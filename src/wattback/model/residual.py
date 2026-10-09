"""Daily residual model: LightGBM vs weekly-seasonal naive.

Target:  log1p(actual_kwh / kwp)  (scale-free across site sizes).
Features: calendar harmonics, lagged actuals, trailing means, ERA5 daily
weather -- all shifted so nothing from day t leaks into day t's row.
Evaluation: expanding walk-forward (train on the past, test the next 7 days).
Duan smearing is applied when back-transforming to kWh.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from wattback.config import RAW_DIR, site

LAGS = (1, 7, 14)
ROLLS = (7, 30)
SEED = 7
TEST_DAYS = 7
MIN_TRAIN = 90

FEATURES = [
    "doy_sin", "doy_cos", "month", "lag1", "lag7", "lag14",
    "roll7", "roll30", "ghi", "tmean", "precip", "cloud", "site",
]


def build_frame(keys: tuple[str, ...] = ("bmt", "manalil")) -> pd.DataFrame:
    parts = []
    for key in keys:
        gen = pd.read_csv(RAW_DIR / f"{key}_daily.csv", parse_dates=["date"])
        wx = pd.read_csv(RAW_DIR / f"era5_{key}.csv", parse_dates=["date"])
        df = gen.merge(wx, on="date", how="left")
        kwp = site(key)["kwp_dc"]
        df["site"] = key
        df["y"] = np.log1p(df["generated_kwh"] / kwp)
        parts.append(df)
    df = pd.concat(parts, ignore_index=True).sort_values(["site", "date"])

    out = []
    for key, g in df.groupby("site"):
        g = g.set_index("date").sort_index()
        feats = pd.DataFrame(index=g.index)
        doy = g.index.dayofyear
        feats["doy_sin"] = np.sin(2 * np.pi * doy / 365.25)
        feats["doy_cos"] = np.cos(2 * np.pi * doy / 365.25)
        feats["month"] = g.index.month
        for lag in LAGS:
            feats[f"lag{lag}"] = g["y"].shift(lag)
        for r in ROLLS:
            feats[f"roll{r}"] = g["y"].shift(1).rolling(r, min_periods=r).mean()
        feats["ghi"] = g["ghi_kwh_m2"]
        feats["tmean"] = g["tmean_c"]
        feats["precip"] = g["precip_mm"].fillna(0)
        feats["cloud"] = g["cloud_pct"].fillna(0)
        feats["site"] = key
        feats["y"] = g["y"]
        out.append(feats.reset_index())
    frame = (pd.concat(out, ignore_index=True).dropna()
             .sort_values("date").reset_index(drop=True))
    frame["site"] = frame["site"].astype("category")
    return frame


def walk_forward(df: pd.DataFrame) -> pd.DataFrame:
    """Expanding CV: train <= t, test t+1..t+7. Returns y, yhat, naive."""
    import lightgbm as lgb

    n = len(df)
    preds = []
    start = MIN_TRAIN
    while start + TEST_DAYS <= n:
        tr, te = df.iloc[:start], df.iloc[start:start + TEST_DAYS]
        model = lgb.LGBMRegressor(
            n_estimators=400, learning_rate=0.05, num_leaves=31,
            subsample=0.9, subsample_freq=1, colsample_bytree=0.9,
            min_child_samples=20, random_state=SEED, verbose=-1)
        model.fit(
            tr[FEATURES], tr["y"],
            categorical_feature=["site"])
        pred = model.predict(te[FEATURES])
        block = pd.DataFrame({
            "date": te["date"] if "date" in te else te.index,
            "y": te["y"].to_numpy(),
            "yhat": pred,
            "naive": te["lag7"].to_numpy(),
        })
        preds.append(block)
        start += TEST_DAYS
    return pd.concat(preds, ignore_index=True)


def smearing_factor(resid: pd.Series) -> float:
    """Duan smearing: E[e^e] correction for back-transforming log targets."""
    return float(np.mean(np.exp(resid.to_numpy())))


def predict_kwh(pred_df: pd.DataFrame, kwp: float) -> pd.DataFrame:
    out = pred_df.copy()
    s = smearing_factor(out["y"] - out["yhat"])
    out["pred_kwh"] = np.maximum(np.expm1(out["yhat"]), 0.0) * s * kwp
    out["naive_kwh"] = np.maximum(np.expm1(out["naive"]), 0.0) * kwp
    out["actual_kwh"] = np.expm1(out["y"]) * kwp
    return out


def rmse(y: np.ndarray, yhat: np.ndarray) -> float:
    return float(np.sqrt(np.mean((np.asarray(y) - np.asarray(yhat)) ** 2)))
