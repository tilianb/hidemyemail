# Self-host hidemyemail in Docker

Runs the production Cloudflare Worker unchanged inside a container, using
[Miniflare](https://github.com/cloudflare/workers-sdk/tree/main/packages/miniflare)
as the runtime. D1 is a local SQLite file; the dashboard SPA is served by
Miniflare's built-in Assets binding. Same routing semantics as prod.

Multi-arch images (`linux/amd64` + `linux/arm64`) are published to
`docker.io/tilianb/hidemyemail` and `ghcr.io/tilianb/hidemyemail` on every push
to `main` and every `v*.*.*` tag.

---

## TL;DR

```bash
git clone https://github.com/tilianb/hidemyemail.git
cd hidemyemail/docker
cp .env.example .env
./gen-secrets.sh >> .env       # see below — or generate by hand
$EDITOR .env                   # set APP_ORIGIN and paste your AWS SES creds
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
2. **AWS account** with SES enabled in a region near you. The container
   replaces the Workers runtime; mail flows through SES.
3. **A domain** you control, with DNS access.

If you prefer to drop AWS entirely and run your own SMTP, this image is not the right path. That requires a larger project with Haraka or Postfix, IP reputation, and DNS.

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

Put the IAM key, region, bucket, and topic ARN into `.env`. The worker auto-confirms the SNS subscription on the first call. Watch `docker compose logs -f app`.

---

## Running

### Pull pre-built image (recommended)

```bash
docker compose pull
docker compose up -d
```

Docker Hub is the default registry. To use GHCR instead:

```bash
IMAGE=ghcr.io/tilianb/hidemyemail docker compose pull
IMAGE=ghcr.io/tilianb/hidemyemail docker compose up -d
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

The container speaks plain HTTP on `:8787`, published to `127.0.0.1` by
default. Do not change that binding to a public address. Put a reverse proxy
on the same host in front for TLS.

Set `APP_ORIGIN` in `.env` to the canonical public dashboard origin seen by
users, for example `https://mail.example.com`. It is required for passkey
origin/RP validation and must be HTTPS in production, with no path, query,
fragment, credentials, or trailing slash. Use `http://localhost:8787` only for
local development without TLS. If omitted, the container still serves mail and
ordinary authentication, but passkey routes return a configuration error.

The container ignores all caller-supplied forwarding headers. For correct
rate-limit client addresses behind a proxy, set `TRUSTED_PROXY_IPS` to the
proxy's **exact socket peer IP** and make the proxy overwrite (never append or
pass through) `X-HideMyEmail-Client-IP`. Do not trust an entire subnet. Leave
`TRUSTED_PROXY_IPS` unset when accessing the loopback publication directly.

**Caddy** (one-liner, auto-renews Let's Encrypt):

```caddyfile
hidemyemail.example.com {
    reverse_proxy localhost:8787 {
        header_up X-HideMyEmail-Client-IP {remote_host}
    }
}
```

For that same-host Caddy example, set `TRUSTED_PROXY_IPS=127.0.0.1,::1`. If
Caddy reaches the published port through a VM or container bridge, use the
single peer address seen by the app instead. Requests from a trusted peer that
omit the header, contain an invalid address, or append multiple addresses are
rejected.

**Cloudflare Tunnel** (no inbound port needed):

```bash
cloudflared tunnel --url http://localhost:8787
```

Configure the tunnel to overwrite `X-HideMyEmail-Client-IP` with the original
client address and trust only cloudflared's socket peer. Do not forward an
incoming value of this private header.

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
`d1_migrations` table inside the SQLite file before accepting HTTP traffic.
Each migration and its tracking row are atomic, so a failed migration rolls
back and is retried on the next start.

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

- **Cron triggers** — The production worker does not use them. If you add
  `[triggers].crons` to `wrangler.jsonc`, wire an external cron service
  to hit `/__scheduled`, or extend `server.mjs` with `mf.dispatchScheduled()`.
- **Multi-region** — single container, single SQLite file. Run one region or
  replicate at the storage layer (Litestream, etc.).
- **Cloudflare-style analytics** — Miniflare writes to stdout. Pipe to your
  log stack.

---

## Why Miniflare?

Same `workerd` runtime as production, with D1 and Assets bindings wired. Raw `workerd` forces a hand-rolled D1 shim. A Node port requires rewriting every request handler against a different runtime. Code changes in `worker/`: **zero**.
