/* The outside watch's judgment and its tell-only-what-changed rule (bin/watch.mjs, Nov 4). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeFile, honestyProblems, diff, STALE_MIN, REMIND_H } from '../bin/watch.mjs';

const T = Date.parse('2026-11-04T23:00:00Z');
const file = (minsOld, sources) => ({ generated: new Date(T - minsOld * 60000).toISOString(), sources });

test('watch: a stale file is a stalled Worker only while one of its sources still reads', () => {
  assert.deepEqual(judgeFile('PA', file(10, [{ id: 'a', status: 'counting' }]), T), []);
  const stale = judgeFile('PA', file(STALE_MIN + 5, [{ id: 'a', status: 'counting' }]), T);
  assert.equal(stale.length, 1);
  assert.match(stale[0].text, /Pennsylvania's results file hasn't been rebuilt for 80 minutes/);
  assert.deepEqual(judgeFile('MD', file(500, [{ id: 'b', status: 'link_only', failing_since: 'x', note: 'source refused us' }]), T), [], 'every source refused: nothing to rebuild');
  assert.equal(judgeFile('TX', { sources: [] }, T)[0].key, 'TX|no-time');
});

test('watch: honesty lines become problems; falling-total notes are the Worker\'s to ping', () => {
  const out = 'url: generated ...\nitems 48: counting 48\nPROBLEMS (2):\n  pa-hd-10: falling-total note: The source\'s total fell from 16,893 to 3,722\n  pa-governor: top-level numbers aren\'t the named slice\'s';
  const p = honestyProblems('PA', out);
  assert.equal(p.length, 1);
  assert.match(p[0].text, /Pennsylvania's results file failed an honesty check: pa-governor/);
  assert.equal(honestyProblems('PA', 'honesty checks: clean').length, 0);
  // Numbers in a line don't make a new problem each run.
  assert.equal(honestyProblems('TX', 'x\n  tx-1: total 1,234 off').at(0).key, honestyProblems('TX', 'x\n  tx-1: total 1,240 off').at(0).key);
});

test('watch: tells a new problem once, again every REMIND_H hours while open, and once when it clears', () => {
  const p = [{ key: 'PA|stale', text: 'Pennsylvania stalled.' }];
  const a = diff(null, p, T);
  assert.deepEqual(a.tell, ['Pennsylvania stalled.']);
  const b = diff(a.state, p, T + 10 * 60000);
  assert.deepEqual(b.tell, [], 'a quiet run posts nothing');
  const c = diff(b.state, p, T + REMIND_H * 3600_000);
  assert.equal(c.tell.length, 1);
  assert.match(c.tell[0], /^Still open since .* CT: Pennsylvania stalled\.$/);
  const d = diff(c.state, [], T + REMIND_H * 3600_000 + 60000);
  assert.deepEqual(d.tell, ['Cleared: Pennsylvania stalled.']);
  assert.deepEqual(d.state.open, {});
  assert.deepEqual(diff(d.state, [], T + REMIND_H * 3600_000 + 120000).tell, []);
});
