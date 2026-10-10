from django.urls import path

from . import views

app_name = "dashboard"

urlpatterns = [
    path("", views.story, name="story"),
    path("onboard/", views.onboard, name="onboard"),
    path("app/", views.overview, name="overview"),
    path("app/site/<slug:key>/", views.site_detail, name="site_detail"),
    path("app/outages/", views.outages, name="outages"),
    path("app/cleaning/", views.cleaning, name="cleaning"),
    path("app/analytics/", views.analytics, name="analytics"),
    path("app/twin/", views.twin, name="twin"),
]
