/* The Air's reader (bin/feed.mjs): its pace, its one telling of trouble, and its stops. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { afterPost, afterFail, SOURCES, START_BY_MS } from '../bin/feed.mjs';
import { mapFor } from './helpers.mjs';

const T = Date.parse('2026-11-13T18:00:00.000Z');
const H = 3_600_000;

test('the reader names the eight sources that refuse the Worker, and leaves time to finish a run', () => {
  assert.equal(SOURCES.length, 8);
  for (const id of SOURCES) assert.equal(mapFor(id).id, id);
  assert.ok(START_BY_MS > 60_000);
});

test('after a good post: the Worker\'s pace, never under 10 minutes; a failure told before is told as over', () => {
  let a = afterPost({}, { next_due: new Date(T + 60_000).toISOString(), last_change: new Date(T).toISOString() }, T);
  assert.equal(a.s.next, new Date(T + 10 * 60_000).toISOString());
  assert.equal(a.s.first_fed, new Date(T).toISOString());
  assert.equal(a.back, false);
  a = afterPost({ first_fed: 'x', fails: 4, told: 'y', failing_since: 'z' }, { next_due: new Date(T + 6 * H).toISOString() }, T);
  assert.equal(a.s.next, new Date(T + 6 * H).toISOString());
  assert.equal(a.back, true);
  assert.equal(a.s.fails, undefined);
  assert.equal(a.s.told, undefined);
});

test('five days with no new counts ends a source, counted from the Air\'s first read at the earliest', () => {
  const old = new Date(T - 8 * 24 * H).toISOString();
  // Counts last changed Nov 5, but the Air only started today: not ended.
  assert.equal(afterPost({}, { last_change: old }, T).s.ended, undefined);
  const first = new Date(T - 5 * 24 * H).toISOString();
  assert.equal(afterPost({ first_fed: first }, { last_change: old }, T).s.ended, 'five days with no new counts');
  assert.equal(afterPost({ first_fed: first }, { last_change: new Date(T - 2 * H).toISOString() }, T).s.ended, undefined);
  assert.equal(afterPost({}, { stopped: 'official' }, T).s.ended, 'official');
});

test('failures back off and are told once, after six hours', () => {
  let f = afterFail({}, 'HTTP 403', T);
  assert.equal(f.s.next, new Date(T + 15 * 60_000).toISOString());
  assert.equal(f.tell, false);
  f = afterFail(f.s, 'HTTP 403', T + 15 * 60_000);
  assert.equal(f.s.next, new Date(T + 45 * 60_000).toISOString());
  f = afterFail(f.s, 'HTTP 403', T + 6 * H);
  assert.equal(f.tell, true);
  assert.equal(f.s.next, new Date(T + 7 * H).toISOString());
  f = afterFail({ ...f.s, told: 'yes' }, 'HTTP 403', T + 7 * H);
  assert.equal(f.tell, false);
});
