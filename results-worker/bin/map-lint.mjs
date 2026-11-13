/* The guide side of the map lint (bin/map-check.mjs), as a function the tests can call: each pair against the guide's
   bundles. `bundles` is the map's places' bundles by place id (a county map that carries statewide slices lists its
   state's bundle, `state-XX`, among them so its statewide fingerprint covers those candidates); `stateBundle` is the
   state's.
   With `write`, it also fills what --write fills in (a measure's pass_threshold, a federal or state race widened to a
   county slice). Returns { errors, warnings } as plain sentences. */
import { parseThreshold } from '../src/outcome.js';

const KINDS = ['plurality', 'multi', 'measure', 'retention', 'rcv', 'rule_unknown'];
const OTHER_COUNTIES = 'other counties';

export function lintGuide(m, { bundles = {}, stateBundle = null, write = false } = {}) {
  const errors = [];
  const warnings = [];
  const err = (s) => errors.push(s);
  const warn = (s) => warnings.push(s);
  const places = m.guide?.places || [];
  // Without the state's bundle a statewide item can't be told from a county's own race, so it would pass as one (and
  // could publish as the whole race): a county map is refused rather than linted blind.
  if (m.scope !== 'state' && !stateBundle?.items) err(`no state-${m.state} bundle, so the lint can't tell a statewide item from this county's own races`);
  const statewide = new Set((stateBundle?.items || []).map((i) => i.id));
  const guide = new Map();
  const local = new Set();
  for (const b of Object.values(bundles)) { for (const it of b?.items || []) guide.set(it.id, it); for (const id of b?.local || []) local.add(id); }
  const seen = new Set();
  for (const mc of m.contests || []) {
    const w = `${mc.item} <- ${mc.feed_name} (${mc.feed_id})`;
    if (seen.has(mc.item)) err(`${w}: item mapped twice`);
    seen.add(mc.item);
    if (!KINDS.includes(mc.kind)) err(`${w}: kind ${mc.kind}`);
    if (!Array.isArray(mc.reaches) || mc.reaches.length === 0) err(`${w}: reaches must name the counties this race's voters live in`);
    else if (!mc.reaches.includes(m.county)) err(`${w}: reaches doesn't include ${m.county}`);
    const isStatewide = statewide.has(mc.item) && !local.has(mc.item);
    if (m.scope !== 'state' && isStatewide) {
      // A county's share of a statewide race (Kevin's call, Nov 4; AGENTS.md's results entry says where it is recorded):
      // allowed only as that county's slice, so it is never the whole race, never summed, rides beneath the state's own
      // count, and stands alone (named by county) only when the state has no count to show. The state source keeps the
      // race's link (`statewide: true`, src/merge.js).
      // Exactly [county, "other counties"]: an extra name would reach the published `missing` list (Codex, Nov 4).
      const exact = Array.isArray(mc.reaches) && mc.reaches.length === 2 && mc.reaches[0] === m.county && mc.reaches[1] === OTHER_COUNTIES;
      if (mc.whole || !exact || mc.statewide !== true) {
        err(`${w}: a statewide item in a county map must be that county's slice: reaches exactly ["${m.county}", "${OTHER_COUNTIES}"], statewide: true, never whole`);
        continue;
      }
      if (!guide.has(mc.item)) { err(`${w}: a statewide slice needs state-${m.state} in guide.places, so the map's statewide fingerprint covers its candidates`); continue; }
    } else if (mc.statewide !== undefined) err(`${w}: statewide: true is only for a statewide item's county slice in a county map`);
    if (m.scope === 'state' && !mc.whole) err(`${w}: a state source's contests count the whole race (whole: true)`);
    const it = guide.get(mc.item);
    if (!it) { err(`${w}: not an item on ${places.join(', ')}`); continue; }
    // Federal and state-level races rarely sit inside one county; flag every one a map calls single-county so a person
    // looks, unless the map cites the official district-by-county source (`reaches_source`).
    // Until a district-by-county source confirms it, a federal or state race is never taken as wholly inside one
    // county: --write widens it to a county slice (coordinator, Nov 3).
    if (write && m.scope !== 'state' && ['federal', 'state'].includes(it.level) && Array.isArray(mc.reaches) && mc.reaches.length === 1 && !mc.reaches_source) { mc.reaches = [...mc.reaches, OTHER_COUNTIES]; mc.reaches_unconfirmed = true; }
    if (m.scope !== 'state' && ['federal', 'state'].includes(it.level) && Array.isArray(mc.reaches) && mc.reaches.length === 1 && !mc.reaches_source) warn(`${w}: a ${it.level} race marked wholly inside ${m.county}; confirm`);
    const want = it.kind === 'measure' ? 'measure' : it.is_retention ? 'retention' : it.ranked_choice ? 'rcv' : (it.vote_for || 1) > 1 ? 'multi' : 'plurality';
    if (mc.kind !== want && mc.kind !== 'rule_unknown') err(`${w}: kind ${mc.kind}, the guide says ${want}`);
    // `checked_kind` keeps an earlier check standing (src/fingerprint.js checkHash): only on a race the guide calls
    // plurality, now marked rule_unknown, with a rule_note saying why.
    if (mc.checked_kind !== undefined && (mc.kind !== 'rule_unknown' || mc.checked_kind !== 'plurality' || want !== 'plurality' || !mc.rule_note)) err(`${w}: checked_kind is only for a plurality race marked rule_unknown, with a rule_note`);
    if (want === 'multi' && Number(mc.seats) !== Number(it.vote_for)) err(`${w}: seats ${mc.seats}, the guide votes for ${it.vote_for}`);
    if (want === 'measure') {
      // The threshold the outcome rule uses comes from the guide item, copied into the map on --write.
      if (write) mc.pass_threshold = it.pass_threshold || null;
      if (!mc.pass_threshold && !mc.threshold) err(`${w}: a measure with no pass_threshold (run with --write to copy the guide's)`);
      else if (!parseThreshold(mc.pass_threshold) && !mc.threshold) err(`${w}: pass_threshold "${mc.pass_threshold}" isn't a rule outcome.js can read`);
    }
    // Over and under votes are votes for no one: `__skip`, never `__other`, or they count in the total and lower every
    // candidate's percent (Orange FL, pre-deploy review, Nov 3).
    for (const [k, v] of Object.entries(mc.choices || {})) if (v === '__other' && /\b(?:over|under)[\s-]*votes?\b|\b(?:over|under)votes?\b/i.test(k)) err(`${w}: "${k}" is votes for no one; map it to __skip, not __other`);
    const vals = Object.values(mc.choices || {});
    if (want === 'measure' || want === 'retention') {
      if (vals.filter((v) => v === 'yes').length !== 1 || vals.filter((v) => v === 'no').length !== 1) err(`${w}: a measure needs exactly one yes and one no choice`);
      if (vals.some((v) => !['yes', 'no', '__other', '__skip', null].includes(v))) err(`${w}: measure choices must be yes, no, __other or null`);
    } else {
      const names = (it.candidates || []).map((c) => c.name);
      for (const v of vals) if (v !== null && v !== '__other' && v !== '__skip' && !names.includes(v)) err(`${w}: "${v}" isn't a guide candidate (${names.join(', ')})`);
      for (const n of names) { const k = vals.filter((v) => v === n).length; if (k > 1) err(`${w}: guide candidate ${n} mapped ${k} times`); if (k === 0) warn(`${w}: guide candidate ${n} isn't in the feed`); }
    }
  }
  for (const id of m.unmatched_guide || []) if (!guide.has(id)) err(`unmatched_guide ${id} isn't an item on ${places.join(', ')}`);
  return { errors, warnings };
}
