#!/usr/bin/env bash
# scripts/ship.sh: take what is in this working copy of the voting guide from "edited" to "live",
# with every gate between. Replaces the old ship.sh, which assumed /home/claude paths and pushed
# straight to main.
#
#   scripts/ship.sh "commit message" [paths...]      gates on the exact commit, branch, push, PR, wait for CI, test the preview
#   scripts/ship.sh --gates-only                     just the local gates, on the working copy (no git, no GitHub)
#   scripts/ship.sh --full ...                       the full sweep (every district variant) instead of fast
#   scripts/ship.sh --after-merge <pr-number>        prove production serves that PR's merge commit, then test production
#   scripts/ship.sh --self-test                      check this script's CI and deploy decisions against canned answers
#
# Ship from an up-to-date main. With paths, only those ship (new files included); without, every
# tracked change ships. Anything already staged that is not part of the ship stops it. The gates run
# on a copy of exactly the tree that will be committed, so a file left out of the ship, or a change
# that stays behind in the working copy, cannot make them pass.
#
# It never merges. Merging waits for an independent review (Kevin's rule for live-deploy repos), so the
# script stops at a green PR and prints the one command to run: gh pr merge <n> --squash
# Green means the required checks (data, browser) each finished with success on the PR's exact head
# commit: cancelled, skipped, timed out or missing is not green, and every wait has a time limit.
# A preview or production counts only when its build-report.json names the expected commit.
#
# Needs: node 18+, npm, git, gh (logged in as an account that can push to khglynn/voting-guide), curl, python3.
set -euo pipefail

PROD_URL="${PROD_URL:-https://voting-guide-silk.vercel.app}"
REPO="${VG_REPO:-khglynn/voting-guide}"
REQUIRED_CHECKS="data browser"            # the job names in .github/workflows/ci.yml
CI_TIMEOUT="${CI_TIMEOUT:-1800}"          # seconds to wait for the required checks
DEPLOY_TIMEOUT="${DEPLOY_TIMEOUT:-900}"   # seconds to wait for Vercel to build and serve a commit
MODE=fast; GATES_ONLY=0; SELF_TEST=0; AFTER_MERGE=""; MSG=""; PATHS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --full) MODE=full ;;
    --gates-only) GATES_ONLY=1 ;;
    --self-test) SELF_TEST=1 ;;
    --after-merge) shift; AFTER_MERGE="${1:?pr number}" ;;
    -h|--help) sed -n 2,23p "$0"; exit 0 ;;
    *) if [ -z "$MSG" ] && [ "$GATES_ONLY" = 0 ] && [ -z "$AFTER_MERGE" ]; then MSG="$1"; else PATHS+=("$1"); fi ;;
  esac
  shift
done

say() { printf '\n== %s\n' "$*"; }
span() { if [ "$1" -ge 60 ]; then echo "$(($1 / 60)) minutes"; else echo "$1 seconds"; fi; }
die() { printf '\nSTOP: %s\n' "$*" >&2; exit 1; }

# ---------- decisions, kept apart from the waiting so --self-test can check them ----------
# GitHub's check runs for one commit (JSON on stdin) -> one line: "pass ...", "wait ..." or "fail ...".
# Each required check is judged by its newest run from GitHub Actions. Only "success" is green.
IFS= read -r -d '' VERDICT_PY <<'PY' || true
import json, os, sys
required = os.environ["REQUIRED"].split()
try:
    runs = json.load(sys.stdin)["check_runs"]
except Exception:
    print("wait GitHub gave no list of checks")
    sys.exit()
state, notes = "pass", []
for name in required:
    mine = sorted((r for r in runs if r.get("name") == name and (r.get("app") or {}).get("slug") == "github-actions"), key=lambda r: r["id"])
    if not mine:
        notes.append(name + ": not started")
        state = "fail" if state == "fail" else "wait"
        continue
    r = mine[-1]
    if r.get("status") != "completed":
        notes.append(name + ": " + str(r.get("status")))
        state = "fail" if state == "fail" else "wait"
    elif r.get("conclusion") != "success":
        notes.append(name + ": " + str(r.get("conclusion")) + " " + str(r.get("html_url") or ""))
        state = "fail"
    else:
        notes.append(name + ": success")
others = sorted({r.get("name", "?") + ": " + str(r.get("conclusion") or r.get("status")) for r in runs
                 if r.get("name") not in required and r.get("conclusion") not in ("success", "skipped", "neutral")})
print(state + " " + "; ".join(notes) + (" (not required, for your information: " + ", ".join(others) + ")" if others else ""))
PY
checks_verdict() { REQUIRED="$REQUIRED_CHECKS" python3 -c "$VERDICT_PY"; }

# The Vercel bot's PR comment (on stdin) carries its data as base64 JSON; print the preview URL in it.
IFS= read -r -d '' PREVIEW_PY <<'PY' || true
import base64, json, re, sys
m = re.search(r"\[vc\]: #[^:\s]+:([A-Za-z0-9+/=]+)", sys.stdin.read())
if m:
    s = m.group(1).rstrip("=")
    try:
        data = json.loads(base64.b64decode(s + "=" * (-len(s) % 4)))
    except Exception:
        data = {}
    for p in data.get("projects", []):
        if p.get("name") == "voting-guide" and p.get("previewUrl"):
            print("https://" + p["previewUrl"])
            break
PY

fetch_checks() { gh api "repos/$REPO/commits/$1/check-runs?per_page=100" 2>/dev/null || true; }
fetch_vercel_state() { gh api "repos/$REPO/commits/$1/status" --jq '[.statuses[] | select(.context=="Vercel")][0].state // "none"' 2>/dev/null || echo unknown; }
fetch_vercel_comment() { gh api "repos/$REPO/issues/$1/comments?per_page=100" --jq '[.[] | select(.user.login=="vercel[bot]")] | last | .body // ""' 2>/dev/null || true; }
# The commit a deployment says it was built from (build-report.json's "commit"), or nothing.
served_commit() {
  curl -sf --max-time 20 "$1/data/build-report.json" 2>/dev/null | python3 -c 'import json, sys
try:
    print(json.load(sys.stdin).get("commit") or "")
except Exception:
    print("")' 2>/dev/null || true
}

wait_required_checks() { # $1 commit. Returns when every required check passed on it; dies otherwise.
  local sha="$1" deadline=$((SECONDS + CI_TIMEOUT)) verdict
  while :; do
    verdict="$(fetch_checks "$sha" | checks_verdict)"
    case "$verdict" in
      pass\ *) echo "${verdict#pass }"; return 0 ;;
      fail\ *) die "required checks did not pass on ${sha:0:12}: ${verdict#fail }" ;;
    esac
    [ "$SECONDS" -lt "$deadline" ] || die "gave up after $(span "$CI_TIMEOUT") waiting for the required checks on ${sha:0:12}: ${verdict#wait }"
    sleep 20
  done
}
wait_vercel() { # $1 commit, $2 preview|production. Vercel's own commit status must reach success.
  local sha="$1" deadline=$((SECONDS + DEPLOY_TIMEOUT)) st
  while :; do
    st="$(fetch_vercel_state "$sha")"
    case "$st" in
      success) return 0 ;;
      failure|error) die "Vercel's $2 build of ${sha:0:12} failed ($st). https://vercel.com/kevinhg/voting-guide" ;;
    esac
    [ "$SECONDS" -lt "$deadline" ] || die "Vercel's $2 build of ${sha:0:12} did not finish in $(span "$DEPLOY_TIMEOUT") (last state: $st)."
    sleep 15
  done
}
wait_serves() { # $1 url, $2 commit, $3 label, $4 1 if a later commit that contains $2 also counts
  local url="$1" sha="$2" what="$3" newer_ok="${4:-0}" deadline=$((SECONDS + DEPLOY_TIMEOUT)) got
  while :; do
    got="$(served_commit "$url")"
    if [ "$got" = "$sha" ]; then echo "$what serves ${sha:0:12}"; return 0; fi
    if [ -n "$got" ] && [ "$newer_ok" = 1 ]; then
      git fetch -q origin main 2>/dev/null || true
      if git merge-base --is-ancestor "$sha" "$got" 2>/dev/null; then echo "$what serves ${got:0:12}, a later commit that includes ${sha:0:12}"; return 0; fi
    fi
    [ "$SECONDS" -lt "$deadline" ] || die "$what ($url) serves commit '${got:-none recorded}', not ${sha:0:12}, after $(span "$DEPLOY_TIMEOUT"). If production is wrong, roll back in Vercel (promote the previous deployment), then fix forward: https://vercel.com/kevinhg/voting-guide"
    sleep 15
  done
}

# ---------- --self-test: the decisions above, on canned answers ----------
if [ "$SELF_TEST" = 1 ]; then
  bad=0
  run() { printf '{"id":%s,"name":"%s","status":"%s","conclusion":%s,"app":{"slug":"%s"},"html_url":"https://github.com/x/runs/%s"}' "$1" "$2" "$3" "$4" "${5:-github-actions}" "$1"; }
  expect() { # $1 want, $2 label, $3 got
    if [ "${3%% *}" = "$1" ]; then echo "ok    $2 -> $3"; else echo "FAIL  $2: want $1, got: $3"; bad=$((bad + 1)); fi
  }
  verdict_of() { printf '%s' "$1" | checks_verdict; }
  V='{"check_runs":['"$(run 9 'Vercel Preview Comments' completed '"success"' vercel)"
  expect wait "only Vercel has reported (Codex: this was green before)" "$(verdict_of "$V]}")"
  expect wait "data passed, browser not started" "$(verdict_of "$V,$(run 10 data completed '"success"')]}")"
  expect wait "data passed, browser running" "$(verdict_of "$V,$(run 10 data completed '"success"'),$(run 11 browser in_progress null)]}")"
  expect fail "browser cancelled (Codex: this was green before)" "$(verdict_of "$V,$(run 10 data completed '"success"'),$(run 11 browser completed '"cancelled"')]}")"
  expect fail "browser skipped (Codex: this was green before)" "$(verdict_of "$V,$(run 10 data completed '"success"'),$(run 11 browser completed '"skipped"')]}")"
  expect fail "data timed out" "$(verdict_of "$V,$(run 10 data completed '"timed_out"'),$(run 11 browser completed '"success"')]}")"
  expect fail "data failed while browser still runs" "$(verdict_of "$V,$(run 10 data completed '"failure"'),$(run 11 browser queued null)]}")"
  expect wait "a check named data from another app does not count" "$(verdict_of "$V,$(run 10 data completed '"success"' someone-else),$(run 11 browser completed '"success"')]}")"
  expect pass "both passed" "$(verdict_of "$V,$(run 10 data completed '"success"'),$(run 11 browser completed '"success"')]}")"
  expect pass "browser failed, then its re-run passed" "$(verdict_of "$V,$(run 10 data completed '"success"'),$(run 11 browser completed '"failure"'),$(run 12 browser completed '"success"')]}")"
  expect fail "browser passed, then its re-run failed" "$(verdict_of "$V,$(run 10 data completed '"success"'),$(run 11 browser completed '"success"'),$(run 12 browser completed '"failure"')]}")"
  expect pass "both passed; an unrelated check failed" "$(verdict_of "$V,$(run 10 data completed '"success"'),$(run 11 browser completed '"success"'),$(run 13 copilot-pull-request-reviewer completed '"failure"')]}")"
  expect wait "GitHub did not answer" "$(verdict_of '')"
  # The waits give up instead of falling through.
  fetch_checks() { printf '%s' "$V,$(run 10 data completed '"success"'),$(run 11 browser in_progress null)]}"; }
  got="$( (CI_TIMEOUT=0; wait_required_checks 0123456789abcdef) 2>&1 )" && rc=0 || rc=$?
  [ "$rc" != 0 ] && echo "$got" | grep -q 'gave up' && echo "ok    the CI wait gives up when time runs out -> exit $rc" || { echo "FAIL  the CI wait did not give up: rc=$rc $got"; bad=$((bad + 1)); }
  fetch_vercel_state() { echo pending; }
  got="$( (DEPLOY_TIMEOUT=0; wait_vercel 0123456789abcdef production) 2>&1 )" && rc=0 || rc=$?
  [ "$rc" != 0 ] && echo "ok    the Vercel wait gives up when time runs out -> exit $rc" || { echo "FAIL  the Vercel wait did not give up"; bad=$((bad + 1)); }
  fetch_vercel_state() { echo failure; }
  got="$( (wait_vercel 0123456789abcdef production) 2>&1 )" && rc=0 || rc=$?
  [ "$rc" != 0 ] && echo "ok    a failed Vercel build stops the ship -> exit $rc" || { echo "FAIL  a failed Vercel build passed"; bad=$((bad + 1)); }
  # Production must serve the merge commit (Codex: an old deployment used to count as rebuilt).
  served_commit() { echo 1111111111111111111111111111111111111111; }
  got="$( (DEPLOY_TIMEOUT=0; wait_serves https://example.invalid 2222222222222222222222222222222222222222 production 0) 2>&1 )" && rc=0 || rc=$?
  [ "$rc" != 0 ] && echo "ok    a deployment serving another commit does not count -> exit $rc" || { echo "FAIL  a deployment serving another commit counted"; bad=$((bad + 1)); }
  served_commit() { echo ''; }
  got="$( (DEPLOY_TIMEOUT=0; wait_serves https://example.invalid 2222222222222222222222222222222222222222 production 1) 2>&1 )" && rc=0 || rc=$?
  [ "$rc" != 0 ] && echo "ok    a deployment that names no commit does not count -> exit $rc" || { echo "FAIL  a deployment naming no commit counted"; bad=$((bad + 1)); }
  served_commit() { echo 2222222222222222222222222222222222222222; }
  got="$( (DEPLOY_TIMEOUT=0; wait_serves https://example.invalid 2222222222222222222222222222222222222222 production 0) 2>&1 )" && rc=0 || rc=$?
  [ "$rc" = 0 ] && echo "ok    a deployment serving the commit counts -> $got" || { echo "FAIL  the right commit did not count: $got"; bad=$((bad + 1)); }
  # The preview URL from the Vercel bot's comment (PR #3's real comment, 2026-10-19).
  C='[vc]: #jZ4+aKnWQ4nmsFf4HlRAIv1dtreTz50my/dH5XNFBdk=:eyJpc01vbm9yZXBvIjp0cnVlLCJ0eXBlIjoiZ2l0aHViIiwicHJvamVjdHMiOlt7Im5hbWUiOiJ2b3RpbmctZ3VpZGUiLCJwcm9qZWN0SWQiOiJwcmpfbHVBUW55TTA5b2RrVjhxUjRTT0dlTGxDclRLcCIsImxpdmVGZWVkYmFjayI6eyJyZXNvbHZlZCI6MCwidW5yZXNvbHZlZCI6MCwidG90YWwiOjAsImxpbmsiOiJ2b3RpbmctZ3VpZGUtZ2l0LWNpLWZvdW5kYXRpb24ta2V2aW5oZy52ZXJjZWwuYXBwIn0sImluc3BlY3RvclVybCI6Imh0dHBzOi8vdmVyY2VsLmNvbS9rZXZpbmhnL3ZvdGluZy1ndWlkZS9IRnppRGh5WUY0aVBCRmN1aG1kd29NemROSjZLIiwicHJldmlld1VybCI6InZvdGluZy1ndWlkZS1naXQtY2ktZm91bmRhdGlvbi1rZXZpbmhnLnZlcmNlbC5hcHAiLCJuZXh0Q29tbWl0U3RhdHVzIjoiREVQTE9ZRUQifV0sInJlcXVlc3RSZXZpZXdVcmwiOiJodHRwczovL3ZlcmNlbC5jb20vdmVyY2VsLWFnZW50L3JlcXVlc3QtcmV2aWV3P293bmVyPWtoZ2x5bm4mcmVwbz12b3RpbmctZ3VpZGUmcHI9MyJ9'
  got="$(printf '%s\nThe latest updates on your projects.' "$C" | python3 -c "$PREVIEW_PY")"
  [ "$got" = "https://voting-guide-git-ci-foundation-kevinhg.vercel.app" ] && echo "ok    preview URL read from the Vercel comment -> $got" || { echo "FAIL  preview URL: got '$got'"; bad=$((bad + 1)); }
  [ "$bad" = 0 ] && { echo "ship.sh self-test: every case right."; exit 0; }
  echo "ship.sh self-test: $bad cases wrong."; exit 1
fi

# The Macs here have a v4 node at /usr/local/bin that shadows the real one.
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt 18 ]; then
  for d in /usr/local/opt/node@22/bin /opt/homebrew/opt/node@22/bin /opt/homebrew/bin; do [ -x "$d/node" ] && PATH="$d:$PATH" && break; done
fi
[ "$(node_major)" -ge 18 ] || die "node 18+ not found (got $(node -v 2>/dev/null || echo none))."

cd "$(git rev-parse --show-toplevel)"
[ -f scripts/build-data.mjs ] || die "run this inside the voting-guide repo."
REPO_ROOT="$PWD"

# ---------- production after a merge: it must serve that PR's merge commit ----------
if [ -n "$AFTER_MERGE" ]; then
  say "Finding PR #$AFTER_MERGE's merge commit"
  info="$(gh pr view "$AFTER_MERGE" --repo "$REPO" --json state,mergeCommit --jq '.state + " " + (.mergeCommit.oid // "")')" || die "could not read PR #$AFTER_MERGE from GitHub."
  state="${info%% *}"; MERGED_SHA="${info#* }"
  [ "$state" = MERGED ] && [ -n "$MERGED_SHA" ] || die "PR #$AFTER_MERGE is $state, not merged. Merge it after its review (gh pr merge $AFTER_MERGE --squash), then rerun this."
  echo "merge commit: $MERGED_SHA"
  say "Waiting for Vercel to build ${MERGED_SHA:0:12} for production"
  wait_vercel "$MERGED_SHA" production
  say "Waiting for $PROD_URL to serve it"
  wait_serves "$PROD_URL" "$MERGED_SHA" production 1
  say "Sweeping production (fast) and running the scripted checks"
  BASE="$PROD_URL" MODE=fast SHOTS_DIR=.tmp/prod-sweep node tests/sweep.mjs || die "production failed its checks. Roll back in Vercel (promote the previous deployment), then fix forward: https://vercel.com/kevinhg/voting-guide"
  BASE="$PROD_URL" SHOTS_DIR=.tmp/prod-e2e node tests/e2e.mjs || die "production failed e2e. Roll back in Vercel, then fix forward."
  echo "Production serves PR #$AFTER_MERGE's merge commit and passes."; exit 0
fi

[ "$GATES_ONLY" = 1 ] || [ -n "$MSG" ] || die 'usage: scripts/ship.sh "commit message" [paths...]   (or --gates-only, --after-merge <pr>, --self-test)'

# ---------- the local gates (the same checks CI runs), in a given folder ----------
run_gates() { # $1 folder holding the files to check, $2 label, $3 changed files to scan for addresses (newline-separated)
  ( cd "$1"
    say "Gates on $2"
    [ -d node_modules ] || npm ci --no-audit --no-fund
    say "Addresses"
    node scripts/check-addresses.mjs --self-test > /dev/null || die "the address guard failed its own self-test (node scripts/check-addresses.mjs --self-test)."
    node scripts/check-addresses.mjs
    if [ -n "${3:-}" ]; then
      files=(); while IFS= read -r f; do [ -f "$f" ] && files+=("$f"); done <<< "$3"
      if [ ${#files[@]} -gt 0 ]; then echo "and every file this change touches:"; node scripts/check-addresses.mjs "${files[@]}"; fi
    fi
    say "Data build and rules"
    npm run data --silent
    node scripts/check-data.mjs
    say "Typecheck and production build"
    npm run build --silent
    say "Browser checks against a local preview"
    port="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')"
    npx vite preview --port "$port" --strictPort > .tmp-preview.log 2>&1 &
    pid=$!
    trap 'kill $pid 2>/dev/null || true; rm -f .tmp-preview.log' EXIT
    for i in $(seq 1 30); do curl -sf "http://localhost:$port/data/index.json" >/dev/null && break; sleep 1; done
    curl -sf "http://localhost:$port/data/index.json" >/dev/null || { cat .tmp-preview.log; die "preview server did not start."; }
    BASE="http://localhost:$port" SHOTS_DIR=.tmp/e2e-shots node tests/e2e.mjs
    BASE="http://localhost:$port" SHOTS_DIR=.tmp/sweep-shots MODE="$MODE" node tests/sweep.mjs
  )
}

if [ "$GATES_ONLY" = 1 ]; then
  run_gates "$REPO_ROOT" "the working copy"
  say "Local gates passed on the working copy ($MODE sweep)"; exit 0
fi

SHIP_INDEX=""; GATE_DIR=""
on_exit() {
  local rc=$?
  [ -z "$SHIP_INDEX" ] || rm -f "$SHIP_INDEX"
  if [ "$rc" != 0 ] && [ -n "$GATE_DIR" ] && [ -d "$GATE_DIR" ]; then echo "The copy the gates ran on, with its screenshots, is in $GATE_DIR" >&2; fi
}
trap on_exit EXIT

# ---------- 1. exactly what will ship ----------
say "What will ship"
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "ship from an up-to-date main: this checkout is at $(git rev-parse --short HEAD), origin/main is at $(git rev-parse --short origin/main). Run: git switch main && git pull --ff-only"
# Anything already staged must belong to this ship, or the commit would carry it along unseen.
if [ ${#PATHS[@]} -gt 0 ]; then
  unexpected="$(comm -23 <(git diff --cached --name-only --no-renames | sort) <(git diff --cached --name-only --no-renames -- "${PATHS[@]}" | sort))"
else
  unexpected="$(git diff --cached --name-only --no-renames --diff-filter=A)"
fi
[ -z "$unexpected" ] || die "staged, but not part of this ship: $(printf '%s ' $unexpected)
Unstage them (git restore --staged <path>) or name them as paths to ship. Nothing was changed."
# Build the tree to commit in a private index that starts from HEAD, so nothing else can ride along.
SHIP_INDEX="$(cd "$(git rev-parse --git-dir)" && pwd)/ship-index.$$"
GIT_INDEX_FILE="$SHIP_INDEX" git read-tree HEAD
if [ ${#PATHS[@]} -gt 0 ]; then GIT_INDEX_FILE="$SHIP_INDEX" git add -- "${PATHS[@]}"; else GIT_INDEX_FILE="$SHIP_INDEX" git add -u; fi
TREE="$(GIT_INDEX_FILE="$SHIP_INDEX" git write-tree)"
rm -f "$SHIP_INDEX"; SHIP_INDEX=""
[ "$TREE" != "$(git rev-parse 'HEAD^{tree}')" ] || die "nothing to ship: no changes in $([ ${#PATHS[@]} -gt 0 ] && echo 'the named paths' || echo 'tracked files')."
CHANGED="$(git diff --name-only --no-renames --diff-filter=d HEAD "$TREE")"
git diff --stat HEAD "$TREE"
if git diff --name-only --no-renames HEAD "$TREE" | grep -Ei '(^|/)(\.env[^/]*|[^/]*\.pem|[^/]*credential[^/]*|[^/]*secret[^/]*)$' >/dev/null; then die "a credential-looking file is in this change. Remove it from the ship."; fi

# ---------- 2. the gates, on a copy of exactly that tree ----------
mkdir -p .tmp
GATE_DIR="$REPO_ROOT/.tmp/ship-gate-$(date +%Y%m%d-%H%M%S)-$$"
mkdir "$GATE_DIR"
git archive --format=tar "$TREE" | tar -x -C "$GATE_DIR"
if git diff --quiet HEAD "$TREE" -- package.json package-lock.json && [ -d node_modules ]; then ln -s "$REPO_ROOT/node_modules" "$GATE_DIR/node_modules"; fi
run_gates "$GATE_DIR" "exactly the tree this ship commits" "$CHANGED"
say "Local gates passed on the exact tree ($MODE sweep)"
rm -rf "$GATE_DIR"; GATE_DIR="" # our own export and its build output; the symlinked node_modules is not followed

# ---------- 3. commit that tree, push, pull request ----------
slug="$(printf '%s' "$MSG" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | cut -c1-40 | sed 's/^-//;s/-$//')"
BRANCH="ship/$(date +%Y%m%d-%H%M)-$slug"
git switch -q -c "$BRANCH"
if [ ${#PATHS[@]} -gt 0 ]; then git add -- "${PATHS[@]}"; else git add -u; fi
[ "$(git write-tree)" = "$TREE" ] || die "what is staged now is not the tree the gates passed (did a file change while they ran?). Nothing was committed. You are on $BRANCH with your changes as they were; switch back (git switch main) and ship again."
TRAILER=""; [ -n "${VG_COAUTHOR:-}" ] && TRAILER=$'\n\n'"Co-Authored-By: $VG_COAUTHOR"
git commit -q -m "$MSG$TRAILER"
SHA="$(git rev-parse HEAD)"
[ "$(git rev-parse "$SHA^{tree}")" = "$TREE" ] || die "the commit's tree is not the tree the gates passed. Not pushing."
git push -q -u origin "$BRANCH"
PR_URL="$(gh pr create --repo "$REPO" --base main --head "$BRANCH" --title "$MSG" --body "Gates passed locally on exactly this commit's tree before the push: addresses (and every changed file), data rules, typecheck and build, e2e, $MODE sweep of every ballot at 380px. CI and the Vercel preview run the same checks again.")"
PR="${PR_URL##*/}"
say "Opened $PR_URL"

# ---------- 4. the required checks on this exact commit, then the preview built from it ----------
say "Waiting for the required checks ($REQUIRED_CHECKS) on ${SHA:0:12}"
head="$(gh pr view "$PR" --repo "$REPO" --json headRefOid --jq .headRefOid)"
[ "$head" = "$SHA" ] || die "PR #$PR's head is $head, not the commit this script pushed ($SHA). Someone else pushed to $BRANCH; start over."
wait_required_checks "$SHA"
say "Waiting for Vercel's preview of ${SHA:0:12}"
wait_vercel "$SHA" preview
PREVIEW=""
for i in $(seq 1 20); do PREVIEW="$(fetch_vercel_comment "$PR" | python3 -c "$PREVIEW_PY")"; [ -n "$PREVIEW" ] && break; sleep 15; done
[ -n "$PREVIEW" ] || die "Vercel built ${SHA:0:12}, but its comment on $PR_URL names no preview URL."
wait_serves "$PREVIEW" "$SHA" preview 0
BASE="$PREVIEW" MODE=fast SHOTS_DIR=.tmp/preview-sweep node tests/sweep.mjs
BASE="$PREVIEW" SHOTS_DIR=.tmp/preview-e2e node tests/e2e.mjs

cat <<EOF

PR #$PR is green on its exact head commit, and its preview serves that commit and passes.
Merging waits for the independent review. After the review is clean, run these two lines, separately:
  gh pr merge $PR --squash
  scripts/ship.sh --after-merge $PR
EOF
