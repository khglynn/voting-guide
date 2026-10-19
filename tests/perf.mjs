#!/usr/bin/env node
/* Performance on the biggest ballots, at 4x CPU throttle (a mid phone): time to open a ballot
   from the ZIP box, and time for a tap (open a row, make a pick) to paint.
   BASE=http://localhost:4173 node tests/perf.mjs     Targets (v2's): open about 1s, taps under 250ms. */
const { chromium } = await import(process.env.PW_PATH || 'playwright');
const BASE = (process.env.BASE || 'http://localhost:4173').replace(/\/$/, '');
const browser = await chromium.launch();
const out = [];
for (const [name, zip] of [['Chicago', '60614'], ['Houston', '77002'], ['Aurora or Denver', '80247']]) {
  const ctx = await browser.newContext({ viewport: { width: 380, height: 820 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await page.goto(`${BASE}/?today=2026-10-19`);
  await page.waitForSelector('#zip');
  await page.evaluate(() => fetch('/data/index.json'));
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.fill('#zip', zip);
  const t0 = Date.now();
  await page.locator('button[type=submit]').click();
  if (zip === '80247') await page.locator('[data-act="choose-place"][data-ids="aurora-co+denver-co"]').click();
  await page.waitForSelector('#plan');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))));
  const open = Date.now() - t0;
  // A tap: open a row in the measures section, then pick, timing input to the next paint.
  const tapTime = (sel) => page.evaluate((s) => new Promise((resolve) => {
    const el = document.querySelector(s);
    const t = performance.now();
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    requestAnimationFrame(() => setTimeout(() => resolve(Math.round(performance.now() - t)), 0));
  }), sel);
  const id = await page.evaluate(() => document.querySelector('#sec-measures .row[data-item]').dataset.item);
  const openRow = await tapTime(`#i-${id} [data-act="row"]`);
  const pick = await tapTime(`#i-${id} [data-act="pick"]`);
  const chip = await tapTime('[data-act="chip"][data-k="progressive"]');
  out.push({ name, open, openRow, pick, chip });
  await ctx.close();
}
await browser.close();
for (const r of out) console.log(`${r.name}: open ${r.open}ms, open a row ${r.openRow}ms, pick ${r.pick}ms, change the lens ${r.chip}ms (4x CPU throttle)`);
const slow = out.filter((r) => r.openRow > 250 || r.pick > 250);
process.exit(slow.length ? 1 : 0);
