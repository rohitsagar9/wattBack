from django.urls import path

from . import views

app_name = "dashboard"

urlpatterns = [
    path("", views.overview, name="overview"),
    path("site/<slug:key>/", views.site_detail, name="site_detail"),
    path("outages/", views.outages, name="outages"),
    path("cleaning/", views.cleaning, name="cleaning"),
]
