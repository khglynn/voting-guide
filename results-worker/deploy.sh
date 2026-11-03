#!/usr/bin/env bash
# Deploy the results fetcher to Kevin's personal Cloudflare account (PLAN-PHASE-1 section 1.4).
# Stops unless wrangler is logged in to that account, runs the Worker's tests and the map lint, then deploys.
# Usually run from main after the PR merges; on election night it also ran from the results-worker branch.
# The personal token lives in ~/.env as CLOUDFLARE_API_TOKEN_PERSONAL; a bare shell may fall back to another login.
set -euo pipefail
cd "$(dirname "$0")"
ACCOUNT=759a850a3af3e2fbf1ab036e7eb2f231
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ -f "$HOME/.env" ]; then
  set -a; source "$HOME/.env" >/dev/null 2>&1; set +a
  export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN_PERSONAL:-}" CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID_PERSONAL:-}"
fi
WHO=$(npx wrangler whoami 2>&1 || true)
if ! grep -q "$ACCOUNT" <<<"$WHO"; then echo "deploy: wrangler isn't on the personal account ($ACCOUNT); stopping."; exit 1; fi
npm test
node bin/map-check.mjs
npx wrangler deploy
