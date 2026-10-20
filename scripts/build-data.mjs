#!/usr/bin/env node
/*
 * build-data: reads the research JSON in data/ and writes lazily loaded bundles to
 * public/data/:
 *   index.json          states, places, ZIP index (small, loaded first)
 *   state-{ST}.json     how to vote + statewide contests, measures, endorsers, endorsements
 *   place-{id}.json     local contests, measures, endorsers, endorsements, ballot order
 *
 * New places drop in: add data/places/{id}.json plus its contests/measures/endorsers/
 * endorsements files, then rerun. A file or record that fails validation is skipped and
 * listed in public/data/build-report.json. The build never fails on bad research data;
 * it fails only if nothing usable is left.
 *
 * No dependencies. Node 18+.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(ROOT, 'public', 'data');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'config.json'), 'utf8'));

// `commit` is the git commit Vercel built (it sets VERCEL_GIT_COMMIT_SHA during builds), so scripts/ship.sh
// can prove a preview or production is serving exactly the commit it expects. Local builds leave it null.
const report = { generated: new Date().toISOString(), commit: process.env.VERCEL_GIT_COMMIT_SHA || null, skippedFiles: [], skippedRecords: [], warnings: [], counts: {} };
const warn = (msg) => { report.warnings.push(msg); };
const skipRec = (file, id, why) => { report.skippedRecords.push({ file, id, why }); };

const LEVELS = ['federal', 'state', 'county', 'city', 'judicial', 'school', 'special_district'];
const M_LEVELS = ['state', 'county', 'city', 'school', 'special_district'];
const LEANS = ['left', 'lean_left', 'neutral', 'lean_right', 'right'];
const STATUSES = ['endorsed', 'no_position', 'not_found'];
const CONF = ['verified', 'sourced', 'unverified'];

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const str = (v) => (isStr(v) ? v.trim() : null);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const conf = (v) => (CONF.includes(v) ? v : 'unverified');
const safeUrl = (u) => (isStr(u) && /^https?:\/\//i.test(u.trim()) ? u.trim() : null);
// Research notes are not the candidate's words ("No statement collected", "Campaign site ... not opened
// for this guide", "Unopposed on the ballot. No positions collected."). Drop those sentences; drop the
// item if nothing else is left, so the card shows its empty state instead of a fake bullet.
const META = /(for this guide|this (guide|run|pass)\b|not (yet )?(collected|opened|read|reviewed)|\b(was|were) not (read|opened|reviewed)|positions? (were |was )?not collected|no positions collected|^unopposed on the ballot|^no (\d{4} )?(statements?|platform|own words|positions?|campaign|issue|questionnaire|published|stated|voters'? pamphlet|lacc?d platform)\b.*\b(found|located|reviewed|collected|exists?|submitted)?|^we found no|^none found|^not collected|^did not respond\b|(campaign site|website) (had|listed|has) no\b|has no campaign website|^no bio\b|answers were not captured|ballotpedia lists|no questionnaire response)/i;
const stripNotes = (t) => t.split(/(?<=[.;!?])\s+/).filter((x) => !META.test(x.trim()) && !/^see (his|her|their|the) /i.test(x.trim())).join(' ').trim();

/* ---------- optional ledger fields (Oct 19 data contract) ----------
   Every one is optional. A bad shape warns and drops that field; it never drops the record. */
const EVAL_KINDS = ['official_commission', 'bar_group', 'bar_poll', 'bar_committee'];
const VERDICTS = ['favorable', 'unfavorable', 'mixed', 'none'];
const pctOk = (v) => Number.isFinite(v) && v >= 0 && v <= 100;
const pct = (x) => (x && pctOk(x.yes_pct) ? { yes_pct: x.yes_pct, no_pct: pctOk(x.no_pct) ? x.no_pct : null, n: Number.isInteger(x.n) ? x.n : null } : null);
function evaluations(list, where) {
  if (list == null) return [];
  if (!Array.isArray(list)) { warn(`${where}: evaluations is not a list; dropped it`); return []; }
  const out = [];
  for (const e of list) {
    if (!e || !isStr(e.by) || !isStr(e.rating) || !VERDICTS.includes(e.verdict)) { warn(`${where}: an evaluation is missing by, rating or a valid verdict; dropped it`); continue; }
    const url = safeUrl(e.url);
    if (!url) { warn(`${where}: an evaluation by ${e.by} has no source URL; dropped it`); continue; }
    const sv = e.survey && typeof e.survey === 'object' ? {
      question: str(e.survey.question), attorneys: pct(e.survey.attorneys), non_attorneys: pct(e.survey.non_attorneys), judges: pct(e.survey.judges),
      report_url: safeUrl(e.survey.report_url), caution: str(e.survey.caution),
    } : null;
    out.push({
      by: e.by.trim(), by_short: str(e.by_short) || e.by.trim(),
      kind: EVAL_KINDS.includes(e.kind) ? e.kind : 'bar_group',
      rating: e.rating.trim(), verdict: e.verdict, vote: str(e.vote),
      survey: sv && (sv.attorneys || sv.non_attorneys || sv.judges) ? sv : null,
      vote_note: str(e.vote_note), survey_note: str(e.survey_note),
      noted_strength: str(e.noted_strength), noted_concern: str(e.noted_concern),
      url, verified_on: isDate(e.verified_on) ? e.verified_on : null, confidence: conf(e.confidence),
    });
  }
  return out;
}
const APPLIES = /^(ballot|section:(federal|state|judicial|county|city|school|special_district|measures)|item:\S+)$/;
function headsUp(list, where) {
  if (list == null) return [];
  if (!Array.isArray(list)) { warn(`${where}: heads_up is not a list; dropped it`); return []; }
  return list.filter((h) => {
    const ok = h && isStr(h.text) && isStr(h.applies_to) && APPLIES.test(h.applies_to.trim());
    if (!ok) warn(`${where}: a heads_up note has no text or a bad applies_to; dropped it`);
    return ok;
  }).map((h) => ({ text: h.text.trim(), applies_to: h.applies_to.trim(), source: safeUrl(h.source) }));
}
function districtFinders(list, where) {
  if (list == null) return [];
  if (!Array.isArray(list)) { warn(`${where}: district_finders is not a list; dropped it`); return []; }
  return list.filter((d) => {
    const ok = d && isStr(d.office_match) && isStr(d.label) && safeUrl(d.url);
    if (!ok) warn(`${where}: a district finder needs office_match, label and an https URL; dropped it`);
    return ok;
  }).map((d) => ({ office_match: d.office_match.trim(), label: d.label.trim(), url: safeUrl(d.url) }));
}
/* A place's own early-voting window, when its county runs a different one from the state's
   (Florida counties choose their own days inside the state's range). plan.ts prefers it. */
function placeEarly(x, where) {
  if (x == null) return null;
  const ok = x && typeof x === 'object' && isDate(x.start) && isDate(x.end) && x.start <= x.end && safeUrl(x.source);
  if (!ok) { warn(`${where}: early_in_person needs start and end dates (start first) and an https source; dropped it`); return null; }
  return { start: x.start, end: x.end, hours_note: str(x.hours_note), ...optional({ hours_short: helpShort(x.hours_short, `${where} early_in_person.hours_short`) }), lookup_url: safeUrl(x.lookup_url), source: safeUrl(x.source), confidence: conf(x.confidence) };
}
/* A place's own where-to-vote tools, when its county runs them; plan.ts prefers them over the
   state's statewide lookups. */
function placeLookups(x, where) {
  if (x == null) return null;
  if (typeof x !== 'object') { warn(`${where}: lookups is not an object; dropped it`); return null; }
  const out = {};
  for (const k of ['early_in_person', 'election_day', 'drop_box']) {
    if (x[k] == null) continue;
    const u = safeUrl(x[k]);
    if (u) out[k] = u; else warn(`${where}: lookups.${k} is not an http(s) URL; dropped it`);
  }
  return Object.keys(out).length ? out : null;
}
const optional = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length)));
/* Common questions as quick answers (Oct 20). Each situation may carry `short` (one plain line)
   and `actions` (up to 2 official links, {label, url}); each gotcha may be {text, short} instead
   of plain text. The bundle keeps `gotchas` as plain text and puts the short lines beside it in
   `gotcha_shorts`, in the same order. scripts/check-data.mjs holds the word limits and checks
   that every action URL comes from the state file. */
function helpShort(v, where) {
  if (v == null) return null;
  if (!isStr(v) || /\n/.test(v) || v.trim().length > 200) { warn(`${where}: short is not one plain line; dropped it`); return null; }
  return v.trim();
}
function helpActions(list, where) {
  if (list == null) return [];
  if (!Array.isArray(list)) { warn(`${where}: actions is not a list; dropped it`); return []; }
  const out = [];
  for (const a of list) {
    if (!a || !isStr(a.label) || !safeUrl(a.url)) { warn(`${where}: an action needs a label and an http(s) URL; dropped it`); continue; }
    if (out.length === 2) { warn(`${where}: more than 2 actions; dropped the rest`); break; }
    out.push({ label: a.label.trim(), url: safeUrl(a.url) });
  }
  return out;
}
function stateHelp(s, f) {
  if (Array.isArray(s.situations)) {
    s.situations = s.situations.map((x) => {
      if (!x || typeof x !== 'object') return x;
      const { short, actions, ...rest } = x;
      const where = `${f} situation ${x.id}`;
      return { ...rest, ...optional({ short: helpShort(short, where), actions: helpActions(actions, where) }) };
    });
  }
  if (Array.isArray(s.gotchas)) {
    const texts = [];
    const shorts = [];
    for (const g of s.gotchas) {
      if (isStr(g)) { texts.push(g); shorts.push(null); }
      else if (g && typeof g === 'object' && isStr(g.text)) { texts.push(g.text.trim()); shorts.push(helpShort(g.short, `${f} gotcha ${texts.length}`)); }
      else warn(`${f}: a gotcha has no text; dropped it`);
    }
    s.gotchas = texts;
    if (shorts.some(Boolean)) s.gotcha_shorts = shorts;
  }
  const reg = s.registration;
  for (const k of ['register_url', 'register_url_source']) {
    if (reg[k] == null) continue;
    const u = safeUrl(reg[k]);
    if (u) reg[k] = u; else { warn(`${f}: registration.${k} is not an http(s) URL; dropped it`); delete reg[k]; }
  }
  if (s.sample_ballot_url != null) {
    const u = safeUrl(s.sample_ballot_url);
    if (u) s.sample_ballot_url = u; else { warn(`${f}: sample_ballot_url is not an http(s) URL; dropped it`); delete s.sample_ballot_url; }
  }
}
function ownWordsChecked(x, where) {
  if (x == null) return null;
  if (typeof x !== 'object' || !isDate(x.on)) { warn(`${where}: own_words_checked needs an "on" date; dropped it`); return null; }
  return { on: x.on, where: Array.isArray(x.where) ? x.where.filter(isStr).map((w) => w.trim()) : [] };
}

/* ---------- file loading ---------- */
function listJson(dir) {
  const p = path.join(DATA, dir);
  if (!fs.existsSync(p)) return [];
  return fs.readdirSync(p).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(dir, f));
}
function readJson(rel, arrayKeys = []) {
  const full = path.join(DATA, rel);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(full, 'utf8')); }
  catch (e) { report.skippedFiles.push({ file: rel, why: `not valid JSON: ${e.message.slice(0, 120)}` }); return null; }
  if (Array.isArray(raw) || arrayKeys.length === 0) return raw;
  for (const k of arrayKeys) if (raw && Array.isArray(raw[k])) return raw[k];
  if (raw && typeof raw === 'object' && raw.id) return [raw];
  report.skippedFiles.push({ file: rel, why: 'expected an array of records' });
  return null;
}
const mtime = (rel) => { try { return fs.statSync(path.join(DATA, rel)).mtimeMs; } catch { return 0; } };

/* ---------- normalizers ---------- */
function partyList(p) {
  if (!isStr(p)) return [];
  return p.split(/\s*,\s*|\s*\/\s*/).map((x) => x.trim()).filter(Boolean)
    .map((x) => (/^democrat(ic)?$/i.test(x) ? 'Democratic' : /^republican$/i.test(x) ? 'Republican' : x));
}
function shortCand(name) {
  const first = name.split(' / ')[0].replace(/\s*\(.*?\)\s*/g, ' ').trim();
  const parts = first.replace(/,/g, '').split(/\s+/).filter((p) => !/^(jr\.?|sr\.?|ii|iii|iv)$/i.test(p));
  return parts.length ? parts[parts.length - 1] : first;
}
function normContest(c, file) {
  if (!c || !isStr(c.id)) return skipRec(file, c && c.id, 'contest missing id');
  if (!isStr(c.state)) return skipRec(file, c.id, 'contest missing state');
  if (!LEVELS.includes(c.level)) return skipRec(file, c.id, `contest has unknown level "${c.level}"`);
  if (!isStr(c.office)) return skipRec(file, c.id, 'contest missing office');
  if (!Array.isArray(c.candidates)) return skipRec(file, c.id, 'contest candidates is not a list');
  const cands = [];
  for (const k of c.candidates) {
    if (!k || !isStr(k.name)) { warn(`${file}: ${c.id} has a candidate with no name; dropped it`); continue; }
    cands.push({
      name: k.name.trim(),
      short: shortCand(k.name.trim()),
      party: str(k.party),
      parties: partyList(k.party),
      incumbent: !!k.incumbent,
      website: safeUrl(k.website),
      website_confidence: conf(k.website_confidence),
      background: str(k.background),
      // Research notes like "No statement collected yet" are not the candidate's words: drop them so
      // the card shows its empty state instead of a fake bullet under "In their own words".
      own_words: (Array.isArray(k.own_words) ? k.own_words : []).filter((o) => o && isStr(o.text))
        .map((o) => ({ text: o.is_quote === true ? o.text.trim() : stripNotes(o.text.trim()), is_quote: !!o.is_quote, source: safeUrl(o.source) }))
        .filter((o) => o.text.length > 0),
      lwv_status: str(k.lwv_status),
      lwv_url: safeUrl(k.lwv_url),
      // Optional fields are written only when present, so 3,000 candidates don't each carry empty keys.
      ...optional({
        own_words_status: k.own_words_status === 'none_found' ? 'none_found' : null,
        own_words_checked: ownWordsChecked(k.own_words_checked, `${file}: ${c.id}`),
        evaluations: evaluations(k.evaluations, `${file}: ${c.id} / ${k.name}`),
      }),
    });
  }
  const scope = str(c.scope_plain) || '';
  const voteFor = Number.isInteger(c.vote_for) && c.vote_for > 0 ? c.vote_for : 1;
  // Ranked choice only when the research says so, with the ballot's own "rank up to" number.
  const rcv = c.ranked_choice === true && !c.is_retention;
  let rankUpTo = null;
  if (rcv) {
    rankUpTo = Number.isInteger(c.rank_up_to) && c.rank_up_to >= 2 ? c.rank_up_to : null;
    if (!rankUpTo) { rankUpTo = Math.max(2, cands.length); warn(`${file}: ${c.id} is ranked choice with no usable rank_up_to; using ${rankUpTo}`); }
  }
  return {
    kind: 'contest',
    id: c.id.trim(),
    state: c.state.trim().toUpperCase(),
    level: c.level,
    office: c.office.trim(),
    district: str(c.district),
    scope_plain: scope,
    every: /^every\b/i.test(scope),
    office_explainer: str(c.office_explainer),
    why_it_matters: str(c.why_it_matters),
    vote_for: voteFor,
    ranked_choice: rcv,
    rank_up_to: rankUpTo,
    winners: Number.isInteger(c.winners) && c.winners > 0 ? c.winners : voteFor,
    rcv_how: rcv ? str(c.rcv_how) : null,
    rcv_url: rcv ? safeUrl(c.rcv_url) : null,
    incumbent: str(c.incumbent),
    open_seat: typeof c.open_seat === 'boolean' ? c.open_seat : null,
    term_years: typeof c.term_years === 'number' ? c.term_years : null,
    is_retention: !!c.is_retention,
    ...optional({ seat_label: str(c.seat_label) }),
    candidates: cands,
    sources: (Array.isArray(c.sources) ? c.sources : []).filter((s) => s && safeUrl(s.url)).map((s) => ({ name: str(s.name) || 'Source', url: safeUrl(s.url) })),
    confidence: conf(c.confidence),
  };
}
function normMeasure(m, file) {
  if (!m || !isStr(m.id)) return skipRec(file, m && m.id, 'measure missing id');
  if (!isStr(m.state)) return skipRec(file, m.id, 'measure missing state');
  if (!isStr(m.number)) return skipRec(file, m.id, 'measure missing number');
  if (!isStr(m.yes_means) || !isStr(m.no_means)) warn(`${file}: ${m.id} is missing yes_means or no_means`);
  const cas = (x) => (x && isStr(x.text) ? { text: x.text.trim(), source: safeUrl(x.source) } : null);
  return {
    kind: 'measure',
    id: m.id.trim(),
    state: m.state.trim().toUpperCase(),
    level: M_LEVELS.includes(m.level) ? m.level : 'state',
    jurisdiction: str(m.jurisdiction) || m.state,
    number: m.number.trim(),
    official_title: str(m.official_title),
    short_title: str(m.short_title),
    plain_summary: str(m.plain_summary),
    yes_means: str(m.yes_means),
    no_means: str(m.no_means),
    current_law: str(m.current_law),
    fiscal_impact: str(m.fiscal_impact),
    pass_threshold: str(m.pass_threshold),
    referred_by: str(m.referred_by),
    confusing_wording_note: str(m.confusing_wording_note),
    supporters_case: cas(m.supporters_case),
    opponents_case: cas(m.opponents_case),
    official_text_url: safeUrl(m.official_text_url),
    official_guide_url: safeUrl(m.official_guide_url),
    explainers: (Array.isArray(m.explainers) ? m.explainers : [])
      .filter((e) => e && isStr(e.source) && safeUrl(e.url))
      .slice(0, 3)
      .map((e) => ({ source: str(e.source), title: str(e.title), url: safeUrl(e.url) })),
    confidence: conf(m.confidence),
    links: [],
  };
}
function validState(s, file) {
  const need = [
    [isStr(s && s.state), 'state'],
    [isDate(s && s.election_date), 'election_date'],
    [s && s.official_site && safeUrl(s.official_site.url), 'official_site.url'],
    [s && s.registration && Array.isArray(s.registration.deadlines), 'registration.deadlines'],
    [s && s.mail_ballot && s.mail_ballot.return_deadline && isDate(s.mail_ballot.return_deadline.date), 'mail_ballot.return_deadline.date'],
    [s && s.election_day && isStr(s.election_day.polls_close), 'election_day.polls_close'],
    [s && s.in_the_booth, 'in_the_booth'],
  ];
  const miss = need.filter((n) => !n[0]).map((n) => n[1]);
  if (miss.length) { report.skippedFiles.push({ file, why: `state file missing ${miss.join(', ')}` }); return false; }
  return true;
}
function validPlace(p, file) {
  const miss = [];
  if (!isStr(p && p.id)) miss.push('id');
  if (!isStr(p && p.label)) miss.push('label');
  if (!isStr(p && p.state)) miss.push('state');
  if (!Array.isArray(p && p.zips)) miss.push('zips');
  if (!Array.isArray(p && p.contest_ids) && !Array.isArray(p && p.measure_ids)) miss.push('contest_ids');
  if (miss.length) { report.skippedFiles.push({ file, why: `place file missing ${miss.join(', ')}` }); return false; }
  return true;
}
function shortEndorser(name) {
  let s = name.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim().replace(/^The\s+/, '').replace(/\s+editorial boards?$/i, '')
    .replace(/\s+endorsements?$/i, '').replace(/League of Women Voters( of)?( the)?/i, 'LWV').trim();
  if (s.includes(' / ')) s = s.split(' / ')[0].trim();
  // No length cut: a cut chopped 98 names mid-phrase (four Planned Parenthood groups all read
  // "Planned Parenthood..."). The views wrap long names; the verdict column uses a shorter tag.
  return s.replace(/[,;:]$/, '');
}

/* ---------- load everything ---------- */
const contests = new Map();
const measures = new Map();
const statewideFileIds = new Map(); // ST -> Set(ids) from {st}-statewide files
const itemFile = new Map();

function addItem(map, item, file) {
  if (!item) return;
  if (map.has(item.id)) {
    const prev = itemFile.get(item.id);
    // A statewide file wins over a local one for the same id.
    if (/-statewide/.test(prev)) { warn(`${item.id} appears in ${prev} and ${file}; kept ${prev}`); return; }
    warn(`${item.id} appears in ${prev} and ${file}; kept ${file}`);
  }
  map.set(item.id, item);
  itemFile.set(item.id, file);
  const m = path.basename(file).match(/^([a-z]{2})-statewide/i);
  if (m) {
    const st = m[1].toUpperCase();
    if (!statewideFileIds.has(st)) statewideFileIds.set(st, new Set());
    statewideFileIds.get(st).add(item.id);
  }
}
for (const f of listJson('contests')) {
  const arr = readJson(f, ['contests']);
  if (!arr) continue;
  for (const c of arr) addItem(contests, normContest(c, f), f);
}
for (const f of listJson('measures')) {
  const arr = readJson(f, ['measures']);
  if (!arr) continue;
  for (const m of arr) addItem(measures, normMeasure(m, f), f);
}
const item = (id) => contests.get(id) || measures.get(id);

const states = new Map();
for (const f of listJson('states')) {
  const s = readJson(f);
  if (!s || !validState(s, f)) continue;
  s.state = s.state.toUpperCase();
  s.heads_up = headsUp(s.heads_up, f);
  stateHelp(s, f);
  if (s.judicial_review != null) {
    const jr = s.judicial_review;
    const ok = jr && typeof jr === 'object' && ['what_the_rating_means', 'who_reviews', 'how_judges_get_here'].some((k) => isStr(jr[k]));
    if (!ok) { warn(`${f}: judicial_review has none of what_the_rating_means, who_reviews, how_judges_get_here; dropped it`); s.judicial_review = null; }
    else {
      const keep = {};
      for (const k of ['how_judges_get_here', 'who_reviews', 'what_the_rating_means', 'what_it_doesnt_mean', 'to_keep_a_judge', 'history']) keep[k] = str(jr[k]);
      keep.read_one = jr.read_one && isStr(jr.read_one.label) && safeUrl(jr.read_one.url) ? { label: jr.read_one.label.trim(), url: safeUrl(jr.read_one.url) } : null;
      keep.sources = (Array.isArray(jr.sources) ? jr.sources : []).filter((x) => x && isStr(x.name) && safeUrl(x.url)).map((x) => ({ name: x.name.trim(), url: safeUrl(x.url) }));
      s.judicial_review = keep;
    }
  }
  states.set(s.state, s);
}

const places = new Map();
for (const f of listJson('places')) {
  const p = readJson(f);
  if (!p || !validPlace(p, f)) continue;
  const st = p.state.toUpperCase();
  if (!states.has(st)) { report.skippedFiles.push({ file: f, why: `no data/states/${st}.json, so this place can't show a plan` }); continue; }
  const ids = [...(p.contest_ids || []), ...(p.measure_ids || [])];
  const known = [];
  for (const id of ids) {
    if (item(id)) { if (!known.includes(id)) known.push(id); }
    else warn(`${f}: lists ${id}, which no contests or measures file defines; dropped it`);
  }
  places.set(p.id, {
    id: p.id, label: p.label.trim(), state: st,
    counties: Array.isArray(p.counties) ? p.counties.filter(isStr) : [],
    county_election_office: p.county_election_office && isStr(p.county_election_office.name) ? {
      name: p.county_election_office.name, url: safeUrl(p.county_election_office.url), phone: str(p.county_election_office.phone),
    } : null,
    sample_ballot_url: safeUrl(p.sample_ballot_url),
    zips: p.zips.map(String).filter((z) => /^\d{5}$/.test(z)),
    zip_caveats: str(p.zip_caveats),
    notes: str(p.notes),
    county_label: str(p.county_label),
    district_finders: districtFinders(p.district_finders, f),
    heads_up: headsUp(p.heads_up, f),
    ...optional({ early_in_person: placeEarly(p.early_in_person, f), lookups: placeLookups(p.lookups, f) }),
    order: known,
    file: f,
  });
}

/* ---------- endorsers ---------- */
const alias = (id) => CONFIG.endorserAliases[id] || id;
const endorserVersions = new Map(); // id -> [{rec, file}]
for (const f of listJson('').filter((x) => /^endorsers-.*\.json$/.test(path.basename(x)))) {
  const arr = readJson(f, ['endorsers']);
  if (!arr) continue;
  for (const e of arr) {
    if (!e || !isStr(e.id) || !isStr(e.name)) { skipRec(f, e && e.id, 'endorser missing id or name'); continue; }
    const id = alias(e.id.trim());
    if (!endorserVersions.has(id)) endorserVersions.set(id, []);
    endorserVersions.get(id).push({ rec: e, file: f, t: mtime(f) });
  }
}
const LEAN_WORD = { left: 'Left', lean_left: 'Lean left', neutral: 'Neutral', lean_right: 'Lean right', right: 'Right' };
const endorsers = new Map();
for (const [id, vers] of endorserVersions) {
  const leanCount = {};
  for (const v of vers) if (LEANS.includes(v.rec.lean)) leanCount[v.rec.lean] = (leanCount[v.rec.lean] || 0) + 1;
  const leanKeys = Object.keys(leanCount);
  let lean = null;
  if (leanKeys.length) {
    const max = Math.max(...Object.values(leanCount));
    const top = leanKeys.filter((k) => leanCount[k] === max);
    lean = top.length === 1 ? top[0] : vers.filter((v) => top.includes(v.rec.lean)).sort((a, b) => b.t - a.t)[0].rec.lean;
  }
  const newest = [...vers].sort((a, b) => b.t - a.t)[0].rec;
  const name = CONFIG.endorserNames[id] || (vers.find((v) => v.rec.id === id) || vers[0]).rec.name.trim();
  const type = str(newest.type) || 'other';
  const dataShort = vers.map((v) => v.rec.short).find(isStr);
  endorsers.set(id, {
    id, name, short: dataShort ? dataShort.trim() : shortEndorser(name), type,
    lean,
    lean_basis: str(newest.lean_basis),
    lean_note: leanKeys.length > 1 ? `Our research passes rated this source differently: ${leanKeys.map((k) => LEAN_WORD[k]).join(' and ')}. We show ${LEAN_WORD[lean]}.` : null,
    guide_url: safeUrl(newest.guide_url),
    // SCHEMA rule: publications and nonpartisan civic groups start on; everything else is opt-in.
    // A publication whose lean comes only from its own stated mission (Knock LA) is an advocate
    // and starts off with the groups (Kevin, Oct 20; src/model/lens.ts sidedByMission).
    default_on: (type === 'publication' && !(newest.lean_basis_kind === 'mission' && ['left', 'lean_left', 'lean_right', 'right'].includes(lean))) || type === 'civic_nonpartisan',
    endorses_candidates: vers.some((v) => v.rec.endorses_candidates === true),
    endorses_measures: vers.some((v) => v.rec.endorses_measures === true),
    // Which party a party organization speaks for ("Democratic", "Working Families"), and how its
    // lean is known. Both optional; the app falls back to reading the party out of the name.
    ...optional({
      party: type === 'party' || type === 'elected_official' ? str(newest.party) : null,
      lean_basis_kind: ['outside_rating', 'party', 'mission'].includes(newest.lean_basis_kind) ? newest.lean_basis_kind : null,
      // A paper whose endorsements sit behind a paywall we couldn't read (Kevin, Oct 19): picks we
      // only saw secondhand are taken out in the data, and the app shows a note inviting a
      // subscriber to send them. Only a literal true counts; `paywall_note_ok: false` hides the
      // note, and `paywall_note` overrides the app's wording for one source.
      paywall: vers.some((v) => v.rec.paywall === true) ? true : null,
      paywall_note_ok: vers.some((v) => v.rec.paywall === true) && newest.paywall_note_ok === false ? false : null,
      paywall_note: vers.some((v) => v.rec.paywall === true) ? str(newest.paywall_note) : null,
      // The places in its own `geography` (across every file that defines it), when it names any:
      // a regional source (the San Antonio Express-News, ["TX", "san-antonio-tx"]). The app reads
      // "not checked yet" on a district race only from sources whose places include the ballot's,
      // or that have none. A paper's places are its home even when it names its state too (it picks
      // statewide races from its city). A party or group that names its state speaks statewide, as
      // endorserHome below reads it (the Colorado Working Families Party, ["CO", "denver-co"]), so it
      // has none. Unknown place ids are dropped.
      home_places: (() => {
        const geo = vers.flatMap((v) => (Array.isArray(v.rec.geography) ? v.rec.geography : [])).filter(isStr).map((g) => g.trim());
        if (type !== 'publication' && geo.some((g) => /^[A-Z]{2}$/.test(g))) return null;
        return [...new Set(geo.filter((g) => places.has(g)))].sort();
      })(),
    }),
  });
}

/* ---------- endorsements ---------- */
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function nameTokens(n) {
  return norm(n.split(' / ')[0].replace(/\(.*?\)/g, ' ')).split(' ').filter((t) => t && !/^(jr|sr|ii|iii|iv)$/.test(t) && t.length > 1);
}
function matchCandidates(choice, contest) {
  const exact = contest.candidates.find((k) => k.name === choice);
  if (exact) return { names: [exact.name], note: null };
  const noteBits = [];
  const stripped = choice.replace(/\(([^)]*)\)/g, (_, x) => { noteBits.push(x.trim()); return ' '; }).trim();
  const parts = stripped.split(/\s+(?:and|or|&)\s+|\s*,\s*/i).map((p) => p.trim()).filter(Boolean);
  const names = [];
  for (const part of parts) {
    const pt = nameTokens(part);
    if (!pt.length) continue;
    const last = pt[pt.length - 1];
    let hits = contest.candidates.filter((k) => nameTokens(k.name).includes(last));
    if (hits.length > 1) hits = hits.filter((k) => nameTokens(k.name)[0] === pt[0]);
    if (hits.length === 1 && !names.includes(hits[0].name)) names.push(hits[0].name);
  }
  if (!names.length) return null;
  const isOr = /\s+or\s+/i.test(stripped);
  if (isOr) noteBits.push('either one');
  return { names, note: noteBits.join('; ') || null };
}
const ePrefer = { endorsed: 3, no_position: 2, not_found: 1 };
const endorsementByKey = new Map();
for (const f of listJson('').filter((x) => /^endorsements-.*\.json$/.test(path.basename(x)))) {
  const arr = readJson(f, ['endorsements']);
  if (!arr) continue;
  for (const r of arr) {
    if (!r || !isStr(r.endorser_id) || !isStr(r.target_id) || !STATUSES.includes(r.status)) { skipRec(f, r && `${r.endorser_id}->${r.target_id}`, 'endorsement missing endorser, target or a valid status'); continue; }
    const eid = alias(r.endorser_id.trim());
    const target = item(r.target_id.trim());
    if (!target) { skipRec(f, r.target_id, 'endorsement points at an unknown contest or measure'); continue; }
    if (!endorsers.has(eid)) { skipRec(f, eid, 'endorsement points at an unknown endorser'); continue; }
    let choices = null; let note = null;
    if (r.status === 'endorsed') {
      const raw = (r.choice || '').trim();
      if (target.kind === 'measure' || (target.is_retention && target.candidates.length <= 1)) {
        const up = raw.toUpperCase();
        if (/^(YES|FOR)\b/.test(up) && !/\bNO\b|AGAINST/.test(up.slice(3))) { choices = ['YES']; }
        else if (/^(NO|AGAINST)\b/.test(up)) { choices = ['NO']; }
        const m = raw.match(/\(([^)]*)\)/);
        if (m) note = m[1];
        if (!choices) note = raw || null;
        else if (/^yes,\s*and/i.test(raw)) note = note || raw;
      } else if (target.is_retention) {
        note = raw || null; // multi-judge retention: keep the source's words as-is
      } else {
        const m = raw ? matchCandidates(raw, target) : null;
        if (m) { choices = m.names; note = m.note; }
        else { note = raw || null; warn(`${f}: ${eid} on ${target.id}: couldn't match "${raw}" to a candidate; shown as text`); }
      }
    }
    const rec = {
      s: r.status, c: choices, note, why: str(r.why), url: safeUrl(r.url), date: str(r.date), conf: conf(r.confidence), f,
      // A "not found" whose record says the source's page couldn't be read (a paywall or an access
      // block): the app names a paywalled paper there by its paywall note, not "No endorsements
      // found". Only a literal true on a not_found row counts.
      ...(r.unreadable === true && r.status === 'not_found' ? { unreadable: true } : {}),
    };
    const key = `${eid}|${target.id}`;
    const prev = endorsementByKey.get(key);
    if (prev) {
      if (ePrefer[rec.s] < ePrefer[prev.s]) continue;
      // Same endorser, same file, different picks: an issue committee listing both campaigns (measure),
      // or a slate or ranked order (race).
      if (rec.s === 'endorsed' && prev.s === 'endorsed' && prev.f === f && rec.c && prev.c && JSON.stringify(rec.c) !== JSON.stringify(prev.c)) {
        prev.c = [...new Set([...prev.c, ...rec.c])];
        prev.why = [...new Set([prev.why, rec.why].filter(Boolean))].join(' ');
        // Both sides only makes sense for a measure. In a race, several rows from one file are a slate
        // (vote for 5) or a ranked order, so keep them in file order and don't call it both sides.
        if (target.kind === 'measure') prev.both = true;
        continue;
      }
      if (rec.s === 'endorsed' && prev.s === 'endorsed' && JSON.stringify(rec.c) !== JSON.stringify(prev.c)) warn(`${eid} on ${target.id}: two files disagree (${prev.c} vs ${rec.c}); kept ${f}`);
    }
    endorsementByKey.set(key, rec);
  }
}

/* ---------- linked (dueling) measures ---------- */
function linkGroups() {
  const groups = CONFIG.measureLinks.map((g) => g.filter((id) => measures.has(id)));
  const byNumber = new Map();
  for (const m of measures.values()) {
    const num = m.number.replace(/^(proposition|prop\.?|amendment|measure|question|initiative)\s+/i, '').trim().toUpperCase();
    byNumber.set(`${m.state}|${m.jurisdiction}|${num}`, m.id);
  }
  for (const m of measures.values()) {
    const text = [m.plain_summary, m.confusing_wording_note, m.current_law].filter(Boolean).join(' ');
    const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => /conflict|cancel|nullif|more yes votes/i.test(s));
    const found = new Set();
    for (const s of sentences) {
      for (const mm of s.matchAll(/\b(?:Prop(?:osition)?\.?|Amendment|Measure|Question|Initiative)\s+([A-Z0-9]{1,4})\b/g)) {
        const id = byNumber.get(`${m.state}|${m.jurisdiction}|${mm[1].toUpperCase()}`);
        if (id && id !== m.id) found.add(id);
      }
    }
    if (found.size) groups.push([m.id, ...found]);
  }
  // merge overlapping groups
  const merged = [];
  for (const g of groups) {
    const hit = merged.find((x) => g.some((id) => x.has(id)));
    if (hit) g.forEach((id) => hit.add(id)); else merged.push(new Set(g));
  }
  for (const set of merged) {
    if (set.size < 2) continue;
    for (const id of set) measures.get(id).links = [...set].filter((x) => x !== id);
  }
  return merged.filter((s) => s.size > 1).map((s) => [...s]);
}
report.linkedMeasures = linkGroups();

/* ---------- bundles ---------- */
/* Where a source speaks, from its own `geography` (state codes and/or place ids, across every
   file that defines it). A state code means statewide. A source with only place ids is local to
   those places: an Orlando county party's picks on Florida's statewide races belong on Orlando
   ballots, not on Tallahassee's or Pensacola's. A source with no geography counts as statewide. */
const endorserHome = new Map(); // eid -> null (statewide) | Set(placeIds)
for (const [id, vers] of endorserVersions) {
  const geo = vers.flatMap((v) => (Array.isArray(v.rec.geography) ? v.rec.geography : [])).filter(isStr).map((g) => g.trim());
  if (!geo.length || geo.some((g) => /^[A-Z]{2}$/.test(g))) { endorserHome.set(id, null); continue; }
  endorserHome.set(id, new Set(geo.filter((g) => places.has(g))));
}
const allStatewide = new Set([...statewideFileIds.values()].flatMap((s) => [...s]));
report.localSources = [...endorserHome].filter(([, h]) => h).length;
/* A bundle's rows: every row on its items, except that a local source's rows on statewide items go
   only to its home places' bundles (placeId), never to the state bundle. */
function bundleFor(ids, placeId = null) {
  const items = ids.map(item).filter(Boolean);
  const idSet = new Set(items.map((i) => i.id));
  const extra = placeId ? new Set((places.get(placeId)?.order || []).filter((id) => allStatewide.has(id))) : new Set();
  const ends = {};
  const used = new Set();
  for (const [key, rec] of endorsementByKey) {
    const [eid, tid] = key.split('|');
    const home = endorserHome.get(eid);
    if (idSet.has(tid)) { if (!placeId && home) continue; }
    else if (!(extra.has(tid) && home && home.has(placeId))) continue;
    const { f: _file, ...clean } = rec;
    (ends[tid] = ends[tid] || {})[eid] = clean;
    used.add(eid);
  }
  return { items, endorsements: ends, endorsers: [...used].map((id) => endorsers.get(id)) };
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const write = (name, obj) => { fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj)); return fs.statSync(path.join(OUT, name)).size; };

const index = { generated: report.generated, states: {}, places: {}, zips: {} };
const sizes = {};
for (const [st, s] of states) {
  const ids = [...(statewideFileIds.get(st) || [])];
  // keep file order: contests first then measures as they appear
  const ordered = [...contests.values(), ...measures.values()].filter((i) => ids.includes(i.id)).map((i) => i.id);
  const b = bundleFor(ordered);
  const bundle = { state: st, name: CONFIG.stateNames[st] || st, howto: s, order: ordered, ...b };
  sizes[`state-${st}.json`] = write(`state-${st}.json`, bundle);
  index.states[st] = {
    name: CONFIG.stateNames[st] || st,
    as_of: s.last_verified || null,
    election_date: s.election_date,
    official_site: s.official_site,
    places: [],
  };
}
for (const [id, p] of places) {
  const sw = statewideFileIds.get(p.state) || new Set();
  const local = p.order.filter((x) => !sw.has(x));
  const b = bundleFor(local, id);
  const bundle = { ...p, file: undefined, local, ...b };
  sizes[`place-${id}.json`] = write(`place-${id}.json`, bundle);
  index.places[id] = { label: p.label, state: p.state, counties: p.counties, local_count: local.length };
  index.states[p.state].places.push(id);
  for (const z of p.zips) {
    (index.zips[z] = index.zips[z] || []);
    if (!index.zips[z].includes(id)) index.zips[z].push(id);
  }
}
sizes['index.json'] = write('index.json', index);
// Optional: "Pass it on" ways to get involved and the texting study, from the data track.
if (fs.existsSync(path.join(DATA, 'get-involved.json'))) {
  const gi = readJson('get-involved.json');
  if (gi && typeof gi === 'object' && !Array.isArray(gi)) { sizes['get-involved.json'] = write('get-involved.json', gi); index.involved = true; write('index.json', index); }
  else warn('get-involved.json is not an object; skipped it');
}

report.counts = {
  states: states.size, places: places.size, contests: contests.size, measures: measures.size,
  endorsers: endorsers.size, endorsements: endorsementByKey.size, zips: Object.keys(index.zips).length,
};
report.sizes = sizes;
fs.writeFileSync(path.join(OUT, 'build-report.json'), JSON.stringify(report, null, 2));

/* ---------- console summary ---------- */
const kb = (n) => `${(n / 1024).toFixed(0)}KB`;
console.log(`build-data: ${Object.entries(report.counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
console.log(`  bundles: ${Object.entries(sizes).map(([k, v]) => `${k} ${kb(v)}`).join(', ')}`);
console.log(`  linked measures: ${report.linkedMeasures.map((g) => g.join(' + ')).join('; ') || 'none'}`);
if (report.skippedFiles.length) { console.log(`  SKIPPED FILES (${report.skippedFiles.length}):`); report.skippedFiles.forEach((s) => console.log(`    ${s.file}: ${s.why}`)); }
if (report.skippedRecords.length) console.log(`  skipped records: ${report.skippedRecords.length} (see public/data/build-report.json)`);
if (report.warnings.length) console.log(`  warnings: ${report.warnings.length} (see public/data/build-report.json)`);
if (states.size === 0) { console.error('build-data: no usable state files. Failing.'); process.exit(1); }
