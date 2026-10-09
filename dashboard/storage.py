"""Dual-mode storage: mirror onboarded systems to DynamoDB when AWS
credentials exist, otherwise stay DB-only. Never raises — onboarding must
not be blocked by missing cloud access."""

from __future__ import annotations

import json
import logging
import os
import time

log = logging.getLogger(__name__)


def save_system(payload: dict) -> dict:
    if not (os.environ.get("AWS_ACCESS_KEY_ID") or os.environ.get("AWS_PROFILE")):
        return {"mode": "db-only", "detail": "no AWS credentials in environment"}
    try:
        import boto3

        region = os.environ.get("AWS_REGION", "ap-south-1")
        table = os.environ.get("DYNAMO_TABLE", "wattback-systems")
        client = boto3.client("dynamodb", region_name=region)
        try:
            client.describe_table(TableName=table)
        except client.exceptions.ResourceNotFoundException:
            client.create_table(
                TableName=table,
                KeySchema=[{"AttributeName": "site_key", "KeyType": "HASH"}],
                AttributeDefinitions=[
                    {"AttributeName": "site_key", "AttributeType": "S"}],
                BillingMode="PAY_PER_REQUEST")
        client.put_item(
            TableName=table,
            Item={
                "site_key": {"S": str(payload.get("key", ""))},
                "payload": {"S": json.dumps(payload)},
                "updated_at": {"N": str(int(time.time()))},
            })
        return {"mode": "dynamodb", "detail": table}
    except Exception as exc:  # noqa: BLE001
        log.warning("DynamoDB mirror skipped: %s", exc)
        return {"mode": "db-only", "detail": f"{type(exc).__name__}: {exc}"}
