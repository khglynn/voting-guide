/* California's three readable sources on Nov 3, 2026, from trimmed copies of real reads (8:15 to 8:27 PM PT):
   San Diego and Orange County on Live Voter Turnout's summary XML, and the Secretary of State's JSON feed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, fixture, mapFor } from './helpers.mjs';
import * as lvt from '../src/adapters/lvt.js';
import * as ca_sos from '../src/adapters/ca_sos.js';
import { ADAPTERS } from '../src/adapters/index.js';
import { checkRead } from '../src/checks.js';
import { NAMED_UA } from '../src/fetch.js';

const LM = 'Wed, 04 Nov 2026 04:05:49 GMT';
const sdRoutes = { '/sandiegocaenr/25/summary_25.xml': { status: 200, body: fixture('lvt-sandiego.summary_25.xml'), headers: { 'Last-Modified': LM } } };
const ocRoutes = { '/orangecaenr/24/summary_24.xml': { status: 200, body: fixture('lvt-orange.summary_24.xml'), headers: { 'Last-Modified': LM } } };

test('adapters index names lvt and ca_sos', () => {
  assert.equal(ADAPTERS.lvt, lvt);
  assert.equal(ADAPTERS.ca_sos, ca_sos);
});

test('lvt: San Diego folder 25 reads as the Nov 3 election, with its own time, ballots counted and banner words', async () => {
  const f = fakeFetch(sdRoutes);
  const r = await lvt.read({ fetch: f, map: mapFor('san-diego-county-ca') });
  assert.equal(r.verdict, 'ok');
  assert.deepEqual(r.election, { id: '25', name: null, date: '2026-11-03' });
  assert.equal(r.source_updated, '2026-11-04T03:57:42.921Z'); // GeneratedDate 2026-11-03T19:57:42.921-08:00
  assert.equal(r.reporting, '689,666 ballots counted');
  assert.deepEqual(r.labels, ['Unofficial Election Results']);
  assert.equal(r.official, false);
  assert.equal(r.changed_token, `${LM}|2026-11-03T19:57:42.921-08:00`);
  assert.equal(r.contests.length, 12);
  const gov = r.contests.find((c) => c.feed_id === '1');
  assert.equal(gov.feed_name, 'GOVERNOR');
  assert.deepEqual(gov.choices, [{ name: 'XAVIER BECERRA', votes: 411514 }, { name: 'STEVE HILTON', votes: 272162 }]);
  assert.equal(gov.total, 683676);
  assert.equal(gov.reporting, null, 'LVT gives no per-race progress line, so none is invented');
  const council = r.contests.find((c) => c.feed_id === '148');
  assert.equal(council.feed_name, 'CITY OF SAN DIEGO MEMBER, CITY COUNCIL DISTRICT NO. 2');
  assert.deepEqual(council.choices.map((c) => [c.name, c.votes]), [['NICOLE CROSBY', 18158], ['RICHARD BAILEY', 15162]]);
  const m = r.contests.find((c) => c.feed_id === '215');
  assert.equal(m.feed_name, 'SAN DIEGO UNIFIED SCHOOL DISTRICT - MEASURE M - 55% Required To Pass');
  assert.deepEqual(m.choices, [{ name: 'BONDS - YES', votes: 120929 }, { name: 'BONDS - NO', votes: 70144 }]);
  assert.equal(checkRead(r, mapFor('san-diego-county-ca')).ok, true);
  assert.ok(f.calls.every((c) => c.headers['User-Agent'] === NAMED_UA), 'every request names us');
  assert.equal(f.calls.length, 1);
});

test('lvt: Orange County folder 24 keeps the feed spelling (party tags, a leading star) and its group as category', async () => {
  const r = await lvt.read({ fetch: fakeFetch(ocRoutes), map: mapFor('orange-county-ca') });
  assert.deepEqual(r.election, { id: '24', name: null, date: '2026-11-03' });
  assert.equal(r.source_updated, '2026-11-04T04:04:59.446Z');
  assert.equal(r.reporting, '604,945 ballots counted');
  const gov = r.contests.find((c) => c.feed_id === '1020');
  assert.equal(gov.category, 'State of California');
  assert.deepEqual(gov.choices.map((c) => c.name), ['XAVIER BECERRA (DEM)', 'STEVE HILTON (REP)']);
  const ful = r.contests.find((c) => c.feed_id === '5073');
  assert.equal(ful.feed_name, 'CITY OF FULLERTON Member, City Council District 3');
  assert.deepEqual(ful.choices, [{ name: '*SHANA CHARLES', votes: 1771 }, { name: 'DANIEL H. KIM', votes: 1220 }]);
  const a = r.contests.find((c) => c.feed_id === '8600');
  assert.equal(a.feed_name, 'A – Laguna Beach Unified School District, Bond Measure');
  assert.deepEqual(a.choices.map((c) => c.name), ['Bonds - Yes', 'Bonds - No']);
});

test('lvt: an unchanged file is one conditional request answered 304', async () => {
  const f = fakeFetch({ summary_25: (url, opts) => (opts.headers['If-Modified-Since'] === LM ? { status: 304 } : { status: 200, body: fixture('lvt-sandiego.summary_25.xml') }) });
  const r = await lvt.read({ fetch: f, map: mapFor('san-diego-county-ca'), prevToken: `${LM}|2026-11-03T19:57:42.921-08:00` });
  assert.equal(r.unchanged, true);
  assert.equal(f.calls.length, 1);
});

test('lvt: a different ElectionID reads as an election mismatch, never as tonight', async () => {
  const other = fixture('lvt-sandiego.summary_25.xml').replace(/<ElectionID>25<\/ElectionID>/g, '<ElectionID>23</ElectionID>');
  const r = await lvt.read({ fetch: fakeFetch({ summary_25: { status: 200, body: other } }), map: mapFor('san-diego-county-ca') });
  assert.equal(r.election.date, null);
  const c = checkRead(r, mapFor('san-diego-county-ca'));
  assert.equal(c.sourceBlocked, true);
  assert.ok(c.problems.some((p) => p.reason === 'election mismatch'));
});

test('lvt: a bot page, a refusal, a garbled count', async () => {
  let r = await lvt.read({ fetch: fakeFetch({ summary_25: { status: 200, body: '<html><body>Please verify you are human</body></html>' } }), map: mapFor('san-diego-county-ca') });
  assert.equal(r.verdict, 'refused');
  r = await lvt.read({ fetch: fakeFetch({ summary_25: { status: 403, body: 'denied' } }), map: mapFor('san-diego-county-ca') });
  assert.equal(r.verdict, 'refused');
  const bad = fixture('lvt-sandiego.summary_25.xml').replace('<TotalVotes>411514</TotalVotes>', '<TotalVotes>41,1514x</TotalVotes>');
  r = await lvt.read({ fetch: fakeFetch({ summary_25: { status: 200, body: bad } }), map: mapFor('san-diego-county-ca') });
  assert.equal(checkRead(r, mapFor('san-diego-county-ca')).readBlocked, true, 'a count that is not a whole number blocks the read');
});

/* The SOS feed: the map's four paths, in order. */
const sosRoutes = {
  '/returns/query?r=': 'ca-sos.query-statewide.json',
  '/returns/ballot-measures': 'ca-sos.ballot-measures.json',
  '/returns/board-of-equalization/district/all': 'ca-sos.boe-all.json',
  '/returns/us-rep/district/all': 'ca-sos.us-rep-all.json',
};

test('ca_sos: the SOS time reads as Pacific', () => {
  assert.equal(ca_sos.parseSosTime('November 3, 2026, 8:15 p.m.'), '2026-11-04T04:15:00.000Z');
  assert.equal(ca_sos.parseSosTime('November 4, 2026, 12:05 a.m.'), '2026-11-04T08:05:00.000Z');
  assert.equal(ca_sos.parseSosTime('Nov. 4, 2026, noon'), '2026-11-04T20:00:00.000Z');
  assert.equal(ca_sos.parseSosTime('November 5, 2026, midnight'), '2026-11-05T08:00:00.000Z');
  assert.equal(ca_sos.parseSosTime('soon'), null);
});

test('ca_sos: statewide offices, retentions, measures, BOE and House from four requests, named, with the race progress words', async () => {
  const f = fakeFetch(sosRoutes);
  const map = mapFor('results-CA');
  const r = await ca_sos.read({ fetch: f, map });
  assert.equal(r.verdict, 'ok');
  assert.equal(f.calls.length, 4);
  assert.ok(f.calls.every((c) => c.headers['User-Agent'] === NAMED_UA), 'every request names us');
  assert.ok(f.calls[0].url.startsWith('https://api.sos.ca.gov/returns/query?r=%5B%2202000000000059%22'), 'the query ids are encoded');
  assert.deepEqual(r.election, { id: 'gubernatorial-general', name: null, date: '2026-11-03' });
  assert.equal(r.source_updated, '2026-11-04T04:15:00.000Z');
  assert.equal(r.reporting, '23.8% (5,688 of 23,860) precincts reporting');
  assert.equal(r.changed_token, 'November 3, 2026, 8:15 p.m.|23.8% (5,688 of 23,860) precincts reporting');
  assert.equal(r.contests.length, 10 + 14 + 4 + 5);
  const gov = r.contests.find((c) => c.feed_id === 'Governor - Statewide Results');
  assert.deepEqual(gov.choices, [{ name: 'Xavier Becerra', votes: 1231614 }, { name: 'Steve Hilton', votes: 831273 }]);
  assert.equal(gov.reporting, '23.8% (5,688 of 23,860) precincts reporting');
  const evans = r.contests.find((c) => c.feed_id === 'Supreme Court Justice - Statewide Results: Kelli M. Evans');
  assert.deepEqual(evans.choices, [{ name: 'Yes', votes: 1127494 }, { name: 'No', votes: 516618 }]);
  assert.ok(r.contests.find((c) => c.feed_id === 'Supreme Court Justice - Statewide Results: Joshua Groban'));
  const p1 = r.contests.find((c) => c.feed_id === 'Proposition 01');
  assert.equal(p1.feed_name, 'Proposition 01: Authorizes Bonds For Housing Affordability Programs. Legislative Statute.');
  assert.deepEqual(p1.choices, [{ name: 'Yes', votes: 1106169 }, { name: 'No', votes: 896363 }]);
  const h12 = r.contests.find((c) => /District 11 -/.test(c.feed_id));
  assert.equal(h12.feed_id, 'U.S. House of Representatives District 11 - Districtwide Results');
  assert.ok(r.contests.find((c) => c.feed_id === 'Board of Equalization District 4 - Districtwide Results'));
  assert.equal(checkRead(r, map).ok, true);
});

test('ca_sos: an unchanged ReportingTime costs one request', async () => {
  const f = fakeFetch(sosRoutes);
  const r = await ca_sos.read({ fetch: f, map: mapFor('results-CA'), prevToken: 'November 3, 2026, 8:15 p.m.|23.8% (5,688 of 23,860) precincts reporting' });
  assert.equal(r.unchanged, true);
  assert.equal(f.calls.length, 1);
});

test('ca_sos: a ballot whose measure numbers differ is not taken as tonight', async () => {
  const bm = JSON.parse(fixture('ca-sos.ballot-measures.json'));
  bm['ballot-measures'] = bm['ballot-measures'].filter((m) => m.Number !== '45');
  const r = await ca_sos.read({ fetch: fakeFetch({ ...sosRoutes, '/returns/ballot-measures': { status: 200, body: JSON.stringify(bm) } }), map: mapFor('results-CA') });
  assert.equal(r.election.date, null);
  assert.equal(checkRead(r, mapFor('results-CA')).sourceBlocked, true);
});

test('ca_sos: the results site\'s Incapsula page, an error, and a duplicate race', async () => {
  let r = await ca_sos.read({ fetch: fakeFetch({ ...sosRoutes, '/returns/query?r=': { status: 200, body: fixture('ca-sos.site-incapsula.html') } }), map: mapFor('results-CA') });
  assert.equal(r.verdict, 'refused');
  r = await ca_sos.read({ fetch: fakeFetch({ ...sosRoutes, '/returns/us-rep/district/all': { status: 500, body: '' } }), map: mapFor('results-CA') });
  assert.equal(r.verdict, 'error');
  const boe = fixture('ca-sos.boe-all.json');
  r = await ca_sos.read({ fetch: fakeFetch({ ...sosRoutes, '/returns/us-rep/district/all': { status: 200, body: boe } }), map: mapFor('results-CA') });
  assert.equal(r.verdict, 'error');
  assert.match(r.error, /twice/);
});
