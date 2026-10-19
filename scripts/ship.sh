#!/usr/bin/env bash
# scripts/ship.sh: take what is in this working copy of the voting guide from "edited" to "live",
# with every gate between. Replaces the old ship.sh, which assumed /home/claude paths and pushed
# straight to main.
#
#   scripts/ship.sh "commit message" [paths...]      gates, branch, push, PR, wait for CI, test the preview
#   scripts/ship.sh --gates-only                     just the local gates (no git, no GitHub)
#   scripts/ship.sh --full ...                       the full sweep (every district variant) instead of fast
#   scripts/ship.sh --after-merge <pr-number>        wait for production to update, then smoke-test it
#
# It never merges. Merging waits for an independent review (Kevin's rule for live-deploy repos), so the
# script stops at a green PR and prints the one command to run: gh pr merge <n> --squash
# With paths, only those are staged (new files included). Without, it stages tracked changes only.
#
# Needs: node 18+, npm, git, gh (logged in as an account that can push to khglynn/voting-guide), curl, python3.
set -euo pipefail

PROD_URL="${PROD_URL:-https://voting-guide-silk.vercel.app}"
MODE=fast; GATES_ONLY=0; AFTER_MERGE=""; MSG=""; PATHS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --full) MODE=full ;;
    --gates-only) GATES_ONLY=1 ;;
    --after-merge) shift; AFTER_MERGE="${1:?pr number}" ;;
    -h|--help) sed -n 2,16p "$0"; exit 0 ;;
    *) if [ -z "$MSG" ] && [ "$GATES_ONLY" = 0 ] && [ -z "$AFTER_MERGE" ]; then MSG="$1"; else PATHS+=("$1"); fi ;;
  esac
  shift
done

say() { printf '\n== %s\n' "$*"; }
die() { printf '\nSTOP: %s\n' "$*" >&2; exit 1; }

# The Macs here have a v4 node at /usr/local/bin that shadows the real one.
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt 18 ]; then
  for d in /usr/local/opt/node@22/bin /opt/homebrew/opt/node@22/bin /opt/homebrew/bin; do [ -x "$d/node" ] && PATH="$d:$PATH" && break; done
fi
[ "$(node_major)" -ge 18 ] || die "node 18+ not found (got $(node -v 2>/dev/null || echo none))."

cd "$(git rev-parse --show-toplevel)"
[ -f scripts/build-data.mjs ] || die "run this inside the voting-guide repo."

# ---------- production smoke after a merge ----------
if [ -n "$AFTER_MERGE" ]; then
  say "Waiting for production to rebuild after PR #$AFTER_MERGE"
  before="${BEFORE_GENERATED:-}"
  for i in $(seq 1 60); do
    now="$(curl -sf "$PROD_URL/data/build-report.json" | python3 -c 'import sys,json;print(json.load(sys.stdin)["generated"])' 2>/dev/null || true)"
    if [ -n "$now" ] && [ "$now" != "$before" ]; then echo "production rebuilt: $now"; break; fi
    sleep 10
  done
  [ -n "${now:-}" ] && [ "$now" != "$before" ] || die "production did not change in 10 minutes. Check Vercel: https://vercel.com/kevinhg/voting-guide"
  say "Sweeping production (fast) and running the scripted checks"
  BASE="$PROD_URL" MODE=fast SHOTS_DIR=.tmp/prod-sweep node tests/sweep.mjs || die "production failed its checks. Roll back in Vercel (promote the previous deployment), then fix forward: https://vercel.com/kevinhg/voting-guide"
  BASE="$PROD_URL" SHOTS_DIR=.tmp/prod-e2e node tests/e2e.mjs || die "production failed e2e. Roll back in Vercel, then fix forward."
  echo "Production is live and passing."; exit 0
fi

[ "$GATES_ONLY" = 1 ] || [ -n "$MSG" ] || die 'usage: scripts/ship.sh "commit message" [paths...]   (or --gates-only)'

# ---------- 1. what is about to ship ----------
if [ "$GATES_ONLY" = 0 ]; then
  say "What will ship"
  git fetch -q origin
  [ "$(git rev-parse HEAD)" = "$(git merge-base HEAD origin/main)" ] || die "this checkout has commits origin/main does not know about, or is behind it. Rebase on origin/main first."
  if [ ${#PATHS[@]} -gt 0 ]; then git status -s -- "${PATHS[@]}"; else git status -s; fi
  # Anything that should never be committed by accident
  if git status --porcelain | awk '{print $2}' | grep -E '(^|/)(\.env|.*\.pem|.*credential.*|.*secret.*)$' >/dev/null; then die "a credential-looking file is in the working tree changes. Remove it from this change."; fi
fi

# ---------- 2. local gates (the same checks CI runs) ----------
say "Dependencies"
[ -d node_modules ] || npm ci --no-audit --no-fund
say "Addresses"
node scripts/check-addresses.mjs
say "Data build and rules"
npm run data --silent
node scripts/check-data.mjs
say "Typecheck and production build"
npm run build --silent

say "Browser checks against a local preview"
PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')"
npx vite preview --port "$PORT" --strictPort > .tmp-preview.log 2>&1 &
PREVIEW_PID=$!
trap 'kill $PREVIEW_PID 2>/dev/null || true; rm -f .tmp-preview.log' EXIT
for i in $(seq 1 30); do curl -sf "http://localhost:$PORT/data/index.json" >/dev/null && break; sleep 1; done
curl -sf "http://localhost:$PORT/data/index.json" >/dev/null || { cat .tmp-preview.log; die "preview server did not start."; }
node tests/model.mjs
BASE="http://localhost:$PORT" SHOTS_DIR=.tmp/e2e-shots node tests/e2e.mjs
BASE="http://localhost:$PORT" SHOTS_DIR=.tmp/sweep-shots MODE="$MODE" node tests/sweep.mjs
kill $PREVIEW_PID 2>/dev/null || true
say "Local gates passed ($MODE sweep)"
[ "$GATES_ONLY" = 1 ] && exit 0

# ---------- 3. branch, commit, push, pull request ----------
slug="$(printf '%s' "$MSG" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | cut -c1-40 | sed 's/^-//;s/-$//')"
BRANCH="ship/$(date +%Y%m%d-%H%M)-$slug"
git switch -q -c "$BRANCH"
if [ ${#PATHS[@]} -gt 0 ]; then git add -- "${PATHS[@]}"; else git add -u; fi
git diff --cached --quiet && die "nothing is staged. Name the paths to ship."
git diff --cached --stat
# The address guard once more, on exactly what is staged (a hand-edited data file after the gate run would slip through otherwise).
node scripts/check-addresses.mjs
TRAILER=""; [ -n "${VG_COAUTHOR:-}" ] && TRAILER=$'\n\n'"Co-Authored-By: $VG_COAUTHOR"
git commit -q -m "$MSG$TRAILER"
git push -q -u origin "$BRANCH"
PR_URL="$(gh pr create --base main --head "$BRANCH" --title "$MSG" --body "Gates passed locally before this push: addresses, data rules, typecheck and build, e2e, $MODE sweep of every ballot at 380px. CI and the Vercel preview run the same checks again.")"
PR="${PR_URL##*/}"
say "Opened $PR_URL"

# ---------- 4. wait for CI, then test the Vercel preview ----------
say "Waiting for CI on PR #$PR"
for i in $(seq 1 120); do
  out="$(gh pr checks "$PR" --json name,bucket 2>/dev/null || echo '[]')"
  pending="$(printf '%s' "$out" | python3 -c 'import sys,json;print(sum(1 for c in json.load(sys.stdin) if c["bucket"]=="pending"))')"
  failed="$(printf '%s' "$out" | python3 -c 'import sys,json;print(", ".join(c["name"] for c in json.load(sys.stdin) if c["bucket"]=="fail"))')"
  [ -n "$failed" ] && die "failed on PR #$PR: $failed. Open $PR_URL/checks"
  [ "$pending" = 0 ] && [ "$out" != "[]" ] && break
  sleep 15
done
SHA="$(git rev-parse HEAD)"
say "Finding the preview for $SHA"
PREVIEW=""
for i in $(seq 1 40); do
  PREVIEW="$(gh api "repos/{owner}/{repo}/deployments?sha=$SHA&environment=Preview" --jq '.[0].id // empty' 2>/dev/null | while read -r id; do
    [ -n "$id" ] && gh api "repos/{owner}/{repo}/deployments/$id/statuses" --jq '[.[]|select(.state=="success")][0].environment_url // empty'; done)"
  [ -n "$PREVIEW" ] && break
  sleep 10
done
[ -n "$PREVIEW" ] || die "no successful Vercel preview for $SHA after about 7 minutes. Look at $PR_URL."
echo "preview: $PREVIEW"
BASE="$PREVIEW" MODE=fast SHOTS_DIR=.tmp/preview-sweep node tests/sweep.mjs
BASE="$PREVIEW" SHOTS_DIR=.tmp/preview-e2e node tests/e2e.mjs

BEFORE="$(curl -sf "$PROD_URL/data/build-report.json" | python3 -c 'import sys,json;print(json.load(sys.stdin)["generated"])' 2>/dev/null || true)"
cat <<EOF

PR #$PR is green and its preview passes. Merging waits for the independent review.
After the review is clean, run these two lines, separately:
  gh pr merge $PR --squash
  BEFORE_GENERATED="$BEFORE" scripts/ship.sh --after-merge $PR
EOF
