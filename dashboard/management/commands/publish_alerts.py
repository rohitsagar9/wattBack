"""Publish un-notified outage alerts to an SNS topic (AWS).

If SNS_TOPIC_ARN is set, publishes each new alert and stamps published_at.
Otherwise does a dry run and prints what would be sent (safe without AWS).

usage: python manage.py publish_alerts
"""

import os
from django.core.management.base import BaseCommand

from dashboard.models import OutageAlert


class Command(BaseCommand):
    help = "Publish unpublished outage alerts to SNS (or dry-run locally)"

    def handle(self, *args, **opts):
        topic = os.environ.get("SNS_TOPIC_ARN", "")
        pending = OutageAlert.objects.filter(published_at__isnull=True)
        count = 0
        client = None
        if topic:
            import boto3
            client = boto3.client("sns", region_name=os.environ.get(
                "AWS_REGION", "ap-south-1"))

        for alert in pending.select_related("site"):
            msg = (f"WattBack outage alert: {alert.site.name} — no generation "
                   f"for {alert.days} day(s) "
                   f"({alert.start_date} → {alert.end_date}), "
                   f"≈{alert.est_lost_kwh:.0f} kWh lost.")
            if client is not None:
                client.publish(TopicArn=topic, Subject="WattBack: outage detected",
                               Message=msg)
                from django.utils import timezone
                alert.published_at = timezone.now()
                alert.save(update_fields=["published_at"])
                self.stdout.write(f"SNS published: {msg}")
            else:
                self.stdout.write(f"DRY RUN (set SNS_TOPIC_ARN to publish): {msg}")
            count += 1
        if count == 0:
            self.stdout.write("no unpublished alerts")
