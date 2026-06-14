# AWS SES Setup

HideMyEmail uses AWS SES for both inbound receiving and outbound sending.
Inbound mail is stored in S3, announced through SNS, then processed by the Worker.

## Variables you need

Choose these before setup:

- `SES_REGION`, for example `ap-southeast-2`
- `S3_INBOUND_BUCKET`, globally unique bucket name
- `SNS_INBOUND_TOPIC_ARN`, for `/api/ses/inbound`
- `SNS_ALLOWED_TOPIC_ARN`, for `/api/ses/notification`
- Worker URL, for example `https://your-worker.example.com`

## 1. Verify your domain in SES

In AWS SES:

1. Create an email identity for your domain.
2. Enable DKIM.
3. Add the three SES DKIM CNAME records to DNS.
4. Wait for SES verification.

If your SES account is in sandbox, request production access before using aliases with arbitrary external recipients.

## 2. Create the inbound S3 bucket

Create a private bucket in the same region as SES receiving.

```bash
aws s3api create-bucket \
  --bucket YOUR-INBOUND-BUCKET \
  --region YOUR-SES-REGION \
  --create-bucket-configuration LocationConstraint=YOUR-SES-REGION

aws s3api put-public-access-block \
  --bucket YOUR-INBOUND-BUCKET \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

Add a lifecycle rule so raw mail expires after a short period, for example 2-7 days.

## 3. Allow SES to write to S3

Replace account, region, bucket, and receipt rule set values:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "ses.amazonaws.com" },
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::YOUR-INBOUND-BUCKET/*",
      "Condition": {
        "StringEquals": {
          "aws:SourceAccount": "YOUR-AWS-ACCOUNT-ID"
        }
      }
    }
  ]
}
```

Apply it:

```bash
aws s3api put-bucket-policy \
  --bucket YOUR-INBOUND-BUCKET \
  --policy file://bucket-policy.json
```

## 4. Create SNS topics

Create one topic for inbound receipt notifications and one for outbound SES events.

```bash
aws sns create-topic --name hidemyemail-inbound --region YOUR-SES-REGION
aws sns create-topic --name hidemyemail-outbound --region YOUR-SES-REGION
```

Set the resulting topic ARNs in Cloudflare:

- inbound topic → `SNS_INBOUND_TOPIC_ARN`
- outbound topic → `SNS_ALLOWED_TOPIC_ARN`

## 5. Create SES receipt rule

Create or update an active SES receipt rule set.

The receipt rule should:

1. Match your domain or subdomain.
2. Store the raw message in `S3_INBOUND_BUCKET`.
3. Publish to the inbound SNS topic.

Example shape:

```bash
aws ses create-receipt-rule-set \
  --rule-set-name hidemyemail-inbound \
  --region YOUR-SES-REGION

aws ses create-receipt-rule \
  --rule-set-name hidemyemail-inbound \
  --region YOUR-SES-REGION \
  --rule '{
    "Name": "store-and-notify",
    "Enabled": true,
    "ScanEnabled": true,
    "Recipients": ["YOUR-DOMAIN"],
    "Actions": [
      { "S3Action": { "BucketName": "YOUR-INBOUND-BUCKET" } },
      { "SNSAction": { "TopicArn": "YOUR-INBOUND-TOPIC-ARN", "Encoding": "UTF-8" } }
    ]
  }'

aws ses set-active-receipt-rule-set \
  --rule-set-name hidemyemail-inbound \
  --region YOUR-SES-REGION
```

## 6. Subscribe SNS to the Worker

Inbound:

```bash
aws sns subscribe \
  --topic-arn YOUR-INBOUND-TOPIC-ARN \
  --protocol https \
  --notification-endpoint https://YOUR-WORKER-HOST/api/ses/inbound \
  --region YOUR-SES-REGION
```

Outbound events:

```bash
aws sns subscribe \
  --topic-arn YOUR-OUTBOUND-TOPIC-ARN \
  --protocol https \
  --notification-endpoint https://YOUR-WORKER-HOST/api/ses/notification \
  --region YOUR-SES-REGION
```

The Worker auto-confirms subscriptions when AWS sends `SubscriptionConfirmation`.
Use `wrangler tail` or Docker logs to inspect failures.

## 7. Give the Worker AWS permissions

Create an IAM user or role for the Worker with least privilege:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ses:SendEmail", "ses:SendRawEmail"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::YOUR-INBOUND-BUCKET/*"
    }
  ]
}
```

Set the credentials as Worker secrets:

```bash
npx wrangler secret put SES_ACCESS_KEY_ID --env=""
npx wrangler secret put SES_SECRET_ACCESS_KEY --env=""
```

## 8. DNS records

For each alias domain:

- MX: `10 inbound-smtp.YOUR-SES-REGION.amazonaws.com`
- SPF TXT: `v=spf1 include:amazonses.com ~all`
- DKIM: the 3 SES-provided CNAME records
- DMARC TXT at `_dmarc`: `v=DMARC1; p=quarantine; rua=mailto:dmarc@YOUR-DOMAIN`

### Custom MAIL FROM (required for deliverability)

Without a custom MAIL FROM, the envelope Return-Path of every forward is
`amazonses.com`. SPF passes but does not *align* with your From domain.
DMARC rides on DKIM alone. Outlook scores the mail worse.
Set it up for every alias domain:

```bash
aws sesv2 put-email-identity-mail-from-attributes \
  --region YOUR-SES-REGION \
  --email-identity YOUR-DOMAIN \
  --mail-from-domain bounce.YOUR-DOMAIN \
  --behavior-on-mx-failure USE_DEFAULT_VALUE
```

Then add:

- `bounce.YOUR-DOMAIN` MX: `10 feedback-smtp.YOUR-SES-REGION.amazonses.com`
- `bounce.YOUR-DOMAIN` TXT: `v=spf1 include:amazonses.com ~all`

## 9. Test mail flow

1. Send external mail to `anything@YOUR-DOMAIN`.
2. Confirm the message appears in S3.
3. Confirm SNS posts to `/api/ses/inbound`.
4. Confirm the forwarded message arrives at your verified destination.
5. Reply from your inbox and confirm the external sender sees your alias.

## 10. Reputation warm-up (avoid the Junk folder)

A new domain forwarding high mail volume resembles a spam
operation, regardless of correct SPF/DKIM/DMARC. Plan the first two weeks:

1. **Start small.** Keep volume under ~50 forwards/day for the first days,
   then ramp gradually. Sign up your own low-volume newsletters first.
2. **Keep verdict handling strict.** Leave `spam_verdict_action` on
   `flag` (or `drop`) and `virus_verdict_action` on `drop` in Admin →
   Settings. Forwarded spam is re-signed with YOUR domain's DKIM — every
   spam message you forward counts against your reputation.
3. **Keep inline actions off** while the domain is new (Admin → Settings →
   Inline Action Links). The three `mailto:` buttons pattern-match
   marketing footers at Microsoft.
4. **Enroll in feedback programs.** [Google Postmaster Tools]
   (https://postmaster.google.com) and [Microsoft SNDS]
   (https://sendersupport.olc.protection.outlook.com/snds/) show your
   domain/IP reputation as the big providers see it.
5. **Watch the suppression dashboard.** Admin → Suppressions tracks
   bounces and complaints; keep the complaint rate under 0.1%. Hard
   bounces and complaints auto-suppress the destination so SES never
   retries them.
6. **Verify alignment.** Send a forward to a Gmail address, open
   "Show original", and confirm SPF, DKIM, and DMARC show PASS with
   your domain (not amazonses.com). See the custom MAIL FROM step.
