/* Reads made on the Air (src/relay.js, Nov 13): recorded there, replayed in the Worker, one writer per source. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, fixture, memStore, mapFor } from './helpers.mjs';
import { recordingFetch, replayFetch, answersProblem } from '../src/relay.js';
import { ADAPTERS } from '../src/adapters/index.js';
import { runTick, SCHED_KEY } from '../src/tick.js';

const LM = 'Wed, 04 Nov 2026 07:52:11 GMT';
const sdRoutes = { '/sandiegocaenr/25/summary_25.xml': { status: 200, body: fixture('lvt-sandiego.summary_25.xml'), headers: { 'Last-Modified': LM } } };
const map = mapFor('san-diego-county-ca');
const noFetch = async (u) => { throw new Error(`the cron fetched ${u}`); };
const sched = async (store) => JSON.parse(await store.get(SCHED_KEY)).sources[map.id];

/* What bin/feed.mjs does: the adapter read through a recording fetch, then the answers as JSON. */
async function airRead(routes = sdRoutes) {
  const rec = recordingFetch(fakeFetch(routes));
  const r = await ADAPTERS[map.feed.adapter].read({ fetch: rec, map });
  assert.equal(r.verdict, 'ok');
  return JSON.parse(JSON.stringify(rec.answers));
}
const refusedStore = () => memStore({ [SCHED_KEY]: JSON.stringify({ sources: { [map.id]: { stopped: 'refused', status: 'refused', refused_hash: 'x', last_run: '2026-11-05T00:00:00.000Z' } }, meta: {} }) });

test('a read from the Air publishes like a Worker read, and the cron leaves the source alone after it', async () => {
  const store = refusedStore();
  const answers = await airRead();
  assert.equal(answersProblem(answers), null);
  const out = await runTick({ fetch: replayFetch(answers), store, archive: null, maps: [map], only: map.id, fed: true, now: '2026-11-13T18:00:00.000Z' });
  assert.equal(out.ran[0].outcome, 'changed');
  assert.equal(out.entry.stopped, 'fed');
  assert.ok(out.entry.next_due, 'the Air paces itself by next_due');
  assert.equal(out.entry.refused_hash, undefined);
  const rec = JSON.parse(await store.get(`src:${map.id}`));
  assert.ok(rec.read.contests.length > 0);
  assert.ok(await store.get('preview:CA'));
  // The next cron tick, an hour on: the source is due by time but stopped, so nothing fetches it.
  const tick = await runTick({ fetch: noFetch, store, archive: null, maps: [map], now: '2026-11-13T19:00:00.000Z' });
  assert.equal(tick.ran.length, 0);
  assert.equal((await sched(store)).stopped, 'fed');
  // The same answers again: unchanged, still the Air's.
  const again = await runTick({ fetch: replayFetch(answers), store, archive: null, maps: [map], only: map.id, fed: true, now: '2026-11-13T19:15:00.000Z' });
  assert.equal(again.ran[0].outcome, 'unchanged');
  assert.equal(again.entry.stopped, 'fed');
});

test('an Air read missing an answer fails without touching the last good counts, and stays the Air\'s', async () => {
  const store = refusedStore();
  await runTick({ fetch: replayFetch(await airRead()), store, archive: null, maps: [map], only: map.id, fed: true, now: '2026-11-13T18:00:00.000Z' });
  const before = await store.get(`src:${map.id}`);
  const out = await runTick({ fetch: replayFetch([{ method: 'GET', url: 'https://example.org/other', status: 200, text: '' }]), store, archive: null, maps: [map], only: map.id, fed: true, now: '2026-11-13T18:20:00.000Z' });
  assert.equal(out.ran[0].outcome, 'error');
  assert.match(out.ran[0].error, /no answer for GET/);
  assert.equal(out.entry.stopped, 'fed');
  assert.equal(await store.get(`src:${map.id}`), before);
});

test('the stop flag stops reads from the Air too; ending one stops it for good, and the done line waits for it', async () => {
  const store = refusedStore();
  await store.put('stop', '1');
  const out = await runTick({ fetch: replayFetch(await airRead()), store, archive: null, maps: [map], only: map.id, fed: true });
  assert.equal(out.stopped, true);
  await store.delete('stop');
  await runTick({ fetch: replayFetch(await airRead()), store, archive: null, maps: [map], only: map.id, fed: true, now: '2026-11-13T18:00:00.000Z' });
  const pings = [];
  const ping = async (...a) => { pings.push(a.join(' ')); return true; };
  await runTick({ fetch: noFetch, store, archive: null, maps: [map], now: '2026-11-13T18:01:00.000Z', ping });
  assert.equal(pings.length, 0, 'a source the Air reads is not done');
  const end = await runTick({ fetch: noFetch, store, archive: null, maps: [map], only: map.id, fed: true, end: true, now: '2026-11-18T18:00:00.000Z' });
  assert.equal(end.entry.stopped, 'fed, ended');
  assert.ok(await store.get(`src:${map.id}`), 'its last counts stay');
  await runTick({ fetch: noFetch, store, archive: null, maps: [map], now: '2026-11-18T18:01:00.000Z', ping });
  assert.match(pings.join('\n'), /done/);
});

test('a good run by hand hands an Air source back to the Worker', async () => {
  const store = refusedStore();
  await runTick({ fetch: replayFetch(await airRead()), store, archive: null, maps: [map], only: map.id, fed: true, now: '2026-11-13T18:00:00.000Z' });
  const out = await runTick({ fetch: fakeFetch(sdRoutes), store, archive: null, maps: [map], only: map.id, now: '2026-11-13T18:30:00.000Z' });
  assert.equal(out.ran[0].outcome, 'unchanged');
  assert.equal((await sched(store)).stopped, undefined);
});

test('bodies that are not plain text travel as base64 and come back byte for byte', async () => {
  const bytes = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 0xff, 0xfe]);
  const rec = recordingFetch(fakeFetch({ '/gz': { status: 200, bytes, headers: { ETag: '"a"', 'Set-Cookie': 'no' } } }));
  await rec('https://example.org/gz');
  const [a] = JSON.parse(JSON.stringify(rec.answers));
  assert.equal(typeof a.b64, 'string');
  assert.deepEqual(a.headers, { etag: '"a"' }, 'only the headers fetch.js reads travel');
  const res = await replayFetch([a])('https://example.org/gz');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
  assert.equal(res.headers.get('etag'), '"a"');
});

test('answers of the wrong shape are turned away before anything reads them', () => {
  assert.match(answersProblem(null), /no answers/);
  assert.match(answersProblem([{ url: 'http://x', status: 200, text: '' }]), /https/);
  assert.match(answersProblem([{ url: 'https://x', status: 99, text: '' }]), /status/);
  assert.match(answersProblem([{ url: 'https://x', status: 200 }]), /body/);
  assert.match(answersProblem([{ url: 'https://x', status: 200, text: '', headers: { a: 1 } }]), /headers/);
});
