#!/usr/bin/env node
/* The lint every map passes before it deploys (PLAN-PHASE-1 section 3.4):
   - shape: election, feed, contests with kind, seats, choices and reaches;
   - against the guide's live bundles (or --bundles public/data): every mapped item exists in one of the map's places,
     and its kind and seats agree with the guide; a statewide item in a county map only as that county's slice (reaches
     [county, "other counties"], statewide: true, never whole; bin/map-lint.mjs);
     every guide candidate is mapped exactly once, no guide candidate twice, a measure has one yes and one no;
   - against the feed (a live read; --offline skips it): every mapped contest is in the feed under the same name, and
     every feed choice is matched or deliberately listed (`__other`);
   then writes the fingerprints (with --write: `guide.fingerprint` for the map's own races, and
   `guide.statewide_fingerprint` for its statewide slices when it has any) and regenerates src/maps.gen.js. Exit 1 on any
   error.
   Usage: node bin/map-check.mjs [--write] [--offline] [--bundles ../public/data] [map ids...] */
import { loadMaps, writeMap, writeIndex, loadBundle, flags } from './lib.mjs';
import { ADAPTERS } from '../src/adapters/index.js';
import { fingerprint, statewideFingerprint, mapHash, checkHash } from '../src/fingerprint.js';
import { lintGuide } from './map-lint.mjs';

const f = flags(process.argv.slice(2));
const maps = loadMaps(f._);
let errors = 0;
const err = (m, s) => { errors++; console.log(`  error  ${m.id}: ${s}`); };
const warn = (m, s) => console.log(`  warn   ${m.id}: ${s}`);
const bundleDir = typeof f.bundles === 'string' ? f.bundles : null;

const stateBundles = {};
for (const m of maps) {
  console.log(`${m.id} (${m.contests?.length ?? 0} contests)`);
  if (m.election?.date !== '2026-11-03') err(m, `election date ${m.election?.date}`);
  if (!m.election?.feed_election_id && m.feed?.adapter !== 'link_only') err(m, 'no feed_election_id');
  if (!m.feed || !(ADAPTERS[m.feed.adapter] || m.feed.adapter === 'link_only')) err(m, `adapter ${m.feed?.adapter} unknown`);
  if (!/^https:\/\//.test(m.feed?.results_url || '')) err(m, 'results_url is not https');
  if (m.feed?.identity === 'browser' && !m.feed.identity_note) err(m, 'browser identity without a note saying the named request was refused');
  if (!m.feed?.tz) err(m, 'no tz');
  if (m.count_closes && Number.isNaN(Date.parse(m.count_closes))) err(m, 'count_closes unreadable');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m.certify_by || '')) err(m, 'certify_by is not a date');

  // the guide side
  const places = m.guide?.places || [];
  const bundles = {};
  for (const p of places) { bundles[p] = await loadBundle(p.startsWith('state-') ? `${p}.json` : `place-${p}.json`, bundleDir); if (!bundles[p]) err(m, `no bundle for place ${p}`); }
  stateBundles[m.state] ??= await loadBundle(`state-${m.state}.json`, bundleDir);
  const lint = lintGuide(m, { bundles, stateBundle: stateBundles[m.state], write: !!f.write });
  for (const e of lint.errors) err(m, e);
  for (const x of lint.warnings) warn(m, x);

  // the feed side
  if (!f.offline && ADAPTERS[m.feed?.adapter] && m.election?.feed_election_id) {
    const r = await ADAPTERS[m.feed.adapter].read({ fetch, map: m });
    // A feed that errors (a 5xx, a timeout) is the vendor having a bad minute, not a bad map: warn and go on, so an
    // outage never blocks a code deploy. A refusal is an error.
    if (r.verdict === 'error') warn(m, `feed read: ${r.error || 'error'} (skipped the feed side of the lint)`);
    else if (r.verdict !== 'ok') err(m, `feed read: ${r.verdict} ${r.error || ''}`);
    else {
      if (r.election.date !== '2026-11-03') err(m, `the feed's election is dated ${r.election.date}`);
      if (m.election.feed_name && r.election.name !== m.election.feed_name) err(m, `the feed calls the election "${r.election.name}"`);
      const byId = new Map(r.contests.map((c) => [c.feed_id, c]));
      for (const mc of m.contests || []) {
        const fc = byId.get(String(mc.feed_id));
        if (!fc) { (r.dropped > 0 ? warn : err)(m, `${mc.feed_name} (${mc.feed_id}) isn't in the feed${r.dropped > 0 ? ' (the page was served cut off; it may be past the cut)' : ''}`); continue; }
        if (fc.feed_name !== mc.feed_name) err(m, `${mc.feed_id} is "${fc.feed_name}" in the feed, "${mc.feed_name}" in the map`);
        for (const ch of fc.choices) if (!(ch.name in (mc.choices || {}))) err(m, `${mc.feed_name}: feed choice "${ch.name}" is neither matched nor listed`);
        for (const k of Object.keys(mc.choices || {})) if (!fc.choices.some((ch) => ch.name === k)) err(m, `${mc.feed_name}: map choice "${k}" isn't in the feed`);
      }
    }
  }

  const fp = await fingerprint(m, bundles);
  const sw = await statewideFingerprint(m, bundles);
  if (m.guide?.fingerprint && m.guide.fingerprint !== fp) warn(m, `fingerprint ${m.guide.fingerprint} is stale; the guide now gives ${fp}`);
  if (sw && m.guide?.statewide_fingerprint !== sw) warn(m, m.guide?.statewide_fingerprint ? `statewide fingerprint ${m.guide.statewide_fingerprint} is stale; the guide now gives ${sw}` : `no statewide fingerprint (the guide gives ${sw}); the Worker leaves its statewide slices out until --write records one`);
  if (f.write) writeMap(m);
  // A skeleton map with no contests binds nothing (results-MD, entry 75): its fingerprint stays null, so a full --write
  // run leaves its check hash alone and the hourly check skips it.
  if (f.write && m.contests?.length && (m.guide?.fingerprint !== fp || (m.guide?.statewide_fingerprint ?? null) !== sw)) {
    const g = { ...m.guide, fingerprint: fp, made_from: bundleDir ? `local bundles ${bundleDir}` : `vote.kevinhg.com/data, read ${new Date().toISOString()}` };
    if (sw) g.statewide_fingerprint = sw; else delete g.statewide_fingerprint;
    m.guide = g;
    writeMap(m);
  }
  console.log(`  fingerprint ${fp}${sw ? ` · statewide fingerprint ${sw}` : ''} · map hash ${await mapHash(m)} · check hash ${await checkHash(m)}`);
}
if (f.write && errors === 0) { writeIndex(loadMaps()); console.log('wrote src/maps.gen.js'); }
if (errors) { console.log(`${errors} error(s)`); process.exit(1); }
console.log('ok');
