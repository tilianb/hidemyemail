# Self-host hidemyemail in Docker

Runs the production Cloudflare Worker unchanged inside a container, using
[Miniflare](https://github.com/cloudflare/workers-sdk/tree/main/packages/miniflare)
as the runtime. D1 is backed by a local SQLite file; the dashboard SPA is
served by Miniflare's built-in Assets binding — same routing semantics as
prod.

## What you still need from AWS

This stack replaces the **Worker** only. Mail flow remains on AWS SES because
running your own mail server (Postfix/Haraka + IP reputation + DNS) is a
larger project than this image. You need:

- An **SES domain identity** (DKIM-verified) for each domain you'll alias.
- An **S3 bucket** that SES writes raw inbound MIME into.
- An **SNS topic** with an HTTPS subscription pointing at
  `https://your-host/api/ses/inbound`.
- An **IAM access key** with `ses:SendRawEmail` and `s3:GetObject` on the
  bucket.
- DNS: `MX` → `inbound-smtp.<SES_REGION>.amazonaws.com`, plus SPF/DKIM/DMARC
  records SES gives you.

If you'd rather drop AWS entirely, you'd want option 3 from the design
discussion (Haraka + MinIO + Nodemailer), not this image.

## Quick start

```bash
# 1. Configure
cd docker
cp .env.example .env
$EDITOR .env   # fill in AWS creds + app secrets

# 2. Generate the missing secrets
openssl rand -hex 32                  # → SESSION_SECRET
openssl rand -base64 32               # → DESTINATION_ENCRYPTION_KEY
openssl rand -hex 16                  # → AUTH_PASSWORD_SALT
node ../worker/scripts/hash-password.mjs '<password>' '<salt-from-above>'
                                       # → AUTH_PASSWORD_HASH

# 3. Build + run
docker compose build
docker compose up -d
docker compose logs -f app
```

Container listens on `:8787`. Point a reverse proxy (Caddy, nginx, Cloudflare
Tunnel) at it for TLS. Same-origin: API at `/api/*`, SPA everywhere else.

## Volumes

| Mount | Purpose |
|-------|---------|
| `hidemyemail-data` → `/data` | SQLite D1 file lives here. Back this up. |

To export the DB: `docker compose exec app sh -c "ls /data/d1"` — copy the
`.sqlite` file out.

## Migrations

`server.mjs` applies every `worker/migrations/*.sql` on boot, tracked in a
`d1_migrations` table inside the SQLite file. Idempotent — safe to restart.

When you `git pull` new migrations: `docker compose up -d --build` (rebuild
picks up the new files, server re-runs the pending ones at boot).

## Updating

```bash
git pull
docker compose build --pull
docker compose up -d
```

The image pins Miniflare to the version that matches the worker's
`wrangler` dev dependency. If you bump `worker/package.json`, also update
`docker/package.json` and the `compatibilityDate` so workerd, the bundle, and
the runtime stay in sync.

## Reverse-proxy snippet (Caddy)

```caddyfile
hidemyemail.example.com {
    reverse_proxy localhost:8787
}
```

Then in your SNS HTTPS subscription, use
`https://hidemyemail.example.com/api/ses/inbound` (append `?token=<SNS_SECRET>`
if you set one).

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `Missing required env vars` on start | `.env` not loaded or key blank. `docker compose config` to inspect resolved env. |
| 502 on `/api/ses/inbound` | SNS subscription confirmation not auto-handled — check `docker compose logs app` for the `SubscriptionConfirmation` payload, the worker auto-confirms but logs the URL. |
| `Failed to fetch S3 object` | IAM key lacks `s3:GetObject` on `S3_INBOUND_BUCKET`. |
| `SignatureDoesNotMatch` from SES | Clock drift in container, or wrong `SES_REGION`. |
| SPA loads, API returns 404 | Asset router consumed the request before the worker. Check `routerConfig.static_routing.user_worker` in `server.mjs` still lists `/api/*`. |
| MFA setup screen blank | Dashboard cache. Hard reload; if persistent, rebuild image (commit `9eb5576` fix must be in your tree). |

## What's not (yet) supported here

- **Cron triggers** — the production worker doesn't currently use any. If you
  add `[triggers].crons` in `wrangler.jsonc`, also wire an external cron (a
  separate compose service running `curl http://app:8787/__scheduled`) or
  extend `server.mjs` to call `mf.dispatchScheduled()`.
- **Multi-region** — single container, single SQLite file. Run behind one
  region or replicate at the storage layer.
- **Observability** — Miniflare writes to stdout. Pipe to your log stack.
  No Cloudflare-style request analytics.

## Why Miniflare and not raw workerd / a Node port?

Short version: Miniflare = same `workerd` runtime as production, with the D1
and Assets bindings already wired. Raw `workerd` would force a hand-rolled
D1 shim. A Node port would mean rewriting every request handler against a
different runtime. Code changes here: **zero**.
