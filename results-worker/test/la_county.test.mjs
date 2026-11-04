import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, fixture, mapFor } from './helpers.mjs';
import * as la from '../src/adapters/la_county.js';
import { NAMED_UA } from '../src/fetch.js';
import { checkRead } from '../src/checks.js';
import { sourceStatus } from '../src/merge.js';

/* Fixtures: Los Angeles County's own JSON at its first bulletin, Nov 3, 2026, "11/3/2026 8:17:00 PM" (Pacific),
   1,439,924 vote-by-mail ballots. Trimmed: measure texts cut to 160 characters, and only the counter types the
   adapter reads (CAND, CFV, WRTN-xx, EBLT, MBLT, PRPT) kept. */
const ROUTES = { 'GetCounterData?electionID=4348': 'la-county.counterdata.json', 'GetElectionData?electionID=4348': 'la-county.electiondata.json' };
const map = mapFor('los-angeles-county-ca');
const json = (name) => JSON.parse(fixture(name));
const routesWith = (counter, election) => ({
  'GetCounterData?electionID=4348': { status: 200, body: JSON.stringify(counter) },
  'GetElectionData?electionID=4348': { status: 200, body: JSON.stringify(election) },
});

test('la_county: the first bulletin reads as election 4348 with 409 contests, the county\'s own time and words', async () => {
  const f = fakeFetch(ROUTES);
  const r = await la.read({ fetch: f, map });
  assert.equal(r.verdict, 'ok');
  assert.deepEqual(r.election, { id: '4348', name: 'General Election', date: '2026-11-03' });
  assert.equal(r.source_updated, '2026-11-04T04:17:00.000Z'); // 8:17 PM PST
  assert.equal(r.reporting, null, 'no precinct has reported; mail ballots only');
  assert.deepEqual(r.labels, ['Election night tally in progress']);
  assert.equal(r.official, false);
  assert.equal(r.source_status, null);
  assert.equal(r.ballots_counted, 1439924);
  assert.equal(r.contests.length, 409);
  assert.ok(f.calls.every((c) => c.headers['User-Agent'] === NAMED_UA), 'every request names us');

  const mayor = r.contests.find((c) => c.feed_id === '10767');
  assert.equal(mayor.feed_name, 'LOS ANGELES CITY GENERAL MUNICIPAL ELECTION Mayor');
  assert.equal(mayor.category, 'Cities');
  assert.deepEqual(mayor.choices, [{ name: 'KAREN RUTH BASS', votes: 252154 }, { name: 'NITHYA RAMAN', votes: 243792 }]);
  assert.equal(mayor.reporting, null);
  assert.equal(mayor.declared, null);

  const burbankC = r.contests.find((c) => c.feed_name === 'CITY OF BURBANK GENERAL MUNICIPAL ELECTION - MEASURE C');
  assert.deepEqual(burbankC.choices, [{ name: 'YES', votes: 15899 }, { name: 'NO', votes: 3812 }], 'a measure has no write-in line');

  const smmusd = r.contests.find((c) => c.feed_id === '10517');
  assert.equal(smmusd.vote_for, 4);
  assert.deepEqual(smmusd.choices.map((c) => c.name), ['ALICIA MIGNANO', 'HARRY LESHNER', 'LAURIE LIEBERMAN', 'ROBBIE STAENBERG', 'STACY ROUSE', 'Write-in']);
  assert.equal(smmusd.choices.at(-1).votes, 205);
});

test('la_county: a one-seat contest\'s total equals the county\'s own fully-voted ballots (CFV, write-ins included)', async () => {
  // CFV is ballots that used every selection (ballots cast less under and over votes): for a one-seat race that is every
  // vote for someone; for a vote-for-three race it is not a vote count at all (Artesia council: 1,099 against 4,744 votes).
  const r = await la.read({ fetch: fakeFetch(ROUTES), map });
  const cfv = new Map(json('la-county.counterdata.json').Data.filter((x) => x.ReferenceType === 'CFV').map((x) => [String(x.ReferenceID), x.Value]));
  const one = r.contests.filter((c) => c.vote_for === 1);
  assert.ok(one.length > 300);
  for (const c of one) assert.equal(c.total, cfv.get(c.feed_id), c.feed_name);
});

test('la_county: an unchanged counter file costs one request', async () => {
  const f = fakeFetch(ROUTES);
  const first = await la.read({ fetch: f, map });
  const n = f.calls.length;
  const again = await la.read({ fetch: f, map, prevToken: first.changed_token });
  assert.equal(again.unchanged, true);
  assert.equal(f.calls.length - n, 1);
  assert.match(f.calls.at(-1).url, /GetCounterData/);
});

test('la_county: a 403 or an Imperva challenge page is a refusal, and the election file is never asked for', async () => {
  for (const spec of [{ status: 403, body: 'Request unsuccessful. Incapsula incident ID: 0-0' }, { status: 200, body: '<html><head><META NAME="robots" CONTENT="noindex,nofollow"><script src="/_Incapsula_Resource?SWJIYLWA=x"></script></head></html>' }]) {
    const f = fakeFetch({ 'GetCounterData?electionID=4348': spec, 'GetElectionData?electionID=4348': 'la-county.electiondata.json' });
    const r = await la.read({ fetch: f, map });
    assert.equal(r.verdict, 'refused');
    assert.ok(f.calls.every((c) => !/GetElectionData/.test(c.url)));
  }
});

test('la_county: a different election in the file turns the source into links', async () => {
  const e = json('la-county.electiondata.json');
  e.Data.ID = 4316;
  e.Data.Date = '2024-11-05T00:00:00-08:00';
  const r = await la.read({ fetch: fakeFetch(routesWith(json('la-county.counterdata.json'), e)), map });
  const { raw, ...read } = r;
  const c = checkRead(read, map);
  assert.equal(c.sourceBlocked, true);
  assert.ok(c.problems.every((p) => p.reason === 'election mismatch'));
});

test('la_county: zeros read pending; the first bulletin reads counting, never complete, even once the election is locked', async () => {
  const zero = json('la-county.counterdata.json');
  zero.Data = zero.Data.map((x) => ({ ...x, Value: 0 }));
  const z = await la.read({ fetch: fakeFetch(routesWith(zero, json('la-county.electiondata.json'))), map });
  assert.equal(sourceStatus(z, map, '2026-11-04T04:10:00.000Z'), 'pending');
  const r = await la.read({ fetch: fakeFetch(ROUTES), map });
  assert.equal(sourceStatus(r, map, '2026-11-04T04:20:00.000Z'), 'counting');
  const e = json('la-county.electiondata.json');
  e.Data.Locked = true;
  const locked = await la.read({ fetch: fakeFetch(routesWith(json('la-county.counterdata.json'), e)), map });
  assert.equal(locked.source_status, 'locked');
  assert.deepEqual(locked.labels, []);
  assert.equal(sourceStatus(locked, map, '2026-12-01T00:00:00.000Z'), 'counting', 'no complete marker for California');
});

test('la_county: the county\'s Winner flags are never taken as an outcome', async () => {
  const e = json('la-county.electiondata.json');
  for (const g of e.Data.ContestGroups) for (const c of g.Contests) for (const x of c.Candidates) x.Winner = true;
  const r = await la.read({ fetch: fakeFetch(routesWith(json('la-county.counterdata.json'), e)), map });
  assert.ok(r.contests.every((c) => c.declared === null));
});

test('la_county: precinct words appear only from the county\'s own PRPT counts, never "0 of N" beside counted votes', async () => {
  const e = json('la-county.electiondata.json');
  const mayor = e.Data.ContestGroups.flatMap((g) => g.Contests).find((c) => c.ID === 10767);
  mayor.PrecinctCount = 1004;
  e.Data.PrecinctCount = 2853;
  const k = json('la-county.counterdata.json');
  k.Data.push({ Number: 9001, ReferenceID: 10767, ReferenceType: 'PRPT', Value: 312 }, { Number: 9002, ReferenceID: '', ReferenceType: 'PRPT', Value: 900 });
  const r = await la.read({ fetch: fakeFetch(routesWith(k, e)), map });
  assert.equal(r.contests.find((c) => c.feed_id === '10767').reporting, '312 of 1004 precincts reporting');
  assert.equal(r.reporting, '900 of 2853 precincts reporting');
  const k0 = json('la-county.counterdata.json');
  k0.Data.push({ Number: 9001, ReferenceID: 10767, ReferenceType: 'PRPT', Value: 0 });
  const r0 = await la.read({ fetch: fakeFetch(routesWith(k0, e)), map });
  assert.equal(r0.contests.find((c) => c.feed_id === '10767').reporting, null);
});

test('la_county: "Vote for no more than three" is three seats', () => {
  assert.equal(la.voteFor('Vote for no more than three'), 3);
  assert.equal(la.voteFor('Vote for no more than four'), 4);
  assert.equal(la.voteFor(''), 1);
});
