#!/usr/bin/env node
/* The Air's reads for sources that refuse the Worker (Nov 13, 2026; Kevin: "Build it", ledger
   2026-11-13-voting-guide-air; behind it, "I want the most up to date election data live"). California's state site
   and three counties, Oregon's state site and Multnomah, Denver and Pennsylvania's state site answer the Worker with a
   403 or a bot check, but answer the same named request from Kevin's Air. Each run, once (launchd starts the next):
   - for each source whose time has come, runs its own adapter here through a recording fetch (src/relay.js) and, when
     the read is good, posts what the office sent to the Worker's POST /results/feed, which replays it, checks it and
     publishes it like any read of its own. This side writes nothing to the Worker's store, so there is one writer, and
     the Worker keeps the source stopped in its own schedule while the Air reads it;
   - paces each source by the Worker's own ladder (the `next_due` the route answers with), never sooner than launchd's
     10 minutes, and backs off 15, 30, then 60 minutes after a failure;
   - a failed read (the office refused the Air too, or the Worker couldn't replay it) posts nothing, so the last good
     counts stay up; a source failing 6 hours is told once, and told again in a line when it reads again;
   - stops a source for good once the Worker calls it official or past certification, or after five days with no new
     counts (Kevin's Nov 7 rule for the results watch, ledger 2026-11-12-results-watch-stop), telling the Worker so
     (`end=1`) and saying once when every source has stopped.
   Telling is a shell command in VG_FEED_NOTIFY that reads the message on stdin (gabby-notify; its exit 75 means
   queued); without one the message is printed. The token is <dir>/token (mode 600) or VG_FEED_TOKEN, and is never
   printed. State is saved after each source, so a run the start script ends at its time limit loses nothing.
   Usage: node bin/feed.mjs [--dir ~/.vg-results-feed] [--sources "results-CA denver-co"] [--dry]
   (--dry: read each source now and print what would be posted; never posts or tells) */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadMaps } from './lib.mjs';
import { ADAPTERS } from '../src/adapters/index.js';
import { recordingFetch, AIR_SOURCES } from '../src/relay.js';
import { mapHash } from '../src/fingerprint.js';

export const SOURCES = AIR_SOURCES;
const ROUTE = 'https://vg-results.kevinhg.workers.dev/results/feed';
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
export const QUIET_DAYS = 5;
// launchd starts a run every 10 minutes, and a source read late in one run would just miss the next run's check at
// exactly 10, so each wait is a minute short of what it means: the next run, or 15, 30, 60 minutes after a failure.
const FLOOR_MIN = 9;
const BACKOFF_MIN = [14, 29, 59];
const TELL_AFTER_MIN = 6 * 60;
const ROUTE_TELL_MIN = 24 * 60;
const FINAL = new Set(['official', 'past certification', 'fed, ended']);
// The start script ends a run at 9 minutes. A source starts only while its slowest read (Oregon's state site: about a
// dozen pages at up to 15 s each), its post and the notify step still fit.
const STOP_MS = 9 * MIN;
const READ_MS = 4 * MIN;
const POST_MS = 90_000;
const NOTIFY_MS = 60_000;
export const START_BY_MS = STOP_MS - 10_000 - NOTIFY_MS - POST_MS - READ_MS;

const iso = (ms) => new Date(ms).toISOString();

/* After a good post: the source's next read, its five-day clock, and whether it is done. Pure, for the tests. */
export function afterPost(s, entry, nowMs) {
  const told = !!s.told;
  const out = { first_fed: s.first_fed || iso(nowMs), last_ok: iso(nowMs) };
  if (entry?.last_change) out.last_change = entry.last_change;
  const due = Date.parse(entry?.next_due || 0) || 0;
  out.next = iso(Math.max(due, nowMs + FLOOR_MIN * MIN));
  if (FINAL.has(entry?.stopped)) out.ended = entry.stopped;
  else {
    // The five quiet days count from the newest of its last change and the Air's first read, so counts from before the
    // Air took over never end it early.
    const since = Math.max(Date.parse(out.last_change || 0) || 0, Date.parse(out.first_fed));
    if (nowMs - since >= QUIET_DAYS * DAY) out.ended = 'five days with no new counts';
  }
  return { s: out, back: told };
}

/* After a failed read or post: back off, and whether to tell (once, after 6 hours of failing). Pure, for the tests. */
export function afterFail(s, error, nowMs) {
  const fails = (s.fails || 0) + 1;
  const out = { ...s, fails, error, failing_since: s.failing_since || iso(nowMs), next: iso(nowMs + BACKOFF_MIN[Math.min(fails, BACKOFF_MIN.length) - 1] * MIN) };
  const tell = !s.told && nowMs - Date.parse(out.failing_since) >= TELL_AFTER_MIN * MIN;
  return { s: out, tell };
}

async function post(url, token, body) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(POST_MS) });
    let j = null;
    try { j = JSON.parse(await r.text()); } catch { /* not JSON */ }
    return { status: r.status, j };
  } catch (e) { return { status: 0, error: e?.name === 'TimeoutError' ? `no answer in ${POST_MS / 1000} s` : String(e?.message || e) }; }
}

function readToken(dir) {
  if (process.env.VG_FEED_TOKEN) return process.env.VG_FEED_TOKEN.trim();
  try { return fs.readFileSync(path.join(dir, 'token'), 'utf8').trim(); } catch { return ''; }
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
  const dry = argv.includes('--dry');
  const dir = opt('dir') || path.join(os.homedir(), '.vg-results-feed');
  const ids = (opt('sources') || process.env.VG_FEED_SOURCES || SOURCES.join(' ')).split(/\s+/).filter((id) => SOURCES.includes(id));
  const maps = Object.fromEntries(loadMaps().map((m) => [m.id, m]));
  fs.mkdirSync(dir, { recursive: true });
  const statePath = path.join(dir, 'state.json');
  let state = { sources: {} };
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); state.sources ??= {}; } catch { /* first run */ }
  const save = () => { if (dry) return; fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 1)); fs.renameSync(`${statePath}.tmp`, statePath); };
  const token = readToken(dir);
  const started = Date.now();
  const tell = [];
  const backIds = []; // sources whose "reads it again" line is in this run's message
  const log = [];
  if (!dry && !token) {
    if (!state.token_told) { tell.push(`The Air's results reader has no token (${path.join(dir, 'token')}), so it can't hand counts to the fetcher.`); state.token_told = iso(started); }
  } else {
    const order = ids.filter((id) => maps[id] && ADAPTERS[maps[id].feed.adapter]).sort((a, b) => (Date.parse(state.sources[a]?.next || 0) || 0) - (Date.parse(state.sources[b]?.next || 0) || 0));
    for (const id of ids) if (!order.includes(id)) log.push(`${id}: no map or adapter`);
    for (const id of order) {
      const s = state.sources[id] || {};
      const map = maps[id];
      if (s.ended && !dry) continue;
      if (!dry && s.next && Date.parse(s.next) > Date.now()) continue;
      if (Date.now() - started > START_BY_MS) { log.push(`out of time before ${id}`); break; }
      const now = Date.now();
      const rec = recordingFetch(fetch);
      let r;
      try { r = await ADAPTERS[map.feed.adapter].read({ fetch: rec, map }); } catch (e) { r = { verdict: 'error', error: `adapter threw: ${e.message}` }; }
      const fail = (error) => {
        const f = afterFail(s, error, now);
        state.sources[id] = f.s;
        log.push(`${id}: failed (${error})`);
        if (f.tell) { tell.push(`${map.name}: the Air's reads have failed since ${f.s.failing_since} (${error}). Its last counts stay up.`); state.sources[id].told = iso(now); }
      };
      if (r.verdict !== 'ok') { fail(`the office: ${r.error || r.verdict}`); save(); continue; }
      const body = JSON.stringify({ map_hash: await mapHash(map), answers: rec.answers });
      if (dry) { log.push(`${id}: ok, ${r.contests?.length ?? 0} contests, updated ${r.source_updated || 'n/a'}; ${rec.answers.length} answers, ${(body.length / 1e6).toFixed(2)} MB to post`); continue; }
      const p = await post(`${ROUTE}?source=${encodeURIComponent(id)}`, token, body);
      if (p.status === 404 && /not found/.test(p.j?.error || '')) {
        // The route isn't deployed yet (results-worker/deploy.sh after the merge): wait, quietly for a day.
        state.route_missing_since ??= iso(now);
        log.push('the fetcher has no /results/feed route yet');
        if (!state.route_told && now - Date.parse(state.route_missing_since) >= ROUTE_TELL_MIN * MIN) { tell.push('The fetcher still has no /results/feed route a day after the Air started reading for it: results-worker/deploy.sh needs to run from main.'); state.route_told = iso(now); }
        break;
      }
      delete state.route_missing_since; delete state.route_told;
      if (p.status === 401) { fail('the fetcher turned the token away (FEED_TOKEN)'); save(); break; }
      if (p.status === 409) { state.sources[id] = { ...s, next: iso(now + 60 * MIN) }; log.push(`${id}: the fetcher is stopped (the stop flag); trying again in an hour`); save(); continue; }
      const outcome = p.j?.ran?.[0]?.outcome;
      if (p.status !== 200 || !p.j?.entry || !outcome || outcome === 'error') { fail(`the fetcher: ${p.error || p.j?.ran?.[0]?.error || p.j?.error || `HTTP ${p.status}`}`); save(); continue; }
      const a = afterPost(s, p.j.entry, now);
      state.sources[id] = a.s;
      if (a.back) { tell.push(`${map.name}: the Air reads it again.`); backIds.push(id); }
      log.push(`${id}: ${outcome}${p.j.ran[0].error ? ` (${p.j.ran[0].error})` : ''}; next ${a.s.next}`);
      if (a.s.ended) {
        if (a.s.ended === 'five days with no new counts') {
          const e = await post(`${ROUTE}?source=${encodeURIComponent(id)}&end=1`, token, '{}');
          if (e.status !== 200) { delete state.sources[id].ended; log.push(`${id}: couldn't end it at the fetcher (HTTP ${e.status}); tries again next time`); }
        }
        if (state.sources[id].ended) log.push(`${id}: stopped (${a.s.ended})`);
      }
      save();
    }
    const ended = ids.filter((id) => state.sources[id]?.ended);
    if (!dry && ids.length && ended.length === ids.length && !state.done_told) {
      tell.push(`The Air's results reader is done: ${ids.map((id) => `${maps[id]?.name || id} (${state.sources[id].ended})`).join(', ')}. Their last counts stay up. To stop it running at all: launchctl bootout gui/$(id -u)/com.kevinhg.vg-results-feed`);
      state.done_told = iso(Date.now());
    }
  }
  console.log(`${iso(started)} ${log.join('; ') || 'nothing due'}${tell.length ? `; told ${tell.length}` : ''}`);
  if (!tell.length) return save();
  const msg = `Voting guide, the Air's results reader:\n${tell.map((t) => `• ${t}`).join('\n')}`;
  const cmd = process.env.VG_FEED_NOTIFY;
  if (dry || !cmd) { console.log(msg); return save(); }
  const n = spawnSync('/bin/sh', ['-c', cmd], { input: msg, encoding: 'utf8', timeout: NOTIFY_MS });
  // 75 is gabby-notify's "queued". Any other failure: forget the "told" marks set this run, so the next run tells again.
  if (n.status !== 0 && n.status !== 75) {
    console.log(`notify failed (${n.status}): ${(n.stderr || '').trim().slice(0, 300)}\n${msg}`);
    const t = iso(started);
    for (const s of Object.values(state.sources)) if (s.told && Date.parse(s.told) >= Date.parse(t)) delete s.told;
    // A "reads it again" line that didn't go out is owed: its next good post tells it (afterPost reads `told`).
    for (const id of backIds) if (state.sources[id]) state.sources[id].told = 'owed';
    for (const k of ['token_told', 'route_told', 'done_told']) if (state[k] && Date.parse(state[k]) >= Date.parse(t)) delete state[k];
    process.exitCode = 2;
  }
  save();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
