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
/* The copy pass (Oct 19): the paywall note's words, from the copy table. */
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
/* The first page: steps 1 and 2 together. A complete ZIP looks itself up as it's typed. */
async function openZip(page, zip, query = '') {
  await page.goto(`${BASE}/?today=${TODAY}${query}`);
  await page.waitForSelector('#zip');
  await page.fill('#zip', zip);
}
/* The fill switch starts on for a new ballot (Kevin, Oct 20). Checks that aren't about the fill turn it
   off first, so they see the ballot as it always was. */
const FILL_SW = '#setup [data-act="setup-fill"]';
async function fillOff(page) {
  // A ZIP still looking itself up repaints step 2 when it lands, which can swap the switch out from under
  // a tap (CI, Oct 20): try again until it reads off.
  for (let i = 0; i < 4; i++) {
    if ((await page.getAttribute(FILL_SW, 'aria-checked').catch(() => null)) !== 'true') return;
    await tap(page, FILL_SW).catch(() => page.waitForTimeout(200));
  }
}
/* "Show my ballot", with both switches off, shows the ballot as it always was (it waits for the
   ZIP's lookup itself). A ballot already showing needs nothing. */
async function plainSetup(page) {
  await fillOff(page);
  await tap(page, '[data-act="setup-done"]');
}
async function throughSetup(page) {
  await page.waitForSelector('#plan, [data-act="setup-done"]', { timeout: 15000 });
  if (!(await page.$('#plan'))) await plainSetup(page);
  await page.waitForSelector('#plan', { timeout: 15000 });
}
async function openBallot(page, zip, query = '') {
  await openZip(page, zip, query);
  await throughSetup(page);
  await page.waitForTimeout(150);
}
/* The ballot's Edit sheet ("Endorsements: ... · Edit"): step 2's controls. Its Done (data-fk sheet-x) applies
   the two switches. */
async function edit(page) { await tap(page, '[data-act="picks"]'); await page.waitForSelector('.sheet-panel.picks'); }
async function editFill(page) {
  await edit(page);
  await tap(page, '.sheet-panel [data-act="setup-fill"]');
  const n = Number(((await text(page, '.sheet-panel [data-act="setup-fill"] small')).match(/^(\d+)/) || [])[1] || 0);
  await tap(page, '.sheet-panel [data-fk="sheet-x"]');
  return n;
}
/* The menu: a sheet the bar's "☰ N of M" opens, and from 1180px a rail in the left margin too. */
async function menu(page) { await tap(page, '.foot [data-act="toc"]'); await page.waitForSelector('.sheet-panel.toc'); }
/* The menu's "Next up": the rail's where it shows, else the sheet's. */
async function next(page) {
  if (await page.$('.rail [data-act="next"]')) { await tap(page, '.rail [data-act="next"]'); return; }
  await menu(page);
  await tap(page, '.sheet-panel [data-act="next"]');
}
const focusedFk = (page) => page.evaluate(() => document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fk || '' : '');
const linkHere = (url) => url.replace(/^https?:\/\/[^/]+/, BASE).replace('/#', `/?today=${TODAY}#`);
const text = async (page, sel) => ((await page.textContent(sel).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
/* Motion (Oct 20): a jump glides for about a third of a second and a sheet slides away in a fifth;
   under "Hide races I've decided" a decided row waits a beat (data-beat), then folds away.
   Wait until the page has stopped scrolling and nothing is on its way out. */
const settle = (page) => page.evaluate(() => new Promise((res) => {
  let last = -1, same = 0;
  const t0 = performance.now();
  const f = () => {
    const y = window.scrollY;
    same = y === last && !document.querySelector('.sheet-ghost, .ob-gone, .trust .gone, .row-gone, .sec-gone, [data-beat]') ? same + 1 : 0;
    last = y;
    if (same >= 4 || performance.now() - t0 > 4000) res(); else requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
}));
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
const SETUP = '[data-act="setup-done"]';
/* What a lookup in Congress District 6 and Senate District 28 sets on Aurora's ballot (the mocks below). */
const AURORA_SET = 'Set from your address: U.S. House of Representatives, District 6 · Regent of the University of Colorado, District 6.';
const savedVG = (page) => page.evaluate(() => localStorage.getItem('vg2'));
{
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/?today=${TODAY}`);
  await page.waitForSelector('#zip');
  await shot(page, '00-start');
  await page.fill('#zip', '802');
  await tap(page, SETUP);
  check('Start: a short ZIP says what is wrong', /5 digits/.test(await text(page, '.zip-err')) && (await focusedFk(page)) === 'zip', `${await text(page, '.zip-err')} / ${await focusedFk(page)}`);
  await page.fill('#zip', '8020');
  check('Start: typing again takes the message away', !(await page.$('.zip-err')));
  await noSideScroll(page, 'Start');
  noErrors(page, 'Start');
  await ctx.close();
}

/* ---------- the first page (Oct 20, round 3): steps 1 and 2 together from the start ---------- */
{
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/?today=${TODAY}`);
  await page.waitForSelector('#zip');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => /\d+ cities/.test(document.querySelector('[data-fk="browse"]')?.textContent || ''), null, { timeout: 15000 });
  await shot(page, '00b-first-page');
  check('First page: the kicker says voting is underway, with Election Day from the data', (await text(page, '.front .dateline')) === 'Voting is underway in every state. Election Day is Tue, Nov 3.', await text(page, '.front .dateline'));
  check('First page: the headline is Kevin’s line', (await text(page, '.front h1')) === 'Quickly make your voting plan.');
  const ticks = await page.$$eval('.ticks li', (els) => els.map((e) => e.textContent.trim()));
  check('First page: three ticked lines', ticks.join('|') === 'Plain English|Full local details|Pick by endorsements or party', ticks.join('|'));
  check('First page: steps 1 and 2 show together before any ZIP, with one "Show my ballot" and no Next', (await text(page, 'label[for="zip"]')) === '1Where do you vote?' && (await text(page, '#su-h')) === '2Pick by endorsements or party'
    && (await text(page, SETUP)) === 'Show my ballot' && (await page.$$('.front button.bigbtn')).length === 1 && !(await page.$('form[data-form="zip"] button')), `${await text(page, 'label[for="zip"]')} | ${await text(page, '#su-h')}`);
  check('First page: steps 1 and 2 sit on the pad’s sheet, with "Show my ballot" at its foot', !!(await page.$('.pad.door > .sheet-top')) && !!(await page.$('.pad.door #zip')) && !!(await page.$('.pad.door #su-h')) && !!(await page.$(`.pad.door > ${SETUP}`)));
  const pressed = (k) => page.getAttribute(`#setup [data-act="chip"][data-k="${k}"]`, 'aria-pressed');
  check('First page: before a ZIP, Newspapers and guides is on, the groups off, no party, no counts', (await pressed('papers')) === 'true' && (await pressed('progressive')) === 'false' && (await pressed('conservative')) === 'false'
    && (await text(page, '#setup [data-fk="chip-party"]')) === 'A party' && !(await page.$('.su-cov')));
  check('First page: the switches read "Fill in my ballot with their picks" (on to start) and "Hide races I’ve decided" (off)', (await text(page, '[data-act="setup-fill"] b')) === 'Fill in my ballot with their picks' && (await text(page, '[data-act="setup-only"] b')) === 'Hide races I’ve decided'
    && (await page.getAttribute('[data-act="setup-fill"]', 'aria-checked')) === 'true' && (await page.getAttribute('[data-act="setup-only"]', 'aria-checked')) === 'false');
  check('First page: before a ZIP, the fill switch says what it does', (await text(page, '[data-act="setup-fill"] small')) === 'Fills the races where they agree. Races where picks split stay open.', await text(page, '[data-act="setup-fill"] small'));
  check('First page: "Use my address for a more exact ballot", on one line at phone width', (await text(page, '.front [data-act="addr-open"]')) === 'Use my address for a more exact ballot'
    && (await page.$eval('.front [data-act="addr-open"]', (e) => { const r = document.createRange(); r.selectNodeContents(e); return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size; })) === 1, await text(page, '.front [data-act="addr-open"]'));
  const fine = await page.$$eval('.front .door-foot .foot-line', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  const cities = new Set(Object.entries(await page.evaluate(() => fetch('/data/index.json').then((r) => r.json()).then((i) => i.places))).map(([id, p]) => (p.state === 'DC' ? 'DC' : /^nyc-/.test(id) ? 'NYC' : id))).size;
  check('First page: the small print counts cities from the index (DC and NYC count once) and names Kevin once, with the coffee link in the same paragraph', fine.length === 1 && fine[0] === `Covers ${cities} cities where Kevin HG’s friends live. How this guide works · Report a problem · Request a city · Buy Kevin a thank-you coffee`, `${fine.join(' / ')} (index says ${cities})`);
  check('First page: Kevin HG links to kevinhg.com, and only "thank-you coffee" links out (Kevin, Oct 21)', (await text(page, '.door-foot .fine a[href="https://kevinhg.com"]')) === 'Kevin HG' && (await text(page, '.door-foot .fine a[href="https://buymeacoffee.com/kevinhg"]')) === 'thank-you coffee');
  check('First page: "How this guide works" is folded in the same line, and the two forms are plain links', (await text(page, '.door-foot #how-h')) === 'How this guide works' && (await page.getAttribute('.door-foot [data-k="how"]', 'aria-expanded')) === 'false' && /entry\.90887649=First\+page/.test((await page.getAttribute('.door-foot [data-fk="help-report"]', 'href')) || '') && /Please\+add\+my\+city/.test((await page.getAttribute('.door-foot [data-fk="help-city"]', 'href')) || ''));
  check('First page: nothing in all caps', (await upperCased(page)).length === 0);
  const pile = await page.$eval('.pile', async (p) => {
    const img = p.querySelector('img'); img.loading = 'eager'; await img.decode().catch(() => {});
    const b = p.getBoundingClientRect(), i = img.getBoundingClientRect();
    // The bottom row the band shows, read from the image: how many of the columns on screen are bare desk.
    const k = img.naturalWidth / i.width, c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const y = Math.floor((b.bottom - i.top) * k) - 1, x0 = Math.max(0, Math.round((b.left - i.left) * k)), x1 = Math.min(c.width, Math.round((b.right - i.left) * k));
    const row = g.getImageData(x0, y, x1 - x0, 1).data; let bare = 0; for (let x = 0; x < x1 - x0; x++) if (row[x * 4 + 3] < 200) bare++;
    return { band: Math.round(b.bottom + scrollY), page: document.documentElement.scrollHeight, bare, cols: x1 - x0 };
  });
  check('First page: the paper states sit on the bottom edge and run off it, with no desk under them', pile.band === pile.page && pile.cols > 1000 && pile.bare === 0, JSON.stringify(pile));
  await noSideScroll(page, 'First page');
  await tap(page, '[data-fk="browse"]');
  check('First page: the city count opens the list of places', (await page.$$('.browse-list [data-act="choose-place"]')).length > 30);
  await tap(page, '[data-fk="browse"]');

  // Choices before a ZIP: a chip, a party from every party the guide covers, the fill switch.
  await tap(page, '#setup [data-act="chip"][data-k="progressive"]');
  check('Before a ZIP: a chip turns on', (await pressed('progressive')) === 'true');
  await tap(page, '#setup [data-fk="chip-party"]');
  const pre = await page.$$eval('#setup [data-act="party-set"]', (els) => els.map((e) => e.dataset.p));
  const covered = await page.evaluate(() => fetch('/data/index.json').then((r) => r.json()).then((i) => i.parties));
  check('Before a ZIP: "A party" lists the parties the guide covers', pre.length > 2 && JSON.stringify(pre) === JSON.stringify(covered) && pre.includes('Working Families') && pre.includes('Republican'), pre.join(', '));
  await tap(page, '#setup [data-act="party-set"][data-p="Working Families"]');
  check('Before a ZIP: a party turns on', (await text(page, '#setup [data-fk="chip-party"]')) === 'Working Families Party' && (await page.getAttribute('#setup [data-fk="chip-party"]', 'aria-pressed')) === 'true');
  check('Before a ZIP: the fill switch is on', (await page.getAttribute('[data-act="setup-fill"]', 'aria-checked')) === 'true');
  check('Before a ZIP: nothing is saved', (await savedVG(page)) === null);

  // The fifth digit finds the place and the counts; the choices carry over.
  await page.locator('#zip').focus();
  await page.fill('#zip', '7870');
  check('Four digits: no place yet', !(await page.$('.door-place')) && !(await page.$('.su-cov')));
  await page.keyboard.type('4');
  await page.waitForSelector('.su-cov', { timeout: 15000 });
  await shot(page, '00c-steps-1-2');
  check('Five digits: the place shows under the ZIP box', (await text(page, '.door-place')) === 'Austin, Texas · 78704' && !(await page.$('.door-place [data-act]')), await text(page, '.door-place'));
  check('Five digits: and the counts in step 2', /^Picks in \d+ of your \d+ races\.$/.test(await text(page, '.su-cov')), await text(page, '.su-cov'));
  // On a phone the number pad steps aside once the ZIP finds its ballot, so step 2 and "Show my ballot" show.
  check('Five digits: on a touch screen the keypad drops and focus goes on to step 2', (await focusedFk(page)) === 'su-h' && (await page.inputValue('#zip')) === '78704', String(await focusedFk(page)));
  check('Five digits: the chips chosen before carry over', (await pressed('papers')) === 'true' && (await pressed('progressive')) === 'true' && (await page.getAttribute('[data-act="setup-fill"]', 'aria-checked')) === 'true');
  check('Five digits: a party this ballot doesn’t have drops out, quietly', (await text(page, '#setup [data-fk="chip-party"]')) === 'A party' && !(await page.$('.zip-err')));
  check('Five digits: the fill switch counts the races where they agree', /^\d+ races? where they agree( \(\d+ from just one source\))?\. Races where picks split stay open\.$/.test(await text(page, '[data-act="setup-fill"] small')), await text(page, '[data-act="setup-fill"] small'));
  await tap(page, '#setup [data-fk="chip-party"]');
  const post = await page.$$eval('#setup [data-act="party-set"]', (els) => els.map((e) => e.dataset.p));
  check('After the ZIP: "A party" lists only the parties on this ballot', post.includes('Republican') && !post.includes('Working Families'), post.join(', '));
  await tap(page, '#setup [data-act="party-set"][data-p="Republican"]');
  check('After the ZIP: with a party, the fill line counts its candidates first', /^(\d+ from the Republican Party( and \d+ where your other sources agree)?|\d+ where your other sources agree)\.$/.test(await text(page, '[data-act="setup-fill"] small')) && (await text(page, '#setup [data-fk="chip-party"]')) === 'Republican Party', await text(page, '[data-act="setup-fill"] small'));
  await tap(page, '#setup [data-act="party-off"]');
  check('After the ZIP: tapping the party again turns it off', (await text(page, '#setup [data-fk="chip-party"]')) === 'A party');
  // The counts repaint in place: coverage, or the fill line when the new sources pick only in
  // races already covered (Austin's progressive groups).
  const cov1 = `${await text(page, '.su-cov')} | ${await text(page, '[data-act="setup-fill"] small')}`;
  await tap(page, '#setup [data-act="chip"][data-k="progressive"]');
  const cov2 = `${await text(page, '.su-cov')} | ${await text(page, '[data-act="setup-fill"] small')}`;
  check('After the ZIP: a chip changes the counts in place', (await pressed('progressive')) === 'false' && cov2 !== cov1, `${cov1} -> ${cov2}`);
  await tap(page, '#setup [data-act="chip"][data-k="progressive"]');
  check('After the ZIP: nothing is saved yet', (await savedVG(page)) === null);
  check('After the ZIP: nothing in all caps', (await upperCased(page)).length === 0);
  await noSideScroll(page, 'Steps 1 and 2');
  // Editing the ZIP takes the place and the counts back; the choices stay.
  await page.fill('#zip', '7870');
  check('Editing the ZIP: the place and the counts go', !(await page.$('.door-place')) && !(await page.$('.su-cov')) && (await pressed('progressive')) === 'true');
  await page.fill('#zip', '78704');
  await page.waitForSelector('.su-cov', { timeout: 15000 });
  await tap(page, '[data-act="setup-fill"]');
  await tap(page, SETUP);
  await page.waitForSelector('#plan', { timeout: 15000 });
  check('"Show my ballot": the ballot, nothing filled with the switch off', /^0 of \d+ decided$/.test(await text(page, '.bar-txt')) && !(await page.$('.toast:not([hidden])')), await text(page, '.bar-txt'));
  check('"Show my ballot": the sources chosen on the first page', (await text(page, '.picks-line span')) === 'Endorsements: Newspapers and guides, progressive groups', await text(page, '.picks-line span'));
  check('"Show my ballot": the ballot is saved once it shows', /austin-tx/.test((await savedVG(page)) || ''));
  check('How this guide works: one folded row at the bottom of the ballot', (await text(page, '#how-h')) === 'How this guide works' && (await page.getAttribute('#how [data-act="open"][data-k="how"]', 'aria-expanded')) === 'false' && !(await page.$('#how .how-bd')), await text(page, '#how-h'));
  check('The foot: one quiet line, the first page’s words, with Kevin HG and only the coffee linked out (Kevin, Oct 21)', /^Covers \d+ cities where Kevin HG’s friends live\. How this guide works · Report a problem · Request a city · Buy Kevin a thank-you coffee$/.test(await text(page, '#how .foot-line'))
    && (await text(page, '#how .foot-line a[href="https://kevinhg.com"]')) === 'Kevin HG' && (await text(page, '#how .foot-line a[href="https://buymeacoffee.com/kevinhg"]')) === 'thank-you coffee' && (await page.$$('#how .foot-line a')).length === 4, await text(page, '#how .foot-line'));
  check('The bar: the gold line runs along its bottom edge', (await page.$eval('.foot', (e) => e.lastElementChild && e.lastElementChild.className)) === 'bar');
  await tap(page, '#how [data-act="open"][data-k="how"]');
  await settle(page);
  check('How this guide works: its row opens it, focus kept on the row', (await page.getAttribute('#how [data-act="open"][data-k="how"]', 'aria-expanded')) === 'true' && (await focusedFk(page)) === 'how', await focusedFk(page));
  check('How this guide works: names the source for "Voting is underway in every state"', /“Voting is underway in every state”: Center for Election Innovation & Research\./.test(await text(page, '#how')) && !!(await page.$('#how a[href="https://electioninnovation.org/research/dates-for-2026-early-in-person-and-mail-voting/"]')));
  check('How this guide works: ends with the build date and the maker', /^Data built \d{4}-\d{2}-\d{2}\. Made by Kevin HG\. Not affiliated/.test(await text(page, '#how .how-bd > :last-child')) && /tap “Report a problem”\./.test(await text(page, '#how .how-bd')), await text(page, '#how .how-bd > :last-child'));
  await tap(page, '#how [data-act="open"][data-k="how"]');
  await settle(page);
  check('How this guide works: the row closes it again', !(await page.$('#how .how-bd')) && !(await page.$('.trust .gone')) && (await page.getAttribute('#how [data-act="open"][data-k="how"]', 'aria-expanded')) === 'false');
  // The two forms, plain links: prefilled with this page and this ballot's place, and the city form with the ZIP.
  const helpReport = (await page.getAttribute('#how [data-fk="help-report"]', 'href')) || '';
  const helpCity = (await page.getAttribute('#how [data-fk="help-city"]', 'href')) || '';
  check('Report a problem and Request a city: the form prefilled for this page and place, and the city form with the ZIP', /entry\.90887649=The\+ballot\+page/.test(helpReport) && /entry\.628621310=Austin%2C\+78704/.test(helpReport) && /entry\.90887649=Please\+add\+my\+city/.test(helpCity) && /entry\.628621310=78704/.test(helpCity), `${helpReport.slice(-80)} | ${helpCity.slice(-60)}`);
  // The menu names it too, right above "How this guide works".
  await menu(page);
  check('The menu: "Report a problem" is a link to the form, right above "How this guide works"', /viewform\?/.test((await page.getAttribute('.sheet-panel .nv-report', 'href')) || '') && (await page.$eval('.sheet-panel .nv-end', (ul) => [...ul.querySelectorAll('.nv-t')].map((e) => e.textContent).join('|'))) === 'Report a problem|How this guide works');
  await tap(page, '.sheet-panel [data-fk="sheet-x"]');
  await settle(page);
  // Texas's governor race: three names and four write-ins read as the grid, the write-ins folded under it (Kevin, Oct 21).
  await tap(page, '#i-tx-governor .row-hd');
  await settle(page);
  check('Governor (TX): the grid, with the write-ins folded under it', !!(await page.$('#i-tx-governor .grid.c3')) && /^\d+ write-in candidates:/.test(await text(page, '#i-tx-governor .wi-fold')) && (await page.$$('#i-tx-governor .clist > li')).length === 1, await text(page, '#i-tx-governor .wi-fold'));
  await tap(page, '#i-tx-governor .row-hd');
  await settle(page);
  // "Lookup can't find you?" under Check my registration opens the plan's details at that question (Kevin, Oct 20: friends read a failed search as being purged).
  await tap(page, '[data-fk="plan-cant-find"]');
  await settle(page);
  check('Plan: "Try your name these ways" opens the details at "The lookup can’t find me", with Texas’s own no-match words', (await page.getAttribute('[data-fk="wi-lookup_cant_find"]', 'aria-expanded')) === 'true' && (await focusedFk(page)) === 'wi-lookup_cant_find' && /exactly as registered/.test(await text(page, '.whatifs')) && !!(await page.$('.whatifs a[href="https://goelect.txelections.civixapps.com/ivis-mvp-ui/#/login"]')), (await text(page, '.wi-short')).slice(0, 80));
  await tap(page, '[data-act="open"][data-k="whatif"]');
  await settle(page);
  await page.goBack();
  await page.waitForSelector('#zip');
  await page.waitForSelector('.door-place', { timeout: 15000 });
  check('Back from the ballot: the first page, with the ZIP and its place again', !(await page.$('#plan')) && !(await page.$('.foot')) && (await page.inputValue('#zip')) === '78704' && (await text(page, '.door-place')) === 'Austin, Texas · 78704');
  check('Back from the ballot: step 2 shows that ballot’s own sources', (await pressed('progressive')) === 'true');
  await page.locator('#zip').press('Enter');
  await page.waitForSelector('#plan', { timeout: 15000 });
  check('Enter in the ZIP box: shows the ballot once the ZIP has found it', !!(await page.$('#plan')) && !(await page.$('#zip')));
  noErrors(page, 'First page');
  await ctx.close();
}
{
  // Dark mode: the sheet stays light paper, as My plan's does, so its ink and controls stay dark.
  const { ctx, page } = await newPage({ colorScheme: 'dark' });
  await openZip(page, '78704');
  await page.waitForSelector('.su-cov', { timeout: 15000 });
  const ink = await page.evaluate(() => [getComputedStyle(document.querySelector('.pad.door')).color, getComputedStyle(document.querySelector('.pad.door .su-cov')).color, getComputedStyle(document.getElementById('zip')).backgroundColor, getComputedStyle(document.body).color]);
  check('First page in dark mode: the sheet keeps dark ink and a light ZIP box on its light paper', ink[0] === 'rgb(31, 38, 35)' && ink[1] === 'rgb(74, 82, 77)' && ink[2] === 'rgb(247, 243, 232)' && ink[3] !== ink[0], ink.join(' | '));
  await shot(page, '00d-steps-1-2-dark');
  noErrors(page, 'First page in dark mode');
  await ctx.close();
}
{
  // A city from the list of places: its place line with no ZIP (the box empties), and the list closes.
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/?today=${TODAY}`);
  await page.waitForSelector('#zip');
  await page.fill('#zip', '802');
  await tap(page, '[data-fk="browse"]');
  await tap(page, '.browse-list [data-act="choose-place"][data-ids="denver-co"]');
  await page.waitForSelector('.door-place', { timeout: 15000 });
  check('A city from the list: its place line, the ZIP box emptied, the list closed, focus on step 2', (await text(page, '.door-place')) === 'Denver, Colorado' && (await page.inputValue('#zip')) === '' && !(await page.$('.browse-list')) && (await focusedFk(page)) === 'su-h' && !!(await page.$('.su-cov')),
    `${await text(page, '.door-place')} / ${await page.inputValue('#zip')} / ${await focusedFk(page)}`);
  await throughSetup(page);
  check('A city from the list: "Show my ballot" opens it', /Denver/.test(await text(page, '.place')));
  noErrors(page, 'A city from the list');
  await ctx.close();
}
{
  // "Change" (the ballot's masthead) goes back the way Back does, so the first page never sits in
  // history twice and one more Back leaves the site.
  const { ctx, page } = await newPage();
  await openZip(page, '78704');
  await throughSetup(page);
  const depth = await page.evaluate(() => history.length);
  for (let i = 0; i < 2; i++) {
    await tap(page, '.mast [data-act="change-place"]');
    await page.waitForSelector('.door-place', { timeout: 15000 });
    if (!i) check('Change: back to the first page, ZIP still in the box', (await page.inputValue('#zip')) === '78704' && (await page.evaluate(() => history.state && history.state.vg)) === 'start');
    await plainSetup(page);
    await page.waitForSelector('#plan', { timeout: 15000 });
  }
  check('Change: the first page is in history once, however often you change', (await page.evaluate(() => history.length)) === depth, `${depth} then ${await page.evaluate(() => history.length)}`);
  noErrors(page, 'Change');
  await ctx.close();
}
{
  // Back or Change from a ballot with picks: the first page says it's saved and opens it in one tap,
  // and so does the next visit (UX walk, Oct 20: forgetting it made the picks look gone).
  const { ctx, page } = await newPage();
  await openBallot(page, '80205');
  const id = await page.evaluate(() => document.querySelector('#sec-measures .row[data-item][data-undecided]').dataset.item);
  await openRow(page, id);
  await page.locator(`#i-${id} [data-act="pick"][data-v="YES"]`).first().tap();
  await page.waitForTimeout(400);
  await tap(page, '.mast [data-act="change-place"]');
  await page.waitForSelector('#zip');
  check('Change: the first page says the ballot is saved, with a way back', /^Your Denver ballot is saved, 1 race decided\./.test(await text(page, '.door-saved')) && !!(await page.$('.door-saved [data-act="saved-open"]')), await text(page, '.door-saved'));
  await page.reload();
  await page.waitForSelector('#zip');
  await page.waitForSelector('.door-place', { timeout: 15000 });
  check('Next visit: the first page again, its ZIP in the box and the saved ballot offered', !(await page.$('#plan')) && (await page.inputValue('#zip')) === '80205' && /saved/.test(await text(page, '.door-saved')), await text(page, '.door-saved'));
  await tap(page, '[data-act="saved-open"]');
  await page.waitForSelector('#plan', { timeout: 15000 });
  check('Open my ballot: the ballot as you left it', (await page.getAttribute(`#i-${id}`, 'data-undecided')) === null && !(await page.$('.door-saved')));
  await page.goBack();
  await page.waitForSelector('#zip');
  check('Open my ballot: Back returns to the first page', !(await page.$('#plan')));
  noErrors(page, 'Saved ballot on the first page');
  await ctx.close();
}
{
  // The fill switch fills, Undo undoes; then a reload, a save link and ?try all skip the first page.
  const { ctx, page } = await newPage();
  await openZip(page, '78704');
  await page.waitForSelector('.su-cov', { timeout: 15000 });
  const n = Number(((await text(page, '[data-act="setup-fill"] small')).match(/^(\d+)/) || [])[1] || 0);
  check('Step 2: the fill switch is on for a new ballot', (await page.getAttribute('[data-act="setup-fill"]', 'aria-checked')) === 'true' && n > 0, String(n));
  await tap(page, '[data-act="setup-only"]');
  await tap(page, SETUP);
  await page.waitForSelector('#plan', { timeout: 15000 });
  const bar = await text(page, '.bar-txt');
  check('Step 2 fill: "Show my ballot" fills the races where your sources agree', bar.startsWith(`${n} of `), `${bar} (switch said ${n})`);
  // The ballot's own line says it once; a toast on top of it said the same thing twice (UX walk, Oct 20).
  check('Step 2 fill: no toast on top of the ballot\'s line', !(await page.$('.toast')));
  check('Step 2 fill: the ballot says "N filled in from your sources. Undo"', (await text(page, '.filled')) === `${n} filled in from your sources. Undo`, await text(page, '.filled'));
  check('Step 2: "Hide races I’ve decided" turns the filter on, so no decided row shows', !(await page.$('.ledger .row[data-item]:not([data-undecided])')));
  await menu(page);
  check('Step 2: the menu’s "Hide races I’ve decided" switch shows it on', (await page.getAttribute('.sheet-panel [data-act="only"]', 'aria-checked')) === 'true');
  await tap(page, '.sheet-panel [data-fk="sheet-x"]');
  await tap(page, '.filled [data-act="undo-bulk"]');
  check('Step 2 fill: Undo takes every filled pick back', /^0 of /.test(await text(page, '.bar-txt')), await text(page, '.bar-txt'));
  await page.reload();
  await page.waitForSelector('#plan', { timeout: 15000 });
  check('Reload: the ballot opens straight away, no first page', !!(await page.$('#plan')) && !(await page.$('#zip')));
  await tap(page, '[data-act="cheat"]');
  await tap(page, '[data-act="save-open"]');
  const link = await page.inputValue('.save-url');
  const fresh = await newPage();
  await fresh.page.goto(linkHere(link));
  await fresh.page.waitForSelector('#plan', { timeout: 15000 });
  check('Save link: a fresh device opens the ballot, no first page', !!(await fresh.page.$('#plan')) && !(await fresh.page.$('#zip')));
  noErrors(fresh.page, 'Save link skips the first page');
  await fresh.ctx.close();
  const demo = await newPage();
  await openZip(demo.page, '78704', '&try=fresh');
  check('Try as: the first page asks only where you vote', !(await demo.page.$('#su-h')) && !(await demo.page.$('[data-act="setup-fill"]')));
  await throughSetup(demo.page);
  check('Try as: "Show my ballot" opens the scenario', !!(await demo.page.$('#plan')) && /^0 of /.test(await text(demo.page, '.bar-txt')));
  noErrors(demo.page, 'Try as');
  await demo.ctx.close();
  noErrors(page, 'Step 2 fill');
  await ctx.close();
}
{
  // "Hide races I've decided" sticks (Kevin, Oct 20: "I closed the page, I reopened the page, and
  // they were showing all the races again"). It is saved with the ballot on this device, never in
  // the save link.
  const { ctx, page } = await newPage();
  await openZip(page, '80205');
  await page.waitForSelector('.su-cov', { timeout: 15000 });
  await tap(page, '[data-act="setup-only"]');
  await plainSetup(page);
  await page.waitForSelector('#plan', { timeout: 15000 });
  const [id, id2] = await page.evaluate(() => [...document.querySelectorAll('#sec-measures .row[data-item][data-undecided]')].slice(0, 2).map((r) => r.dataset.item));
  await openRow(page, id);
  await tap(page, `#i-${id} [data-act="pick"][data-v="YES"]`);
  await openRow(page, id2);
  await settle(page);
  check('Hide races sticks: a decided row leaves the page', !(await page.$(`#i-${id}`)) && !!(await page.$(`#i-${id2}.is-open`)));
  const saved = JSON.parse((await savedVG(page)) || '{}');
  check('Hide races sticks: saved with the ballot', Object.values(saved.ballots || {}).some((b) => b.hideDecided === true), JSON.stringify(Object.values(saved.ballots || {}).map((b) => b.hideDecided)));
  await page.reload();
  await page.waitForSelector('#plan', { timeout: 15000 });
  await page.waitForTimeout(150);
  check('Hide races sticks: after a reload the decided row is still hidden', !(await page.$(`#i-${id}`)) && !(await page.$('.ledger .row[data-item]:not([data-undecided])')) && /^1 of /.test(await text(page, '.bar-txt')), await text(page, '.bar-txt'));
  await menu(page);
  check('Hide races sticks: after a reload the menu\'s switch is on', (await page.getAttribute('.sheet-panel [data-act="only"]', 'aria-checked')) === 'true');
  await tap(page, '.sheet-panel [data-fk="sheet-x"]');
  await edit(page);
  check('Hide races sticks: and so is the Edit sheet\'s', (await page.getAttribute('.sheet-panel [data-act="setup-only"]', 'aria-checked')) === 'true');
  await tap(page, '.sheet-panel [data-fk="sheet-x"]');
  await settle(page);
  // A save link opened on this device keeps this device's setting; on a fresh device it starts off.
  await tap(page, '.foot [data-act="cheat"]');
  await tap(page, '[data-act="save-open"]');
  const link = await page.inputValue('.save-url');
  check('Hide races sticks: the save link carries no new field', /^[^#]*#v[12]~CO~denver-co~80205~[^~]*~[^~]*~[^~]*~[^~]*$/.test(link), link.replace(/^[^#]*/, ''));
  await page.goto(linkHere(link));
  await page.waitForSelector('#plan', { timeout: 15000 });
  await page.waitForTimeout(150);
  check('Hide races sticks: your own save link on this device keeps it on', !(await page.$(`#i-${id}`)));
  const fresh = await newPage();
  await fresh.page.goto(linkHere(link));
  await fresh.page.waitForSelector('#plan', { timeout: 15000 });
  await fresh.page.waitForTimeout(150);
  check('Hide races sticks: on a fresh device the link opens with it off', !!(await fresh.page.$(`#i-${id}`)));
  noErrors(fresh.page, 'Hide races sticks, fresh device');
  await fresh.ctx.close();
  // Turned off from the menu, it stays off after a reload too.
  await menu(page);
  await tap(page, '.sheet-panel [data-act="only"]');
  await tap(page, '.sheet-panel [data-fk="sheet-x"]');
  await settle(page);
  await page.reload();
  await page.waitForSelector('#plan', { timeout: 15000 });
  await page.waitForTimeout(150);
  check('Hide races sticks: turned off in the menu, it stays off after a reload', !!(await page.$(`#i-${id}`)));
  noErrors(page, 'Hide races sticks');
  await ctx.close();
}

/* ---------- Denver 80205: the plan strip, the lens, rows, picks, fills, the save link ---------- */
{
  const { ctx, page } = await newPage();
  await openBallot(page, '80205');
  await shot(page, '01-denver-top');
  await noSideScroll(page, 'Denver');
  check('Denver: masthead names the place, then where, the ZIP and Change', /Denver/.test(await text(page, '.place')) && /· 80205 · Change$/.test(await text(page, '.where')) && !!(await page.$('.where [data-act="change-place"]')), await text(page, '.where'));
  check('Denver: the ballot is step 3, "Your ballot", above whose picks show', (await text(page, '#ballot-h')) === '3Your ballot' && (await text(page, '#ballot-h .step-n')) === '3'
    && (await page.evaluate(() => { const h = document.getElementById('ballot-h').getBoundingClientRect(); const p = document.querySelector('.picks-line').getBoundingClientRect(); return h.height > 10 && h.bottom <= p.top; })), await text(page, '#ballot-h'));
  check('Denver: a mail state’s plan says nothing about a photo ID', !/photo ID/.test(await text(page, '#plan')));
  const head = await text(page, '.plan-h');
  check('Denver: plan strip leads with the next step and its date, never a countdown', /^Mail your ballot by Mon, Oct 26\.$/.test(head) && !/days? (left|until)/i.test(await text(page, '#plan')), head);
  check('Denver: plan paragraphs stay under 40 words', (await planWalls(page)).length === 0, (await planWalls(page)).join(' | '));
  check('Denver: "Am I registered?" goes to the official lookup', /^https?:/.test((await page.getAttribute('.plan .pbtn.line', 'href')) || ''));
  check('Denver: nothing in all caps', (await upperCased(page)).length === 0, (await upperCased(page)).join(' | '));
  await tap(page, '[data-act="open"][data-k="whatif"]');
  const wiHeads = await page.$$eval('.whatifs .wi-h', (els) => els.map((e) => e.textContent.trim()));
  check('Denver: the dates and ID toggle opens dates and ID first, then gotchas, then what to do', wiHeads.join('|') === 'Dates, ID and voting rules|Gotchas in Colorado|If something goes wrong' && /In the booth/.test(await text(page, '.whatifs')), wiHeads.join('|'));
  await tap(page, '[data-act="open"][data-k="whatif"]');

  // Whose picks you see (flow, Oct 20): one line at the top of the ballot; Edit opens step 2's
  // controls in a sheet, with every source and the party list a tap further in.
  const fk = () => page.evaluate(() => document.activeElement && document.activeElement.dataset.fk);
  check('Denver: no "Show endorsements from" block, chip bar or fill buttons on the ballot', !(await page.$('#lens')) && !(await page.$('#lensbar')) && !(await page.$('.pfm')) && !(await page.$('#r-ballot [data-act="chip"]')));
  check('Denver: the ballot says whose picks show, with Edit', (await text(page, '.picks-line span')) === 'Endorsements: Newspapers and guides' && (await text(page, '.picks-line [data-act="picks"]')) === 'Edit', await text(page, '.picks-line'));
  await edit(page);
  check('Denver: Edit opens step 2’s controls, Newspapers and guides on, both switches off', (await text(page, '.sheet-panel #sh-h')) === 'Pick by endorsements or party' && (await page.getAttribute('.sheet-panel [data-act="chip"][data-k="papers"]', 'aria-pressed')) === 'true'
    && (await page.getAttribute('.sheet-panel [data-act="setup-fill"]', 'aria-checked')) === 'false' && (await page.getAttribute('.sheet-panel [data-act="setup-only"]', 'aria-checked')) === 'false');
  check('Denver: the Edit sheet takes focus', (await fk()) === 'sheet-x');
  const cov1 = `${await text(page, '.sheet-panel .su-cov')} | ${await text(page, '.sheet-panel [data-act="setup-fill"] small')}`;
  await tap(page, '.sheet-panel [data-act="chip"][data-k="progressive"]');
  const cov2 = `${await text(page, '.sheet-panel .su-cov')} | ${await text(page, '.sheet-panel [data-act="setup-fill"] small')}`;
  check('Denver: turning on Progressive groups changes the counts in the sheet', cov1 !== cov2 && /^Picks in \d+ of your \d+ races\./.test(cov2), `${cov1} -> ${cov2}`);
  await tap(page, '.sheet-panel [data-act="chip"][data-k="progressive"]');
  check('Denver: and off again', `${await text(page, '.sheet-panel .su-cov')} | ${await text(page, '.sheet-panel [data-act="setup-fill"] small')}` === cov1);
  await tap(page, '.sheet-panel [data-act="sheet"][data-s="sources"]');
  await page.waitForSelector('.sheet-panel .sgrp');
  check('Denver: See all sources lists every source by lean, each with why its lean', (await page.$$('.sgrp')).length >= 2 && /Why this lean/.test(await text(page, '.sheet-panel')));
  check('Denver: the sheet moves focus to its close button', (await fk()) === 'sheet-x');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check('Denver: Escape goes back to the Edit sheet, focus on See all sources', !!(await page.$('.sheet-panel.picks')) && (await fk()) === 'chip-more', await fk());
  await tap(page, '.sheet-panel [data-act="sheet"][data-s="party"]');
  await page.waitForSelector('.sheet-panel [data-act="party-set"]');
  await tap(page, '.sheet-panel [data-act="party-set"]');
  check('Denver: a party from the party list comes back to the Edit sheet, turned on', !!(await page.$('.sheet-panel.picks')) && (await page.getAttribute('.sheet-panel [data-fk="chip-party"]', 'aria-pressed')) === 'true' && / Party$/.test(await text(page, '.sheet-panel [data-fk="chip-party"]')));
  await tap(page, '.sheet-panel [data-act="party-off"]');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check('Denver: Escape closes the Edit sheet, focus back on Edit', !(await page.$('.sheet-panel')) && (await fk()) === 'picks-edit', await fk());
  check('Denver: the line still says Newspapers and guides', (await text(page, '.picks-line span')) === 'Endorsements: Newspapers and guides', await text(page, '.picks-line span'));

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
  await next(page);
  check('Denver: Next up opens an undecided row', !!(await page.$('.row.is-open[data-undecided]')));

  // "Fill in my ballot with their picks" from the Edit sheet: fills on Done, says so, and undoes as one batch.
  const before = await text(page, '.bar-txt');
  const n = await editFill(page);
  check('Denver: the Edit sheet’s fill switch has races to fill on the default lens', n > 0, String(n));
  if (n) {
    const t = await text(page, '.toast');
    check('Denver: Done fills them and says how many, with Undo', new RegExp(`^Filled ${n} picks? where your sources agree`).test(t) && !!(await page.$('.toast [data-act="undo-bulk"]')), t);
    check('Denver: the ballot says "N filled in from your sources. Undo"', (await text(page, '.filled')) === `${n} filled in from your sources. Undo`, await text(page, '.filled'));
    check('Denver: the bar counts the filled picks', (await text(page, '.bar-txt')) !== before);
    await tap(page, '.filled [data-act="undo-bulk"]');
    check('Denver: Undo puts every pick back, and the line goes', (await text(page, '.bar-txt')) === before && !(await page.$('.filled')), `${before} vs ${await text(page, '.bar-txt')}`);
  }

  await tap(page, '[data-act="cheat"]');
  await page.waitForSelector('#cheat');
  check('Denver: the cheat sheet keeps the note', /Read the Blue Book first/.test(await text(page, '#cheat')));
  check('Denver: the cheat sheet ends, then offers Help friends vote as its own step', !(await page.$('#pass')) && !!(await page.$('#cheat [data-act="view"][data-v="pass"]')));
  check('My plan: ends with the same foot as the ballot', (await text(page, '#r-trust #how-h')) === 'How this guide works' && /entry\.90887649=My\+plan\+page/.test((await page.getAttribute('#r-trust [data-fk="help-report"]', 'href')) || '') && /Buy Kevin a thank-you coffee$/.test(await text(page, '#r-trust .foot-line')));
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

/* ---------- the ballot top (flow, Oct 20): the place, the next step, whose picks, the address ---------- */
{
  const { ctx, page } = await newPage();
  await openBallot(page, '78704');
  await page.evaluate(() => document.fonts.ready);
  await shot(page, '03b-austin-top');
  // Austin spans three counties, so the line names just the state; a one-county place names its county.
  check('Ballot top: the place, then where, the ZIP and Change', (await text(page, '.mast .place')) === 'Austin' && (await text(page, '.mast .where')) === 'Texas · 78704 · Change', await text(page, '.mast .where'));
  check('Ballot top: the election office left the masthead', !(await page.$('.mast .office')) && !/Your election office/.test(await text(page, '.mast')));
  await tap(page, '[data-act="open"][data-k="whatif"]');
  check('Ballot top: "Your election office" is in the plan’s details', /Your election office/.test(await text(page, '.whatifs')));
  await tap(page, '[data-act="open"][data-k="whatif"]');
  check('Ballot top: in Austin (Travis, Williamson and Hays) the next step names no one county\'s hours, then says to bring a photo ID', !/Travis County sites/.test(await text(page, '.plan-sub')) && /in your county\..*Bring a photo ID\.$/.test(await text(page, '.plan-sub')), await text(page, '.plan-sub'));
  const box = await text(page, '.addrbox > p');
  check('Ballot top: the address box says how many races depend on your address, and what the address can do', /^\d+ races depend on your address\. Your address finds \d+ of them\. Your official sample ballot shows all \d+\.$/.test(box), box);
  check('Ballot top: with "Use my address" and "Official sample ballot"', (await text(page, '.addrbox [data-act="addr-open"]')) === 'Use my address' && (await text(page, '.addrbox a')) === 'Official sample ballot' && /^https:/.test((await page.getAttribute('.addrbox a', 'href')) || ''));
  check('Ballot top: the old head lines are gone', !/in the same order as your ballot/.test(await text(page, '#r-ballot')) && !(await page.$('.bhead .sb')));
  await tap(page, '.addrbox [data-act="addr-open"]');
  check('Ballot top: "Use my address" opens the form in the box', !!(await page.$('.addrbox form[data-form="addr"]')) && await page.evaluate(() => document.activeElement && document.activeElement.id === 'addr-in'));
  check('Ballot top: nothing in all caps', (await upperCased(page)).length === 0);
  await noSideScroll(page, 'Ballot top');
  noErrors(page, 'Ballot top');
  await ctx.close();
}

/* ---------- every "go check" gets a button (flow, Oct 20) ---------- */
{
  const { ctx, page } = await newPage();
  let asked = 0;
  await page.route('https://geocoding.geo.census.gov/**', (route) => { asked++; return route.abort(); });
  await openBallot(page, '78704');
  // "Only on some ballots": the address (a state Senate race, so the Census can settle it), the sample ballot, "It's not on my ballot".
  await openRow(page, 'tx-senate-21');
  const may = await page.$$eval('#i-tx-senate-21 .may .may-acts > *', (els) => els.map((e) => e.textContent.trim()));
  check('Maybe box: Check with my address, Official sample ballot, It’s not on my ballot', may.join('|') === 'Check with my address|Official sample ballot|It’s not on my ballot', may.join('|'));
  check('Maybe box: the sample ballot is an official link', /^https:/.test((await page.getAttribute('#i-tx-senate-21 .may a', 'href')) || ''));
  await shot(page, '04b-maybe-box');
  await tap(page, '#i-tx-senate-21 .may [data-act="addr-open"]');
  check('Maybe box: Check with my address opens the address form, focused', !!(await page.$('.addrbox form[data-form="addr"]')) && await page.evaluate(() => document.activeElement && document.activeElement.id === 'addr-in'));
  // The Census doesn't answer: Try again, or pick them yourself.
  await page.fill('#addr-in', 'a test lookup');
  await page.locator('form[data-form="addr"] button[type=submit]').tap();
  await page.waitForSelector('[data-act="addr-retry"]', { timeout: 8000 }).catch(() => {});
  check('Lookup down: one line, then Try again and Pick them myself', (await text(page, 'form[data-form="addr"] [role="status"]')) === 'The Census lookup didn’t answer.' && (await page.$$eval('.addrbox .addr-next button', (els) => els.map((e) => e.textContent.trim()))).join('|') === 'Try again|Pick them myself', await text(page, '.addrbox'));
  await shot(page, '04c-lookup-down');
  const before = asked;
  await tap(page, '[data-act="addr-retry"]');
  await page.waitForSelector('[data-act="addr-retry"]', { timeout: 8000 }).catch(() => {});
  check('Lookup down: Try again asks the Census again with what you typed', asked > before && (await page.inputValue('#addr-in')) === 'a test lookup', `${before} then ${asked}`);
  const firstQ = await page.evaluate(() => document.querySelector('.ledger .row[data-q]').dataset.q);
  await tap(page, '[data-act="addr-pick"]');
  check('Lookup down: Pick them myself closes the form and opens the first district question', !(await page.$('form[data-form="addr"]')) && !!(await page.$(`.row[data-q="${firstQ}"].is-open`)), firstQ);
  // A district question has a last answer for a district you're not in.
  const dv = await page.evaluate(() => [...document.querySelectorAll('.row[data-q]')].map((r) => r.dataset.q).find((k) => /Del Valle/.test(k)));
  await openRow(page, `q:${dv}`);
  const last = await page.$$eval(`.row[data-q="${dv}"] .opts .opt`, (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()).pop());
  check('District question: the last answer is "I’m not in Del Valle ISD"', last === 'I’m not in Del Valle ISD', last);
  const m0 = Number(((await text(page, '.bar-txt')).match(/of (\d+)/) || [])[1]);
  await tap(page, `.row[data-q="${dv}"] [data-act="district"][data-v="none"]`);
  // Kevin, Oct 20: what isn't on your ballot leaves its section for one line at the bottom.
  check('District question: "I’m not in Del Valle ISD" moves it to "Not on your ballot" at the bottom and off the count', !/Del Valle ISD Trustee/.test(await text(page, '#sec-school')) && /^Not on your ballot: .*Del Valle ISD Trustee/.test(await text(page, '#off .disc')) && Number(((await text(page, '.bar-txt')).match(/of (\d+)/) || [])[1]) === m0 - 1, await text(page, '#off .disc'));
  check('District question: a toast says where it went', /Moved to “Not on your ballot” at the bottom/.test(await text(page, '.toast')), await text(page, '.toast'));
  await tap(page, '#off [data-act="open"][data-k="off"]');
  check('Not on your ballot: opened, it lists the race with "It’s on my ballot"', /It’s on my ballot/.test(await text(page, `#off [data-act="district-change"][data-g="${dv}"]`)));
  await tap(page, `#off [data-act="district-change"][data-g="${dv}"]`);
  check('Not on your ballot: "It’s on my ballot" asks the question again in its section', !!(await page.$(`#sec-school .row[data-q="${dv}"]`)) && !(await page.$(`#off [data-g="${dv}"]`)));
  await tap(page, `.row[data-q="${dv}"] [data-act="district"][data-v="none"]`).catch(async () => { await openRow(page, `q:${dv}`); await tap(page, `.row[data-q="${dv}"] [data-act="district"][data-v="none"]`); });
  const council = await page.evaluate(() => [...document.querySelectorAll('.row[data-q]')].map((r) => r.dataset.q).find((k) => /City Council/.test(k)));
  await openRow(page, `q:${council}`);
  check('District question: with no one district to name, "Not in any of these"', (await text(page, `.row[data-q="${council}"] [data-act="district"][data-v="none"]`)) === 'Not in any of these');
  // "It's not on my ballot" hides the race.
  await openRow(page, 'tx-senate-21');
  await tap(page, '#i-tx-senate-21 [data-act="notmine"]:not([data-all])');
  check('Maybe box: It’s not on my ballot moves the race to the list at the bottom', !(await page.$('#i-tx-senate-21')) && !!(await page.$('#off-tx-senate-21')), await text(page, '#off .disc'));
  check('Go check: nothing in all caps', (await upperCased(page)).length === 0);
  await noSideScroll(page, 'Go check');
  page.errors = page.errors.filter((e) => !/Failed to load resource|ERR_FAILED/.test(e));
  noErrors(page, 'Go check');
  await ctx.close();
}
// The address box after a lookup that works (Kevin, Oct 20: "it should show you what's up"): what
// the Census found, with "Not it? Try again"; what it set; what's left for the sample ballot, which
// leads now that "Use my address" has answered all it can. Census is answered here, with a made-up
// address. A reload keeps what was set and never the address.
{
  const { ctx, page } = await newPage();
  const answer = { result: { addressMatches: [{ matchedAddress: 'TEST ONE, AUSTIN, TX, 78704', geographies: {
    States: [{ STATE: '48' }], 'Incorporated Places': [{ BASENAME: 'Austin' }], '119th Congressional Districts': [{ BASENAME: '37' }],
    '2024 State Legislative Districts - Upper': [{ BASENAME: '14' }], '2024 State Legislative Districts - Lower': [{ BASENAME: '49' }] } }] } };
  await page.route('https://geocoding.geo.census.gov/**', (route) => {
    const cb = new URL(route.request().url()).searchParams.get('callback');
    return route.fulfill({ status: 200, contentType: 'application/javascript', body: `${cb}(${JSON.stringify(answer)})` });
  });
  await openBallot(page, '78704');
  const before = await text(page, '.addrbox .addr-n');
  check('Address box before a lookup: "{n} races depend on your address." and how many the address finds', /^\d+ races depend on your address\. Your address finds \d+ of them\./.test(before), before);
  await tap(page, '.addrbox [data-act="addr-open"]');
  await page.fill('#addr-in', 'a test lookup');
  await page.locator('form[data-form="addr"] button[type=submit]').tap();
  await page.waitForSelector('.addrbox .addr-found', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(200);
  check('Address box after a lookup: "Found:" and the Census’s address, tidied, with Not it? Try again', (await text(page, '.addrbox .addr-found')) === 'Found: Test One, Austin, TX 78704 Not it? Try again', await text(page, '.addrbox .addr-found'));
  check('Address box after a lookup: focus lands on what was found', (await focusedFk(page)) === 'addr-found', await focusedFk(page));
  const setLine = 'Set from your address: U.S. Representative, District 37 · State Representative, District 49.';
  check('Address box after a lookup: what it set, by office', (await text(page, '.addrbox .addr-set')) === setLine, await text(page, '.addrbox .addr-set'));
  const left = await text(page, '.addrbox .addr-n');
  const nLeft = Number((left.match(/^(\d+)/) || [])[1]);
  check('Address box after a lookup: the rest counted for the sample ballot, with the kinds of race the lookup doesn’t cover', /^\d+ races need your official sample ballot\. The address lookup doesn’t cover races like [a-zA-Z .]+( or [a-zA-Z .]+)?\.$/.test(left) && nLeft < Number((before.match(/^(\d+)/) || [])[1]) && !/depend on your address/.test(left), `${before} then ${left}`);
  const btns = await page.$$eval('.addrbox .row-btns > *', (els) => els.map((e) => `${e.textContent.trim()}${e.classList.contains('dark') ? ' (dark)' : ''}`));
  check('Address box after a lookup: the sample ballot leads', btns.join('|') === 'Official sample ballot (dark)', btns.join('|'));
  check('Address box after a lookup: no question left offers Use my address', !(await page.$('.ledger [data-act="addr-open"]')));
  check('Address box after a lookup: no toast, and nothing in the masthead', !/address/i.test(await text(page, '.toast')) && !/Set from|districts/i.test(await text(page, '.mast')), `${await text(page, '.toast')} | ${await text(page, '.mast')}`);
  await shot(page, '04d-address-found');
  // Not it? Try again: the form, with what was typed; Cancel brings the result back.
  await tap(page, '.addrbox [data-act="addr-again"]');
  check('Address box: Not it? Try again reopens the form with what you typed, focused', !!(await page.$('.addrbox form[data-form="addr"]')) && (await page.inputValue('#addr-in')) === 'a test lookup' && await page.evaluate(() => document.activeElement && document.activeElement.id === 'addr-in'));
  await tap(page, '.addrbox [data-act="addr-close"]');
  check('Address box: Cancel brings back what was found', (await text(page, '.addrbox .addr-found')) === 'Found: Test One, Austin, TX 78704 Not it? Try again' && (await focusedFk(page)) === 'addr-again', await focusedFk(page));
  // A reload: what was set stays; the address doesn't, anywhere.
  await page.waitForTimeout(400);
  await page.reload();
  await page.waitForSelector('#plan', { timeout: 15000 });
  await page.waitForTimeout(150);
  const street = /test one|a test lookup/i;
  const stored = (await savedVG(page)) || '';
  check('Address after a reload: what was set stays in the box, the address is gone', (await text(page, '.addrbox .addr-set')) === setLine && !(await page.$('.addr-found')) && !street.test(await text(page, 'body')), await text(page, '.addrbox'));
  check('Address after a reload: never in saved state, the page’s address or its history', !street.test(stored) && /Set from your address/.test(stored) && !street.test(page.url()) && !street.test(JSON.stringify(await page.evaluate(() => history.state))), page.url());
  noErrors(page, 'Address box after a lookup');
  await ctx.close();
}
// Statewide Florida (Miami): the only races that depend on your address are appeals judges, which
// the Census can't settle, so the box leads with the sample ballot; from the first page, the lookup
// shows what it found under the place line, and the box says the sample ballot shows the rest.
{
  const { ctx, page } = await newPage();
  const answer = { result: { addressMatches: [{ matchedAddress: 'TEST TWO, MIAMI, FL, 33101', geographies: {
    States: [{ STATE: '12' }], 'Incorporated Places': [{ BASENAME: 'Miami' }], 'ZIP Code Tabulation Areas': [{ ZCTA5: '33101' }],
    '119th Congressional Districts': [{ BASENAME: '24' }], '2024 State Legislative Districts - Upper': [{ BASENAME: '38' }] } }] } };
  await page.route('https://geocoding.geo.census.gov/**', (route) => {
    const cb = new URL(route.request().url()).searchParams.get('callback');
    return route.fulfill({ status: 200, contentType: 'application/javascript', body: `${cb}(${JSON.stringify(answer)})` });
  });
  await openBallot(page, '33101');
  const btns = await page.$$eval('.addrbox .row-btns > *', (els) => els.map((e) => `${e.textContent.trim()}${e.classList.contains('dark') ? ' (dark)' : ''}`));
  check('Statewide Florida: the address box leads with the sample ballot, no Use my address', /races? depends? on your address\. Your official sample ballot shows which are yours\.$/.test(await text(page, '.addrbox > p')) && btns.join('|') === 'Official sample ballot (dark)', `${await text(page, '.addrbox > p')} | ${btns.join('|')}`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${BASE}/?today=${TODAY}`);
  await page.waitForSelector('#zip');
  await tap(page, '.front [data-act="addr-open"]');
  await page.fill('#addr-in', 'a test lookup');
  await page.locator('form[data-form="addr"] button[type=submit]').tap();
  await page.waitForSelector('.door-place', { timeout: 15000 });
  check('Statewide Florida from the first page: what was found shows under the place line', (await text(page, '.door-found')) === 'Found: Test Two, Miami, FL 33101 Not it? Try again' && !(await page.$('.front [data-act="addr-open"]')), await text(page, '.door-found'));
  await plainSetup(page);
  await page.waitForSelector('#plan', { timeout: 15000 });
  const fbtns = await page.$$eval('.addrbox .row-btns > *', (els) => els.map((e) => `${e.textContent.trim()}${e.classList.contains('dark') ? ' (dark)' : ''}`));
  check('Statewide Florida: nothing here turns on Congress, so the box sends you to the sample ballot', /^\d+ races? needs? your official sample ballot\./.test(await text(page, '.addrbox .addr-n')) && !(await page.$('.addrbox .addr-set')) && fbtns.join('|') === 'Official sample ballot (dark)', `${await text(page, '.addrbox')} | ${fbtns.join('|')}`);
  check('Statewide Florida: the box still shows what was found', (await text(page, '.addrbox .addr-found')) === 'Found: Test Two, Miami, FL 33101 Not it? Try again', await text(page, '.addrbox .addr-found'));
  noErrors(page, 'Statewide Florida address');
  await ctx.close();
}
{
  // A ballot that won't load: Try again, with the ZIP still in the box. Then the guide's data itself.
  const { ctx, page } = await newPage();
  await page.route('**/data/place-austin-tx.json', (route) => route.fulfill({ status: 503, body: 'down' }));
  await openZip(page, '78704');
  await page.waitForSelector('[data-act="retry"]', { timeout: 15000 });
  check('Load error: says so, with Try again and the ZIP in the box', /couldn’t load that ballot/.test(await text(page, '.zip-err')) && (await text(page, '[data-act="retry"]')) === 'Try again' && (await page.inputValue('#zip')) === '78704');
  await page.unroute('**/data/place-austin-tx.json');
  await tap(page, '[data-act="retry"]');
  await page.waitForSelector('.door-place', { timeout: 15000 }).catch(() => {});
  check('Load error: Try again finds the same place', /Austin, Texas · 78704/.test(await text(page, '.door-place')), await text(page, '.door-place'));
  await ctx.close();
  const two = await newPage();
  await two.page.route('**/data/index.json', (route) => route.fulfill({ status: 503, body: 'down' }));
  await two.page.goto(`${BASE}/?today=${TODAY}`);
  await two.page.waitForSelector('[data-act="retry"]', { timeout: 15000 });
  check('Load error: the guide’s data down on the first visit, with Try again', /couldn’t reach the guide’s data/.test(await text(two.page, '.zip-err')));
  await two.page.unroute('**/data/index.json');
  await tap(two.page, '[data-act="retry"]');
  await two.page.waitForFunction(() => !document.querySelector('.zip-err') && /\d+ cities/.test(document.querySelector('[data-fk="browse"]')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  check('Load error: Try again loads the first page', !(await two.page.$('.zip-err')) && !!(await two.page.$('[data-fk="browse"]')));
  await two.ctx.close();
}
{
  // The registration alert gets a button (the state's register page comes with the data track; mocked here).
  const { ctx, page } = await newPage();
  await page.route('**/data/state-CO.json', async (route) => {
    const r = await route.fetch();
    const j = await r.json();
    j.howto.registration.register_url = 'https://vote.gov/register/colorado';
    return route.fulfill({ response: r, json: j });
  });
  await openBallot(page, '80205');
  check('Registration alert: "Register now" to the state’s register page', /^Not registered\?/.test(await text(page, '.plan-reg p')) && (await text(page, '.plan-reg a')) === 'Register now' && (await page.getAttribute('.plan-reg a', 'href')) === 'https://vote.gov/register/colorado', await text(page, '.plan-reg'));
  noErrors(page, 'Registration alert');
  await ctx.close();
}

/* ---------- My plan (flow, Oct 20): the cheat sheet, renamed, with "Save it before you go" ---------- */
{
  const { ctx, page } = await newPage();
  await openBallot(page, '78704');
  const endcap = await page.$$eval('.endcap > *', (els) => els.map((e) => e.textContent.trim()));
  check('Ballot end: "That’s your whole ballot. Next, save your plan." with "Open my plan"', endcap.join('|') === 'That’s your whole ballot.|Next, save your plan.|Open my plan', endcap.join('|'));
  await tap(page, '.endcap [data-act="cheat"]');
  await page.waitForSelector('#cheat');
  await page.evaluate(() => document.fonts.ready);
  await shot(page, '05b-my-plan');
  check('My plan: titled "Your voting plan", numbered 4 like the first page’s steps', (await text(page, '#cs-h')) === 'Your voting plan' && (await text(page, '.cs-step .step-n')) === '4' && (await page.getAttribute('.cs-step .step-n', 'aria-hidden')) === 'true', await text(page, '.cs-step'));
  check('My plan: Texas says save it, and print it or write it down', (await text(page, '#cheat .save-go')) === 'Save it before you go. Print it or write it down.', await text(page, '#cheat .save-go'));
  check('My plan: in person, the reminder keeps the booth line', /In the booth:/.test(await text(page, '#cheat .remind')));
  check('My plan: the print sheet has the title but no save line', /Your voting plan/.test(await text(page, '#r-print')) && !(await page.$('#r-print .save-go')));
  check('My plan: nothing in all caps', (await upperCased(page)).length === 0);
  noErrors(page, 'My plan');
  await ctx.close();
  const la = await newPage();
  await openBallot(la.page, '90012');
  await tap(la.page, '.foot [data-act="cheat"]');
  await la.page.waitForSelector('#cheat');
  const rem = await la.page.$$eval('#cheat .remind p', (els) => els.map((e) => e.textContent.trim()));
  check('My plan in a mail state: the reminder leads with the mail steps, no booth line', /^Mail your ballot by/.test(rem[0] || '') && !rem.some((x) => /In the booth/.test(x)), rem.join(' | '));
  check('My plan in California: "Print it, copy it, or take a screenshot."', (await text(la.page, '#cheat .save-go')) === 'Save it before you go. Print it, copy it, or take a screenshot.');
  noErrors(la.page, 'My plan in a mail state');
  await la.ctx.close();
}

/* ---------- the share page (flow, Oct 20): Share the guide, a public post, early voting sites ---------- */
{
  // A phone with a share sheet (stubbed: it records what it was handed).
  const { ctx, page } = await newPage();
  await page.addInitScript(() => { Object.defineProperty(navigator, 'share', { configurable: true, value: async (d) => { window.__shared = d; } }); });
  await openBallot(page, '78702');
  await tap(page, '.foot [data-act="cheat"]');
  await tap(page, '.foot [data-act="view"][data-v="pass"]');
  await page.waitForSelector('#pass');
  check('Share page: the same foot sits above the crowd', (await text(page, '#pass #how-h')) === 'How this guide works' && (await page.$eval('#pass .trust', (e) => e.nextElementSibling && e.nextElementSibling.className)) === 'crowd' && !(await page.$('#r-trust .trust')));
  await shot(page, '10b-share');
  check('Share page: the lede asks you to make the message your own', (await text(page, '#pass .lede')) === 'Copy a message, make it your own, and send it. Ask each person to text three more.', await text(page, '#pass .lede'));
  check('Share page: "Share the guide" comes right after the lede', (await page.$eval('#pass .lede', (e) => e.nextElementSibling && e.nextElementSibling.dataset.act)) === 'share-guide' && (await text(page, '[data-act="share-guide"]')) === 'Share the guide');
  await tap(page, '[data-act="share-guide"]');
  const shared = await page.evaluate(() => window.__shared || null);
  const fam = await text(page, '#msg-fam');
  check('Share the guide: the share sheet gets the friends message, with the guide as its link', !!shared && shared.url === 'https://vote.kevinhg.com/' && shared.title === 'Quickly make your voting plan.' && /^Got a plan to vote\? Here’s a guide to help you sort through your ballot\./.test(shared.text) && !shared.text.includes('https://') && /text three people/.test(shared.text), JSON.stringify(shared));
  check('Share page: a public post goes with the friends message, official links with work, school and neighborhood groups', (await text(page, '#pass .msgs.fam h4')) === 'For friends, family and public posts' && (await text(page, '#pass .msgs.pub h4')) === 'For work, school and neighborhood groups' && fam.includes('https://vote.kevinhg.com/'));
  const order = await page.$$eval('#pass .checks [data-act="tick"]', (els) => els.map((e) => e.dataset.k));
  check('Share page: the spots to post follow the two messages, a public post third', order.join() === 'family,friends,post,school,work,hood', order.join());
  const spots = await page.evaluate(() => { const ul = document.querySelector('#pass .checks'); const h = ul.previousElementSibling; return [h.tagName, h.textContent.trim()]; });
  check('Share page: "Good spots to post", with no line under it', spots.join() === 'H3,Good spots to post' && !/Saved on this device/.test(await text(page, '#pass')), spots.join());
  // The crowd (Kevin, Oct 20: "Too much space above the people's heads"): crowd.webp's heads start
  // at row 144 of 480, so the box starts just above them; every head stays whole.
  const crowd = await page.evaluate(() => {
    const el = document.querySelector('#pass .crowd'); const c = el.getBoundingClientRect();
    const img = c.height * (parseFloat(getComputedStyle(el).backgroundSize.split(' ')[1]) / 100);
    const heads = c.bottom - img + img * 144 / 480;
    const words = Math.max(...[...document.querySelectorAll('#pass .wrap *')].filter((e) => e.getClientRects().length).map((e) => e.getBoundingClientRect().bottom));
    return { gap: Math.round(heads - words), whole: Math.round(heads - c.top), img: Math.round(img) };
  });
  check('Share page: the crowd sits close under the last words, every head whole', crowd.gap > 16 && crowd.gap <= 40 && crowd.whole >= 0 && crowd.img >= 180, JSON.stringify(crowd));
  const pub = await text(page, '#msg-pub');
  check('Share page: during early voting the work message links the early voting sites, not Election Day’s', /Find early voting places: https:\/\/www\.votetexas\.gov\/voting\/where\.html/.test(pub) && !pub.includes(new URL(BASE).host), pub);
  noErrors(page, 'Share the guide');
  await ctx.close();
  // No share sheet (most desktops): the message is copied instead.
  const two = await newPage();
  await two.page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied = t; } } });
  });
  await openBallot(two.page, '78702');
  await tap(two.page, '#plan [data-act="view"][data-v="pass"]');
  await tap(two.page, '[data-act="share-guide"]');
  await two.page.waitForSelector('.toast:not([hidden])', { timeout: 3000 }).catch(() => {});
  const copied = await two.page.evaluate(() => window.__copied || '');
  check('Share the guide with no share sheet: copies the friends message and says so', /^I just voted! Got a plan to vote\? Here’s a guide to help you sort through your ballot: https:\/\/vote\.kevinhg\.com\/\n\nIf you’ve already voted/.test(copied), copied.slice(0, 80));
  check('Share the guide with no share sheet: the toast says copied', /^Copied\. Paste it into your group chat\./.test(await text(two.page, '.toast')), await text(two.page, '.toast'));
  noErrors(two.page, 'Share the guide, copied');
  await two.ctx.close();
  // Orlando's county opened early voting on Oct 19: its own early voting page, not its polling-place finder.
  const orl = await newPage();
  await openBallot(orl.page, '32801');
  await tap(orl.page, '.foot [data-act="cheat"]');
  await tap(orl.page, '.foot [data-act="view"][data-v="pass"]');
  const op = await text(orl.page, '#msg-pub');
  check('Share page: Orlando’s work message links Orange County’s early voting sites', /Find early voting places in Orlando: https:\/\/voteorangefl\.gov\/event\/early-voting-general-election\//.test(op) && !/find-your-polling-place/.test(op), op);
  await orl.ctx.close();
}

/* ---------- resume (flow, Oct 20): "Welcome back" on a started ballot, once per visit ---------- */
{
  const { ctx, page } = await newPage();
  await openBallot(page, '78704');
  check('Resume: not on a first visit', !(await page.$('.resume')));
  const id = await page.evaluate(() => document.querySelector('#sec-measures .row[data-item]').dataset.item);
  await openRow(page, id);
  await tap(page, `#i-${id} [data-act="pick"][data-v="YES"]`);
  await page.waitForTimeout(400);
  await page.reload();
  await page.waitForSelector('#plan');
  const m = Number(((await text(page, '.bar-txt')).match(/of (\d+)/) || [])[1]);
  await shot(page, '03c-resume');
  check('Resume: a started ballot says "Welcome back. You’ve decided 1 of M."', (await text(page, '.resume #rs-h')) === `Welcome back. You’ve decided 1 of ${m}.`, await text(page, '.resume'));
  check('Resume: above the plan, with "Pick up where I left off" and a small close', await page.evaluate(() => document.querySelector('.resume').getBoundingClientRect().bottom <= document.getElementById('plan').getBoundingClientRect().top)
    && (await text(page, '.resume [data-act="next"]')) === 'Pick up where I left off' && (await page.getAttribute('.resume [data-act="resume-x"]', 'aria-label')) === 'Close');
  const first = await page.evaluate(() => { const r = document.querySelector('.ledger .row[data-undecided]'); return r && (r.dataset.item ? `i-${r.dataset.item}` : r.id); });
  await tap(page, '.resume [data-act="next"]');
  const opened = await page.$$eval('.ledger .row.is-open', (els) => els.map((e) => e.id));
  check('Resume: "Pick up where I left off" opens the first thing left, and the line goes', !(await page.$('.resume')) && opened.length === 1 && opened[0] === first, `${opened.join()} vs ${first}`);
  await page.reload();
  await page.waitForSelector('.resume');
  await tap(page, '.resume [data-act="resume-x"]');
  check('Resume: the close takes it away, focus on to the plan', !(await page.$('.resume')) && (await focusedFk(page)) === 'plan-k', await focusedFk(page));
  await page.reload();
  await page.waitForSelector('.resume');
  await tap(page, `#i-${id} > [data-act="row"]`);
  check('Resume: any other tap takes it away too, and does what it says', !(await page.$('.resume')) && !!(await page.$(`#i-${id}.is-open`)));
  await tap(page, '.foot [data-act="cheat"]');
  await tap(page, '[data-act="save-open"]');
  const link = await page.inputValue('.save-url');
  noErrors(page, 'Resume');
  await ctx.close();
  const fresh = await newPage();
  await fresh.page.goto(linkHere(link));
  await fresh.page.waitForSelector('#plan');
  check('Resume: a save link never says "Welcome back"', !(await fresh.page.$('.resume')));
  await fresh.ctx.close();
}

/* ---------- the bar and the menu (flow, Oct 20) ---------- */
{
  const { ctx, page } = await newPage();
  await openBallot(page, '78704');
  const acts = await page.$$eval('.foot button', (els) => els.map((e) => e.dataset.act));
  check('Bar: two buttons, the menu and My plan', acts.join() === 'toc,cheat' && (await text(page, '.foot [data-act="cheat"]')) === 'My plan', acts.join());
  const bar = await text(page, '.bar-txt');
  const [n0, m0] = (bar.match(/^(\d+) of (\d+) decided$/) || []).slice(1).map(Number);
  const shown = await page.evaluate(() => { const c = document.querySelector('.menu-btn').cloneNode(true); c.querySelectorAll('.vh').forEach((e) => e.remove()); return c.textContent.replace(/\s+/g, ' ').trim(); });
  check('Bar: the menu button shows "N of M"; its .bar-txt reads "N of M decided"', n0 === 0 && m0 > 0 && shown === `0 of ${m0}` && !!(await page.$('.menu-btn svg.burger')), `${shown} / ${bar}`);
  check('Bar: no rail on a phone', !(await page.$('.rail')));
  await menu(page);
  await shot(page, '08-menu');
  check('Menu: "Your ballot" with Close, focus on Close', (await text(page, '.sheet-panel #sh-h')) === 'Your ballot' && (await text(page, '.sheet-panel [data-fk="sheet-x"]')) === 'Close' && (await focusedFk(page)) === 'sheet-x');
  const order = await page.$$eval('.sheet-panel .sheet-bd button', (els) => els.map((e) => `${e.dataset.act}${e.dataset.to ? `:${e.dataset.to}` : ''}`));
  check('Menu: Next up first, then your next step and Quick picks, then the switch right above the sections', order.slice(0, 5).join() === 'next,jump:plan,picks,only,jump:federal', order.slice(0, 5).join());
  check('Menu: the switch reads "Hide races I’ve decided"', (await text(page, '.sheet-panel [data-act="only"]')) === 'Hide races I’ve decided', await text(page, '.sheet-panel [data-act="only"]'));
  const rows = await page.$$eval('.sheet-panel .nv', (els) => els.map((e) => [e.querySelector('.nv-t').textContent.trim(), e.querySelector('.nv-n').textContent.trim()]));
  const names = rows.map((r) => r[0]);
  check('Menu: your next step, Quick picks, each section on the page, My plan, Report a problem, then How this guide works', names[0] === 'Your next step' && names[1] === 'Quick picks' && names.slice(-3).join() === 'My plan,Report a problem,How this guide works'
    && JSON.stringify(names.slice(2, -3)) === JSON.stringify(await page.$$eval('.ledger .sec .sec-t', (els) => els.map((e) => e.textContent.trim()))), names.join(' | '));
  const left = rows.reduce((n, [, r]) => n + Number((r.match(/^(\d+) left$/) || [])[1] || 0), 0);
  check('Menu: what each section has left adds up to the bar', left === m0 - n0 && rows.every(([, r]) => r === '' || r === 'Done' || /^\d+ left$/.test(r)), `${left} vs ${m0 - n0}`);
  const first = await page.evaluate(() => { const r = document.querySelector('.ledger .row[data-undecided]'); return r && (r.dataset.item || `q:${r.dataset.q}`); });
  check('Menu: "Next up" names the first thing left on the page', (await page.getAttribute('.sheet-panel [data-act="next"]', 'data-k')) === first && /^Next up: \S/.test(await text(page, '.sheet-panel [data-act="next"]')), `${await page.getAttribute('.sheet-panel [data-act="next"]', 'data-k')} vs ${first}`);
  await tap(page, '.sheet-panel [data-act="jump"][data-to="measures"]');
  await settle(page);
  const top = await page.evaluate(() => Math.round(document.getElementById('sec-measures').getBoundingClientRect().top));
  check('Menu: a section row closes the menu, brings its band to the top and focuses it', !(await page.$('.sheet-panel')) && (await focusedFk(page)) === 'sec-measures' && top >= 0 && top < 60, `top ${top}, focus ${await focusedFk(page)}`);
  await menu(page);
  await tap(page, '.sheet-panel [data-act="jump"][data-to="plan"]');
  await settle(page);
  check('Menu: "Your next step" goes back to the plan', (await focusedFk(page)) === 'plan-k' && (await page.evaluate(() => Math.round(document.getElementById('plan').getBoundingClientRect().top))) < 60);
  await menu(page);
  await tap(page, '.sheet-panel [data-act="jump"][data-to="how"]');
  await settle(page);
  const howTop = await page.evaluate(() => Math.round(document.getElementById('how').getBoundingClientRect().top));
  check('Menu: "How this guide works" goes there and opens it, focused', !(await page.$('.sheet-panel')) && !!(await page.$('#how .how-bd')) && (await page.getAttribute('#how [data-act="open"][data-k="how"]', 'aria-expanded')) === 'true' && (await focusedFk(page)) === 'how' && howTop >= 0 && howTop < 60, `top ${howTop}, focus ${await focusedFk(page)}`);
  await menu(page);
  await tap(page, '.sheet-panel [data-act="picks"]');
  check('Menu: "Quick picks" opens the Edit sheet', !!(await page.$('.sheet-panel.picks')));
  await tap(page, '.sheet-panel [data-fk="sheet-x"]');
  check('Menu: closing the Edit sheet hands focus back to the menu button', (await focusedFk(page)) === 'bar-menu', await focusedFk(page));
  await menu(page);
  const k = await page.getAttribute('.sheet-panel [data-act="next"]', 'data-k');
  await tap(page, '.sheet-panel [data-act="next"]');
  const opened = await page.$$eval('.ledger .row.is-open', (els) => els.map((e) => e.dataset.item || `q:${e.dataset.q}`));
  check('Menu: "Next up" opens the race it names, and only that one', opened.length === 1 && opened[0] === k, `${opened.join()} vs ${k}`);
  await menu(page);
  check('Menu: then it names the next one after it', (await page.getAttribute('.sheet-panel [data-act="next"]', 'data-k')) !== k);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check('Menu: Escape closes it, focus back on the menu button', !(await page.$('.sheet-panel')) && (await focusedFk(page)) === 'bar-menu');
  await tap(page, '.foot [data-act="cheat"]');
  await page.waitForSelector('#cheat');
  check('Bar on the cheat sheet: Back to the ballot and Help friends vote', (await text(page, '.foot')) === 'Back to the ballot Help friends vote', await text(page, '.foot'));
  await tap(page, '.foot [data-act="view"][data-v="pass"]');
  check('Bar on Help friends vote: Back to the ballot and My plan', (await text(page, '.foot')) === 'Back to the ballot My plan', await text(page, '.foot'));
  check('Menu: nothing in all caps', (await upperCased(page)).length === 0);
  noErrors(page, 'Bar and menu');
  await ctx.close();
}
{
  // Under "Hide races I've decided" a finished section is just its band, folded, with Show (that's
  // where its races went): the menu says "Done", and jumping there opens it with its decided rows,
  // the filter still on. ("Try as aunt" decides everything but the measures.)
  const { ctx, page } = await newPage();
  await openBallot(page, '78704', '&try=aunt');
  await menu(page);
  await tap(page, '.sheet-panel [data-act="only"]');
  check('Menu: the switch turns "Hide races I’ve decided" on', (await page.getAttribute('.sheet-panel [data-act="only"]', 'aria-checked')) === 'true');
  check('Menu: a finished section reads "Done"', (await text(page, '.sheet-panel [data-to="federal"] .nv-n')) === 'Done');
  await tap(page, '.sheet-panel [data-fk="sheet-x"]');
  await settle(page);
  check('Menu: closed, the ballot shows only what’s left, a finished section as its band', !!(await page.$('#sec-federal.folded')) && !(await page.$('#sec-federal .row')) && !(await page.$('.ledger .row[data-item]:not([data-undecided])')));
  check('Menu: that band reads "2 of 2 decided" with Show', (await text(page, '#sec-federal .sec-r')) === '2 of 2 decided Show' && (await text(page, '#sec-federal .sec-count')) === '2 of 2 decided', await text(page, '#sec-federal .sec-r'));
  await menu(page);
  await tap(page, '.sheet-panel [data-act="jump"][data-to="federal"]');
  await settle(page);
  check('Menu: jumping to it opens it with its decided rows, focused', !(await page.$('#sec-federal.folded')) && (await focusedFk(page)) === 'sec-federal' && !!(await page.$('#sec-federal .row[data-item]:not([data-undecided])')) && (await text(page, '#sec-federal .sec-r')) === '2 of 2 decided Hide', await text(page, '#sec-federal .sec-r'));
  check('Menu: the other finished sections stay folded', !!(await page.$('#sec-state.folded')) && !(await page.$('#sec-state .row')));
  await menu(page);
  check('Menu: and the filter is still on', (await page.getAttribute('.sheet-panel [data-act="only"]', 'aria-checked')) === 'true');
  await tap(page, '.sheet-panel [data-fk="sheet-x"]');
  await settle(page);
  // A finished band's count, and the band itself, open and close it.
  await tap(page, '#sec-federal [data-act="sec-count"]');
  await settle(page);
  check('Counts: under the filter, "Hide" folds a finished section back to its band', !!(await page.$('#sec-federal.folded')) && !(await page.$('#sec-federal .row')) && (await text(page, '#sec-federal .sec-r')) === '2 of 2 decided Show', await text(page, '#sec-federal .sec-r'));
  await page.locator('#sec-state [data-act="sec-count"]').scrollIntoViewIfNeeded();
  const band0 = await page.$eval('#sec-state > .sec-h', (e) => e.getBoundingClientRect().top);
  await tap(page, '#sec-state [data-act="sec-count"]');
  await settle(page);
  const band1 = await page.$eval('#sec-state > .sec-h', (e) => e.getBoundingClientRect().top);
  check('Counts: "Show" on a finished band opens it with its decided rows, the band where it was', !(await page.$('#sec-state.folded')) && (await page.$$('#sec-state .row[data-item]')).length >= 2 && Math.abs(band1 - band0) <= 1, `${band0} then ${band1}`);
  await tap(page, '#sec-judicial [data-act="sec"]');
  await settle(page);
  check('Counts: under the filter, a finished band itself opens the same way', !(await page.$('#sec-judicial.folded')) && !!(await page.$('#sec-judicial .row[data-item]:not([data-undecided])')) && (await text(page, '#sec-judicial .sec-edit')) === 'Hide', await text(page, '#sec-judicial .sec-r'));
  const cb = await page.$eval('#sec-state [data-act="sec-count"]', (e) => e.getBoundingClientRect().height);
  check('Counts: the count is a full-height tap target', cb >= 44, String(cb));
  noErrors(page, 'Menu under the filter');
  await ctx.close();
}
{
  // From 1180px the menu stands as a rail in the left margin, clear of the ballot.
  const { ctx, page } = await newPage({ viewport: { width: 1280, height: 900 }, isMobile: false, deviceScaleFactor: 1 });
  await openBallot(page, '78704');
  await shot(page, '09-rail-1280');
  const r = await page.evaluate(() => { const a = document.querySelector('.rail').getBoundingClientRect(); const l = document.querySelector('.ledger').getBoundingClientRect(); const sh = document.querySelector('.sec-h').getBoundingClientRect(); return { left: a.left, right: a.right, col: l.left, band: sh.left, vis: getComputedStyle(document.querySelector('.rail')).display }; });
  check('Rail: at 1280px it stands in the left margin, clear of the bands', r.vis !== 'none' && r.left >= 0 && r.right <= r.band - 8, JSON.stringify(r));
  check('Rail: Next up, the switch and the rows, with no header', !!(await page.$('.rail [data-act="next"]')) && !!(await page.$('.rail [data-act="only"]')) && (await page.$$('.rail .nv')).length >= 5 && !(await page.$('.rail [data-act="sheet-close"]')));
  const before = await text(page, '.bar-txt');
  const id = await page.evaluate(() => document.querySelector('#sec-measures .row[data-item][data-undecided]').dataset.item);
  const leftOf = async () => text(page, '.rail [data-to="measures"] .nv-n');
  const l0 = await leftOf();
  await page.locator(`#i-${id} > [data-act="row"]`).click();
  await page.locator(`#i-${id} [data-act="pick"]`).first().click();
  await page.waitForTimeout(150);
  check('Rail: a pick updates its counts with the bar', (await leftOf()) !== l0 && (await text(page, '.bar-txt')) !== before, `${l0} -> ${await leftOf()}`);
  await page.setViewportSize({ width: 800, height: 900 });
  await page.waitForTimeout(200);
  check('Rail: under 1180px it goes, the bar’s menu stays', !(await page.$('.rail')) && !!(await page.$('.foot [data-act="toc"]')));
  noErrors(page, 'Rail');
  await ctx.close();
}

/* ---------- motion (Kevin, Oct 20: "opening a shelf and closing it again ... feels cruddy") ----------
   A tapped header stays where it is while its panel grows open beneath it and folds back up into it;
   a pick draws its tick and settles the verdict in gold; jumps glide and mark where they land. With
   prefers-reduced-motion everything lands at once. Measured every frame, at 380px. */
const film = (page, sel, ms = 520) => page.evaluate(([sel, ms]) => {
  window.__film = [];
  const t0 = performance.now();
  const f = () => {
    const r = document.querySelector(sel);
    const p = r && r.querySelector('.ink path');
    if (r) { const b = r.getBoundingClientRect(); window.__film.push([b.top, b.height, p ? parseFloat(getComputedStyle(p).strokeDashoffset) : null, window.scrollY]); }
    if (performance.now() - t0 < ms) requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
}, [sel, ms]);
const reel = async (page) => { await page.waitForTimeout(600); return page.evaluate(() => window.__film); };
const drift = (frames, y) => Math.max(...frames.map(([t]) => Math.abs(t - y)));
const topOf = (page, sel) => page.evaluate((s) => document.querySelector(s).getBoundingClientRect().top, sel);
const placeAt = (page, sel, y) => page.evaluate(([s, y]) => window.scrollBy(0, document.querySelector(s).getBoundingClientRect().top - y), [sel, y]);
{
  const { ctx, page } = await newPage();
  await openBallot(page, '80205');
  const ids = await page.evaluate(() => [...document.querySelectorAll('#sec-state .row[data-item][data-undecided]')].map((r) => r.dataset.item));
  const a = ids[1], b = ids[3];
  const B = `#i-${b}`;
  await placeAt(page, B, 300);
  await film(page, B);
  await page.locator(`${B} > [data-act="row"]`).tap();
  let f = await reel(page);
  const h0 = f[0][1], h1 = f[f.length - 1][1];
  const between = (fr) => fr.filter(([, h]) => h > h0 + 4 && h < h1 - 4).length;
  check('Motion: opening a row, its header stays put (within 2px) as the panel grows open beneath it', drift(f, 300) <= 2 && h1 > h0 + 100 && between(f) >= 3, `drift ${drift(f, 300).toFixed(1)}px, ${Math.round(h0)} to ${Math.round(h1)}px over ${between(f)} frames`);
  await film(page, B);
  await page.locator(`${B} > [data-act="row"]`).tap();
  f = await reel(page);
  check('Motion: closing it, the header stays put and the panel folds up into it, then is gone', drift(f, 300) <= 2 && Math.abs(f[f.length - 1][1] - h0) <= 1 && between(f) >= 2 && !(await page.$('.ob-gone')), `drift ${drift(f, 300).toFixed(1)}px, ${between(f)} frames between`);
  // Tapped low on the screen, a header whose panel would open mostly out of sight glides up to the
  // top as the panel grows (review, Oct 20: at 700px only 16px of the panel showed).
  await placeAt(page, B, 640);
  await film(page, B);
  await page.locator(`${B} > [data-act="row"]`).tap();
  f = await reel(page);
  const lowEnd = f[f.length - 1][0];
  const lowSteps = new Set(f.map(([t]) => Math.round(t))).size;
  check('Motion: a header tapped low on the screen glides up to the top as its panel grows', !!(await page.$(`${B}.is-open`)) && lowEnd >= 0 && lowEnd <= 8 && lowSteps >= 5 && between(f) >= 3, `640px to ${Math.round(lowEnd)}px over ${lowSteps} positions`);
  await page.locator(`${B} > [data-act="row"]`).tap();
  await settle(page);
  // A row open above it: that one closes at once and the page makes up the difference in the same frame.
  await openRow(page, a);
  await settle(page);
  await placeAt(page, B, 420);
  const above = await page.evaluate((id) => document.getElementById(`i-${id}`).getBoundingClientRect().height, a);
  await film(page, B);
  await page.locator(`${B} > [data-act="row"]`).tap();
  f = await reel(page);
  check('Motion: with a row open above, opening this one closes that one and still leaves this header where it was', above > 150 && drift(f, 420) <= 2 && !(await page.$(`#i-${a}.is-open`)) && !!(await page.$(`${B}.is-open`)), `drift ${drift(f, 420).toFixed(1)}px, the open row above was ${Math.round(above)}px`);
  // A pick closes the row: the header stays put, the pen tick draws itself, the verdict settles in gold.
  const pickAt = await page.evaluate((s) => document.querySelector(`${s} [data-act="pick"]`).getBoundingClientRect().top - document.querySelector(s).getBoundingClientRect().top, B);
  const y = Math.max(20, Math.min(300, 560 - pickAt));
  await placeAt(page, B, y);
  await film(page, B);
  await page.locator(`${B} [data-act="pick"]`).first().tap();
  f = await reel(page);
  const ink = f.map(([, , o]) => o).filter((o) => o !== null);
  check('Motion: a pick closes the row with its header in place, focus on it', drift(f, y) <= 2 && !!(await page.$(`${B}:not(.is-open) .vd.done`)) && !(await page.$('.ob-gone')) && (await focusedFk(page)) === `row-${b}`, `drift ${drift(f, y).toFixed(1)}px, focus ${await focusedFk(page)}`);
  await page.waitForTimeout(300);
  check('Motion: the tick draws itself in the box, then the drawn one steps aside for the printed one', ink.length >= 3 && ink[0] > 10 && ink.some((o) => o > 1 && o < ink[0] - 1) && ink[ink.length - 1] < 1 && !(await page.$(`${B} .ink`)) && !!(await page.$(`${B}.is-done`)), ink.map((o) => Math.round(o)).join(','));
  // A pick made below a header that scrolled off the top: the row comes down into view as the panel folds.
  const c = await page.evaluate(() => { const r = [...document.querySelectorAll('.ledger .row[data-item][data-undecided]')].find((x) => x.closest('#sec-measures')); return r && r.dataset.item; });
  const C = `#i-${c}`;
  await openRow(page, c);
  await settle(page);
  const yes = await page.evaluate((s) => document.querySelector(`${s} [data-act="pick"][data-v="YES"]`).getBoundingClientRect().top - document.querySelector(s).getBoundingClientRect().top, C);
  await placeAt(page, C, Math.min(-40, 560 - yes));
  const off = await topOf(page, C);
  await page.locator(`${C} [data-act="pick"][data-v="YES"]`).tap();
  await settle(page);
  const back = await topOf(page, C);
  check('Motion: a pick below a header scrolled out of view brings the decided row back into view', off < 0 && back >= 0 && back <= 820 * 0.4 + 4, `header at ${Math.round(off)}px, then ${Math.round(back)}px`);
  // Jumps glide (no teleport to the end) and mark where they land.
  await page.evaluate(() => window.scrollTo(0, 0));
  await menu(page);
  await page.evaluate(() => { window.__ys = []; const t0 = performance.now(); const f = () => { window.__ys.push(window.scrollY); if (performance.now() - t0 < 700) requestAnimationFrame(f); }; requestAnimationFrame(f); });
  const sheetFrames = await page.evaluate(() => getComputedStyle(document.querySelector('.sheet-panel')).transform);
  await tap(page, '.sheet-panel [data-act="jump"][data-to="judicial"]');
  await settle(page);
  const ys = await page.evaluate(() => window.__ys);
  const steps = new Set(ys.map((v) => Math.round(v))).size;
  check('Motion: a menu row glides to its band and marks it', steps >= 5 && Math.abs(await topOf(page, '#sec-judicial')) <= 2 && !!(await page.$('#sec-judicial.land')), `${steps} scroll positions, band at ${Math.round(await topOf(page, '#sec-judicial'))}px`);
  check('Motion: the menu sheet slid away, nothing left behind', !(await page.$('.sheet-panel')) && !(await page.$('.sheet-ghost')), sheetFrames);
  await next(page);
  await settle(page);
  const up = await page.evaluate(() => { const r = document.querySelector('.ledger .row.is-open'); return r ? [Math.round(r.getBoundingClientRect().top), r.classList.contains('land')] : null; });
  check('Motion: Next up glides to its row, near the top, and marks it', !!up && up[0] >= 0 && up[0] <= 8 && up[1], JSON.stringify(up));
  // "How this guide works" grows open under its row and folds back up into it; the row stays put.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await settle(page);
  const hy = await topOf(page, '#how');
  await film(page, '#how');
  await page.locator('#how [data-act="open"][data-k="how"]').tap();
  f = await reel(page);
  const g0 = f[0][1], g1 = f[f.length - 1][1];
  const mid = (fr) => fr.filter(([, h]) => h > g0 + 4 && h < g1 - 4).length;
  check('Motion: "How this guide works" grows open under its row, the row in place', drift(f, hy) <= 2 && g1 > g0 + 200 && mid(f) >= 3, `drift ${drift(f, hy).toFixed(1)}px, ${Math.round(g0)} to ${Math.round(g1)}px over ${mid(f)} frames`);
  await film(page, '#how');
  await page.locator('#how [data-act="open"][data-k="how"]').tap();
  f = await reel(page);
  check('Motion: and folds back up into it, then is gone', drift(f, hy) <= 2 && Math.abs(f[f.length - 1][1] - g0) <= 1 && mid(f) >= 2 && !(await page.$('.trust .gone')), `drift ${drift(f, hy).toFixed(1)}px, ${mid(f)} frames between`);
  check('Motion: nothing in all caps', (await upperCased(page)).length === 0);
  noErrors(page, 'Motion');
  await ctx.close();
}
{
  // prefers-reduced-motion: the same end states, at once.
  const { ctx, page } = await newPage({ reducedMotion: 'reduce' });
  await openBallot(page, '80205');
  const b = await page.evaluate(() => [...document.querySelectorAll('#sec-state .row[data-item][data-undecided]')][3].dataset.item);
  const B = `#i-${b}`;
  await placeAt(page, B, 300);
  await film(page, B);
  await page.locator(`${B} > [data-act="row"]`).tap();
  let f = await reel(page);
  const hs = [...new Set(f.map(([, h]) => Math.round(h)))];
  check('Reduced motion: a row opens at once, header in place', hs.length <= 2 && drift(f, 300) <= 2 && !!(await page.$(`${B}.is-open`)), `heights ${hs.join(', ')}`);
  await film(page, B);
  await page.locator(`${B} > [data-act="row"]`).tap();
  f = await reel(page);
  check('Reduced motion: and closes at once, nothing folding away', [...new Set(f.map(([, h]) => Math.round(h)))].length <= 2 && drift(f, 300) <= 2 && !(await page.$('.ob-gone')));
  await placeAt(page, B, 640);
  await film(page, B);
  await page.locator(`${B} > [data-act="row"]`).tap();
  f = await reel(page);
  check('Reduced motion: a header tapped low on the screen is at the top at once, open', !!(await page.$(`${B}.is-open`)) && new Set(f.map(([t]) => Math.round(t))).size <= 2 && f[f.length - 1][0] >= 0 && f[f.length - 1][0] <= 8, [...new Set(f.map(([t]) => Math.round(t)))].join(', '));
  await page.locator(`${B} > [data-act="row"]`).tap();
  await openRow(page, b);
  await page.locator(`${B} [data-act="pick"]`).first().tap();
  check('Reduced motion: a pick shows its tick and gold at once, nothing drawn', !!(await page.$(`${B} .vd.done`)) && !(await page.$(`${B} .ink`)) && !(await page.$(`${B}.flash`)) && !(await page.$('.ob-gone')));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('.foot [data-act="toc"]').tap();
  const t = await page.evaluate(() => getComputedStyle(document.querySelector('.sheet-panel')).transform);
  await page.evaluate(() => { window.__ys = []; const t0 = performance.now(); const f = () => { window.__ys.push(window.scrollY); if (performance.now() - t0 < 500) requestAnimationFrame(f); }; requestAnimationFrame(f); });
  await page.locator('.sheet-panel [data-act="jump"][data-to="judicial"]').tap();
  await page.waitForTimeout(550);
  const ys = await page.evaluate(() => window.__ys);
  check('Reduced motion: the menu is up at once and its jump lands at once, sheet gone, no mark', t === 'none' && new Set(ys.map((v) => Math.round(v))).size <= 2 && Math.abs(await topOf(page, '#sec-judicial')) <= 2 && !(await page.$('.sheet-panel, .sheet-ghost, .land')), `${t}, ${new Set(ys.map((v) => Math.round(v))).size} positions`);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await film(page, '#how');
  await page.locator('#how [data-act="open"][data-k="how"]').tap();
  f = await reel(page);
  check('Reduced motion: "How this guide works" opens at once', [...new Set(f.map(([, h]) => Math.round(h)))].length <= 2 && !!(await page.$('#how .how-bd')), [...new Set(f.map(([, h]) => Math.round(h)))].join(', '));
  noErrors(page, 'Reduced motion');
  await ctx.close();
}

/* ---------- the page keeps its place (review, Oct 20) ----------
   A row or a fold repainted at the top of the screen leaves what you tapped where it was. The
   browser's own scroll anchoring is off: a repaint took its anchor away, and it then followed
   something far below, throwing the page hundreds or thousands of pixels. Raw touch taps here, so
   Playwright scrolls nothing into view first. */
const touchAt = async (page, sel) => {
  const b = await page.locator(sel).first().boundingBox();
  await page.touchscreen.tap(b.x + Math.min(30, b.width / 2), b.y + b.height / 2);
  await page.waitForTimeout(140);
};
{
  const { ctx, page } = await newPage();
  await openZip(page, '20001');
  await page.waitForSelector('[data-act="choose-place"]');
  await tap(page, '[data-act="choose-place"][data-fk="cp-unsure"]');
  await throughSetup(page);
  const openRowNow = () => page.evaluate(() => { const r = document.querySelector('.ledger .row.is-open'); return r ? [r.dataset.item, r.getBoundingClientRect().top] : null; });
  await next(page);
  await settle(page);
  const first = await openRowNow();
  await tap(page, `#i-${first[0]} [data-act="skip"]`);
  await settle(page);
  await next(page);
  await settle(page);
  const [id, y0] = await openRowNow();
  await touchAt(page, `#i-${id} [data-act="pick"]`);
  await settle(page);
  const y1 = await topOf(page, `#i-${id}`);
  check('Place: Next up to the Shadow Senator, then a pick, leaves its header where it was (within 2px)', first[0] === 'dc-delegate' && id === 'dc-shadow-senator' && y0 <= 8 && Math.abs(y1 - y0) <= 2 && !!(await page.$(`#i-${id}:not(.is-open) .vd.done`)), `${first[0]}, then ${id} at ${Math.round(y0)}px, then ${Math.round(y1)}px`);
  noErrors(page, 'Place 20001');
  await ctx.close();
}
{
  const { ctx, page } = await newPage();
  await openBallot(page, '80205');
  const q = await page.evaluate(() => document.querySelector('.ledger .row[data-q]').id);
  const Q = `#${q}`;
  for (const y of [4, 60]) {
    await placeAt(page, Q, 300);
    await touchAt(page, `${Q} > .row-hd`);
    await settle(page);
    await placeAt(page, Q, y);
    const y0 = await topOf(page, Q);
    await touchAt(page, `${Q} > .row-hd`);
    await settle(page);
    const y1 = await topOf(page, Q);
    check(`Place: closing the district question by its header at ${y}px leaves the header there`, !(await page.$(`${Q}.is-open`)) && Math.abs(y1 - y0) <= 2, `${Math.round(y0)}px, then ${Math.round(y1)}px`);
  }
  noErrors(page, 'Place 80205');
  await ctx.close();
}
{
  const { ctx, page } = await newPage();
  await openBallot(page, '60614');
  const G = '[data-act="grp"][data-g="judicial|Circuit Court of Cook County"]';
  await placeAt(page, G, 4);
  const g0 = await topOf(page, G);
  await touchAt(page, G);
  await settle(page);
  const g1 = await topOf(page, G);
  check('Place: opening the Cook County court group near the top leaves its button there', (await page.getAttribute(G, 'aria-expanded')) === 'true' && Math.abs(g1 - g0) <= 2, `${Math.round(g0)}px, then ${Math.round(g1)}px`);
  const U = '#sec-judicial [data-act="open"][data-k="unopp-judicial"]';
  await placeAt(page, U, 4);
  const u0 = await topOf(page, U);
  await touchAt(page, U);
  await settle(page);
  const u1 = await topOf(page, U);
  check('Place: opening the unopposed races near the top leaves their button there', !!(await page.$(`${U}[aria-expanded="true"]`)) && Math.abs(u1 - u0) <= 2, `${Math.round(u0)}px, then ${Math.round(u1)}px`);
  noErrors(page, 'Place 60614');
  await ctx.close();
}

/* ---------- "Show endorsements" (Kevin, Oct 20): a switch that leads step 2, on to start. Off, every row
   shows just the choices and the controls that only matter with endorsements step aside ---------- */
{
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/?today=${TODAY}`);
  await page.waitForSelector('#zip');
  const ends = (p = page, where = '#setup') => p.getAttribute(`${where} [data-act="ends"]`, 'aria-checked');
  const leads = (where) => page.$eval(where, (s) => { const sw = s.querySelector('[data-act="ends"]'); const rest = s.querySelectorAll('[data-act="chip"], [data-act="setup-fill"], [data-act="setup-only"]');
    return !!sw && [...rest].every((e) => !!(sw.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING)); });
  check('Show endorsements: a switch in step 2 that reads "Show endorsements", on to start, ahead of the chips and the other switches', (await ends()) === 'true' && (await page.getAttribute('#setup [data-act="ends"]', 'role')) === 'switch'
    && (await text(page, '#setup [data-act="ends"] b')) === 'Show endorsements' && (await leads('#setup')) && (await page.getAttribute('#setup [data-act="chip"][data-k="papers"]', 'aria-pressed')) === 'true', await text(page, '#setup [data-act="ends"]'));
  await tap(page, '#setup [data-act="ends"]');
  check('Show endorsements: off, the chips, "A party" and the fill switch step aside, and "Hide races I’ve decided" stays', (await ends()) === 'false' && !(await page.$('#setup .su-chips, #setup [data-act="chip"], #setup [data-fk="chip-party"], #setup [data-act="setup-fill"]')) && !!(await page.$('#setup [data-act="setup-only"]')));
  await page.fill('#zip', '80205');
  await page.waitForSelector('.door-place', { timeout: 15000 });
  check('Show endorsements: with the ZIP found, still off, and no picks count to read', (await ends()) === 'false' && !(await page.$('#setup .su-cov')));
  await tap(page, SETUP);
  await page.waitForSelector('#plan', { timeout: 15000 });
  await page.waitForTimeout(150);
  check('Show endorsements off: the ballot says "Endorsements: Off"', (await text(page, '.picks-line span')) === 'Endorsements: Off', await text(page, '.picks-line span'));
  const vds = await page.$$eval('.ledger .row[data-item][data-undecided]:not(.is-info) .vd', (els) => els.map((e) => [e.className, e.textContent.trim()]));
  const blank = vds.filter(([c, t]) => /\bblank\b/.test(c) && t === '');
  const words = vds.filter(([c]) => !/\b(blank|review)\b/.test(c));
  check('Show endorsements off: the verdict column is empty and quiet on every undecided row (judges keep their official review)', blank.length > 20 && words.length === 0, `${blank.length} empty, others: ${words.slice(0, 3).map(([, t]) => t).join(' | ')}`);
  const race = await page.evaluate(() => { const r = [...document.querySelectorAll('#sec-state .row[data-item][data-undecided]')][0]; return r && r.dataset.item; });
  const R = `#i-${race}`;
  await openRow(page, race);
  await shot(page, '12-no-endorsements-row');
  const n = await page.$$eval(`${R} .clist [data-act="pick"]`, (els) => els.length);
  check('Show endorsements off: an open race is the candidates with Pick, their words in full, no grid, no source lines, no other sources', n >= 2 && !!(await page.$(`${R} .clist.full`)) && !(await page.$(`${R} .grid, ${R} .none-line, ${R} .gridnote, ${R} .others-wrap, ${R} .by`)) && !!(await page.$(`${R} .ob-acts`)), `${n} candidates`);
  await edit(page);
  check('Show endorsements: the Edit sheet leads with it, off, with no chips and no fill switch', (await ends(page, '.sheet-panel')) === 'false' && (await leads('.sheet-panel .sheet-bd'))
    && !(await page.$('.sheet-panel .su-chips, .sheet-panel [data-act="chip"], .sheet-panel [data-act="setup-fill"]')) && !!(await page.$('.sheet-panel [data-act="setup-only"]')));
  await tap(page, '.sheet-panel [data-act="ends"]');
  check('Show endorsements: on again, newspapers and guides are back with the fill switch', (await ends(page, '.sheet-panel')) === 'true' && (await page.getAttribute('.sheet-panel [data-act="chip"][data-k="papers"]', 'aria-pressed')) === 'true' && !!(await page.$('.sheet-panel [data-act="setup-fill"]')));
  await tap(page, '.sheet-panel [data-fk="sheet-x"]');
  await settle(page);
  // With no grid to read, the candidates' own words show in full (UX walk, Oct 20), so height no longer tells
  // the two apart: the grid coming back does.
  check('Show endorsements: the same open race has its sources back, words clamped again', !!(await page.$(`${R} .grid, ${R} .none-line`)) && !(await page.$(`${R} .clist.full`)));
  await edit(page);
  await tap(page, '.sheet-panel [data-act="ends"]');
  await tap(page, '.sheet-panel [data-fk="sheet-x"]');
  await settle(page);
  await page.locator(`${R} [data-act="pick"]`).first().tap();
  await page.waitForTimeout(400);
  await tap(page, '.foot [data-act="cheat"]');
  await page.waitForSelector('#cheat');
  await tap(page, '[data-act="save-open"]');
  const link = await page.inputValue('.save-url');
  check('Show endorsements off: the save link carries it as an empty source list', link.split('#')[1].split('~')[7] === '0', link.split('#')[1].split('~')[7]);
  noErrors(page, 'Show endorsements');
  const fresh = await newPage();
  await fresh.page.goto(linkHere(link));
  await fresh.page.waitForSelector('#plan', { timeout: 15000 });
  await fresh.page.waitForTimeout(250);
  if (await fresh.page.$('[data-act="shared-keep"]')) await tap(fresh.page, '[data-act="shared-keep"]');
  await edit(fresh.page);
  check('Show endorsements: off comes back from the save link', (await text(fresh.page, '.picks-line span')) === 'Endorsements: Off' && (await ends(fresh.page, '.sheet-panel')) === 'false', await text(fresh.page, '.picks-line span'));
  noErrors(fresh.page, 'Show endorsements link');
  await fresh.ctx.close();
  await ctx.close();
}

/* "Show endorsements" on the first page with a ballot that has choices of its own (review, Oct 20):
   the switch shows the ballot's choice, so a tap turns that over; and the next new ZIP takes what the
   page showed. With it off, the chips aren't there at all. */
{
  const { ctx, page } = await newPage();
  const none = async () => ((await page.getAttribute('#setup [data-act="ends"]', 'aria-checked')) === 'true' ? 'false' : 'true');
  const papers = async () => ((await page.$('#setup [data-act="chip"][data-k="papers"]')) ? page.getAttribute('#setup [data-act="chip"][data-k="papers"]', 'aria-pressed') : 'hidden');
  await openBallot(page, '80205');
  await edit(page);
  await tap(page, '.sheet-panel [data-act="ends"]');
  await tap(page, '.sheet-panel [data-fk="sheet-x"]');
  await settle(page);
  await tap(page, '[data-act="change-place"]');
  await page.waitForSelector('.door-place', { timeout: 15000 });
  check('Show endorsements, back on the first page: the switch shows the ballot\'s choice', (await none()) === 'true' && (await papers()) === 'hidden');
  await page.fill('#zip', '78704');
  await page.waitForFunction(() => /Austin/.test(document.querySelector('.door-place')?.textContent || ''), null, { timeout: 15000 });
  check('Show endorsements: a new ZIP from there keeps what the page showed', (await none()) === 'true' && (await papers()) === 'hidden', `${await none()} ${await papers()}`);
  await page.fill('#zip', '80205');
  await page.waitForFunction(() => /Denver/.test(document.querySelector('.door-place')?.textContent || ''), null, { timeout: 15000 });
  await tap(page, '#setup [data-act="ends"]');
  check('Show endorsements: on a saved ballot\'s first page, one tap turns it on and the newspapers come back', (await none()) === 'false' && (await papers()) === 'true', `${await none()} ${await papers()}`);
  await plainSetup(page);
  await page.waitForSelector('#plan', { timeout: 15000 });
  check('Show endorsements: and the ballot shows the newspapers\' picks', /Newspapers and guides/.test(await text(page, '.picks-line span')), await text(page, '.picks-line span'));
  // The other way: turned off before the ZIP, then a ZIP whose saved ballot uses the newspapers.
  await tap(page, '[data-act="change-place"]');
  await page.waitForSelector('.door-place', { timeout: 15000 });
  await page.fill('#zip', '');
  await page.waitForFunction(() => !document.querySelector('.door-place'));
  if ((await none()) !== 'true') await tap(page, '#setup [data-act="ends"]');
  await page.fill('#zip', '80205');
  await page.waitForFunction(() => /Denver/.test(document.querySelector('.door-place')?.textContent || ''), null, { timeout: 15000 });
  const shown = await none();
  await tap(page, '#setup [data-act="ends"]');
  check('Show endorsements: off before a ZIP whose ballot uses the newspapers, the switch shows on, and one tap turns it off', shown === 'false' && (await none()) === 'true' && (await papers()) === 'hidden', `${shown}, then ${await none()} ${await papers()}`);
  noErrors(page, 'Show endorsements, first page');
  await ctx.close();
}

/* ---------- common questions: quick answers with buttons (Kevin, Oct 20) ----------
   "They should be quick answers with things that you can do." An opened question shows one
   short line and its buttons; the full answer, steps and source wait behind "More". Each common
   mistake is one line, its full text behind its own "More". */
for (const [zip, label, id, btn, href, full] of [
  ['78702', 'Austin', 'not_registered', 'Register for next time', /^https:\/\/vote\.gov\/register\/texas$/, /the Texas deadline was October 5/],
  ['90004', 'Los Angeles', 'not_registered', 'Find a vote center', /^https:\/\/caearlyvoting\.sos\.ca\.gov\/$/, /RegisterToVote\.ca\.gov/],
]) {
  const { ctx, page } = await newPage();
  await openBallot(page, zip);
  await tap(page, '[data-act="open"][data-k="whatif"]');
  await tap(page, `[data-act="open"][data-k="wi-${id}"]`);
  const a = `.wi-a:has(.wi-short)`;
  const short = await text(page, `${a} .wi-short`);
  check(`${label}: "I'm not registered" opens to one short line`, short.length > 0 && short.split(/\s+/).length <= 20 && !full.test(await text(page, a)), short);
  const acts = await page.$$eval(`${a} .wi-acts a`, (els) => els.map((e) => ({ t: e.textContent.trim(), href: e.getAttribute('href'), blank: e.target === '_blank', h: e.getBoundingClientRect().height })));
  check(`${label}: with one or two official buttons, "${btn}" among them`, acts.length >= 1 && acts.length <= 2 && acts.every((x) => /^https:\/\//.test(x.href) && x.blank) && acts.some((x) => x.t === btn && href.test(x.href)), JSON.stringify(acts));
  check(`${label}: the buttons are big enough to tap`, acts.every((x) => x.h >= 44), acts.map((x) => Math.round(x.h)).join(','));
  await shot(page, `05-${label.toLowerCase().replace(/\s+/g, '-')}-quick-answer`);
  await tap(page, `[data-act="open"][data-k="wim-${id}"]`);
  check(`${label}: "More" shows the full answer, the steps and the source`, full.test(await text(page, `${a} .wi-full`)) && !!(await page.$(`${a} .wi-full ol li`)) && !!(await page.$(`${a} .wi-full .src`)) && (await page.getAttribute(`[data-k="wim-${id}"]`, 'aria-expanded')) === 'true');
  const tips = await page.$$eval('.whatifs .gotchas li.g-short', (els) => els.map((e) => e.firstChild.textContent.trim()));
  check(`${label}: each common mistake is one short line`, tips.length >= 5 && tips.every((t) => t.split(/\s+/).length <= 15), tips.join(' | '));
  const before = await text(page, '.whatifs .gotchas li.g-short:first-child');
  await tap(page, '.whatifs .gotchas [data-act="open"][data-k="gm-0"]');
  const after = await text(page, '.whatifs .gotchas li.g-short:first-child .pd-x');
  check(`${label}: a mistake's "More" shows its full text`, after.length > before.length, after.slice(0, 80));
  check(`${label}: nothing in all caps in the panel`, (await upperCased(page)).length === 0, (await upperCased(page)).join(' | '));
  await noSideScroll(page, `${label} common questions`);
  noErrors(page, `${label} common questions`);
  await ctx.close();
}

/* ---------- statewide-only, uncovered, shared ZIPs ---------- */
{
  const { ctx, page } = await newPage();
  await openBallot(page, '99201');
  await noSideScroll(page, 'Spokane');
  check('Spokane: says we only have statewide races so far', /We only have statewide races for your area so far\./.test(await text(page, '.bhead')));
  check('Spokane: links an official ballot lookup', !!(await page.$('.bhead .statewide-note a[href^="http"]')));
  check('Spokane: Official sample ballot and Ask for your city', (await page.$$eval('.statewide-note .row-btns a', (els) => els.map((e) => e.textContent.trim()))).join('|') === 'Official sample ballot|Ask for your city'
    && /docs\.google\.com/.test((await page.getAttribute('.statewide-note a:last-child', 'href')) || ''));
  check('Spokane: the sample ballot link is the state lookup, not one county\'s PDF', /^https:\/\/voter\.votewa\.gov\//.test((await page.getAttribute('.bhead .statewide-note a[href^="http"]', 'href')) || ''));
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
  check('Uncovered: the notice sits under the ZIP box, step 2 stays with no counts', !!(await page.$('.door .door-where .notice')) && !!(await page.$('#su-h')) && !(await page.$('.su-cov')) && !(await page.$('.door-place')));
  await tap(page, SETUP);
  check('Uncovered: "Show my ballot" stays on the first page', !(await page.$('#plan')) && (await focusedFk(page)) === 'zip');
  const ask = new URL((await page.getAttribute('.notice a[data-ask-kevin]', 'href')) || 'about:blank');
  check('Uncovered: "Want this for your city? Ask Kevin." opens the form with the state and ZIP', /Want this for your city\? Ask Kevin\./.test(await text(page, '.notice')) && ask.searchParams.get('entry.628621310') === 'Massachusetts, 02139', ask.search);
  await ctx.close();
}
{
  const { ctx, page } = await newPage();
  await openZip(page, '80247');
  await page.waitForSelector('[data-act="choose-place"]');
  check('80247: asks which place, with "I’m not sure"', (await page.$$('[data-act="choose-place"]')).length === 3 && /I’m not sure/.test(await text(page, '.choose')));
  check('80247: offers the address lookup to pick', !!(await page.$('.choose [data-act="addr-open"]')));
  check('80247: the place question sits under the ZIP box, step 2 beside it with no counts yet', !!(await page.$('.door .door-where .choose')) && !!(await page.$('#su-h')) && !(await page.$('.su-cov')));
  await tap(page, SETUP);
  check('80247: "Show my ballot" before a pick goes to the first place to pick', (await focusedFk(page)) === 'cp-aurora-co' && !(await page.$('#plan')), await focusedFk(page));
  await tap(page, '[data-act="choose-place"][data-ids="aurora-co"]');
  await page.waitForSelector('.door-place', { timeout: 15000 });
  check('80247: the place picked shows under the ZIP box, with Change, and step 2 counts it', (await text(page, '.door-place span')) === 'Aurora, Colorado · 80247' && !!(await page.$('.door-place [data-act="rechoose"]')) && !!(await page.$('.su-cov')), await text(page, '.door-place'));
  await tap(page, '.door-place [data-act="rechoose"]');
  check('80247: Change asks again', (await page.$$('[data-act="choose-place"]')).length === 3 && !(await page.$('.door-place')) && (await focusedFk(page)) === 'cp-aurora-co');
  await tap(page, '[data-act="choose-place"][data-ids="aurora-co+denver-co"]');
  await page.waitForSelector('.door-place', { timeout: 15000 });
  check('80247 not sure: the place line names both', (await text(page, '.door-place span')) === 'Aurora or Denver, Colorado · 80247', await text(page, '.door-place span'));
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
  check('Houston: both Klein ISD seats leave the ballot for "Not on your ballot"', !(await page.$('#i-tx-kleinisd-trustee-1')) && !(await page.$('#i-tx-kleinisd-trustee-2')) && /Klein ISD Trustee/.test(await text(page, '#off .disc')), await text(page, '#off .disc'));
  await tap(page, '[data-act="cheat"]');
  await tap(page, '[data-act="save-open"]');
  const link = await page.inputValue('.save-url');
  check('Houston: "Not on my ballot" travels in the save link', link.split('~').length === 10, `${link.split('~').length} fields`);
  const fresh = await newPage();
  await fresh.page.goto(linkHere(link));
  await fresh.page.waitForSelector('#plan', { timeout: 15000 });
  check('Houston link: those races come back in "Not on your ballot"', !(await fresh.page.$('#i-tx-kleinisd-trustee-1')) && /Klein ISD Trustee/.test(await text(fresh.page, '#off .disc')), await text(fresh.page, '#off .disc'));
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
  await edit(page);
  await tap(page, '.sheet-panel [data-act="sheet"][data-s="sources"]');
  await page.waitForSelector('.sheet-panel .sgrp');
  const pw = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.sheet-panel .srow')].find((r) => r.querySelector('.pw-note'));
    if (!row) return null;
    const a = row.querySelector('.pw-note a');
    return { name: row.querySelector('.s-n').textContent.trim(), note: row.querySelector('.pw-note').textContent.replace(/\s+/g, ' ').trim(), href: a ? a.href : '' };
  });
  check('Portland: a paywalled paper in See all sources carries the note, linking the report form with its name', !!pw && PW_NOTE_RE.test(pw.note) && pw.href.includes('docs.google.com/forms') && new URL(pw.href).searchParams.get('entry.90887649').includes(pw.name), pw ? `${pw.name}: ${pw.note}` : 'no paywalled source on this ballot');
  await tap(page, '[data-act="sheet-close"][data-fk="sheet-x"]');
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
  await edit(page);
  for (const k of ['progressive', 'conservative']) if (await page.$(`.sheet-panel [data-act="chip"][data-k="${k}"][aria-pressed="false"]`)) await tap(page, `.sheet-panel [data-act="chip"][data-k="${k}"]`);
  await tap(page, '.sheet-panel [data-act="setup-fill"]');
  await tap(page, '.sheet-panel [data-fk="sheet-x"]');
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
  check('Help friends vote: a spot to post ticks', (await page.getAttribute('[data-act="tick"][data-k="family"]', 'aria-pressed')) === 'true');
  noErrors(page, 'Lakewood');
  await ctx.close();
}
for (const [day, want] of [['2026-11-03', /^Today is Election Day\. Polls close at 7 PM\.$/], ['2026-11-04', /^Voting has closed/]]) {
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/?today=${day}&now=10:00`);
  await page.fill('#zip', '80226');
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
  // My plan stays light paper in dark mode: its save line takes no dark fill, so its dark ink reads.
  await tap(page, '.foot [data-act="cheat"]');
  const sg = await page.$eval('#cheat .save-go', (e) => [getComputedStyle(e).backgroundColor, getComputedStyle(e).color]);
  check('Dark mode: My plan’s save line is dark ink on the sheet, no dark fill', sg[0] === 'rgba(0, 0, 0, 0)' && sg[1] === 'rgb(31, 38, 35)', sg.join(' / '));
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
  check('Austin: the public message says Election Day and the early-voting dates', /Election Day in Texas is Tue, Nov 3\./.test(pub) && /Early voting (in Austin )?runs Mon, Oct 19 through Fri, Oct 30\./.test(pub), pub.slice(0, 140));
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
  check('Austin: "None of these" moves them all to "Not on your ballot" and the line goes', !(await page.$('#sec-school .grp.oth')) && /^Not on your ballot: /.test(await text(page, '#off .disc')), await text(page, '#off .disc'));
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
  check('Orlando: under it, Orange County\'s hours and the photo ID, and nothing else', (await text(page, '.plan-sub')) === 'Orange County sites are open 8 AM to 8 PM every day. Bring a photo ID.', await text(page, '.plan-sub'));
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
  await editFill(page);
  const filled = await page.evaluate(() => { const r = [...document.querySelectorAll('#sec-measures .row[data-item]')].find((x) => /From your sources/.test(x.textContent)); return r ? { id: r.dataset.item, v: /Yes\s*$/.test(r.querySelector('.vd .m').textContent) ? 'YES' : 'NO' } : null; });
  check('Undo after a hand edit: a measure was filled', !!filled);
  if (filled) {
    await openRow(page, filled.id);
    await tap(page, `#i-${filled.id} [data-act="pick"][data-v="${filled.v}"]`);
    await tap(page, '.toast [data-act="undo-bulk"]').catch(() => {});
    const still = await text(page, `#i-${filled.id} .vd .m`);
    check('Undo after a hand edit: the pick you confirmed by hand stays', new RegExp(filled.v === 'YES' ? 'Yes$' : 'No$').test(still) && !/From your sources/.test(await text(page, `#i-${filled.id}`)), still);
  }
  noErrors(page, 'Undo after a hand edit');
  await ctx.close();
}
// #12: after the polls close on Election Day.
{
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/?today=2026-11-03&now=19:05`);
  await page.fill('#zip', '77002');
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
  await edit(page);
  await tap(page, '.sheet-panel [data-act="sheet"][data-s="sources"]');
  await page.waitForSelector('.sheet-panel .sgrp');
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
  await page.keyboard.press('Escape'); // back to the Edit sheet
  await page.waitForTimeout(150);
  check('Sheet: the Edit sheet holds the keyboard too', await wraps('.sheet-panel.picks'));
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
// #10: "Hide races I've decided" drops a decided row on the next move, even on a one-row repaint.
{
  const { ctx, page } = await newPage();
  await openBallot(page, '80205');
  await menu(page);
  await tap(page, '.sheet-panel [data-act="only"]');
  await tap(page, '.sheet-panel [data-fk="sheet-x"]');
  const ids = await page.evaluate(() => [...document.querySelectorAll('#sec-measures .row[data-item]')].slice(0, 2).map((r) => r.dataset.item));
  await openRow(page, ids[0]);
  await tap(page, `#i-${ids[0]} [data-act="pick"][data-v="YES"]`);
  check('Hide races I’ve decided: the row you just decided stays for a moment', !!(await page.$(`#i-${ids[0]}`)));
  await openRow(page, ids[1]);
  check('Hide races I’ve decided: opening the next row drops the decided one', !(await page.$(`#i-${ids[0]}`)) && !!(await page.$(`#i-${ids[1]}.is-open`)));
  noErrors(page, 'Hide races I’ve decided');
  await ctx.close();
}
/* Frame by frame for `ms`: whether a husk is folding away, and the top of each selector (null when
   it isn't on the page). */
const sample = (page, ms, sels) => page.evaluate(([ms, sels]) => new Promise((res) => {
  const out = [];
  const t0 = performance.now();
  const f = () => {
    const t = performance.now() - t0;
    out.push({ t, husk: !!document.querySelector('.row-gone, .sec-gone'), tops: sels.map((s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect().top : null; }) });
    if (t < ms) requestAnimationFrame(f); else res(out);
  };
  requestAnimationFrame(f);
}), [ms, sels]);
/* "A beat, then they collapse" (Kevin, Oct 20): under "Hide races I've decided" a pick closes the row,
   which shows its pick in gold for about 900ms, then folds away while the rows under it slide up;
   the band above stays still. Opening another row in the beat ends it at once, the tapped header
   held where it was; reopening the row keeps it. */
{
  const { ctx, page } = await newPage();
  await openBallot(page, '80205');
  await menu(page);
  await tap(page, '.sheet-panel [data-act="only"]');
  await tap(page, '.sheet-panel [data-fk="sheet-x"]');
  await settle(page);
  const ids = await page.evaluate(() => [...document.querySelectorAll('#sec-measures .row[data-item][data-undecided]')].slice(0, 5).map((r) => r.dataset.item));
  await page.evaluate((id) => { const r = document.getElementById(`i-${id}`); window.scrollBy(0, r.getBoundingClientRect().top - 220); }, ids[0]);
  await openRow(page, ids[0]);
  await settle(page);
  await page.locator(`#i-${ids[0]} [data-act="pick"][data-v="YES"]`).first().tap();
  const beat = await page.evaluate((id) => { const r = document.getElementById(`i-${id}`); return r && { beat: r.hasAttribute('data-beat'), open: r.classList.contains('is-open'), gold: !!r.querySelector('.vd.done'), count: document.querySelector('#sec-measures .sec-r').textContent.replace(/\s+/g, ' ').trim() }; }, ids[0]);
  check('Beat: a pick closes the row, which stays with its pick in gold', !!beat && beat.beat && !beat.open && beat.gold, JSON.stringify(beat));
  check('Beat: the band counts it at once, with Show for the hidden one', !!beat && /^1 of \d+ decided ?Show$/.test(beat.count), beat && beat.count);
  const s = await sample(page, 1700, ['#sec-measures > .sec-h', `#i-${ids[1]}`, `#i-${ids[0]}`]);
  const goneAt = s.findIndex((x) => x.tops[2] === null);
  const tGone = goneAt >= 0 ? s[goneAt].t : -1;
  check('Beat: the row waits about 900ms before it goes', tGone >= 650 && tGone <= 1250, `${Math.round(tGone)}ms`);
  check('Beat: then it folds away (a husk, for a moment)', s.some((x) => x.husk) && !s[s.length - 1].husk);
  // (The pick's own panel fold may bring the row back into view first: motion.followFold, 160ms.)
  const bandTops = s.filter((x) => x.t >= 300).map((x) => x.tops[0]);
  check('Beat: the band above holds still through the beat and the fold', Math.max(...bandTops) - Math.min(...bandTops) <= 1, `${Math.min(...bandTops)} to ${Math.max(...bandTops)}`);
  const before = goneAt > 0 ? s[goneAt - 1].tops[1] : null;
  const after = s[s.length - 1].tops[1];
  const mid = s.filter((x) => x.husk && x.tops[1] !== null && x.tops[1] < before - 2 && x.tops[1] > after + 2).length;
  check('Beat: the row under it slides up into its place, not in one jump', before !== null && after < before - 40 && mid >= 2, `${before} to ${after}, ${mid} frames between`);
  check('Beat: gone, and the band still says so', !(await page.$(`#i-${ids[0]}`)) && /^1 of \d+ decided Show$/.test(await text(page, '#sec-measures .sec-r')), await text(page, '#sec-measures .sec-r'));
  // Another row opened in the beat: the decided one goes at once and the tapped header holds still.
  await openRow(page, ids[1]);
  await settle(page);
  await page.locator(`#i-${ids[1]} [data-act="pick"][data-v="NO"]`).first().tap();
  await page.waitForTimeout(250);
  check('Beat: the next pick waits its beat too', !!(await page.$(`#i-${ids[1]}[data-beat]`)));
  const top2 = await page.$eval(`#i-${ids[2]} > .row-hd`, (e) => e.getBoundingClientRect().top);
  await page.locator(`#i-${ids[2]} > [data-act="row"]`).tap();
  const now2 = await page.evaluate((id) => ({ top: document.querySelector(`#i-${id} > .row-hd`).getBoundingClientRect().top, open: document.getElementById(`i-${id}`).classList.contains('is-open') }), ids[2]);
  check('Beat: opening another row ends the beat first: the decided row is gone, no husk left', !(await page.$(`#i-${ids[1]}`)) && !(await page.$('.row-gone')) && now2.open);
  check('Beat: and the header you tapped stays where it was', Math.abs(now2.top - top2) <= 1, `${top2} then ${now2.top}`);
  await settle(page);
  // Reopened in its beat, a row stays.
  await page.locator(`#i-${ids[2]} [data-act="pick"][data-v="YES"]`).first().tap();
  await page.waitForTimeout(200);
  await page.locator(`#i-${ids[2]} > [data-act="row"]`).tap();
  await page.waitForTimeout(1300);
  check('Beat: a row reopened in its beat stays, open', !!(await page.$(`#i-${ids[2]}.is-open`)) && !(await page.$(`#i-${ids[2]}[data-beat]`)));
  // Closed by its header while decided: the same beat, then it goes.
  await page.locator(`#i-${ids[2]} > [data-act="row"]`).tap();
  await page.waitForTimeout(250);
  check('Beat: a decided row closed by its header waits its beat', !!(await page.$(`#i-${ids[2]}[data-beat]`)));
  await settle(page);
  check('Beat: then it goes', !(await page.$(`#i-${ids[2]}`)) && /^3 of \d+ decided Show$/.test(await text(page, '#sec-measures .sec-r')), await text(page, '#sec-measures .sec-r'));
  // The count shows the section's decided rows and hides them again; the choice lasts the visit.
  await tap(page, '#sec-measures [data-act="sec-count"]');
  await settle(page);
  check('Counts: "Show" shows the section\'s decided rows', !!(await page.$(`#i-${ids[0]}`)) && !!(await page.$(`#i-${ids[1]}`)) && !!(await page.$(`#i-${ids[2]}`)) && (await text(page, '#sec-measures .sec-edit')) === 'Hide' && (await page.getAttribute('#sec-measures [data-act="sec-count"]', 'aria-expanded')) === 'true');
  check('Counts: the count itself still reads "N of M decided"', /^3 of \d+ decided$/.test(await text(page, '#sec-measures .sec-count')), await text(page, '#sec-measures .sec-count'));
  check('Counts: other sections keep hiding theirs', !(await page.$('.ledger .sec:not(#sec-measures) .row[data-item]:not([data-undecided])')));
  await openRow(page, ids[3]);
  await settle(page);
  await page.locator(`#i-${ids[3]} [data-act="pick"][data-v="YES"]`).first().tap();
  await page.waitForTimeout(1300);
  check('Counts: while shown, a new pick there stays on the page', !!(await page.$(`#i-${ids[3]}`)) && !(await page.$(`#i-${ids[3]}[data-beat]`)));
  await tap(page, '#sec-measures [data-act="sec-count"]');
  await settle(page);
  check('Counts: "Hide" hides them again', !(await page.$(`#i-${ids[0]}`)) && !(await page.$(`#i-${ids[3]}`)) && (await text(page, '#sec-measures .sec-r')).endsWith('decided Show'), await text(page, '#sec-measures .sec-r'));
  await tap(page, '#sec-measures [data-act="sec-count"]');
  await page.reload();
  await page.waitForSelector('#plan', { timeout: 15000 });
  await page.waitForTimeout(150);
  check('Counts: what a count showed is saved with the ballot; after a reload they still show', !!(await page.$(`#i-${ids[0]}`)) && /^4 of \d+ decided Hide$/.test(await text(page, '#sec-measures .sec-r')), await text(page, '#sec-measures .sec-r'));
  // The section's last race: the section folds to its band, the band holding still.
  const cid = await page.evaluate(() => document.querySelector('#sec-city .row[data-item][data-undecided]')?.dataset.item);
  await page.evaluate((id) => { const r = document.getElementById(`i-${id}`); window.scrollBy(0, r.getBoundingClientRect().top - 260); }, cid);
  await openRow(page, cid);
  await settle(page);
  await page.locator(`#i-${cid} [data-act="pick"]`).first().tap();
  const sc = await sample(page, 1600, ['#sec-city > .sec-h']);
  const ct = sc.map((x) => x.tops[0]).filter((x) => x !== null);
  check('Beat: a section\'s last race folds the section to its band, "1 of 1 decided" with Show', !!(await page.$('#sec-city.folded')) && !(await page.$('#sec-city .row')) && (await text(page, '#sec-city .sec-r')) === '1 of 1 decided Show', await text(page, '#sec-city .sec-r'));
  check('Beat: the band holds still as the section folds under it', ct.length === sc.length && Math.max(...ct) - Math.min(...ct) <= 1 && sc.some((x) => x.husk), `${Math.min(...ct)} to ${Math.max(...ct)}`);
  noErrors(page, 'Beat and counts');
  await ctx.close();
}
{
  // A keyboard pick: when its row folds away, focus goes on to the row that took its place.
  const { ctx, page } = await newPage();
  await openBallot(page, '80205');
  await page.click('.foot [data-act="toc"]');
  await page.waitForSelector('.sheet-panel.toc');
  await page.click('.sheet-panel [data-act="only"]');
  await page.keyboard.press('Escape');
  await settle(page);
  const [k0, k1] = await page.evaluate(() => [...document.querySelectorAll('#sec-measures .row[data-item][data-undecided]')].slice(0, 2).map((r) => r.dataset.item));
  // (A click within 650ms of the last tap is the tap's own follow-up, main.ts: wait it out.)
  await page.waitForTimeout(700);
  await page.focus(`#i-${k0} > [data-act="row"]`);
  await page.keyboard.press('Enter');
  await settle(page);
  await page.waitForTimeout(700);
  await page.focus(`#i-${k0} [data-act="pick"][data-v="YES"]`);
  await page.keyboard.press('Enter');
  check('Beat, keyboard: the pick waits its beat with focus on its row', !!(await page.$(`#i-${k0}[data-beat]`)) && (await focusedFk(page)) === `row-${k0}`, await focusedFk(page));
  await settle(page);
  check('Beat, keyboard: once it folds away, focus is on the row that took its place', !(await page.$(`#i-${k0}`)) && (await focusedFk(page)) === `row-${k1}`, await focusedFk(page));
  noErrors(page, 'Beat, keyboard');
  await ctx.close();
}
{
  // A band tapped while a row above it is in its beat: the row goes at once, and the band under
  // your finger stays where it was, for its count and for a folded band's title.
  const { ctx, page } = await newPage();
  await openBallot(page, '80205');
  await menu(page);
  await tap(page, '.sheet-panel [data-act="only"]');
  await tap(page, '.sheet-panel [data-fk="sheet-x"]');
  await settle(page);
  // City's one race decided folds it to its band; one measure decided gives Measures its "Show".
  for (const sec of ['city', 'measures']) {
    const id = await page.evaluate((s) => document.querySelector(`#sec-${s} .row[data-item][data-undecided]`).dataset.item, sec);
    await openRow(page, id);
    await settle(page);
    await page.locator(`#i-${id} [data-act="pick"]`).first().tap();
    await page.waitForTimeout(1300);
    await settle(page);
  }
  check('Beat under a band: City folded to its band, Measures has 1 decided', !!(await page.$('#sec-city.folded')) && /^1 of \d+ decided Show$/.test(await text(page, '#sec-measures .sec-r')), `${await text(page, '#sec-city .sec-r')} | ${await text(page, '#sec-measures .sec-r')}`);
  const held = async (band, target) => {
    const left = await page.evaluate(() => [...document.querySelectorAll('#sec-judicial .row[data-item][data-undecided]')].map((r) => r.dataset.item));
    const id = left[left.length - 2];
    await openRow(page, id);
    await settle(page);
    await page.evaluate((b) => { const h = document.querySelector(`#sec-${b} > .sec-h`); window.scrollBy(0, h.getBoundingClientRect().top - 560); }, band);
    await page.waitForTimeout(100);
    await page.locator(`#i-${id} [data-act="pick"]`).first().tap();
    await page.waitForTimeout(300);
    const beat = !!(await page.$(`#i-${id}[data-beat]`));
    const b0 = await page.$eval(`#sec-${band} > .sec-h`, (e) => e.getBoundingClientRect().top);
    await page.locator(target).first().tap();
    const b1 = await page.$eval(`#sec-${band} > .sec-h`, (e) => e.getBoundingClientRect().top);
    await settle(page);
    return { beat, b0, b1, gone: !(await page.$(`#i-${id}`)) };
  };
  const c = await held('measures', '#sec-measures [data-act="sec-count"]');
  check('Beat under a band: tapping its count ends the beat and the band stays where it was', c.beat && c.gone && Math.abs(c.b1 - c.b0) <= 1 && (await text(page, '#sec-measures .sec-edit')) === 'Hide', `beat ${c.beat}, ${c.b0} then ${c.b1}`);
  const f = await held('city', '#sec-city [data-act="sec"]');
  check('Beat under a band: tapping a folded band’s title does the same', f.beat && f.gone && Math.abs(f.b1 - f.b0) <= 1 && !(await page.$('#sec-city.folded')), `beat ${f.beat}, ${f.b0} then ${f.b1}`);
  // What you showed under the filter is still showing after a reload (Kevin, Oct 20).
  const shownBefore = await page.$$eval('#sec-measures .row[data-item]:not([data-undecided])', (els) => els.length);
  await page.reload();
  await page.waitForSelector('#plan', { timeout: 15000 });
  await settle(page);
  check('Hide races I’ve decided: sections you opened stay open after a reload, decided rows and all', (await text(page, '#sec-measures .sec-edit')) === 'Hide' && !(await page.$('#sec-city.folded'))
    && shownBefore > 0 && (await page.$$eval('#sec-measures .row[data-item]:not([data-undecided])', (els) => els.length)) === shownBefore, `${shownBefore} | ${await text(page, '#sec-measures .sec-r')}`);
  noErrors(page, 'Beat under a band');
  await ctx.close();
}
{
  // Reduced motion: no animation; the row just goes after its beat.
  const { ctx, page } = await newPage({ reducedMotion: 'reduce' });
  await openBallot(page, '80205');
  await menu(page);
  await tap(page, '.sheet-panel [data-act="only"]');
  await tap(page, '.sheet-panel [data-fk="sheet-x"]');
  const id = await page.evaluate(() => document.querySelector('#sec-measures .row[data-item][data-undecided]').dataset.item);
  await openRow(page, id);
  await page.locator(`#i-${id} [data-act="pick"][data-v="YES"]`).first().tap();
  const s = await sample(page, 1400, [`#i-${id}`]);
  const at = s.findIndex((x) => x.tops[0] === null);
  check('Beat, reduced motion: the row stays its beat, then goes with no husk', at > 0 && s[at].t >= 650 && s[at].t <= 1250 && !s.some((x) => x.husk), `${at >= 0 ? Math.round(s[at].t) : -1}ms`);
  noErrors(page, 'Beat, reduced motion');
  await ctx.close();
}
{
  // Without the filter, a band's count folds and unfolds its section, even one still being decided;
  // the band itself still goes to the next race left. The choice is saved with the ballot.
  const { ctx, page } = await newPage();
  await openBallot(page, '80205');
  check('Counts: without the filter the count reads "0 of 2 decided" with Hide', (await text(page, '#sec-federal .sec-r')) === '0 of 2 decided Hide' && (await page.getAttribute('#sec-federal [data-act="sec-count"]', 'aria-expanded')) === 'true', await text(page, '#sec-federal .sec-r'));
  await page.locator('#sec-state [data-act="sec-count"]').scrollIntoViewIfNeeded();
  const b0 = await page.$eval('#sec-state > .sec-h', (e) => e.getBoundingClientRect().top);
  await tap(page, '#sec-state [data-act="sec-count"]');
  await settle(page);
  const b1 = await page.$eval('#sec-state > .sec-h', (e) => e.getBoundingClientRect().top);
  check('Counts: tapped, it folds the section, the band where it was', !!(await page.$('#sec-state.folded')) && !(await page.$('#sec-state .row')) && (await text(page, '#sec-state .sec-r')) === '0 of 8 decided Show' && Math.abs(b1 - b0) <= 1, `${b0} then ${b1}`);
  check('Counts: the bar still counts the folded races', /^0 of /.test(await text(page, '.bar-txt')));
  await page.reload();
  await page.waitForSelector('#plan', { timeout: 15000 });
  await settle(page);
  check('Counts: a section you folded stays folded after a reload', !!(await page.$('#sec-state.folded')) && (await text(page, '#sec-state .sec-r')) === '0 of 8 decided Show', await text(page, '#sec-state .sec-r'));
  await tap(page, '#sec-state [data-act="sec-count"]');
  await settle(page);
  check('Counts: tapped again, it unfolds', !(await page.$('#sec-state.folded')) && (await page.$$('#sec-state .row[data-undecided]')).length >= 6 && (await text(page, '#sec-state .sec-edit')) === 'Hide');
  noErrors(page, 'Counts without the filter');
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
  await page.waitForSelector('.door-place', { timeout: 15000 });
  const found = await text(page, '.door-found');
  await throughSetup(page);
  check('Address: Aurora, Colorado opens its ballot and answers its districts', /Aurora/.test(await text(page, '.place')) && found === 'Found: Test Not it? Try again' && (await text(page, '.addrbox .addr-set')) === AURORA_SET, `${found} | ${await text(page, '.addrbox .addr-set')}`);
  noErrors(page, 'Address');
  await ctx.close();
}

// The first page's "Use my address for a more exact ballot": no ZIP and no ballot yet.
// Census is answered here, with made-up addresses.
{
  const { ctx, page } = await newPage();
  const geoFor = (fips, place, cd, upper, matched = 'TEST') => ({ result: { addressMatches: [{ matchedAddress: matched, geographies: {
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
    await page.waitForSelector('form[data-form="addr"] [role="status"], .door-place, .notice', { timeout: 8000 }).catch(() => {});
  };
  await lookUp();
  check('Address on the first page: a place it can’t settle says so in one line and keeps the ZIP box', (await text(page, 'form[data-form="addr"] [role="status"]')) === 'We couldn’t tell which place that is. Try your ZIP.' && !!(await page.$('#zip')), await text(page, 'form[data-form="addr"] [role="status"]'));
  check('Address on the first page: with no ZIP typed, the address goes as typed', asked[0] === 'a test lookup', asked.join(' | '));
  answer = geoFor('25', 'Cambridge', 7, 2);
  await lookUp();
  check('Address on the first page: a state we don’t cover says so', /We don’t cover Massachusetts yet/.test(await text(page, '.notice')), await text(page, '.notice'));
  await tap(page, '.front [data-act="addr-open"]');
  answer = geoFor('08', 'Aurora', 6, 28, 'TEST THREE, AURORA, CO, 80247');
  await lookUp();
  await page.waitForSelector('.door-place', { timeout: 15000 });
  const found = 'Found: Test Three, Aurora, CO 80247 Not it? Try again';
  check('Address on the first page: Aurora, Colorado shows under the ZIP box, then what the Census found', /^Aurora, Colorado/.test(await text(page, '.door-place span')) && (await text(page, '.door-found')) === found, `${await text(page, '.door-place span')} | ${await text(page, '.door-found')}`);
  check('Address on the first page: no toast; the address link steps aside', !/address|district/i.test(await text(page, '.toast')) && !(await page.$('.front [data-act="addr-open"]')), await text(page, '.toast'));
  check('Address on the first page: focus moves on to step 2', (await focusedFk(page)) === 'su-h', await focusedFk(page));
  await shot(page, '00e-address-found');
  // Not it? Try again: the form with what was typed, and the lookup again from there.
  await tap(page, '.front [data-act="addr-again"]');
  check('Address on the first page: Not it? Try again reopens the form with what you typed', (await page.inputValue('#addr-in').catch(() => '')) === 'a test lookup' && !(await page.$('.door-found')));
  const n0 = asked.length;
  await page.locator('form[data-form="addr"] button[type=submit]').tap();
  await page.waitForSelector('.door-found', { timeout: 15000 }).catch(() => {});
  check('Address on the first page: and asks the Census again', asked.length > n0 && (await text(page, '.door-found')) === found, `${n0} then ${asked.length}`);
  const cov = Number(((await text(page, '.su-cov')).match(/of your (\d+) races?/) || [])[1]);
  await plainSetup(page);
  await page.waitForSelector('#plan', { timeout: 15000 });
  const m = Number(((await text(page, '.bar-txt')).match(/of (\d+)/) || [])[1]);
  check('Address on the first page: step 2’s count was the ballot’s, districts set', cov > 0 && cov === m, `${cov} vs ${m}`);
  const kept = await text(page, '.addrbox .addr-set');
  // Senate District 28 isn't one of Aurora's (SD-27, SD-29), so that question reads "Not on your ballot" and the line doesn't name it.
  check('Address on the first page: the ballot keeps what was set, in the address box, naming only races it put on the ballot', kept === AURORA_SET && !/Set from|districts/i.test(await text(page, '.mast')), kept);
  check('Address on the first page: the box still shows what was found this visit', (await text(page, '.addrbox .addr-found')) === found);
  check('Address on the first page: District 6 puts Aurora’s U.S. House race on the ballot, no longer a maybe', !!(await page.$('#i-co-us-house-6')) && !/Maybe on your ballot/.test(await text(page, '#i-co-us-house-6')), await text(page, '#i-co-us-house-6'));
  noErrors(page, 'Address on the first page');
  await ctx.close();
}
// A DC ward's ZIP: nothing on the ballot turns on the address, so there is no address box before a
// lookup; after one from the first page, the box holds only what was found, this visit; after a
// reload there is no box again. Census is answered here, with a made-up address.
{
  const { ctx, page } = await newPage();
  const answer = { result: { addressMatches: [{ matchedAddress: 'TEST FOUR, WASHINGTON, DC, 20016', geographies: {
    States: [{ STATE: '11' }], 'Incorporated Places': [{ BASENAME: 'Washington' }], '119th Congressional Districts': [{ BASENAME: '98' }],
    '2024 State Legislative Districts - Upper': [{ BASENAME: '3' }] } }] } };
  await page.route('https://geocoding.geo.census.gov/**', (route) => {
    const cb = new URL(route.request().url()).searchParams.get('callback');
    return route.fulfill({ status: 200, contentType: 'application/javascript', body: `${cb}(${JSON.stringify(answer)})` });
  });
  await openBallot(page, '20016');
  check('DC ward: before a lookup, no address box', !(await page.$('.addrbox')), await text(page, '.addrbox'));
  await page.evaluate(() => localStorage.clear());
  await openZip(page, '20016');
  await page.waitForSelector('.door-place', { timeout: 15000 });
  await tap(page, '.front [data-act="addr-open"]');
  await page.fill('#addr-in', 'a test lookup');
  await page.locator('form[data-form="addr"] button[type=submit]').tap();
  await page.waitForSelector('.door-found', { timeout: 15000 });
  await plainSetup(page);
  await page.waitForSelector('#plan', { timeout: 15000 });
  const found = 'Found: Test Four, Washington, DC 20016 Not it? Try again';
  check('DC ward: after a lookup, the box holds only what was found, no "the rest"', (await text(page, '.addrbox')) === found && !(await page.$('.addrbox .addr-n, .addrbox .addr-set, .addrbox .row-btns')), await text(page, '.addrbox'));
  await tap(page, '.addrbox [data-act="addr-again"]');
  check('DC ward: Not it? Try again opens the form in the box', !!(await page.$('.addrbox form[data-form="addr"]')) && (await page.inputValue('#addr-in')) === 'a test lookup');
  await tap(page, '.addrbox [data-act="addr-close"]');
  check('DC ward: Cancel brings back what was found', (await text(page, '.addrbox')) === found, await text(page, '.addrbox'));
  await page.waitForTimeout(400);
  await page.reload();
  await page.waitForSelector('#plan', { timeout: 15000 });
  await page.waitForTimeout(150);
  check('DC ward: after a reload, no address box, as before the lookup', !(await page.$('.addrbox')) && !/test four|a test lookup/i.test((await savedVG(page)) || ''), await text(page, '.addrbox'));
  noErrors(page, 'DC ward address');
  await ctx.close();
}

// Several Census matches (Kevin, Oct 20: "did I select the right address?"): "Which one is yours?",
// one button each, and the one tapped is the one applied. A miss says so, with what you typed kept.
// Census is answered here, with made-up addresses.
{
  const { ctx, page } = await newPage();
  const m = (matched, cd, upper, lower) => ({ matchedAddress: matched, geographies: {
    States: [{ STATE: '48' }], 'Incorporated Places': [{ BASENAME: 'Austin' }], '119th Congressional Districts': [{ BASENAME: String(cd) }],
    '2024 State Legislative Districts - Upper': [{ BASENAME: String(upper) }], '2024 State Legislative Districts - Lower': [{ BASENAME: String(lower) }] } });
  let matches = [];
  await page.route('https://geocoding.geo.census.gov/**', (route) => {
    const cb = new URL(route.request().url()).searchParams.get('callback');
    return route.fulfill({ status: 200, contentType: 'application/javascript', body: `${cb}(${JSON.stringify({ result: { addressMatches: matches } })})` });
  });
  await openBallot(page, '78704');
  const submit = async () => {
    await page.locator('form[data-form="addr"] button[type=submit]').tap();
    await page.waitForSelector('.addrbox .addr-which, .addrbox .addr-found, form[data-form="addr"] [role="status"]', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(150);
  };
  // A miss: nothing found, one line, and the address still in the box.
  await tap(page, '.addrbox [data-act="addr-open"]');
  await page.fill('#addr-in', 'a test lookup');
  await submit();
  check('Address miss: says the Census couldn’t find it, and keeps what you typed', (await text(page, 'form[data-form="addr"] [role="status"]')) === 'The Census lookup couldn’t find that address. Try adding the city and ZIP.' && (await page.inputValue('#addr-in')) === 'a test lookup' && !(await page.$('.addr-found')), await text(page, 'form[data-form="addr"] [role="status"]'));
  // Several: one button each, the same address once.
  matches = [m('TEST ONE, AUSTIN, TX, 78704', 37, 14, 49), m('TEST ONE, AUSTIN, TX, 78704', 37, 14, 49), m('TEST TWO, AUSTIN, TX, 78745', 35, 21, 50)];
  await submit();
  const opts = await page.$$eval('.addrbox .addr-which [data-act="addr-which"]', (els) => els.map((e) => e.textContent.trim()));
  check('Several matches: "Which one is yours?" with one button each, the same address once', (await text(page, '.addrbox .addr-which #aw-h')) === 'Which one is yours?' && opts.join(' | ') === 'Test One, Austin, TX 78704 | Test Two, Austin, TX 78745' && (await text(page, '.addrbox [data-fk="aw-none"]')) === 'None of these', opts.join(' | '));
  check('Several matches: focus on the first', (await focusedFk(page)) === 'aw-0', await focusedFk(page));
  check('Several matches: nothing set yet', !(await page.$('.addrbox .addr-set')) && /^\d+ races depend on your address\./.test(await text(page, '.addrbox .addr-n')));
  await shot(page, '04e-which-address');
  const bigEnough = await small44(page, '.addrbox .addr-which');
  check('Several matches: every button is a full-size tap', bigEnough.length === 0, bigEnough.join(', '));
  await tap(page, '.addrbox [data-act="addr-again"]');
  check('Several matches: None of these brings back the form with what you typed', (await page.inputValue('#addr-in').catch(() => '')) === 'a test lookup' && !(await page.$('.addr-which')));
  await submit();
  await tap(page, '.addrbox [data-act="addr-which"][data-i="1"]');
  await page.waitForSelector('.addrbox .addr-found', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(150);
  check('Several matches: the one tapped is the one found', (await text(page, '.addrbox .addr-found')) === 'Found: Test Two, Austin, TX 78745 Not it? Try again', await text(page, '.addrbox .addr-found'));
  check('Several matches: and its districts are the ones set', (await text(page, '.addrbox .addr-set')) === 'Set from your address: State Senator, District 21 · State Representative, District 50.', await text(page, '.addrbox .addr-set'));
  check('Several matches: Senate District 21 puts that race on the ballot, no longer a maybe', !!(await page.$('#i-tx-senate-21')) && !/Maybe on your ballot/.test(await text(page, '#i-tx-senate-21')), await text(page, '#i-tx-senate-21'));
  await page.waitForTimeout(400);
  check('Several matches: neither address is saved', !/test (one|two)|a test lookup/i.test((await savedVG(page)) || ''));
  noErrors(page, 'Several matches');
  await ctx.close();
}
// The first page, several matches: the list, then the one tapped opens its ballot.
{
  const { ctx, page } = await newPage();
  const m = (matched, zip, cd) => ({ matchedAddress: matched, geographies: {
    States: [{ STATE: '48' }], 'Incorporated Places': [{ BASENAME: 'Austin' }], 'ZIP Code Tabulation Areas': [{ ZCTA5: zip }], '119th Congressional Districts': [{ BASENAME: String(cd) }] } });
  await page.route('https://geocoding.geo.census.gov/**', (route) => {
    const cb = new URL(route.request().url()).searchParams.get('callback');
    return route.fulfill({ status: 200, contentType: 'application/javascript', body: `${cb}(${JSON.stringify({ result: { addressMatches: [m('TEST ONE, AUSTIN, TX, 78704', '78704', 37), m('TEST TWO, AUSTIN, TX, 78745', '78745', 35)] } })})` });
  });
  await page.goto(`${BASE}/?today=${TODAY}`);
  await page.waitForSelector('#zip');
  await tap(page, '.front [data-act="addr-open"]');
  await page.fill('#addr-in', 'a test lookup');
  await page.locator('form[data-form="addr"] button[type=submit]').tap();
  await page.waitForSelector('.front .addr-which', { timeout: 8000 }).catch(() => {});
  check('First page, several matches: Which one is yours?', (await page.$$('.front [data-act="addr-which"]')).length === 2);
  await tap(page, '.front [data-act="addr-which"][data-i="1"]');
  await page.waitForSelector('.door-found', { timeout: 15000 }).catch(() => {});
  check('First page, several matches: the one tapped opens its ballot and shows under the place line', /^Austin, Texas · 78745/.test(await text(page, '.door-place span')) && (await text(page, '.door-found')) === 'Found: Test Two, Austin, TX 78745 Not it? Try again', `${await text(page, '.door-place span')} | ${await text(page, '.door-found')}`);
  noErrors(page, 'First page, several matches');
  await ctx.close();
}

// Nav review, Oct 20: "Next" walks the page in its own order, from the first thing on it (LA's U.S.
// House question), one row open at a time. Since the flow (Oct 20) it is the menu's "Next up": the
// sheet's at 380px, the rail's at 1280px.
for (const width of [380, 1280]) {
  const { ctx, page } = await newPage({ viewport: { width, height: 900 } });
  await openBallot(page, '90004');
  const all = await page.evaluate(() => [...document.querySelectorAll('.ledger .row[data-item], .ledger .row[data-q]')].map((e) => e.id));
  await page.evaluate(() => window.scrollTo(0, 0));
  const opened = [];
  let oneAtATime = true;
  for (let i = 0; i < 8; i++) {
    await next(page);
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
    await next(page);
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
