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
