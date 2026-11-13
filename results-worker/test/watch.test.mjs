/* The outside watch's judgment and its tell-only-what-changed rules (bin/watch.mjs, Nov 4). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeFile, honestyProblems, diff, message, runOrder, STATES, START_BY_MS, HONESTY_BY_MS, STOP_MS, LATE_MIN, REMIND_H } from '../bin/watch.mjs';

const T = Date.parse('2026-11-04T23:00:00Z');
const iso = (minsFromNow) => new Date(T + minsFromNow * 60000).toISOString();
const file = (sources) => ({ generated: iso(-5), sources });

test('watch: stale follows the Worker\'s own plan (next_due), so quiet hours, slow polls and stopped sources are quiet', () => {
  assert.deepEqual(judgeFile('PA', file([{ id: 'a', status: 'counting', next_due: iso(5) }]), T), []);
  // Overnight quiet hours: last read hours ago, next read at 6 AM. Not stale.
  assert.deepEqual(judgeFile('GA', { generated: iso(-300), sources: [{ id: 'g', status: 'counting', next_due: iso(120) }] }, T), []);
  // Every source stopped or refused (no next_due): nothing is due, nothing is stale.
  assert.deepEqual(judgeFile('MD', file([{ id: 'b', status: 'link_only' }, { id: 'c', status: 'complete' }]), T), []);
  const late = judgeFile('PA', file([{ id: 'a', status: 'counting', next_due: iso(-(LATE_MIN + 5)) }, { id: 'b', status: 'counting', next_due: iso(30) }]), T);
  assert.equal(late.length, 1, 'the earliest planned read decides');
  assert.match(late[0].text, /Pennsylvania's results file was due a fresh read 25 minutes ago/);
  assert.deepEqual(judgeFile('PA', file([{ id: 'a', status: 'counting', next_due: iso(-(LATE_MIN - 5)) }]), T), [], 'a few minutes late is a busy tick, not a stall');
  assert.equal(judgeFile('TX', { sources: [] }, T)[0].key, 'TX|no-time');
});

test('watch: only the PROBLEMS list counts; falling-total notes are the Worker\'s to ping; two races stay two problems', () => {
  const out = 'url: generated ...\nitems 48: counting 48\nPROBLEMS (3):\n  pa-hd-10: falling-total note: The source\'s total fell from 16,893 to 3,722\n  pa-hd-19: final on a counting count\n  pa-hd-20: final on a counting count';
  const p = honestyProblems('PA', out);
  assert.equal(p.length, 2);
  assert.notEqual(p[0].key, p[1].key, 'pa-hd-19 and pa-hd-20 are different races');
  assert.match(p[0].text, /Pennsylvania's results file failed an honesty check: pa-hd-19: final on a counting count/);
  assert.match(p[0].label, /pa-hd-19 passes its honesty check again/);
  assert.deepEqual(honestyProblems('PA', 'honesty checks: clean'), null, 'no list: nothing to read (the caller decides if the check ran)');
  assert.deepEqual(honestyProblems('PA', 'x\nPROBLEMS (1):\n  pa-hd-10: falling-total note: fell'), []);
  // Counts after the id don't make a new problem each run.
  const a = honestyProblems('TX', 'PROBLEMS (1):\n  tx-1: total 1,234 off')[0].key;
  assert.equal(a, honestyProblems('TX', 'PROBLEMS (1):\n  tx-1: total 1,240 off')[0].key);
  // A crash's stack lines are not problems.
  assert.equal(honestyProblems('TX', 'TypeError: fetch failed\n  [cause]: Error: connect\n  }'), null);
});

test('watch: tells a new problem once, again every REMIND_H hours, and a short line when it clears', () => {
  const p = [{ key: 'PA|stale', text: 'Pennsylvania stalled for 25 minutes.', label: 'Pennsylvania is being rebuilt again.' }];
  const a = diff(null, p, T);
  assert.deepEqual(a.tell, ['Pennsylvania stalled for 25 minutes.']);
  assert.deepEqual(diff(a.state, p, T + 10 * 60000).tell, [], 'a quiet run posts nothing');
  const c = diff(a.state, p, T + REMIND_H * 3600_000);
  assert.match(c.tell[0], /^Still open since Nov 4, 5:00 PM CT: Pennsylvania stalled/);
  const d = diff(c.state, [], T + REMIND_H * 3600_000 + 60000);
  assert.deepEqual(d.tell, ['Cleared: Pennsylvania is being rebuilt again.']);
  assert.deepEqual(diff(d.state, [], T + REMIND_H * 3600_000 + 120000).tell, []);
});

test('watch: a state it couldn\'t judge keeps its open problems; a hiccup is told only on the second run in a row', () => {
  const open = diff(null, [{ key: 'PA|honesty|x', text: 'PA broke a rule.', label: 'PA passes.' }], T).state;
  const blip = [{ key: 'PA|unreachable', hiccup: true, text: 'PA didn\'t load.', label: 'PA loads.' }];
  const b = diff(open, blip, T + 600_000, new Set(['PA']));
  assert.deepEqual(b.tell, [], 'one blip: nothing told, and the open honesty problem is not falsely cleared');
  assert.ok(b.state.open['PA|honesty|x']);
  const c = diff(b.state, blip, T + 1_200_000, new Set(['PA']));
  assert.deepEqual(c.tell, ['PA didn\'t load.'], 'twice in a row: told');
  const d = diff(c.state, [{ key: 'PA|honesty|x', text: 'PA broke a rule.' }], T + 1_800_000);
  assert.deepEqual(d.tell, ['Cleared: PA loads.']);
  const e = diff(b.state, [], T + 1_200_000);
  assert.deepEqual(e.tell, ['Cleared: PA passes.'], 'a blip that went away is never told');
});

test('watch: a long message is cut with a count of what was left out', () => {
  const m = message(Array.from({ length: 40 }, (_, i) => `Problem number ${i} with a fairly long description of what went wrong.`));
  assert.ok(m.length <= 1150);
  assert.match(m, /\(and \d+ more; ~\/\.vg-results-watch\/state\.json has them all\)$/);
});

test('watch: the states a run left out go first on the next run, so the same ones are never skipped every time', () => {
  assert.deepEqual(runOrder(STATES, null), STATES, 'a first run keeps the usual order');
  assert.deepEqual(runOrder(STATES, { skipped: [] }), STATES);
  const next = runOrder(STATES, { skipped: ['OR', 'WA'] });
  assert.deepEqual(next.slice(0, 2), ['OR', 'WA']);
  assert.deepEqual([...next].sort(), [...STATES].sort(), 'every state once');
  assert.deepEqual(runOrder(['TX', 'CO'], { skipped: ['WA', 'CO'] }), ['CO', 'TX'], 'only the states this run checks');
});

test('watch: a state started at the last moment still finishes, notify step included, inside the 9-minute stop', () => {
  // The slowest file read (20 s, 15 s, 20 s), honesty check (90 s) and notify step (60 s).
  assert.ok(START_BY_MS + 55_000 + 90_000 + 60_000 <= STOP_MS);
  assert.ok(HONESTY_BY_MS + 90_000 + 60_000 <= STOP_MS);
  assert.ok(START_BY_MS >= 5 * 60_000, 'still most of the run for checking');
});
