#!/usr/bin/env node
/* Performance on the biggest ballots, at 4x CPU throttle (a mid phone): time from the ZIP box to
   step 2, and time for a tap (a step 2 chip or switch, open a row, make a pick, open the Edit sheet
   and tap a chip there, open the menu) to paint; then a row and a pick at 1280px, with the rail;
   then a returning visitor's "Pick up where I left off".
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
  // A fresh device opens on step 2 ("Pick by endorsements or party"): "open" times the ZIP to step 2.
  await page.waitForSelector('[data-act="setup-done"]');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))));
  const open = Date.now() - t0;
  // A tap: input to the next paint.
  const tapTime = (sel) => page.evaluate((s) => new Promise((resolve) => {
    const el = document.querySelector(s);
    const t = performance.now();
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    requestAnimationFrame(() => setTimeout(() => resolve(Math.round(performance.now() - t)), 0));
  }), sel);
  // Step 2's chips and switches repaint its counts (the fills and coverage) on every tap.
  const setupChip = await tapTime('#setup [data-act="chip"][data-k="papers"]');
  await tapTime('#setup [data-act="chip"][data-k="papers"]');
  const setupFill = await tapTime('[data-act="setup-fill"]');
  await tapTime('[data-act="setup-fill"]');
  // "Show my ballot" paints the whole ballot (not a tap budget: it is the ballot opening).
  const show = await tapTime('[data-act="setup-done"]');
  await page.waitForSelector('#plan');
  // Open a row in the measures section, then pick.
  const id = await page.evaluate(() => document.querySelector('#sec-measures .row[data-item]').dataset.item);
  const openRow = await tapTime(`#i-${id} [data-act="row"]`);
  const pick = await tapTime(`#i-${id} [data-act="pick"]`);
  // The lens lives in the Edit sheet: open it, tap a chip (only the sheet repaints), then Done
  // (the ballot behind repaints once; not a tap budget, like "Show my ballot").
  const edit = await tapTime('[data-act="picks"]');
  const chip = await tapTime('.sheet-panel [data-act="chip"][data-k="progressive"]');
  const done = await tapTime('.sheet-panel [data-fk="sheet-x"]');
  // The menu: "☰ N of M" opens it (gated); its switch repaints the ballot behind (not gated, like
  // the old "Only undecided").
  const menu = await tapTime('.foot [data-act="toc"]');
  const only = await tapTime('.sheet-panel [data-act="only"]');
  out.push({ name, open, setupChip, setupFill, show, openRow, pick, edit, chip, done, menu, only });
  await ctx.close();
}
/* From 1000px the menu stands as a rail drawn with the bar, so it repaints after every pick: a pick
   on the biggest ballot at 1280px must still paint under 250ms. */
const wide = [];
for (const [name, zip] of [['Chicago', '60614'], ['Houston', '77002']]) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await page.goto(`${BASE}/?today=2026-10-19`);
  await page.fill('#zip', zip);
  await page.locator('button[type=submit]').click();
  await page.locator('[data-act="setup-done"]').click();
  await page.waitForSelector('.rail');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const t = (sel) => page.evaluate((s) => new Promise((resolve) => {
    const el = document.querySelector(s);
    const t0 = performance.now();
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    requestAnimationFrame(() => setTimeout(() => resolve(Math.round(performance.now() - t0)), 0));
  }), sel);
  const id = await page.evaluate(() => document.querySelector('#sec-measures .row[data-item]').dataset.item);
  const openRow = await t(`#i-${id} [data-act="row"]`);
  const pick = await t(`#i-${id} [data-act="pick"]`);
  const next = await t('.rail [data-act="next"]');
  wide.push({ name, openRow, pick, next });
  await ctx.close();
}
/* A returning visitor's first tap also takes "Welcome back" away (main.ts), on the biggest ballot:
   "Pick up where I left off" must paint under 250ms too. */
const resume = [];
for (const [name, zip] of [['Chicago', '60614']]) {
  const ctx = await browser.newContext({ viewport: { width: 380, height: 820 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await page.goto(`${BASE}/?today=2026-10-19`);
  await page.fill('#zip', zip);
  await page.locator('button[type=submit]').click();
  await page.locator('[data-act="setup-done"]').click();
  await page.waitForSelector('#plan');
  const id = await page.evaluate(() => document.querySelector('#sec-measures .row[data-item]').dataset.item);
  await page.locator(`#i-${id} [data-act="row"]`).click();
  await page.locator(`#i-${id} [data-act="pick"]`).first().click();
  await page.waitForTimeout(400);
  await page.reload();
  await page.waitForSelector('.resume');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const go = await page.evaluate(() => new Promise((resolve) => {
    const el = document.querySelector('.resume [data-act="next"]');
    const t0 = performance.now();
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    requestAnimationFrame(() => setTimeout(() => resolve(Math.round(performance.now() - t0)), 0));
  }));
  resume.push({ name, go, gone: !(await page.$('.resume')) });
  await ctx.close();
}
await browser.close();
for (const r of out) console.log(`${r.name}: open to step 2 ${r.open}ms, step 2 chip ${r.setupChip}ms, step 2 switch ${r.setupFill}ms, show my ballot ${r.show}ms, open a row ${r.openRow}ms, pick ${r.pick}ms, open Edit ${r.edit}ms, Edit chip ${r.chip}ms, Edit done ${r.done}ms, open the menu ${r.menu}ms, its switch ${r.only}ms (4x CPU throttle)`);
for (const r of wide) console.log(`${r.name} at 1280px, with the rail: open a row ${r.openRow}ms, pick ${r.pick}ms, Next up ${r.next}ms (4x CPU throttle)`);
for (const r of resume) console.log(`${r.name}, back again: "Pick up where I left off" ${r.go}ms${r.gone ? '' : ' (the line stayed!)'} (4x CPU throttle)`);
const slow = [...out.filter((r) => [r.openRow, r.pick, r.setupChip, r.setupFill, r.edit, r.chip, r.menu].some((t) => t > 250)), ...wide.filter((r) => r.openRow > 250 || r.pick > 250), ...resume.filter((r) => r.go > 250 || !r.gone)];
process.exit(slow.length ? 1 : 0);
