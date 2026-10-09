import pytest

from wattback.model.residual import build_frame, predict_kwh, rmse, walk_forward


@pytest.fixture(scope="module")
def frame():
    return build_frame()


@pytest.fixture(scope="module")
def oof(frame):
    return walk_forward(frame)


def test_frame_covers_both_sites(frame):
    assert set(frame["site"].astype(str)) == {"bmt", "manalil"}
    assert len(frame) > 3000
    assert frame[["lag7", "roll7", "ghi"]].notna().all().all()


def test_walk_forward_beats_weekly_naive(oof):
    assert len(oof) > 3000
    r_model = rmse(oof["y"], oof["yhat"])
    r_naive = rmse(oof["y"], oof["naive"])
    assert r_model < r_naive * 0.85, (r_model, r_naive)


def test_backtransform_stays_sane(oof):
    kw = predict_kwh(oof, kwp=1.0)
    assert (kw["pred_kwh"] >= 0).all()
    med_err = (kw["pred_kwh"] - kw["actual_kwh"]).abs().median()
    assert med_err < 0.4, med_err
