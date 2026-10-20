#!/usr/bin/env node
/* Morning-review screenshots of the test ballots at 380x820 (not a test; it never fails).
   BASE=http://localhost:4173 node tests/shots.mjs            -> .tmp/shots/ledger/
   ONLY=lakewood,chicago node tests/shots.mjs                 -> just those
   Each ballot: fresh first screen, an open race, an open measure, the judges section, the
   "aunt" scenario (mostly decided), the cheat sheet and Pass it on. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PW_PATH || 'playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.BASE || 'http://localhost:4173').replace(/\/$/, '');
const TODAY = process.env.TODAY || '2026-10-19';
const OUT = path.resolve(process.env.SHOTS_DIR || path.join(ROOT, '.tmp', 'shots', 'ledger'));
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
fs.mkdirSync(OUT, { recursive: true });
const BALLOTS = [
  { name: 'lakewood', zip: '80226' }, { name: 'chicago', zip: '60614' }, { name: 'houston', zip: '77002' },
  { name: 'aurora', zip: '80247', choose: 'aurora-co' }, { name: 'aurora-notsure', zip: '80247', choose: 'aurora-co+denver-co' },
  { name: 'portland', zip: '97202' }, { name: 'dc-ward1', zip: '20001', choose: 'dc-ward-1' }, { name: 'la', zip: '90004' },
  { name: 'brooklyn', zip: '11201' }, { name: 'baltimore', zip: '21201' },
].filter((b) => !ONLY.length || ONLY.includes(b.name));

const PRESS = `window.__press = (el) => el && el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));`;
const browser = await chromium.launch();
async function open(b, query = '') {
  const ctx = await browser.newContext({ viewport: { width: 380, height: 820 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.addInitScript(PRESS);
  await page.goto(`${BASE}/?today=${TODAY}${query}`);
  await page.fill('#zip', b.zip);
  await page.locator('button[type=submit]').click();
  if (b.choose) await page.locator(`[data-act="choose-place"][data-ids="${b.choose}"]`).click();
  // A fresh device opens on step 2 first: shoot it once per ballot, then "Show my ballot".
  await page.waitForSelector('#plan, [data-act="setup-done"]', { timeout: 15000 });
  if (await page.$('[data-act="setup-done"]')) {
    if (!query) {
      await page.evaluate(() => Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3000))]));
      await shot(page, `${b.name}-0-step-2`);
    }
    await page.locator('[data-act="setup-done"]').click();
  }
  await page.waitForSelector('#plan', { timeout: 15000 });
  await page.evaluate(() => Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3000))]));
  await page.waitForTimeout(200);
  return { ctx, page };
}
const shot = (page, n) => page.screenshot({ path: path.join(OUT, `${n}.png`) });
async function openRow(page, sel) {
  const id = await page.evaluate((s) => { const r = document.querySelector(s); if (!r) return null; window.__press(r.querySelector('[data-act="row"]')); return r.id; }, sel);
  await page.waitForTimeout(250);
  return id;
}
for (const b of BALLOTS) {
  let { ctx, page } = await open(b);
  await shot(page, `${b.name}-1-fresh`);
  if (await openRow(page, '.row[data-item]:has(.vd.agree), .row[data-item]:has(.vd.split)')) await shot(page, `${b.name}-2-race-open`);
  if (await openRow(page, '#sec-measures .row[data-item]')) await shot(page, `${b.name}-3-measure-open`);
  if (await page.$('#sec-judicial')) {
    await page.evaluate(() => { const s = document.querySelector('#sec-judicial'); if (s) window.scrollTo(0, s.getBoundingClientRect().top + scrollY - 70); });
    await page.waitForTimeout(150);
    await shot(page, `${b.name}-4-judges`);
  }
  await ctx.close();
  ({ ctx, page } = await open(b, '&try=aunt'));
  await shot(page, `${b.name}-5-aunt`);
  await page.evaluate(() => { const s = document.querySelector('.sec:not(.folded)'); if (s) window.scrollTo(0, s.getBoundingClientRect().top + scrollY - 70); });
  await page.waitForTimeout(150);
  await shot(page, `${b.name}-5b-aunt-left`);
  await page.evaluate(() => window.__press(document.querySelector('[data-act="cheat"]')));
  await page.waitForTimeout(300);
  await shot(page, `${b.name}-6-cheat`);
  await page.evaluate(() => window.__press(document.querySelector('[data-act="view"][data-v="pass"]')));
  await page.waitForTimeout(300);
  await shot(page, `${b.name}-7-pass`);
  await ctx.close();
  console.log(`shots: ${b.name}`);
}
await browser.close();
console.log(`Screenshots in ${path.relative(ROOT, OUT)}/`);
