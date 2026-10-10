import json
from io import StringIO
from unittest.mock import patch

from django.core.management import call_command
from django.test import TestCase

from dashboard.models import DailyRecord, LossRecord, OutageAlert, RunMeta, Site

ORACLE = ("2026-09-01", "2026-09-29")


class WattBackEndToEnd(TestCase):
    """One data load (committed CSVs + cached engine window) drives everything."""

    @classmethod
    def setUpTestData(cls):
        call_command("load_wattback", verbosity=0)

    # ---- data layer ------------------------------------------------------
    def test_sites_loaded(self):
        self.assertEqual(Site.objects.count(), 3)
        bmt = Site.objects.get(key="bmt")
        self.assertEqual(bmt.kwp_dc, 56.6)

    def test_daily_counts(self):
        self.assertEqual(DailyRecord.objects.filter(site__key="bmt").count(), 2096)
        self.assertEqual(DailyRecord.objects.filter(site__key="manalil").count(), 1204)

    def test_loss_window_loaded(self):
        self.assertEqual(LossRecord.objects.filter(site__key="bmt").count(), 29)
        rm = RunMeta.objects.get(site__key="bmt")
        self.assertEqual(str(rm.start_date), ORACLE[0])
        self.assertEqual(str(rm.end_date), ORACLE[1])
        self.assertAlmostEqual(rm.totals_json["expected"], 5670.0, delta=170)
        self.assertAlmostEqual(rm.totals_json["actual"], 4917.0, delta=5)

    def test_alerts_loaded(self):
        self.assertGreaterEqual(OutageAlert.objects.filter(site__key="bmt").count(), 6)
        self.assertGreaterEqual(OutageAlert.objects.filter(site__key="manalil").count(), 3)

    # ---- pages -----------------------------------------------------------
    def test_story_page(self):
        r = self.client.get("/")
        self.assertEqual(r.status_code, 200)
        self.assertContains(r, "WattBack")
        self.assertContains(r, "Soiling")
        self.assertContains(r, "CHOOSE YOUR ROOF")
        self.assertContains(r, "Dust, dirt, bird droppings")

    def test_overview_page(self):
        r = self.client.get("/app/")
        self.assertEqual(r.status_code, 200)
        self.assertContains(r, "WattBack")
        self.assertContains(r, "Expected")
        self.assertContains(r, "Cleaning counterfactual")

    def test_site_detail_page(self):
        r = self.client.get("/app/site/bmt/")
        self.assertEqual(r.status_code, 200)
        self.assertContains(r, "BMT Punjab")
        self.assertContains(r, "Days on record")

    def test_outages_page(self):
        r = self.client.get("/app/outages/")
        self.assertEqual(r.status_code, 200)
        self.assertContains(r, "Outage alerts")
        self.assertContains(r, "2026-02-17")

    def test_cleaning_page(self):
        r = self.client.get("/app/cleaning/?site=bmt")
        self.assertEqual(r.status_code, 200)
        self.assertContains(r, "counterfactual")
        self.assertContains(r, "tiered rain wash")

    # ---- API -------------------------------------------------------------
    def test_api_sites(self):
        data = self.client.get("/api/v1/sites/").json()
        self.assertEqual(len(data["sites"]), 3)
        keys = {s["key"] for s in data["sites"]}
        self.assertEqual(keys, {"bmt", "manalil", "maha_ref"})

    def test_api_daily(self):
        data = self.client.get(
            "/api/v1/daily/?site=bmt&start=2026-09-01&end=2026-09-29").json()
        self.assertEqual(data["count"], 29)
        self.assertEqual(data["days"][0]["date"], "2026-09-01")

    def test_api_loss_oracle(self):
        data = self.client.get(
            f"/api/v1/loss/?site=bmt&start={ORACLE[0]}&end={ORACLE[1]}").json()
        self.assertEqual(data["source"], "database")
        self.assertAlmostEqual(data["totals"]["expected"], 5670.0, delta=170)
        self.assertAlmostEqual(data["totals"]["actual"], 4917.0, delta=5)
        self.assertLess(data["unexplained_pct"], 1.0)
        self.assertAlmostEqual(data["loss_pct_of_expected"]["temp"], 6.78, delta=1.0)
        self.assertEqual(len(data["days"]), 29)

    def test_api_outages(self):
        data = self.client.get("/api/v1/outages/?site=bmt").json()
        self.assertGreaterEqual(len(data["alerts"]), 6)
        feb = [a for a in data["alerts"] if a["start"] == "2026-02-17"]
        self.assertEqual(feb[0]["days"], 4)
        self.assertGreater(feb[0]["est_lost_kwh"], 100)

    def test_api_cleaning(self):
        data = self.client.get("/api/v1/cleaning/?site=bmt").json()
        self.assertIn("recommendation", data)
        self.assertIn("gain_kwh", data)
        self.assertGreaterEqual(data["gain_kwh"], 0)

    def test_api_impact(self):
        data = self.client.get("/api/v1/impact/").json()
        self.assertEqual(data["india_rooftop_gw"], 32.59)
        self.assertEqual(data["global_solar_gw"], 2499)
        self.assertEqual(data["recoverable_pct"], 3)

    # ---- SNS command -----------------------------------------------------
    def test_publish_alerts_dry_run(self):
        out = StringIO()
        call_command("publish_alerts", stdout=out)
        text = out.getvalue()
        self.assertIn("DRY RUN", text)
        self.assertIn("WattBack outage alert", text)

    # ---- P3 daily digest -------------------------------------------------
    def test_publish_digest_dry_run(self):
        out = StringIO()
        call_command("publish_digest", stdout=out)
        text = out.getvalue()
        self.assertIn("DRY RUN", text)
        self.assertIn("daily digest", text)
        self.assertIn("BMT Punjab", text)
        self.assertIn("top loss driver", text)

    def test_publish_digest_single_site(self):
        out = StringIO()
        call_command("publish_digest", site="manalil", stdout=out)
        text = out.getvalue()
        self.assertIn("Manalil", text)
        self.assertNotIn("BMT Punjab", text)

    # ---- onboarding (P1) -------------------------------------------------
    def test_onboard_page(self):
        r = self.client.get("/onboard/")
        self.assertEqual(r.status_code, 200)
        self.assertContains(r, "USE MY LOCATION")
        self.assertContains(r, "pvoutput.org/register.html")
        self.assertContains(r, "Bhadla Solar Park")

    def test_onboard_save_creates_site(self):
        r = self.client.post("/onboard/", {
            "save": "1", "lat": "28.6139", "lon": "77.2090", "kwp": "4.0",
            "tilt": "28", "az": "180", "name": "Test Rooftop Delhi",
            "ac": "3.2", "pvkey": "abc123"})
        self.assertEqual(r.status_code, 200)
        self.assertContains(r, "SAVED")
        s = Site.objects.get(name="Test Rooftop Delhi")
        self.assertEqual(s.kwp_dc, 4.0)
        self.assertEqual(s.pvoutput_api_key, "abc123")
        self.assertIn("onboarded", s.role)

    def test_onboard_save_rejects_bad_coords(self):
        r = self.client.post("/onboard/", {
            "save": "1", "lat": "999", "lon": "77.2", "kwp": "4"})
        self.assertContains(r, "CHECK INPUT", status_code=200)
        self.assertFalse(Site.objects.filter(name__contains="999").exists())

    def test_extract_requires_coords(self):
        r = self.client.get("/api/v1/extract/")
        self.assertEqual(r.status_code, 400)
        self.assertIn("error", r.json())

    def test_analytics_page(self):
        r = self.client.get("/app/analytics/")
        self.assertEqual(r.status_code, 200)
        self.assertContains(r, "heatmap_pr.log")
        self.assertContains(r, "PVGIS cross-check")

    # ---- P2 cleaning intelligence ---------------------------------------
    def test_cleaning_ladder_renders(self):
        r = self.client.get("/app/cleaning/")
        self.assertEqual(r.status_code, 200)
        self.assertContains(r, "action_ladder.log")
        self.assertContains(r, "Have you cleaned?")
        self.assertContains(r, "Log today")
        self.assertContains(r, "bake risk")

    def test_cleaning_log_kwh(self):
        r = self.client.post("/app/cleaning/?site=bmt", {
            "action": "kwh", "date": "2026-10-09", "kwh": "17.5"})
        self.assertEqual(r.status_code, 200)
        self.assertContains(r, "Logged 17.5 kWh")
        rec = DailyRecord.objects.get(site__key="bmt", date="2026-10-09")
        self.assertEqual(rec.generated_kwh, 17.5)
        self.assertEqual(rec.source, "manual entry")
        rec.delete()

    def test_cleaning_record_event(self):
        r = self.client.post("/app/cleaning/?site=bmt", {
            "action": "cleaned", "date": "2026-10-08", "method": "wash",
            "note": "left half only"})
        self.assertEqual(r.status_code, 200)
        self.assertContains(r, "Cleaning recorded for 2026-10-08")
        self.assertContains(r, "left half only")
        from dashboard.models import CleaningEvent
        self.assertTrue(CleaningEvent.objects.filter(
            site__key="bmt", date="2026-10-08", method="wash").exists())

    def test_storage_dual_mode_db_only(self):
        from unittest.mock import patch

        from dashboard import storage
        with patch.dict("os.environ", {"AWS_ACCESS_KEY_ID": "",
                                       "AWS_PROFILE": ""}):
            res = storage.save_system({"key": "x"})
        self.assertEqual(res["mode"], "db-only")


class TwinAPITests(TestCase):
    """Digital twin: any-date sun path, 7-day state machine, no-rain sim."""

    @classmethod
    def setUpTestData(cls):
        call_command("load_wattback", verbosity=0)

    def _frame(self, year=2025, rain_recent=False):
        import pandas as pd
        days = pd.date_range(f"{year - 1}-12-01", f"{year}-12-31", freq="D")
        n = len(days)
        precip = [0.0] * n
        if rain_recent:  # 2 mm/day for the 5 days ending 2025-06-21
            for i, d in enumerate(days):
                if pd.Timestamp("2025-06-17") <= d <= pd.Timestamp("2025-06-21"):
                    precip[i] = 2.0
        return pd.DataFrame({
            "date": days,
            "ghi_kwh_m2": [5.0] * n,
            "tmean_c": [25.0] * n,
            "tmax_c": [30.0] * n,
            "tmin_c": [20.0] * n,
            "precip_mm": precip,
            "cloud_pct": [40.0] * n,
            "wind_max_kmh": [10.0] * n,
        })

    def test_twin_requires_coords(self):
        r = self.client.get("/api/v1/twin/")
        self.assertEqual(r.status_code, 400)
        self.assertIn("error", r.json())

    def test_twin_bad_date(self):
        r = self.client.get("/api/v1/twin/?lat=28&lon=77&date=not-a-date")
        self.assertEqual(r.status_code, 400)

    def test_twin_bad_year(self):
        r = self.client.get("/api/v1/twin/?lat=28&lon=77&year=abc")
        self.assertEqual(r.status_code, 400)

    def test_twin_page_renders(self):
        r = self.client.get("/app/twin/")
        self.assertEqual(r.status_code, 200)
        self.assertContains(r, "twin_scene")
        self.assertContains(r, "DIGITAL TWIN")

    @patch("dashboard.api._twin_sim6m")
    @patch("dashboard.api._weather_frame")
    @patch("wattback.ingest.pvgis.horizon_profile")
    def test_twin_shape_summer_day(self, hz, wf, sim):
        hz.return_value = {"points": [{"az": 180.0, "el": 2.0}]}
        wf.return_value = self._frame()
        sim.return_value = {"months": [], "total_inr": 0, "final_soil": None}
        r = self.client.get("/api/v1/twin/?lat=28.61&lon=77.21&date=2025-06-21")
        d = r.json()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(d["weather_year"]), 365)
        self.assertEqual(d["sunpath"]["date"], "2025-06-21")
        self.assertEqual(len(d["sunpath"]["points"]), 96)
        self.assertIsNone(d["sunpath"]["now"])
        self.assertGreater(max(p["el"] for p in d["sunpath"]["points"]), 70)
        st = d["state"]
        self.assertEqual(st["mode"], "dusty")
        self.assertEqual(st["days_since_rain"], 999)
        self.assertEqual(st["visual_soil"], 0.15)
        self.assertEqual(d["horizon"], {"points": [{"az": 180.0, "el": 2.0}]})
        self.assertEqual(d["sim6m"]["months"], [])
        self.assertEqual(d["consts"]["rain_partial_min_mm"], 1.0)
        self.assertEqual(d["sources"]["era5"], "ok")

    @patch("dashboard.api._twin_sim6m")
    @patch("dashboard.api._weather_frame")
    @patch("wattback.ingest.pvgis.horizon_profile", return_value=None)
    def test_twin_rain_recent_resets_visual_soil(self, _hz, wf, sim):
        wf.return_value = self._frame(rain_recent=True)
        sim.return_value = {"months": []}
        r = self.client.get("/api/v1/twin/?lat=28.61&lon=77.21&date=2025-06-21")
        st = r.json()["state"]
        self.assertEqual(st["mode"], "rain_clean")
        self.assertEqual(st["rain_7d"], 10.0)
        self.assertEqual(st["days_since_rain"], 0)
        self.assertLess(st["visual_soil"], 0.05)
        self.assertEqual(r.json()["sources"]["horizon"], "unavailable")

    @patch("dashboard.api._twin_sim6m")
    @patch("dashboard.api._weather_frame")
    @patch("wattback.ingest.pvgis.horizon_profile", return_value=None)
    def test_twin_site_param_uses_db(self, _hz, wf, sim):
        wf.return_value = self._frame()
        sim.return_value = {"months": []}
        r = self.client.get("/api/v1/twin/?site=bmt&date=2025-06-21")
        d = r.json()
        self.assertAlmostEqual(d["lat"], 31.63)
        self.assertEqual(d["kwp"], 56.6)
        self.assertEqual(d["tilt"], 5.0)
        self.assertEqual(d["az"], 180.0)

    def test_sim6m_run_no_rain_scenario(self):
        import pandas as pd
        from dashboard.api import _sim6m_run
        idx = pd.date_range("2025-04-01", periods=24 * 45, freq="h")
        wx = pd.DataFrame({"time": idx, "ghi_wm2": 500.0, "precip_mm": 3.0})
        pm = pd.DataFrame({"time": idx, "pm2_5": 20.0, "pm10": 50.0})
        out = _sim6m_run(wx, pm, tilt=28.0, kwp=10.0, end_iso="2025-05-15")
        self.assertLess(out["final_soil"], 1.0)
        self.assertGreater(out["final_soil"], 0.85)
        self.assertGreater(out["total_kwh"], 0)
        self.assertGreater(out["total_inr"], 0)
        months = [m["month"] for m in out["months"]]
        self.assertIn("2025-04", months)
        self.assertIn("2025-05", months)
        self.assertEqual(out["pr_assumed"], 0.80)
        self.assertEqual(out["months"][-1]["cum_kwh"], out["total_kwh"])
