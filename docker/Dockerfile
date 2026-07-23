# syntax=docker/dockerfile:1.7
#
# hidemyemail.dev — self-host Docker image.
#
# Runs the Cloudflare Worker via Miniflare (workerd embedded in Node) so the
# production code paths (D1, Assets binding, WebCrypto, fetch) work unchanged.
# Inbound MX, S3 raw store, and SNS notifications are still expected to come
# from AWS SES — this container only replaces the Workers runtime.

# ──────────────────────────────────────────────────────────────────────────────
# Stage 1: build dashboard SPA + bundle worker
# ──────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

WORKDIR /src

# Install deps first (cache layer)
COPY worker/package.json worker/package-lock.json ./worker/
COPY dashboard/package.json dashboard/package-lock.json ./dashboard/
RUN --mount=type=cache,target=/root/.npm \
    cd worker && npm ci --no-audit --no-fund && \
    cd ../dashboard && npm ci --no-audit --no-fund

# Copy sources
COPY worker ./worker
COPY dashboard ./dashboard

# Build dashboard (writes to dashboard/dist) and bundle worker (writes to worker/dist)
# wrangler --dry-run produces a portable ES module bundle without contacting CF.
RUN cd dashboard && npm run build && \
    cd ../worker && npx wrangler deploy --dry-run --outdir=dist --env="" 2>&1 | tail -20

# ──────────────────────────────────────────────────────────────────────────────
# Stage 2: runtime dependencies — install on glibc Linux, then copy only output
# ──────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime-deps

WORKDIR /app

# Pin Miniflare to the same minor as the worker's wrangler so compatibility-date
# semantics line up. Bump together. Use the lockfile for reproducible installs.
COPY docker/package.json docker/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund --omit=dev && \
    mkdir -p /data

# ──────────────────────────────────────────────────────────────────────────────
# Stage 3: runtime — distroless Miniflare host
# ──────────────────────────────────────────────────────────────────────────────
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime

WORKDIR /app

COPY --from=runtime-deps --chown=nonroot:nonroot /app/package.json ./package.json
COPY --from=runtime-deps --chown=nonroot:nonroot /app/node_modules ./node_modules

# Bundled worker + SPA assets + migrations
COPY --from=builder --chown=nonroot:nonroot /src/worker/dist ./worker-dist
COPY --from=builder --chown=nonroot:nonroot /src/dashboard/dist ./public
COPY --from=builder --chown=nonroot:nonroot /src/worker/migrations ./migrations

# Server entrypoint and its local modules
COPY --chown=nonroot:nonroot docker/server.mjs ./server.mjs
COPY --chown=nonroot:nonroot docker/client-ip.mjs ./client-ip.mjs
COPY --chown=nonroot:nonroot docker/migrations.mjs ./migrations.mjs

# D1 sqlite file lives here — mount a volume to persist
COPY --from=runtime-deps --chown=nonroot:nonroot /data /data
VOLUME ["/data"]

USER nonroot:nonroot
EXPOSE 8787

ENV NODE_ENV=production \
    DATA_DIR=/data \
    ASSETS_DIR=/app/public \
    WORKER_SCRIPT=/app/worker-dist/index.js \
    MIGRATIONS_DIR=/app/migrations \
    PORT=8787 \
    HOST=0.0.0.0

CMD ["server.mjs"]
