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
async function openBallot(page, zip, query = '') {
  await openZip(page, zip, query);
  await page.waitForSelector('#plan', { timeout: 15000 });
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
  check('Denver: "What if" opens the situations and the basics', /What if/.test(await text(page, '.whatifs')) && /In the booth/.test(await text(page, '.whatifs')));
  await tap(page, '[data-act="open"][data-k="whatif"]');

  // The lens: Papers and guides on by default; a chip adds groups; the sheet lists everyone.
  check('Denver: Papers and guides is on by default', (await page.getAttribute('[data-act="chip"][data-k="papers"]', 'aria-pressed')) === 'true');
  const cov1 = await text(page, '#lens .cov');
  await tap(page, '[data-act="chip"][data-k="progressive"]');
  const cov2 = await text(page, '#lens .cov');
  check('Denver: turning on Progressive groups changes the coverage line', cov1 !== cov2 && /made picks on \d+ of your \d+ choices/.test(cov2), `${cov1} -> ${cov2}`);
  await tap(page, '[data-act="chip"][data-k="progressive"]');
  check('Denver: and off again', (await text(page, '#lens .cov')) === cov1);
  await tap(page, '[data-act="sheet"][data-s="sources"]');
  await page.waitForSelector('.sheet-panel');
  check('Denver: More sources lists every source by lean, each with how we know', (await page.$$('.sgrp')).length >= 2 && /How we know/.test(await text(page, '.sheet-panel')));
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
  check('Denver: the cheat sheet ends, then offers Pass it on as its own step', !(await page.$('#pass')) && !!(await page.$('#cheat [data-act="view"][data-v="pass"]')));
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
  check('Denver link: "Keep them" clears the banner and keeps the picks', !(await fresh.page.$('[data-act="shared-fresh"]')));
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
  await page.waitForSelector('#plan');
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
  check('20001: asks which ward, not which city', /is split across \d+ wards/.test(await text(page, '.choose')));
  await tap(page, '[data-act="choose-place"][data-fk="cp-unsure"]');
  await page.waitForSelector('#plan');
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

/* ---------- judges, the Full read, Pass it on ---------- */
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
  check('Lakewood: Full read opens with the candidates in their own words', !!(await page.$('.reader')) && /in their own words/i.test(await text(page, '.reader')));
  await shot(page, '06-lakewood-reader');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Lakewood: Escape closes the Full read and returns focus', !(await page.$('.reader')) && await page.evaluate((id) => document.activeElement && document.activeElement.dataset.fk === `rd-${id}`, rId));
  await tap(page, '#plan [data-act="view"][data-v="pass"]');
  const pub = await text(page, '#msg-pub');
  check('Pass it on: "I already voted" says thank you', /You voted\. Thank you\./.test(await text(page, '#pass')));
  check('Pass it on: the public message uses official links, never this guide', /(Official election info|Check your registration): https?:\/\//.test(pub) && !pub.includes(new URL(BASE).host), pub.slice(0, 80));
  check('Pass it on: Colorado’s registration and official links are the same URL, given once', (pub.match(/govotecolorado\.gov/g) || []).length === 1, pub);
  check('Pass it on: the public message never carries the county office line', !/Local election office/.test(pub), pub);
  check('Pass it on: the public message leads with Election Day and the mail rule', /^Election Day in Colorado is Tue, Nov 3\. Ballots must be in by 7 PM Tue, Nov 3\./.test(pub), pub.slice(0, 120));
  check('Pass it on: no "12 people" arithmetic', !/12 people/.test(await text(page, '#pass')));
  // Florida counties set their own early-voting days: a county ballot gives its county's window,
  // and a statewide-only ballot calls the state's dates a minimum (Codex round 4).
  for (const [zip, re, label] of [
    ['32801', /Early voting in Orange County runs Mon, Oct 19 through Sun, Nov 1\./, "Pass it on: Orlando gives Orange County's early-voting window"],
    ['32052', /Every Florida county offers early voting Sat, Oct 24 through Sat, Oct 31\. Some counties start earlier or finish later/, "Pass it on: a statewide Florida ballot calls Oct 24 to 31 the counties' minimum"],
    ['60614', /Early voting dates vary by county and run through Mon, Nov 2; check yours\./, "Pass it on: Illinois says early voting dates vary by county (no statewide start)"],
  ]) {
    const fl = await newPage();
    await openBallot(fl.page, zip);
    await tap(fl.page, '#plan [data-act="view"][data-v="pass"]');
    const msg = await text(fl.page, '#msg-pub');
    check(label, re.test(msg), msg.slice(0, 200));
    await fl.ctx.close();
  }
  check('Pass it on: having voted, the friends message starts "I just voted!"', /^I just voted!/.test(await text(page, '#msg-fam')));
  check('Pass it on: the texting study shows, with its caveats one tap away', /Outvote/.test(await text(page, '#pass')) && !!(await page.$('#pass [data-k="study-more"]')));
  check('Pass it on: partisan groups sit beside "examples, not recommendations"', /not recommendations/.test(await text(page, '#pass .ways')) && /On the left/.test(await text(page, '#pass .ways')) && /On the right/.test(await text(page, '#pass .ways')));
  check('Pass it on: the friends message can share the guide', (await text(page, '#msg-fam')).includes(new URL(BASE).host));
  check('Pass it on: no relative "today" in a message someone reads later', !/\btoday\b|\btomorrow\b/i.test(pub));
  await tap(page, '[data-act="tick"][data-k="family"]');
  check('Pass it on: the checklist ticks', (await page.getAttribute('[data-act="tick"][data-k="family"]', 'aria-pressed')) === 'true');
  noErrors(page, 'Lakewood');
  await ctx.close();
}
for (const [day, want] of [['2026-11-03', /^Today is Election Day\. Polls close at 7 PM\.$/], ['2026-11-04', /^Voting has closed/]]) {
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/?today=${day}&now=10:00`);
  await page.fill('#zip', '80226');
  await page.locator('button[type=submit]').tap();
  await page.waitForSelector('#plan');
  check(`Plan on ${day}: ${want}`, want.test(await text(page, '.plan-h')), await text(page, '.plan-h'));
  await ctx.close();
}
{
  const { ctx, page } = await newPage({ colorScheme: 'dark' });
  await openBallot(page, '80226');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('Dark mode: the page goes dark', bg === 'rgb(28, 25, 21)', bg);
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

/* ---------- Pass it on in Washington: statewide links only, never King County's page ---------- */
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
  await tap(page, '#sec-school .grp.oth [data-act="grp"]');
  const shown = (await page.$$('#sec-school [data-fold]')).length;
  check('Austin: opening the line lists them, with "None of these are on my ballot"', shown >= 3 && !!(await page.$('[data-act="notmine-oth"]')), String(shown));
  await tap(page, '[data-act="notmine-oth"]');
  check('Austin: "None of these" takes them all off and folds the line', /none on your ballot/.test(await text(page, '#sec-school .grp.oth')), await text(page, '#sec-school .grp.oth'));
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
  await page.waitForSelector('#plan', { timeout: 15000 });
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
  await page.waitForSelector('#plan', { timeout: 15000 });
  const before = await text(page, '.plan-h');
  await page.clock.runFor(3 * 60_000);
  await page.waitForTimeout(200);
  const after = await text(page, '.plan-h');
  check('Austin on a Pacific-time phone: 6:58 PM Central is still Election Day', /^Today is Election Day\. Polls close at 7 PM\.$/.test(before), before);
  check('Austin on a Pacific-time phone: the open page turns to "Polls closed" after 7 PM Central', /^Polls closed at 7 PM/.test(after), after);
  noErrors(page, 'Polls close on an open page');
  await ctx.close();
}
// Codex r2: a contested judicial race's Full read keeps each rating as published, with its scope and source.
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
  check('Brooklyn Civil Court Full read: each rating as published, with its June primary scope', /Each rating as published/.test(rd) && /June 11, 2026 primary review/.test(rd) && /Failed to Appear/.test(rd), rd.slice(0, 120));
  check('Brooklyn Civil Court Full read: links the NYC Bar release', !!(await page.$('.reader a[href*="nycbar.org"]')));
  noErrors(page, 'Brooklyn ratings');
  await ctx.close();
}
// #9: a sheet and the Full read hold the keyboard; the ballot behind them is inert.
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
  check('Full read: Tab and Shift+Tab wrap inside it', await wraps('.reader'));
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
  await page.route('https://geocoding.geo.census.gov/**', (route) => {
    const cb = new URL(route.request().url()).searchParams.get('callback');
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
  await page.waitForSelector('#plan', { timeout: 15000 });
  check('Address: Aurora, Colorado opens its ballot and answers its districts', /Aurora/.test(await text(page, '.place')) && /Matched \d+ district/.test(await text(page, '.toast')), await text(page, '.toast'));
  noErrors(page, 'Address');
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
