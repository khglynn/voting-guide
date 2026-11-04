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
import { nextEntry, dueSources, clampElectionNight } from './schedule.js';
import { fingerprint, mapHash, checkHash } from './fingerprint.js';
import { sha256, ELECTION } from './util.js';

export const SCHED_KEY = `sched:${ELECTION}`;
/* Bump when an adapter's output changes for the same feed bytes (Nov 3: no progress words when no precinct has
   reported), so stored reads made by older code are redone in full and replaced in place, never left stale.
   3 (Nov 3, 10:55 PM): a contest kept after a falling total by the old code had no time of its own (TX-10); a full
   re-read lets checkRead hand it back to the source's count even when the feed hasn't changed. */
export const READ_VERSION = 3;
const MAX_CARRY = 3; // cut-off reads in a row a dropped race keeps its last numbers through
const SITE = 'https://vote.kevinhg.com';

/* The R2 archive is a record, never a gate: a failed write is logged and the tick goes on (overnight review, Nov 3). */
async function keep(archive, key, body, log) {
  if (!archive) return;
  try { await archive.put(key, body); } catch (e) { log(JSON.stringify({ archive_failed: key, error: String(e?.message || e) })); }
}

const readJson = async (store, key, dflt = null) => { const v = await store.get(key); if (!v) return dflt; try { return JSON.parse(v); } catch { return dflt; } };

export async function loadSched(store) {
  const s = await readJson(store, SCHED_KEY, null);
  return s && s.sources ? s : { sources: {}, meta: {} };
}

async function runSource({ map, fetch, store, archive, sched, now, ping, log }) {
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
  if (r.verdict === 'error') { await new Promise((ok) => setTimeout(ok, 3000)); const again = await attempt(); r = again.verdict === 'ok' ? again : { ...again, error: `${again.error} (and before the retry: ${r.error})` }; }
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

/* One cron tick. A failure in one source or one state's file (a KV 429, an R2 5xx, an adapter bug) is logged and
   turned into that source's or that state's error; every other source and state still runs and publishes, and the
   schedule is still saved (overnight review, Nov 3: one throw used to stop every state for that minute). */
export async function runTick({ fetch, store, archive, maps, now = new Date().toISOString(), only = null, ping: rawPing = async () => false, budgetMs = 40_000, log = console.log }) {
  // A ping that fails (its KV dedupe key, Slack) never takes a source or a tick down with it.
  const ping = async (...a) => { try { return await rawPing(...a); } catch (e) { log(JSON.stringify({ ping_failed: a.slice(0, 2).join(':'), error: String(e?.message || e) })); return false; } };
  if (!only && (await store.get('stop'))) return { stopped: true };
  const started = Date.now();
  const sched = await loadSched(store);
  sched.meta ??= {};
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
  const ids = only ? live.filter((m) => m.id === only).map((m) => m.id) : dueSources(sched.sources, live.map((m) => m.id), now);
  const byId = Object.fromEntries(maps.map((m) => [m.id, m]));
  const ran = (await Promise.all(ids.map(async (id) => {
    if (Date.now() - started > budgetMs) return null;
    try {
      return await runSource({ map: byId[id], fetch, store, archive, sched, now, ping, log });
    } catch (e) {
      const error = `crashed: ${String(e?.message || e)}`;
      log(JSON.stringify({ source: id, error }));
      // A refusal recorded this tick before the crash stays a refusal; anything else backs off like any failed poll.
      const e0 = sched.sources[id];
      const refusedNow = e0?.stopped === 'refused' && e0?.last_run === now;
      if (!refusedNow) sched.sources[id] = nextEntry(e0, { kind: 'error', error }, now, byId[id]);
      return { id, outcome: 'error', error };
    }
  }))).filter(Boolean);

  let fpChanged = false;
  let metaChanged = clamped;
  if (!only && (!sched.meta.fp_at || Date.parse(now) - Date.parse(sched.meta.fp_at) >= 60 * 60_000)) {
    const before = JSON.stringify(sched.meta.fp || {});
    try { await checkFingerprints({ maps, fetch, sched, now, ping }); } catch (e) { log(JSON.stringify({ fingerprints_failed: String(e?.message || e) })); }
    fpChanged = before !== JSON.stringify(sched.meta.fp);
    metaChanged = true;
  }

  if (!only && (!sched.meta.site_at || Date.parse(now) - Date.parse(sched.meta.site_at) >= 10 * 60_000)) {
    try { await checkThroughSite({ maps, fetch, store, sched, now, ping }); } catch (e) { log(JSON.stringify({ site_check_failed: String(e?.message || e) })); }
    metaChanged = true;
  }

  const states = new Set(ran.map((r) => byId[r.id].state));
  // A first-run check that passes sets checked:{id} by hand; rebuild that state's files on the next tick rather than
  // waiting for its source's next change (DC's poll had backed off toward an hour when it was checked, Nov 3).
  if (!only) {
    sched.meta.checked ??= {};
    for (const m of maps) {
      let v;
      try { v = (await store.get(`checked:${m.id}`)) || ''; } catch (e) { log(JSON.stringify({ source: m.id, checked_read_failed: String(e?.message || e) })); continue; }
      if (sched.meta.checked[m.id] !== v) { sched.meta.checked[m.id] = v; states.add(m.state); metaChanged = true; }
    }
  }
  if (fpChanged) for (const m of maps) states.add(m.state);
  // A state whose last publish crashed is tried again every tick until it goes out, even when none of its sources is
  // due: a refusal written on a tick whose file write failed would otherwise leave old numbers public (Codex, Nov 3).
  const retry = sched.meta.republish || [];
  for (const st of retry) states.add(st);
  const published = [];
  const failed = [];
  for (const st of states) {
    try { published.push(await publishState({ state: st, maps, store, archive, sched, now, ping, log })); } catch (e) {
      const error = `crashed: ${String(e?.message || e)}`;
      log(JSON.stringify({ state: st, error }));
      published.push({ state: st, error });
      failed.push(st);
    }
  }
  if (failed.length) sched.meta.republish = failed; else delete sched.meta.republish;
  if (failed.join() !== retry.join()) metaChanged = true;

  if (live.length && live.every((m) => sched.sources[m.id]?.stopped) && !sched.meta.done_pinged) {
    sched.meta.done_pinged = now;
    await ping('all', 'done', 'every source has stopped (official, past certification, or refused). The fetcher is done for 2026-11-03.');
  }
  if (ran.length || fpChanged || metaChanged) { sched.meta.last_tick = now; await store.put(SCHED_KEY, JSON.stringify(sched)); }
  return { ran, published };
}
