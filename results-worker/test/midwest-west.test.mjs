/* St. Louis County's CSV, the Oregon SOS pages and Multnomah's ranked-choice site, on trimmed copies of the reads made
   Nov 3, 2026 between 10:19 and 10:40 PM CT (stlouis.media.csv: contest 73 whole plus contests 35 and 48 for precincts
   1 to 8; the Oregon pages keep their header and a few races; the Multnomah home page keeps two offices). Expected
   counts were summed from the saved files with a separate script, not by the adapter. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, fixture, mapFor } from './helpers.mjs';
import * as stl from '../src/adapters/stlouis_csv.js';
import * as orsos from '../src/adapters/or_sos.js';
import * as multco from '../src/adapters/multco.js';
import { NAMED_UA } from '../src/fetch.js';
import { checkRead } from '../src/checks.js';
import { sourceSlices } from '../src/merge.js';

const LM = 'Wed, 04 Nov 2026 03:58:42 GMT';
const csvRoute = (body = fixture('stlouis.media.csv'), lm = LM) => ({ 'media.csv': { status: 200, body, headers: { 'Last-Modified': lm, ETag: '"689174c8106cdd1:0"' } } });

test('stlouis_csv: the county file sums its precinct rows per contest, with the server\'s own time and words', async () => {
  const f = fakeFetch(csvRoute());
  const map = mapFor('results-MO-stlouis-county');
  const r = await stl.read({ fetch: f, map });
  assert.equal(r.verdict, 'ok');
  assert.deepEqual(r.contests.map((c) => c.feed_id), ['35', '48', '73']);
  const exec = r.contests[0];
  assert.equal(exec.feed_name, 'ST. LOUIS COUNTY - COUNTY EXECUTIVE');
  assert.deepEqual(exec.choices.map((c) => [c.name, c.votes]), [['DENNIS HANCOCK', 289], ['JAKE ZIMMERMAN', 719], ['J D MCFARLAND', 32]]);
  assert.equal(exec.total, 1040);
  assert.deepEqual(r.contests[2].choices.map((c) => [c.name, c.votes]), [['YES', 5490], ['NO', 6867]]);
  assert.equal(exec.reporting, 'Polls Reporting: 200/200');
  assert.equal(r.reporting, 'Polls Reporting: 200/200');
  assert.equal(r.source_updated, '2026-11-04T03:58:42.000Z');
  assert.deepEqual(r.election, { id: map.election.feed_election_id, name: '', date: '2026-11-03' });
  assert.deepEqual(r.labels, []);
  assert.equal(r.official, false);
  assert.ok(f.calls.every((c) => c.headers['User-Agent'] === NAMED_UA));
  assert.equal(checkRead(r, map).ok, true);
});

test('stlouis_csv: an unchanged file is one conditional request answered 304', async () => {
  const f = fakeFetch({ 'media.csv': { status: 304, body: '' } });
  const r = await stl.read({ fetch: f, map: mapFor('results-MO-stlouis-county'), prevToken: `${LM}|"689174c8106cdd1:0"` });
  assert.equal(r.unchanged, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].headers['If-Modified-Since'], LM);
});

test('stlouis_csv: another election\'s file (no identity contests, or dated outside the count) never passes', async () => {
  const map = mapFor('results-MO-stlouis-county');
  const head = fixture('stlouis.media.csv').split('\r\n')[0];
  const other = `${head}\r\nAP - 001,1,Polls Reporting: 5/5,252,33,13.1,CITY OF BALLWIN - PROPOSITION 1,1,,YES,1,,10\r\n`;
  let r = await stl.read({ fetch: fakeFetch(csvRoute(other)), map });
  assert.equal(r.verdict, 'ok');
  assert.equal(checkRead(r, map).sourceBlocked, true);
  r = await stl.read({ fetch: fakeFetch(csvRoute(undefined, 'Tue, 04 Aug 2026 03:10:00 GMT')), map });
  assert.equal(r.election.date, '2026-08-03');
  assert.equal(checkRead(r, map).sourceBlocked, true);
});

test('stlouis_csv: mixed progress words are not quoted; a non-number count is refused; a bot page is a refusal', async () => {
  const map = mapFor('results-MO-stlouis-county');
  const text = fixture('stlouis.media.csv');
  const mixed = text.replace('Polls Reporting: 200/200', 'Absentee Reporting');
  let r = await stl.read({ fetch: fakeFetch(csvRoute(mixed)), map });
  assert.equal(r.reporting, null);
  assert.equal(r.contests[0].reporting, null);
  const garbled = text.replace(/,7\r\n/, ',7x\r\n');
  r = await stl.read({ fetch: fakeFetch(csvRoute(garbled)), map });
  assert.equal(checkRead(r, map).readBlocked, true);
  r = await stl.read({ fetch: fakeFetch(csvRoute('<!DOCTYPE html><title>Attention Required! | Cloudflare</title>')), map });
  assert.equal(r.verdict, 'refused');
  r = await stl.read({ fetch: fakeFetch({ 'media.csv': { status: 403, body: 'no' } }), map });
  assert.equal(r.verdict, 'refused');
});

test('stlouis_csv: a quoted field with a comma inside still lines up', () => {
  const p = stl.parse('#Precinct,Precinct ID,Precinct Reporting,Registered Voters,Ballots Cast,Turnout Percentage,Contest Title,Contest ID,Contest Party,Choice Name,Choice ID,Choice Party,Total Votes\r\nA,1,x,1,1,1,"CITY OF X, PROP 1",9,,"YES, FOR",1,,4\r\n');
  assert.deepEqual(p.contests[0].feed_name, 'CITY OF X, PROP 1');
  assert.deepEqual(p.contests[0].choices, [{ name: 'YES, FOR', party: '', votes: 4 }]);
});

const orRoutes = () => ({
  'type=FED': 'or-sos.fed.html',
  'type=SWNON': 'or-sos.swnon.html',
  'type=HOUSE': (url, opts) => ({ status: 200, body: fixture(opts.method === 'POST' ? 'or-sos.house-31-60.html' : 'or-sos.house.html') }),
  'oregonvotes.gov/': 'or-sos.index.html',
});
const orMap = () => {
  const m = mapFor('results-OR');
  m.feed.pages = ['resultsSW.aspx?type=FED&map=CTY', 'resultsSW.aspx?type=SWNON&map=CTY', 'resultsSW.aspx?type=HOUSE&map=CTY', { page: 'resultsSW.aspx?type=HOUSE&map=CTY', post: { name: 'ctl00$MainContent$btnHouse4', value: '31 - 60' } }];
  return m;
};

test('or_sos: the SOS pages read with the state\'s own time, label and ballots counted; races count whole', async () => {
  const f = fakeFetch(orRoutes());
  const map = orMap();
  const r = await orsos.read({ fetch: f, map });
  assert.equal(r.verdict, 'ok');
  assert.deepEqual(r.election, { id: 'General 11/3/2026', name: 'General Election November 3, 2026', date: '2026-11-03' });
  assert.equal(checkRead(r, map).ok, true);
  assert.equal(r.source_updated, '2026-11-04T04:15:00.000Z'); // "11/3/2026 | 8:15 PM PT"
  assert.deepEqual(r.labels, ['Unofficial']);
  assert.equal(r.official, false);
  assert.equal(r.reporting, 'Ballots Counted 1,210,606');
  const senate = r.contests.find((c) => c.feed_id === '300038695');
  assert.equal(senate.feed_name, 'US Senator');
  assert.deepEqual(senate.choices.map((c) => [c.name, c.votes]), [['David Brock Smith', 478226], ['Jeff Merkley', 682217], ['Gary Lyndon Dye', 10447], ['Chris Henry', 21385], ['Write-in', 865]]);
  assert.equal(senate.total, 1193140);
  // "0 out of 1318 Precincts Reported" beside 1.19 million counted votes (all mail): no progress words.
  assert.equal(senate.reporting, null);
  const judge = r.contests.find((c) => c.feed_name === 'Judge of the Circuit Court, 4th District, Position 6');
  assert.deepEqual(judge.choices.map((c) => c.name), ['Sonia A Montalbano - Incumbent', 'Write-in']);
  assert.ok(r.contests.some((c) => c.feed_name === 'State Representative, 28th District'));
  assert.ok(r.contests.some((c) => c.feed_name === 'State Representative, 42nd District'), 'House 31 to 60 come from the page\'s own button');
  const post = f.calls.find((c) => c.headers['Content-Type'] === 'application/x-www-form-urlencoded');
  assert.ok(post, 'one form post');
  assert.ok(f.calls.every((c) => c.headers['User-Agent'] === NAMED_UA));
  assert.equal(r.dropped, 0);
});

test('or_sos: the form post carries the page\'s own hidden fields and the one button', () => {
  const body = orsos.formBody(fixture('or-sos.house.html'), { name: 'ctl00$MainContent$btnHouse4', value: '31 - 60' });
  const keys = body.split('&').map((p) => decodeURIComponent(p.split('=')[0]));
  assert.ok(keys.includes('__VIEWSTATE') && keys.includes('__EVENTVALIDATION'));
  assert.equal(keys.at(-1), 'ctl00$MainContent$btnHouse4');
});

test('or_sos: an unchanged header is one request', async () => {
  const f = fakeFetch(orRoutes());
  const first = await orsos.read({ fetch: f, map: orMap() });
  const g = fakeFetch(orRoutes());
  const r = await orsos.read({ fetch: g, map: orMap(), prevToken: first.changed_token });
  assert.equal(r.unchanged, true);
  assert.equal(g.calls.length, 1);
});

test('or_sos: a race with no total (a page cut off) is dropped; ranked-choice placeholders are left out', () => {
  const page = fixture('or-sos.fed.html').replace(/id="300038696totals">[^<]*</, 'id="x"><');
  const p = orsos.parsePage(page);
  assert.equal(p.dropped, 1);
  assert.deepEqual(p.contests.map((c) => c.feed_id), ['300038695']);
  const cty = orsos.parsePage(fixture('or-sos.multnomah.html'));
  assert.equal(cty.elsewhere, 1); // "Multnomah County Commission, Chair - view results at rcvresults.multco.us", zeros
  assert.deepEqual(cty.contests.map((c) => c.feed_id), ['300038660', '300001788']);
});

const multRoutes = () => ({
  'Multnomah_County_Chair': 'multco.chair.html',
  'Multnomah_County_Auditor': 'multco.auditor.html',
  'blob.core.windows.net': 'multco.chair.json',
  'type=CTYALL': 'or-sos.multnomah.html',
  'oregonvotes.gov/': 'or-sos.index.html',
  'rcvresults.multco.us/': 'multco.index.html',
});

test('multco: first choices only from the county\'s ranked-choice JSON, with its publish time; the county page fills the rest', async () => {
  const f = fakeFetch(multRoutes());
  const map = mapFor('results-OR-multnomah');
  const r = await multco.read({ fetch: f, map });
  assert.equal(r.verdict, 'ok');
  assert.deepEqual(r.election, { id: 'November 3, 2026 General Election', name: 'November 3, 2026 General Election', date: '2026-11-03' });
  assert.equal(checkRead(r, map).ok, true);
  const chair = r.contests.find((c) => c.feed_id === 'rcv:Multnomah_County_Chair');
  assert.equal(chair.feed_name, 'Multnomah County Chair');
  assert.deepEqual(chair.choices, [{ name: 'Julia Brim-Edwards', votes: 61575 }, { name: 'Shannon Singleton', votes: 85119 }, { name: 'Sharon Meieran', votes: 39214 }, { name: 'Uncertified Write In', votes: 591 }]);
  assert.equal(chair.updated, '2026-11-04T04:00:00.000Z'); // "Published: November 3, 2026 8:00 PM"
  assert.equal(chair.is_rcv, true);
  assert.equal(chair.declared, null, 'round 2\'s "elected" is never read');
  assert.match(chair.note, /First choices only/);
  // One candidate, no JSON, and a table whose total disagrees with its rows: left as a link.
  assert.deepEqual(r.skipped, ['Multnomah County Auditor']);
  assert.ok(!r.contests.some((c) => /Auditor/.test(c.feed_name)));
  assert.ok(r.contests.some((c) => c.feed_id === '300038660'));
  assert.ok(!r.contests.some((c) => c.feed_id === '900038516'), 'the SOS page\'s zero placeholder for the chair race is not a count');
  assert.equal(r.source_updated, '2026-11-04T04:15:00.000Z');
  assert.ok(r.labels.includes('Preliminary Results') && r.labels.includes('Unofficial'));
  assert.ok(f.calls.every((c) => c.headers['User-Agent'] === NAMED_UA));
  const json = f.calls.find((c) => c.url.includes('blob.core.windows.net'));
  assert.ok(json.url.includes('Multco%20Board%20Chair%20Preliminary%20Update%201.json?sv='), 'the signed link is read fresh from the report page');
});

test('multco: an unchanged poll is two requests (the ranked-choice home page and the SOS header)', async () => {
  const first = await multco.read({ fetch: fakeFetch(multRoutes()), map: mapFor('results-OR-multnomah') });
  const g = fakeFetch(multRoutes());
  const r = await multco.read({ fetch: g, map: mapFor('results-OR-multnomah'), prevToken: first.changed_token });
  assert.equal(r.unchanged, true);
  assert.equal(g.calls.length, 2);
});

test('multco: a ranked-choice slice carries ranked_choice and never an outcome', async () => {
  const r = await multco.read({ fetch: fakeFetch(multRoutes()), map: mapFor('results-OR-multnomah') });
  const { raw, ...read } = r;
  const map = { ...mapFor('results-OR-multnomah'), contests: [{ feed_id: 'rcv:Multnomah_County_Chair', feed_name: 'Multnomah County Chair', item: 'multnomah-chair', kind: 'rcv', seats: 1, choices: { 'Julia Brim-Edwards': 'Julia Brim-Edwards', 'Shannon Singleton': 'Shannon Singleton', 'Sharon Meieran': 'Sharon Meieran', 'Uncertified Write In': '__other' }, reaches: ['Multnomah'], item_url: null }] };
  const { slices, problems } = sourceSlices(read, map, '2026-11-04T05:00:00.000Z');
  assert.deepEqual(problems, []);
  const s = slices['multnomah-chair'];
  assert.equal(s.status, 'counting');
  assert.equal(s.total_votes, 186499);
  assert.equal(s.candidates[0].name, 'Shannon Singleton');
  assert.equal(s.updated, '2026-11-04T04:00:00.000Z');
  assert.equal(s._kind, 'rcv');
  assert.match(s.note, /First choices only/);
});
