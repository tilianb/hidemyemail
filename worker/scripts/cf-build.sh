#!/usr/bin/env bash
#
# Cloudflare Workers Builds entrypoint.
#
# Runs during CF Builds (Git-connected deploys). Builds dashboard assets,
# installs worker deps, and applies D1 migrations to the correct database
# based on the branch being deployed. CF Builds invokes `wrangler deploy`
# itself after this script completes.
#
# Two Workers Builds projects use this script:
#   hidemyemail          (production branch: main → D1 hidemyemail)
#   hidemyemail-preview  (preview branch:    dev  → D1 hidemyemail-env)
#
# Expected CF Builds settings (either root dir works — script self-locates):
#   Root directory:  worker  OR  repo root
#   Build command:   bash worker/scripts/cf-build.sh   (from repo root)
#               or:  bash scripts/cf-build.sh          (root=worker)
#   Deploy command:
#     hidemyemail          → npx wrangler deploy
#     hidemyemail-preview  → npx wrangler deploy --env preview
#                        or (root=repo root): cd worker && npx wrangler deploy --env preview
#
# CF Builds provides an implicit CLOUDFLARE_API_TOKEN for wrangler.
# WORKERS_CI_BRANCH is injected by CF Builds.

set -euo pipefail

# Self-locate: cd to worker/ regardless of caller cwd
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$WORKER_DIR/.." && pwd)"
cd "$WORKER_DIR"

BRANCH="${WORKERS_CI_BRANCH:-${GITHUB_REF_NAME:-unknown}}"
echo "==> Building for branch: $BRANCH (worker=$WORKER_DIR)"

# Build dashboard assets (worker/wrangler.jsonc references ../dashboard/dist)
echo "==> Installing dashboard deps"
(cd "$REPO_ROOT/dashboard" && npm ci)

echo "==> Building dashboard"
(cd "$REPO_ROOT/dashboard" && npm run build)

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
