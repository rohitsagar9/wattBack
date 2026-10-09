from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/v1/", include("dashboard.api_urls")),
    path("", include("dashboard.urls")),
]
