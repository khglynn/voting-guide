#!/usr/bin/env node
/* The lint every map passes before it deploys (PLAN-PHASE-1 section 3.4):
   - shape: election, feed, contests with kind, seats, choices and reaches;
   - against the guide's live bundles (or --bundles public/data): every mapped item exists in one of the map's places,
     isn't a statewide item (statewide rows come only from a state source), and its kind and seats agree with the guide;
     every guide candidate is mapped exactly once, no guide candidate twice, a measure has one yes and one no;
   - against the feed (a live read; --offline skips it): every mapped contest is in the feed under the same name, and
     every feed choice is matched or deliberately listed (`__other`);
   then writes the fingerprint (with --write) and regenerates src/maps.gen.js. Exit 1 on any error.
   Usage: node bin/map-check.mjs [--write] [--offline] [--bundles ../public/data] [map ids...] */
import { loadMaps, writeMap, writeIndex, loadBundle, flags } from './lib.mjs';
import { ADAPTERS } from '../src/adapters/index.js';
import { fingerprint, mapHash, checkHash } from '../src/fingerprint.js';
import { parseThreshold } from '../src/outcome.js';

const KINDS = ['plurality', 'multi', 'measure', 'retention', 'rcv', 'rule_unknown'];
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
  const statewide = new Set((stateBundles[m.state]?.items || []).map((i) => i.id));
  const guide = new Map();
  const local = new Set();
  for (const b of Object.values(bundles)) { for (const it of b?.items || []) guide.set(it.id, it); for (const id of b?.local || []) local.add(id); }
  const seen = new Set();
  for (const mc of m.contests || []) {
    const w = `${mc.item} <- ${mc.feed_name} (${mc.feed_id})`;
    if (seen.has(mc.item)) err(m, `${w}: item mapped twice`);
    seen.add(mc.item);
    if (!KINDS.includes(mc.kind)) err(m, `${w}: kind ${mc.kind}`);
    if (!Array.isArray(mc.reaches) || mc.reaches.length === 0) err(m, `${w}: reaches must name the counties this race's voters live in`);
    else if (!mc.reaches.includes(m.county)) err(m, `${w}: reaches doesn't include ${m.county}`);
    if (m.scope !== 'state' && statewide.has(mc.item) && !local.has(mc.item)) { err(m, `${w}: a statewide item from a county source`); continue; }
    if (m.scope === 'state' && !mc.whole) err(m, `${w}: a state source's contests count the whole race (whole: true)`);
    const it = guide.get(mc.item);
    if (!it) { err(m, `${w}: not an item on ${places.join(', ')}`); continue; }
    // Federal and state-level races rarely sit inside one county; flag every one a map calls single-county so a person
    // looks, unless the map cites the official district-by-county source (`reaches_source`).
    // Until a district-by-county source confirms it, a federal or state race is never taken as wholly inside one
    // county: --write widens it to a county slice (coordinator, Nov 3).
    if (f.write && m.scope !== 'state' && ['federal', 'state'].includes(it.level) && Array.isArray(mc.reaches) && mc.reaches.length === 1 && !mc.reaches_source) { mc.reaches = [...mc.reaches, 'other counties']; mc.reaches_unconfirmed = true; }
    if (m.scope !== 'state' && ['federal', 'state'].includes(it.level) && Array.isArray(mc.reaches) && mc.reaches.length === 1 && !mc.reaches_source) warn(m, `${w}: a ${it.level} race marked wholly inside ${m.county}; confirm`);
    const want = it.kind === 'measure' ? 'measure' : it.is_retention ? 'retention' : it.ranked_choice ? 'rcv' : (it.vote_for || 1) > 1 ? 'multi' : 'plurality';
    if (mc.kind !== want && mc.kind !== 'rule_unknown') err(m, `${w}: kind ${mc.kind}, the guide says ${want}`);
    // `checked_kind` keeps an earlier check standing (src/fingerprint.js checkHash): only on a race the guide calls
    // plurality, now marked rule_unknown, with a rule_note saying why.
    if (mc.checked_kind !== undefined && (mc.kind !== 'rule_unknown' || mc.checked_kind !== 'plurality' || want !== 'plurality' || !mc.rule_note)) err(m, `${w}: checked_kind is only for a plurality race marked rule_unknown, with a rule_note`);
    if (want === 'multi' && Number(mc.seats) !== Number(it.vote_for)) err(m, `${w}: seats ${mc.seats}, the guide votes for ${it.vote_for}`);
    if (want === 'measure') {
      // The threshold the outcome rule uses comes from the guide item, copied into the map on --write.
      if (f.write) mc.pass_threshold = it.pass_threshold || null;
      if (!mc.pass_threshold && !mc.threshold) err(m, `${w}: a measure with no pass_threshold (run with --write to copy the guide's)`);
      else if (!parseThreshold(mc.pass_threshold) && !mc.threshold) err(m, `${w}: pass_threshold "${mc.pass_threshold}" isn't a rule outcome.js can read`);
    }
    // Over and under votes are votes for no one: `__skip`, never `__other`, or they count in the total and lower every
    // candidate's percent (Orange FL, pre-deploy review, Nov 3).
    for (const [k, v] of Object.entries(mc.choices || {})) if (v === '__other' && /\b(?:over|under)[\s-]*votes?\b|\b(?:over|under)votes?\b/i.test(k)) err(m, `${w}: "${k}" is votes for no one; map it to __skip, not __other`);
    const vals = Object.values(mc.choices || {});
    if (want === 'measure' || want === 'retention') {
      if (vals.filter((v) => v === 'yes').length !== 1 || vals.filter((v) => v === 'no').length !== 1) err(m, `${w}: a measure needs exactly one yes and one no choice`);
      if (vals.some((v) => !['yes', 'no', '__other', '__skip', null].includes(v))) err(m, `${w}: measure choices must be yes, no, __other or null`);
    } else {
      const names = (it.candidates || []).map((c) => c.name);
      for (const v of vals) if (v !== null && v !== '__other' && v !== '__skip' && !names.includes(v)) err(m, `${w}: "${v}" isn't a guide candidate (${names.join(', ')})`);
      for (const n of names) { const k = vals.filter((v) => v === n).length; if (k > 1) err(m, `${w}: guide candidate ${n} mapped ${k} times`); if (k === 0) warn(m, `${w}: guide candidate ${n} isn't in the feed`); }
    }
  }
  for (const id of m.unmatched_guide || []) if (!guide.has(id)) err(m, `unmatched_guide ${id} isn't an item on ${places.join(', ')}`);

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
  if (m.guide?.fingerprint && m.guide.fingerprint !== fp) warn(m, `fingerprint ${m.guide.fingerprint} is stale; the guide now gives ${fp}`);
  if (f.write) writeMap(m);
  if (f.write && m.guide?.fingerprint !== fp) { m.guide = { ...m.guide, fingerprint: fp, made_from: bundleDir ? `local bundles ${bundleDir}` : `vote.kevinhg.com/data, read ${new Date().toISOString()}` }; writeMap(m); }
  console.log(`  fingerprint ${fp} · map hash ${await mapHash(m)} · check hash ${await checkHash(m)}`);
}
if (f.write && errors === 0) { writeIndex(loadMaps()); console.log('wrote src/maps.gen.js'); }
if (errors) { console.log(`${errors} error(s)`); process.exit(1); }
console.log('ok');
