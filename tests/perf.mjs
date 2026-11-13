#!/usr/bin/env node
/* Performance on the biggest ballots, at 4x CPU throttle (a mid phone): time from typing the ZIP to
   step 2's counts, and time for a tap (a step 2 chip or switch, open a row, make a pick, open and close a
   row in view, open the Edit sheet
   and tap a chip there, open the menu, and under "Hide races I've decided" a band's count and a pick) to paint; then a row and a pick at 1280px, with the rail;
   then a returning visitor's "Pick up where I left off".
   BASE=http://localhost:4173 node tests/perf.mjs     Targets (v2's): open about 1s, taps under 250ms. */
const { chromium } = await import(process.env.PW_PATH || 'playwright');
const BASE = (process.env.BASE || 'http://localhost:4173').replace(/\/$/, '');
const browser = await chromium.launch();
const out = [];
for (const [name, zip] of [['Chicago', '60614'], ['Houston', '77002'], ['Aurora or Denver', '80247']]) {
  const ctx = await browser.newContext({ viewport: { width: 380, height: 820 }, hasTouch: true, isMobile: true });
  await ctx.route((u) => u.pathname.startsWith('/_vercel/insights/'), (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' })); // Vercel's visit counts never load here (src/stats.ts)
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await page.goto(`${BASE}/?today=2026-10-19`);
  await page.waitForSelector('#zip');
  await page.evaluate(() => fetch('/data/index.json'));
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  // Steps 1 and 2 share the first page: "open" times the typed ZIP (and the place picked) to step 2's line.
  const t0 = Date.now();
  await page.fill('#zip', zip);
  if (zip === '80247') await page.locator('[data-act="choose-place"][data-ids="aurora-co+denver-co"]').click();
  await page.waitForSelector('.su-src');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))));
  const open = Date.now() - t0;
  // A tap: input to the next paint.
  const tapTime = (sel) => page.evaluate((s) => new Promise((resolve) => {
    const el = document.querySelector(s);
    const t = performance.now();
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    requestAnimationFrame(() => setTimeout(() => resolve(Math.round(performance.now() - t)), 0));
  }), sel);
  // Step 2's chips and switches repaint its counts (the fills and coverage) on every tap. A group chip
  // on and off again, so the newspapers stay on and the fill switch stays there.
  const setupChip = await tapTime('#setup [data-act="chip"][data-k="progressive"]');
  await tapTime('#setup [data-act="chip"][data-k="progressive"]');
  const setupFill = await tapTime('[data-act="setup-fill"]');
  await tapTime('[data-act="setup-fill"]');
  // "Show my ballot" paints the whole ballot (not a tap budget: it is the ballot opening).
  const show = await tapTime('[data-act="setup-done"]');
  await page.waitForSelector('#plan');
  // Open a row in the measures section, then pick.
  const id = await page.evaluate(() => document.querySelector('#sec-measures .row[data-item]').dataset.item);
  const openRow = await tapTime(`#i-${id} [data-act="row"]`);
  const pick = await tapTime(`#i-${id} [data-act="pick"]`);
  // A row in view, as a finger finds it (motion, Oct 20): its header stays put while the panel grows
  // open beneath it, then folds away. The first frame of each must paint under 250ms like any tap.
  const id2 = await page.evaluate(() => { const r = document.querySelector('#sec-measures .row[data-item][data-undecided]'); window.scrollBy(0, r.getBoundingClientRect().top - 300); return r.dataset.item; });
  await page.waitForTimeout(300);
  const openInView = await tapTime(`#i-${id2} [data-act="row"]`);
  await page.waitForTimeout(300);
  const closeInView = await tapTime(`#i-${id2} [data-act="row"]`);
  await page.waitForTimeout(300);
  // The lens lives in the Edit sheet: open it, tap a chip (only the sheet repaints), then Done
  // (the ballot behind repaints once; not a tap budget, like "Show my ballot").
  const edit = await tapTime('[data-act="picks"]');
  const chip = await tapTime('.sheet-panel [data-act="chip"][data-k="progressive"]');
  const done = await tapTime('.sheet-panel [data-fk="sheet-x"]');
  // The menu: "☰ N of M" opens it (gated); its switch repaints the ballot behind (not gated, like
  // the old "Only undecided").
  const menu = await tapTime('.foot [data-act="toc"]');
  const only = await tapTime('.sheet-panel [data-act="only"]');
  // With "Hide races I've decided" on: a band's count shows the section's decided rows, and a pick
  // starts its beat (the fold that follows is not a tap).
  await tapTime('.sheet-panel [data-fk="sheet-x"]');
  await page.waitForTimeout(400);
  const count = await tapTime('#sec-measures [data-act="sec-count"]');
  await page.waitForTimeout(300);
  await tapTime('#sec-measures [data-act="sec-count"]');
  await page.waitForTimeout(300);
  const id3 = await page.evaluate(() => { const r = document.querySelector('#sec-measures .row[data-item][data-undecided]'); window.scrollBy(0, r.getBoundingClientRect().top - 300); return r.dataset.item; });
  await page.waitForTimeout(300);
  await tapTime(`#i-${id3} [data-act="row"]`);
  await page.waitForTimeout(300);
  const pickHidden = await tapTime(`#i-${id3} [data-act="pick"]`);
  await page.waitForTimeout(1500);
  out.push({ name, open, setupChip, setupFill, show, openRow, pick, openInView, closeInView, edit, chip, done, menu, only, count, pickHidden });
  await ctx.close();
}
/* From 1180px the menu stands as a rail drawn with the bar, so it repaints after every pick: a pick
   on the biggest ballot at 1280px must still paint under 250ms. */
const wide = [];
for (const [name, zip] of [['Chicago', '60614'], ['Houston', '77002']]) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route((u) => u.pathname.startsWith('/_vercel/insights/'), (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' })); // Vercel's visit counts never load here (src/stats.ts)
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await page.goto(`${BASE}/?today=2026-10-19`);
  await page.fill('#zip', zip);
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
  await ctx.route((u) => u.pathname.startsWith('/_vercel/insights/'), (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' })); // Vercel's visit counts never load here (src/stats.ts)
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await page.goto(`${BASE}/?today=2026-10-19`);
  await page.fill('#zip', zip);
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
/* Results (Nov 3, results Phase 1): after the close, every row on the biggest Texas ballot carries a count and the ballot
   head the figure, so a tap repaints more. A made-up results file with numbers for every race on Houston's ballot. */
const res = [];
{
  const ctx = await browser.newContext({ viewport: { width: 380, height: 820 }, hasTouch: true, isMobile: true, timezoneId: 'America/Chicago' });
  await ctx.route((u) => u.pathname.startsWith('/_vercel/insights/'), (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  const items = {};
  for (const f of ['state-TX.json', 'place-houston-tx.json']) {
    const b = await (await fetch(`${BASE}/data/${f}`)).json();
    for (const it of b.items) {
      const base = { source: 'harris-county-tx', status: 'counting', reporting: '300 of 623 vote centers reporting', updated: '2026-11-04T03:12:00Z', url: 'https://www.harrisvotes.com/', final: null };
      if (it.kind === 'measure') items[it.id] = { ...base, measure: { yes: 5200, no: 4800, yes_pct: 52, threshold: null }, total_votes: 10000 };
      else if (it.candidates.length > 1) { const n = it.candidates.length; const c = it.candidates.map((k, i) => ({ name: k.name, votes: 1000 * (n - i), pct: 0 })); const t = c.reduce((a, k) => a + k.votes, 0); c.forEach((k) => { k.pct = (k.votes / t) * 100; }); items[it.id] = { ...base, candidates: c, total_votes: t }; }
    }
  }
  const file = JSON.stringify({ election: '2026-11-03', state: 'TX', generated: '2026-11-04T03:42:30Z', sources: [{ id: 'harris-county-tx', name: 'Harris County', url: 'https://www.harrisvotes.com/', updated: '2026-11-04T03:12:00Z', status: 'counting', reporting: '300 of 623 vote centers reporting', fetched: '2026-11-04T03:42:00Z' }], items });
  await ctx.route((u) => u.pathname === '/results/2026-11-03/TX.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: file }));
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await page.goto(`${BASE}/?today=2026-11-03&now=21:42`);
  await page.fill('#zip', '77002');
  await page.locator('[data-act="setup-done"]').click();
  // No picks yet: the summary is the where-races-stand list; after the pick below it is the dots again.
  await page.waitForSelector('#vz .st, #vz .vz-fig');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const t = (sel) => page.evaluate((s) => new Promise((resolve) => {
    const el = document.querySelector(s);
    const t0 = performance.now();
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    requestAnimationFrame(() => setTimeout(() => resolve(Math.round(performance.now() - t0)), 0));
  }), sel);
  const id = await page.evaluate(() => document.querySelector('#sec-measures .row[data-item]').dataset.item);
  const openRow = await t(`#i-${id} [data-act="row"]`);
  await t(`#i-${id} [data-act="open"].rs-fold`);
  await page.waitForTimeout(300);
  const pick = await t(`#i-${id} [data-act="pick"]`);
  await page.waitForTimeout(300);
  const figRow = await t('#vz [data-act="fig-row"]');
  res.push({ name: 'Houston, results', openRow, pick, figRow });
  await ctx.close();
}
await browser.close();
for (const r of out) console.log(`${r.name}: open to step 2 ${r.open}ms, step 2 chip ${r.setupChip}ms, step 2 switch ${r.setupFill}ms, show my ballot ${r.show}ms, open a row ${r.openRow}ms, pick ${r.pick}ms, open a row in view ${r.openInView}ms, close it ${r.closeInView}ms, open Edit ${r.edit}ms, Edit chip ${r.chip}ms, Edit done ${r.done}ms, open the menu ${r.menu}ms, its switch ${r.only}ms, a band's count ${r.count}ms, a pick under the filter ${r.pickHidden}ms (4x CPU throttle)`);
for (const r of wide) console.log(`${r.name} at 1280px, with the rail: open a row ${r.openRow}ms, pick ${r.pick}ms, Next up ${r.next}ms (4x CPU throttle)`);
for (const r of res) console.log(`${r.name}: open a row ${r.openRow}ms, pick ${r.pick}ms, a figure row ${r.figRow}ms (4x CPU throttle)`);
for (const r of resume) console.log(`${r.name}, back again: "Pick up where I left off" ${r.go}ms${r.gone ? '' : ' (the line stayed!)'} (4x CPU throttle)`);
const slow = [...out.filter((r) => [r.openRow, r.pick, r.openInView, r.closeInView, r.setupChip, r.setupFill, r.edit, r.chip, r.menu, r.count, r.pickHidden].some((t) => t > 250)), ...wide.filter((r) => r.openRow > 250 || r.pick > 250), ...resume.filter((r) => r.go > 250 || !r.gone), ...res.filter((r) => r.openRow > 250 || r.pick > 250 || r.figRow > 250)];
process.exit(slow.length ? 1 : 0);
