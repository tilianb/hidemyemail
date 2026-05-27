#!/usr/bin/env bash
# Generate the four required secrets and print them in .env format.
#
# Usage:
#   ./gen-secrets.sh                  # prompts for the admin password
#   ./gen-secrets.sh <password>       # uses the given password
#
# Pipe straight into .env:
#   ./gen-secrets.sh >> .env
#
set -euo pipefail

password="${1:-}"
if [ -z "$password" ]; then
  read -rsp "Choose an admin password: " password
  echo >&2
fi

if [ -z "$password" ]; then
  echo "error: password cannot be empty" >&2
  exit 1
fi

# Resolve script dir so the relative path to hash-password.mjs works from
# anywhere the user calls it.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
hash_script="$script_dir/../worker/scripts/hash-password.mjs"

if [ ! -f "$hash_script" ]; then
  echo "error: $hash_script not found — run from a hidemyemail checkout" >&2
  exit 1
fi

echo "# Generated $(date -u +%FT%TZ) by docker/gen-secrets.sh"
echo "SESSION_SECRET=$(openssl rand -hex 32)"
echo "DESTINATION_ENCRYPTION_KEY=$(openssl rand -base64 32)"
node "$hash_script" "$password"
