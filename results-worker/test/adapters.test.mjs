import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, mapFor } from './helpers.mjs';
import * as clarity from '../src/adapters/clarity.js';
import * as harris from '../src/adapters/harris.js';
import { NAMED_UA } from '../src/fetch.js';

const bexarRoutes = {
  '/127291/current_ver.txt': 'clarity-bexar.current_ver.txt',
  '/127291/379718/json/en/summary.json': 'clarity-bexar.summary.json',
  '/127291/379718/json/en/electionsettings.json': 'clarity-bexar.electionsettings.json',
};

test('clarity: Bexar 127291 reads as the Nov 3, 2026 election with 183 contests, all zero', async () => {
  const f = fakeFetch(bexarRoutes);
  const r = await clarity.read({ fetch: f, map: mapFor('bexar-tx') });
  assert.equal(r.verdict, 'ok');
  assert.equal(r.changed_token, '379718');
  assert.deepEqual(r.election, { id: '127291', name: '2026 General Election', date: '2026-11-03' });
  assert.equal(r.contests.length, 183);
  const senate = r.contests.find((c) => c.feed_name === 'United States Senator');
  assert.deepEqual(senate.choices.map((c) => c.name), ['REP Ken Paxton', 'DEM James Talarico', 'LIB Ted Brown', 'Write-in']);
  assert.ok(senate.choices.every((c) => c.votes === 0));
  assert.equal(senate.reporting, '0 of 806 precincts reporting');
  assert.equal(r.source_updated, '2026-10-01T21:06:32.000Z'); // "10/1/2026 4:06:32 PM CDT"
  assert.equal(r.official, false);
  assert.equal(r.source_status, null);
  assert.ok(f.calls.every((c) => c.headers['User-Agent'] === NAMED_UA), 'every request names us');
});

test('clarity: an unchanged version costs one request', async () => {
  const f = fakeFetch(bexarRoutes);
  const r = await clarity.read({ fetch: f, map: mapFor('bexar-tx'), prevToken: '379718' });
  assert.equal(r.unchanged, true);
  assert.equal(f.calls.length, 1);
});

test('clarity: Dallas 127396 is the Nov 3 election; 126485 (the registry guess) is June 13 runoff', async () => {
  const f = fakeFetch({
    '/127396/current_ver.txt': 'clarity-dallas.current_ver.txt',
    '/127396/382636/json/en/summary.json': 'clarity-dallas.summary.json',
    '/127396/382636/json/en/electionsettings.json': 'clarity-dallas.electionsettings.json',
  });
  const r = await clarity.read({ fetch: f, map: mapFor('dallas-county-tx') });
  assert.deepEqual(r.election, { id: '127396', name: 'General & Joint Election 2026', date: '2026-11-03' });
  assert.equal(r.contests.length, 83);

  const june = fakeFetch({
    '/126485/current_ver.txt': 'clarity-dallas-june.current_ver.txt',
    '/126485/375921/json/en/summary.json': 'clarity-dallas-june.summary.json',
    '/126485/375921/json/en/electionsettings.json': 'clarity-dallas-june.electionsettings.json',
  });
  const old = await clarity.read({ fetch: june, map: { ...mapFor('dallas-county-tx'), election: { date: '2026-11-03', feed_election_id: '126485' } } });
  assert.equal(old.election.date, '2026-06-13');
  // the June runoff has real counts: the identity check (checks.test) is what keeps them out
  assert.ok(old.contests.some((c) => c.choices.some((ch) => ch.votes > 0)));
});

test('clarity: refused, an HTML bot page, and a garbled version', async () => {
  let r = await clarity.read({ fetch: fakeFetch({ current_ver: { status: 403, body: 'denied' } }), map: mapFor('bexar-tx') });
  assert.equal(r.verdict, 'refused');
  r = await clarity.read({ fetch: fakeFetch({ current_ver: { status: 200, body: '<!DOCTYPE html><html>Just a moment</html>' } }), map: mapFor('bexar-tx') });
  assert.equal(r.verdict, 'refused');
  r = await clarity.read({ fetch: fakeFetch({ current_ver: { status: 200, body: 'oops' } }), map: mapFor('bexar-tx') });
  assert.equal(r.verdict, 'error');
  r = await clarity.read({ fetch: fakeFetch({ current_ver: { status: 200, body: '379999' }, 'summary.json': { status: 500, body: '' } }), map: mapFor('bexar-tx') });
  assert.equal(r.verdict, 'error');
});

test('clarity: lists elections from the county list page', async () => {
  const r = await clarity.listElections({ fetch: fakeFetch({ 'Travis/elections.json': 'clarity-travis.elections.json' }), base: 'https://results.enr.clarityelections.com/TX/Travis' });
  assert.equal(r.verdict, 'ok');
  assert.equal(r.elections[0].id, '126357');
  assert.equal(r.elections[0].date, '2026-05-26');
  assert.ok(!r.elections.some((e) => e.date === '2026-11-03'), 'no Nov 3 entry at 3:10 PM CT');
});

test('harris: election 1126 reads with 231 contests and the county\'s own time', async () => {
  const f = fakeFetch({ '/1126/resultsbyballot.json': { status: 200, body: (await import('./helpers.mjs')).fixture('harris.resultsbyballot.json'), headers: { 'Last-Modified': 'Tue, 03 Nov 2026 20:10:19 GMT' } } });
  const r = await harris.read({ fetch: f, map: mapFor('harris-county-tx') });
  assert.equal(r.verdict, 'ok');
  assert.deepEqual(r.election, { id: '1126', name: 'General and Special Elections', date: '2026-11-03' });
  assert.equal(r.contests.length, 231);
  assert.equal(r.source_updated, '2026-11-03T19:51:00.000Z');
  assert.equal(r.official, false);
  assert.equal(r.reporting, '0 of 623 voting centers reporting');
  assert.ok(r.contests.every((c) => c.reporting === '0 of 623 voting centers reporting'), "every race carries the county's vote-center line, never the feed's precinct count");
  const prop = r.contests.find((c) => c.feed_name === 'CITY OF HOUSTON, PROPOSITION A');
  assert.deepEqual(prop.choices.map((c) => c.name), ['FOR', 'AGAINST']);
  assert.equal(r.changed_token, 'Tue, 03 Nov 2026 20:10:19 GMT|2026-11-03T19:51:00Z');
});

test('harris: a 304 to If-Modified-Since is unchanged in one request', async () => {
  const f = fakeFetch({ resultsbyballot: (url, opts) => (opts.headers['If-Modified-Since'] === 'Tue, 03 Nov 2026 20:10:19 GMT' ? { status: 304 } : { status: 500 }) });
  const r = await harris.read({ fetch: f, map: mapFor('harris-county-tx'), prevToken: 'Tue, 03 Nov 2026 20:10:19 GMT|2026-11-03T19:51:00Z' });
  assert.equal(r.unchanged, true);
  assert.equal(f.calls.length, 1);
});

test('harris: official flag and counts', async () => {
  const body = JSON.stringify({ et: 'General and Special Elections', ec: '1126', edt: 'November 03, 2026', o: 1, vc: 623, vt: 623, dt: '2026-11-17T20:00:00Z', contests: [{ i: 1, t: 'X', ca: ['A', 'B'], tv: [10, 5], pr: 3, tp: 3, pct: ['66.67%', '33.33%'] }] });
  const r = await harris.read({ fetch: fakeFetch({ resultsbyballot: { status: 200, body } }), map: mapFor('harris-county-tx') });
  assert.equal(r.official, true);
  assert.equal(r.contests[0].total, 15);
  assert.equal(r.contests[0].reporting, '623 of 623 voting centers reporting');
});

test('clarity: a summary.json sent gzipped without Content-Encoding (Fulton, Nov 3) is unzipped by hand', async () => {
  const { gzipSync } = await import('node:zlib');
  const { fixture } = await import('./helpers.mjs');
  const zipped = new Uint8Array(gzipSync(Buffer.from(fixture('clarity-bexar.summary.json'))));
  const f = fakeFetch({ ...bexarRoutes, '/127291/379718/json/en/summary.json': { status: 200, bytes: zipped } });
  const r = await clarity.read({ fetch: f, map: mapFor('bexar-tx') });
  assert.equal(r.verdict, 'ok');
  assert.equal(r.contests.length, 183);
});

test('clarity: the source\'s own banner words come through as labels', async () => {
  const { fixture } = await import('./helpers.mjs');
  const settings = JSON.parse(fixture('clarity-dallas.electionsettings.json'));
  settings.pagesettings.web.header = '<div>Early Voting Totals Only</div>';
  settings.pagesettings['global settings'].header = '<center><span style="color: red">\r\nEarly Voting Totals Only</span></center>';
  settings.pagesettings['global settings']['mobile header'] = 'Unofficial Results';
  const f = fakeFetch({ '/127396/current_ver.txt': 'clarity-dallas.current_ver.txt', '/127396/382636/json/en/summary.json': 'clarity-dallas.summary.json', '/127396/382636/json/en/electionsettings.json': { status: 200, body: JSON.stringify(settings) } });
  const r = await clarity.read({ fetch: f, map: mapFor('dallas-county-tx') });
  assert.deepEqual(r.labels, ['Early Voting Totals Only', 'Unofficial Results']);
});

test('tx_sos: the SOS page parses; a race cut off mid-table (Nov 3, 8:58 PM) is dropped, never read as finished', async () => {
  const { parse } = await import('../src/adapters/tx_sos.js');
  const { fixture } = await import('./helpers.mjs');
  const p = parse(fixture('tx-sos.results.html'));
  assert.equal(p.name, '2026 NOVEMBER GENERAL ELECTION');
  assert.equal(p.date, '2026-11-03');
  assert.equal(p.updated, '11/03/2026 08:56 PM');
  assert.equal(p.contests.length, 9);
  assert.equal(p.dropped, 1, 'U.S. House District 9 is cut off mid-row');
  const sen = p.contests[0];
  assert.equal(sen.feed_id, 'U. S. SENATOR');
  assert.equal(sen.reporting, 'Polling Locations Reporting: 11%');
  assert.deepEqual(sen.choices.slice(0, 2).map((c) => [c.name, c.votes]), [['KEN PAXTON', 2553979], ['JAMES TALARICO', 3410265]]);
  assert.ok(!p.contests.some((c) => c.feed_id.endsWith('DISTRICT 9')));
});

test('clarity: no progress words when no precinct has reported but votes are in', async () => {
  const { fixture } = await import('./helpers.mjs');
  const sum = JSON.parse(fixture('clarity-bexar.summary.json'));
  sum[0] = { ...sum[0], PR: 0, TP: 210, V: [100, 50, 0, 0] };
  sum[1] = { ...sum[1], PR: 5, TP: 210 };
  const f = fakeFetch({ ...bexarRoutes, '/127291/379718/json/en/summary.json': { status: 200, body: JSON.stringify(sum) } });
  const r = await clarity.read({ fetch: f, map: mapFor('bexar-tx') });
  assert.equal(r.contests[0].reporting, null);
  assert.equal(r.contests[1].reporting, '5 of 210 precincts reporting');
});
