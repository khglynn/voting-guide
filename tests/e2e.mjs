/* End-to-end pass at 380px, using the repo's own playwright (npm ci, then npx playwright install chromium).
   BASE=http://localhost:4173 node tests/e2e.mjs        (vite preview must be running)
   BASE=https://<deploy>.vercel.app node tests/e2e.mjs  (a Vercel preview or production)
   SHOTS_DIR=...   where screenshots go (default .tmp/e2e-shots, gitignored; shots/ holds the committed reference set)
   VERCEL_AUTOMATION_BYPASS_SECRET=...  only if Deployment Protection is on for the deployment under test
   Exits non-zero on any failed check or console error. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PW_PATH || 'playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.resolve(process.env.SHOTS_DIR || path.join(ROOT, '.tmp', 'e2e-shots'));
fs.mkdirSync(SHOTS, { recursive: true });
const BASE = (process.env.BASE || 'http://localhost:4173').replace(/\/$/, '');
const TODAY = process.env.TODAY || '2026-10-16';
const W = 380;
const BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '';

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok, extra }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); };

const browser = await chromium.launch();
async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: W, height: 820 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
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
async function shotEl(page, sel, name, above = 8) {
  const el = await page.$(sel);
  if (!el) return check(`screenshot target ${sel}`, false);
  await el.evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await page.evaluate((y) => window.scrollBy(0, -y), above);
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
/* No visible block in the plan card runs past about 40 words. */
async function planWalls(page) {
  return page.evaluate(() => {
    const out = [];
    document.querySelectorAll('#plan p, #plan li, #plan dd, #plan .fact-line').forEach((el) => {
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

/* ---------- Denver 80205 ---------- */
{
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/?today=${TODAY}`);
  await shot(page, '00-start');
  await openZip(page, '80205');
  await shot(page, '01-denver-top');
  await noSideScroll(page, 'Denver');
  check('Denver: plan card shows a countdown', (await page.textContent('.count')).trim() === '18');
  const walls = await planWalls(page);
  check('Denver: no plan-card paragraph over 40 words by default', walls.length === 0, walls.join(' | '));
  check('Denver: nothing visible is set in all caps', (await upperCased(page)).length === 0, (await upperCased(page)).join(' | '));

  // The sources line opens the Filter shelf at the sources section, focus on its heading.
  const lineBefore = (await page.textContent('#sources')).replace(/\s+/g, ' ').trim();
  check('Denver: sources show as one compact line', /^Endorsements from \d+ sources? Change$/.test(lineBefore), lineBefore);
  await tap(page, '[data-act="sources"]');
  await page.waitForSelector('.sheet-panel #flt-src');
  // 2026-10-19: this check failed once in three runs because focus lands a moment after the shelf opens. Wait for it.
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'flt-src-h', null, { timeout: 2000 }).catch(() => {});
  const at = await page.evaluate(() => {
    const bd = document.querySelector('.sheet-bd'); const h = document.getElementById('flt-src-h');
    return { focus: document.activeElement && document.activeElement.id, top: Math.round(h.getBoundingClientRect().top - bd.getBoundingClientRect().top) };
  });
  check('Denver: sources line opens the shelf at the sources section', at.focus === 'flt-src-h' && at.top >= 0 && at.top < 80, JSON.stringify(at));
  check('Denver: "Only candidates my sources endorsed" sits in the sources section', !!(await page.$('#flt-src [data-act="f-endorsed"]')));
  await shot(page, '01b-denver-sources-shelf');
  check('Denver: shelf has nothing in all caps', (await upperCased(page)).length === 0, (await upperCased(page)).join(' | '));
  // Turn one default source off; the save link must carry it.
  const offId = await page.locator('#flt-src [data-act="src"][aria-checked="true"]').first().getAttribute('data-id');
  await tap(page, `#flt-src [data-act="src"][data-id="${offId}"]`);
  check('Denver: a source toggles off in the shelf', (await page.getAttribute(`#flt-src [data-act="src"][data-id="${offId}"]`, 'aria-checked')) === 'false', offId);
  await tap(page, '[data-act="grid-open"]');
  await page.waitForSelector('.sheet-grid .grid-wrap');
  await noSideScroll(page, 'Denver with the side-by-side grid open');
  await shot(page, '01c-denver-sources-grid');
  await tap(page, '[data-act="grid-close"]');
  check('Denver: Back from the grid returns to the sources section', !!(await page.$('.sheet-panel #flt-src')) && !(await page.$('.sheet-grid')));
  await tap(page, '[data-fk="flt-done"]');
  const lineAfter = (await page.textContent('#sources')).replace(/\s+/g, ' ').trim();
  check('Denver: the line counts one fewer source', lineAfter !== lineBefore, `${lineBefore} -> ${lineAfter}`);

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
  await tap(page, '[data-fk="flt-done"]');
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

  const yn = await page.$$eval('#i-co-amendment-87 .yn-label', (els) => els.map((e) => e.textContent.trim() + (e.querySelector('strong') ? '*' : '')));
  check('Denver: measure choices read "A yes vote means" with yes in bold', yn[0] === 'A yes vote means*' && yn[1] === 'A no vote means*', yn.join(' | '));
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
  check('Denver: print has nothing in all caps', (await upperCased(page)).length === 0, (await upperCased(page)).join(' | '));
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
  const freshLine = (await fresh.page.textContent('#sources')).replace(/\s+/g, ' ').trim();
  await tap(fresh.page, '[data-act="sources"]');
  await fresh.page.waitForSelector('#flt-src');
  const offBack = await fresh.page.getAttribute(`#flt-src [data-act="src"][data-id="${offId}"]`, 'aria-checked');
  check('Denver: the link restores source choices', freshLine === lineAfter && offBack === 'false', `${freshLine}; ${offId}=${offBack}`);
  await tap(fresh.page, '[data-fk="flt-done"]');
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
  const aWalls = await planWalls(page);
  check('Austin: no plan-card paragraph over 40 words by default', aWalls.length === 0, aWalls.join(' | '));
  const booth = (await page.textContent('#plan .fact:has(dt:text-is("In the booth")) .fact-v')).replace(/\s+/g, ' ').trim();
  check('Austin: booth rules read as one short line', booth.startsWith('Notes allowed') && booth.endsWith('Phones not allowed'), booth);
  await shot(page, '10b-austin-plan');
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

/* ---------- Spokane 99201 (statewide only; Atlanta and Seattle got local data Oct 17) ---------- */
{
  const { ctx, page } = await newPage();
  await openZip(page, '99201');
  await noSideScroll(page, 'Spokane');
  const txt = await page.textContent('#plan');
  check('Spokane: says statewide only, honestly', txt.includes('We only have statewide races for your area so far.'));
  check('Spokane: links an official ballot lookup', !!(await page.$('#plan .plan-sec a')));
  const gWalls = await planWalls(page);
  check('Spokane: no plan-card paragraph over 40 words by default', gWalls.length === 0, gWalls.join(' | '));
  await shot(page, '15-spokane-top');
  const sections = await page.$$eval('.sec', (els) => els.map((e) => e.dataset.sec));
  check('Spokane: statewide sections only', !sections.includes('city') && !sections.includes('county'), sections.join(','));
  await shotEl(page, '.sec', '16-spokane-ballot');
  check('Spokane: no console errors', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
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

/* ---------- ranked choice: Portland 97214, City Council District 3 (3 winners, rank up to 6) ---------- */
const panelNames = (page, card) => page.$$eval(`${card} .rank-row .rank-nm`, (els) => els.map((e) => e.textContent.replace(/^\s*\d+(st|nd|rd|th):\s*/, '').trim()));
const noEmDash = (s) => !/—/.test(s);
{
  const { ctx, page } = await newPage();
  await openZip(page, '97214');
  await noSideScroll(page, 'Portland');
  const q = page.locator('.q', { hasText: 'Portland City Council' });
  check('Portland: asks which council district', (await q.count()) === 1);
  await q.locator('.choice', { hasText: 'District 3' }).first().tap();
  await page.waitForTimeout(200);
  const card = '#i-portland-council-3';
  check('Portland: District 3 race shows, District 4 hides', !!(await page.$(card)) && !(await page.$('#i-portland-council-4')));
  const head = (await page.textContent(`${card} .rcv`)).replace(/\s+/g, ' ').trim();
  check('Portland: header says rank up to 6, three people win', head.includes('Ranked choice: rank up to 6.') && head.includes('Three people win.'), head.slice(0, 90));
  check('Portland: header links the official count rules', (await page.getAttribute(`${card} .rcv a`, 'href') || '').includes('multco.us'));
  const cardText = await page.textContent(card);
  check('Portland: no "mark up to" wording on a ranked race', !/mark up to/i.test(cardText));
  check('Portland: ranked card has no em dashes', noEmDash(cardText));

  // Rank three in a row: each tap takes the next rank.
  await tap(page, `${card} [data-act="rank"][data-v="Steve Novick"]`);
  await tap(page, `${card} [data-act="rank"][data-v="Tiffany Koyama Lane"]`);
  const nextLabel = (await page.textContent(`${card} [data-act="rank"][data-v="Kellie Torres"]`)).trim();
  check('Portland: an unranked candidate offers the next rank', nextLabel === 'Rank Torres 3rd', nextLabel);
  await tap(page, `${card} [data-act="rank"][data-v="Kellie Torres"]`);
  let order = await panelNames(page, card);
  check('Portland: three taps rank three candidates in order', order.join('|') === 'Steve Novick|Tiffany Koyama Lane|Kellie Torres', order.join(' | '));
  check('Portland: a ranked candidate shows their rank', (await page.textContent(`${card} [data-act="rank"][data-v="Tiffany Koyama Lane"]`)).trim().startsWith('Your 2nd: Lane'));
  await shotEl(page, card, 'rcv-portland-open', 64);
  await shotEl(page, `${card} .rank-panel`, 'rcv-portland-ranking', 64);
  check('Portland: ranked race stays open until Done ranking', !!(await page.$(`article${card}[data-undecided]`)));

  // Tap the 2nd again: they come off and the 3rd moves up.
  await tap(page, `${card} [data-act="rank"][data-v="Tiffany Koyama Lane"]`);
  order = await panelNames(page, card);
  check('Portland: removing the 2nd renumbers the rest', order.join('|') === 'Steve Novick|Kellie Torres', order.join(' | '));
  check('Portland: the old 3rd now reads as 2nd', (await page.textContent(`${card} [data-act="rank"][data-v="Kellie Torres"]`)).trim().startsWith('Your 2nd: Torres'));

  // Move up, by keyboard: Enter on the button, focus stays with the row.
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
  const small = await page.$$eval(`${card} .rank-panel button, ${card} [data-act="rank"]`, (els) => els.filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.height < 44 || r.width < 44); }).length);
  check('Portland: ranking controls are at least 44px', small === 0, `${small} too small`);

  // A note, then Done ranking folds it to "1. Name, 2. Name, ...".
  await tap(page, `${card} [data-act="note"]`);
  await page.fill(`textarea[data-note="portland-council-3"]`, 'Check the OPB explainer');
  await page.locator(`textarea[data-note="portland-council-3"]`).blur();
  await page.waitForTimeout(300);
  await tap(page, `${card} [data-act="rdone"]`);
  const fold = (await page.textContent(`${card} .fold-v`)).trim();
  check('Portland: decided race folds to its ranks in order', fold === '1. Angelita Morillo, 2. Steve Novick, 3. Kellie Torres', fold);
  await shotEl(page, card, 'rcv-portland-decided', 64);

  // Cheat sheet lists the ranks in order, ready to copy onto the ballot.
  const cs = await page.$$eval('#cheat tr[data-cs="portland-council-3"] .cs-ranks li', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  check('Portland: cheat sheet shows the ranks in order', cs.join('|') === '1st Angelita Morillo|2nd Steve Novick|3rd Kellie Torres', cs.join(' | '));
  check('Portland: cheat sheet notes the rank limit and keeps the note', /Ranked choice: rank up to 6/.test(await page.textContent('#cheat tr[data-cs="portland-council-3"]')) && (await page.textContent('#cheat')).includes('Check the OPB explainer'));
  await shotEl(page, '#cheat tr[data-cs="portland-council-3"]', 'rcv-portland-cheat', 120);
  await page.emulateMedia({ media: 'print' });
  const printRanks = await page.$$eval('#r-print tr[data-cs="portland-council-3"] .cs-ranks li', (els) => els.length);
  check('Portland: print lists the ranks too', printRanks === 3, `${printRanks}`);
  check('Portland: print has nothing in all caps', (await upperCased(page)).length === 0, (await upperCased(page)).join(' | '));
  await page.emulateMedia({ media: 'screen' });

  // Filters still work, and never auto-pick a ranked race: with only one source on and
  // "only endorsed" set, County Chair shows one candidate but stays open.
  await tap(page, '[data-act="sources"]');
  await page.waitForSelector('#flt-src');
  await tap(page, '[data-act="src-none"]');
  for (const g of await page.$$eval('#flt-src [data-k^="srcg-"][aria-expanded="false"]', (els) => els.map((e) => e.dataset.k))) await tap(page, `#flt-src [data-k="${g}"]`);
  await tap(page, '#flt-src [data-act="src"][data-id="portland-metro-chamber"]');
  await tap(page, '[data-act="f-endorsed"]');
  await tap(page, '[data-fk="flt-done"]');
  if (await page.$('[data-act="offer-yes"]')) await tap(page, '[data-act="offer-yes"]');
  const chairCands = await page.$$eval('#i-multnomah-chair .cand-c', (els) => els.length);
  const chairOpen = !!(await page.$('article#i-multnomah-chair[data-undecided]')) && !(await page.$('#i-multnomah-chair .fold-auto'));
  check('Portland: filters narrow a ranked race but never auto-pick it', chairCands === 1 && chairOpen, `${chairCands} shown, open ${chairOpen}`);
  await tap(page, '[data-act="sources"]');
  await page.waitForSelector('#flt-src');
  await tap(page, '[data-act="f-endorsed"]');
  await tap(page, '[data-act="src-default"]');
  await tap(page, '[data-fk="flt-done"]');

  // Save link: v2 carries the ranks; a fresh browser gets them back in order.
  await tap(page, '[data-act="save-open"]');
  const url = await page.inputValue('.save-url');
  check('Portland: save link is v2 when it holds a ranking', /#v2~OR~portland-or~97214~/.test(url) && url.length < 2000, `${url.length} chars`);
  const decidedBefore = (await page.textContent('.bar-txt')).trim();
  check('Portland: no all caps', (await upperCased(page)).length === 0, (await upperCased(page)).join(' | '));
  check('Portland: no console errors', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
  const fresh = await newPage();
  await fresh.page.goto(url.replace(/^https?:\/\/[^/]+/, BASE));
  await fresh.page.waitForSelector('#plan', { timeout: 15000 });
  await fresh.page.waitForTimeout(300);
  const back = (await fresh.page.textContent('#i-portland-council-3 .fold-v').catch(() => '')).trim();
  check('Portland: reopening the link restores the ranks in order', back === fold, back);
  check('Portland: the link restores the progress count', (await fresh.page.textContent('.bar-txt')).trim() === decidedBefore);
  check('Portland: the note comes back with the link', (await fresh.page.textContent('#cheat')).includes('Check the OPB explainer'));
  await tap(fresh.page, '#i-portland-council-3 [data-act="change"]');
  order = await panelNames(fresh.page, '#i-portland-council-3');
  check('Portland: Change reopens the ranking for editing', order.join('|') === 'Angelita Morillo|Steve Novick|Kellie Torres', order.join(' | '));
  check('Portland reopen: no console errors', fresh.page.errors.length === 0, fresh.page.errors.slice(0, 3).join(' | '));
  await fresh.ctx.close();
  await ctx.close();
}

/* ---------- ranked choice: DC Ward 1 (20010), four candidates, rank up to 5 ---------- */
{
  const { ctx, page } = await newPage();
  await openZip(page, '20010');
  await noSideScroll(page, 'DC Ward 1');
  const card = '#i-dc-ward-1-council';
  const head = (await page.textContent(`${card} .rcv`)).replace(/\s+/g, ' ').trim();
  check('DC Ward 1: header says rank up to 5, one person wins', head.includes('Ranked choice: rank up to 5.') && head.includes('One person wins.'), head.slice(0, 80));
  check('DC Ward 1: says the ballot adds a write-in line', (await page.textContent(`${card} .rank-empty`)).includes('write-in'));
  const names = await page.$$eval(`${card} [data-act="rank"]`, (els) => els.map((e) => e.dataset.v));
  check('DC Ward 1: four candidates to rank', names.length === 4, names.join(', '));
  for (const n of names) await tap(page, `${card} [data-act="rank"][data-v="${n}"]`);
  const order = await panelNames(page, card);
  check('DC Ward 1: all four ranked in tap order', order.join('|') === names.join('|'), order.join(' | '));
  check('DC Ward 1: full ranking stays open to reorder', (await page.textContent(`${card} .rank-panel`)).includes('All 4 ranked.') && !!(await page.$(`${card} [data-act="rdone"]`)));
  await shotEl(page, `${card} .rank-panel`, 'rcv-dc-ward1-open', 64);
  await tap(page, `${card} [data-act="rdone"]`);
  const fold = (await page.textContent(`${card} .fold-v`)).trim();
  check('DC Ward 1: folds to 1. through 4.', fold === names.map((n, i) => `${i + 1}. ${n}`).join(', '), fold);
  const al = (await page.textContent('#i-dc-council-at-large .rcv')).replace(/\s+/g, ' ');
  check('DC at-large: ranked, two win, one vote counts', al.includes('rank up to 5.') && al.includes('Two people win.') && al.includes('Your ballot counts once'), al.trim().slice(0, 120));
  check('DC Ward 1: council chair stays pick-one', !(await page.$('#i-dc-council-chair .rcv')) && !!(await page.$('#i-dc-council-chair [data-act="pick"]')));
  check('DC Ward 1: no console errors', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
  await ctx.close();
}

/* ---------- an old v1 link, saved from the live guide before ranked choice ----------
   DC Ward 1: Ward 1 council and Mayor were pick-one then (both ranked now), at-large had two
   "mark up to 2" seats, Chair is still pick-one, plus a note. */
{
  const OLD = '#v1~DC~dc-ward-1~20010~l0g49h8j.it941rdf.3z3i9P.ik2ysP.1rq6ag1n~~l0g49T2xkIGxpbmsgbm90ZQ~';
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/?today=${TODAY}${OLD}`);
  await page.waitForSelector('#plan', { timeout: 15000 });
  await page.waitForTimeout(300);
  const toastText = (await page.textContent('.toast').catch(() => '')) || '';
  check('Old v1 link: restores', /^Restored 3 picks/.test(toastText.trim()), toastText.trim());
  const w1 = (await page.textContent('#i-dc-ward-1-council .fold-v').catch(() => '')).trim();
  check('Old v1 link: a pick-one choice comes back as the 1st choice', w1 === '1. Aparna Raj', w1);
  const mayor = (await page.textContent('#i-dc-mayor .fold-v').catch(() => '')).trim();
  check('Old v1 link: Mayor pick comes back as the 1st choice', mayor === '1. Rhonda Hamilton', mayor);
  const chair = (await page.textContent('#i-dc-council-chair .fold-v').catch(() => '')).trim();
  check('Old v1 link: a pick-one race restores as before', chair.startsWith('Phil Mendelson'), chair);
  check('Old v1 link: at-large seat marks reopen the race to rank', !!(await page.$('article#i-dc-council-at-large[data-undecided]')) && !(await page.$('#i-dc-council-at-large .rank-row')));
  check('Old v1 link: the note comes back', (await page.textContent('#cheat')).includes('Old link note'));
  check('Old v1 link: no console errors', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
