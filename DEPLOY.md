# Deploying WattBack to AWS (Elastic Beanstalk)

One-time setup, then three commands. Free tier: single-instance environment
on t3.micro (no ALB), S3 app versions, CloudWatch logs — all included.

## Prereqs (once)

1. AWS account with free-tier credits
2. IAM user `wattback-deploy` → access key (paste into env):
   ```powershell
   $env:AWS_ACCESS_KEY_ID="AKIA..."
   $env:AWS_SECRET_ACCESS_KEY="..."
   ```
3. `pip install -r requirements.txt` (includes `awsebcli`)

## Deploy

```powershell
# 1. link repo to an EB application (region: ap-south-1, platform: Python 3.11)
eb init wattback --region ap-south-1 -p "Python 3.11"

# 2. create the environment (single instance = free tier)
eb create wattback --single

# 3. open it
eb open
```

Deploy bundles **everything** including `data/` (CSVs + engine cache), so
`load_wattback` runs offline on the instance via `.ebextensions`
(container command) after every deploy. Static files are served by
Whitenoise after the platform's `collectstatic`.

## Environment variables (set once)

```powershell
eb setenv DJANGO_SECRET_KEY="<generate: python -c 'import secrets; print(secrets.token_urlsafe(50))'>" ALLOWED_HOSTS="*"
```

### SNS outage alerts (optional but on-video)

```python
python -c "
import boto3
sns = boto3.client('sns', region_name='ap-south-1')
t = sns.create_topic(Name='wattback-alerts')
print(t['TopicArn'])"
# then subscribe your email and set the ARN:
eb setenv SNS_TOPIC_ARN="arn:aws:sns:ap-south-1:....:wattback-alerts"
```

## Routine

```powershell
eb deploy        # push current git state
eb logs          # CloudWatch-backed logs
eb logs --stream # live tail
python manage.py publish_alerts   # publish pending alerts to SNS
```

## Teardown (after submission)

```powershell
eb terminate wattback
# then delete the IAM access key in the console
```
