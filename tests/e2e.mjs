/* End-to-end pass at 380px. Uses the Chromium preinstalled at /opt/pw-browsers.
   BASE=http://localhost:4173 node tests/e2e.mjs        (vite preview must be running)
   BASE=https://<deploy>.vercel.app node tests/e2e.mjs  (against production)
   Screenshots land in shots/. Exits non-zero on any failed check or console error. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
const PW = process.env.PW_PATH || '/opt/npm-tools/node_modules/playwright/index.mjs';
const { chromium } = await import(PW);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const BASE = (process.env.BASE || 'http://localhost:4173').replace(/\/$/, '');
const TODAY = process.env.TODAY || '2026-10-16';
const W = 380;

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok, extra }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); };

const browser = await chromium.launch();
async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: W, height: 820 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push(m.text()); });
  page.on('pageerror', (e) => page.errors.push(e.message));
  return { ctx, page };
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
async function shotEl(page, sel, name) {
  const el = await page.$(sel);
  if (!el) return check(`screenshot target ${sel}`, false);
  await el.evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await page.evaluate(() => window.scrollBy(0, -8));
  await page.waitForTimeout(80);
  await shot(page, name);
}
const tap = async (page, sel) => { await page.locator(sel).first().scrollIntoViewIfNeeded(); await page.locator(sel).first().tap(); await page.waitForTimeout(120); };
async function openZip(page, zip) {
  await page.goto(`${BASE}/?today=${TODAY}`);
  await page.fill('#zip', zip);
  await page.locator('button[type=submit]').tap();
  await page.waitForSelector('#plan', { timeout: 15000 });
}
const noSideScroll = async (page, label) => {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  check(`${label}: no sideways page scroll at ${W}px`, w <= W, `scrollWidth ${w}`);
};

/* ---------- Denver 80205 ---------- */
{
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/?today=${TODAY}`);
  await shot(page, '00-start');
  await openZip(page, '80205');
  await shot(page, '01-denver-top');
  await noSideScroll(page, 'Denver');
  check('Denver: plan card shows a countdown', (await page.textContent('.count')).trim() === '18');
  await tap(page, '[data-act="sources"]');
  await page.waitForSelector('.grid-wrap');
  await noSideScroll(page, 'Denver with sources open');
  await shotEl(page, '#sources', '01b-denver-sources-open');
  await shotEl(page, '.grid-wrap', '01c-denver-sources-grid');
  await tap(page, '[data-act="sources"]');

  // Next undecided jumps to the first open item.
  await tap(page, '[data-act="next"]');
  await page.waitForTimeout(150);
  const nextTop = await page.evaluate(() => { const el = document.querySelector('[data-undecided]'); return el ? Math.round(el.getBoundingClientRect().top) : -1; });
  check('Denver: Next undecided brings the first open item into view', nextTop >= 0 && nextTop < 200, `top ${nextTop}`);

  // Filter to one party.
  await tap(page, '[data-act="filter"]');
  await page.waitForSelector('.sheet-panel');
  for (const p of ['R', 'O', 'I']) { if (await page.$(`[data-act="party"][data-p="${p}"]`)) await tap(page, `[data-act="party"][data-p="${p}"]`); }
  await shot(page, '02-denver-filter-sheet');
  await tap(page, '.sheet-panel .btn-block');
  await page.waitForSelector('.offer', { timeout: 5000 }).catch(() => {});
  const offer = await page.$('.offer');
  check('Denver: party filter shows the auto-pick offer', !!offer, offer ? (await offer.textContent()).trim().slice(0, 80) : 'no offer');
  await shotEl(page, '.offer', '03-denver-offer');

  // Accept auto-pick.
  await tap(page, '[data-act="offer-yes"]');
  const autos = await page.$$('.fold-auto');
  check('Denver: auto-picked races say why', autos.length > 0, `${autos.length} auto-picked`);
  await shotEl(page, '.fold-auto', '04-denver-autopicked');

  // Undo one.
  const undoId = await page.locator('[data-act="undo-auto"]').first().getAttribute('data-id');
  await tap(page, '[data-act="undo-auto"]');
  const reopened = await page.$(`article#i-${undoId}`);
  check('Denver: Undo reopens that race', !!reopened, undoId);
  await shotEl(page, `#i-${undoId}`, '05-denver-undo');

  // Add a note.
  const noteId = undoId;
  await tap(page, `#i-${noteId} [data-act="note"]`);
  await page.fill(`textarea[data-note="${noteId}"]`, 'Ask a friend about this one');
  await page.locator(`textarea[data-note="${noteId}"]`).blur();
  await page.waitForTimeout(400);
  await shotEl(page, `#i-${noteId}`, '06-denver-note');

  // Pick a measure so the link carries a YES/NO too.
  await tap(page, '#i-co-amendment-87 [data-act="pick"][data-v="YES"]');

  // Save link.
  await tap(page, '[data-act="save-open"]');
  const url = await page.inputValue('.save-url');
  check('Denver: save link is versioned and compact', /#v1~CO~denver-co~80205~/.test(url) && url.length < 2000, `${url.length} chars`);
  await shotEl(page, '#cheat', '07-denver-cheat-save');
  const decidedBefore = (await page.textContent('.bar-txt')).trim();

  // Print stylesheet.
  await page.emulateMedia({ media: 'print' });
  await page.screenshot({ path: path.join(SHOTS, '08-denver-print.png'), fullPage: true });
  const printVisible = await page.evaluate(() => getComputedStyle(document.getElementById('r-print')).display !== 'none' && getComputedStyle(document.getElementById('app')).display === 'none');
  check('Denver: print shows only the cheat sheet', printVisible);
  await page.pdf({ path: path.join(SHOTS, 'denver-cheat-sheet.pdf'), format: 'Letter' }).catch(() => {});
  await page.emulateMedia({ media: 'screen' });
  check('Denver: no console errors', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));

  // Reopen the link in a fresh browser (no saved picks).
  const fresh = await newPage();
  await fresh.page.goto(url.replace(/^https?:\/\/[^/]+/, BASE));
  await fresh.page.waitForSelector('#plan', { timeout: 15000 });
  await fresh.page.waitForTimeout(300);
  const toastText = await fresh.page.textContent('.toast').catch(() => '');
  const decidedAfter = (await fresh.page.textContent('.bar-txt')).trim();
  check('Denver: reopening the link restores the picks', decidedAfter === decidedBefore, `${decidedBefore} -> ${decidedAfter}; toast: ${toastText}`);
  const noteBack = await fresh.page.textContent('#cheat');
  check('Denver: the note comes back with the link', noteBack.includes('Ask a friend about this one'));
  await shotEl(fresh.page, '#cheat', '09-denver-reopened');
  check('Denver reopen: no console errors', fresh.page.errors.length === 0, fresh.page.errors.slice(0, 3).join(' | '));

  // Same device, different picks: ask before overwriting.
  await page.goto(`${BASE}/?today=${TODAY}`);
  await page.waitForSelector('#plan');
  await tap(page, '#i-co-amendment-87 [data-act="change"]').catch(() => {});
  await page.goto(url.replace(/^https?:\/\/[^/]+/, BASE).replace(/\.([a-z0-9]{5})Y(\.|~)/, '.$1N$2'));
  await page.waitForSelector('#plan');
  const ask = await page.$('[data-act="restore-yes"]');
  check('Denver: a link with different picks asks before overwriting', !!ask);
  if (ask) await shotEl(page, '.notice-strong', '10-denver-ask-overwrite');
  await fresh.ctx.close();
  await ctx.close();
}

/* ---------- Austin 78702 ---------- */
{
  const { ctx, page } = await newPage();
  await openZip(page, '78702');
  await noSideScroll(page, 'Austin');
  const q = page.locator('.q', { hasText: 'Austin City Council' });
  check('Austin: asks which council district', (await q.count()) === 1);
  await q.first().scrollIntoViewIfNeeded();
  await shotEl(page, `#${await q.first().getAttribute('id')}`, '11-austin-council-question');
  await q.locator('.choice', { hasText: 'District 3' }).first().tap();
  await page.waitForTimeout(200);
  const d3 = await page.$('#i-tx-austin-council-3');
  const d1 = await page.$('#i-tx-austin-council-1');
  check('Austin: District 3 race shows, District 1 hides', !!d3 && !d1);
  await shotEl(page, '#i-tx-austin-council-3', '12-austin-council-3');

  const unopp = page.locator('#sec-judicial .unopp .disc');
  check('Austin: unopposed races fold to one line', (await unopp.count()) === 1, (await unopp.first().textContent()).trim());
  await shotEl(page, '#sec-judicial .unopp', '13-austin-unopposed-folded');
  await unopp.first().tap();
  await page.waitForTimeout(150);
  const items = await page.$$('#sec-judicial .unopp-list li');
  check('Austin: unopposed fold opens to a list', items.length > 3, `${items.length} races`);
  await shotEl(page, '#sec-judicial .unopp', '14-austin-unopposed-open');
  check('Austin: no console errors', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
  await ctx.close();
}

/* ---------- Atlanta 30303 ---------- */
{
  const { ctx, page } = await newPage();
  await openZip(page, '30303');
  await noSideScroll(page, 'Atlanta');
  const txt = await page.textContent('#plan');
  check('Atlanta: says statewide only, honestly', txt.includes('We only have statewide races for your area so far.'));
  check('Atlanta: links an official ballot lookup', !!(await page.$('#plan .plan-sec a')));
  await shot(page, '15-atlanta-top');
  const sections = await page.$$eval('.sec', (els) => els.map((e) => e.dataset.sec));
  check('Atlanta: statewide sections only', !sections.includes('city') && !sections.includes('county'), sections.join(','));
  await shotEl(page, '#sec-federal', '16-atlanta-ballot');
  check('Atlanta: no console errors', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
  await ctx.close();
}

/* ---------- uncovered state ---------- */
{
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/?today=${TODAY}`);
  await page.fill('#zip', '02139');
  await page.locator('button[type=submit]').tap();
  await page.waitForSelector('.notice', { timeout: 8000 });
  check('Uncovered state: points to vote.gov', (await page.textContent('.notice')).includes('Vote.gov'));
  await shot(page, '17-uncovered');
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
