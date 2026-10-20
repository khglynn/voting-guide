/* End-to-end pass at 380px, using the repo's own playwright (npm ci, then npx playwright install chromium).
   BASE=http://localhost:4173 node tests/e2e.mjs        (vite preview must be running)
   BASE=https://<deploy>.vercel.app node tests/e2e.mjs  (a Vercel preview or production)
   SHOTS_DIR=...   where screenshots go (default .tmp/e2e-shots, gitignored; shots/ holds the committed reference set)
   VERCEL_AUTOMATION_BYPASS_SECRET=...  only if Deployment Protection is on for the deployment under test
   Exits non-zero on any failed check or console error.

   Rewritten Oct 19 2026 for the ledger. The model contracts (link formats, restore results,
   rank order, district filtering, bulk fills) are also checked without a browser in
   tests/model.mjs; this file checks that the screens and taps carry them. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PW_PATH || 'playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.resolve(process.env.SHOTS_DIR || path.join(ROOT, '.tmp', 'e2e-shots'));
fs.mkdirSync(SHOTS, { recursive: true });
const BASE = (process.env.BASE || 'http://localhost:4173').replace(/\/$/, '');
const TODAY = process.env.TODAY || '2026-10-19';
const W = 380;
const BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '';
/* The copy pass (Oct 19): the sources header's words and the paywall note's, from the copy table. */
const LENS_HEAD = 'Show endorsements from';
const PW_NOTE_RE = /behind a paywall, so we couldn’t read/i;

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok, extra }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); };

const browser = await chromium.launch();
async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: W, height: 820 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, ...opts });
  // The bypass header goes only to the site under test, never to fonts or the Census lookup.
  if (BYPASS) await ctx.route((u) => u.origin === new URL(BASE).origin, (route) => route.continue({ headers: { ...route.request().headers(), 'x-vercel-protection-bypass': BYPASS } }));
  const page = await ctx.newPage();
  page.errors = [];
  // Only our own origin counts: a slow Google Fonts request is not a bug in the guide.
  page.on('console', (m) => { if (m.type() === 'error' && (!m.location().url || m.location().url.startsWith(new URL(BASE).origin))) page.errors.push(m.text()); });
  page.on('pageerror', (e) => page.errors.push(e.message));
  return { ctx, page };
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const tap = async (page, sel) => { const l = page.locator(sel).first(); await l.scrollIntoViewIfNeeded(); await l.tap(); await page.waitForTimeout(140); };
async function openZip(page, zip, query = '') {
  await page.goto(`${BASE}/?today=${TODAY}${query}`);
  await page.fill('#zip', zip);
  await page.locator('button[type=submit]').tap();
}
/* A ballot this device has nothing for opens on step 2 ("Pick by endorsements or party") first;
   "Show my ballot", with both switches off, shows the ballot as it always was. */
async function throughSetup(page) {
  await page.waitForSelector('#plan, [data-act="setup-done"]', { timeout: 15000 });
  if (await page.$('[data-act="setup-done"]')) await tap(page, '[data-act="setup-done"]');
  await page.waitForSelector('#plan', { timeout: 15000 });
}
async function openBallot(page, zip, query = '') {
  await openZip(page, zip, query);
  await throughSetup(page);
  await page.waitForTimeout(150);
}
const linkHere = (url) => url.replace(/^https?:\/\/[^/]+/, BASE).replace('/#', `/?today=${TODAY}#`);
const text = async (page, sel) => ((await page.textContent(sel).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
/* Open a row (an item id, or "q:<group key>") by tapping its header. */
async function openRow(page, id) {
  const sel = id.startsWith('q:') ? `.row[data-q="${id.slice(2)}"]` : `#i-${id}`;
  if (!(await page.$(`${sel}.is-open`))) await tap(page, `${sel} > [data-act="row"]`);
}
/* A finished section folds to one band; tap it to open it again. */
async function unfold(page, sec) {
  if (await page.$(`#sec-${sec}.folded`)) await tap(page, `#sec-${sec} [data-act="sec"]`);
}
/* No visible block in the plan strip runs past about 40 words. */
async function planWalls(page) {
  return page.evaluate(() => {
    const out = [];
    document.querySelectorAll('#plan p, #plan li').forEach((el) => {
      if (!el.getClientRects().length) return;
      const n = el.innerText.trim().split(/\s+/).filter(Boolean).length;
      if (n > 40) out.push(`${n}w: ${el.innerText.trim().slice(0, 60)}`);
    });
    return out;
  });
}
/* Kevin: no all caps. Nothing visible may use text-transform: uppercase. */
async function upperCased(page) {
  return page.evaluate(() => [...document.querySelectorAll('body *')]
    .filter((el) => el.getClientRects().length && getComputedStyle(el).textTransform === 'uppercase' && el.textContent.trim())
    .map((el) => `${el.tagName.toLowerCase()}.${el.className}: ${el.textContent.trim().slice(0, 30)}`).slice(0, 5));
}
const noSideScroll = async (page, label) => {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  check(`${label}: no sideways page scroll at ${W}px`, w <= W, `scrollWidth ${w}`);
};
const noErrors = (page, label) => check(`${label}: no console errors`, page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
const small44 = (page, scope) => page.$$eval(`${scope} button`, (els) => els.filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.height && r.height < 43.5; }).map((e) => `${e.dataset.act || e.className}:${Math.round(e.getBoundingClientRect().height)}`));

/* ---------- the front door ---------- */
{
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/?today=${TODAY}`);
  await page.waitForSelector('#zip');
  await shot(page, '00-start');
  await page.fill('#zip', '802');
  await page.locator('button[type=submit]').tap();
  check('Start: a short ZIP says what is wrong', /5 digits/.test(await text(page, '.zip-err')));
  await noSideScroll(page, 'Start');
  noErrors(page, 'Start');
  await ctx.close();
}

/* ---------- the first page (flow, Oct 20): step 1, step 2, and Back ---------- */
const SETUP = '[data-act="setup-done"]';
const savedVG = (page) => page.evaluate(() => localStorage.getItem('vg2'));
{
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/?today=${TODAY}`);
  await page.waitForSelector('#zip');
  await page.evaluate(() => document.fonts.ready);
  await shot(page, '00b-first-page');
  check('First page: the kicker says voting is underway, with Election Day from the data', (await text(page, '.front .dateline')) === 'Voting is underway in every state. Election Day is Tue, Nov 3.', await text(page, '.front .dateline'));
  check('First page: the headline is Kevin’s line', (await text(page, '.front h1')) === 'Quickly make your voting plan.');
  const ticks = await page.$$eval('.ticks li', (els) => els.map((e) => e.textContent.trim()));
  check('First page: three ticked lines', ticks.join('|') === 'Plain English|Full local details|Pick by endorsements or party', ticks.join('|'));
  check('First page: step 1 asks where you vote, with Next', (await text(page, 'label[for="zip"]')) === '1Where do you vote?' && (await text(page, 'form[data-form="zip"] button[type=submit]')) === 'Next', await text(page, 'label[for="zip"]'));
  check('First page: "Use my street address instead"', (await text(page, '.front [data-act="addr-open"]')) === 'Use my street address instead');
  const fine = await page.$$eval('.front > .fine', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  const cities = new Set(Object.entries(await page.evaluate(() => fetch('/data/index.json').then((r) => r.json()).then((i) => i.places))).map(([id, p]) => (p.state === 'DC' ? 'DC' : /^nyc-/.test(id) ? 'NYC' : id))).size;
  check('First page: the small print counts cities from the index (DC and NYC count once)', fine[0] === `Covers ${cities} cities where Kevin’s friends live. Ask for yours`, `${fine[0]} (index says ${cities})`);
  check('First page: the credit line, with no coffee link until there is one', fine[1] === 'Made by Kevin · kevinhg.com' && (await page.getAttribute('.front > .fine a[href="https://kevinhg.com"]', 'href')) === 'https://kevinhg.com', fine[1]);
  await page.fill('#zip', '02139');
  const ask = new URL(await page.getAttribute('a[data-ask]', 'href'));
  check('First page: Ask for yours opens the report form with "Please add my city" and the ZIP in the box', ask.host === 'docs.google.com' && ask.searchParams.get('entry.90887649') === 'Please add my city' && ask.searchParams.get('entry.628621310') === '02139', ask.search);
  check('First page: nothing in all caps', (await upperCased(page)).length === 0);
  await noSideScroll(page, 'First page');
  await tap(page, '[data-fk="browse"]');
  check('First page: the city count opens the list of places', (await page.$$('.browse-list [data-act="choose-place"]')).length > 30);
  await tap(page, '[data-fk="browse"]');

  // A fresh ZIP: step 2, papers on, no party, both switches off, nothing saved yet.
  await page.fill('#zip', '78704');
  await page.locator('button[type=submit]').tap();
  await page.waitForSelector(SETUP, { timeout: 15000 });
  await shot(page, '00c-step-2');
  check('Step 2: a fresh ZIP shows step 2, not the ballot', !(await page.$('#plan')) && !(await page.$('.foot')) && !(await page.$('#zip')));
  check('Step 2: the place line names the place and ZIP, with Change', (await text(page, '.su-done span')) === 'Austin, Texas · 78704' && !!(await page.$('.su-done [data-act="change-place"]')), await text(page, '.su-done'));
  check('Step 2: "Pick by endorsements or party"', (await text(page, '#su-h')) === '2Pick by endorsements or party');
  check('Step 2: Newspapers and guides is on and no party is chosen', (await page.getAttribute(`#setup [data-act="chip"][data-k="papers"]`, 'aria-pressed')) === 'true' && (await text(page, '#setup [data-fk="chip-party"]')) === 'A party' && (await page.getAttribute('#setup [data-fk="chip-party"]', 'aria-pressed')) !== 'true');
  check('Step 2: both switches start off', (await page.getAttribute('[data-act="setup-fill"]', 'aria-checked')) === 'false' && (await page.getAttribute('[data-act="setup-only"]', 'aria-checked')) === 'false');
  check('Step 2: "Picks in N of your M races."', /^Picks in \d+ of your \d+ races\.$/.test(await text(page, '.su-cov')), await text(page, '.su-cov'));
  check('Step 2: the fill switch says how many races they agree on', /^\d+ races? where they agree( \(\d+ from just one source\))?\. Skips the ones where they split\.$/.test(await text(page, '[data-act="setup-fill"] small')), await text(page, '[data-act="setup-fill"] small'));
  check('Step 2: nothing is saved before "Show my ballot"', (await savedVG(page)) === null);
  // The counts repaint in place: coverage, or the fill line when the new sources pick only in
  // races already covered (Austin's progressive groups).
  const cov1 = `${await text(page, '.su-cov')} | ${await text(page, '[data-act="setup-fill"] small')}`;
  await tap(page, '#setup [data-act="chip"][data-k="progressive"]');
  const cov2 = `${await text(page, '.su-cov')} | ${await text(page, '[data-act="setup-fill"] small')}`;
  check('Step 2: a chip changes the counts in place', (await page.getAttribute('#setup [data-act="chip"][data-k="progressive"]', 'aria-pressed')) === 'true' && cov2 !== cov1, `${cov1} -> ${cov2}`);
  await tap(page, '#setup [data-act="chip"][data-k="progressive"]');
  await tap(page, '#setup [data-fk="chip-party"]');
  check('Step 2: "A party" opens the party list right there, not a sheet', (await page.$$('#setup [data-act="party-set"]')).length >= 2 && !(await page.$('.sheet-panel')));
  await tap(page, '#setup [data-act="party-set"][data-p="Republican"]');
  check('Step 2: with a party, the fill line counts its candidates first', /^\d+ from the Republican Party, \d+ more where your sources agree\.$/.test(await text(page, '[data-act="setup-fill"] small')) && (await text(page, '#setup [data-fk="chip-party"]')) === 'Republican Party', await text(page, '[data-act="setup-fill"] small'));
  await tap(page, '#setup [data-act="party-off"]');
  check('Step 2: tapping the party again turns it off', (await text(page, '#setup [data-fk="chip-party"]')) === 'A party');
  check('Step 2: nothing in all caps', (await upperCased(page)).length === 0);
  await noSideScroll(page, 'Step 2');

  // Back after a ZIP returns to the first page, with the ZIP still in the box.
  await page.goBack();
  await page.waitForSelector('#zip');
  check('Back from step 2: returns to the first page, ZIP still in the box', !(await page.$(SETUP)) && (await page.inputValue('#zip')) === '78704');
  check('Back from step 2: still nothing saved', (await savedVG(page)) === null);
  await page.locator('button[type=submit]').tap();
  await page.waitForSelector(SETUP, { timeout: 15000 });
  await tap(page, SETUP);
  await page.waitForSelector('#plan', { timeout: 15000 });
  check('Step 2: "Show my ballot" shows the ballot, nothing filled', !!(await page.$('#plan')) && /^0 of \d+ decided$/.test(await text(page, '.bar-txt')) && !(await page.$('.toast:not([hidden])')), await text(page, '.bar-txt'));
  check('Step 2: the ballot is saved once it shows', /austin-tx/.test((await savedVG(page)) || ''));
  check('How this guide works: names the source for "Voting is underway in every state"', /“Voting is underway in every state”: Center for Election Innovation & Research\./.test(await text(page, '#how')) && !!(await page.$('#how a[href="https://electioninnovation.org/research/dates-for-2026-early-in-person-and-mail-voting/"]')));
  await page.goBack();
  await page.waitForSelector('#zip');
  check('Back from the ballot: returns to the first page', !(await page.$('#plan')) && !(await page.$('.foot')) && (await page.inputValue('#zip')) === '78704');
  await page.locator('button[type=submit]').tap();
  await page.waitForSelector('#plan, [data-act="setup-done"]', { timeout: 15000 });
  check('The same ZIP again: a ballot finished on this device skips step 2', !!(await page.$('#plan')) && !(await page.$(SETUP)));
  noErrors(page, 'First page');
  await ctx.close();
}
{
  // "Change" (step 2's place line, the ballot's masthead) goes back the way Back does, so the first
  // page never sits in history twice and one more Back leaves the site.
  const { ctx, page } = await newPage();
  await openZip(page, '78704');
  await page.waitForSelector(SETUP, { timeout: 15000 });
  const depth = await page.evaluate(() => history.length);
  await tap(page, '.su-done [data-act="change-place"]');
  await page.waitForSelector('#zip');
  check('Change on step 2: back to the first page, ZIP still in the box', !(await page.$(SETUP)) && (await page.inputValue('#zip')) === '78704' && (await page.evaluate(() => history.state && history.state.vg)) === 'start');
  await page.locator('button[type=submit]').tap();
  await throughSetup(page);
  await tap(page, '.mast [data-act="change-place"]');
  await page.waitForSelector('#zip');
  await page.locator('button[type=submit]').tap();
  await page.waitForSelector('#plan', { timeout: 15000 });
  check('Change: the first page is in history once, however often you change', (await page.evaluate(() => history.length)) === depth, `${depth} then ${await page.evaluate(() => history.length)}`);
  noErrors(page, 'Change');
  await ctx.close();
}
{
  // The fill switch fills, Undo undoes; then a reload, a save link and ?try all skip step 2.
  const { ctx, page } = await newPage();
  await openZip(page, '78704');
  await page.waitForSelector(SETUP, { timeout: 15000 });
  await tap(page, '[data-act="setup-fill"]');
  const n = Number(((await text(page, '[data-act="setup-fill"] small')).match(/^(\d+)/) || [])[1] || 0);
  check('Step 2: the fill switch turns on', (await page.getAttribute('[data-act="setup-fill"]', 'aria-checked')) === 'true' && n > 0, String(n));
  await tap(page, '[data-act="setup-only"]');
  await tap(page, SETUP);
  await page.waitForSelector('#plan', { timeout: 15000 });
  const bar = await text(page, '.bar-txt');
  const t = await text(page, '.toast');
  check('Step 2 fill: "Show my ballot" fills the races where your sources agree', bar.startsWith(`${n} of `), `${bar} (switch said ${n})`);
  check('Step 2 fill: one toast says so, with Undo', new RegExp(`^Filled ${n} picks? where your sources agree\\.`).test(t) && !!(await page.$('.toast [data-act="undo-bulk"]')), t);
  check('Step 2: "Show only what’s left" turns the filter on, so no decided row shows', (await page.getAttribute('[data-act="only"]', 'aria-pressed')) === 'true' && !(await page.$('.ledger .row[data-item]:not([data-undecided])')));
  await tap(page, '.toast [data-act="undo-bulk"]');
  check('Step 2 fill: Undo takes every filled pick back', /^0 of /.test(await text(page, '.bar-txt')), await text(page, '.bar-txt'));
  await page.reload();
  await page.waitForSelector('#plan, [data-act="setup-done"]', { timeout: 15000 });
  check('Reload: the ballot opens straight away, no step 2', !!(await page.$('#plan')) && !(await page.$(SETUP)));
  await tap(page, '[data-act="cheat"]');
  await tap(page, '[data-act="save-open"]');
  const link = await page.inputValue('.save-url');
  const fresh = await newPage();
  await fresh.page.goto(linkHere(link));
  await fresh.page.waitForSelector('#plan, [data-act="setup-done"]', { timeout: 15000 });
  check('Save link: a fresh device opens the ballot, no step 2', !!(await fresh.page.$('#plan')) && !(await fresh.page.$(SETUP)));
  noErrors(fresh.page, 'Save link skips step 2');
  await fresh.ctx.close();
  const demo = await newPage();
  await openZip(demo.page, '78704', '&try=fresh');
  await demo.page.waitForSelector('#plan, [data-act="setup-done"]', { timeout: 15000 });
  check('Try as: ?try skips step 2', !!(await demo.page.$('#plan')) && !(await demo.page.$(SETUP)));
  noErrors(demo.page, 'Try as skips step 2');
  await demo.ctx.close();
  noErrors(page, 'Step 2 fill');
  await ctx.close();
}

/* ---------- Denver 80205: the plan strip, the lens, rows, picks, fills, the save link ---------- */
{
  const { ctx, page } = await newPage();
  await openBallot(page, '80205');
  await shot(page, '01-denver-top');
  await noSideScroll(page, 'Denver');
  check('Denver: masthead names the place and offers a way out', /Denver/.test(await text(page, '.place')) && /Not your ballot\? Change/.test(await text(page, '.where')));
  const head = await text(page, '.plan-h');
  check('Denver: plan strip leads with the next step and its date, never a countdown', /^Mail your ballot by Mon, Oct 26\.$/.test(head) && !/days? (left|until)/i.test(await text(page, '#plan')), head);
  check('Denver: plan paragraphs stay under 40 words', (await planWalls(page)).length === 0, (await planWalls(page)).join(' | '));
  check('Denver: "Am I registered?" goes to the official lookup', /^https?:/.test((await page.getAttribute('.plan .pbtn.line', 'href')) || ''));
  check('Denver: nothing in all caps', (await upperCased(page)).length === 0, (await upperCased(page)).join(' | '));
  await tap(page, '[data-act="open"][data-k="whatif"]');
  check('Denver: the dates and ID toggle opens the situations and the basics', /Common problems and what to do/.test(await text(page, '.whatifs')) && /In the booth/.test(await text(page, '.whatifs')));
  await tap(page, '[data-act="open"][data-k="whatif"]');

  // The lens: Newspapers and guides on by default; a chip adds groups; the sheet lists everyone.
  // The copy pass (Kevin, Oct 19): the section header says what it does, not "Who do you trust?".
  check(`Denver: the sources header reads "${LENS_HEAD}"`, (await text(page, '#lens-h')) === LENS_HEAD, await text(page, '#lens-h'));
  check('Denver: Newspapers and guides is on by default', (await page.getAttribute('[data-act="chip"][data-k="papers"]', 'aria-pressed')) === 'true');
  const cov1 = await text(page, '#lens .cov');
  await tap(page, '[data-act="chip"][data-k="progressive"]');
  const cov2 = await text(page, '#lens .cov');
  check('Denver: turning on Progressive groups changes the coverage line', cov1 !== cov2 && /with endorsements in \d+ of your \d+ races and measures/.test(cov2), `${cov1} -> ${cov2}`);
  await tap(page, '[data-act="chip"][data-k="progressive"]');
  check('Denver: and off again', (await text(page, '#lens .cov')) === cov1);
  await tap(page, '[data-act="sheet"][data-s="sources"]');
  await page.waitForSelector('.sheet-panel');
  check('Denver: See all sources lists every source by lean, each with why its lean', (await page.$$('.sgrp')).length >= 2 && /Why this lean/.test(await text(page, '.sheet-panel')));
  check('Denver: the sheet moves focus to its close button', await page.evaluate(() => document.activeElement && document.activeElement.dataset.fk === 'sheet-x'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check('Denver: Escape closes the sheet and returns focus to the chip', !(await page.$('.sheet-panel')) && await page.evaluate(() => document.activeElement && document.activeElement.dataset.fk === 'chip-more'));

  // A race: open it, see your sources, pick, and the row closes with your pick in gold.
  const raceId = await page.evaluate(() => { const r = document.querySelector('.row[data-item]:has(.vd.agree)'); return r && r.dataset.item; });
  check('Denver: some row shows sources that agree', !!raceId);
  if (raceId) {
    await openRow(page, raceId);
    await shot(page, '02-denver-race-open');
    check('Denver: the open race shows your sources side by side', !!(await page.$(`#i-${raceId} .grid`)) || !!(await page.$(`#i-${raceId} .clist`)));
    check('Denver: the open race links Report a problem', !!(await page.$(`#i-${raceId} a[href*="docs.google.com/forms"]`)));
    await tap(page, `#i-${raceId} [data-act="pick"]`);
    check('Denver: a pick closes the row and shows your pick in gold', !(await page.$(`#i-${raceId}.is-open`)) && !!(await page.$(`#i-${raceId} .vd.done`)) && !(await page.$(`#i-${raceId}[data-undecided]`)));
  }
  const mId = await page.evaluate(() => document.querySelector('#sec-measures .row[data-item]').dataset.item);
  await openRow(page, mId);
  check('Denver: a measure says what a yes and a no vote mean', /A yes vote means/.test(await text(page, `#i-${mId} .means`)) && /A no vote means/.test(await text(page, `#i-${mId} .means`)));
  await tap(page, `#i-${mId} [data-act="pick"][data-v="NO"]`);
  check('Denver: the measure row shows No', (await text(page, `#i-${mId} .vd .m`)).endsWith('No'));
  await openRow(page, mId);
  await tap(page, `#i-${mId} [data-act="note"]`);
  await page.fill(`textarea[data-note="${mId}"]`, 'Read the Blue Book first');
  await page.locator(`textarea[data-note="${mId}"]`).blur();
  await page.waitForTimeout(300);

  await page.evaluate(() => window.scrollTo(0, 0));
  await tap(page, '[data-act="next"]');
  check('Denver: Next undecided opens an undecided row', !!(await page.$('.row.is-open[data-undecided]')));

  // "Use their picks where they agree": fills, says so, and undoes as one batch.
  const before = await text(page, '.bar-txt');
  const n = Number((await text(page, '[data-act="bulk"][data-k="agree"] .n')) || 0);
  check('Denver: agree fill has rows to fill on the default lens', n > 0, String(n));
  if (n) {
    await tap(page, '[data-act="bulk"][data-k="agree"]');
    const t = await text(page, '.toast');
    check('Denver: agree fill says how many, with Undo', /^Filled \d+ picks? where your sources agree/.test(t) && !!(await page.$('.toast [data-act="undo-bulk"]')), t);
    check('Denver: the bar counts the filled picks', (await text(page, '.bar-txt')) !== before);
    await tap(page, '.toast [data-act="undo-bulk"]');
    check('Denver: Undo puts every pick back', (await text(page, '.bar-txt')) === before, `${before} vs ${await text(page, '.bar-txt')}`);
  }

  await tap(page, '[data-act="cheat"]');
  await page.waitForSelector('#cheat');
  check('Denver: the cheat sheet keeps the note', /Read the Blue Book first/.test(await text(page, '#cheat')));
  check('Denver: the cheat sheet ends, then offers Help friends vote as its own step', !(await page.$('#pass')) && !!(await page.$('#cheat [data-act="view"][data-v="pass"]')));
  await page.emulateMedia({ media: 'print' });
  const vis = await page.evaluate(() => ({ app: getComputedStyle(document.getElementById('app')).display, print: getComputedStyle(document.getElementById('r-print')).display, rows: document.querySelectorAll('#r-print tbody tr').length }));
  check('Denver: print shows only the cheat sheet', vis.app === 'none' && vis.print !== 'none' && vis.rows > 10, JSON.stringify(vis));
  check('Denver: print has nothing in all caps', (await upperCased(page)).length === 0);
  await page.emulateMedia({ media: 'screen' });
  await tap(page, '[data-act="save-open"]');
  const link = await page.inputValue('.save-url');
  check('Denver: save link is v1 for a ballot with no rankings, under 2,000 characters', /#v1~CO~denver-co~80205~/.test(link) && link.length < 2000, `${link.length} chars`);
  const decided = await text(page, '.cheat-head .sub');
  await page.goBack();
  await page.waitForTimeout(300);
  check('Denver: the phone’s Back button returns from the cheat sheet to the ballot', !!(await page.$('#plan')) && !(await page.$('#cheat')));
  noErrors(page, 'Denver');

  const fresh = await newPage();
  await fresh.page.goto(linkHere(link));
  await fresh.page.waitForSelector('#plan', { timeout: 15000 });
  await fresh.page.waitForTimeout(300);
  // On a device that had nothing for this ballot, a link's picks come with a plain banner (it may
  // be a friend's), not a silent "your pick".
  check('Denver link: a fresh device says where the picks came from', /This link brought \d+ picks? for Denver/.test(await text(fresh.page, '#r-restore')) && !!(await fresh.page.$('[data-act="shared-fresh"]')), await text(fresh.page, '#r-restore'));
  await tap(fresh.page, '[data-act="shared-keep"]');
  check('Denver link: "Use the link’s picks" clears the banner and keeps the picks', !(await fresh.page.$('[data-act="shared-fresh"]')));
  await tap(fresh.page, '[data-act="cheat"]');
  check('Denver link: the same decided count and the note come back', (await text(fresh.page, '.cheat-head .sub')) === decided && /Read the Blue Book first/.test(await text(fresh.page, '#cheat')));
  noErrors(fresh.page, 'Denver link');
  await fresh.ctx.close();

  // Same device, different picks in the link: ask before overwriting.
  const [h, ...rest] = link.split('#');
  const fields = rest.join('#').split('~');
  fields[4] = fields[4].replace(/N(\.|$)/, 'Y$1');
  await page.goto(linkHere(`${h}#${fields.join('~')}`));
  await page.waitForSelector('#plan', { timeout: 15000 });
  await page.waitForTimeout(250);
  check('Denver: a link with different picks asks first', !!(await page.$('[data-act="restore-yes"]')));
  await ctx.close();
}

/* ---------- Austin 78702: district questions, unopposed fold, booth rules ---------- */
{
  const { ctx, page } = await newPage();
  await openBallot(page, '78702');
  await noSideScroll(page, 'Austin');
  check('Austin: Texas on Oct 19 says early voting starts today', (await text(page, '.plan-h')) === 'Early voting starts today, Oct 19.', await text(page, '.plan-h'));
  await tap(page, '[data-act="open"][data-k="whatif"]');
  check('Austin: booth rules say notes allowed, phones not allowed', /notes allowed, phones not allowed/i.test(await text(page, '.whatifs')));
  await tap(page, '[data-act="open"][data-k="whatif"]');
  const key = await page.evaluate(() => [...document.querySelectorAll('.row[data-q]')].map((r) => r.dataset.q).find((k) => /City Council/.test(k)));
  check('Austin: asks which council district is yours', !!key);
  await openRow(page, `q:${key}`);
  await shot(page, '04-austin-question');
  // UX review: write-ins fold into one line in a long race (U.S. Senate has four).
  await openRow(page, 'tx-us-senate');
  check('Austin: the U.S. Senate row folds its 4 write-ins into one line', /4 write-in candidates/.test(await text(page, '#i-tx-us-senate .wi-fold')) && !/refers readers to VOTE411/.test(await text(page, '#i-tx-us-senate')), await text(page, '#i-tx-us-senate .wi-fold'));
  await openRow(page, `q:${key}`);
  const finders = await page.$$eval(`.row[data-q="${key}"] .dq-help a`, (as) => as.map((a) => a.textContent));
  check('Austin: the council question links every county’s finder (Travis, Williamson, Hays)', ['Travis', 'Williamson', 'Hays'].every((c) => finders.some((t) => t.includes(c))), finders.join(' | '));
  await tap(page, `.row[data-q="${key}"] [data-act="district"][data-v="tx-austin-council-3"]`);
  check('Austin: District 3 shows, opened; District 1 hides', !!(await page.$('#i-tx-austin-council-3.is-open')) && !(await page.$('#i-tx-austin-council-1')));
  check('Austin: the open race says which district you chose', /You said you’re in District 3/.test(await text(page, '#i-tx-austin-council-3 .ob')));
  const unopp = await text(page, '#sec-judicial .unopp .disc');
  check('Austin: unopposed races fold into one line', /^\d+ unopposed races?\. Nothing to decide\./.test(unopp), unopp);
  await tap(page, '#sec-judicial .unopp .disc');
  check('Austin: the line opens to the list', (await page.$$('#sec-judicial .unopp-list li')).length > 1);
  noErrors(page, 'Austin');
  await ctx.close();
}

/* ---------- statewide-only, uncovered, shared ZIPs ---------- */
{
  const { ctx, page } = await newPage();
  await openBallot(page, '99201');
  await noSideScroll(page, 'Spokane');
  check('Spokane: says we only have statewide races so far', /We only have statewide races for your area so far\./.test(await text(page, '.bhead')));
  check('Spokane: links an official ballot lookup', !!(await page.$('.bhead .statewide-note a[href^="http"]')));
  check('Spokane: no city or county sections', !(await page.$('.sec[data-sec="city"], .sec[data-sec="county"]')));
  noErrors(page, 'Spokane');
  await ctx.close();
}
{
  // A fresh browser each time: a saved ballot would open instead of the ZIP box.
  const { ctx, page } = await newPage();
  await openZip(page, '02139');
  await page.waitForSelector('.notice');
  check('Uncovered: names Vote.gov', /Vote\.gov/.test(await text(page, '.notice')));
  await ctx.close();
}
{
  const { ctx, page } = await newPage();
  await openZip(page, '80247');
  await page.waitForSelector('[data-act="choose-place"]');
  check('80247: asks which place, with "I’m not sure"', (await page.$$('[data-act="choose-place"]')).length === 3 && /I’m not sure/.test(await text(page, '.choose')));
  check('80247: offers the address lookup to pick', !!(await page.$('.choose [data-act="addr-open"]')));
  await tap(page, '[data-act="choose-place"][data-ids="aurora-co+denver-co"]');
  await throughSetup(page);
  check('80247 not sure: both places, items marked "Only in"', /Aurora or Denver/.test(await text(page, '.place')) && (await page.$$('.tag')).length > 10);
  await noSideScroll(page, '80247 not sure');
  noErrors(page, '80247');
  await ctx.close();
}

/* ---------- DC 20001, not sure which ward: the city up top, the wards under it ---------- */
{
  const { ctx, page } = await newPage();
  await openZip(page, '20001');
  await page.waitForSelector('[data-act="choose-place"]');
  check('20001: asks which ward, not which city', /covers \d+ wards\. Pick yours/.test(await text(page, '.choose')));
  await tap(page, '[data-act="choose-place"][data-fk="cp-unsure"]');
  await throughSetup(page);
  check('20001 not sure: the headline is "Washington, DC" with the wards under it', (await text(page, '.place')) === 'Washington, DC' && /^Ward \d+(, \d+)* or \d+$/.test(await text(page, '.where-note')), `${await text(page, '.place')} | ${await text(page, '.where-note')}`);
  noErrors(page, '20001');
  await ctx.close();
}

/* ---------- Houston 77002: numbered seats every voter sees are not a question ---------- */
{
  const { ctx, page } = await newPage();
  await openBallot(page, '77002');
  await noSideScroll(page, 'Houston');
  check('Houston: Klein ISD positions are not a district question', !(await page.$('.row[data-q*="Klein ISD"]')));
  if (await page.$('#sec-school .unopp .disc[aria-expanded="false"]')) await tap(page, '#sec-school .unopp .disc');
  check('Houston: other school districts’ races fold into one line', /Other school districts that touch Houston/.test(await text(page, '#sec-school .grp.oth')));
  if (await page.$('#sec-school .grp.oth [data-act="grp"][aria-expanded="false"]')) await tap(page, '#sec-school .grp.oth [data-act="grp"]');
  check('Houston: both Klein ISD positions are on the ballot', !!(await page.$('#i-tx-kleinisd-trustee-1')) && !!(await page.$('#i-tx-kleinisd-trustee-2')));
  await openRow(page, 'tx-kleinisd-trustee-1');
  check('Houston: a "May apply" race can hide every seat that shares its scope', !!(await page.$('#i-tx-kleinisd-trustee-1 [data-act="notmine"][data-all="1"]')));
  await tap(page, '#i-tx-kleinisd-trustee-1 [data-act="notmine"][data-all="1"]');
  check('Houston: both Klein ISD seats now say "Not on your ballot"', !!(await page.$('#i-tx-kleinisd-trustee-1.is-off')) && !!(await page.$('#i-tx-kleinisd-trustee-2.is-off')));
  await tap(page, '[data-act="cheat"]');
  await tap(page, '[data-act="save-open"]');
  const link = await page.inputValue('.save-url');
  check('Houston: "Not on my ballot" travels in the save link', link.split('~').length === 10, `${link.split('~').length} fields`);
  const fresh = await newPage();
  await fresh.page.goto(linkHere(link));
  await fresh.page.waitForSelector('#plan', { timeout: 15000 });
  if (await fresh.page.$('#sec-school .grp.oth [data-act="grp"][aria-expanded="false"]')) await tap(fresh.page, '#sec-school .grp.oth [data-act="grp"]');
  check('Houston link: those races come back as not on your ballot', !!(await fresh.page.$('#i-tx-kleinisd-trustee-1.is-off')));
  await fresh.ctx.close();
  noErrors(page, 'Houston');
  await ctx.close();
}

/* ---------- ranked choice: Portland 97214, City Council District 3 (3 winners, rank up to 6) ---------- */
const panelNames = (page, card) => page.$$eval(`${card} .rank-row .rank-nm`, (els) => els.map((e) => e.textContent.replace(/^\s*\d+(st|nd|rd|th):\s*/, '').trim()));
{
  const { ctx, page } = await newPage();
  await openBallot(page, '97214');
  await noSideScroll(page, 'Portland');
  await tap(page, '[data-act="sheet"][data-s="sources"]');
  await page.waitForSelector('.sheet-panel');
  const pw = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.sheet-panel .srow')].find((r) => r.querySelector('.pw-note'));
    if (!row) return null;
    const a = row.querySelector('.pw-note a');
    return { name: row.querySelector('.s-n').textContent.trim(), note: row.querySelector('.pw-note').textContent.replace(/\s+/g, ' ').trim(), href: a ? a.href : '' };
  });
  check('Portland: a paywalled paper in See all sources carries the note, linking the report form with its name', !!pw && PW_NOTE_RE.test(pw.note) && pw.href.includes('docs.google.com/forms') && new URL(pw.href).searchParams.get('entry.90887649').includes(pw.name), pw ? `${pw.name}: ${pw.note}` : 'no paywalled source on this ballot');
  await tap(page, '[data-act="sheet-close"][data-fk="sheet-x"]');
  const key = await page.evaluate(() => [...document.querySelectorAll('.row[data-q]')].map((r) => r.dataset.q).find((k) => /Portland City Council/.test(k)));
  check('Portland: asks which council district', !!key);
  await openRow(page, `q:${key}`);
  await tap(page, `.row[data-q="${key}"] [data-act="district"][data-v="portland-council-3"]`);
  const card = '#i-portland-council-3';
  check('Portland: District 3 race shows, District 4 hides', !!(await page.$(card)) && !(await page.$('#i-portland-council-4')));
  await openRow(page, 'portland-council-3');
  const head = await text(page, `${card} .rcv`);
  check('Portland: header says rank up to 6, three people win', head.includes('Ranked choice: rank up to 6.') && head.includes('Three people win.'), head.slice(0, 90));
  check('Portland: header links the official count rules', ((await page.getAttribute(`${card} .rcv a`, 'href')) || '').includes('multco.us'));
  check('Portland: no "mark up to" wording on a ranked race', !/mark up to/i.test(await text(page, card)));
  check('Portland: no em dashes in the ranked race', !/—/.test(await text(page, card)));
  // Paywalled papers (Kevin, Oct 19): the Oregonian's picks we only saw secondhand are out, so
  // this race says once why, with a link that opens the report form naming the paper.
  const pwRow = await page.evaluate((c) => { const n = document.querySelector(`${c} .pw-note`); return n ? { n: document.querySelectorAll(`${c} .pw-note`).length, note: n.textContent.replace(/\s+/g, ' ').trim(), href: (n.querySelector('a') || {}).href || '' } : null; }, card);
  check('Portland: the race notes the paywalled Oregonian once, linking the report form with its name', !!pwRow && pwRow.n === 1 && /Oregonian/.test(pwRow.note) && PW_NOTE_RE.test(pwRow.note) && new URL(pwRow.href).searchParams.get('entry.90887649').includes('Oregonian'), pwRow ? pwRow.note : 'no note');
  await tap(page, `${card} [data-act="rank"][data-v="Steve Novick"]`);
  await tap(page, `${card} [data-act="rank"][data-v="Tiffany Koyama Lane"]`);
  const nextLabel = await text(page, `${card} [data-act="rank"][data-v="Kellie Torres"]`);
  check('Portland: an unranked candidate offers the next rank', nextLabel === 'Rank Torres 3rd', nextLabel);
  await tap(page, `${card} [data-act="rank"][data-v="Kellie Torres"]`);
  let order = await panelNames(page, card);
  check('Portland: three taps rank three candidates in order', order.join('|') === 'Steve Novick|Tiffany Koyama Lane|Kellie Torres', order.join(' | '));
  check('Portland: a ranked candidate shows their rank', (await text(page, `${card} [data-act="rank"][data-v="Tiffany Koyama Lane"]`)).startsWith('Your 2nd: Lane'));
  check('Portland: the row stays open while ranking', !!(await page.$(`${card}.is-open[data-undecided]`)));
  await shot(page, '05-portland-ranking');
  await tap(page, `${card} [data-act="rank"][data-v="Tiffany Koyama Lane"]`);
  order = await panelNames(page, card);
  check('Portland: removing the 2nd renumbers the rest', order.join('|') === 'Steve Novick|Kellie Torres', order.join(' | '));
  await tap(page, `${card} [data-act="rank"][data-v="Angelita Morillo"]`);
  await page.focus(`${card} [data-act="rup"][data-v="Angelita Morillo"]`);
  await page.waitForTimeout(700); // the tap handler ignores a click right after a touch tap
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  order = await panelNames(page, card);
  const focused = await page.evaluate(() => { const a = document.activeElement; return a && a.dataset ? `${a.dataset.act}:${a.dataset.v}` : ''; });
  check('Portland: Move up works from the keyboard', order.join('|') === 'Steve Novick|Angelita Morillo|Kellie Torres', order.join(' | '));
  check('Portland: focus follows the moved row', focused === 'rup:Angelita Morillo', focused);
  await tap(page, `${card} [data-act="rup"][data-v="Angelita Morillo"]`);
  order = await panelNames(page, card);
  check('Portland: Move up to 1st', order.join('|') === 'Angelita Morillo|Steve Novick|Kellie Torres', order.join(' | '));
  const tiny = await small44(page, `${card} .rank-panel`);
  check('Portland: ranking controls are at least 44px', tiny.length === 0, tiny.join(', '));
  await tap(page, `${card} [data-act="note"]`);
  await page.fill('textarea[data-note="portland-council-3"]', 'Check the OPB explainer');
  await page.locator('textarea[data-note="portland-council-3"]').blur();
  await page.waitForTimeout(300);
  await tap(page, `${card} [data-act="rdone"]`);
  check('Portland: Done ranking finishes the city section, which folds to one band naming the pick', !!(await page.$('#sec-city.folded')) && /1\. Morillo \+2/.test(await text(page, '#sec-city .sec-sub')), await text(page, '#sec-city .sec-sub'));
  await unfold(page, 'city');
  check('Portland: opened again, the row shows the 1st choice in gold', !(await page.$(`${card}.is-open`)) && (await text(page, `${card} .vd .m`)).endsWith('1. Morillo +2'), await text(page, `${card} .vd .m`));
  for (const k of ['progressive', 'conservative']) if (await page.$(`[data-act="chip"][data-k="${k}"][aria-pressed="false"]`)) await tap(page, `[data-act="chip"][data-k="${k}"]`);
  if (await page.$('[data-act="bulk"][data-k="agree"]:not([disabled])')) await tap(page, '[data-act="bulk"][data-k="agree"]');
  check('Portland: "use their picks" never fills a ranked race', !!(await page.$('#i-multnomah-chair[data-undecided]')));
  await tap(page, '[data-act="cheat"]');
  const cs = await page.$$eval('#cheat tr[data-cs="portland-council-3"] .cs-ranks li', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  check('Portland: cheat sheet shows the ranks in order', cs.join('|') === '1st Angelita Morillo|2nd Steve Novick|3rd Kellie Torres', cs.join(' | '));
  check('Portland: cheat sheet notes the rank limit and keeps the note', /Ranked choice: rank up to 6/.test(await text(page, '#cheat tr[data-cs="portland-council-3"]')) && /Check the OPB explainer/.test(await text(page, '#cheat')));
  await page.emulateMedia({ media: 'print' });
  check('Portland: print lists the ranks too', (await page.$$('#r-print tr[data-cs="portland-council-3"] .cs-ranks li')).length === 3);
  await page.emulateMedia({ media: 'screen' });
  await tap(page, '[data-act="save-open"]');
  const url = await page.inputValue('.save-url');
  check('Portland: save link is v2 when it holds a ranking', /#v2~OR~portland-or~97214~/.test(url) && url.length < 2000, `${url.length} chars`);
  check('Portland: no all caps', (await upperCased(page)).length === 0);
  noErrors(page, 'Portland');
  const fresh = await newPage();
  await fresh.page.goto(linkHere(url));
  await fresh.page.waitForSelector('#plan', { timeout: 15000 });
  await fresh.page.waitForTimeout(300);
  await unfold(fresh.page, 'city');
  await openRow(fresh.page, 'portland-council-3');
  order = await panelNames(fresh.page, card);
  check('Portland link: the ranking comes back in order', order.join('|') === 'Angelita Morillo|Steve Novick|Kellie Torres', order.join(' | '));
  await tap(fresh.page, '[data-act="cheat"]');
  check('Portland link: the note comes back', /Check the OPB explainer/.test(await text(fresh.page, '#cheat')));
  noErrors(fresh.page, 'Portland link');
  await fresh.ctx.close();
  // "Change" on a cheat-sheet line goes back to that row, opened, even inside a folded section.
  await tap(page, '#cheat tr[data-cs="portland-council-3"]');
  check('Portland: Change on the cheat sheet reopens that row on the ballot', !!(await page.$('#i-portland-council-3.is-open')) && !(await page.$('#cheat')));
  await ctx.close();
}

/* ---------- ranked choice: DC Ward 1 (20010), four candidates, rank up to 5 ---------- */
{
  const { ctx, page } = await newPage();
  await openBallot(page, '20010');
  await noSideScroll(page, 'DC Ward 1');
  const card = '#i-dc-ward-1-council';
  await openRow(page, 'dc-ward-1-council');
  const head = await text(page, `${card} .rcv`);
  check('DC Ward 1: header says rank up to 5, one person wins', head.includes('Ranked choice: rank up to 5.') && head.includes('One person wins.'), head.slice(0, 80));
  check('DC Ward 1: says the ballot adds a write-in line', /write-in/.test(await text(page, `${card} .rank-empty`)));
  const names = await page.$$eval(`${card} [data-act="rank"]`, (els) => els.map((e) => e.dataset.v));
  check('DC Ward 1: four candidates to rank', names.length === 4, names.join(', '));
  for (const nm of names) await tap(page, `${card} [data-act="rank"][data-v="${nm}"]`);
  check('DC Ward 1: all four ranked in tap order', (await panelNames(page, card)).join('|') === names.join('|'));
  check('DC Ward 1: a full ranking stays open to reorder', /All 4 ranked\./.test(await text(page, `${card} .rank-panel`)) && !!(await page.$(`${card} [data-act="rdone"]`)));
  await tap(page, `${card} [data-act="rdone"]`);
  await openRow(page, 'dc-council-at-large');
  const al = await text(page, '#i-dc-council-at-large .rcv');
  check('DC at-large: ranked, two win, your ballot counts once', al.includes('rank up to 5.') && al.includes('Two people win.') && al.includes('Your ballot counts once'), al.slice(0, 120));
  await openRow(page, 'dc-council-chair');
  check('DC Ward 1: council chair stays pick-one', !(await page.$('#i-dc-council-chair .rcv')) && !!(await page.$('#i-dc-council-chair [data-act="pick"]')));
  noErrors(page, 'DC Ward 1');
  await ctx.close();
}

/* ---------- an old v1 link, saved from the live guide before ranked choice ---------- */
{
  const OLD = '#v1~DC~dc-ward-1~20010~l0g49h8j.it941rdf.3z3i9P.ik2ysP.1rq6ag1n~~l0g49T2xkIGxpbmsgbm90ZQ~';
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/?today=${TODAY}${OLD}`);
  await page.waitForSelector('#plan', { timeout: 15000 });
  await page.waitForTimeout(300);
  check('Old v1 link: brings back 3 picks, with the shared-link banner', /This link brought 3 picks/.test(await text(page, '#r-restore')), await text(page, '#r-restore'));
  check('Old v1 link: Ward 1 pick comes back as the 1st choice', (await text(page, '#i-dc-ward-1-council .vd .m')).endsWith('1. Raj'), await text(page, '#i-dc-ward-1-council .vd .m'));
  check('Old v1 link: Mayor pick comes back as the 1st choice', (await text(page, '#i-dc-mayor .vd .m')).endsWith('1. Hamilton'), await text(page, '#i-dc-mayor .vd .m'));
  check('Old v1 link: Chair restores as before', (await text(page, '#i-dc-council-chair .vd .m')).endsWith('Mendelson'), await text(page, '#i-dc-council-chair .vd .m'));
  check('Old v1 link: at-large seat marks reopen the race to rank', !!(await page.$('#i-dc-council-at-large[data-undecided]')));
  await tap(page, '[data-act="cheat"]');
  check('Old v1 link: the note comes back', /Old link note/.test(await text(page, '#cheat')));
  await tap(page, '[data-act="view"][data-v="ballot"]');
  await tap(page, '[data-act="shared-fresh"]');
  check('Shared link: "Start fresh" clears the shared picks', /^0 of/.test(await text(page, '.bar-txt')) && !(await page.$('[data-act="shared-fresh"]')), await text(page, '.bar-txt'));
  noErrors(page, 'Old v1 link');
  await ctx.close();
}

/* ---------- judges, Full details, Help your friends vote ---------- */
{
  const { ctx, page } = await newPage();
  await openBallot(page, '80226');
  const jId = await page.evaluate(() => document.querySelector('#sec-judicial .row[data-item]').dataset.item);
  await openRow(page, jId);
  check('Lakewood: a judge row offers Keep and Remove', !!(await page.$(`#i-${jId} [data-act="pick"][data-v="YES"]`)) && /Keep/.test(await text(page, `#i-${jId} .duo`)));
  await tap(page, `#i-${jId} [data-act="pick"][data-v="YES"]`);
  check('Lakewood: keeping a judge reads "Keep" in the row', (await text(page, `#i-${jId} .vd .m`)).endsWith('Keep'));
  const rId = await page.evaluate(() => document.querySelector('#sec-federal .row[data-item]').dataset.item);
  await openRow(page, rId);
  await tap(page, `#i-${rId} [data-act="reader"]`);
  check('Lakewood: Full details opens with the candidates in their own words', !!(await page.$('.reader')) && /in their own words/i.test(await text(page, '.reader')));
  await shot(page, '06-lakewood-reader');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Lakewood: Escape closes the Full details and returns focus', !(await page.$('.reader')) && await page.evaluate((id) => document.activeElement && document.activeElement.dataset.fk === `rd-${id}`, rId));
  await tap(page, '#plan [data-act="view"][data-v="pass"]');
  const pub = await text(page, '#msg-pub');
  check('Help friends vote: "I already voted" says thank you', /You voted\. Thank you\./.test(await text(page, '#pass')));
  check('Help friends vote: the public message uses official links, never this guide', /(Official election info|Check your registration): https?:\/\//.test(pub) && !pub.includes(new URL(BASE).host), pub.slice(0, 80));
  check('Help friends vote: Colorado’s registration and official links are the same URL, given once', (pub.match(/govotecolorado\.gov/g) || []).length === 1, pub);
  check('Help friends vote: the public message never carries the county office line', !/Local election office/.test(pub), pub);
  check('Help friends vote: the public message leads with Election Day and the mail rule', /^Election Day in Colorado is Tue, Nov 3\. Ballots must be in by 7 PM Tue, Nov 3\./.test(pub), pub.slice(0, 120));
  check('Help friends vote: no "12 people" arithmetic', !/12 people/.test(await text(page, '#pass')));
  // Florida counties set their own early-voting days: a county ballot gives its county's window,
  // and a statewide-only ballot calls the state's dates a minimum (Codex round 4).
  {
    // A judge whose chosen paywalled papers have no readable pick still gets the paywall note
    // once (Codex, copy pass review): Ballwin's Missouri Supreme Court retention.
    const bw = await newPage();
    await openBallot(bw.page, '63011');
    await openRow(bw.page, 'mo-retention-wilson');
    check('Ballwin: a retention row names its paywalled papers with the note', /behind a paywall/.test(await text(bw.page, '#i-mo-retention-wilson')));
    await bw.ctx.close();
  }
  for (const [zip, re, label] of [
    ['32801', /Early voting in Orange County runs Mon, Oct 19 through Sun, Nov 1\./, "Help friends vote: Orlando gives Orange County's early-voting window"],
    ['32052', /Every Florida county offers early voting Sat, Oct 24 through Sat, Oct 31\. Some counties start earlier or finish later/, "Help friends vote: a statewide Florida ballot calls Oct 24 to 31 the counties' minimum"],
    ['60614', /Early voting dates vary by county and run through Mon, Nov 2; check yours\./, "Help friends vote: Illinois says early voting dates vary by county (no statewide start)"],
  ]) {
    const fl = await newPage();
    await openBallot(fl.page, zip);
    await tap(fl.page, '#plan [data-act="view"][data-v="pass"]');
    const msg = await text(fl.page, '#msg-pub');
    check(label, re.test(msg), msg.slice(0, 200));
    await fl.ctx.close();
  }
  check('Help friends vote: having voted, the friends message starts "I just voted!"', /^I just voted!/.test(await text(page, '#msg-fam')));
  check('Help friends vote: the texting study shows, with its caveats one tap away', /Outvote/.test(await text(page, '#pass')) && !!(await page.$('#pass [data-k="study-more"]')));
  check('Help friends vote: partisan groups sit beside "examples, not recommendations"', /not recommendations/.test(await text(page, '#pass .ways')) && /Progressive groups/.test(await text(page, '#pass .ways')) && /Conservative groups/.test(await text(page, '#pass .ways')));
  // The guide's address since Oct 19: the friends message shares it whatever host the page is
  // on (a preview, the old vercel.app address, localhost).
  const fam = await text(page, '#msg-fam');
  check('Help friends vote: the friends message shares the guide at https://vote.kevinhg.com/', fam.includes('https://vote.kevinhg.com/') && (new URL(BASE).host === 'vote.kevinhg.com' || !fam.includes(new URL(BASE).host)), fam.slice(0, 200));
  check('Help friends vote: no relative "today" in a message someone reads later', !/\btoday\b|\btomorrow\b/i.test(pub));
  await tap(page, '[data-act="tick"][data-k="family"]');
  check('Help friends vote: the checklist ticks', (await page.getAttribute('[data-act="tick"][data-k="family"]', 'aria-pressed')) === 'true');
  noErrors(page, 'Lakewood');
  await ctx.close();
}
for (const [day, want] of [['2026-11-03', /^Today is Election Day\. Polls close at 7 PM\.$/], ['2026-11-04', /^Voting has closed/]]) {
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/?today=${day}&now=10:00`);
  await page.fill('#zip', '80226');
  await page.locator('button[type=submit]').tap();
  await throughSetup(page);
  check(`Plan on ${day}: ${want}`, want.test(await text(page, '.plan-h')), await text(page, '.plan-h'));
  await ctx.close();
}
{
  const { ctx, page } = await newPage({ colorScheme: 'dark' });
  await openBallot(page, '80226');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('Dark mode: the page goes dark', bg === 'rgb(22, 29, 26)', bg);
  await noSideScroll(page, 'Dark mode');
  await shot(page, '07-dark');
  await ctx.close();
}
{
  // ?try= never touches the real saved picks.
  const { ctx, page } = await newPage();
  await openBallot(page, '80226');
  const id = await page.evaluate(() => document.querySelector('#sec-measures .row[data-item]').dataset.item);
  await openRow(page, id);
  await tap(page, `#i-${id} [data-act="pick"][data-v="YES"]`);
  await page.waitForTimeout(400);
  const saved = await page.evaluate(() => localStorage.getItem('vg2'));
  await openBallot(page, '80226', '&try=aunt');
  check('Try as: shows the scenario banner', /Nothing here is saved/.test(await text(page, '.trybar')));
  check('Try as: the aunt has most rows decided', Number((await text(page, '.bar-txt')).split(' ')[0]) > 20, await text(page, '.bar-txt'));
  await page.waitForTimeout(400);
  check('Try as: the real saved picks are untouched', (await page.evaluate(() => localStorage.getItem('vg2'))) === saved);
  noErrors(page, 'Try as');
  await ctx.close();
}

/* ---------- Help your friends vote in Washington: statewide links only, never King County's page ---------- */
{
  const { ctx, page } = await newPage();
  await openBallot(page, '99201');
  await tap(page, '#plan [data-act="view"][data-v="pass"]');
  await page.waitForSelector('#msg-pub');
  const pub = await text(page, '#msg-pub');
  check('Spokane: the public message never carries King County’s lookup page', !/kingcounty\.gov/.test(pub) && /votewa\.gov/.test(pub), pub);
  noErrors(page, 'Spokane pass');
  await ctx.close();
}
{
  const { ctx, page } = await newPage();
  await openBallot(page, '78702');
  await tap(page, '#plan [data-act="view"][data-v="pass"]');
  await page.waitForSelector('#msg-pub');
  const pub = await text(page, '#msg-pub');
  check('Austin: the public message says Election Day and the early-voting dates', /Election Day in Texas is Tue, Nov 3\./.test(pub) && /Early voting runs Mon, Oct 19 through Fri, Oct 30\./.test(pub), pub.slice(0, 140));
  await tap(page, '[data-act="view"][data-v="ballot"]');
  const oth = await text(page, '#sec-school .grp.oth');
  check('Austin: other school districts’ races fold into one line', /Other school districts that touch Austin/.test(oth) && !(await page.$('#sec-school [data-fold]')), oth.slice(0, 120));
  const barM = async () => Number(((await text(page, '.bar-txt')).match(/of (\d+)/) || [])[1]);
  const m0 = await barM();
  await tap(page, '#sec-school .grp.oth [data-act="grp"]');
  const shown = (await page.$$('#sec-school [data-fold]')).length;
  check('Austin: opening the line lists them, with "None of these are on my ballot"', shown >= 3 && !!(await page.$('[data-act="notmine-oth"]')), String(shown));
  // Counting (Oct 20): the fold's races count only once you claim them, and opening it does.
  check('Austin: opening the fold adds its races to the bar\'s count', (await barM()) === m0 + shown, `${m0} then ${await barM()} with ${shown} shown`);
  await tap(page, '[data-act="notmine-oth"]');
  check('Austin: "None of these" takes them all off and folds the line', /none on your ballot/.test(await text(page, '#sec-school .grp.oth')), await text(page, '#sec-school .grp.oth'));
  check('Austin: and the bar\'s count drops back', (await barM()) === m0, `${m0} vs ${await barM()}`);
  noErrors(page, 'Austin pass and fold');
  await ctx.close();
}

/* ---------- Codex round 1 fixes, each checked in a real browser ---------- */
// #5: the key dates keep their fine print, and Orlando uses Orange County's own early voting.
{
  const { ctx, page } = await newPage();
  await openBallot(page, '32801');
  const head = await text(page, '.plan-h');
  check('Orlando: on Oct 19 early voting starts today (Orange County opens Oct 19)', /^Early voting starts today, Oct 19\.$/.test(head), head);
  check('Orlando: the early voting button goes to Orange County', /voteorangefl\.gov/.test((await page.getAttribute('.plan .pbtn.gold', 'href')) || ''));
  await tap(page, '[data-act="open"][data-k="whatif"]');
  await tap(page, '[data-act="open"][data-k="bx-dates"]');
  const n = (await page.$$('.pdates .pd-more')).length;
  check('Orlando: key dates offer their details', n >= 3, String(n));
  await tap(page, '.pdates [data-act="open"][data-k="kd-eps"]');
  const eps = await text(page, '.pdates .pd-x');
  check('Orlando: early voting details name Orange County’s hours, in normal case', /Orange County/.test(eps) && /8:00 AM to 8:00 PM/.test(eps) && !/\b[A-Z]{4,}\b/.test(eps.replace(/\b(AM|PM)\b/g, '')), eps.slice(0, 120));
  check('Orlando: the details button says it is open', (await page.getAttribute('.pdates [data-k="kd-eps"]', 'aria-expanded')) === 'true');
  check('Orlando: the key dates show early voting ending Nov 1', /Nov 1/.test(await text(page, '.pdates')));
  noErrors(page, 'Orlando');
  await ctx.close();
}
// UX re-walk: Amendment 87's open row is one conflict box and a two-line official title; grid
// cells keep the lean dots and word, with how it was placed one tap away.
{
  const { ctx, page } = await newPage();
  await openBallot(page, '80226');
  await openRow(page, 'co-amendment-87');
  const boxes = await page.$$eval('#i-co-amendment-87 .heads', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  check('A87: no separate "Read with" box when the heads-up names Prop 136', !boxes.some((t) => /^Read with/.test(t)) && boxes.some((t) => /Heads up:.*Read with Proposition 136/.test(t)), boxes.join(' || ').slice(0, 200));
  check('A87: the official title is clamped, with "Read the full ballot wording"', !!(await page.$('#i-co-amendment-87 .ot.two')) && /Read the full ballot wording/.test(await text(page, '#i-co-amendment-87 .ot-more')));
  check('A87: no lean-basis words inside the grid', !(await page.$('#i-co-amendment-87 .grid .lk')) && !!(await page.$('#i-co-amendment-87 .grid .lean-tap')));
  await tap(page, '#i-co-amendment-87 .grid .lean-tap');
  check('A87: tapping a lean says how it was placed', /rated by|party|mission|outside media-bias|not rated/.test(await text(page, '.toast')), await text(page, '.toast'));
  noErrors(page, 'A87');
  await ctx.close();
}
// UX re-walk: a Chicago judge's open row has one wording and every group by full name, one tap away.
{
  const { ctx, page } = await newPage();
  await openBallot(page, '60601');
  // "Read these first" jumps to Judge Smith (7 of 14 groups say don't keep) and opens her row.
  const go = await page.evaluate(() => { const bt = [...document.querySelectorAll('.readfirst [data-act="goto"]')].find((x) => x.textContent.trim() === 'Smith'); return bt && bt.dataset.id; });
  if (go) { await tap(page, `.readfirst [data-act="goto"][data-id="${go}"]`); await page.waitForTimeout(200); }
  const id = go;
  check('Chicago: a judge row reads "say don’t keep"', !!id && /say don’t keep/.test(await text(page, `#i-${id} .vd`)), id && await text(page, `#i-${id} .vd`));
  if (id) {
    await openRow(page, id);
    const line = await text(page, `#i-${id} .finding .q`);
    check('Chicago: the open row says "say don’t keep" too, with no acronyms', /say don’t keep/.test(line) && !/\b[A-Z]{3,}\b/.test(line), line);
    await tap(page, `#i-${id} .finding [data-act="open"]`);
    check('Chicago: "See each group" lists the groups by full name', (await page.$$(`#i-${id} .eg li`)).length > 5 && /Association|Bar/.test(await text(page, `#i-${id} .eg`)));
  }
  noErrors(page, 'Chicago judge');
  await ctx.close();
}
// Codex r2 (r1 #3): confirming a filled pick by hand, even with the same value, survives Undo.
{
  const { ctx, page } = await newPage();
  await openBallot(page, '80226');
  await tap(page, '[data-act="bulk"][data-k="agree"]');
  const filled = await page.evaluate(() => { const r = [...document.querySelectorAll('#sec-measures .row[data-item]')].find((x) => /Filled from your sources/.test(x.textContent)); return r ? { id: r.dataset.item, v: /Yes\s*$/.test(r.querySelector('.vd .m').textContent) ? 'YES' : 'NO' } : null; });
  check('Undo after a hand edit: a measure was filled', !!filled);
  if (filled) {
    await openRow(page, filled.id);
    await tap(page, `#i-${filled.id} [data-act="pick"][data-v="${filled.v}"]`);
    await tap(page, '.toast [data-act="undo-bulk"]').catch(() => {});
    const still = await text(page, `#i-${filled.id} .vd .m`);
    check('Undo after a hand edit: the pick you confirmed by hand stays', new RegExp(filled.v === 'YES' ? 'Yes$' : 'No$').test(still) && !/Filled from your sources/.test(await text(page, `#i-${filled.id}`)), still);
  }
  noErrors(page, 'Undo after a hand edit');
  await ctx.close();
}
// #12: after the polls close on Election Day.
{
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/?today=2026-11-03&now=19:05`);
  await page.fill('#zip', '77002');
  await page.locator('button[type=submit]').tap();
  await throughSetup(page);
  const head = await text(page, '.plan-h');
  check('Houston 7:05 PM on Election Day: polls closed, stay in line', /^Polls closed at 7 PM\. Already in line\? Stay in line\.$/.test(head), head);
  noErrors(page, 'Polls closed');
  await ctx.close();
}
// Codex r2 (r1 #12): an open page turns over at 7 PM Central on its own, whatever the device's zone.
{
  const { ctx, page } = await newPage({ timezoneId: 'America/Los_Angeles' });
  await page.clock.install({ time: new Date('2026-11-04T00:58:00Z') });
  await page.goto(`${BASE}/?today=2026-11-03`);
  await page.fill('#zip', '78702');
  await page.locator('button[type=submit]').tap();
  await throughSetup(page);
  const before = await text(page, '.plan-h');
  await page.clock.runFor(3 * 60_000);
  await page.waitForTimeout(200);
  const after = await text(page, '.plan-h');
  check('Austin on a Pacific-time phone: 6:58 PM Central is still Election Day', /^Today is Election Day\. Polls close at 7 PM\.$/.test(before), before);
  check('Austin on a Pacific-time phone: the open page turns to "Polls closed" after 7 PM Central', /^Polls closed at 7 PM/.test(after), after);
  noErrors(page, 'Polls close on an open page');
  await ctx.close();
}
// Codex r2: a contested judicial race's Full details keeps each rating as published, with its scope and source.
{
  const { ctx, page } = await newPage();
  await openBallot(page, '11201');
  const id = 'nyc-civil-court-brooklyn-md6';
  if (!(await page.$(`#i-${id}`))) {
    const key = await page.evaluate((x) => { const q = [...document.querySelectorAll('.row[data-q]')].find((r) => r.querySelector(`[data-v="${x}"]`) || /Civil Court/.test(r.dataset.q)); return q && q.dataset.q; }, id);
    if (key) { await openRow(page, `q:${key}`); await tap(page, `.row[data-q="${key}"] [data-act="district"][data-v="${id}"]`); }
  }
  await openRow(page, id);
  await tap(page, `#i-${id} [data-act="reader"]`);
  await page.waitForSelector('.reader');
  const rd = await text(page, '.reader');
  check('Brooklyn Civil Court Full details: each rating as published, with its June primary scope', /Ratings, word for word/.test(rd) && /June 11, 2026 primary review/.test(rd) && /Failed to Appear/.test(rd), rd.slice(0, 120));
  check('Brooklyn Civil Court Full details: links the NYC Bar release', !!(await page.$('.reader a[href*="nycbar.org"]')));
  noErrors(page, 'Brooklyn ratings');
  await ctx.close();
}
// #9: a sheet and the Full details hold the keyboard; the ballot behind them is inert.
{
  const { ctx, page } = await newPage();
  await openBallot(page, '80205');
  await tap(page, '[data-act="sheet"][data-s="sources"]');
  await page.waitForSelector('.sheet-panel');
  check('Sheet: the ballot behind it is inert', await page.evaluate(() => document.getElementById('app').inert && document.getElementById('r-bar').inert));
  // From the last control, Tab wraps to the first; from the first, Shift+Tab wraps to the last.
  const FOC = (sc) => `${sc} a[href], ${sc} button:not([disabled]), ${sc} input:not([disabled]), ${sc} textarea`;
  const wraps = async (scope) => {
    const sel = FOC(scope);
    const focusAt = (k) => page.evaluate(([q, i]) => { const els = [...document.querySelectorAll(q)].filter((x) => x.offsetParent !== null); const el = els[i < 0 ? els.length + i : i]; if (el) el.focus(); return els.length; }, [sel, k]);
    const isAt = (k) => page.evaluate(([q, i]) => { const els = [...document.querySelectorAll(q)].filter((x) => x.offsetParent !== null); return document.activeElement === els[i < 0 ? els.length + i : i]; }, [sel, k]);
    if (!(await focusAt(-1))) return false;
    await page.keyboard.press('Tab'); const fwd = await isAt(0);
    await focusAt(0); await page.keyboard.press('Shift+Tab'); const back = await isAt(-1);
    let out = 0;
    for (let i = 0; i < 12; i++) { await page.keyboard.press('Tab'); if (!(await page.evaluate((sc) => !!document.activeElement && !!document.activeElement.closest(sc), scope))) out++; }
    return fwd && back && out === 0;
  };
  check('Sheet: Tab and Shift+Tab wrap inside the sheet', await wraps('.sheet-panel'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check('Sheet: after closing, the ballot is live again', await page.evaluate(() => !document.getElementById('app').inert));
  const id = await page.evaluate(() => document.querySelector('.row[data-item]').dataset.item);
  await openRow(page, id);
  await tap(page, `#i-${id} [data-act="reader"]`);
  await page.waitForSelector('.reader');
  check('Full details: Tab and Shift+Tab wrap inside it', await wraps('.reader'));
  noErrors(page, 'Focus trap');
  await ctx.close();
}
// #10: "Only undecided" drops a decided row on the next move, even on a one-row repaint.
{
  const { ctx, page } = await newPage();
  await openBallot(page, '80205');
  await tap(page, '[data-act="only"]');
  const ids = await page.evaluate(() => [...document.querySelectorAll('#sec-measures .row[data-item]')].slice(0, 2).map((r) => r.dataset.item));
  await openRow(page, ids[0]);
  await tap(page, `#i-${ids[0]} [data-act="pick"][data-v="YES"]`);
  check('Only undecided: the row you just decided stays for a moment', !!(await page.$(`#i-${ids[0]}`)));
  await openRow(page, ids[1]);
  check('Only undecided: opening the next row drops the decided one', !(await page.$(`#i-${ids[0]}`)) && !!(await page.$(`#i-${ids[1]}.is-open`)));
  noErrors(page, 'Only undecided');
  await ctx.close();
}
// #2 and #11: the address lookup checks the state, and a ballot that fails to load after a
// Census match fails cleanly. The Census lookup is answered here, never called.
{
  const { ctx, page } = await newPage();
  const geoFor = (fips, place, cd, upper) => ({ result: { addressMatches: [{ matchedAddress: 'TEST', geographies: {
    States: [{ STATE: fips }], 'Incorporated Places': [{ BASENAME: place }], '119th Congressional Districts': [{ BASENAME: String(cd) }],
    '2024 State Legislative Districts - Upper': [{ BASENAME: String(upper) }] } }] } });
  const answer = geoFor('17', 'Aurora', 14, 25);
  const asked = [];
  await page.route('https://geocoding.geo.census.gov/**', (route) => {
    const u = new URL(route.request().url());
    asked.push(u.searchParams.get('address') || '');
    const cb = u.searchParams.get('callback');
    return route.fulfill({ status: 200, contentType: 'application/javascript', body: `${cb}(${JSON.stringify(answer)})` });
  });
  await openZip(page, '80247');
  await page.waitForSelector('[data-act="choose-place"]');
  await tap(page, '.choose [data-act="addr-open"]');
  await page.fill('#addr-in', 'a test lookup');
  await page.locator('form[data-form="addr"] button[type=submit]').tap();
  await page.waitForSelector('form[data-form="addr"] [role="status"]', { timeout: 8000 }).catch(() => {});
  const msg = await text(page, 'form[data-form="addr"] [role="status"]');
  check('Address: a Census match in Aurora, Illinois does not open Aurora, Colorado', /outside Colorado/.test(msg) && !(await page.$('#plan')), msg);
  check('Address: what you typed stays in the box after a miss', (await page.inputValue('#addr-in').catch(() => '')) === 'a test lookup');
  check('Address: the lookup adds the state and ZIP you entered', asked[0] === 'a test lookup, CO 80247', asked.join(' | '));
  noErrors(page, 'Address in the wrong state');
  await ctx.close();
}
{
  const { ctx, page } = await newPage();
  const geoFor = (fips, place, cd, upper) => ({ result: { addressMatches: [{ matchedAddress: 'TEST', geographies: {
    States: [{ STATE: fips }], 'Incorporated Places': [{ BASENAME: place }], '119th Congressional Districts': [{ BASENAME: String(cd) }],
    '2024 State Legislative Districts - Upper': [{ BASENAME: String(upper) }] } }] } });
  const answer = geoFor('08', 'Aurora', 6, 28);
  await page.route('https://geocoding.geo.census.gov/**', (route) => {
    const cb = new URL(route.request().url()).searchParams.get('callback');
    return route.fulfill({ status: 200, contentType: 'application/javascript', body: `${cb}(${JSON.stringify(answer)})` });
  });
  await page.route('**/data/place-aurora-co.json', (route) => route.fulfill({ status: 503, body: 'down' }));
  await openZip(page, '80247');
  await page.waitForSelector('[data-act="choose-place"]');
  await tap(page, '.choose [data-act="addr-open"]');
  await page.fill('#addr-in', 'a test lookup');
  await page.locator('form[data-form="addr"] button[type=submit]').tap();
  await page.waitForSelector('.zip-err[role="alert"]', { timeout: 8000 }).catch(() => {});
  check('Address: a ballot that fails after the Census match says so', /couldn’t load that ballot/.test(await text(page, '.zip-err')));
  await page.waitForTimeout(300);
  // The browser logs the mocked 503 itself; what must not happen is an error in our code.
  const own = page.errors.filter((e) => !/Failed to load resource/.test(e));
  check('Address then 503: no unhandled error', own.length === 0, own.slice(0, 2).join(' | '));
  page.errors = [];
  await page.unroute('**/data/place-aurora-co.json');
  await openZip(page, '80247');
  await page.waitForSelector('[data-act="choose-place"]');
  await tap(page, '.choose [data-act="addr-open"]');
  await page.fill('#addr-in', 'a test lookup');
  await page.locator('form[data-form="addr"] button[type=submit]').tap();
  await page.waitForSelector('[data-act="setup-done"]', { timeout: 15000 });
  const said = await text(page, '.toast');
  await throughSetup(page);
  check('Address: Aurora, Colorado opens its ballot and answers its districts', /Aurora/.test(await text(page, '.place')) && /Filled in \d+ districts? from your address/.test(said), said);
  noErrors(page, 'Address');
  await ctx.close();
}

// The first page's "Use my street address instead": no ZIP and no ballot yet. Census is answered here.
{
  const { ctx, page } = await newPage();
  const geoFor = (fips, place, cd, upper) => ({ result: { addressMatches: [{ matchedAddress: 'TEST', geographies: {
    States: [{ STATE: fips }], 'Incorporated Places': place ? [{ BASENAME: place }] : [], '119th Congressional Districts': [{ BASENAME: String(cd) }],
    '2024 State Legislative Districts - Upper': [{ BASENAME: String(upper) }] } }] } });
  let answer = geoFor('08', 'Nowhere', 6, 28);
  const asked = [];
  await page.route('https://geocoding.geo.census.gov/**', (route) => {
    const u = new URL(route.request().url());
    asked.push(u.searchParams.get('address') || '');
    return route.fulfill({ status: 200, contentType: 'application/javascript', body: `${u.searchParams.get('callback')}(${JSON.stringify(answer)})` });
  });
  await page.goto(`${BASE}/?today=${TODAY}`);
  await page.waitForSelector('#zip');
  await tap(page, '.front [data-act="addr-open"]');
  const lookUp = async () => {
    await page.fill('#addr-in', 'a test lookup');
    await page.locator('form[data-form="addr"] button[type=submit]').tap();
    await page.waitForSelector('form[data-form="addr"] [role="status"], [data-act="setup-done"], .notice', { timeout: 8000 }).catch(() => {});
  };
  await lookUp();
  check('Address on the first page: a place it can’t settle says so in one line and keeps the ZIP box', (await text(page, 'form[data-form="addr"] [role="status"]')) === 'We couldn’t tell which place that is. Try your ZIP.' && !!(await page.$('#zip')), await text(page, 'form[data-form="addr"] [role="status"]'));
  check('Address on the first page: with no ZIP typed, the address goes as typed', asked[0] === 'a test lookup', asked.join(' | '));
  answer = geoFor('25', 'Cambridge', 7, 2);
  await lookUp();
  check('Address on the first page: a state we don’t cover says so', /We don’t cover Massachusetts yet/.test(await text(page, '.notice')), await text(page, '.notice'));
  await tap(page, '.front [data-act="addr-open"]');
  answer = geoFor('08', 'Aurora', 6, 28);
  await lookUp();
  await page.waitForSelector(SETUP, { timeout: 15000 });
  const said = await text(page, '.toast');
  check('Address on the first page: Aurora, Colorado opens its step 2 with its districts answered', /^Aurora, Colorado/.test(await text(page, '.su-done span')) && /Filled in \d+ districts? from your address/.test(said), `${await text(page, '.su-done span')} | ${said}`);
  await tap(page, SETUP);
  await page.waitForSelector('#plan', { timeout: 15000 });
  check('Address on the first page: the ballot keeps the districts', /Your districts: Congressional District 6/.test(await text(page, '.mast')), await text(page, '.mast .fine'));
  noErrors(page, 'Address on the first page');
  await ctx.close();
}

// Nav review, Oct 20: "N of M decided" walks the page in its own order, from the first thing on it
// (LA's U.S. House question), one row open at a time, and never sticks on a row parked under a tall
// sticky lens bar (the wrapped chips of wide screens make it 117px).
for (const width of [380, 1280]) {
  const { ctx, page } = await newPage({ viewport: { width, height: 900 } });
  await openBallot(page, '90004');
  if (width > 600) await page.addStyleTag({ content: '#lensbar .chips { flex-wrap: wrap; }' });
  const all = await page.evaluate(() => [...document.querySelectorAll('.ledger .row[data-item], .ledger .row[data-q]')].map((e) => e.id));
  await page.evaluate(() => window.scrollTo(0, 0));
  const opened = [];
  let oneAtATime = true;
  for (let i = 0; i < 8; i++) {
    await tap(page, '[data-act="next"]');
    const open = await page.$$eval('.ledger .row.is-open', (els) => els.map((e) => e.id));
    if (open.length !== 1) oneAtATime = false;
    opened.push(open[open.length - 1] || '');
  }
  const idx = opened.map((id) => all.indexOf(id));
  check(`Next at ${width}px: starts at the first thing on the page, the U.S. House question`, /^q-/.test(opened[0]) && (await page.evaluate((id) => !!document.querySelector(`#${id}[data-q^="federal|"]`), opened[0])), opened[0]);
  check(`Next at ${width}px: eight taps open eight different rows, in page order`, new Set(opened).size === 8 && idx.every((v, i) => v >= 0 && (!i || v > idx[i - 1])), opened.join(' > '));
  check(`Next at ${width}px: a jump closes the row that was open`, oneAtATime);
  // A jump into another section from the cheat sheet closes the row left open here, too.
  await tap(page, '[data-act="cheat"]');
  await page.waitForSelector('#cheat');
  const mLine = await page.evaluate(() => { const r = document.querySelector('#cheat tr[data-cs^="ca-prop"]'); return r && r.dataset.cs; });
  if (mLine) await tap(page, `#cheat tr[data-cs="${mLine}"]`);
  const after = await page.$$eval('.ledger .row.is-open', (els) => els.map((e) => e.id));
  check(`Next at ${width}px: a cheat-sheet jump to a measure leaves only that row open`, !!mLine && after.length === 1 && after[0] === `i-${mLine}`, after.join(', '));
  noErrors(page, `Next at ${width}px`);
  await ctx.close();
}

// Review, Oct 20: on Austin, Next opened the folded "Other school districts that touch Austin" races
// one by one (seven taps through Round Rock, Pflugerville and Leander ISD). The fold says "Open only
// if one of them is yours", so Next passes it by while it is closed and goes on to the measures.
{
  const { ctx, page } = await newPage();
  await openBallot(page, '78704');
  await page.evaluate(() => window.scrollTo(0, 0));
  const opened = [];
  for (let i = 0; i < 45; i++) {
    await tap(page, '[data-act="next"]');
    const o = await page.$$eval('.ledger .row.is-open', (els) => els.map((e) => `${e.dataset.fold ? 'fold:' : ''}${e.dataset.item || `q:${e.dataset.q}`}`));
    opened.push(o.join('+'));
    if (o.some((k) => /^tx-austin-prop/.test(k))) break;
  }
  const inFold = opened.filter((k) => k.startsWith('fold:'));
  check('Next on Austin: never opens a race inside the closed "Other school districts" fold', inFold.length === 0, inFold.join(', '));
  check('Next on Austin: goes on past the fold to the measures', opened.some((k) => /^tx-austin-prop/.test(k)) && !(await page.$('.grp.oth [aria-expanded="true"]')), opened.slice(-4).join(' > '));
  noErrors(page, 'Next on Austin');
  await ctx.close();
}

// Walks, Oct 20: a cheat-sheet line for an unanswered district question was dead. It now goes back
// to the ballot with that question open.
{
  const { ctx, page } = await newPage();
  await openBallot(page, '32801');
  await tap(page, '[data-act="cheat"]');
  await page.waitForSelector('#cheat');
  const key = await page.evaluate(() => { const r = document.querySelector('#cheat tr[data-q]'); return r && r.dataset.q; });
  check('Orlando cheat sheet: an unanswered district line is a tap ("Pick your district")', !!key && /Pick your district/.test(await text(page, `#cheat tr[data-q="${key}"]`)) && (await page.getAttribute(`#cheat tr[data-q="${key}"]`, 'data-act')) === 'goto', key || 'no line');
  if (key) {
    await tap(page, `#cheat tr[data-q="${key}"]`);
    check('Orlando cheat sheet: tapping it reopens that question on the ballot', !(await page.$('#cheat')) && !!(await page.$(`.row[data-q="${key}"].is-open`)));
  }
  noErrors(page, 'Cheat sheet district line');
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
