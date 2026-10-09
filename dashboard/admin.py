from django.contrib import admin

from .models import (CleaningEvent, DailyRecord, LossRecord, OutageAlert,
                     RunMeta, Site)


@admin.register(Site)
class SiteAdmin(admin.ModelAdmin):
    list_display = ("key", "name", "kwp_dc", "role")
    prepopulated_fields = {"key": ("name",)}


@admin.register(DailyRecord)
class DailyRecordAdmin(admin.ModelAdmin):
    list_display = ("site", "date", "generated_kwh", "flags")
    list_filter = ("site", "flags")


@admin.register(OutageAlert)
class OutageAlertAdmin(admin.ModelAdmin):
    list_display = ("site", "start_date", "end_date", "days",
                    "est_lost_kwh", "published_at")
    list_filter = ("site",)


@admin.register(LossRecord)
class LossRecordAdmin(admin.ModelAdmin):
    list_display = ("site", "date", "expected", "predicted", "actual",
                    "unexplained")
    list_filter = ("site",)


admin.site.register(RunMeta)


@admin.register(CleaningEvent)
class CleaningEventAdmin(admin.ModelAdmin):
    list_display = ("site", "date", "method", "note")
    list_filter = ("site", "method")
