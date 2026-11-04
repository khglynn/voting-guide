/* One cron tick, and the one-source run behind POST /results/run (PLAN-PHASE-1 sections 4 to 6).
   Portable: `store` is KV-shaped ({get, put, delete}), `archive` R2-shaped ({put}), `fetch` is handed in, so the same
   code runs under the Worker and under node (bin/run.mjs, the tests).
   KV keys: `stop` (any value stops every tick), `sched:2026-11-03` (each source's schedule), `src:{id}` (its last good
   read), `checked:{id}` (the map's checkHash its first-run check passed against), `preview:{ST}` and `file:{ST}` (the files),
   `alert:{source}:{reason}` (ping dedupe). R2: `raw/{source}/{fetched}-{hash}.json` for every changed read,
   `files/{ST}/{generated}.json` and `latest/{ST}.json` for every published file. */
import { ADAPTERS } from './adapters/index.js';
import { checkRead, checkFile } from './checks.js';
import { buildStateFile, sourceStatus } from './merge.js';
import { nextEntry, dueSources, clampElectionNight, previewFloor } from './schedule.js';
import { fingerprint, mapHash, checkHash } from './fingerprint.js';
import { sha256, ELECTION } from './util.js';

export const SCHED_KEY = `sched:${ELECTION}`;
/* Bump when an adapter's output changes for the same feed bytes (Nov 3: no progress words when no precinct has
   reported), so stored reads made by older code are redone in full and replaced in place, never left stale.
   3 (Nov 3, 10:55 PM): a contest kept after a falling total by the old code had no time of its own (TX-10); a full
   re-read lets checkRead hand it back to the source's count even when the feed hasn't changed. */
export const READ_VERSION = 3;
const PUBLISH_MS = 8_000; // one state's files, at most
const MAX_CARRY = 3; // cut-off reads in a row a dropped race keeps its last numbers through
const SITE = 'https://vote.kevinhg.com';

/* The R2 archive is a record, never a gate: a failed write is logged and the tick goes on (overnight review, Nov 3),
   and so is one that stalls past ARCHIVE_MS (Codex, Nov 3). */
const ARCHIVE_MS = 3_000;
async function keep(archive, key, body, log) {
  if (!archive) return;
  let t;
  const slow = new Promise((ok) => { t = setTimeout(() => ok('slow'), ARCHIVE_MS); t?.unref?.(); });
  try {
    if ((await Promise.race([archive.put(key, body), slow])) === 'slow') log(JSON.stringify({ archive_failed: key, error: `no answer in ${ARCHIVE_MS / 1000} s` }));
  } catch (e) { log(JSON.stringify({ archive_failed: key, error: String(e?.message || e) })); } finally { clearTimeout(t); }
}

const readJson = async (store, key, dflt = null) => { const v = await store.get(key); if (!v) return dflt; try { return JSON.parse(v); } catch { return dflt; } };

export async function loadSched(store) {
  const s = await readJson(store, SCHED_KEY, null);
  return s && s.sources ? s : { sources: {}, meta: {} };
}

async function runSource({ map, fetch, store, archive, sched, now, ping, log, hasTime = () => true }) {
  const adapter = ADAPTERS[map.feed.adapter];
  const S = sched.sources;
  const prevRec = await readJson(store, `src:${map.id}`);
  let r;
  const mh = await mapHash(map);
  // A token only stands when its read is still stored: with no good read on hand, read in full.
  const current = prevRec?.read_version === READ_VERSION;
  const prevToken = current && prevRec?.read && S[map.id]?.token && S[map.id]?.map_hash === mh ? S[map.id].token : null;
  const attempt = async () => { try { return await adapter.read({ fetch, map, prevToken }); } catch (e) { return { verdict: 'error', error: `adapter threw: ${e.message}` }; } };
  r = await attempt();
  // One quick retry inside the tick for a blip (a timeout, a 5xx, a version whose files aren't up yet); never for a
  // refusal. Election night, Nov 3: three blips in a row parked Bexar in back-off while it posted its first numbers.
  // Not once the tick's clock has run out: the retry would only fail again.
  if (r.verdict === 'error' && hasTime()) { await new Promise((ok) => setTimeout(ok, 3000)); const again = await attempt(); r = again.verdict === 'ok' ? again : { ...again, error: `${again.error} (and before the retry: ${r.error})` }; }
  if (r.verdict === 'refused') {
    S[map.id] = nextEntry(S[map.id], { kind: 'refused', error: r.error, mapHash: mh }, now, map);
    // Stopped, never past it: say so in the log as well as the ping (pings need the Worker secrets).
    log(JSON.stringify({ source: map.id, refused: r.error, stopped: 'until its map changes or it is run by hand' }));
    await ping(map.id, 'refused', `${map.name} refused our request (${r.error}). It stops until its map changes or someone runs it by hand; its rows link out.`);
    return { id: map.id, outcome: 'refused', error: r.error };
  }
  if (r.verdict !== 'ok') {
    S[map.id] = nextEntry(S[map.id], { kind: 'error', error: r.error }, now, map);
    const since = S[map.id].failing_since;
    if (since && Date.parse(now) - Date.parse(since) >= 30 * 60_000) await ping(map.id, 'failing', `${map.name} has failed since ${since} (${r.error}). Its last numbers stay up.`);
    return { id: map.id, outcome: 'error', error: r.error };
  }
  if (r.unchanged) {
    const status = prevRec?.read ? sourceStatus(prevRec.read, map, now) : S[map.id]?.status;
    S[map.id] = nextEntry(S[map.id], { kind: 'ok', changed: false, status, allComplete: status === 'complete' }, now, map);
    S[map.id].token = r.changed_token;
    S[map.id].map_hash = mh;
    return { id: map.id, outcome: 'unchanged' };
  }
  const { raw, ...read } = r;
  // The falling-total baseline is the last good read, never a blocked one (security review, Nov 3).
  const baseline = prevRec && !prevRec.blocked_only ? prevRec.read : null;
  const hash = (await sha256(JSON.stringify(raw || read))).slice(0, 12);
  if (current && prevRec && !prevRec.blocked && prevRec.hash === hash) {
    // A full re-read (a new map, a lost token) that found the same bytes: unchanged, nothing to store or archive.
    const status = sourceStatus(prevRec.read, map, now);
    S[map.id] = nextEntry(S[map.id], { kind: 'ok', changed: false, status, allComplete: status === 'complete' }, now, map);
    S[map.id].token = r.changed_token;
    S[map.id].map_hash = mh;
    return { id: map.id, outcome: 'unchanged' };
  }
  // A page served cut off (the Texas SOS, Nov 3: its length changed with each update) keeps the last good numbers for
  // any race it dropped, so a race doesn't flicker between numbers and a link. Honest freshness (security review,
  // Nov 3): a carried race keeps its own time (`updated`, `carried_from`) and note through any number of cut-off reads,
  // never re-timed to a newer page, and after MAX_CARRY cut-off reads in a row it is let go, so its row falls back to
  // the county counts or the link.
  if (read.dropped > 0 && baseline?.contests) {
    const have = new Set(read.contests.map((c) => c.feed_id));
    for (const c of baseline.contests) {
      if (have.has(c.feed_id)) continue;
      const carries = (c.carries || 0) + 1;
      if (carries > MAX_CARRY) { read.let_go = [...(read.let_go || []), c.feed_id]; continue; }
      const when = c.carried_from || c.updated || baseline.source_updated || null;
      const at = when ? new Date(when).toLocaleTimeString('en-US', { timeZone: map.feed.tz || 'America/Chicago', hour: 'numeric', minute: '2-digit' }) : 'an earlier';
      read.contests.push({ ...c, updated: when, carried_from: when, carries, note: c.carried_from ? c.note : `The ${map.name}'s page was cut off at its latest update, so these numbers are from its ${at} update.` });
    }
  }
  const check = checkRead(read, map, baseline);
  await keep(archive, `raw/${map.id}/${now}-${hash}.json`, JSON.stringify({ fetched: now, source: map.id, election: read.election, raw }), log);
  if (check.readBlocked) {
    S[map.id] = nextEntry(S[map.id], { kind: 'error', error: check.problems.map((p) => p.detail).join('; ') }, now, map);
    await ping(map.id, 'bad numbers', `${map.name}: ${check.problems[0].detail}. Kept the last good read.`);
    return { id: map.id, outcome: 'bad numbers', problems: check.problems };
  }
  if (check.sourceBlocked) {
    // Keep the last good read untouched as the baseline; mark the source blocked so its rows link out, and keep the
    // blocked attempt under its own key for the status page. No token is saved, so every poll re-reads in full and a
    // fixed map (or a feed that comes back to the right election) clears the block on its own.
    await store.put(`blocked:${map.id}`, JSON.stringify({ read, fetched: now, problems: check.problems, raw_key: `raw/${map.id}/${now}-${hash}.json` }));
    const kept = prevRec && !prevRec.blocked_only ? { ...prevRec, blocked: true, blocked_at: now } : { read: null, fetched: null, blocked: true, blocked_only: true, blocked_at: now };
    await store.put(`src:${map.id}`, JSON.stringify(kept));
    for (const p of check.problems) if (p.reason === 'election mismatch') await ping(map.id, 'election mismatch', `${map.name}: ${p.detail}. Its rows link out until the map is fixed.`);
    S[map.id] = nextEntry(S[map.id], { kind: 'ok', changed: true, status: S[map.id]?.status || 'pending' }, now, map);
    delete S[map.id].token;
    return { id: map.id, outcome: 'election mismatch', problems: check.problems };
  }
  const rec = { read, fetched: now, hash, read_version: READ_VERSION, blocked: false, problems: check.problems, raw_key: `raw/${map.id}/${now}-${hash}.json` };
  await store.put(`src:${map.id}`, JSON.stringify(rec));
  await store.delete(`blocked:${map.id}`);
  for (const p of check.problems) if (p.reason === 'falling total' || p.reason === 'falling total accepted') await ping(map.id, p.reason, `${map.name}: ${p.detail}.`);
  const status = sourceStatus(read, map, now);
  S[map.id] = nextEntry(S[map.id], { kind: 'ok', changed: true, status, allComplete: status === 'complete' }, now, map);
  S[map.id].token = r.changed_token;
  S[map.id].map_hash = mh;
  return { id: map.id, outcome: 'changed', problems: check.problems, ...(read.let_go ? { error: `stopped carrying ${read.let_go.length} race(s) after ${MAX_CARRY} cut-off reads: ${read.let_go.join('; ')}` } : {}) };
}

/* Build and store one state's preview file, and its public file once any source in it has passed its first-run check.
   Until then the public key keeps whatever is there (the hand-written test file). */
export async function publishState({ state, maps, store, archive, sched, now, ping, log = console.log }) {
  const mine = maps.filter((m) => m.state === state);
  const srcs = {};
  for (const m of mine) {
    const want = await checkHash(m);
    srcs[m.id] = {
      record: await readJson(store, `src:${m.id}`),
      sched: sched.sources[m.id] || {},
      checked: (await store.get(`checked:${m.id}`)) === want,
      fpOk: sched.meta?.fp?.[m.id] !== 'mismatch',
    };
    if (srcs[m.id].record) srcs[m.id].record.fetched = sched.sources[m.id]?.last_ok || srcs[m.id].record.fetched;
  }
  const out = { state };
  const preview = buildStateFile({ state, maps: mine, srcs, mode: 'preview', now });
  const pv = checkFile(preview);
  if (pv.length) { out.preview_problems = pv; await ping(state, 'preview check', `the ${state} preview file failed its checks: ${pv.slice(0, 3).join('; ')}`); }
  else { await store.put(`preview:${state}`, JSON.stringify(preview)); out.preview = true; }

  if (!Object.values(srcs).some((s) => s.checked)) return out;
  const pub = buildStateFile({ state, maps: mine, srcs, mode: 'public', now });
  const problems = checkFile(pub);
  if (problems.length) { out.public_problems = problems; await ping(state, 'file check', `the ${state} file failed its checks and was not published: ${problems.slice(0, 3).join('; ')}`); return out; }
  const body = JSON.stringify(pub);
  await store.put(`file:${state}`, body);
  const back = await store.get(`file:${state}`);
  if (!back || (await sha256(back)) !== (await sha256(body))) await ping(state, 'stale read-back', `the ${state} file read back different from what was written at ${now}.`);
  await keep(archive, `files/${state}/${now}.json`, body, log);
  await keep(archive, `latest/${state}.json`, body, log);
  out.public = true;
  return out;
}

/* Hourly: recompute each map's fingerprint from the live guide bundles; a mismatch turns its items into links. */
export async function checkFingerprints({ maps, fetch, sched, now, ping }) {
  const cache = {};
  sched.meta.fp ??= {};
  for (const m of maps) {
    if (!m.guide?.fingerprint || !m.guide?.places?.length) continue;
    const bundles = {};
    try {
      for (const p of m.guide.places) {
        cache[p] ??= await fetch(`${SITE}/data/${p.startsWith('state-') ? p : `place-${p}`}.json`, { signal: AbortSignal.timeout(15000) }).then((r) => (r.ok ? r.json() : null));
        bundles[p] = cache[p];
      }
    } catch { continue; } // the site unreachable is not a mismatch
    if (Object.values(bundles).some((b) => !b)) continue;
    const fp = await fingerprint(m, bundles);
    const was = sched.meta.fp[m.id];
    sched.meta.fp[m.id] = fp === m.guide.fingerprint ? 'ok' : 'mismatch';
    if (sched.meta.fp[m.id] === 'mismatch' && was !== 'mismatch') await ping(m.id, 'map out of date', `${m.name}'s map was made against different guide data (fingerprint ${m.guide.fingerprint}, now ${fp}). Its rows link out until the map is remade.`);
  }
  sched.meta.fp_at = now;
}

/* Every ten minutes: read each published file the way the site does, through vote.kevinhg.com/results/, and ping if
   what people get is more than five minutes behind what we wrote. Quiet until the site's rewrite exists (a 404 or a
   page that isn't JSON is skipped). */
export async function checkThroughSite({ maps, fetch, store, sched, now, ping }) {
  sched.meta.site_at = now;
  for (const st of [...new Set(maps.map((m) => m.state))]) {
    const ours = await readJson(store, `file:${st}`);
    if (!ours) continue;
    let theirs;
    try {
      const r = await fetch(`${SITE}/results/2026-11-03/${st}.json?check=${Date.parse(now)}`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      theirs = JSON.parse(await r.text());
    } catch { continue; }
    const behind = (Date.parse(ours.generated) - Date.parse(theirs.generated || 0)) / 60000;
    if (behind > 5) await ping(st, 'site stale', `vote.kevinhg.com serves the ${st} file from ${theirs.generated}, ${Math.round(behind)} minutes behind the one written at ${ours.generated}.`);
  }
}

/* Each source's schedule entry and each meta key as JSON, to tell later which ones this tick changed. */
const snapshot = (sched) => ({ sources: Object.fromEntries(Object.entries(sched.sources).map(([k, v]) => [k, JSON.stringify(v)])), meta: Object.fromEntries(Object.entries(sched.meta || {}).map(([k, v]) => [k, JSON.stringify(v)])) });

/* Save only what this tick changed, over what is stored now: a tick that ran long never puts back an older copy of a
   source another tick ran since (pre-deploy review, Nov 3: an older tick's save could undo a newer tick's refusal and
   start a stopped source again). KV is eventually consistent across locations, so this guards the common case; the
   tick's own clock (runTick) is what keeps ticks from overlapping at all. */
const ranAt = (e) => (e?.last_run ? Date.parse(e.last_run) : 0);
async function saveSched(store, sched, loaded, stateOf = () => null) {
  const stored = await loadSched(store);
  const out = { ...sched, sources: { ...stored.sources }, meta: { ...(stored.meta || {}) } };
  const theirsKept = [];
  for (const [id, mine] of Object.entries(sched.sources)) {
    if (loaded.sources[id] === JSON.stringify(mine) && stored.sources[id]) continue; // untouched here: keep the stored one
    const theirs = stored.sources[id];
    if (theirs && ranAt(theirs) > ranAt(mine)) { theirsKept.push(id); continue; } // a newer tick ran it
    out.sources[id] = mine;
  }
  for (const [k, v] of Object.entries(sched.meta || {})) if (loaded.meta[k] !== JSON.stringify(v) || !(k in out.meta)) out.meta[k] = v;
  for (const k of Object.keys(loaded.meta)) if (!(k in (sched.meta || {}))) delete out.meta[k]; // deleted here (republish)
  // This tick may have published those sources' states from its older reads after the newer tick did (Codex, Nov 3:
  // counting numbers left up over a newer refusal). Publish them again next tick, from the schedule as stored.
  const again = [...new Set(theirsKept.map(stateOf).filter(Boolean))];
  if (again.length) out.meta.republish = [...new Set([...(out.meta.republish || []), ...again])];
  await store.put(SCHED_KEY, JSON.stringify(out));
  return theirsKept;
}

/* Either signal aborts the request. */
function both(a, b) {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  const c = new AbortController();
  for (const s of [a, b]) { if (s.aborted) { c.abort(s.reason); break; } s.addEventListener('abort', () => c.abort(s.reason), { once: true }); }
  return c.signal;
}

/* One cron tick. A failure in one source or one state's file (a KV 429, an R2 5xx, an adapter bug) is logged and
   turned into that source's or that state's error; every other source and state still runs and publishes, and the
   schedule is still saved (overnight review, Nov 3: one throw used to stop every state for that minute). */
export async function runTick({ fetch, store, archive, maps, now = new Date().toISOString(), only = null, ping: rawPing = async () => false, budgetMs = 25_000, deadlineMs = 40_000, publishMs = PUBLISH_MS, workers = 6, limit, log = console.log }) {
  // A ping that fails (its KV dedupe key, Slack) never takes a source or a tick down with it.
  const ping = async (...a) => { try { return await rawPing(...a); } catch (e) { log(JSON.stringify({ ping_failed: a.slice(0, 2).join(':'), error: String(e?.message || e) })); return false; } };
  if (!only && (await store.get('stop'))) return { stopped: true };
  const started = Date.now();
  const sched = await loadSched(store);
  sched.meta ??= {};
  const loaded = snapshot(sched);
  const live = maps.filter((m) => ADAPTERS[m.feed.adapter]);
  // A refusal stops a source until a person acts (overnight review, Nov 3: it used to stay stopped for good). A changed
  // map, which means a deploy, clears it here; a run by hand clears it on a good read (schedule.js).
  let unstuck = false;
  if (!only) {
    for (const m of live) {
      const e = sched.sources[m.id];
      if (e?.stopped !== 'refused') continue;
      const at = e.refused_hash ?? e.map_hash;
      if (!at || at === (await mapHash(m))) continue;
      delete e.stopped; delete e.refused_hash; e.next_due = null;
      log(JSON.stringify({ source: m.id, refusal_cleared: 'its map changed' }));
      unstuck = true;
    }
  }
  const clamped = (!only && clampElectionNight(sched.sources, live, now)) || unstuck;
  // Sources whose numbers are public (a first-run check stored) go first; the rest are preview-only (schedule.js).
  const checkedIds = new Set(Object.keys(sched.meta.checked || {}).filter((k) => sched.meta.checked[k]));
  const ids = only ? live.filter((m) => m.id === only).map((m) => m.id) : dueSources(sched.sources, live.map((m) => m.id), now, limit, checkedIds);
  const byId = Object.fromEntries(maps.map((m) => [m.id, m]));

  // The tick's own clock (pre-deploy review, Nov 3: every due source ran in one Promise.all and no state published until
  // the slowest settled; NYC alone is 14 pages at up to 15 s each, so ticks could run into each other). At most
  // `workers` sources read at once (the six connections a Worker run may hold open); none starts after budgetMs; any
  // fetch still open at deadlineMs is cut, so its source ends as an error and backs off; and a source still running five
  // seconds after that is recorded as an error, so nothing waits on it. Each state goes out as soon as its own due
  // sources are done, so one slow source holds back only its own state.
  const timers = [];
  const after = (ms) => new Promise((ok) => timers.push(setTimeout(ok, Math.max(0, ms))));
  const ctl = new AbortController();
  after(deadlineMs - (Date.now() - started)).then(() => ctl.abort(new Error(`the tick ran out of time (${deadlineMs / 1000} s)`)));
  const late = after(deadlineMs + 5_000 - (Date.now() - started)).then(() => 'late');
  const tickFetch = (u, o = {}) => fetch(u, { ...o, signal: o.signal ? both(o.signal, ctl.signal) : ctl.signal });
  const hasTime = () => !ctl.signal.aborted;

  const published = [];
  const failed = [];
  const out_ = new Set(); // states published this tick
  const publish = async (st) => {
    if (out_.has(st)) return;
    out_.add(st);
    // Bounded too: a stalled KV, R2 or Slack call fails this state (it goes out again next tick) rather than holding
    // the tick and its schedule save past the next cron (Codex, Nov 3).
    const cut = after(publishMs).then(() => { throw new Error(`publishing took longer than ${publishMs / 1000} s`); });
    try { published.push(await Promise.race([publishState({ state: st, maps, store, archive, sched, now, ping, log }), cut])); } catch (e) {
      const error = `crashed: ${String(e?.message || e)}`;
      log(JSON.stringify({ state: st, error }));
      published.push({ state: st, error });
      failed.push(st);
    }
  };
  const left = {};
  for (const id of ids) left[byId[id].state] = (left[byId[id].state] || 0) + 1;
  const ran = [];
  const skipped = [];
  const runOne = async (id) => {
    let res;
    try {
      res = await Promise.race([runSource({ map: byId[id], fetch: tickFetch, store, archive, sched, now, ping, log, hasTime }), late]);
      if (res === 'late') {
        res = { id, outcome: 'error', error: 'still running when the tick ran out of time' };
        log(JSON.stringify({ source: id, error: res.error }));
        sched.sources[id] = nextEntry(sched.sources[id], { kind: 'error', error: res.error }, now, byId[id]);
      }
    } catch (e) {
      const error = `crashed: ${String(e?.message || e)}`;
      log(JSON.stringify({ source: id, error }));
      // A refusal recorded this tick before the crash stays a refusal; anything else backs off like any failed poll.
      const e0 = sched.sources[id];
      const refusedNow = e0?.stopped === 'refused' && e0?.last_run === now;
      if (!refusedNow) sched.sources[id] = nextEntry(e0, { kind: 'error', error }, now, byId[id]);
      res = { id, outcome: 'error', error };
    }
    if (!checkedIds.has(id)) previewFloor(sched.sources[id], now);
    ran.push(res);
    if (--left[byId[id].state] === 0) await publish(byId[id].state);
  };
  let fpChanged = false;
  let metaChanged = clamped;
  const states = new Set();
  const retry = sched.meta.republish || [];
  try {
    const queue = [...ids];
    await Promise.all(Array.from({ length: Math.min(workers, queue.length) }, async () => {
      while (queue.length) {
        const id = queue.shift();
        // Left due, so it is first in line next tick.
        if (Date.now() - started > budgetMs || !hasTime()) { skipped.push(id); left[byId[id].state]--; continue; }
        await runOne(id);
      }
    }));
    if (skipped.length) log(JSON.stringify({ skipped, reason: `no source starts after ${budgetMs / 1000} s; they stay due for the next tick` }));

    if (!only && (!sched.meta.fp_at || Date.parse(now) - Date.parse(sched.meta.fp_at) >= 60 * 60_000)) {
      const before = JSON.stringify(sched.meta.fp || {});
      try { await checkFingerprints({ maps, fetch: tickFetch, sched, now, ping }); } catch (e) { log(JSON.stringify({ fingerprints_failed: String(e?.message || e) })); }
      fpChanged = before !== JSON.stringify(sched.meta.fp);
      metaChanged = true;
    }

    if (!only && (!sched.meta.site_at || Date.parse(now) - Date.parse(sched.meta.site_at) >= 10 * 60_000)) {
      try { await checkThroughSite({ maps, fetch: tickFetch, store, sched, now, ping }); } catch (e) { log(JSON.stringify({ site_check_failed: String(e?.message || e) })); }
      metaChanged = true;
    }

    // A source whose state had a skipped source still gets its state published.
    for (const r of ran) states.add(byId[r.id].state);
    // A first-run check that passes sets checked:{id} by hand; rebuild that state's files on the next tick rather than
    // waiting for its source's next change (DC's poll had backed off toward an hour when it was checked, Nov 3).
    if (!only) {
      sched.meta.checked ??= {};
      for (const m of maps) {
        let v;
        try { v = (await store.get(`checked:${m.id}`)) || ''; } catch (e) { log(JSON.stringify({ source: m.id, checked_read_failed: String(e?.message || e) })); continue; }
        // A state already out this tick read its checked: marks fresh as it went, so it isn't published twice.
        if (sched.meta.checked[m.id] !== v) { sched.meta.checked[m.id] = v; states.add(m.state); metaChanged = true; }
      }
    }
    if (fpChanged) for (const m of maps) { states.add(m.state); out_.delete(m.state); }
    // A state whose last publish crashed is tried again every tick until it goes out, even when none of its sources is
    // due: a refusal written on a tick whose file write failed would otherwise leave old numbers public (Codex, Nov 3).
    for (const st of retry) states.add(st);
    for (const st of states) await publish(st);
  } finally {
    for (const t of timers) clearTimeout(t);
  }
  const stillFailing = [...new Set(failed.filter((st) => !published.some((p) => p.state === st && !p.error)))];
  if (stillFailing.length) sched.meta.republish = stillFailing; else delete sched.meta.republish;
  if (stillFailing.join() !== retry.join()) metaChanged = true;

  if (live.length && live.every((m) => sched.sources[m.id]?.stopped) && !sched.meta.done_pinged) {
    sched.meta.done_pinged = now;
    await ping('all', 'done', 'every source has stopped (official, past certification, or refused). The fetcher is done for 2026-11-03.');
  }
  if (ran.length || fpChanged || metaChanged) {
    sched.meta.last_tick = now;
    const kept = await saveSched(store, sched, loaded, (id) => byId[id]?.state);
    if (kept.length) log(JSON.stringify({ newer_tick_kept: kept, republish_next_tick: true }));
  }
  return { ran, published, ...(skipped.length ? { skipped } : {}) };
}
