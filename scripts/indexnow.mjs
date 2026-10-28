#!/usr/bin/env node
/*
 * indexnow: after a production deploy, tell Bing, Yandex and the other IndexNow engines which of the guide's
 * pages changed (Oct 28, 2026; https://www.indexnow.org/documentation). No account: the key in
 * scripts/discovery.json is served at /<key>.txt, which is how an engine knows the ping is the site's own.
 * Google doesn't take IndexNow; it reads the sitemap (robots.txt names it, and Search Console once Kevin adds it).
 *
 *   node scripts/indexnow.mjs --before <file> [--base https://vote.kevinhg.com] [--dry-run]
 *   node scripts/indexnow.mjs --self-test
 *
 * <file> is /data/pages.json as production served it before the deploy (scripts/ship.sh --after-merge saves it
 * first). Only pages whose fingerprint changed, or that are new, are sent. With no usable "before" (the first
 * deploy that has pages, or one saved after production already served the new build), every page is sent.
 * Production only: the engines refuse a URL on any other host. A failed ping is reported, never retried in a loop.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PRODUCTION = 'https://vote.kevinhg.com';
const ENDPOINT = 'https://api.indexnow.org/indexnow';

/* The pages to send: every path in `after` whose fingerprint isn't the same in `before`. `before` may be null
   or not a pages.json at all; then it's everything. Absolute URLs, the sitemap's order. */
export function changedUrls(before, after) {
  if (!after || !Array.isArray(after.pages)) throw new Error('the new pages.json has no pages');
  const origin = after.origin || PRODUCTION;
  const usable = before && Array.isArray(before.pages) && before.pages.length && !(before.commit && before.commit === after.commit);
  const was = new Map(usable ? before.pages.map((p) => [p.path, p.fp]) : []);
  return after.pages.filter((p) => !usable || was.get(p.path) !== p.fp).map((p) => `${origin}${p.path}`);
}

async function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const base = (arg('--base') || PRODUCTION).replace(/\/$/, '');
  const dry = argv.includes('--dry-run');
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'discovery.json'), 'utf8'));
  const key = conf.indexNowKey;
  let before = null;
  const bf = arg('--before');
  if (bf) { try { before = JSON.parse(fs.readFileSync(bf, 'utf8') || 'null'); } catch { before = null; } }
  const get = async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(`${u} answered ${r.status}`); return r; };
  const after = await (await get(`${base}/data/pages.json`)).json();
  const urls = changedUrls(before, after);
  if (!urls.length) { console.log('IndexNow: no page changed in this deploy; nothing to send.'); return 0; }
  if (new URL(base).origin !== new URL(after.origin || PRODUCTION).origin) {
    console.log(`IndexNow: ${base} isn't production (${after.origin}); the engines would refuse it. ${urls.length} page(s) would go: ${urls.slice(0, 5).join(' ')}${urls.length > 5 ? ' ...' : ''}`);
    return 0;
  }
  const live = (await (await get(`${base}/${key}.txt`)).text()).trim();
  if (live !== key) { console.error(`IndexNow: ${base}/${key}.txt doesn't hold the key from scripts/discovery.json; not sending.`); return 1; }
  const body = { host: new URL(base).host, key, keyLocation: `${base}/${key}.txt`, urlList: urls };
  if (dry) { console.log(`IndexNow (dry run): would send ${urls.length} page(s): ${urls.join(' ')}`); return 0; }
  const r = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  // 200: taken. 202: taken, the key is still being checked (normal the first time).
  if (r.status === 200 || r.status === 202) { console.log(`IndexNow: sent ${urls.length} page(s) (${r.status}).`); return 0; }
  console.error(`IndexNow: the engine answered ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
  return 1;
}

function selfTest() {
  const after = { origin: PRODUCTION, commit: 'b', pages: [{ path: '/', fp: '1' }, { path: '/texas', fp: '2' }, { path: '/austin-tx', fp: '3' }] };
  const cases = [
    ['nothing before: every page', changedUrls(null, after).length === 3],
    ['an empty file before: every page', changedUrls({}, after).length === 3],
    ['the same commit before (saved too late): every page', changedUrls({ ...after }, after).length === 3],
    ['one fingerprint changed: just that page', JSON.stringify(changedUrls({ commit: 'a', pages: [{ path: '/', fp: '1' }, { path: '/texas', fp: '2' }, { path: '/austin-tx', fp: 'x' }] }, after)) === JSON.stringify([`${PRODUCTION}/austin-tx`])],
    ['a new page: just that page', JSON.stringify(changedUrls({ commit: 'a', pages: [{ path: '/', fp: '1' }, { path: '/texas', fp: '2' }] }, after)) === JSON.stringify([`${PRODUCTION}/austin-tx`])],
    ['nothing changed: nothing', changedUrls({ commit: 'a', pages: after.pages }, after).length === 0],
  ];
  for (const [name, ok] of cases) console.log(`${ok ? 'ok   ' : 'FAIL '} ${name}`);
  return cases.every(([, ok]) => ok) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) process.exit(selfTest());
  main(argv).then((rc) => process.exit(rc), (e) => { console.error(`IndexNow: ${e.message}`); process.exit(1); });
}
