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
 *   7  pick everything: cheat sheet and print sheet list every decision once, none blank
 * MODE=full repeats 3 and 6 for each district choice (every member of every group at least once).
 *
 * Screenshots go to SHOTS_DIR (default .tmp/sweep-shots, gitignored): the top of every ballot,
 * and the failing card for every failure. A CI run uploads that folder as an artifact.
 * Exit code 1 if anything fails. No dependencies beyond the repo's playwright.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PW_PATH || 'playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.BASE || 'http://localhost:4173').replace(/\/$/, '');
const ORIGIN = new URL(BASE).origin;
const MODE = process.env.MODE === 'full' ? 'full' : 'fast';
const WORKERS = Number(process.env.WORKERS || 4);
const TODAY = process.env.TODAY || '2026-10-16';
const W = 380;
const SHOTS = path.resolve(process.env.SHOTS_DIR || path.join(ROOT, '.tmp', 'sweep-shots'));
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || ''; // protected Vercel previews
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

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
  const groups = [...by].filter(([, m]) => m.length >= 2).map(([key, members]) => ({ key, members, sec: sectionOf(byId.get(members[0])) }));
  return { items, byId, groups, kinds: Object.fromEntries(items.map((i) => [i.id, kindOf(i)])) };
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
  return { visible, perSec, decisions, unanswered, barTotal: decisions.length + unanswered.length };
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
      order: [...s.querySelectorAll('[id^="i-"]')].map((e) => e.id.slice(2)),
    };
  });
  return {
    ids, dupIds: [...dupIds], over, sec, scrollWidth: document.documentElement.scrollWidth,
    qs: [...document.querySelectorAll('.q[data-q]')].map((q) => q.dataset.q),
    bar: (document.querySelector('.bar-txt') || {}).textContent?.trim() || '',
    barBtnDisabled: !!document.querySelector('[data-act="next"][disabled]'),
  };
};
/* The app ignores a click within 650ms of the last action (a touch guard), so programmatic taps
   dispatch the mouse pointerdown that fires an action immediately. Real touch taps are covered by e2e. */
const PRESS = `window.__press = (el) => el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));`;
const OPEN_UNOPP = () => { document.querySelectorAll('.unopp .disc[aria-expanded="false"]').forEach((b) => window.__press(b)); };
/* Pick one thing on every open card, by the kind of card it is. */
const PICK_ALL = () => {
  const log = [];
  for (let guard = 0; guard < 2000; guard++) {
    const card = document.querySelector('article.card-r[data-undecided]');
    if (!card) break;
    const id = card.dataset.item;
    const click = (sel) => { const b = card.querySelector(sel); if (b) window.__press(b); return !!b; };
    const before = card.outerHTML.length;
    let did = false;
    if (card.querySelector('[data-act="jpick"]')) { // each answer re-renders the card, so look it up again every time
      for (let i = 0; i < 100; i++) { const b = document.querySelector(`#i-${CSS.escape(id)} [data-act="jpick"][data-v="YES"][aria-pressed="false"]`); if (!b) break; window.__press(b); }
      did = true;
    }
    else if (card.querySelector('[data-act="rank"]')) {
      const max = Number((card.querySelector('.rank-panel .small:last-child')?.textContent.match(/of (\d+) ranked/) || [])[1] || 0);
      const n = card.querySelectorAll('[data-act="rank"]').length;
      for (let i = 0; i < Math.max(1, Math.min(max || n, n)); i++) { const c = document.querySelector(`#i-${CSS.escape(id)}`); const b = c && c.querySelector('[data-act="rank"][aria-pressed="false"]'); if (b) window.__press(b); }
      const d = document.querySelector(`#i-${CSS.escape(id)} [data-act="rdone"]`); if (d) window.__press(d);
      did = true;
    } else if (card.querySelector('[data-act="mpick"]')) {
      const seats = Number((card.textContent.match(/fills (\d+) seats/) || [])[1] || 1);
      for (let i = 0; i < seats; i++) { const c = document.querySelector(`#i-${CSS.escape(id)}`); const b = c && c.querySelector('[data-act="mpick"][aria-pressed="false"]'); if (b) window.__press(b); }
      const d = document.querySelector(`#i-${CSS.escape(id)} [data-act="mdone"]`); if (d) window.__press(d);
      did = true;
    } else did = click('[data-act="pick"]') || click('[data-act="skip"]');
    const after = document.querySelector(`#i-${CSS.escape(id)}`);
    if (!did || (after && after.hasAttribute('data-undecided') && after.outerHTML.length === before)) { log.push(`stuck:${id}`); card.removeAttribute('data-undecided'); card.setAttribute('data-stuck', ''); }
  }
  return log;
};
const CHEAT = () => {
  const rows = (root) => [...document.querySelectorAll(`${root} tbody tr:not(.cs-sec)`)].map((r) => ({ t: r.querySelector('th')?.textContent.trim(), v: (r.querySelector('td')?.innerText || '').replace(/\s+/g, ' ').trim() }));
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
    await page.locator('.browse .btn-text').first().click(); // "Or pick a place from the list"
    const sel = ballot.placeIds.length ? `[data-act="choose-place"][data-ids="${ballot.placeIds.join('+')}"]` : `[data-act="choose-state"][data-st="${ballot.st}"]`;
    await page.locator(sel).first().click();
  }
  await page.waitForSelector('#plan', { timeout: 20000 });
  await page.evaluate(() => Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 4000))])); // real font metrics, but never wait long
  await page.waitForTimeout(150);
  return { ctx, page };
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
    const total = s.decisions + s.questions;
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
const pressDistrict = (page, key, v) => page.locator(`.q[data-q="${key.replace(/"/g, '\\"')}"] [data-act="district"][data-v="${v}"]`).first().evaluate((e) => window.__press(e));
const pressChange = (page, key) => page.locator(`[data-act="district-change"][data-g="${key.replace(/"/g, '\\"')}"]`).first().evaluate((e) => window.__press(e));

async function sweepBallot(browser, ballot) {
  const t0 = Date.now();
  const R = { n: 0, fail: (b, w, d) => { R.n++; fail(b, w, d); } };
  const o = await oracle(ballot.st, ballot.placeIds);
  const { ctx, page } = await open(browser, ballot, R);

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
  const { ex } = await checkStructure(page, ballot, o, notSure, 'all districts', R);
  await page.screenshot({ path: path.join(SHOTS, `${ballot.name}.png`) });

  // Pick everything, then the cheat sheet and print sheet must list every decision once, none blank.
  const stuck = await page.evaluate(PICK_ALL);
  if (stuck.length) R.fail(ballot.name, 'could not pick on some cards', stuck.slice(0, 4).join(', '));
  await page.waitForTimeout(250);
  const cheat = await page.evaluate(CHEAT);
  if (cheat.screen.length !== ex.decisions.length) R.fail(ballot.name, 'cheat sheet row count', `want ${ex.decisions.length} got ${cheat.screen.length}`);
  const blank = cheat.screen.filter((r) => !r.v || /not decided/i.test(r.v) || /^_+$/.test(r.v));
  if (blank.length) R.fail(ballot.name, `${blank.length} cheat sheet rows are blank after picking everything`, blank.slice(0, 3).map((r) => r.t).join(' | '));
  const wantPrint = ex.decisions.length + ex.visible.filter((i) => o.kinds[i.id] === 'unopposed').length;
  if (cheat.print.length !== wantPrint) R.fail(ballot.name, 'print sheet row count', `want ${wantPrint} got ${cheat.print.length}`);
  const titles = cheat.screen.map((r) => r.t);
  // 2026-10-19: found by the first sweep. Two races with the same title leave the voter unable to tell the rows apart.
  if (new Set(titles).size !== titles.length) (process.env.STRICT ? R.fail : warn)(ballot.name, 'cheat sheet lists a title twice', titles.find((x, i) => titles.indexOf(x) !== i));
  const done = await page.evaluate(() => (document.querySelector('.bar-txt') || {}).textContent.trim());
  if (done !== `${ex.barTotal} of ${ex.barTotal} decided`) R.fail(ballot.name, 'progress bar after picking everything', done);

  if (page.errs.length) R.fail(ballot.name, 'console or network errors', page.errs.slice(0, 3).join(' | '));
  if (R.n) await page.screenshot({ path: path.join(SHOTS, `FAIL-${ballot.name}.png`) }).catch(() => {});
  await ctx.close();
  results.push({ name: ballot.name, items: o.items.length, groups: o.groups.length, ms: Date.now() - t0, failures: R.n });
  console.log(`${R.n ? 'FAIL' : 'ok  '}  ${ballot.name}  ${o.items.length} items, ${o.groups.length} district questions, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

/* ---------- plan the ballots ---------- */
const index = await getJSON('index.json');
const ballots = [];
for (const [st, s] of Object.entries(index.states)) ballots.push({ name: `state-${st}`, st, placeIds: [] });
for (const [id, p] of Object.entries(index.places)) ballots.push({ name: id, st: p.state, placeIds: [id] });
const combos = new Map();
for (const [zip, list] of Object.entries(index.zips)) if (list.length > 1 && !combos.has(list.join('+'))) combos.set(list.join('+'), zip);
for (const [key, zip] of combos) ballots.push({ name: `zip-${key}`, st: index.places[key.split('+')[0]].state, placeIds: key.split('+'), combo: true, zip });
const todo = ballots.filter((b) => !ONLY.length || ONLY.includes(b.name));
console.log(`sweep ${MODE}: ${todo.length} ballots (${Object.keys(index.states).length} state-only, ${Object.keys(index.places).length} places, ${combos.size} multi-place ZIPs) at ${W}px against ${BASE}`);

/* ---------- index sanity: every ZIP resolves to real places, every place has a ZIP ---------- */
for (const [zip, list] of Object.entries(index.zips)) {
  if (!/^\d{5}$/.test(zip)) fail('index', 'bad ZIP key', zip);
  for (const id of list) if (!index.places[id]) fail('index', `ZIP ${zip} points at unknown place`, id);
}
for (const id of Object.keys(index.places)) if (!Object.values(index.zips).some((l) => l.includes(id))) fail('index', `place has no ZIP`, id);

const browser = await chromium.launch();
const queue = [...todo];
await Promise.all(Array.from({ length: Math.min(WORKERS, queue.length) }, async () => {
  while (queue.length) {
    const b = queue.shift();
    try { await sweepBallot(browser, b); } catch (e) { fail(b.name, 'sweep crashed', e.message.split('\n')[0]); }
  }
}));
await browser.close();

fs.writeFileSync(path.join(SHOTS, 'sweep-report.json'), JSON.stringify({ mode: MODE, base: BASE, results, fails, warns }, null, 2));
console.log(`\nsweep: ${results.length} ballots swept, ${fails.length} failures, ${warns.length} warnings. Report and screenshots in ${path.relative(ROOT, SHOTS)}/`);
process.exit(fails.length ? 1 : 0);
