#!/usr/bin/env bash
#
# Cloudflare Workers Builds entrypoint.
#
# Runs during CF Builds (Git-connected deploys). Builds dashboard assets,
# installs worker deps, and applies D1 migrations to the correct database
# based on the branch being deployed. CF Builds invokes `wrangler deploy`
# itself after this script completes.
#
# Expected CF Builds settings:
#   Root directory:  worker
#   Build command:   bash scripts/cf-build.sh
#   Deploy command:  (leave default — main: `npx wrangler deploy`,
#                                     dev:  `npx wrangler deploy --env preview`)
#
# CF Builds provides an implicit CLOUDFLARE_API_TOKEN for wrangler.
# WORKERS_CI_BRANCH is injected by CF Builds.

set -euo pipefail

BRANCH="${WORKERS_CI_BRANCH:-${GITHUB_REF_NAME:-unknown}}"
echo "==> Building for branch: $BRANCH"

# Build dashboard assets (worker/wrangler.jsonc references ../dashboard/dist)
echo "==> Installing dashboard deps"
(cd ../dashboard && npm ci)

echo "==> Building dashboard"
(cd ../dashboard && npm run build)

# Install worker deps (wrangler lives here)
echo "==> Installing worker deps"
npm ci

# Apply D1 migrations for the target environment
case "$BRANCH" in
  main)
    echo "==> Applying D1 migrations to production (hidemyemail)"
    npx wrangler d1 migrations apply hidemyemail --remote
    ;;
  dev)
    echo "==> Applying D1 migrations to preview (hidemyemail-env)"
    npx wrangler d1 migrations apply hidemyemail-env --remote --env preview
    ;;
  *)
    echo "==> Unknown branch '$BRANCH' — skipping D1 migrations"
    ;;
esac

echo "==> Build complete"
