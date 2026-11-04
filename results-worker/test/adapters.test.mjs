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

test('clarity: a banner that carries a progress count is dropped (Travis 0/201, Williamson\'s unfilled X of X)', async () => {
  const { fixture } = await import('./helpers.mjs');
  const { hasProgressCount } = await import('../src/util.js');
  const settings = JSON.parse(fixture('clarity-dallas.electionsettings.json'));
  settings.pagesettings.web.header = 'Unofficial Results 0/201 Vote Centers Reporting';
  settings.pagesettings['global settings'].header = '<b>UNOFFICIAL RESULTS X of X Vote Centers Completely Reported</b>';
  settings.pagesettings['global settings']['mobile header'] = 'Unofficial Results';
  const f = fakeFetch({ '/127396/current_ver.txt': 'clarity-dallas.current_ver.txt', '/127396/382636/json/en/summary.json': 'clarity-dallas.summary.json', '/127396/382636/json/en/electionsettings.json': { status: 200, body: JSON.stringify(settings) } });
  const r = await clarity.read({ fetch: f, map: mapFor('dallas-county-tx') });
  assert.deepEqual(r.labels, ['Unofficial Results']);
  for (const t of ['245 of 1,327 Precincts Reported', 'Precincts Reporting: 15%', 'x of x reporting']) assert.equal(hasProgressCount(t), true, t);
  for (const t of ['Early Voting Totals Only', 'Unofficial Cumulative Results', 'Ranked-choice rounds available 11/4/2026', 'Election Night Unofficial Results']) assert.equal(hasProgressCount(t), false, t);
  // A read stored before the filter keeps its old labels; the file leaves them out anyway.
  const { buildStateFile } = await import('../src/merge.js');
  const map = { id: 't', state: 'TX', name: 'T County', county: 'T', feed: { adapter: 'clarity', results_url: 'https://t.example/', tz: 'America/Chicago' }, contests: [] };
  const read = { election: { date: '2026-11-03' }, source_updated: '2026-11-04T03:46:01.000Z', labels: ['Unofficial Results 0/201 Vote Centers Reporting'], contests: [] };
  const file = buildStateFile({ state: 'TX', maps: [map], srcs: { t: { record: { read, fetched: '2026-11-04T03:47:00.000Z' }, checked: true, sched: {} } }, mode: 'public', now: '2026-11-04T03:47:00.000Z' });
  assert.equal(file.sources[0].labels, undefined);
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

test('dc: the board\'s JSON reads with its own time and words; IsWinner is never taken as an outcome', async () => {
  const dc = await import('../src/adapters/dc.js');
  const map = { election: { feed_election_id: '2026-General-Election' }, feed: { base: 'https://electionresults.dcboe.org', identity: 'named' } };
  const f = fakeFetch({ 'getElectionInfo/2026-General-Election': 'dc.info.json', 'getCityWide/2026-General-Election': 'dc.citywide.json' });
  const r = await dc.read({ fetch: f, map });
  assert.equal(r.verdict, 'ok');
  assert.deepEqual(r.election, { id: '2026-General-Election', name: 'General Election 2026', date: '2026-11-03' });
  assert.equal(r.source_updated, '2026-11-04T02:30:16.197Z');
  assert.equal(r.reporting, '144 of 144 precincts counted');
  assert.equal(r.labels[0], 'Election Night Unofficial Results');
  assert.equal(r.official, false);
  assert.equal(r.contests.length, 16);
  assert.ok(r.contests.every((c) => c.declared === null), 'IsWinner is ignored');
  const again = await dc.read({ fetch: f, map, prevToken: r.changed_token });
  assert.equal(again.unchanged, true);
});

/* More Clarity sources, read once each with the named fetcher on Nov 3 at about 10:20 PM CT (one request every 30 s):
   Colorado's statewide site, Orange County FL (its own domain) and Fulton County GA. Fixtures are trimmed copies. */
const route = (e, v, n) => ({ [`/${e}/current_ver.txt`]: `${n}.current_ver.txt`, [`/${e}/${v}/json/en/summary.json`]: `${n}.summary.json`, [`/${e}/${v}/json/en/electionsettings.json`]: `${n}.electionsettings.json` });

test('clarity: Colorado statewide 127407 counts counties per contest, keeps precincts for the source line, drops a 2016 header', async () => {
  const f = fakeFetch(route('127407', '385063', 'clarity-co-state'));
  const r = await clarity.read({ fetch: f, map: mapFor('results-CO') });
  assert.equal(r.verdict, 'ok');
  assert.deepEqual(r.election, { id: '127407', name: '2026 General', date: '2026-11-03' });
  assert.equal(r.feed_version, '385063');
  assert.equal(r.source_updated, '2026-11-04T04:18:06.000Z'); // "11/3/2026 9:18:06 PM MST"
  // One header is "Unofficial Results" plus a pasted HTML page; the other still says "June 28, 2016 Primary Election".
  assert.deepEqual(r.labels, ['Unofficial Results']);
  assert.equal(r.reporting, '1132 of 4297 precincts reporting');
  const senate = r.contests.find((c) => c.feed_id === '20');
  assert.equal(senate.feed_name, 'United States Senator');
  assert.deepEqual(senate.choices.map((c) => c.name), ['Mark Baisley', 'John Hickenlooper', 'Bob Chew', 'Christopher Baum', 'Blake Huber', 'Adam Withrow']);
  assert.equal(senate.choices.find((c) => c.name === 'John Hickenlooper').votes, 1211963);
  assert.equal(senate.reporting, '15 of 64 counties reporting');
  const a81 = r.contests.find((c) => c.feed_name === 'Amendment 81 (CONSTITUTIONAL)');
  assert.deepEqual(a81.choices.map((c) => c.name), ['Yes/For', 'No/Against']);
  // Aurora 3A: the state's count is the sum of Adams, Arapahoe and Douglas, with PR 0 of 3 beside it: no progress words.
  const a3a = r.contests.find((c) => c.feed_id === '7306');
  assert.deepEqual(a3a.choices.map((c) => c.votes), [35386, 51662]);
  assert.equal(a3a.reporting, null);
  assert.equal(r.contests.find((c) => c.feed_id === '2023').reporting, null); // HD-23, 0 of 1 counties with votes in
  assert.ok(f.calls.every((c) => c.headers['User-Agent'] === NAMED_UA));
});

test('clarity: Orange County FL 127356 on its own domain, over and under votes listed as choices', async () => {
  const r = await clarity.read({ fetch: fakeFetch(route('127356', '384974', 'clarity-orange')), map: mapFor('orange-fl') });
  assert.equal(r.verdict, 'ok');
  assert.deepEqual(r.election, { id: '127356', name: '2026 General Election', date: '2026-11-03' });
  assert.equal(r.contests.length, 34);
  assert.equal(r.source_updated, '2026-11-04T04:03:00.000Z'); // "11/3/2026 11:03:00 PM EST"
  assert.deepEqual(r.labels, ['Unofficial Results']);
  // Its settings say 0 of 0, so the office's line is its whole-county races' own (13 at 263 precincts).
  assert.equal(r.reporting, '261 of 263 precincts reporting');
  assert.equal(r.reporting_from, 'United States Senator');
  const mayor = r.contests.find((c) => c.feed_name === 'County Mayor');
  assert.deepEqual(mayor.choices.map((c) => c.name), ['Chris Messina', 'Tiffany Moore Russell', 'Over Votes', 'Under Votes']);
  const senate = r.contests.find((c) => c.feed_id === '0004');
  assert.equal(senate.reporting, '261 of 263 precincts reporting');
  assert.equal(senate.choices.reduce((a, c) => a + c.votes, 0), senate.total); // T includes over and under votes
  const q = r.contests.find((c) => c.feed_name === 'School Board Question');
  assert.deepEqual(q.choices.map((c) => c.name), ['Yes for Approval', 'No for Rejection', 'Over Votes', 'Under Votes']);
});

test('clarity: Fulton County GA 127295, party tags on names, one label for two spellings of it', async () => {
  const r = await clarity.read({ fetch: fakeFetch(route('127295', '384970', 'clarity-fulton')), map: mapFor('fulton-ga') });
  assert.equal(r.verdict, 'ok');
  assert.deepEqual(r.election, { id: '127295', name: 'November 3, 2026 - General Primary -Nonpartisan General Special Election', date: '2026-11-03' });
  assert.equal(r.contests.length, 58);
  assert.equal(r.source_updated, '2026-11-04T03:58:39.000Z'); // "11/3/2026 10:58:39 PM EST"
  assert.deepEqual(r.labels, ['Unofficial Results']); // "Unofficial Results" and "UNOFFICIAL RESULTS"
  const cd5 = r.contests.find((c) => c.feed_id === '12');
  assert.deepEqual(cd5.choices.map((c) => c.name), ["John ''Bongo'' Salvesen (Rep)", 'Nikema Williams (I)(Dem)']);
  assert.deepEqual(cd5.choices.map((c) => c.votes), [8526, 113827]);
  assert.equal(cd5.reporting, '67 of 155 precincts reporting');
  const sw = r.contests.find((c) => c.feed_id === '50');
  assert.equal(sw.vote_for, 2);
});

test('clarity labels: a pasted page is cut off, another year is dropped, capitals-only repeats show once', () => {
  assert.deepEqual(clarity.labels({ web: { header: '<span>Unofficial Results</span>\r\n<!DOCTYPE html><html><body><table>7A</table></body></html>' }, 'global settings': { header: 'UNOFFICIAL RESULTS<br/>June 28, 2016 Primary Election', 'mobile header': 'unofficial results' } }, '2026'), ['Unofficial Results']);
  assert.deepEqual(clarity.labels({ web: { header: 'Early Voting Totals Only' }, 'global settings': { header: 'Unofficial Results November 3, 2026' } }, '2026'), ['Early Voting Totals Only', 'Unofficial Results November 3, 2026']);
});
