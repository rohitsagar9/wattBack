from django.urls import path

from . import api

app_name = "api"

urlpatterns = [
    path("sites/", api.sites, name="sites"),
    path("daily/", api.daily, name="daily"),
    path("loss/", api.loss, name="loss"),
    path("outages/", api.outages, name="outages"),
    path("cleaning/", api.cleaning, name="cleaning"),
    path("impact/", api.impact, name="impact"),
]
