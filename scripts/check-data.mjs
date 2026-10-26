#!/usr/bin/env node
/*
 * check-data: the rules from FOUNDATION.md, as code. Run it right after `npm run data`.
 *
 * build-data.mjs is forgiving on purpose (a bad record is skipped, never fatal). That is right
 * for the live site and wrong for a gate: a skipped record is a hole in someone's ballot, and a
 * date after Nov 3 is a wrong fact. This script reads the raw JSON itself, the build's own report
 * (public/data/build-report.json, which must exist and be newer than every data file), and the
 * built bundles, and decides what blocks a deploy. Anything the build dropped blocks: a skipped
 * file or record, a candidate with no name, a place pointing at nothing, a duplicate that lost,
 * and any build warning this script does not recognize (classify new ones below, on purpose).
 * Every contest's candidate names must also arrive in the bundles exactly as the raw data has them.
 *
 *   node scripts/check-data.mjs                  # exit 1 on any ERROR above the baseline
 *   node scripts/check-data.mjs --update-baseline  # record today's counts (a person does this on purpose)
 *   node scripts/check-data.mjs --all            # print every finding, not the first 8 per rule
 *
 * Severity: ERROR blocks. WARN reports. Both are ratcheted by scripts/data-baseline.json
 * ({rule: allowed count}): the count may go down, never up. So the gate is green on day one and
 * every new problem is new. As old ones are fixed, run --update-baseline to lock the gain in.
 * No dependencies. Node 18+.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isThin } from './coverage.mjs';

const ROOT = process.env.VG_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const BASELINE_FILE = process.env.BASELINE || path.join(ROOT, 'scripts', 'data-baseline.json');
const ELECTION = '2026-11-03';
const TODAY = process.env.TODAY || new Date().toISOString().slice(0, 10);
const args = process.argv.slice(2);
const ALL = args.includes('--all');

/* ---------- findings ---------- */
const found = {}; // rule -> {sev, msgs[]}
const RULE_SEV = {};
function add(rule, sev, msg) { RULE_SEV[rule] = sev; (found[rule] ||= []).push(msg); }
const err = (rule, msg) => add(rule, 'ERROR', msg);
const warn = (rule, msg) => add(rule, 'WARN', msg);

/* ---------- helpers ---------- */
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isUrl = (v) => isStr(v) && /^https?:\/\/[^\s]+\.[^\s]+/i.test(v.trim());
const isoOk = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
function files(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (e.name.endsWith('.json')) out.push(p);
  }
  return out.sort();
}
const rel = (f) => path.relative(DATA, f);
function load(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { err('json-parse', `${rel(f)}: ${e.message.slice(0, 80)}`); return null; }
}
const listOf = (j, key) => (Array.isArray(j) ? j : j && Array.isArray(j[key]) ? j[key] : j && j.id ? [j] : []);

const all = { contests: [], measures: [], endorsers: [], endorsements: [], places: [], states: [] };
for (const f of files(DATA)) {
  const j = load(f);
  if (j == null) continue;
  const top = rel(f).split(path.sep)[0];
  const base = path.basename(f);
  if (top === 'contests') listOf(j, 'contests').forEach((c) => all.contests.push({ ...c, _f: rel(f) }));
  else if (top === 'measures') listOf(j, 'measures').forEach((m) => all.measures.push({ ...m, _f: rel(f) }));
  else if (top === 'places') all.places.push({ ...j, _f: rel(f) });
  else if (top === 'states') all.states.push({ ...j, _f: rel(f) });
  else if (/^endorsers-/.test(base)) listOf(j, 'endorsers').forEach((e) => all.endorsers.push({ ...e, _f: rel(f) }));
  else if (/^endorsements-/.test(base)) listOf(j, 'endorsements').forEach((e) => all.endorsements.push({ ...e, _f: rel(f) }));
}

/* ---------- 1. the build's own complaints ---------- */
// Every warning build-data.mjs can emit, and what it means. Each one loses or bends data, so each
// blocks; a person who decides a specific one is fine records it with --update-baseline. A warning
// that matches none of these is new: it blocks until someone reads build-data.mjs and adds it here.
const BUILD_WARNINGS = [
  [/has a candidate with no name; dropped it/, 'build-dropped-candidate'],
  [/which no contests or measures file defines; dropped it/, 'build-dropped-place-item'],
  [/appears in .* and .*; kept /, 'build-duplicate-dropped'],
  [/two files disagree .*; kept /, 'build-endorsement-conflict-dropped'],
  [/couldn't match .* to a candidate; shown as text/, 'build-endorsement-unlinked'],
  [/is ranked choice with no usable rank_up_to; using /, 'build-rank-guessed'],
  [/is missing yes_means or no_means/, 'measure-means'],
  [/: short is not one plain line; dropped it|: actions is not a list; dropped it|: an action needs a label and an http\(s\) URL; dropped it|: more than 2 actions; dropped the rest|: a gotcha has no text; dropped it|: registration\.register_url(_source)? is not an http\(s\) URL; dropped it|: sample_ballot_url is not an http\(s\) URL; dropped it/, 'build-dropped-help'],
];
const reportFile = path.join(ROOT, 'public', 'data', 'build-report.json');
const BUNDLES = path.join(ROOT, 'public', 'data');
let report = null;
// A report must be a real build report. Anything else (missing, unreadable, `null`, an array, missing
// lists) blocks, and everything below that depends on the report is then not trusted.
const isReport = (r) => !!r && typeof r === 'object' && !Array.isArray(r) && typeof r.generated === 'string'
  && ['skippedFiles', 'skippedRecords', 'warnings'].every((k) => Array.isArray(r[k])) && !!r.counts && typeof r.counts === 'object';
if (!fs.existsSync(reportFile)) err('build-report-missing', 'public/data/build-report.json does not exist: run `npm run data` first, then this check');
else {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(reportFile, 'utf8')); } catch (e) { err('build-report-invalid', `build-report.json is not readable JSON: ${e.message.slice(0, 80)}`); }
  if (parsed !== undefined && !isReport(parsed)) err('build-report-invalid', 'build-report.json is not a build report (it needs generated, skippedFiles, skippedRecords, warnings and counts): run `npm run data` again');
  else if (parsed !== undefined) report = parsed;
}
if (report) {
  // A report older than the data describes some other data. Compare with every input the build reads.
  const inputs = [...files(DATA), path.join(ROOT, 'scripts', 'build-data.mjs'), path.join(ROOT, 'scripts', 'config.json')].filter((f) => fs.existsSync(f));
  const newest = inputs.reduce((a, f) => { const t = fs.statSync(f).mtimeMs; return t > a.t ? { t, f } : a; }, { t: 0, f: '' });
  const built = Date.parse(report.generated);
  if (!Number.isFinite(built) || newest.t > built + 1000) err('build-report-stale', `build-report.json (${report.generated}) is older than ${path.relative(ROOT, newest.f)}: run \`npm run data\` again`);
  report.skippedFiles.forEach((s) => err('build-skipped-file', `${s.file}: ${s.why}`));
  report.skippedRecords.forEach((s) => err('build-skipped-record', `${s.file} ${s.id}: ${s.why}`));
  for (const w of report.warnings) {
    const hit = BUILD_WARNINGS.find(([re]) => re.test(w));
    err(hit ? hit[1] : 'build-warning-unclassified', w);
  }
}

/* ---------- 2. dates ---------- */
for (const s of all.states) {
  const st = s.state || s._f;
  const d = (v, what, { max = ELECTION, min = '2026-01-01' } = {}) => {
    if (v == null) return null;
    if (!isoOk(v)) { err('date-invalid', `${st} ${what}: "${v}" is not a real YYYY-MM-DD date`); return null; }
    if (v > max) err('date-after-election', `${st} ${what}: ${v} is after ${max}`);
    if (v < min) warn('date-oddly-early', `${st} ${what}: ${v} is before ${min}`);
    return v;
  };
  if (s.election_date !== ELECTION) err('date-election', `${st} election_date is ${s.election_date}, expected ${ELECTION}`);
  (s.registration?.deadlines || []).forEach((x, i) => d(x.date, `registration.deadlines[${i}] (${x.method})`));
  const mb = s.mail_ballot || {};
  const req = d(mb.request_deadline?.date, 'mail request deadline');
  const ret = d(mb.return_deadline?.date, 'mail return deadline');
  if (req && ret && req > ret) err('date-order', `${st}: mail request ${req} is after return ${ret}`);
  const e = s.early_in_person || {};
  const es = d(e.start, 'early voting start'), ee = d(e.end, 'early voting end');
  if (es && ee && es > ee) err('date-order', `${st}: early voting starts ${es}, ends ${ee}`);
  if (e.available === true && !es) warn('early-voting-no-start', `${st}: early voting is available but has no start date`);
  if (s.last_verified) {
    if (!isoOk(s.last_verified) || s.last_verified > TODAY) err('date-last-verified', `${st} last_verified "${s.last_verified}"`);
    else if ((new Date(TODAY) - new Date(s.last_verified)) / 864e5 > 10) warn('stale-verification', `${st} last verified ${s.last_verified}`);
  } else warn('stale-verification', `${st} has no last_verified`);
  // situations may point past the election (cure and certification deadlines); cap at year end.
  (s.situations || []).forEach((x) => { if (x.deadline != null) { if (!isoOk(x.deadline)) err('date-invalid', `${st} situation ${x.id}: "${x.deadline}"`); else if (x.deadline > '2026-12-31') warn('date-oddly-late', `${st} situation ${x.id}: ${x.deadline}`); } });
}
for (const p of all.places) if (p.last_verified && (!isoOk(p.last_verified) || p.last_verified > TODAY)) err('date-last-verified', `place ${p.id} last_verified "${p.last_verified}"`);
for (const r of all.endorsements) {
  if (r.date == null) continue;
  if (/^\d{4}-\d{2}$/.test(r.date) && isoOk(`${r.date}-01`)) { warn('date-partial', `${r.endorser_id}->${r.target_id}: "${r.date}" (month only)`); if (`${r.date}-31` > TODAY && `${r.date}-01` > TODAY) err('date-future', `${r.endorser_id}->${r.target_id}: ${r.date}`); }
  else if (!isoOk(r.date)) err('date-invalid', `${r._f} ${r.endorser_id}->${r.target_id}: "${r.date}"`);
  else if (r.date > TODAY) err('date-future', `${r._f} ${r.endorser_id}->${r.target_id}: endorsement dated ${r.date}, after today (${TODAY})`);
  else if (r.date < '2026-01-01') warn('endorsement-old', `${r.endorser_id}->${r.target_id}: dated ${r.date}`);
}

/* ---------- 3. measures: both ways to vote explained ---------- */
for (const m of all.measures) {
  const id = `${m._f} ${m.id}`;
  if (!isStr(m.yes_means)) err('measure-means', `${id}: no yes_means`);
  if (!isStr(m.no_means)) err('measure-means', `${id}: no no_means`);
  if (isStr(m.yes_means) && m.yes_means.trim() === (m.no_means || '').trim()) err('measure-means', `${id}: yes_means and no_means are identical`);
  for (const k of ['plain_summary', 'pass_threshold', 'official_text_url']) if (!isStr(m[k])) warn('measure-missing-field', `${id}: no ${k}`);
  if (m.official_text_url && !isUrl(m.official_text_url)) err('url-invalid', `${id}: official_text_url "${m.official_text_url}"`);
  if (!!m.supporters_case !== !!m.opponents_case) warn('measure-one-sided', `${id}: only one side of the case is written`);
  if (!['verified', 'sourced', 'unverified'].includes(m.confidence)) err('confidence', `${id}: confidence "${m.confidence}"`);
}

/* ---------- 4. contests ---------- */
const seen = new Map();
for (const c of all.contests) {
  const id = `${c._f} ${c.id}`;
  if (seen.has(c.id)) warn('duplicate-id-across-files', `${c.id} in ${seen.get(c.id)} and ${c._f}`); else seen.set(c.id, c._f);
  if (!['verified', 'sourced', 'unverified'].includes(c.confidence)) err('confidence', `${id}: confidence "${c.confidence}"`);
  if (!Array.isArray(c.candidates)) err('contest-candidates-not-list', `${id}: candidates is not a list, so the build drops the whole race`);
  else if (c.candidates.length === 0) warn('contest-no-candidates', id);
  // The build drops a nameless candidate with only a warning; here it is a hole in someone's ballot.
  (Array.isArray(c.candidates) ? c.candidates : []).forEach((k, i) => { if (!k || typeof k !== 'object' || !isStr(k.name)) err('candidate-no-name', `${id}: candidate ${i + 1} has no name, so the build drops them`); });
  if (c.ranked_choice === true) {
    if (!Number.isInteger(c.rank_up_to) || c.rank_up_to < 2) err('rcv', `${id}: ranked choice with no usable rank_up_to`);
    if (!Number.isInteger(c.winners) || c.winners < 1) warn('rcv', `${id}: ranked choice with no winners count`);
    if (!isUrl(c.rcv_url)) warn('rcv', `${id}: ranked choice with no rcv_url`);
  }
  const names = (Array.isArray(c.candidates) ? c.candidates : []).filter((k) => k && isStr(k.name)).map((k) => k.name.trim());
  if (new Set(names).size !== names.length) err('candidate-duplicate', `${id}: two candidates share a name`);
  const withWords = (c.candidates || []).filter((k) => (k.own_words || []).length);
  if (withWords.length && withWords.length < (c.candidates || []).length && (c.candidates || []).length > 1) warn('own-words-parallel', `${id}: own_words for ${withWords.length} of ${c.candidates.length} candidates`);
  const withBg = (c.candidates || []).filter((k) => isStr(k.background));
  if (withBg.length && withBg.length < (c.candidates || []).length && (c.candidates || []).length > 1) warn('background-parallel', `${id}: background for ${withBg.length} of ${c.candidates.length} candidates`);
  for (const k of c.candidates || []) {
    for (const o of k.own_words || []) if (!isUrl(o.source)) err('own-words-source', `${id} / ${k.name}: an own_words entry has no source URL`);
    if (k.website && !isUrl(k.website)) err('url-invalid', `${id} / ${k.name}: website "${k.website}"`);
  }
}

/* ---------- 5. endorsers: lean only from outside ratings, party status, or stated mission ---------- */
const LEANS = ['left', 'lean_left', 'neutral', 'lean_right', 'right'];
const OUTSIDE_OK = /\b(democrat\w*|republican|libertarian|green party)\b|allsides|ad fontes|media bias|official (state |county |local )?party|party (organization|committee|affiliate)|certified|describes itself|states? (its|their) (own )?mission|own (stated )?mission|self-describ|mission|about (us|page)|not rated|no outside rating|no (separate )?rating|nonpartisan|does not endorse/i;
const FROM_PICKS = /based on (its|their|the) (picks|endorsements|slate)|endorsement pattern|picks lean|endorses (mostly|mainly|primarily|almost only)|slate (leans|is)|(who|whom) (it|they) endorse|candidates (it|they) (back|endorse)s?/i;
const byEndorser = new Map();
for (const e of all.endorsers) {
  const id = `${e._f} ${e.id}`;
  (byEndorser.get(e.id) || byEndorser.set(e.id, []).get(e.id)).push(e);
  if (e.lean != null && !LEANS.includes(e.lean)) err('lean', `${id}: lean "${e.lean}" is not one of ${LEANS.join(', ')}`);
  if (!isStr(e.lean_basis)) err('lean-basis', `${id}: no lean_basis`);
  else {
    if (FROM_PICKS.test(e.lean_basis)) err('lean-from-picks', `${id}: lean_basis reads like a lean taken from whom they endorse: "${e.lean_basis.slice(0, 100)}"`);
    if (!OUTSIDE_OK.test(e.lean_basis)) warn('lean-basis-source', `${id}: lean_basis names no outside rating, party status or stated mission: "${e.lean_basis.slice(0, 100)}"`);
    if (e.lean && e.type === 'publication' && !/allsides|ad fontes|media bias/i.test(e.lean_basis)) warn('lean-publication-unrated', `${id}: a publication with a lean but no AllSides or Ad Fontes rating in lean_basis`);
    if (!e.lean && !/not rated|no outside rating|no (separate )?rating|not rate/i.test(e.lean_basis)) warn('lean-null-unexplained', `${id}: no lean, and lean_basis does not say it is unrated`);
  }
  if (!isUrl(e.guide_url)) warn('endorser-guide-url', `${id}: no usable guide_url`);
  // Paywalled papers (Oct 19): build-data honors only a literal true, so anything else is a typo.
  if (e.paywall != null && typeof e.paywall !== 'boolean') err('paywall-shape', `${id}: paywall must be true or false, got ${JSON.stringify(e.paywall)}`);
  if (e.paywall_note_ok != null && typeof e.paywall_note_ok !== 'boolean') err('paywall-shape', `${id}: paywall_note_ok must be true or false, got ${JSON.stringify(e.paywall_note_ok)}`);
  if (e.paywall_note != null && !isStr(e.paywall_note)) err('paywall-shape', `${id}: paywall_note must be text`);
}
for (const [id, vs] of byEndorser) {
  const leans = [...new Set(vs.map((v) => v.lean ?? 'null'))];
  if (leans.length > 1) warn('lean-conflict', `${id}: ${vs.map((v) => `${v._f}=${v.lean}`).join(' vs ')}`);
}

/* ---------- 6. endorsements: every endorsed row has a URL; states stay distinct ---------- */
const targets = new Set([...all.contests, ...all.measures].map((x) => x.id));
const endorserIds = new Set(all.endorsers.map((e) => e.id));
const STATUS = ['endorsed', 'no_position', 'not_found'];
for (const r of all.endorsements) {
  const id = `${r._f} ${r.endorser_id}->${r.target_id}`;
  if (!STATUS.includes(r.status)) { err('endorsement-status', `${id}: status "${r.status}"`); continue; }
  if (!targets.has(r.target_id)) err('endorsement-dangling', `${id}: target does not exist`);
  if (!endorserIds.has(r.endorser_id)) warn('endorsement-dangling-endorser', `${id}: endorser id is not in any endorsers file (an alias in config.json may cover it)`);
  if (r.status === 'endorsed') {
    if (!isUrl(r.url)) err('endorsement-url', `${id}: endorsed with no URL`);
    if (!isStr(r.choice)) err('endorsement-choice', `${id}: endorsed with no choice`);
  } else if (isStr(r.choice)) err('endorsement-state-mixed', `${id}: status ${r.status} but has a choice ("${r.choice}")`);
  if (r.confidence != null && !['verified', 'sourced', 'unverified'].includes(r.confidence)) err('confidence', `${id}: confidence "${r.confidence}"`);
  // `unreadable: true` marks a not_found row whose source couldn't be read (Oct 20); build-data honors
  // only a literal true on a not_found row, so anything else is a typo.
  if (r.unreadable != null && (r.unreadable !== true || r.status !== 'not_found')) err('endorsement-unreadable-shape', `${id}: unreadable must be true and only on a not_found row, got ${JSON.stringify(r.unreadable)} on ${r.status}`);
}

/* ---------- 7. places ---------- */
const stateIds = new Set(all.states.map((s) => s.state));
for (const p of all.places) {
  if (!stateIds.has(p.state)) err('place-state', `${p._f}: no states/${p.state}.json`);
  if (!Array.isArray(p.zips) || !p.zips.length) err('place-zips', `${p._f}: no ZIPs`);
  (p.zips || []).forEach((z) => { if (!/^\d{5}$/.test(String(z))) err('place-zips', `${p._f}: bad ZIP "${z}"`); });
  for (const id of [...(p.contest_ids || []), ...(p.measure_ids || [])]) if (!targets.has(id)) err('place-dangling', `${p._f}: lists ${id}, which no file defines`);
  const ids = [...(p.contest_ids || []), ...(p.measure_ids || [])];
  if (new Set(ids).size !== ids.length) warn('place-duplicate-ids', `${p._f}: lists an id twice`);
}

/* ---------- 7b. what the build wrote, bundle by bundle ----------
   Independent of the build's own warnings, so a new way of dropping data is caught even if nobody
   taught the build to mention it. Each state and place bundle is checked on its own against what the
   raw data says it must hold: its races and measures, in order, each with exactly the raw data's
   named candidates in order. A correct copy of a race in one bundle never vouches for a broken copy
   in another (Codex round 2: Englewood missing a candidate passed because Aurora's copy was fine). */
if (!fs.existsSync(BUNDLES)) err('bundle-missing', 'public/data does not exist: run `npm run data` first');
else if (report) {
  const readBundle = (name) => {
    const f = path.join(BUNDLES, name);
    if (!fs.existsSync(f)) { err('bundle-missing', `${name} was not written`); return null; }
    try { const b = JSON.parse(fs.readFileSync(f, 'utf8')); if (b && typeof b === 'object') return b; } catch (e) { err('bundle-unreadable', `${name}: ${e.message.slice(0, 80)}`); return null; }
    err('bundle-unreadable', `${name}: not a bundle`); return null;
  };
  const rawById = new Map();
  for (const x of [...all.contests, ...all.measures]) if (isStr(x.id) && !rawById.has(x.id.trim())) rawById.set(x.id.trim(), x);
  const named = (x) => (Array.isArray(x.candidates) ? x.candidates : []).filter((k) => k && isStr(k.name)).map((k) => k.name.trim());
  const list = (v) => (Array.isArray(v) ? v : []);
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const firstDiff = (want, got) => {
    const i = want.findIndex((x, j) => x !== got[j]);
    return i < 0 ? `has ${got.length - want.length} more than the data (${got.slice(want.length, want.length + 3).join(', ')})` : `differs at position ${i + 1}: the data has ${want[i]}, the bundle has ${got[i] ?? 'nothing'}`;
  };
  const checkItems = (where, b, wantIds) => {
    const items = list(b.items);
    const gotIds = items.map((it) => (it && it.id) || '?');
    if (!same(wantIds, gotIds)) err('bundle-items-differ', `${where}: items ${firstDiff(wantIds, gotIds)}`);
    for (const it of items) {
      const raw = it && rawById.get(it.id);
      if (!raw || raw.candidates === undefined) continue; // an unknown id is reported just above; measures have no candidates
      const want = named(raw);
      const got = list(it.candidates).map((k) => (k && k.name) || '');
      if (!same(want, got)) {
        const gone = want.filter((n) => !got.includes(n));
        err('bundle-candidates-differ', `${where} ${it.id}: the data has ${want.length} named candidates, the bundle has ${got.length}${gone.length ? ` (missing: ${gone.slice(0, 3).join(', ')})` : ' (order or names differ)'}`);
      }
    }
  };
  // State bundles: every race and measure from that state's {st}-statewide files, contests first, in file order.
  const statewide = new Map();
  for (const s of all.states) {
    const st = String(s.state || '').trim().toUpperCase();
    if (!st) continue;
    const fromFile = (x) => isStr(x.id) && path.basename(x._f).toLowerCase().startsWith(`${st.toLowerCase()}-statewide`);
    const want = [...all.contests.filter(fromFile), ...all.measures.filter(fromFile)].map((x) => x.id.trim());
    statewide.set(st, new Set(want));
    const b = readBundle(`state-${st}.json`);
    if (!b) continue;
    if (!same(want, list(b.order))) err('bundle-order-differ', `state-${st}.json: order ${firstDiff(want, list(b.order))}`);
    checkItems(`state-${st}.json`, b, want);
  }
  // Place bundles: the place's listed races and measures that exist, in its order; items are the non-statewide ones.
  for (const p of all.places) {
    if (!isStr(p.id)) continue;
    const order = [];
    for (const id of [...list(p.contest_ids), ...list(p.measure_ids)]) if (rawById.has(id) && !order.includes(id)) order.push(id);
    const sw = statewide.get(String(p.state || '').trim().toUpperCase()) || new Set();
    const local = order.filter((id) => !sw.has(id));
    const name = `place-${p.id}.json`;
    const b = readBundle(name);
    if (!b) continue;
    if (!same(order, list(b.order))) err('bundle-order-differ', `${name}: order ${firstDiff(order, list(b.order))}`);
    if (!same(local, list(b.local))) err('bundle-order-differ', `${name}: local ${firstDiff(local, list(b.local))}`);
    checkItems(name, b, local);
  }
  const onABallot = new Set([...[...statewide.values()].flatMap((s) => [...s]), ...all.places.flatMap((p) => [...list(p.contest_ids), ...list(p.measure_ids)])]);
  for (const [id, x] of rawById) if (!onABallot.has(id)) warn('item-on-no-ballot', `${x._f} ${id}: defined, but no place lists it and it is not statewide`);
}

/* ---------- 7c. thin places (Oct 25) ----------
   A place none of whose own sources has a pick (index.json, scripts/coverage.mjs) is reported, never
   blocking, so a thin city shows in CI output. Where some of its own races also have no pick from
   anyone, the first page says so and offers to gather its endorsements (src/model/coverage.ts). */
const INDEX_FILE = path.join(BUNDLES, 'index.json');
if (fs.existsSync(INDEX_FILE)) {
  let idx = null;
  try { idx = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch { err('bundle-unreadable', 'index.json'); }
  for (const [id, p] of Object.entries((idx && idx.places) || {})) {
    if (!(p.local_sources > 0 && p.local_with_picks === 0) && !isThin(p)) continue;
    warn('place-thin', `${id}: ${p.local_sources} local sources, none with picks; ${p.local_races_with_picks} of its ${p.local_races} own races have a pick from anyone${isThin(p) ? '. The first page offers to gather its endorsements.' : ''}`);
  }
}

/* ---------- 8. our own words: no em dashes, no shouting ---------- */
// Our copy. Anything quoted from someone else (ballot wording, own_words quotes, names, URLs) is out of scope.
const OURS = new Set(['office_explainer', 'why_it_matters', 'scope_plain', 'plain_summary', 'yes_means', 'no_means', 'current_law', 'fiscal_impact',
  'confusing_wording_note', 'pass_threshold', 'background', 'model_plain', 'gotchas', 'answer', 'steps', 'mail_cutoff_advice', 'notes', 'zip_caveats',
  'lean_basis', 'why', 'note', 'rcv_how', 'who_gets_one', 'hours_note', 'same_day_notes', 'cure_process', 'signature_witness_rules', 'in_line_rule',
  'apparel_rule', 'phones_detail', 'notes_detail', 'still_possible_now', 'postage', 'no_id_option', 'smd_names_note', 'text', 'short', 'hours_short']);
const SKIP_PARENT = new Set(['official_title']);
const ACRONYMS = new Set(fs.existsSync(path.join(ROOT, 'scripts', 'acronyms.txt')) ? fs.readFileSync(path.join(ROOT, 'scripts', 'acronyms.txt'), 'utf8').split(/\s+/).filter(Boolean) : []);
// Names of groups and offices are written in caps by their owners (ISBA, TABOR). Tokens that occur in any name-like field are allowed.
const nameTokens = new Set();
const harvest = (s) => { for (const m of String(s || '').matchAll(/[A-Z][A-Z0-9&'’-]{1,}/g)) nameTokens.add(m[0].replace(/['’]S?$/, '')); };
[...all.endorsers].forEach((e) => { harvest(e.name); harvest(e.short); e.id.toUpperCase().split('-').forEach((t) => { if (t.length > 1) nameTokens.add(t); }); });
[...all.contests, ...all.measures].forEach((x) => { harvest(x.office); harvest(x.number); harvest(x.jurisdiction); harvest(x.district); harvest(x.official_title); });
all.contests.forEach((c) => (c.candidates || []).forEach((k) => harvest(k.name)));
const STRESS = /^(NOT|ONLY|MUST|NEVER|ALWAYS|TODAY|AGAINST|FAVOR|OPPOSITION|SUPPORT|OPPOSE|EVERY|ALL|ANY|ONE|TWO|THE|AND|FOR|NEW|CITY|VOTE|RECEIVED|POSTMARKED|NOON|DEADLINE|BEFORE|AFTER|YOUR|THIS|WITH|FROM|MEETS|DOES|STANDARDS|PERFORMANCE|ELECTION|EARLY|VOTING|BALLOT|IMPORTANT|WARNING|CANNOT)$/;
function stripQuoted(s) { return s.replace(/"[^"]*"|“[^”]*”|'[^']{4,}'|‘[^’]{4,}’/g, ' '); }
// Names written in caps by their owners. Add to scripts/acronyms.txt rather than here.
const NAME_PHRASES = /\bUSA TODAY\b/g;
function scanCopy(text, where) {
  if (!isStr(text)) return;
  const t = stripQuoted(text).replace(NAME_PHRASES, ' ');
  if (t.includes('\u2014')) err('copy-em-dash', `${where}: "...${t.slice(Math.max(0, t.indexOf('\u2014') - 25), t.indexOf('\u2014') + 25)}..."`);
  const toks = [...t.matchAll(/(?<![\w-])[A-Z][A-Z'’]{2,}(?![\w-])/g)].map((m) => m[0].replace(/['’]S?$/, ''));
  // Shouting: an ordinary English word in caps, or three caps words in a row. YES and NO are vote words, handled in the app.
  const stress = toks.filter((w) => STRESS.test(w) && !ACRONYMS.has(w));
  const run = /\b[A-Z]{3,}(?:\s+[A-Z]{3,}){2,}\b/.test(t);
  if (stress.length || run) err('copy-shouting', `${where}: ${[...new Set(stress)].slice(0, 5).join(' ') || t.match(/\b[A-Z]{3,}(?:\s+[A-Z]{3,}){2,}\b/)[0]}`);
  // Caps we cannot place: probably a name or acronym. Review once, then add it to scripts/acronyms.txt.
  const unknown = toks.filter((w) => !STRESS.test(w) && w.length >= 4 && !ACRONYMS.has(w) && !nameTokens.has(w) && w !== 'YES');
  if (unknown.length) warn('copy-caps-unreviewed', `${where}: ${[...new Set(unknown)].slice(0, 4).join(' ')}`);
}
function walk(o, where, key, quoted) {
  if (Array.isArray(o)) return o.forEach((v, i) => walk(v, `${where}[${i}]`, key, quoted));
  if (o && typeof o === 'object') {
    const q = quoted || o.is_quote === true;
    return Object.entries(o).forEach(([k, v]) => { if (!SKIP_PARENT.has(k) && !k.startsWith('_')) walk(v, `${where}.${k}`, k, q); });
  }
  if (typeof o === 'string' && OURS.has(key) && !quoted) scanCopy(o, where);
}
all.contests.forEach((c) => walk(c, `${c._f} ${c.id}`));
all.measures.forEach((m) => walk(m, `${m._f} ${m.id}`));
all.states.forEach((s) => walk(s, `states/${s.state}`));
all.places.forEach((p) => walk(p, `places/${p.id}`));
all.endorsers.forEach((e) => walk(e, `${e._f} ${e.id}`));

/* ---------- 9. common questions: quick answers and their buttons (Oct 20) ---------- */
// A situation's short answer is one sentence of 20 words at most, a gotcha's fix 15, a place's
// hours line 20. Every button goes to a URL this state file already holds: no new links.
const words = (t) => String(t || '').trim().split(/\s+/).filter(Boolean).length;
const oneSentence = (t) => !/[.!?]\s+\S/.test(String(t).replace(/\b(U\.S|St|No|Mr|Mrs|Ms|Dr|a\.m|p\.m)\./g, '$1'));
function shortOk(t, max, where) {
  if (t == null) return;
  if (!isStr(t)) return;
  if (words(t) > max) err('help-short-long', `${where}: ${words(t)} words (max ${max}): "${t.slice(0, 60)}..."`);
  if (!oneSentence(t)) warn('help-short-sentences', `${where}: more than one sentence: "${t.slice(0, 60)}..."`);
}
for (const s of all.states) {
  const st = s.state || s._f;
  const r = s.registration || {};
  if (!isUrl(r.register_url)) warn('help-register-url', `${st}: no registration.register_url`);
  const known = new Set([r.check_url, r.register_url, r.register_url_source, s.election_day?.lookup_url, s.early_in_person?.lookup_url, s.mail_ballot?.tracking_url,
    s.mail_ballot?.drop_box_lookup_url, s.official_site?.url, ...(s.sources || []).map((x) => x && x.url)].filter(isStr).map((u) => u.trim()));
  (s.situations || []).forEach((x) => {
    if (!x) return;
    const where = `${st} situation ${x.id}`;
    shortOk(x.short, 20, where);
    (Array.isArray(x.actions) ? x.actions : []).forEach((a, i) => {
      if (!a || !isStr(a.url)) return;
      if (!known.has(a.url.trim()) && a.url.trim() !== (x.source || '').trim()) err('help-action-url', `${where} action ${i + 1}: ${a.url} is not a URL this state file already holds`);
      const n = words(a.label);
      if (n < 2 || n > 5) warn('help-action-label', `${where} action ${i + 1}: "${a.label}" is ${n} words (2 to 5)`);
      scanCopy(a.label, `${where} action ${i + 1}`);
    });
  });
  (s.gotchas || []).forEach((g, i) => { if (g && typeof g === 'object') shortOk(g.short, 15, `${st} gotcha ${i + 1}`); });
}
all.places.forEach((p) => shortOk(p.early_in_person?.hours_short, 20, `places/${p.id} early_in_person.hours_short`));
all.endorsements.forEach((r) => walk(r, `${r._f} ${r.endorser_id}->${r.target_id}`));

/* ---------- report with the ratchet ---------- */
// WARN rules ratchet by count. ERROR rules ratchet by exact finding, so fixing one old problem
// cannot hide a new one. {counts: {rule: n}, keys: {rule: [finding, ...]}}
const baseline = fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) : { counts: {}, keys: {} };
if (args.includes('--update-baseline')) {
  const next = { counts: {}, keys: {} };
  for (const [r, m] of Object.entries(found).sort()) { if (RULE_SEV[r] === 'ERROR') next.keys[r] = [...m].sort(); else next.counts[r] = m.length; }
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(next, null, 1) + '\n');
  console.log(`check-data: baseline written (${Object.keys(next.counts).length} warning rules by count, ${Object.keys(next.keys).length} error rules by finding).`);
  process.exit(0);
}
let blocked = 0;
for (const [rule, msgs] of Object.entries(found).sort()) {
  const sev = RULE_SEV[rule];
  const known = new Set((baseline.keys || {})[rule] || []);
  const fresh = sev === 'ERROR' ? msgs.filter((m) => !known.has(m)) : msgs.length > ((baseline.counts || {})[rule] ?? 0) ? msgs : [];
  if (fresh.length && sev === 'ERROR') blocked++;
  const tag = fresh.length ? (sev === 'ERROR' ? 'ERROR' : 'WARN ') : 'known';
  console.log(`${tag}  ${rule}: ${msgs.length}${fresh.length && sev === 'ERROR' ? ` (${fresh.length} new)` : ''}`);
  if (fresh.length || ALL) for (const m of (ALL ? msgs : fresh).slice(0, ALL ? 1e9 : 8)) console.log(`        ${m}`);
  if (!ALL && fresh.length > 8) console.log(`        ... ${fresh.length - 8} more (--all)`);
}
for (const rule of new Set([...Object.keys(baseline.counts || {}), ...Object.keys(baseline.keys || {})])) if (!found[rule]) console.log(`fixed  ${rule}: now zero (run --update-baseline to lock it in)`);
console.log(`check-data: ${all.contests.length} contests, ${all.measures.length} measures, ${all.endorsers.length} endorsers, ${all.endorsements.length} endorsements, ${all.places.length} places, ${all.states.length} states. ${blocked ? `${blocked} error rules have new findings.` : 'No new errors.'}`);
process.exit(blocked ? 1 : 0);
