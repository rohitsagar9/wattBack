# Deploying WattBack to AWS (Elastic Beanstalk)

**Live (2026-10-11):** http://wattback.eba-yjd2vepx.ap-south-1.elasticbeanstalk.com  
App `wattback` · env `e-8zhnp5bd5e` · Python 3.11 on AL2023 · single-instance t3.micro (free tier)

## Prereqs (once)

1. AWS account with free-tier credits
2. IAM user `wattback-deploy` (account `332250067784`) with programmatic access.
   Least-privilege policy: [`docs/aws-iam-policy.json`](docs/aws-iam-policy.json)
   (EB + EC2 + S3 + SNS + DynamoDB). Attach, then create an access key.
3. Set credentials in the shell (no angle brackets!):
   ```powershell
   [Environment]::SetEnvironmentVariable("AWS_ACCESS_KEY_ID","AKIA...","User")
   [Environment]::SetEnvironmentVariable("AWS_SECRET_ACCESS_KEY","...","User")
   [Environment]::SetEnvironmentVariable("AWS_REGION","ap-south-1","User")
   ```
4. `pip install -r requirements.txt` (includes `awsebcli`)

## Deploy

```powershell
# 1. link repo to an EB application (region: ap-south-1, platform: Python 3.11)
eb init wattback --region ap-south-1 -p "Python 3.11"

# 2. create the environment (single instance = free tier)
eb create wattback --single

# 3. open it
eb open
```

### How data survives deploys

`/var/app/current` is **replaced every deploy**, so SQLite cannot live there.
`.ebextensions/99_wattback.config` sets:

| Var | Value |
|---|---|
| `SQLITE_PATH` | `/var/app/wattback_data/db.sqlite3` (outside the app tree) |
| `DEBUG` | `0` |
| `ALLOWED_HOSTS` | `*` |

Container commands (leader-only) run after each deploy:

1. `mkdir -p /var/app/wattback_data && python manage.py migrate && chown -R webapp:webapp …`
2. `python manage.py load_wattback && chown -R webapp:webapp …`

`data/` (CSVs + engine cache) ships in the bundle, so `load_wattback` is fully offline.
Static files: Whitenoise after the platform’s `collectstatic`.

**Gotcha:** if SQLite is created as root without `chown webapp`, gunicorn gets
`attempt to write a readonly database` and every page 500s/502s.

## Environment variables (set once)

```powershell
eb setenv DJANGO_SECRET_KEY="<python -c 'import secrets; print(secrets.token_urlsafe(50))'>" `
          ALLOWED_HOSTS="*" DEBUG=0 `
          SQLITE_PATH=/var/app/wattback_data/db.sqlite3 `
          AWS_ACCESS_KEY_ID="AKIA..." AWS_SECRET_ACCESS_KEY="..." AWS_REGION=ap-south-1 `
          DYNAMO_TABLE=wattback-systems `
          SNS_TOPIC_ARN="arn:aws:sns:ap-south-1:332250067784:wattback-alerts"
```

AWS keys in the EB env let the **onboard** wizard dual-write to DynamoDB
(`storage: dynamodb (wattback-systems)`). Without keys it falls back to `db-only`.

## SNS outage alerts

```python
python -c "
import boto3
sns = boto3.client('sns', region_name='ap-south-1')
t = sns.create_topic(Name='wattback-alerts')
print(t['TopicArn'])
# subscribe your email, then click the confirm link
sns.subscribe(TopicArn=t['TopicArn'], Protocol='email', Endpoint='you@example.com')"
eb setenv SNS_TOPIC_ARN="arn:aws:sns:ap-south-1:332250067784:wattback-alerts"
```

```powershell
$env:SNS_TOPIC_ARN="arn:aws:sns:ap-south-1:332250067784:wattback-alerts"
python manage.py publish_alerts   # stamps published_at on each OutageAlert
python manage.py publish_digest --site bmt
```

Verified 2026-10-11: 10 outage alerts + daily digest published to SNS.

## DynamoDB table

Created on demand by `dashboard.storage.save_system` (or manually):

```python
ddb.create_table(
    TableName='wattback-systems',
    KeySchema=[{'AttributeName': 'site_key', 'KeyType': 'HASH'}],
    AttributeDefinitions=[{'AttributeName': 'site_key', 'AttributeType': 'S'}],
    BillingMode='PAY_PER_REQUEST')
```

## Routine

```powershell
eb deploy        # push current git state (re-runs migrate + load_wattback)
eb logs          # instance + nginx + gunicorn logs
python manage.py publish_alerts
```

## Teardown (after submission)

```powershell
eb terminate wattback
# then in the IAM console: deactivate + delete the wattback-deploy access key
# (the key was visible in chat — rotate it even if you keep the account)
```
