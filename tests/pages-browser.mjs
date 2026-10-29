/* The static pages in a real browser and as a crawler reads them (Oct 28, 2026; src/pages/site.ts).
   BASE=http://localhost:4173 node tests/pages-browser.mjs        (vite preview of a full `npm run build`)
   BASE=https://<deploy>.vercel.app node tests/pages-browser.mjs  (a preview or production: also checks Vercel's
                                                                  redirects, the 404 and the /data/ header)
   SHOTS_DIR=...  where screenshots go (default .tmp/pages-shots)
   VERCEL_AUTOMATION_BYPASS_SECRET=...  only if Deployment Protection is on
   Its own file, beside tests/e2e.mjs, so neither one's changes collide with the other's. Exits non-zero on any
   failed check or console error. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PW_PATH || 'playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.resolve(process.env.SHOTS_DIR || path.join(ROOT, '.tmp', 'pages-shots'));
fs.mkdirSync(SHOTS, { recursive: true });
const BASE = (process.env.BASE || 'http://localhost:4173').replace(/\/$/, '');
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE);
const BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '';
const ORIGIN = 'https://vote.kevinhg.com';
const TODAY = '2026-10-19';
const KEY = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'discovery.json'), 'utf8')).indexNowKey;

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? `  (${extra})` : ''}`); };
const headers = BYPASS ? { 'x-vercel-protection-bypass': BYPASS } : {};
const get = (p, opts = {}) => fetch(`${BASE}${p}`, { headers, redirect: 'manual', ...opts });

/* ---------- as a crawler reads it: one request, no JavaScript ---------- */
const place = await (await get('/data/place-austin-tx.json')).json();
const firstLocal = place.items.find((i) => i.kind === 'measure') || place.items[0];
{
  const r = await get('/austin-tx');
  const html = await r.text();
  check('crawler: /austin-tx is a 200 HTML page', r.status === 200 && /text\/html/.test(r.headers.get('content-type') || ''), `${r.status} ${r.headers.get('content-type')}`);
  check('crawler: it names Austin, has its dates and its canonical, with no JavaScript run', html.includes('<h1 class="place">Austin</h1>') && /Election Day: (<b>)?Tue, Nov 3/.test(html) && html.includes(`<link rel="canonical" href="${ORIGIN}/austin-tx">`));
  check('crawler: its ballot items are in the HTML (a local measure, a statewide race)', html.includes(firstLocal.kind === 'measure' ? firstLocal.number : firstLocal.office) && html.includes('U.S. Senator'), firstLocal.number || firstLocal.office);
  check('crawler: no noindex on a place page', !/noindex/i.test(html) && !/noindex/i.test(r.headers.get('x-robots-tag') || '') || !LOCAL && /vercel\.app$/.test(new URL(BASE).hostname));
}
{
  const r = await get('/texas');
  const html = await r.text();
  check('crawler: /texas lists its cities', r.status === 200 && html.includes('href="/austin-tx"') && html.includes('href="/houston-tx"'));
  const home = await (await get('/')).text();
  check('crawler: the home page has its canonical and no noindex', home.includes(`<link rel="canonical" href="${ORIGIN}/">`) && !/name="robots"[^>]*noindex/.test(home));
  check('crawler: the home page lists every place for anything that doesn\'t run JavaScript', /<noscript>[\s\S]*href="\/austin-tx"[\s\S]*<\/noscript>/.test(home));
  const sm = await get('/sitemap.xml');
  const xml = await sm.text();
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  check('sitemap.xml: served, lists Austin and Texas, no # or ? anywhere (no save link, no ?on= or ?try=)', sm.status === 200 && locs.includes(`${ORIGIN}/austin-tx`) && locs.includes(`${ORIGIN}/texas`) && locs.every((l) => !/[#?]/.test(l)), `${sm.status} ${locs.length}`);
  const rb = await (await get('/robots.txt')).text();
  check('robots.txt: allows everyone and names the sitemap', /User-agent: \*/.test(rb) && /Allow: \//.test(rb) && rb.includes(`Sitemap: ${ORIGIN}/sitemap.xml`));
  const ll = await get('/llms.txt');
  check('llms.txt: served, links Austin', ll.status === 200 && (await ll.text()).includes(`(${ORIGIN}/austin-tx)`));
  const k = await get(`/${KEY}.txt`);
  check('the IndexNow key file holds the key', k.status === 200 && (await k.text()).trim() === KEY);
}
if (!LOCAL) {
  // Vercel only: vite preview doesn't redirect, and answers every unknown address with the app.
  const a = await get('/austin-tx.html');
  const b = await get('/austin-tx/');
  check('Vercel: /austin-tx.html and /austin-tx/ redirect to /austin-tx', [a, b].every((r) => r.status >= 300 && r.status < 400 && new URL(r.headers.get('location'), BASE).pathname === '/austin-tx'), `${a.status} ${a.headers.get('location')} / ${b.status} ${b.headers.get('location')}`);
  const nf = await get('/no-such-page-here');
  check('Vercel: an unknown address is a 404 with the guide\'s own page', nf.status === 404 && (await nf.text()).includes('Page not found'), String(nf.status));
  const d = await get('/data/index.json');
  check('Vercel: /data/ answers with X-Robots-Tag: noindex', /noindex/.test(d.headers.get('x-robots-tag') || ''), d.headers.get('x-robots-tag'));
}

/* ---------- in a browser at 380px ---------- */
const browser = await chromium.launch();
async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 380, height: 820 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, ...opts });
  if (BYPASS) await ctx.route((u) => u.origin === new URL(BASE).origin, (route) => route.continue({ headers: { ...route.request().headers(), 'x-vercel-protection-bypass': BYPASS } }));
  // The same fences as tests/e2e.mjs: nothing reaches Kevin's form, Sentry or Vercel's real visit counts.
  await ctx.route('https://docs.google.com/forms/**', (route) => route.abort());
  await ctx.route((u) => /(^|\.)sentry\.io$/i.test(u.hostname), (route) => route.abort());
  const insights = [];
  await ctx.route((u) => u.pathname.startsWith('/_vercel/insights/'), (route) => { insights.push(route.request().url()); return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }); });
  await ctx.route('https://script.google.com/macros/**', (route) => route.abort());
  const page = await ctx.newPage();
  page.errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && (!m.location().url || m.location().url.startsWith(new URL(BASE).origin))) page.errors.push(m.text()); });
  page.on('pageerror', (e) => page.errors.push(e.message));
  return { ctx, page, insights };
}
const noErrors = (page, what) => check(`${what}: no console errors`, page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
const canonical = (page) => page.evaluate(() => document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '');

{
  const { ctx, page, insights } = await newPage();
  await page.goto(`${BASE}/austin-tx`);
  await page.waitForSelector('h1.place');
  check('Austin\'s page: its name is the heading', (await page.textContent('h1.place')).trim() === 'Austin');
  check('Austin\'s page: nothing wider than a 380px phone', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), String(await page.evaluate(() => document.documentElement.scrollWidth)));
  await page.screenshot({ path: path.join(SHOTS, 'austin-top.png') });
  await page.screenshot({ path: path.join(SHOTS, 'austin-full.png'), fullPage: true });
  if (LOCAL) check('Austin\'s page: no visit-count script off the guide\'s Vercel hosts', insights.length === 0, insights.join(' '));
  // The button: the first page, with Austin chosen, and ?place= gone from the address bar.
  await page.locator('a.bigbtn').first().tap();
  await page.waitForSelector('#zip', { timeout: 15000 });
  await page.waitForFunction(() => /Austin/.test(document.querySelector('.door-place')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  check('Austin\'s button opens the guide\'s first page with Austin chosen', /Austin/.test(await page.textContent('.door-place').catch(() => '') || ''), (await page.textContent('.door-place').catch(() => '(no .door-place)')) || '');
  check('…and ?place= is out of the address bar', !/place=/.test(page.url()), page.url());
  check('…and the app\'s canonical is the clean home address', (await canonical(page)) === `${ORIGIN}/`);
  noErrors(page, 'Austin\'s page and its button');
  await ctx.close();
}
{
  const { ctx, page } = await newPage({ colorScheme: 'dark' });
  await page.goto(`${BASE}/texas`);
  await page.waitForSelector('h1.place');
  await page.screenshot({ path: path.join(SHOTS, 'texas-dark.png'), fullPage: true });
  check('Texas\'s page: nothing wider than a 380px phone', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.locator('a.bigbtn').first().tap();
  await page.waitForSelector('#zip', { timeout: 15000 });
  await page.waitForFunction(() => /Texas/.test(document.querySelector('.door-place')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  check('Texas\'s button opens the first page with Texas chosen', /Texas/.test(await page.textContent('.door-place').catch(() => '') || ''), (await page.textContent('.door-place').catch(() => '(no .door-place)')) || '');
  noErrors(page, 'Texas\'s page and its button');
  await ctx.close();
}
{
  // A save link holds a person's picks after the #. The page it opens says its address is the clean one.
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/?today=${TODAY}#v1~TX~austin-tx~-~~~~`);
  await page.waitForSelector('#plan', { timeout: 15000 });
  check('a save link: the ballot opens, and its canonical is the clean home address', (await canonical(page)) === `${ORIGIN}/`);
  await page.goto(`${BASE}/?try=aunt&today=${TODAY}`);
  await page.waitForSelector('#zip, #plan', { timeout: 15000 });
  check('?try= and ?today=: the canonical is still the clean home address', (await canonical(page)) === `${ORIGIN}/`);
  noErrors(page, 'save link and demo');
  await ctx.close();
}
{
  // A place the guide doesn't have is ignored: a new visitor gets the first page, as without it.
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/?place=nowhere-xx&today=${TODAY}`);
  await page.waitForSelector('#zip', { timeout: 15000 });
  check('?place= for a place the guide doesn\'t have: the first page, as usual, and the query gone', !(await page.$('#plan')) && !/place=/.test(page.url()));
  noErrors(page, 'unknown place');
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
