import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, mapFor, memStore, fixture } from './helpers.mjs';
import * as clarity from '../src/adapters/clarity.js';
import { checkRead, checkFile } from '../src/checks.js';
import { get } from '../src/fetch.js';
import { runTick } from '../src/tick.js';

const dallasJune = {
  '/126485/current_ver.txt': 'clarity-dallas-june.current_ver.txt',
  '/126485/375921/json/en/summary.json': 'clarity-dallas-june.summary.json',
  '/126485/375921/json/en/electionsettings.json': 'clarity-dallas-june.electionsettings.json',
};

test('identity: the election id comes from the feed, so a feed for another election is blocked', async () => {
  // The server answers 127396's address with the June runoff's files (126485): the id in its settings says so.
  const f = fakeFetch({
    '/127396/current_ver.txt': 'clarity-dallas-june.current_ver.txt',
    '/127396/375921/json/en/summary.json': 'clarity-dallas-june.summary.json',
    '/127396/375921/json/en/electionsettings.json': 'clarity-dallas-june.electionsettings.json',
  });
  const map = mapFor('dallas-county-tx');
  const r = await clarity.read({ fetch: f, map });
  assert.equal(r.election.id, '126485', 'the id is read from the feed, not copied from the map');
  const c = checkRead(r, map);
  assert.equal(c.sourceBlocked, true);
  const reasons = c.problems.filter((p) => p.reason === 'election mismatch').map((p) => p.detail);
  assert.ok(reasons.some((d) => /election id is 126485/.test(d)));
  assert.ok(reasons.some((d) => /dated|date is 2026-06-13/.test(d)));
});

test('identity: the right election passes', async () => {
  const f = fakeFetch({
    '/127396/current_ver.txt': 'clarity-dallas.current_ver.txt',
    '/127396/382636/json/en/summary.json': 'clarity-dallas.summary.json',
    '/127396/382636/json/en/electionsettings.json': 'clarity-dallas.electionsettings.json',
  });
  const map = mapFor('dallas-county-tx');
  const c = checkRead(await clarity.read({ fetch: f, map }), map);
  assert.equal(c.ok, true, JSON.stringify(c.problems));
});

test('fetch: a redirect is refused, and so is a body served from another address', async () => {
  const redirect = fakeFetch({ x: { status: 302, headers: { Location: 'https://elsewhere.example/feed.json' } } });
  let r = await get(redirect, 'https://results.example/x');
  assert.equal(r.verdict, 'refused');
  assert.match(r.error, /redirected/);
  const moved = async (url) => ({ status: 200, ok: true, url: 'https://elsewhere.example/x', headers: { get: () => null }, text: async () => '{}' });
  r = await get(moved, 'https://results.example/x');
  assert.equal(r.verdict, 'refused');
});

test('bad numbers block the read; a falling total keeps the earlier numbers', () => {
  const map = { election: { date: '2026-11-03' } };
  const mk = (v) => ({ election: { date: '2026-11-03' }, contests: [{ feed_id: '1', feed_name: 'X', choices: [{ name: 'A', votes: v }, { name: 'B', votes: 5 }] }] });
  assert.equal(checkRead(mk(-1), map).readBlocked, true);
  assert.equal(checkRead(mk(2.5), map).readBlocked, true);
  const now = mk(10);
  const c = checkRead(now, map, mk(50));
  assert.equal(c.ok, true);
  assert.deepEqual(c.kept, ['1']);
  assert.equal(now.contests[0].choices[0].votes, 50);
  assert.match(now.contests[0].note, /fell from 55 to 15/);
});

test('a falling total keeps its numbers with their own time; three lower reads in a row land as a correction', async () => {
  const { sourceSlices } = await import('../src/merge.js');
  const map = { id: 't', name: 'T County', county: 'T', election: { date: '2026-11-03' }, feed: { tz: 'America/Chicago', results_url: 'https://t.example/' }, contests: [{ feed_id: '1', feed_name: 'X', item: 'x', kind: 'plurality', seats: 1, choices: { A: 'A', B: 'B' }, reaches: ['T'] }] };
  const mk = (v, at) => ({ election: { date: '2026-11-03' }, source_updated: at, contests: [{ feed_id: '1', feed_name: 'X', updated: null, reporting: `at ${at}`, choices: [{ name: 'A', votes: v }, { name: 'B', votes: 0 }] }] });
  const nine = '2026-11-04T03:00:00.000Z';
  const r0 = mk(1200, nine);
  const r1 = mk(1000, '2026-11-04T04:30:00.000Z');
  let c = checkRead(r1, map, r0);
  assert.deepEqual(c.kept, ['1']);
  const k = r1.contests[0];
  assert.equal(k.choices[0].votes, 1200);
  assert.equal(k.updated, nine, 'kept numbers keep the time they are from');
  assert.equal(k.carried_from, nine);
  assert.equal(k.reporting, `at ${nine}`, 'and their own progress words');
  assert.equal(k.note, "The source's total fell from 1,200 to 1,000 at its 10:30 PM update, so these are its numbers from 9:00 PM.");
  assert.equal(sourceSlices(r1, map, '2026-11-04T04:31:00.000Z').slices.x.updated, nine, 'the file shows 9:00 PM, not 10:30 PM');
  // a second lower read: still kept, still 9:00 PM
  const r2 = mk(1010, '2026-11-04T05:00:00.000Z');
  c = checkRead(r2, map, r1);
  assert.deepEqual(c.kept, ['1']);
  assert.equal(r2.contests[0].updated, nine);
  // the third lower read in a row: the source's own count stands (a correction)
  const r3 = mk(1020, '2026-11-04T05:30:00.000Z');
  c = checkRead(r3, map, r2);
  assert.deepEqual(c.kept, []);
  assert.equal(r3.contests[0].choices[0].votes, 1020);
  assert.equal(r3.contests[0].updated, null);
  assert.equal(r3.contests[0].note, undefined);
  assert.ok(c.problems.some((p) => p.reason === 'falling total accepted'));
  // a read back at or above the kept total in between starts the count over
  const a1 = mk(1000, '2026-11-04T04:30:00.000Z'); checkRead(a1, map, mk(1200, nine));
  const a2 = mk(1300, '2026-11-04T05:00:00.000Z'); checkRead(a2, map, a1);
  assert.equal(a2.contests[0].falls, undefined);
  const a3 = mk(1250, '2026-11-04T05:30:00.000Z'); assert.deepEqual(checkRead(a3, map, a2).kept, ['1']);
  assert.equal(a3.contests[0].falls, 1);
});

test('TX-10 on the Texas SOS, Nov 3: a contest kept by the old code (no time of its own) gives way to the source\'s count', () => {
  const map = { election: { date: '2026-11-03' }, feed: { tz: 'America/Chicago' } };
  const tx10 = (gober, rourk, extra = {}) => ({ feed_id: 'U. S. REPRESENTATIVE DISTRICT 10', feed_name: 'U. S. REPRESENTATIVE DISTRICT 10', updated: null, reporting: 'Polling Locations Reporting: 27%', choices: [{ name: 'CHRIS GOBER', votes: gober }, { name: 'CAITLIN ROURK', votes: rourk }], ...extra });
  // What the live file held at 04:40Z: the earlier 124,544 kept under the 04:34 read, with the old note and no time.
  const stored = { election: { date: '2026-11-03' }, source_updated: '2026-11-04T04:34:00.000Z', contests: [tx10(76000, 48544, { note: "The source's total fell from 124544 to 124424 at its 2026-11-04T04:34:00.000Z update; we kept the earlier numbers." })] };
  const next = { election: { date: '2026-11-03' }, source_updated: '2026-11-04T04:45:00.000Z', contests: [tx10(75930, 48494)] };
  const c = checkRead(next, map, stored);
  assert.deepEqual(c.kept, []);
  assert.equal(next.contests[0].choices[0].votes, 75930, "the source's own count, with the source's own time");
  assert.equal(next.contests[0].note, undefined);
  assert.ok(c.problems.some((p) => p.reason === 'falling total accepted'));
  // The same drop under the new code keeps 124,544 with the time it is from.
  const before = { election: { date: '2026-11-03' }, source_updated: '2026-11-04T04:20:00.000Z', contests: [tx10(76000, 48544)] };
  const fell = { election: { date: '2026-11-03' }, source_updated: '2026-11-04T04:34:00.000Z', contests: [tx10(75930, 48494)] };
  checkRead(fell, map, before);
  assert.equal(fell.contests[0].updated, '2026-11-04T04:20:00.000Z');
  assert.equal(fell.contests[0].note, "The source's total fell from 124,544 to 124,424 at its 10:34 PM update, so these are its numbers from 10:20 PM.");
});

test('tick: a blocked read keeps the previous good read as the baseline', async () => {
  const map = mapFor('dallas-county-tx');
  const good = {
    '/127396/current_ver.txt': { status: 200, body: '400001' },
    '/127396/400001/json/en/summary.json': { status: 200, body: JSON.stringify(JSON.parse(fixture('clarity-dallas.summary.json')).map((c, i) => (i === 0 ? { ...c, V: c.V.map(() => 100), T: [100 * c.V.length] } : c))) },
    '/127396/400001/json/en/electionsettings.json': 'clarity-dallas.electionsettings.json',
  };
  const store = memStore();
  const t1 = '2026-11-04T02:00:00.000Z';
  await runTick({ fetch: fakeFetch(good), store, archive: null, maps: [map], now: t1 });
  const first = JSON.parse(await store.get('src:dallas-county-tx'));
  assert.equal(first.blocked, false);

  // Next: the feed serves the June runoff under the same address (a new version, the wrong election).
  const wrong = {
    '/127396/current_ver.txt': { status: 200, body: '400002' },
    '/127396/400002/json/en/summary.json': 'clarity-dallas-june.summary.json',
    '/127396/400002/json/en/electionsettings.json': 'clarity-dallas-june.electionsettings.json',
  };
  const t2 = '2026-11-04T02:01:00.000Z';
  const out = await runTick({ fetch: fakeFetch(wrong), store, archive: null, maps: [map], now: t2 });
  assert.equal(out.ran[0].outcome, 'election mismatch');
  const kept = JSON.parse(await store.get('src:dallas-county-tx'));
  assert.equal(kept.blocked, true);
  assert.deepEqual(kept.read, first.read, 'the good read stays as the baseline');
  assert.ok(await store.get('blocked:dallas-county-tx'), 'the blocked attempt is kept apart');
  const preview = JSON.parse(await store.get('preview:TX'));
  assert.equal(preview.sources[0].status, 'link_only');
  assert.equal(preview.sources[0].note, 'election mismatch');

  // Then the right election again, with lower numbers than the good read: the falling-total check compares with the
  // good read (100s), not with the June file.
  const ninety = JSON.stringify(JSON.parse(fixture('clarity-dallas.summary.json')).map((c, i) => (i === 0 ? { ...c, V: c.V.map(() => 90) } : c)));
  const back = { '/127396/current_ver.txt': { status: 200, body: '400003' }, '/127396/400003/json/en/summary.json': { status: 200, body: ninety }, '/127396/400003/json/en/electionsettings.json': 'clarity-dallas.electionsettings.json' };
  const t3 = '2026-11-04T02:30:00.000Z';
  const out3 = await runTick({ fetch: fakeFetch(back), store, archive: null, maps: [map], now: t3 });
  assert.equal(out3.ran[0].outcome, 'changed');
  assert.ok(out3.ran[0].problems.some((p) => p.reason === 'falling total'));
  const after = JSON.parse(await store.get('src:dallas-county-tx'));
  assert.equal(after.blocked, false);
  assert.equal(after.read.contests[0].choices[0].votes, 100, 'kept the earlier good numbers');
  assert.equal(await store.get('blocked:dallas-county-tx'), null);
});

test('checkFile: percentages must match their counts', () => {
  const f = { election: '2026-11-03', state: 'TX', generated: '2026-11-04T02:00:00Z', sources: [], items: { a: { source: 's', status: 'counting', reporting: null, updated: null, url: 'https://x.example/', total_votes: 10, candidates: [{ name: 'A', votes: 6, pct: 60 }, { name: 'B', votes: 4, pct: 45 }], final: null } } };
  assert.ok(checkFile(f).some((p) => /B pct 45/.test(p)));
  f.items.a.candidates[1].pct = 40;
  assert.deepEqual(checkFile(f), []);
  f.items.a.final = { winners: ['A'] };
  assert.ok(checkFile(f).some((p) => /final result on a count that isn't complete/.test(p)));
});

test('tick: a full re-read of identical bytes is unchanged (no new snapshot)', async () => {
  const map = mapFor('bexar-tx');
  const routes = { '/127291/current_ver.txt': 'clarity-bexar.current_ver.txt', '/127291/379718/json/en/summary.json': 'clarity-bexar.summary.json', '/127291/379718/json/en/electionsettings.json': 'clarity-bexar.electionsettings.json' };
  const store = memStore();
  const puts = [];
  const archive = { put: async (k) => puts.push(k) };
  await runTick({ fetch: fakeFetch(routes), store, archive, maps: [map], now: '2026-11-03T22:00:00.000Z' });
  const sched = JSON.parse(await store.get('sched:2026-11-03'));
  delete sched.sources['bexar-tx'].token; // as after a deploy that changed the map
  sched.sources['bexar-tx'].next_due = null;
  await store.put('sched:2026-11-03', JSON.stringify(sched));
  const out = await runTick({ fetch: fakeFetch(routes), store, archive, maps: [map], now: '2026-11-03T22:05:00.000Z' });
  assert.equal(out.ran[0].outcome, 'unchanged');
  assert.equal(puts.filter((k) => k.startsWith('raw/')).length, 1);
});

test('tick: a stored read that went missing is read again in full, token or not', async () => {
  const map = mapFor('bexar-tx');
  const routes = { '/127291/current_ver.txt': 'clarity-bexar.current_ver.txt', '/127291/379718/json/en/summary.json': 'clarity-bexar.summary.json', '/127291/379718/json/en/electionsettings.json': 'clarity-bexar.electionsettings.json' };
  const store = memStore();
  await runTick({ fetch: fakeFetch(routes), store, archive: null, maps: [map], now: '2026-11-03T22:00:00.000Z' });
  await store.delete('src:bexar-tx');
  const sched = JSON.parse(await store.get('sched:2026-11-03'));
  sched.sources['bexar-tx'].next_due = null;
  await store.put('sched:2026-11-03', JSON.stringify(sched));
  await runTick({ fetch: fakeFetch(routes), store, archive: null, maps: [map], now: '2026-11-03T22:05:00.000Z' });
  assert.ok(JSON.parse(await store.get('src:bexar-tx')).read, 'the read is back');
});

test('tick: a cut-off page keeps the last good numbers for the races it dropped, marked with their update', async () => {
  const { fixture } = await import('./helpers.mjs');
  const map = { id: 'results-TX', state: 'TX', name: 'Texas Secretary of State', county: 'Texas', scope: 'state', election: { date: '2026-11-03', feed_election_id: '2026 NOVEMBER GENERAL ELECTION', feed_name: '2026 NOVEMBER GENERAL ELECTION' }, feed: { adapter: 'tx_sos', base: 'https://electionresults.sos.state.tx.us', results_url: 'https://electionresults.sos.state.tx.us/results.html', tz: 'America/Chicago' },
    contests: [{ feed_id: 'U. S. SENATOR', feed_name: 'U. S. SENATOR', item: 'tx-us-senate', kind: 'plurality', seats: 1, whole: true, reaches: ['Texas'], choices: { 'KEN PAXTON': 'Ken Paxton', 'JAMES TALARICO': 'James Talarico', 'TED BROWN': 'Ted Brown', 'AVERY AYERS': 'Avery Ayers', 'JADE SIMMONS': 'Jade Simmons', "BRADFORD 'BRAD' HALL": "Bradford 'Brad' Hall", 'ZUL MOHAMED': 'Zul Mohamed' } }] };
  const full = fixture('tx-sos.results.html');
  const store = memStore();
  await runTick({ fetch: fakeFetch({ 'results.html': { status: 200, body: full, headers: { 'Last-Modified': 'A' } } }), store, archive: null, maps: [map], now: '2026-11-04T03:00:00.000Z' });
  // the next update cuts the page before the Senate (a later, shorter page with only House District 1)
  const cut = full.replace(/<div class="election">U\. S\. SENATOR[\s\S]*?<\/table><\/div>/, '').replace('08:56 PM', '09:12 PM');
  const out = await runTick({ fetch: fakeFetch({ 'results.html': { status: 200, body: cut, headers: { 'Last-Modified': 'B' } } }), store, archive: null, maps: [map], now: '2026-11-04T03:13:00.000Z' });
  assert.equal(out.ran[0].outcome, 'changed');
  const rec = JSON.parse(await store.get('src:results-TX'));
  const sen = rec.read.contests.find((c) => c.feed_id === 'U. S. SENATOR');
  assert.ok(sen, 'the Senate is kept');
  assert.match(sen.note, /cut off at its latest update, so these numbers are from its 8:56 PM update/);
  const pv = JSON.parse(await store.get('preview:TX'));
  assert.equal(pv.items['tx-us-senate'].candidates[0].votes, 3410265);
  assert.match(pv.items['tx-us-senate'].note, /8:56 PM/);
});

test('tick: a race carried through two cut-off reads keeps its own time; after three it is let go', async () => {
  const { fixture } = await import('./helpers.mjs');
  const map = { id: 'results-TX', state: 'TX', name: 'Texas Secretary of State', county: 'Texas', scope: 'state', election: { date: '2026-11-03', feed_election_id: '2026 NOVEMBER GENERAL ELECTION', feed_name: '2026 NOVEMBER GENERAL ELECTION' }, feed: { adapter: 'tx_sos', base: 'https://electionresults.sos.state.tx.us', results_url: 'https://electionresults.sos.state.tx.us/results.html', tz: 'America/Chicago' },
    contests: [{ feed_id: 'U. S. SENATOR', feed_name: 'U. S. SENATOR', item: 'tx-us-senate', kind: 'plurality', seats: 1, whole: true, reaches: ['Texas'], choices: { 'KEN PAXTON': 'Ken Paxton', 'JAMES TALARICO': 'James Talarico', 'TED BROWN': 'Ted Brown', 'AVERY AYERS': 'Avery Ayers', 'JADE SIMMONS': 'Jade Simmons', "BRADFORD 'BRAD' HALL": "Bradford 'Brad' Hall", 'ZUL MOHAMED': 'Zul Mohamed' } }] };
  const full = fixture('tx-sos.results.html');
  const noSenate = (t) => full.replace(/<div class="election">U\. S\. SENATOR[\s\S]*?<\/table><\/div>/, '').replace('08:56 PM', t);
  const store = memStore();
  const tick = (body, lm, now) => runTick({ fetch: fakeFetch({ 'results.html': { status: 200, body, headers: { 'Last-Modified': lm } } }), store, archive: null, maps: [map], now });
  await tick(full, 'A', '2026-11-04T03:00:00.000Z');
  const times = ['09:12 PM', '09:20 PM', '09:30 PM', '09:40 PM'];
  const seen = [];
  for (const [i, t] of times.entries()) {
    const out = await tick(noSenate(t), `B${i}`, `2026-11-04T03:${String(13 + i * 10).padStart(2, '0')}:00.000Z`);
    const pv = JSON.parse(await store.get('preview:TX'));
    seen.push({ item: pv.items['tx-us-senate'], error: out.ran[0].error });
  }
  for (const s of seen.slice(0, 3)) {
    assert.equal(s.item.updated, '2026-11-04T02:56:00.000Z', 'never re-timed to a newer page');
    assert.match(s.item.note, /from its 8:56 PM update/);
  }
  assert.notEqual(seen[3].item.status, 'counting', 'let go after three cut-off reads');
  assert.match(seen[3].error, /stopped carrying 1 race/);
});

test('tick: a stored read made by older adapter code is redone in full and replaced in place', async () => {
  const map = mapFor('bexar-tx');
  const routes = { '/127291/current_ver.txt': 'clarity-bexar.current_ver.txt', '/127291/379718/json/en/summary.json': 'clarity-bexar.summary.json', '/127291/379718/json/en/electionsettings.json': 'clarity-bexar.electionsettings.json' };
  const store = memStore();
  await runTick({ fetch: fakeFetch(routes), store, archive: null, maps: [map], now: '2026-11-03T22:00:00.000Z' });
  const rec = JSON.parse(await store.get('src:bexar-tx'));
  rec.read_version = 1; rec.read.contests[0].reporting = 'stale words';
  await store.put('src:bexar-tx', JSON.stringify(rec));
  const sched = JSON.parse(await store.get('sched:2026-11-03'));
  sched.sources['bexar-tx'].next_due = null;
  await store.put('sched:2026-11-03', JSON.stringify(sched));
  const out = await runTick({ fetch: fakeFetch(routes), store, archive: null, maps: [map], now: '2026-11-03T22:05:00.000Z' });
  assert.equal(out.ran[0].outcome, 'changed');
  assert.notEqual(JSON.parse(await store.get('src:bexar-tx')).read.contests[0].reporting, 'stale words');
});
