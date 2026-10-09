import json
from io import StringIO

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

    def test_storage_dual_mode_db_only(self):
        from unittest.mock import patch

        from dashboard import storage
        with patch.dict("os.environ", {"AWS_ACCESS_KEY_ID": "",
                                       "AWS_PROFILE": ""}):
            res = storage.save_system({"key": "x"})
        self.assertEqual(res["mode"], "db-only")
