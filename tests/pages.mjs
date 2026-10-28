#!/usr/bin/env node
/*
 * Page tests: the static pages for search engines and AI assistants (src/pages/site.ts, scripts/build-pages.mjs),
 * checked without a browser. Loads the real TypeScript through Vite's SSR loader, as tests/model.mjs does, and
 * renders every page from the built bundles in public/data/.
 *
 *   npm run data && node tests/pages.mjs            (and, after `npm run build`, it checks dist/ too)
 *
 * What it guards:
 *   - a page for every place and every state, each with its name, its races and measures, its dates, a canonical
 *     address and structured data that parses, and a button into the app set to that place
 *   - the walls: no pick, endorser name or lean on a page; no ZIP list or research note (zip_caveats); no em
 *     dashes or all caps in the page's own words
 *   - sitemap.xml, robots.txt and llms.txt: every page, nothing with a # or a ?, real lastmod dates
 *   - IndexNow sends only what changed (scripts/indexnow.mjs)
 *   - the built site: no noindex, the canonical on the home page, one file per page, the headers in vercel.json
 * Exit code 1 if anything fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { changedUrls } from '../scripts/indexnow.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'public', 'data');
if (!fs.existsSync(path.join(DATA, 'index.json'))) { console.error('No built data. Run `npm run data` first.'); process.exit(2); }
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const index = read('index.json');
const data = { index, states: {}, places: {} };
for (const st of Object.keys(index.states)) data.states[st] = read(`state-${st}.json`);
for (const id of Object.keys(index.places)) data.places[id] = read(`place-${id}.json`);

const vite = await createServer({ root: ROOT, configFile: false, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
const site = await vite.ssrLoadModule('/src/pages/site.ts');
const bl = await vite.ssrLoadModule('/src/ballot.ts');
const labels = await vite.ssrLoadModule('/src/model/labels.ts');
const st8 = await vite.ssrLoadModule('/src/state.ts');

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? `  (${extra})` : ''}`); };
const TODAY = '2026-10-28';
const norm0 = (x) => String(x || '').replace(/\s+/g, ' ').trim();
const A = site.PLACEHOLDER;
const unesc = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const textOf = (html) => unesc(html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
const bodyOf = (html) => html.split('<body')[1] || '';
const ldOf = (html) => { const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/); return m ? JSON.parse(m[1]) : null; };

const pages = site.allPages(data, A, TODAY);
const placeIds = Object.keys(index.places);
const stateCodes = Object.keys(index.states);

/* ---------- one page per place and per state ---------- */
check('a page for every place and every state', pages.filter((p) => p.kind === 'place').length === placeIds.length && pages.filter((p) => p.kind === 'state').length === stateCodes.length, `${pages.length} pages for ${placeIds.length} places and ${stateCodes.length} states`);
check('every page has its own address and file', new Set(pages.map((p) => p.path)).size === pages.length && new Set(pages.map((p) => p.file)).size === pages.length);
check('no address holds five digits in a row, an @, a # or a ?', pages.every((p) => !/\d{5}|@|#|\?/.test(p.path)), pages.map((p) => p.path).filter((x) => /\d{5}|@|#|\?/.test(x)).join(' '));

const bad = { title: [], canon: [], h1: [], button: [], items: [], dates: [], ld: [], walls: [], copy: [] };
const OUR_WORDS = /—|–|\b[A-Z]{4,}\b/;
for (const id of placeIds) {
  const p = pages.find((x) => x.path === `/${id}`);
  const pb = data.places[id];
  const short = site.shortLabel(pb.label);
  if (!p) { bad.title.push(`${id}: no page`); continue; }
  if (!p.title.includes(short) || p.title.length > 65 || !p.description.includes(short) || p.description.length > 160) bad.title.push(`${id}: "${p.title}" / ${p.description.length} chars`);
  if (!p.html.includes(`<link rel="canonical" href="${site.ORIGIN}/${id}">`)) bad.canon.push(id);
  if (!new RegExp(`<h1 class="place">${short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</h1>`).test(p.html.replace(/&#39;/g, "'"))) bad.h1.push(id);
  if (!p.html.includes(`href="/?place=${id}"`)) bad.button.push(id);
  // Every race and measure the app would show on this place's ballot, by its row title (district races once).
  const ballot = bl.buildBallot(data.states[pb.state], [pb]);
  st8.S.ballot = ballot;
  const text = textOf(bodyOf(p.html));
  const missing = ballot.items.filter((it) => !text.includes(labels.rowTitle(it).title.replace(/\s+/g, ' ')));
  if (missing.length) bad.items.push(`${id}: ${missing.slice(0, 3).map((it) => labels.rowTitle(it).title).join(' | ')}${missing.length > 3 ? ` +${missing.length - 3}` : ''}`);
  if (!text.includes('Election Day: Tue, Nov 3') || (ballot.howto.early_in_person.available && ballot.howto.early_in_person.start && !text.includes('voting: '))) bad.dates.push(id);
  // Structured data: it parses, and it says what the page is.
  const ld = ldOf(p.html);
  const wp = ld && ld['@graph'].find((g) => g['@type'] === 'WebPage');
  const bc = ld && ld['@graph'].find((g) => g['@type'] === 'BreadcrumbList');
  if (!wp || wp.url !== `${site.ORIGIN}/${id}` || wp.dateModified !== p.lastmod || !bc || bc.itemListElement.length !== 3) bad.ld.push(id);
  // The walls. No endorser's name (unless it's also a candidate's or an office's on this ballot), no lean, no picks,
  // no research notes, no ZIP list.
  const names = new Set(ballot.items.flatMap((it) => (it.kind === 'contest' ? [...it.candidates.map((c) => c.name), it.office] : [it.number])));
  const leaked = ballot.endorsers.filter((e) => e.name.length >= 8 && !names.has(e.name) && text.includes(e.name)).map((e) => e.name);
  const head = `${p.title} ${p.description} ${JSON.stringify(ld)}`;
  const zipsShown = pb.zips.filter((z) => text.includes(z));
  if (leaked.length || /\bendors/i.test(head) || /\b(lean left|lean right|we recommend|vote (yes|no) on)\b/i.test(text) || zipsShown.length > 1 || (pb.zip_caveats && text.includes(pb.zip_caveats.slice(0, 40)))) {
    bad.walls.push(`${id}: ${[leaked.slice(0, 2).join(', '), /\bendors/i.test(head) ? 'endorse in title/description' : '', zipsShown.length > 1 ? `ZIPs ${zipsShown.join(' ')}` : ''].filter(Boolean).join('; ')}`);
  }
  if (OUR_WORDS.test(`${p.title} ${p.description}`)) bad.copy.push(`${id}: ${p.title} / ${p.description}`);
}
check('every place page names its place in its title, description and heading (title under 65, description under 160)', !bad.title.length && !bad.h1.length, [...bad.title, ...bad.h1].join('; '));
check('every place page has its own canonical address', !bad.canon.length, bad.canon.join(' '));
check('every place page opens the app on that place (/?place=<id>)', !bad.button.length, bad.button.join(' '));
check('every place page lists every race and measure on its ballot', !bad.items.length, bad.items.join('; '));
check('every place page has Election Day and its early or in-person voting window', !bad.dates.length, bad.dates.join(' '));
check('every place page has structured data that parses and matches the page', !bad.ld.length, bad.ld.join(' '));
check('no place page carries an endorser, a pick, a lean, a ZIP list or a research note', !bad.walls.length, bad.walls.join('; '));
check('page titles and descriptions: no em dashes, no all caps', !bad.copy.length, bad.copy.join('; '));
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'site.ts'), 'utf8');
  const strings = [...src.matchAll(/`[^`]*`|'[^'\n]*'/g)].map((m) => m[0]).filter((s) => /[a-z] [a-z]/i.test(s));
  const dashes = strings.filter((s) => /—|–/.test(s));
  const caps = strings.filter((s) => /\b(?!HTML|JSON|ZIP|NYC|ISD|DPS|CSS)[A-Z]{4,}\b/.test(s.replace(/\$\{[^}]*\}/g, '')));
  check('the page copy in site.ts: no em or en dashes, no all caps, no uppercase transform', !dashes.length && !caps.length && !/text-transform:\s*uppercase/.test(src), [...dashes, ...caps].slice(0, 3).join(' | '));
}
// The walls, worded: a statement of fact on every page, never a recommendation.
{
  const p = pages.find((x) => x.path === '/austin-tx');
  check('Austin: the nonpartisan line, the privacy line and when Texas\'s dates and rules were last checked (its last_verified)', /never tells you how to vote/.test(p.html) && /We count visits without identifying you/.test(p.html) && unesc(p.html).includes(`Your state's voting dates and rules last checked: ${new Date(`${data.states.TX.howto.last_verified}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}.`));
  check('Austin: what to do without a photo ID is on the page, not only that one is required', textOf(bodyOf(p.html)).includes(norm0(data.states.TX.howto.id_rules.no_id_option).slice(0, 60)));
  check('Austin: Kevin\'s ZIP note (zip_caveats) is not on the page', !/Kevin’s|Kevin's|78702 is split/.test(textOf(bodyOf(p.html))));
  check('Austin: its election office and its early voting hours, from the data', p.html.includes('Travis County Clerk') && p.html.includes(data.places['austin-tx'].early_in_person?.hours_short || '(none)'));
  const lastmod = [data.states.TX.howto.last_verified, index.places['austin-tx'].checked, index.states.TX.checked].filter(Boolean).sort().pop();
  check('Austin: lastmod is the newest date its own facts carry, never after today', p.lastmod === (lastmod > TODAY ? TODAY : lastmod), `${p.lastmod} vs ${lastmod}`);
  check('a date in the data past today never becomes a lastmod in the future', site.allPages(data, A, '2026-10-01').every((x) => x.lastmod <= '2026-10-01'));
}
/* ---------- dates say what the data says, qualifications included (Codex, Oct 28) ---------- */
{
  const norm = (x) => unesc(String(x || '')).replace(/\s+/g, ' ').trim();
  const lost = [];
  for (const st of stateCodes) {
    const p = pages.find((x) => x.path === site.statePath(data, st));
    const h = data.states[st].howto;
    const text = textOf(bodyOf(p.html));
    const mail = h.voting_model === 'all_mail' || h.voting_model === 'mail_to_all_plus_in_person';
    const rules = [...h.registration.deadlines.filter((d) => d.date && d.rule).map((d) => d.rule), h.mail_ballot.request_deadline?.date ? h.mail_ballot.request_deadline.rule : null].filter(Boolean);
    const gone = rules.filter((r) => !text.includes(norm(r).slice(0, 60)));
    if (gone.length) lost.push(`${st}: ${gone.length} rule(s) missing, like "${norm(gone[0]).slice(0, 50)}"`);
    if (mail && /Last day to ask for a mail ballot/.test(text)) lost.push(`${st}: a mail-voting state headlines a request deadline`);
    if ((mail || !/^\s*\d{1,2}(:\d{2})?\s*[ap]\.?m\.?(\s+[A-Z]{2,3})?\s*$/i.test(h.election_day.polls_open)) && /You can vote from/.test(text)) lost.push(`${st}: "You can vote from" from a qualified or mail-state opening time`);
  }
  check('state pages: every deadline keeps its own rule, a mail-voting state never headlines a request date, and opening hours are said only when plain', !lost.length, lost.join('; '));
  const md = textOf(bodyOf(pages.find((x) => x.path === '/maryland').html));
  const wa = textOf(bodyOf(pages.find((x) => x.path === '/washington').html));
  // Every way to return a mail ballot, in the data's words, on every state and place page (Codex round 2: Texas's
  // postmark exception was missing under a heading that said "must arrive by").
  const ways = [];
  for (const p of pages) {
    const st = p.kind === 'state' ? stateCodes.find((x) => site.statePath(data, x) === p.path) : data.places[p.path.slice(1)].state;
    const text = textOf(bodyOf(p.html));
    // Case aside: the app's deshout writes the data's "NOT at your polling place" as "not".
    const gone = (data.states[st].howto.mail_ballot.return_options || []).filter((o) => !text.toLowerCase().includes(norm(o).slice(0, 60).toLowerCase()));
    const oneRule = /Your mail ballot must/.test(p.html) || !/Mail ballot deadline: <b>/.test(p.html);
    if (gone.length || oneRule) ways.push(`${p.path}: ${gone.length} way(s) missing${oneRule ? ', a one-rule heading' : ''}`);
  }
  check('every page lists each way to return a mail ballot, and its heading names no single rule', !ways.length, ways.slice(0, 4).join('; '));
  check('Texas: the USPS postmark exception is on the page', textOf(bodyOf(pages.find((x) => x.path === '/texas').html)).includes('postmarked by 7:00 PM Nov. 3 and arriving by 5:00 PM'));
  const early = stateCodes.filter((st) => { const n = data.states[st].howto.early_in_person.hours_note; const text = textOf(bodyOf(pages.find((x) => x.path === site.statePath(data, st)).html)).toLowerCase(); return n && !text.includes(norm(n).slice(0, 60).toLowerCase()); });
  check('state pages: the early voting note, in the data\'s words, even where there is no window (Alabama, Pennsylvania)', !early.length, early.join(' '));
  check('Maryland: the request deadline says how it depends on delivery (fax or email); Washington: no blanket opening time', /fax or email/.test(md) && !/You can vote from/.test(wa) && /Polls close at 8 PM/.test(wa));
}
/* ---------- state pages ---------- */
{
  const missing = stateCodes.filter((st) => {
    const p = pages.find((x) => x.path === site.statePath(data, st));
    return !p || !p.html.includes(`href="/?state=${st}"`) || !index.states[st].places.every((id) => p.html.includes(`href="/${id}"`)) || !p.html.includes(`<link rel="canonical" href="${site.ORIGIN}${site.statePath(data, st)}">`);
  });
  check('every state page links each of its places, opens the app on that state, and has its canonical', !missing.length, missing.join(' '));
  check('state addresses: /texas, /washington, /washington-dc, /new-york', ['TX', 'WA', 'DC', 'NY'].map((st) => site.statePath(data, st)).join(' ') === '/texas /washington /washington-dc /new-york');
}
/* ---------- the files for crawlers ---------- */
{
  const listed = [{ path: '/', lastmod: site.homeLastmod(pages, TODAY), fp: 'x' }, ...pages.map((p) => ({ path: p.path, lastmod: p.lastmod, fp: 'x' }))];
  const xml = site.sitemapXML(listed);
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const mods = [...xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]);
  check('sitemap: well formed, one entry per page plus the home page', xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>') && /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/.test(xml) && locs.length === pages.length + 1 && new Set(locs).size === locs.length && (xml.match(/<url>/g) || []).length === locs.length);
  check('sitemap: every address is on vote.kevinhg.com, none with a # or a ? (no save link, no ?on= or ?try=)', locs.every((l) => l.startsWith(`${site.ORIGIN}/`) && !/[#?]/.test(l)));
  check('sitemap: every lastmod is a real date, never after today', mods.length === locs.length && mods.every((m) => /^\d{4}-\d{2}-\d{2}$/.test(m) && m <= TODAY));
  const robots = site.robotsTXT();
  check('robots.txt: everyone allowed, the sitemap named, nothing blocked', /^User-agent: \*$/m.test(robots) && /^Allow: \/$/m.test(robots) && /^Sitemap: https:\/\/vote\.kevinhg\.com\/sitemap\.xml$/m.test(robots) && !/^Disallow:/m.test(robots));
  const llms = site.llmsTXT(data, pages);
  check('llms.txt: a title, a summary, and a link to every page', /^# /.test(llms) && /^> /m.test(llms) && pages.every((p) => llms.includes(`](${site.ORIGIN}${p.path})`)) && /^## Optional$/m.test(llms));
  check('llms.txt: says it never recommends, and no endorser by name', /never recommends/.test(llms) && !Object.values(data.places).some((pb) => pb.endorsers.some((e) => e.name.length >= 12 && llms.includes(e.name))));
  const home = site.homeExtras(data);
  check('home page: structured data parses; its noscript list links every page', !!JSON.parse(home.jsonLd)['@graph'][0].url && pages.every((p) => home.noscript.includes(`href="${p.path}"`)));
  const nf = site.notFoundPage(data, A, TODAY);
  check('404 page: noindex, no canonical, no visit count', /<meta name="robots" content="noindex">/.test(nf) && !/rel="canonical"/.test(nf) && !nf.includes(A.js));
}
/* ---------- IndexNow: only what changed ---------- */
{
  const after = { origin: site.ORIGIN, commit: 'b', pages: [{ path: '/', fp: '1' }, { path: '/texas', fp: '2' }, { path: '/austin-tx', fp: '3' }] };
  check('IndexNow: the first deploy with pages sends them all', changedUrls(null, after).length === 3);
  check('IndexNow: a deploy sends only the pages whose fingerprint changed', JSON.stringify(changedUrls({ commit: 'a', pages: [{ path: '/', fp: '1' }, { path: '/texas', fp: '9' }, { path: '/austin-tx', fp: '3' }] }, after)) === JSON.stringify([`${site.ORIGIN}/texas`]));
  check('IndexNow: nothing changed, nothing sent', changedUrls({ commit: 'a', pages: after.pages }, after).length === 0);
  // A page's fingerprint is its content: the same data gives the same page, whatever build made it.
  const again = site.allPages(data, A, TODAY);
  check('a page renders the same twice from the same data (fingerprints are stable)', again.every((p, i) => p.html === pages[i].html));
}
/* ---------- the built site ---------- */
const DIST = path.join(ROOT, 'dist');
if (fs.existsSync(path.join(DIST, 'sitemap.xml'))) {
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  check('built home page: no noindex, its canonical is the clean address', !/noindex/.test(html) && html.includes('<link rel="canonical" href="https://vote.kevinhg.com/">'));
  check('built home page: one structured-data block and the noscript list', (html.match(/application\/ld\+json/g) || []).length === 1 && (html.match(/<noscript>/g) || []).length === 1 && html.includes('href="/austin-tx"'));
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'discovery.json'), 'utf8'));
  const gv = conf.siteVerification.google, bv = conf.siteVerification.bing;
  check('built home page: a verification tag exactly when scripts/discovery.json has its token', (gv ? html.includes(`name="google-site-verification" content="${gv}"`) : !html.includes('google-site-verification')) && (bv ? html.includes(`name="msvalidate.01" content="${bv}"`) : !html.includes('msvalidate.01')));
  const pj = JSON.parse(fs.readFileSync(path.join(DIST, 'data', 'pages.json'), 'utf8'));
  check('built: every page rendered (none skipped), and a file for each', !pj.skipped.length && pj.pages.length === pages.length + 1 && pages.every((p) => fs.existsSync(path.join(DIST, p.file))), pj.skipped.map((s) => s.id).join(' '));
  check('built: sitemap.xml, robots.txt, llms.txt, 404.html and the IndexNow key file', ['sitemap.xml', 'robots.txt', 'llms.txt', '404.html', `${conf.indexNowKey}.txt`].every((f) => fs.existsSync(path.join(DIST, f))) && fs.readFileSync(path.join(DIST, `${conf.indexNowKey}.txt`), 'utf8') === conf.indexNowKey);
  const austin = fs.readFileSync(path.join(DIST, 'austin-tx.html'), 'utf8');
  const css = (html.match(/href="(\/assets\/[^"]+\.css)"/) || [])[1];
  const js = (austin.match(/<script type="module" src="(\/assets\/visit-[^"]+\.js)"/) || [])[1];
  check('built pages link the app\'s own stylesheet and the visit count, both in dist', !!css && austin.includes(`href="${css}"`) && !!js && fs.existsSync(path.join(DIST, js)));
  const visit = js ? fs.readFileSync(path.join(DIST, js), 'utf8') : '';
  check('the visit count is stats.ts: Vercel hosts only, the referrer cut to its origin', /vercel\.app/.test(visit) && /kevinhg\.com/.test(visit) && /referrer/.test(visit) && !/sentry/i.test(visit));
  check('no source map in dist', !(fs.readdirSync(DIST, { recursive: true })).some((f) => String(f).endsWith('.map')));
} else console.log('SKIP  the built site (run `npm run build` first to check dist/)');
{
  const vj = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const dataH = vj.headers.find((h) => h.source === '/data/(.*)');
  check('vercel.json: clean addresses, no trailing slash, and /data/ never a search result', vj.cleanUrls === true && vj.trailingSlash === false && !!dataH && dataH.headers.some((h) => h.key === 'X-Robots-Tag' && h.value === 'noindex'));
  check('index.html (source): no noindex, the canonical in place', (() => { const s = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'); return !/noindex/.test(s) && s.includes('<link rel="canonical" href="https://vote.kevinhg.com/">'); })());
}

await vite.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
