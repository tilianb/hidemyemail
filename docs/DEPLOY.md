# Deploy — hidemyemail.dev

## 1. D1
```bash
cd worker
npx wrangler d1 create hidemyemail          # paste database_id into wrangler.jsonc
npx wrangler d1 migrations apply hidemyemail --remote
```

## 2. Secrets & Environment Variables (Worker)
Add the following variables to your `wrangler.jsonc` or `.dev.vars` for local testing. Use `npx wrangler secret put` for production secrets:
```bash
node scripts/hash-password.mjs 'YOUR_PASSWORD'   # prints SALT + HASH
npx wrangler secret put AUTH_PASSWORD_SALT
npx wrangler secret put AUTH_PASSWORD_HASH
npx wrangler secret put SESSION_SECRET           # e.g. openssl rand -hex 32
npx wrangler secret put SES_ACCESS_KEY_ID
npx wrangler secret put SES_SECRET_ACCESS_KEY
npx wrangler secret put SNS_SECRET               # Secure random string for SNS webhook auth
npx wrangler secret put SNS_ALLOWED_TOPIC_ARN    # Outbound bounce/complaint topic ARN
npx wrangler secret put SNS_INBOUND_TOPIC_ARN    # Inbound email receipt topic ARN
npx wrangler secret put DESTINATION_ENCRYPTION_KEY # 32-byte hex string (e.g. openssl rand -hex 32)
```
Update `wrangler.jsonc` with your specific variables:
```jsonc
"vars": {
  "SES_REGION": "ap-southeast-2",
  "S3_INBOUND_BUCKET": "hidemyemail-inbound-raw"
}
```

## 3. Amazon S3 & SES Setup (Inbound & Outbound)

### Inbound (Receiving Emails)
1. **S3 Bucket**: Create a private S3 bucket (e.g., `hidemyemail-inbound-raw`) to store raw incoming MIME emails.
2. **SNS Topic (Inbound)**: Create an SNS topic for inbound email notifications. Set `SNS_INBOUND_TOPIC_ARN` in your secrets.
3. **SES Receipt Rule**: Go to Amazon SES -> Email Receiving. Create a rule set and a receipt rule.
   - **Condition**: Apply to your domains/subdomains (or leave empty for all verified identities).
   - **Action 1 (S3)**: Deliver to the S3 bucket you created.
   - **Action 2 (SNS)**: Publish to your Inbound SNS Topic.
4. **SNS Webhook (Inbound)**: Subscribe your worker's webhook to the inbound topic:
   `https://<worker-host>/api/ses/inbound?secret=<your_sns_secret>`

### Outbound (Replies & Deliverability)
1. **Verify Domains**: Verify each sending domain D in SES and add the DKIM CNAMEs.
2. **SNS Topic (Outbound)**: Create a second SNS topic for bounce, delivery, and complaint events. Set `SNS_ALLOWED_TOPIC_ARN` in your secrets.
3. **SNS Webhook (Outbound)**: Subscribe your worker's webhook to the outbound topic:
   `https://<worker-host>/api/ses/notification?secret=<your_sns_secret>`
4. **Confirm Subscriptions**: Check your worker's logs (`npx wrangler tail`) for the `SubscribeURL` upon creation and open it in your browser to confirm both SNS subscriptions.
5. (Optional) Request SES production access if you need to send replies to unverified addresses.

## 4. DNS Configuration per domain
Configure your domain's DNS records (e.g., in Cloudflare) to route emails to SES and ensure high deliverability:
- **MX Record**: Point to the Amazon SES inbound endpoint for your region (e.g., `10 inbound-smtp.<your-region>.amazonaws.com`).
- **SPF**: Add `v=spf1 include:amazonses.com ~all` as a TXT record.
- **DMARC**: `_dmarc TXT "v=DMARC1; p=quarantine; rua=mailto:dmarc@<your-domain>"`
- **DKIM**: Add the 3 DKIM CNAME records provided by Amazon SES during verification.

## 5. Deploy Worker + Dashboard
```bash
cd worker && npx wrangler deploy
cd ../dashboard && npm run build && npx wrangler pages deploy dist --project-name hidemyemail-dashboard
```
Serve the dashboard same-origin as the API: add a Worker route `app.hidemyemail.dev/api/*`
to the Worker, and point `app.hidemyemail.dev` at the Pages project for the static SPA.

## 6. Initial Configuration (Dashboard)
After deploying the Worker and Dashboard, log in to your dashboard using the password you hashed in step 2.
1. Navigate to **Destinations** to add and verify your real email inbox.
2. The global domain (`hidemyemail.dev`) is seeded automatically. You can add your own subdomains or additional domains from the **Domains** tab.
*(Note: Do not manually insert destinations into D1, as they must be verified and encrypted by the worker.)*

## 7. Post-Deployment Verification
- [ ] **Inbound Routing**: Send a test email from an external account to your newly created alias. Verify it successfully arrives in your real inbox.
- [ ] **E2E Reply (Outbound)**: Reply to the forwarded test email from your real inbox. Verify the external sender receives the reply from your *alias address*, and ensure your real email address is completely absent from the email headers.
- [ ] **SNS Webhooks**: Check the Cloudflare Worker logs (`npx wrangler tail`) while sending/receiving to ensure SNS notifications are processed without signature errors.
- [ ] **Deliverability Check**: Send an email to a service like `mail-tester.com` to verify your SPF, DKIM, and DMARC configurations are passing correctly.
- [ ] **SES Quota Monitoring**: Keep an eye on your SES sending quotas during your first week, as catch-all spam forwarded to your inbox will count against your daily SES limits.
