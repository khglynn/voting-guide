#!/usr/bin/env node
/*
 * build-pages: after `vite build`, the files that let search engines and AI assistants find the guide
 * (Oct 28, 2026). Everything comes from the bundles build-data wrote, through src/pages/site.ts. Into dist/:
 *
 *   {place id}.html, {state}.html   one page per place (/austin-tx) and per state (/texas); Vercel's
 *                                   cleanUrls serves them without the .html
 *   404.html                        Vercel serves it, with a 404, for any address that isn't a file
 *   sitemap.xml, robots.txt, llms.txt
 *   {indexNowKey}.txt               the IndexNow key file (scripts/discovery.json)
 *   data/pages.json                 each page's path, lastmod and fingerprint: scripts/indexnow.mjs pings only
 *                                   the pages whose fingerprint changed between two production deployments
 *   assets/visit-*.js               the pages' visit count (src/pages/visit.ts), built on its own so the app's
 *                                   bundle and load order stay exactly as they were
 * and into dist/index.html: the guide's structured data, the verification tags in scripts/discovery.json,
 * and a noscript list of every page for anything that reads the page without running it.
 *
 * Like build-data, a page that fails to render is left out and reported (tests/pages.mjs fails CI on it);
 * the build fails only when nothing renders, or when dist/index.html isn't the shape this expects.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build, createServer } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const DATA = path.join(DIST, 'data');
const CONF = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'discovery.json'), 'utf8'));
const die = (msg) => { console.error(`build-pages: ${msg}`); process.exit(1); };
if (!fs.existsSync(path.join(DIST, 'index.html')) || !fs.existsSync(path.join(DATA, 'index.json'))) die('run `vite build` first (no dist/index.html or dist/data/index.json).');

/* The day the build runs, in Central time: no page's lastmod is ever later than it. */
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/* ---------- the bundles ---------- */
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const index = read('index.json');
const data = { index, states: {}, places: {} };
for (const st of Object.keys(index.states)) data.states[st] = read(`state-${st}.json`);
for (const id of Object.keys(index.places)) data.places[id] = read(`place-${id}.json`);

/* ---------- the assets a page links ---------- */
let home = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
const css = (home.match(/<link rel="stylesheet"[^>]*href="(\/assets\/[^"]+\.css)"/) || [])[1];
if (!css) die('dist/index.html links no /assets/*.css stylesheet; the pages reuse the app\'s.');
const MANIFEST = '.visit-manifest.json';
await build({
  configFile: false, root: ROOT, logLevel: 'warn', publicDir: false,
  build: { outDir: DIST, emptyOutDir: false, copyPublicDir: false, target: 'es2020', sourcemap: false, manifest: MANIFEST, rollupOptions: { input: { visit: path.join(ROOT, 'src', 'pages', 'visit.ts') } } },
});
const manifest = JSON.parse(fs.readFileSync(path.join(DIST, MANIFEST), 'utf8'));
fs.rmSync(path.join(DIST, MANIFEST));
const visit = Object.values(manifest).find((m) => m.isEntry && /src\/pages\/visit\.ts$/.test(m.src || ''));
if (!visit) die('the visit-count build wrote no entry for src/pages/visit.ts.');
const assets = { css, js: `/${visit.file}` };

/* ---------- the pages ---------- */
const vite = await createServer({ root: ROOT, configFile: false, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
const site = await vite.ssrLoadModule('/src/pages/site.ts');
const fp = (html) => crypto.createHash('sha256').update(html).digest('hex').slice(0, 16);
/* Rendered with placeholder asset names, so the fingerprint says what the page says, not which build made it. */
const real = (html) => html.split(site.PLACEHOLDER.css).join(assets.css).split(site.PLACEHOLDER.js).join(assets.js);
const pages = [];
const skipped = [];
const order = Object.keys(index.states).sort((a, b) => index.states[a].name.localeCompare(index.states[b].name));
const jobs = [...order.map((st) => ['state', st]), ...order.flatMap((st) => index.states[st].places.map((id) => ['place', id]))];
for (const [kind, id] of jobs) {
  try {
    const p = kind === 'state' ? site.statePage(data, id, site.PLACEHOLDER, today) : site.placePage(data, id, site.PLACEHOLDER, today);
    pages.push({ ...p, fp: fp(p.html), html: real(p.html) });
  } catch (e) {
    skipped.push({ kind, id, why: String(e && e.stack || e).split('\n').slice(0, 3).join(' | ') });
    console.warn(`build-pages: SKIPPED the ${kind} page for ${id}: ${e && e.message}`);
  }
}
if (!pages.length) die('no page rendered.');
const taken = new Set();
for (const p of pages) {
  if (taken.has(p.file) || p.file === 'index.html' || p.file === '404.html') die(`two pages want ${p.file}.`);
  taken.add(p.file);
  fs.writeFileSync(path.join(DIST, p.file), p.html);
}
fs.writeFileSync(path.join(DIST, '404.html'), site.notFoundPage(data, assets, today));

/* ---------- the home page ---------- */
const extras = site.homeExtras(data);
const tags = [
  CONF.siteVerification?.google ? `<meta name="google-site-verification" content="${CONF.siteVerification.google.replace(/[^A-Za-z0-9_-]/g, '')}">` : '',
  CONF.siteVerification?.bing ? `<meta name="msvalidate.01" content="${CONF.siteVerification.bing.replace(/[^A-Za-z0-9_-]/g, '')}">` : '',
  `<script type="application/ld+json">${extras.jsonLd}</script>`,
].filter(Boolean).join('\n  ');
const noscripts = home.match(/<noscript>[\s\S]*?<\/noscript>/g) || [];
if (noscripts.length !== 1 || !home.includes('</head>')) die('dist/index.html should have one <noscript> and a </head>.');
if (/name="robots"[^>]*noindex/.test(home)) die('dist/index.html still says noindex.');
home = home.replace('</head>', `  ${tags}\n</head>`).replace(noscripts[0], extras.noscript);
fs.writeFileSync(path.join(DIST, 'index.html'), home);
const homeFp = fp(`${extras.noscript}${extras.jsonLd}${(home.match(/<title>[^<]*<\/title>/) || [''])[0]}${(home.match(/<meta name="description"[^>]*>/) || [''])[0]}`);

/* ---------- for crawlers ---------- */
const listed = [{ path: '/', lastmod: site.homeLastmod(pages, today), fp: homeFp }, ...pages.map((p) => ({ path: p.path, lastmod: p.lastmod, fp: p.fp }))];
fs.writeFileSync(path.join(DIST, 'sitemap.xml'), site.sitemapXML(listed));
fs.writeFileSync(path.join(DIST, 'robots.txt'), site.robotsTXT());
fs.writeFileSync(path.join(DIST, 'llms.txt'), site.llmsTXT(data, pages));
const key = String(CONF.indexNowKey || '');
if (!/^[A-Za-z0-9-]{8,128}$/.test(key)) die('scripts/discovery.json indexNowKey must be 8 to 128 letters, digits or dashes.');
fs.writeFileSync(path.join(DIST, `${key}.txt`), key);
fs.writeFileSync(path.join(DATA, 'pages.json'), JSON.stringify({ generated: new Date().toISOString(), commit: process.env.VERCEL_GIT_COMMIT_SHA || null, origin: site.ORIGIN, pages: listed, skipped }));

await vite.close();
console.log(`build-pages: ${pages.filter((p) => p.kind === 'state').length} state pages, ${pages.filter((p) => p.kind === 'place').length} place pages, sitemap of ${listed.length}, robots.txt, llms.txt, 404, visit count ${assets.js}${skipped.length ? `; SKIPPED ${skipped.length}: ${skipped.map((s) => s.id).join(', ')}` : ''}`);
