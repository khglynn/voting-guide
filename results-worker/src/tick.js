/* One cron tick, and the one-source run behind POST /results/run (PLAN-PHASE-1 sections 4 to 6).
   Portable: `store` is KV-shaped ({get, put, delete}), `archive` R2-shaped ({put}), `fetch` is handed in, so the same
   code runs under the Worker and under node (bin/run.mjs, the tests).
   KV keys: `stop` (any value stops every tick), `sched:2026-11-03` (each source's schedule), `src:{id}` (its last good
   read), `checked:{id}` (the map hash its first-run check passed against), `preview:{ST}` and `file:{ST}` (the files),
   `alert:{source}:{reason}` (ping dedupe). R2: `raw/{source}/{fetched}-{hash}.json` for every changed read,
   `files/{ST}/{generated}.json` and `latest/{ST}.json` for every published file. */
import { ADAPTERS } from './adapters/index.js';
import { checkRead, checkFile } from './checks.js';
import { buildStateFile, sourceStatus } from './merge.js';
import { nextEntry, dueSources } from './schedule.js';
import { fingerprint, mapHash } from './fingerprint.js';
import { sha256, ELECTION } from './util.js';

export const SCHED_KEY = `sched:${ELECTION}`;
const SITE = 'https://vote.kevinhg.com';

const readJson = async (store, key, dflt = null) => { const v = await store.get(key); if (!v) return dflt; try { return JSON.parse(v); } catch { return dflt; } };

export async function loadSched(store) {
  const s = await readJson(store, SCHED_KEY, null);
  return s && s.sources ? s : { sources: {}, meta: {} };
}

async function runSource({ map, fetch, store, archive, sched, now, ping }) {
  const adapter = ADAPTERS[map.feed.adapter];
  const S = sched.sources;
  const prevRec = await readJson(store, `src:${map.id}`);
  let r;
  const mh = await mapHash(map);
  const prevToken = S[map.id]?.token && S[map.id]?.map_hash === mh ? S[map.id].token : null;
  try { r = await adapter.read({ fetch, map, prevToken }); } catch (e) { r = { verdict: 'error', error: `adapter threw: ${e.message}` }; }
  if (r.verdict === 'refused') {
    S[map.id] = nextEntry(S[map.id], { kind: 'refused', error: r.error }, now, map);
    await ping(map.id, 'refused', `${map.name} refused our request (${r.error}). It stops until its map changes; its rows link out.`);
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
  if (prevRec && !prevRec.blocked && prevRec.hash === hash) {
    // A full re-read (a new map, a lost token) that found the same bytes: unchanged, nothing to store or archive.
    const status = sourceStatus(prevRec.read, map, now);
    S[map.id] = nextEntry(S[map.id], { kind: 'ok', changed: false, status, allComplete: status === 'complete' }, now, map);
    S[map.id].token = r.changed_token;
    S[map.id].map_hash = mh;
    return { id: map.id, outcome: 'unchanged' };
  }
  const check = checkRead(read, map, baseline);
  if (archive) await archive.put(`raw/${map.id}/${now}-${hash}.json`, JSON.stringify({ fetched: now, source: map.id, election: read.election, raw }));
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
  const rec = { read, fetched: now, hash, blocked: false, problems: check.problems, raw_key: `raw/${map.id}/${now}-${hash}.json` };
  await store.put(`src:${map.id}`, JSON.stringify(rec));
  await store.delete(`blocked:${map.id}`);
  for (const p of check.problems) if (p.reason === 'falling total') await ping(map.id, 'falling total', `${map.name}: ${p.detail}.`);
  const status = sourceStatus(read, map, now);
  S[map.id] = nextEntry(S[map.id], { kind: 'ok', changed: true, status, allComplete: status === 'complete' }, now, map);
  S[map.id].token = r.changed_token;
  S[map.id].map_hash = mh;
  return { id: map.id, outcome: 'changed', problems: check.problems };
}

/* Build and store one state's preview file, and its public file once any source in it has passed its first-run check.
   Until then the public key keeps whatever is there (the hand-written test file). */
export async function publishState({ state, maps, store, archive, sched, now, ping }) {
  const mine = maps.filter((m) => m.state === state);
  const srcs = {};
  for (const m of mine) {
    const want = await mapHash(m);
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
  if (archive) { await archive.put(`files/${state}/${now}.json`, body); await archive.put(`latest/${state}.json`, body); }
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
        cache[p] ??= await fetch(`${SITE}/data/place-${p}.json`, { signal: AbortSignal.timeout(15000) }).then((r) => (r.ok ? r.json() : null));
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

export async function runTick({ fetch, store, archive, maps, now = new Date().toISOString(), only = null, ping = async () => false, budgetMs = 40_000 }) {
  if (!only && (await store.get('stop'))) return { stopped: true };
  const started = Date.now();
  const sched = await loadSched(store);
  sched.meta ??= {};
  const live = maps.filter((m) => ADAPTERS[m.feed.adapter]);
  const ids = only ? live.filter((m) => m.id === only).map((m) => m.id) : dueSources(sched.sources, live.map((m) => m.id), now);
  const byId = Object.fromEntries(maps.map((m) => [m.id, m]));
  const ran = (await Promise.all(ids.map((id) => (Date.now() - started > budgetMs ? null : runSource({ map: byId[id], fetch, store, archive, sched, now, ping }))))).filter(Boolean);

  let fpChanged = false;
  let metaChanged = false;
  if (!only && (!sched.meta.fp_at || Date.parse(now) - Date.parse(sched.meta.fp_at) >= 60 * 60_000)) {
    const before = JSON.stringify(sched.meta.fp || {});
    await checkFingerprints({ maps, fetch, sched, now, ping });
    fpChanged = before !== JSON.stringify(sched.meta.fp);
    metaChanged = true;
  }

  if (!only && (!sched.meta.site_at || Date.parse(now) - Date.parse(sched.meta.site_at) >= 10 * 60_000)) { await checkThroughSite({ maps, fetch, store, sched, now, ping }); metaChanged = true; }

  const states = new Set(ran.map((r) => byId[r.id].state));
  if (fpChanged) for (const m of maps) states.add(m.state);
  const published = [];
  for (const st of states) published.push(await publishState({ state: st, maps, store, archive, sched, now, ping }));

  if (live.length && live.every((m) => sched.sources[m.id]?.stopped) && !sched.meta.done_pinged) {
    sched.meta.done_pinged = now;
    await ping('all', 'done', 'every source has stopped (official, past certification, or refused). The fetcher is done for 2026-11-03.');
  }
  if (ran.length || fpChanged || metaChanged) { sched.meta.last_tick = now; await store.put(SCHED_KEY, JSON.stringify(sched)); }
  return { ran, published };
}
