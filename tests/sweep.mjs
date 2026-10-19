#!/usr/bin/env node
/*
 * sweep: open EVERY ballot the guide can produce at 380px and check it against the data.
 *
 *   BASE=http://localhost:4173 node tests/sweep.mjs                 # fast: one pass per ballot
 *   MODE=full BASE=http://localhost:4173 node tests/sweep.mjs       # also every district variant
 *   BASE=https://voting-guide-<hash>.vercel.app node tests/sweep.mjs   # a Vercel preview
 *   ONLY=austin-tx,dc-ward-1 node tests/sweep.mjs                   # debug a few ballots
 *
 * A "ballot" is a state-only view (the "Elsewhere in the state" button), one view per place
 * (the browse list on the start screen), and one view per ZIP that spans several places
 * (the "I'm not sure" choice). The expected contents come from a small oracle in this file
 * that reads the same /data bundles the site loads, so a bug in src/ballot.ts is a
 * disagreement here, not a shared blind spot.
 *
 * Per ballot (all checks run in every mode):
 *   1  no console errors, page errors, or failed/4xx/5xx same-origin requests
 *   2  no sideways scroll at 380px (and the elements that overflow, when it fails)
 *   3  every item the oracle says is on the ballot renders exactly once, nothing extra
 *   4  no duplicate DOM ids anywhere
 *   5  district questions match the oracle's groups
 *   6  section counts, unopposed counts and the progress bar match the data
 *   7  make a choice on every decision row (opened, paged if needed), chosen here from the data (varied by race: different
 *      candidates, yes and no, skips, rankings with a reorder, mixed judge answers), then the
 *      cheat sheet and the print sheet must show every race, in order, each with exactly that
 *      choice: the pick and party, the marked seats, each rank, each judge's answer
 * MODE=full repeats 3 and 6 for each district choice (every member of every group at least once).
 *
 * The run fails, rather than passing quietly, when it would check nothing: WORKERS that is not
 * 1 to 16, an ONLY that names a ballot that does not exist, an index with no states, places or
 * ZIPs, or any planned ballot that did not finish. A ballot that crashes (its page never loaded,
 * say, on a stalled machine) gets one more try; a second crash fails, and a failed check is never retried.
 *
 * Each run writes to its own new folder, SHOTS_DIR/<time>-<mode>-<pid>/ (SHOTS_DIR defaults to
 * .tmp/sweep-shots and must be inside the repo's .tmp/): the top of every ballot, the failing
 * card for every failure, and sweep-report.json. Nothing is ever deleted except this script's
 * own files in its own older run folders (it keeps the newest 10). CI uploads SHOTS_DIR.
 * Exit code 1 if anything fails, 2 for bad settings. No dependencies beyond the repo's playwright.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PW_PATH || 'playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.BASE || 'http://localhost:4173').replace(/\/$/, '');
const ORIGIN = new URL(BASE).origin;
const MODE = process.env.MODE === 'full' ? 'full' : 'fast';
const TODAY = process.env.TODAY || '2026-10-16';
const W = 380;
const ONLY = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || ''; // protected Vercel previews
const stop = (msg) => { console.error(`sweep: ${msg}`); process.exit(2); };

// A run that checks nothing must not pass: no workers means no ballots opened.
const WORKERS = process.env.WORKERS === undefined || process.env.WORKERS === '' ? 4 : Number(process.env.WORKERS);
if (!Number.isInteger(WORKERS) || WORKERS < 1 || WORKERS > 16) stop(`WORKERS must be a whole number from 1 to 16, got "${process.env.WORKERS}".`);

// Output: a new folder per run, inside .tmp/. Never delete a folder someone named.
const TMP = path.join(ROOT, '.tmp');
const OUT_ROOT_ASKED = path.resolve(process.env.SHOTS_DIR || path.join(TMP, 'sweep-shots'));
if (!OUT_ROOT_ASKED.startsWith(TMP + path.sep)) stop(`SHOTS_DIR must be a folder inside ${TMP}/ (got ${OUT_ROOT_ASKED}). Each run makes its own subfolder there.`);
fs.mkdirSync(OUT_ROOT_ASKED, { recursive: true });
// Judge by real paths, so a symlink inside .tmp cannot lead the run, or the pruning below, outside it.
const REAL_TMP = fs.realpathSync(TMP);
const OUT_ROOT = fs.realpathSync(OUT_ROOT_ASKED);
if (!OUT_ROOT.startsWith(REAL_TMP + path.sep)) stop(`SHOTS_DIR ${OUT_ROOT_ASKED} leads to ${OUT_ROOT}, outside ${REAL_TMP}/ (a symlink?). Use a plain folder inside .tmp/.`);
const RUN_MARK = '.sweep-run';
const RUN_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(fast|full)-\d+$/;
const SHOTS = path.join(OUT_ROOT, `${new Date().toISOString().replace(/[:.]/g, '-')}-${MODE}-${process.pid}`);
fs.mkdirSync(SHOTS); // throws if it somehow exists: this run never writes into another run's folder
fs.writeFileSync(path.join(SHOTS, RUN_MARK), `sweep run ${new Date().toISOString()} ${MODE}\n`);
// Keep the newest 10 runs. A run folder counts only if it is a real folder (not a symlink), really
// sits right here, and holds this script's marker file. Remove only files this script writes, then the
// folder only if it is empty.
const isOwnRun = (n) => {
  if (!RUN_NAME.test(n)) return false;
  const dir = path.join(OUT_ROOT, n);
  try {
    const st = fs.lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() && fs.realpathSync(dir) === dir && fs.lstatSync(path.join(dir, RUN_MARK)).isFile();
  } catch { return false; }
};
for (const old of fs.readdirSync(OUT_ROOT).filter(isOwnRun).sort().slice(0, -10)) {
  const dir = path.join(OUT_ROOT, old);
  for (const f of fs.readdirSync(dir)) if ((f === RUN_MARK || f === 'sweep-report.json' || f.endsWith('.png')) && fs.lstatSync(path.join(dir, f)).isFile()) fs.rmSync(path.join(dir, f));
  try { fs.rmdirSync(dir); } catch { /* something else is in there: leave it */ }
}

/* ---------- data + oracle ---------- */
const hdrs = BYPASS ? { 'x-vercel-protection-bypass': BYPASS } : {};
const cache = new Map();
async function getJSON(p) {
  if (!cache.has(p)) cache.set(p, fetch(`${BASE}/data/${p}`, { headers: hdrs }).then((r) => { if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.json(); }));
  return cache.get(p);
}
const sectionOf = (it) => (it.kind === 'measure' ? 'measures' : it.level);
const kindOf = (it) => {
  if (it.kind === 'measure') return 'decision';
  if (it.candidates.length === 0) return 'info';
  if (!it.is_retention && it.candidates.length === 1) return 'unopposed';
  return 'decision';
};
/* Mirrors the documented rules (PROGRESS.md "Decisions made"), not the code in src/. */
async function oracle(st, placeIds) {
  const sb = await getJSON(`state-${st}.json`);
  const pbs = await Promise.all(placeIds.map((id) => getJSON(`place-${id}.json`)));
  const byId = new Map();
  sb.items.forEach((i) => byId.set(i.id, i));
  pbs.forEach((p) => p.items.forEach((i) => { if (!byId.has(i.id)) byId.set(i.id, i); }));
  const statewide = new Set(sb.order);
  const onlyIn = new Set();
  let ids;
  if (pbs.length) {
    const set = new Set();
    sb.order.forEach((id) => { const it = byId.get(id); if (it.kind === 'measure' || it.every) set.add(id); });
    pbs.forEach((p) => p.order.forEach((id) => { if (byId.has(id)) set.add(id); }));
    if (pbs.length > 1) for (const id of set) if (!statewide.has(id) && pbs.filter((p) => p.order.includes(id)).length < pbs.length) onlyIn.add(id);
    const swIdx = new Map(sb.order.map((id, i) => [id, i]));
    const idx = new Map();
    pbs.forEach((p) => p.order.forEach((id, i) => { if (!idx.has(id)) idx.set(id, i); }));
    ids = [...set].sort((a, b) => {
      const sa = statewide.has(a) ? 0 : 1, sbb = statewide.has(b) ? 0 : 1;
      return sa !== sbb ? sa - sbb : (sa === 0 ? swIdx.get(a) - swIdx.get(b) : (idx.get(a) ?? 9999) - (idx.get(b) ?? 9999));
    });
  } else ids = [...sb.order];
  const items = ids.map((id) => byId.get(id));
  const by = new Map();
  for (const it of items) if (it.kind === 'contest' && !it.every && !onlyIn.has(it.id)) by.set(`${it.level}|${it.office}`, [...(by.get(`${it.level}|${it.office}`) || []), it.id]);
  // Numbered seats (Place/Position/Seat N) sharing one scope are separate races every voter there
  // sees, not a district question (fixed 2026-10-19; Houston ISDs, Edgewood ISD, Tallahassee).
  const SEAT = /^(?:place|position|seat|post|no\.)\s*\d+\b/i;
  const scopeOf = (id) => (byId.get(id).scope_plain || '').trim().toLowerCase();
  const seats = (m) => m.every((id) => SEAT.test((byId.get(id).district || '').trim())) && m.every((id) => scopeOf(id) && scopeOf(id) === scopeOf(m[0]));
  const groups = [...by].filter(([, m]) => m.length >= 2 && !seats(m)).map(([key, members]) => ({ key, members, sec: sectionOf(byId.get(members[0])) }));
  const here = pbs.flatMap((p) => [p.label, ...p.counties]).map((x) => x.replace(/\s*\(.*\)$/, '').replace(/\s+County$/i, '').toLowerCase());
  return { items, byId, groups, kinds: Object.fromEntries(items.map((i) => [i.id, kindOf(i)])), titles: sheetTitles(items, here) };
}
/* What should be on screen for a set of district answers (group key -> member id or '*'). */
function expected(o, answers) {
  const hidden = new Set();
  const unanswered = [];
  for (const g of o.groups) {
    const a = answers[g.key];
    if (a === undefined) { unanswered.push(g); g.members.forEach((m) => hidden.add(m)); }
    else if (a !== '*') g.members.filter((m) => m !== a).forEach((m) => hidden.add(m));
  }
  const visible = o.items.filter((i) => !hidden.has(i.id));
  const perSec = {};
  for (const it of visible) {
    const s = (perSec[sectionOf(it)] ||= { decisions: 0, unopposed: 0, questions: 0 });
    if (o.kinds[it.id] === 'decision') s.decisions++;
    if (o.kinds[it.id] === 'unopposed') s.unopposed++;
  }
  for (const g of unanswered) (perSec[g.sec] ||= { decisions: 0, unopposed: 0, questions: 0 }).questions++;
  const decisions = visible.filter((i) => o.kinds[i.id] === 'decision');
  // The bar and the section counts count choices; a district question is setup, not a choice.
  return { visible, perSec, decisions, unanswered, barTotal: decisions.length };
}

/* ---------- the choices this sweep makes, and what the cheat sheet must then say ----------
   The choice for each race comes from the data and a hash of its id, so it is the same every run
   but not always "the first candidate" or "yes": a cheat sheet that shows the wrong candidate, a
   stale answer, one judge's answer on another judge, or a ranking out of order cannot pass. */
const hashStr = (s) => { let h = 2166136261; for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
const squash = (s) => String(s).replace(/\s+/g, ' ').trim();
function planFor(ex) {
  const plan = {};
  for (const it of ex.decisions) {
    const h = hashStr(it.id);
    if (it.kind === 'measure' || (it.is_retention && it.candidates.length === 1)) { plan[it.id] = h % 11 === 0 ? { t: 'skip' } : { t: 'pick', v: h % 2 ? 'NO' : 'YES' }; continue; }
    const names = it.candidates.map((c) => c.name);
    const rot = [...names.slice(h % names.length), ...names.slice(0, h % names.length)];
    if (it.is_retention) plan[it.id] = { t: 'judges', answers: names.map((n, j) => [n, (h + j) % 2 ? 'NO' : 'YES']) };
    else if (it.ranked_choice) {
      // Rank all the ballot allows, or one short of it (then "Done ranking"), then move the last one up.
      const max = Math.min(it.rank_up_to || names.length, names.length);
      const order = rot.slice(0, max > 2 ? max - 1 : max);
      const up = order.length >= 2 ? order[order.length - 1] : null;
      const final = up ? [...order.slice(0, -2), up, order[order.length - 2]] : order;
      plan[it.id] = { t: 'rank', order, up, final };
    } else if (it.vote_for > 1) plan[it.id] = { t: 'seats', names: rot.slice(0, Math.min(it.vote_for, names.length)) };
    else plan[it.id] = { t: 'pick', v: rot[0] };
  }
  return plan;
}
/* Cheat-sheet titles: the documented rule in src/model/labels.ts (cheatTitle), written again here
   so a bug there is a disagreement, not a shared blind spot. If the rule changes on purpose,
   change it here too. Measures: the number, plus the place for a short local number. Judges: the
   court and the judge. Races: the office (quiet parentheses dropped) and a seat label from the
   district, unless that only names this ballot's own county or place. Titles that still repeat on
   one ballot get the county from their scope, else "(1 of 2)". */
const QUIET_PAREN = /\s*\((?:non-?partisan|partisan|countywide|municipal court district|retention|unexpired term|[A-Z]{2,6})\)/gi;
const cleanOffice = (o) => o.replace(QUIET_PAREN, '').replace(/\s+judges? retention$/i, ' judges').replace(/\s{2,}/g, ' ').trim();
function courtOf(c) {
  const o = c.office.trim();
  const colon = o.match(/^(.*?):\s*(?:retain\b|.*continuance in office)/i);
  if (colon) return colon[1].trim();
  if (/\bjudge retention$/i.test(o)) {
    const base = o.replace(/\s*judges? retention$/i, '').trim();
    const d = (c.district || '').trim();
    return d && !/county court$/i.test(d) ? `${base}, ${d}` : d || base;
  }
  return cleanOffice(o.replace(/\s*\(retention\)\s*$/i, ''));
}
function seatLabel(c, here) {
  if (c.seat_label) return c.seat_label;
  let d = (c.district || '').trim();
  if (!d || /^your\b/i.test(d)) return null;
  let extra = '';
  const paren = d.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (paren) { d = paren[1].trim(); if (/county|term\b/i.test(paren[2]) && paren[2].length <= 28) extra = paren[2].trim(); }
  d = d.split(':')[0].trim();
  d = d.replace(/^(?:CD|SD|HD|AD|LD|[A-Z]{2})-\s*(\d+[A-Z]?)\b\s*/, (_m, n) => `District ${n} `).trim();
  d = d.replace(/^(District \d+[A-Z]?) (Position \d+)/, '$1, $2');
  if (d.length > 40) d = d.split(',')[0].trim();
  if (!d) return null;
  if (c.office.toLowerCase().includes(d.toLowerCase())) return extra || null;
  if (!extra && here.includes(d.replace(/\s+County( Court)?$/i, '').toLowerCase()) && !/court/i.test(d)) return null;
  return extra ? `${d}, ${extra}` : d;
}
const jurisdictionShort = (m) => m.jurisdiction.replace(/\s*\([^)]*\)/g, '').replace(/\.\s.*$/, '').split(':')[0].trim();
function baseTitle(it, here) {
  if (it.kind === 'measure') {
    const n = it.number.trim();
    const jur = jurisdictionShort(it);
    return it.level !== 'state' && jur && !n.toLowerCase().includes(jur.split(' ')[0].toLowerCase()) && n.length <= 24 ? `${n} (${jur})` : n;
  }
  if (it.is_retention && it.candidates.length === 1) return `${courtOf(it)}: ${it.candidates[0].name}`;
  if (it.is_retention) return `${courtOf(it)}, ${it.candidates.length} judges`;
  const seat = seatLabel(it, here);
  return seat ? `${cleanOffice(it.office)}, ${seat}` : cleanOffice(it.office);
}
function sheetTitles(items, here) {
  const out = new Map();
  const by = new Map();
  for (const it of items) { const t = baseTitle(it, here); out.set(it.id, t); by.set(t, [...(by.get(t) || []), it]); }
  for (const [t, list] of by) {
    if (list.length < 2) continue;
    const county = (it) => { const m = ((it.kind === 'measure' ? it.jurisdiction : it.scope_plain) || '').match(/\b([A-Z][a-zA-Z.]+(?: [A-Z][a-zA-Z.]+)?) County\b/); return m ? `${m[1]} County` : null; };
    const extra = list.map((it) => county(it) || (it.kind === 'measure' ? jurisdictionShort(it) : null));
    const distinct = new Set(extra).size === list.length && extra.every(Boolean);
    list.forEach((it, i) => out.set(it.id, distinct ? `${t} (${extra[i]})` : `${t} (${i + 1} of ${list.length})`));
  }
  return out;
}
function wantRow(it, kind, p, titles) {
  const row = { t: squash(titles.get(it.id)), v: '', ranks: [], judges: [] };
  if (kind === 'unopposed') row.v = squash(`${it.candidates[0].name} (unopposed)`);
  else if (!p) row.v = '(the sweep made no choice here)';
  else if (p.t === 'skip') row.v = 'Left blank';
  else if (it.kind === 'measure') row.v = p.v === 'YES' ? 'Yes' : 'No';
  else if (p.t === 'pick' && it.is_retention) row.v = p.v === 'YES' ? 'Yes, keep' : 'No, remove';
  else if (p.t === 'pick') { const c = it.candidates.find((k) => k.name === p.v); row.v = squash(`${c.name}${c.party ? ` (${c.party})` : ''}`); }
  else if (p.t === 'seats') row.v = squash(it.candidates.filter((c) => p.names.includes(c.name)).map((c) => c.name).join(', '));
  else if (p.t === 'judges') {
    const yes = p.answers.filter(([, v]) => v === 'YES').length;
    row.v = `Yes on ${yes}, No on ${p.answers.length - yes}`;
    row.judges = p.answers.map(([n, v]) => squash(`${n}: ${v === 'YES' ? 'Yes' : 'No'}`));
  } else if (p.t === 'rank') row.ranks = p.final.map((n, i) => squash(`${ordinal(i + 1)} ${n}`));
  return row;
}
/* Every row the sheet should have, in ballot order: sections in the order the page shows them,
   items in ballot order within each. The screen sheet lists decisions; print adds unopposed races. */
function wantSheet(o, ex, plan, secOrder, forPrint) {
  const bySec = new Map();
  for (const it of ex.visible) {
    const k = o.kinds[it.id];
    if (k === 'info' || (k === 'unopposed' && !forPrint)) continue;
    if (!bySec.has(sectionOf(it))) bySec.set(sectionOf(it), []);
    bySec.get(sectionOf(it)).push(wantRow(it, k, plan[it.id], o.titles));
  }
  return [...secOrder, ...[...bySec.keys()].filter((s) => !secOrder.includes(s))].flatMap((s) => bySec.get(s) || []);
}
function compareSheet(R, where, label, got, want) {
  const show = (r) => `${r.t}: ${r.ranks.length ? r.ranks.join(', ') : r.v}${r.judges.length ? ` [${r.judges.join('; ')}]` : ''}`;
  const diffs = [];
  for (let i = 0; i < Math.max(got.length, want.length); i++) {
    const g = got[i], w = want[i];
    const same = g && w && !g.blank && g.t === w.t && g.v === w.v && g.ranks.join('\n') === w.ranks.join('\n') && g.judges.join('\n') === w.judges.join('\n');
    if (!same) diffs.push(`row ${i + 1}: want "${w ? show(w) : '(no row)'}" got "${g ? show(g) + (g.blank ? ' (blank)' : '') : '(no row)'}"`);
  }
  if (got.length !== want.length) R.fail(where, `${label} has ${got.length} rows, the picks need ${want.length}`);
  if (diffs.length) R.fail(where, `${label}: ${diffs.length} rows do not show the race and choice made`, diffs.slice(0, 3).join(' | '));
}

/* ---------- in-page snapshots and actions ---------- */
const SNAPSHOT = (w) => {
  const ids = [...document.querySelectorAll('[id^="i-"]')].map((e) => e.id.slice(2));
  const all = [...document.querySelectorAll('[id]')].map((e) => e.id);
  const seen = new Set(), dupIds = new Set();
  for (const x of all) (seen.has(x) ? dupIds.add(x) : seen.add(x));
  const over = [...document.querySelectorAll('body *')].filter((e) => e.getClientRects().length && e.getBoundingClientRect().right > w + 1 && !e.closest('[data-keep]'))
    .slice(0, 5).map((e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}.${String(e.className).slice(0, 30)} right=${Math.round(e.getBoundingClientRect().right)}`);
  const sec = {};
  document.querySelectorAll('.sec').forEach((s) => {
    const u = s.querySelector('.unopp .disc');
    sec[s.dataset.sec] = {
      count: (s.querySelector('.sec-count') || {}).textContent?.trim() || '',
      unopp: u ? Number((u.textContent.match(/^(\d+) unopposed/) || [])[1] || -1) : 0,
      // Rows inside the "other school districts" fold list where the fold sits, so they are
      // checked for presence, not for place in the section's order.
      order: [...s.querySelectorAll('[id^="i-"]:not([data-fold])')].map((e) => e.id.slice(2)),
    };
  });
  return {
    ids, dupIds: [...dupIds], over, sec, scrollWidth: document.documentElement.scrollWidth,
    qs: [...document.querySelectorAll('.row[data-q]')].map((q) => q.dataset.q),
    bar: (document.querySelector('.bar-txt') || {}).textContent?.replace(/\s+/g, ' ').trim() || '',
    barBtnDisabled: !!document.querySelector('[data-act="next"][disabled]'),
  };
};
/* The app ignores a click within 650ms of the last action (a touch guard), so programmatic taps
   dispatch the mouse pointerdown that fires an action immediately. Real touch taps are covered by e2e. */
const PRESS = `window.__press = (el) => el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));`;
/* Unopposed lists and long court groups start folded; open every one (each tap re-renders its section). */
const OPEN_UNOPP = () => {
  for (let i = 0; i < 400; i++) {
    const b = document.querySelector('.unopp .disc[aria-expanded="false"], [data-act="grp"][aria-expanded="false"]');
    if (!b) break;
    window.__press(b);
  }
};
/* Carry out the sweep's plan on every decision row: open the row, then press the button that names
   each choice, paging the candidate grid when the choice is on another page (the ledger shows three
   at a time). Each press re-renders the row, so every button is looked up again. Returns what went wrong. */
const PICK_PLAN = (plan) => {
  const log = [];
  const card = (id) => document.getElementById(`i-${id}`);
  const open = (id) => { const c = card(id); if (c && !c.classList.contains('is-open')) window.__press(c.querySelector('[data-act="row"]')); };
  const find = (id, act, pred) => {
    for (let page = 0; page < 4; page++) {
      open(id);
      const c = card(id);
      const hit = c && [...c.querySelectorAll(`[data-act="${act}"]`)].find(pred);
      if (hit) return hit;
      // Write-in candidates fold into one line; open it and look again.
      const wi = c && c.querySelector('.wi-fold [data-act="open"][aria-expanded="false"]');
      if (wi) { window.__press(wi); page--; continue; }
      const pager = c && c.querySelector('[data-act="page"]');
      if (!pager) return null;
      window.__press(pager);
    }
    return null;
  };
  for (const [id, p] of Object.entries(plan)) {
    if (!card(id)) { log.push(`no card for ${id}`); continue; }
    if (!card(id).hasAttribute('data-undecided')) log.push(`${id} was already decided before the sweep chose anything`);
    open(id);
    const press = (b, what) => { if (b) window.__press(b); else log.push(`${id}: no button to ${what}`); };
    if (p.t === 'skip') press(find(id, 'skip', () => true), 'skip');
    else if (p.t === 'pick') press(find(id, 'pick', (b) => b.dataset.v === p.v), `pick "${p.v}"`);
    else if (p.t === 'judges') for (const [n, v] of p.answers) press(find(id, 'jpick', (b) => b.dataset.k === `${id}|${n}` && b.dataset.v === v), `answer ${v} on ${n}`);
    else if (p.t === 'seats') {
      for (const n of p.names) press(find(id, 'mpick', (b) => b.dataset.v === n), `mark "${n}"`);
      const d = find(id, 'mdone', () => true); if (d) window.__press(d);
    } else if (p.t === 'rank') {
      for (const n of p.order) press(find(id, 'rank', (b) => b.dataset.v === n && b.getAttribute('aria-pressed') === 'false'), `rank "${n}"`);
      if (p.up) press(find(id, 'rup', (b) => b.dataset.v === p.up), `move "${p.up}" up`);
      const d = find(id, 'rdone', () => true); if (d) window.__press(d);
    }
    if (card(id) && card(id).hasAttribute('data-undecided')) log.push(`${id} is still undecided after the sweep's choices`);
  }
  const left = [...document.querySelectorAll('.row[data-item][data-undecided]')].map((c) => c.dataset.item).filter((x) => !(x in plan));
  if (left.length) log.push(`open cards the data does not count as decisions: ${left.slice(0, 4).join(', ')}`);
  return log;
};
/* Both sheets, row by row: the race title, the chosen value, and any ranks or per-judge answers.
   Read from text nodes, not innerText, so the hidden print sheet reads the same as the screen one. */
const CHEAT = () => {
  const own = (el) => (el ? [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('') : '').replace(/\s+/g, ' ').trim();
  const rows = (root) => [...document.querySelectorAll(`${root} tbody tr:not(.cs-sec)`)].map((r) => {
    const td = r.querySelector('td');
    return {
      t: own(r.querySelector('th')),
      v: own(td),
      blank: !td || td.classList.contains('undecided') || !!td.querySelector('.screen-only, .print-only'),
      ranks: [...(td ? td.querySelectorAll('ol.cs-ranks > li') : [])].map((li) => `${((li.querySelector('.cs-rk') || {}).textContent || '?').trim()} ${own(li)}`.replace(/\s+/g, ' ').trim()),
      judges: [...(td ? td.querySelectorAll('ul.cs-judges > li') : [])].map((li) => `${own(li)} ${((li.querySelector('strong') || {}).textContent || '').trim()}`.replace(/\s+/g, ' ').trim()),
    };
  });
  return { screen: rows('#cheat'), print: rows('#r-print') };
};

/* ---------- one ballot ---------- */
const results = [];
const fails = [];
/* Known gaps are reported as WARN until someone fixes them, then move to fail() so they cannot come back.
   STRICT=1 makes every warning fail the run. Keep this list short and dated. */
const warns = [];
function warn(ballot, what, detail = '') { warns.push({ ballot, what, detail }); console.log(`WARN  ${ballot}: ${what}${detail ? `  (${detail})` : ''}`); }
function fail(ballot, what, detail = '') { fails.push({ ballot, what, detail }); console.log(`FAIL  ${ballot}: ${what}${detail ? `  (${detail})` : ''}`); }
async function open(browser, ballot, R) {
  const ctx = await browser.newContext({ viewport: { width: W, height: 820 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
  try {
    if (BYPASS) await ctx.route((u) => u.origin === ORIGIN, (route) => route.continue({ headers: { ...route.request().headers(), 'x-vercel-protection-bypass': BYPASS } }));
    const page = await ctx.newPage();
    await page.addInitScript(PRESS);
    page.errs = [];
    // Only our own origin counts. A slow Google Fonts request is not a bug in the guide.
    page.on('console', (m) => { if (m.type() === 'error' && (!m.location().url || m.location().url.startsWith(ORIGIN))) page.errs.push(`console: ${m.text().slice(0, 160)}`); });
    page.on('pageerror', (e) => page.errs.push(`pageerror: ${e.message.slice(0, 160)}`));
    page.on('requestfailed', (r) => { if (r.url().startsWith(ORIGIN)) page.errs.push(`requestfailed: ${r.url()}`); });
    page.on('response', (r) => { if (r.url().startsWith(ORIGIN) && r.status() >= 400) page.errs.push(`HTTP ${r.status()}: ${r.url()}`); });
    await page.goto(`${BASE}/?today=${TODAY}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#zip');
    if (ballot.combo) { // a multi-place ZIP only exists behind the ZIP box
      await page.fill('#zip', ballot.zip);
      await page.locator('button[type=submit]').click();
      await page.locator(`[data-act="choose-place"][data-ids="${ballot.placeIds.join('+')}"]`).click();
    } else {
      await page.locator('[data-fk="browse"]').click(); // "Or pick a place from the list"
      const sel = ballot.placeIds.length ? `[data-act="choose-place"][data-ids="${ballot.placeIds.join('+')}"]` : `[data-act="choose-state"][data-st="${ballot.st}"]`;
      await page.locator(sel).first().click();
    }
    await page.waitForSelector('#plan', { timeout: 20000 });
    await page.evaluate(() => Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 4000))])); // real font metrics, but never wait long
    await page.waitForTimeout(150);
    return { ctx, page };
  } catch (e) { await ctx.close().catch(() => {}); throw e; } // a failed open must not leave a browser context behind
}

async function checkStructure(page, ballot, o, answers, label, R) {
  const ex = expected(o, answers);
  await page.evaluate(OPEN_UNOPP);
  const snap = await page.evaluate(SNAPSHOT, W);
  const where = `${ballot.name}${label ? ' / ' + label : ''}`;
  const want = new Set(ex.visible.map((i) => i.id));
  const got = new Set(snap.ids);
  const missing = [...want].filter((x) => !got.has(x));
  const extra = [...got].filter((x) => !want.has(x));
  if (missing.length) R.fail(where, `${missing.length} items on the ballot are not rendered`, missing.slice(0, 4).join(', '));
  if (extra.length) R.fail(where, `${extra.length} items render that should not`, extra.slice(0, 4).join(', '));
  if (snap.ids.length !== got.size) R.fail(where, 'an item renders more than once', snap.ids.filter((x, i) => snap.ids.indexOf(x) !== i).slice(0, 4).join(', '));
  if (snap.dupIds.length) R.fail(where, 'duplicate DOM ids', snap.dupIds.slice(0, 4).join(', '));
  if (snap.scrollWidth > W) R.fail(where, `sideways scroll (${snap.scrollWidth}px)`, snap.over.join(' | '));
  const wantQ = ex.unanswered.map((g) => g.key).sort().join('|'), gotQ = [...snap.qs].sort().join('|');
  if (wantQ !== gotQ) R.fail(where, 'district questions differ from the oracle', `want ${wantQ || 'none'} got ${gotQ || 'none'}`);
  for (const [sec, s] of Object.entries(ex.perSec)) {
    const total = s.decisions;
    const wantCount = total ? `0 of ${total} decided` : s.unopposed ? 'Nothing to decide' : '';
    const d = snap.sec[sec];
    if (!d) { if (s.decisions || s.unopposed || s.questions) R.fail(where, `section ${sec} is missing`); continue; }
    if (d.count !== wantCount) R.fail(where, `section ${sec} count`, `want "${wantCount}" got "${d.count}"`);
    if (d.unopp !== s.unopposed) R.fail(where, `section ${sec} unopposed count`, `want ${s.unopposed} got ${d.unopp}`);
  }
  const wantBar = `0 of ${ex.barTotal} decided`;
  if (snap.bar !== wantBar) R.fail(where, 'progress bar', `want "${wantBar}" got "${snap.bar}"`);
  // Ballot order within each section follows the oracle (statewide first, then the place's order).
  // Unopposed races fold into one list at the end of their section, so they sort last.
  const wantOrder = {};
  [...ex.visible.filter((i) => o.kinds[i.id] !== 'unopposed'), ...ex.visible.filter((i) => o.kinds[i.id] === 'unopposed')]
    .forEach((i) => (wantOrder[sectionOf(i)] ||= []).push(i.id));
  for (const [sec, d] of Object.entries(snap.sec)) {
    const w = (wantOrder[sec] || []).filter((x) => d.order.includes(x));
    const g = d.order.filter((x) => w.includes(x));
    if (w.join() !== g.join()) R.fail(where, `section ${sec} order`, `first difference near ${w.find((x, i) => x !== g[i])}`);
  }
  return { ex, snap };
}
/* A district question is a row: open it, then answer. */
const pressDistrict = async (page, key, v) => {
  const sel = `.row[data-q="${key.replace(/"/g, '\\"')}"]`;
  await page.locator(sel).first().evaluate((r) => { if (!r.classList.contains('is-open')) window.__press(r.querySelector('[data-act="row"]')); });
  await page.locator(`${sel} [data-act="district"][data-v="${v}"]`).first().evaluate((e) => window.__press(e));
};
const pressChange = (page, key) => page.locator(`[data-act="district-change"][data-g="${key.replace(/"/g, '\\"')}"]`).first().evaluate((e) => window.__press(e));

async function sweepBallot(browser, ballot) {
  const t0 = Date.now();
  const R = { n: 0, fail: (b, w, d) => { R.n++; fail(b, w, d); } };
  const o = await oracle(ballot.st, ballot.placeIds);
  const { ctx, page } = await open(browser, ballot, R);
  try {

    // MODE=full first, while nothing is picked: every member of every district group at least once,
    // one variant per index. The same page is reused; "Change" reopens a question.
    if (MODE === 'full' && o.groups.length) {
      const maxN = Math.max(...o.groups.map((g) => g.members.length));
      for (let k = 0; k < maxN; k++) {
        const answers = Object.fromEntries(o.groups.map((g) => [g.key, g.members[k % g.members.length]]));
        for (const g of o.groups) {
          if (k > 0) await pressChange(page, g.key);
          await pressDistrict(page, g.key, answers[g.key]);
        }
        await page.waitForTimeout(100);
        await checkStructure(page, ballot, o, answers, `district variant ${k + 1}/${maxN}`, R);
      }
      for (const g of o.groups) await pressChange(page, g.key);
    }

    // Variant "I'm not sure": every candidate race shows once, each marked "May apply".
    const notSure = Object.fromEntries(o.groups.map((g) => [g.key, '*']));
    for (const g of o.groups) await pressDistrict(page, g.key, '*');
    await page.waitForTimeout(200);
    const { ex, snap } = await checkStructure(page, ballot, o, notSure, 'all districts', R);
    await page.screenshot({ path: path.join(SHOTS, `${ballot.name}.png`) });

    // Make the planned choice on every decision. Then both sheets must show each race, in order,
    // with exactly that choice.
    const plan = planFor(ex);
    const problems = await page.evaluate(PICK_PLAN, plan);
    if (problems.length) R.fail(ballot.name, `${problems.length} problems making the planned choices`, problems.slice(0, 4).join(' | '));
    await page.waitForTimeout(150);
    const done = await page.evaluate(() => (document.querySelector('.bar-txt') || {}).textContent.replace(/\s+/g, ' ').trim());
    if (done !== `${ex.barTotal} of ${ex.barTotal} decided`) R.fail(ballot.name, 'progress bar after picking everything', done);
    // The cheat sheet is its own view in the ledger (with the print sheet rendered beside it).
    await page.locator('[data-act="cheat"]').first().evaluate((e) => window.__press(e));
    await page.waitForSelector('#cheat', { timeout: 5000 });
    // The sheets render just after the last tap paints. Wait (up to 5 s, for a busy machine) until neither
  // shows anything undecided; a row that stays blank is then reported by the comparison below.
  await page.waitForFunction(() => !document.querySelector('#cheat td.undecided, #r-print td.undecided, #cheat td .screen-only, #r-print td .screen-only'), null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(100);
    const cheat = await page.evaluate(CHEAT);
    const secOrder = Object.keys(snap.sec);
    compareSheet(R, ballot.name, 'cheat sheet (screen)', cheat.screen, wantSheet(o, ex, plan, secOrder, false));
    compareSheet(R, ballot.name, 'print sheet', cheat.print, wantSheet(o, ex, plan, secOrder, true));
    const titles = cheat.screen.map((r) => r.t);
    // 2026-10-19: found by the first sweep. Two races with the same title leave the voter unable to tell the rows apart.
    // Seat labels made every title unique on 2026-10-19, so a repeat is now a failure.
    if (new Set(titles).size !== titles.length) R.fail(ballot.name, 'cheat sheet lists a title twice', titles.find((x, i) => titles.indexOf(x) !== i));

    if (page.errs.length) R.fail(ballot.name, 'console or network errors', page.errs.slice(0, 3).join(' | '));
    if (R.n) await page.screenshot({ path: path.join(SHOTS, `FAIL-${ballot.name}.png`) }).catch(() => {});
  } finally { await ctx.close().catch(() => {}); }
  results.push({ name: ballot.name, items: o.items.length, groups: o.groups.length, ms: Date.now() - t0, failures: R.n });
  console.log(`${R.n ? 'FAIL' : 'ok  '}  ${ballot.name}  ${o.items.length} items, ${o.groups.length} district questions, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

/* ---------- plan the ballots ---------- */
const index = await getJSON('index.json');
const states = index && typeof index.states === 'object' && index.states ? index.states : {};
const places = index && typeof index.places === 'object' && index.places ? index.places : {};
const zips = index && typeof index.zips === 'object' && index.zips ? index.zips : {};
const ballots = [];
for (const st of Object.keys(states)) ballots.push({ name: `state-${st}`, st, placeIds: [] });
for (const [id, p] of Object.entries(places)) ballots.push({ name: id, st: p.state, placeIds: [id] });
const combos = new Map();
for (const [zip, list] of Object.entries(zips)) if (Array.isArray(list) && list.length > 1 && !combos.has(list.join('+'))) combos.set(list.join('+'), zip);
for (const [key, zip] of combos) ballots.push({ name: `zip-${key}`, st: (places[key.split('+')[0]] || {}).state, placeIds: key.split('+'), combo: true, zip });
const unknown = ONLY.filter((n) => !ballots.some((b) => b.name === n));
if (unknown.length) stop(`ONLY names ballots that do not exist: ${unknown.join(', ')}. Names look like state-TX, austin-tx, ${[...combos.keys()][0] ? `zip-${[...combos.keys()][0]}` : 'zip-a+b'}.`);
const todo = ballots.filter((b) => !ONLY.length || ONLY.includes(b.name));
console.log(`sweep ${MODE}: ${todo.length} ballots (${Object.keys(states).length} state-only, ${Object.keys(places).length} places, ${combos.size} multi-place ZIPs) at ${W}px against ${BASE}, ${WORKERS} workers`);

/* ---------- index sanity: there is something to check, every ZIP resolves to real places, every place has a ZIP ---------- */
if (!Object.keys(states).length) fail('index', 'index.json lists no states');
if (!Object.keys(places).length) fail('index', 'index.json lists no places');
if (!Object.keys(zips).length) fail('index', 'index.json lists no ZIPs');
if (!todo.length) fail('sweep', 'no ballots to sweep');
for (const [zip, list] of Object.entries(zips)) {
  if (!/^\d{5}$/.test(zip)) fail('index', 'bad ZIP key', zip);
  if (!Array.isArray(list) || !list.length) { fail('index', `ZIP ${zip} lists no places`); continue; }
  for (const id of list) if (!places[id]) fail('index', `ZIP ${zip} points at unknown place`, id);
}
for (const id of Object.keys(places)) if (!Object.values(zips).some((l) => Array.isArray(l) && l.includes(id))) fail('index', `place has no ZIP`, id);

const browser = await chromium.launch();
const queue = [...todo];
await Promise.all(Array.from({ length: Math.min(WORKERS, queue.length) }, async () => {
  while (queue.length) {
    const b = queue.shift();
    // A crash means the ballot could not be checked (a page that never loaded, a stalled machine), so it
    // gets one more try. A failed check is never retried, and a second crash fails the run.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try { await sweepBallot(browser, b); break; } catch (e) {
        const why = e.message.split('\n')[0];
        if (attempt === 1) warn(b.name, 'crashed, trying once more', why); else fail(b.name, 'sweep crashed twice', why);
      }
    }
  }
}));
await browser.close();

// Every planned ballot must have finished its checks. A crash, a lost worker or a skipped ballot is a failure.
const finished = new Set(results.map((r) => r.name));
const unfinished = todo.filter((b) => !finished.has(b.name)).map((b) => b.name);
if (unfinished.length) fail('sweep', `${unfinished.length} of ${todo.length} planned ballots did not finish`, unfinished.slice(0, 6).join(', '));

fs.writeFileSync(path.join(SHOTS, 'sweep-report.json'), JSON.stringify({ mode: MODE, base: BASE, planned: todo.map((b) => b.name), results, fails, warns }, null, 2));
console.log(`\nsweep: ${results.length} of ${todo.length} planned ballots swept, ${fails.length} failures, ${warns.length} warnings. Report and screenshots in ${path.relative(ROOT, SHOTS)}/`);
process.exit(fails.length || results.length !== todo.length || !todo.length ? 1 : 0);
