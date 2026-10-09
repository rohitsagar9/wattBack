from django.db import models


class Site(models.Model):
    key = models.SlugField(unique=True)
    name = models.CharField(max_length=100)
    lat = models.FloatField(null=True, blank=True)
    lng = models.FloatField(null=True, blank=True)
    tilt_deg = models.FloatField(null=True, blank=True)
    azimuth_deg = models.FloatField(null=True, blank=True)
    kwp_dc = models.FloatField(default=0)
    ac_kw = models.FloatField(default=0)
    role = models.CharField(max_length=200, blank=True)
    data_policy = models.CharField(max_length=200, blank=True)

    def __str__(self) -> str:
        return self.name


class DailyRecord(models.Model):
    site = models.ForeignKey(Site, on_delete=models.CASCADE, related_name="daily")
    date = models.DateField()
    generated_kwh = models.FloatField()
    peak_kw = models.FloatField(null=True, blank=True)
    peak_time = models.CharField(max_length=20, blank=True)
    conditions = models.CharField(max_length=100, blank=True)
    temp_text = models.CharField(max_length=50, blank=True)
    source = models.CharField(max_length=100, blank=True)
    flags = models.CharField(max_length=100, blank=True)
    ghi_kwh_m2 = models.FloatField(null=True, blank=True)
    tmean_c = models.FloatField(null=True, blank=True)
    precip_mm = models.FloatField(null=True, blank=True)
    cloud_pct = models.FloatField(null=True, blank=True)

    class Meta:
        ordering = ["-date"]
        unique_together = [("site", "date")]
        indexes = [models.Index(fields=["site", "-date"])]


class OutageAlert(models.Model):
    site = models.ForeignKey(Site, on_delete=models.CASCADE, related_name="alerts")
    start_date = models.DateField()
    end_date = models.DateField()
    days = models.IntegerField()
    est_lost_kwh = models.FloatField()
    published_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-start_date"]
        unique_together = [("site", "start_date", "end_date")]

    def __str__(self) -> str:
        return f"{self.site.key} {self.start_date}..{self.end_date} ({self.days}d)"


class LossRecord(models.Model):
    site = models.ForeignKey(Site, on_delete=models.CASCADE, related_name="loss")
    date = models.DateField()
    segment = models.CharField(max_length=10, blank=True)
    factor = models.FloatField(default=1.0)
    expected = models.FloatField()
    aoi = models.FloatField(default=0)
    temp = models.FloatField(default=0)
    soiling = models.FloatField(default=0)
    dc_cable = models.FloatField(default=0)
    inv_conv = models.FloatField(default=0)
    clip = models.FloatField(default=0)
    ac_cable = models.FloatField(default=0)
    predicted = models.FloatField(default=0)
    actual = models.FloatField(default=0)
    avail = models.FloatField(default=0)
    missing = models.FloatField(default=0)
    unexplained = models.FloatField(default=0)

    class Meta:
        ordering = ["date"]
        unique_together = [("site", "date")]


class RunMeta(models.Model):
    site = models.OneToOneField(Site, on_delete=models.CASCADE, related_name="runmeta")
    start_date = models.DateField()
    end_date = models.DateField()
    n_days = models.IntegerField(default=0)
    soiling_ratio = models.FloatField(default=1.0)
    factors_json = models.JSONField(default=dict)
    totals_json = models.JSONField(default=dict)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self) -> str:
        return f"{self.site.key} run {self.start_date}..{self.end_date}"
