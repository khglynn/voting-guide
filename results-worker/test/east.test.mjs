/* The east family (Nov 3, 2026): New York City's election night site and Maryland's SBE pages. Fixtures are the
   live pages read at 10:19 to 10:25 PM CT, trimmed (NYC's bar graphs and styles, Maryland's site menus removed). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, fixture, mapFor } from './helpers.mjs';
import * as nyc from '../src/adapters/nyc_enr.js';
import * as md from '../src/adapters/md_sbe.js';
import { NAMED_UA } from '../src/fetch.js';

const nycRoutes = () => {
  const r = { '/index.html': 'nyc.index.html' };
  for (const p of mapFor('results-NY-nyc').feed.pages) r[`/${p}`] = `nyc.${p}`;
  return r;
};
const mdRoutes = (id) => Object.fromEntries(mapFor(id).feed.pages.map((p) => [`/${p}`, `md.${p}`]));

test('nyc_enr: the board site reads as the Nov 3 election, 140 contests, its own words and times', async () => {
  const f = fakeFetch(nycRoutes());
  const r = await nyc.read({ fetch: f, map: mapFor('results-NY-nyc') });
  assert.equal(r.verdict, 'ok');
  assert.deepEqual(r.election, { id: 'SPECIAL NOVEMBER 3, 2026', name: 'SPECIAL NOVEMBER 3, 2026', date: '2026-11-03' });
  assert.equal(r.official, false);
  assert.deepEqual(r.labels, ['Unofficial election night results']);
  assert.equal(r.contests.length, 140);
  assert.equal(r.dropped, 0);
  assert.equal(r.reporting, 'Percentage of Scanners Reported: 96.10 %'); // Proposal 1, citywide
  assert.equal(r.source_updated, '2026-11-04T04:15:04.000Z'); // "Information As Of: 2026-11-03 23:15:04 EST"
  assert.ok(!r.contests.some((c) => /Governor|Comptroller|Attorney General/.test(c.feed_id)), 'statewide offices are not read');
  assert.ok(f.calls.every((c) => c.headers['User-Agent'] === NAMED_UA), 'every request names us');
  assert.equal(f.calls.length, 14);

  const ny3 = r.contests.find((c) => c.feed_id === 'Representative in Congress 3rd Congressional District');
  assert.equal(ny3.category, nyc.PORTION, "the board's asterisk: the City of New York portion only");
  assert.deepEqual(ny3.choices, [{ name: 'Thomas R. Suozzi', votes: 30732 }, { name: 'Michael J. LiPetri Jr.', votes: 20267 }, { name: 'WRITE-IN', votes: 200 }]);
  assert.equal(ny3.reporting, 'Percentage of Scanners Reported: 96.38 %');
  assert.equal(ny3.updated, '2026-11-04T04:15:02.000Z');
  assert.equal(r.contests.find((c) => c.feed_id === 'Representative in Congress 5th Congressional District').category, null);

  // A person on several party lines: the board's own "Totals by Candidate" rows, one per person.
  const jd2 = r.contests.find((c) => c.feed_id === 'Justice of the Supreme Court 2nd Judicial District');
  assert.equal(jd2.vote_for, 4);
  assert.deepEqual(jd2.choices.map((c) => c.name), ['Betsey Jean-Jacques', 'Hemalee J. Patel', 'Sherveal Mimes', 'Lola Waterman', 'William D. Spain Jr.', 'WRITE-IN']);
  assert.equal(jd2.choices[0].votes, 539937);
  assert.equal(jd2.total, 2060945);
  // No board total (one line each): the rows themselves.
  const jd1 = r.contests.find((c) => c.feed_id === 'Justice of the Supreme Court 1st Judicial District');
  assert.equal(jd1.vote_for, 6);
  assert.equal(jd1.choices.length, 12);

  const prop1 = r.contests.find((c) => c.feed_id === 'Proposal Number 1');
  assert.match(prop1.feed_name, /Revocable Consent to Use Public Space/);
  assert.deepEqual(prop1.choices, [{ name: 'YES', votes: 1091701 }, { name: 'NO', votes: 631566 }]);
  const cc3 = r.contests.find((c) => c.feed_id === 'Member of the City Council 3rd Council District');
  assert.deepEqual(cc3.choices.map((c) => c.name), ['Carl Wilson', 'Haris Bhatti', 'WRITE-IN']);
  assert.equal(r.contests.find((c) => c.feed_id === 'Surrogate New York').choices[0].name, 'Rita Mella');
});

test('nyc_enr: an unchanged index costs one conditional request', async () => {
  const first = await nyc.read({ fetch: fakeFetch(nycRoutes()), map: mapFor('results-NY-nyc') });
  const f = fakeFetch({ '/index.html': (url, opts) => (opts.headers['If-Modified-Since'] ? { status: 304, body: '' } : { status: 200, body: fixture('nyc.index.html') }) });
  const r = await nyc.read({ fetch: f, map: mapFor('results-NY-nyc'), prevToken: `Wed, 04 Nov 2026 04:16:58 GMT|${first.changed_token.split('|')[1]}` });
  assert.equal(r.unchanged, true);
  assert.equal(f.calls.length, 1);
});

test('nyc_enr: a repeated name with no board total, or rows that miss the printed total, drop the contest', () => {
  const page = fixture('nyc.OFA10CY0PY1.html'); // Surrogate New York and Bronx, one line each
  const twice = page.replace('>WRITE-IN&nbsp;', '>Rita Mella&nbsp;'); // Surrogate New York's first block only
  assert.deepEqual(nyc.parsePage(twice).contests.map((c) => c.feed_id), ['Surrogate Bronx']);
  assert.equal(nyc.parsePage(twice).dropped, 1);
  const short = page.replace('&nbsp;382483<', '&nbsp;382480<');
  const p = nyc.parsePage(short);
  assert.deepEqual(p.contests.map((c) => c.feed_id), ['Surrogate Bronx']);
  assert.equal(p.dropped, 1);
});

test('nyc_enr: a refusal or a challenge page is never read as results', async () => {
  let r = await nyc.read({ fetch: fakeFetch({ '/index.html': { status: 403, body: 'Just a moment...' } }), map: mapFor('results-NY-nyc') });
  assert.equal(r.verdict, 'refused');
  r = await nyc.read({ fetch: fakeFetch({ '/index.html': { status: 200, body: '<html><title>Just a moment...</title></html>' } }), map: mapFor('results-NY-nyc') });
  assert.equal(r.verdict, 'error');
  r = await nyc.read({ fetch: fakeFetch({ '/index.html': { status: 302, body: '', headers: { location: 'https://vote.nyc/' } } }), map: mapFor('results-NY-nyc') });
  assert.equal(r.verdict, 'refused');
});

test('md_sbe: the state pages read whole-race counts with each page its own refresh time', async () => {
  const f = fakeFetch(mdRoutes('results-MD'));
  const r = await md.read({ fetch: f, map: mapFor('results-MD') });
  assert.equal(r.verdict, 'ok');
  assert.deepEqual(r.election, { id: '2026 Gubernatorial General Election', name: '2026 Gubernatorial General Election', date: '2026-11-03' });
  assert.deepEqual(r.labels, ['Unofficial']);
  assert.equal(r.official, false);
  assert.equal(r.contests.length, 134);
  assert.equal(r.dropped, 0);
  assert.equal(r.reporting, '1749 of 1979 election day precincts reported');
  assert.equal(r.source_updated, '2026-11-04T04:22:47.000Z'); // the questions page, 11:22:47 PM ET, is the newest
  const gov = r.contests.find((c) => c.feed_id === 'Governor / Lt. Governor');
  assert.equal(gov.updated, '2026-11-04T04:15:15.000Z');
  assert.deepEqual(gov.choices.map((c) => c.name), ['Wes Moore and Aruna Miller', 'Dan Cox and Rob Krop', 'Andy Ellis and Owen Silverman Andrews', 'Cathy White and Cathy Permut', 'Other Write-Ins']);
  assert.equal(gov.choices[0].votes, 1089186);
  const q1 = r.contests.find((c) => c.feed_id === 'Question 1: Constitutional Amendment');
  assert.equal(q1.updated, '2026-11-04T04:22:47.000Z');
  assert.match(q1.feed_name, /Arbitration Reform for State Employees/);
  assert.deepEqual(q1.choices.map((c) => c.name), ['For the Constitutional Amendment', 'Against the Constitutional Amendment']);
  assert.ok(r.contests.some((c) => c.feed_id === 'Justice, Supreme Court of Maryland, Circuit 4, Peter Killough'));
  assert.equal(r.contests.find((c) => c.feed_id === 'House of Delegates, District 43A').vote_for, 2);
  const cd1 = r.contests.find((c) => c.feed_id === 'Representative in Congress, District 1');
  assert.equal(cd1.choices.find((c) => c.name === 'Edward Shlikas (Write-In)').votes, 0);
  assert.ok(f.calls.every((c) => c.headers['User-Agent'] === NAMED_UA));
});

test('md_sbe: Baltimore City page: local offices, retention and Questions A to I', async () => {
  const r = await md.read({ fetch: fakeFetch(mdRoutes('results-MD-baltimore-city')), map: mapFor('results-MD-baltimore-city') });
  assert.equal(r.verdict, 'ok');
  assert.equal(r.contests.length, 35);
  assert.equal(r.reporting, '272 of 295 election day precincts reported');
  const qa = r.contests.find((c) => c.feed_id === 'Question A: Bond Issue');
  assert.equal(qa.feed_name, 'Question A: Bond Issue (Affordable Housing Loan)');
  assert.deepEqual(qa.choices, [{ name: 'For', votes: 97360 }, { name: 'Against', votes: 18581 }]);
  const boe = r.contests.find((c) => c.feed_id === 'Board of Education At Large');
  assert.equal(boe.vote_for, 2);
  assert.equal(boe.total, 171122);
  assert.deepEqual(r.contests.find((c) => c.feed_id === 'Judge, Appellate Court of Maryland At Large, Dan Friedman').choices.map((c) => c.name), ['Yes', 'No']);
  assert.equal(r.contests.find((c) => c.feed_id === 'House of Delegates, District 43A').reporting, '40 of 42 election day precincts reported');
});

test('md_sbe: unchanged pages cost one 304 each; one changed page re-reads the rest in full', async () => {
  const map = mapFor('results-MD-baltimore-city');
  const first = await md.read({ fetch: fakeFetch({ '/gen_results_2026_by_county_3_P.html': { status: 200, body: fixture('md.gen_results_2026_by_county_3_P.html'), headers: { 'Last-Modified': 'Wed, 04 Nov 2026 04:16:20 GMT' } } }), map });
  assert.equal(first.changed_token, JSON.stringify({ 'gen_results_2026_by_county_3_P.html': 'Wed, 04 Nov 2026 04:16:20 GMT' }));
  const same = fakeFetch({ '/gen_results_2026_by_county_3_P.html': (u, o) => (o.headers['If-Modified-Since'] ? { status: 304, body: '' } : { status: 500, body: '' }) });
  const r = await md.read({ fetch: same, map, prevToken: first.changed_token });
  assert.equal(r.unchanged, true);
  assert.equal(same.calls.length, 1);

  const state = mapFor('results-MD');
  const mods = Object.fromEntries(state.feed.pages.map((p) => [p, 'Wed, 04 Nov 2026 04:15:54 GMT']));
  const routes = {};
  for (const p of state.feed.pages) routes[`/${p}`] = (u, o) => (o.headers['If-Modified-Since'] && p !== 'gen_qresults_2026_1_00_ALL_P.html' ? { status: 304, body: '' } : { status: 200, body: fixture(`md.${p}`), headers: { 'Last-Modified': 'Wed, 04 Nov 2026 04:23:00 GMT' } });
  const g = fakeFetch(routes);
  const r2 = await md.read({ fetch: g, map: state, prevToken: JSON.stringify(mods) });
  assert.equal(r2.verdict, 'ok');
  assert.equal(r2.contests.length, 134);
  assert.equal(g.calls.length, state.feed.pages.length * 2 - 1);
});

test('md_sbe: a Totals row the rows miss drops that contest; a winner check rides as declared; NR reads 0', () => {
  const page = fixture('md.gen_results_2026_by_county_3_P.html');
  const short = page.replace('>108,228<', '>108,220<'); // State's Attorney: rows no longer add up
  const p = md.parsePage(short);
  assert.equal(p.dropped, 1);
  assert.ok(!p.contests.some((c) => c.feed_id === "State's Attorney"));
  const won = page.replace('<td><div>Ivan J. Bates</div></td>', '<td><div>Ivan J. Bates <img alt="Winner Selected" src="/img/check.gif"/></div></td>');
  assert.deepEqual(md.parsePage(won).contests.find((c) => c.feed_id === "State's Attorney").declared, ['Ivan J. Bates']);
  const nr = page.replace(/<td class="alignRight">98,064<\/td>/, '<td class="alignRight">NR</td>').replace('<b>117,585</b>', '<b>19,521</b>');
  assert.equal(md.parsePage(nr).contests.find((c) => c.feed_id === 'Governor / Lt. Governor').choices[0].votes, 0);
});

test('md_sbe: an election name the map does not know has no date (a mismatch, never a guess)', async () => {
  const map = mapFor('results-MD-baltimore-city');
  const body = fixture('md.gen_results_2026_by_county_3_P.html').replace('2026 Gubernatorial General Election', '2026 Gubernatorial Primary Election');
  const r = await md.read({ fetch: fakeFetch({ '/gen_results_2026_by_county_3_P.html': { status: 200, body } }), map });
  assert.equal(r.election.date, null);
});
