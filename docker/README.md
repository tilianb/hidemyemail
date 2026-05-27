# Self-host hidemyemail in Docker

Runs the production Cloudflare Worker unchanged inside a container, using
[Miniflare](https://github.com/cloudflare/workers-sdk/tree/main/packages/miniflare)
as the runtime. D1 is a local SQLite file; the dashboard SPA is served by
Miniflare's built-in Assets binding. Same routing semantics as prod.

Multi-arch image (`linux/amd64` + `linux/arm64`) is published to
`ghcr.io/tilianb/hidemyemail` on every push to `main` and every `v*.*.*` tag.

---

## TL;DR

```bash
git clone https://github.com/tilianb/hidemyemail.git
cd hidemyemail/docker
cp .env.example .env
./gen-secrets.sh >> .env       # see below — or generate by hand
$EDITOR .env                   # paste your AWS SES creds
docker compose up -d
open http://localhost:8787
```

If you don't have `gen-secrets.sh` yet, run these and paste the output into
`.env`:

```bash
echo "SESSION_SECRET=$(openssl rand -hex 32)"
echo "DESTINATION_ENCRYPTION_KEY=$(openssl rand -base64 32)"
node ../worker/scripts/hash-password.mjs '<your-password>'
# prints AUTH_PASSWORD_SALT=... and AUTH_PASSWORD_HASH=...
```

---

## Prerequisites

You need:

1. **Docker** with the `compose` plugin (Docker Desktop, Colima, OrbStack, or
   server-side Docker Engine).
2. **AWS account** with SES enabled in a region near you. The container only
   replaces the Workers runtime — mail still flows through SES.
3. **A domain** you control, with DNS access.

If you'd rather drop AWS entirely (run your own SMTP), this image isn't the
right path — that's a bigger project (Haraka/Postfix + IP reputation + DNS).

---

## AWS setup (one time)

| Step | What | Why |
|------|------|-----|
| 1 | Verify your domain in SES (DKIM on) | Lets SES send + receive for it |
| 2 | Set DNS `MX` → `inbound-smtp.<region>.amazonaws.com` | Routes inbound to SES |
| 3 | Add SPF + DMARC records SES shows you | Deliverability + anti-spoof |
| 4 | Create S3 bucket (e.g. `hidemyemail-inbound-raw`) | Holds raw MIME |
| 5 | Add SES receipt rule: store to S3 + publish to SNS | Triggers webhook |
| 6 | Create SNS topic + HTTPS subscription → `https://<your-host>/api/ses/inbound` | Worker entry point |
| 7 | Create IAM user with `ses:SendRawEmail` + `s3:GetObject` on the bucket | Worker credentials |
| 8 | (Optional) Request SES production access | Removes sandbox sending limits |

Put the IAM key + region + bucket + topic ARN into `.env`. The worker
auto-confirms the SNS subscription on first call — watch
`docker compose logs -f app`.

---

## Running

### Pull pre-built image (recommended)

```bash
docker compose pull
docker compose up -d
```

### Pin a release

```bash
IMAGE_TAG=v1.2.3 docker compose up -d
```

### Build from source

For development or if you don't want to trust GHCR:

```bash
PULL_POLICY=never docker compose build
PULL_POLICY=never docker compose up -d
```

### Tail logs

```bash
docker compose logs -f app
```

### Stop / restart

```bash
docker compose down                 # stop, keep data
docker compose down -v              # stop + DELETE SQLite volume
docker compose restart app
```

---

## TLS / reverse proxy

The container speaks plain HTTP on `:8787`. Don't expose that directly to the
internet — put a reverse proxy in front for TLS.

**Caddy** (one-liner, auto-renews Let's Encrypt):

```caddyfile
hidemyemail.example.com {
    reverse_proxy localhost:8787
}
```

**Cloudflare Tunnel** (no inbound port needed):

```bash
cloudflared tunnel --url http://localhost:8787
```

Then point your SNS HTTPS subscription at `https://hidemyemail.example.com/api/ses/inbound`.

---

## Volumes & backups

| Volume | Mount | Contents |
|--------|-------|----------|
| `hidemyemail-data` | `/data` | SQLite D1 file (`/data/d1/…`) |

**Backup:**

```bash
docker run --rm -v hidemyemail-data:/data -v "$PWD":/out \
  alpine tar czf /out/hidemyemail-$(date +%F).tar.gz -C /data .
```

**Restore:**

```bash
docker compose down
docker run --rm -v hidemyemail-data:/data -v "$PWD":/in \
  alpine sh -c "rm -rf /data/* && tar xzf /in/hidemyemail-YYYY-MM-DD.tar.gz -C /data"
docker compose up -d
```

---

## Migrations

`server.mjs` applies every `worker/migrations/*.sql` on boot, tracked in a
`d1_migrations` table inside the SQLite file. Idempotent — restart is safe.

When you upgrade the image, new migrations run automatically.

---

## Updating

**Pre-built image** (most users):

```bash
docker compose pull
docker compose up -d
```

**Built from source:**

```bash
git pull
PULL_POLICY=never docker compose build --pull
PULL_POLICY=never docker compose up -d
```

The image pins Miniflare to a version matching the worker's `wrangler` dev
dependency. If you bump `worker/package.json`, also update
`docker/package.json` and the `compatibilityDate` in `server.mjs` so workerd,
the bundle, and the runtime stay in sync.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| `Missing required env vars` on start | `.env` not loaded or key blank. Run `docker compose config` to inspect resolved env. |
| Browser shows "unauthorized" on login | Wrong `AUTH_PASSWORD_HASH` / `_SALT`. Re-run `hash-password.mjs` and copy both lines. |
| `Failed to fetch S3 object` | IAM key lacks `s3:GetObject` on `S3_INBOUND_BUCKET`. |
| `SignatureDoesNotMatch` from SES | Container clock drift, or wrong `SES_REGION`. Restart Docker engine. |
| 502 on `/api/ses/inbound` | SNS subscription not confirmed. Check `docker compose logs app` — worker auto-confirms but prints the URL if it fails. |
| SPA loads but API returns 404 | Asset router stole the request. Confirm `routerConfig.static_routing.user_worker` in `server.mjs` lists `/api/*`. |
| `port is already allocated` | Something else on `:8787`. Set `HOST_PORT=18787` in `.env`. |
| Image pull fails (`denied`) | GHCR package is private. Make it public in your fork's Packages settings, or `docker login ghcr.io` first. |

---

## What's not (yet) supported here

- **Cron triggers** — production worker doesn't use any. If you add
  `[triggers].crons` to `wrangler.jsonc`, also wire an external cron service
  hitting `/__scheduled`, or extend `server.mjs` with `mf.dispatchScheduled()`.
- **Multi-region** — single container, single SQLite file. Run one region or
  replicate at the storage layer (Litestream, etc.).
- **Cloudflare-style analytics** — Miniflare writes to stdout. Pipe to your
  log stack.

---

## Why Miniflare?

Same `workerd` runtime as production, with D1 and Assets bindings already
wired. Raw `workerd` would force a hand-rolled D1 shim. A Node port would
mean rewriting every request handler against a different runtime. Code
changes in `worker/`: **zero**.
