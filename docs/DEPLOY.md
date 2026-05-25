# Deploy — hidemyemail.dev

## 1. D1
```bash
cd worker
npx wrangler d1 create hidemyemail          # paste database_id into wrangler.jsonc
npx wrangler d1 migrations apply hidemyemail --remote
```

## 2. Secrets (Worker)
```bash
node scripts/hash-password.mjs 'YOUR_PASSWORD'   # prints SALT + HASH
npx wrangler secret put AUTH_PASSWORD_SALT
npx wrangler secret put AUTH_PASSWORD_HASH
npx wrangler secret put SESSION_SECRET           # e.g. openssl rand -hex 32
npx wrangler secret put SES_ACCESS_KEY_ID
npx wrangler secret put SES_SECRET_ACCESS_KEY
npx wrangler secret put SNS_ALLOWED_TOPIC_ARN
```

## 3. Seed first domain
After deploying the Worker (step 7), add the domain from the dashboard (Domains form)
or via the D1 console in the Cloudflare dashboard:
`INSERT INTO domains (domain, default_destination, active, created_at) VALUES ('hidemyemail.dev','YOUR_REAL@inbox.com',1, <epoch_ms>)`

## 4. SES (already production)
- Verify each sending domain D in SES; add the 3 DKIM CNAMEs to that zone.
- Optional custom MAIL FROM `bounce.D` for a cleaner Return-Path.
- Create an SNS topic; subscribe `https://<worker-host>/api/ses/notification` (HTTPS).
  On first POST the Worker logs `SubscribeURL` — open it once to confirm.
- Set `SNS_ALLOWED_TOPIC_ARN`. Configure the SES identity to publish Bounce + Complaint to the topic.

## 5. DNS per domain D
- Enable Cloudflare Email Routing on D (adds MX + TXT).
- SPF TXT includes `include:amazonses.com`.
- DMARC: `_dmarc.D TXT "v=DMARC1; p=quarantine; rua=mailto:dmarc@D"`.
- SES DKIM CNAMEs (step 4).

## 6. Catch-all route per domain
For each domain D: Email Routing → Routes → Catch-all → send to Worker `hidemyemail`.
One Worker serves all domains; it resolves the domain from `message.to`.

## 7. Deploy Worker + Dashboard
```bash
cd worker && npx wrangler deploy
cd ../dashboard && npm run build && npx wrangler pages deploy dist --project-name hidemyemail-dashboard
```
Serve the dashboard same-origin as the API: add a Worker route `app.hidemyemail.dev/api/*`
to the Worker, and point `app.hidemyemail.dev` at the Pages project for the static SPA.

## 8. Pre-production verification (spec §10)
- [ ] Thrown exception in `email()` → sender gets tempfail + retries? (test: break SES creds, send, observe)
- [ ] 25 MB inbound → base64 (~33 MB) accepted by SES (< 40 MB)?
- [ ] SES sending quota vs expected volume (catch-all spam included).
- [ ] aws4fetch SES request signs with `service=ses` and succeeds live.
- [ ] Multi-zone catch-all all reach the one Worker.
- [ ] SNS signature verification implemented before trusting notifications.
- [ ] E2E: send → alias → inbox shows `"X via alias" <r.token@D>`; reply → external receives from alias; real address absent from headers.
