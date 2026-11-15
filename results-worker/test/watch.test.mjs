/* The outside watch's judgment and its tell-only-what-changed rules (bin/watch.mjs, Nov 4). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendTimeout, untell, NOTIFY_MS, SEND_MIN_MS } from '../bin/watch.mjs';
import { judgeFile, honestyProblems, diff, message, sends, runOrder, STATES, START_BY_MS, HONESTY_BY_MS, STOP_MS, LATE_MIN, REMIND_H } from '../bin/watch.mjs';

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

test('watch: this Mac\'s own trouble and every "Cleared" are quiet; a broken file is not (Nov 15)', () => {
  const ran = [{ key: 'DC|honesty-ran', hiccup: true, quiet: true, text: 'The honesty check on DC\'s file couldn\'t run: it didn\'t finish in 90 seconds', label: 'The honesty check on DC\'s file runs again.' }];
  const a = diff(diff(null, ran, T).state, ran, T + 600_000);
  assert.deepEqual([a.tell, a.quiet], [[ran[0].text], [ran[0].text]], 'the 4 AM timeout of Nov 15: told, but quiet');
  assert.ok(a.state.open['DC|honesty-ran'].quiet);
  const again = diff(a.state, ran, T + 600_000 + REMIND_H * 3600_000);
  assert.deepEqual(again.quiet, again.tell, 'its reminder is quiet too');
  const cleared = diff(a.state, [], T + 1_200_000);
  assert.deepEqual([cleared.tell, cleared.quiet], [['Cleared: The honesty check on DC\'s file runs again.'], ['Cleared: The honesty check on DC\'s file runs again.']]);
  const broke = diff(null, [{ key: 'PA|stale', text: 'PA stalled.', label: 'PA fresh.' }, { key: 'TX|honesty|x', text: 'TX broke a rule.' }], T);
  assert.deepEqual(broke.quiet, [], 'a stalled Worker and a broken rule reach him at once');
  const fixed = diff(broke.state, [], T + 600_000);
  assert.deepEqual(fixed.quiet, fixed.tell, 'their clears need nothing of him');
});

test('watch: with a quiet command, what reaches him goes first and the quiet lines after; without, one message as before', () => {
  const tell = ['PA stalled.', 'Cleared: DC runs again.', 'TX broke a rule.'];
  const quiet = ['Cleared: DC runs again.'];
  assert.deepEqual(sends(tell, quiet, 'now', 'later'), [['now', ['PA stalled.', 'TX broke a rule.'], false], ['later', ['Cleared: DC runs again.'], true]],
    'a slow or failed quiet send can never hold an urgent one back (review round 2)');
  assert.deepEqual(sends(tell, quiet, 'now', undefined), [['now', tell, false]], 'no quiet command: everything as before');
  assert.deepEqual(sends(quiet, quiet, 'now', 'later'), [['later', quiet, true]], 'only quiet lines: one send');
  assert.deepEqual(sends(['PA stalled.'], [], 'now', 'later'), [['now', ['PA stalled.'], false]]);
  assert.deepEqual(sends([], [], 'now', 'later'), []);
});

test('watch: a quiet send that failed after the urgent one went out retells only the quiet lines (review round 2)', () => {
  // The reviewer's case: a cleared notice and a new stalled-Worker alert in one run; the alert goes, the quiet send fails.
  const first = diff(null, [{ key: 'DC|honesty|x', text: 'DC broke a rule.', label: 'DC passes.' }], T).state;
  const run = diff(first, [{ key: 'PA|stale', text: 'PA stalled.', label: 'PA fresh.' }], T + 600_000);
  assert.deepEqual([run.tell, run.quiet, run.quietKeys], [['PA stalled.', 'Cleared: DC passes.'], ['Cleared: DC passes.'], ['DC|honesty|x']]);
  const saved = untell(run.state, first, run.quietKeys, T + 600_000);
  assert.ok(saved.open['PA|stale'], 'the alert that went out is kept as told');
  const next = diff(saved, [{ key: 'PA|stale', text: 'PA stalled.', label: 'PA fresh.' }], T + 1_200_000);
  assert.deepEqual(next.tell, ['Cleared: DC passes.'], 'the next run tells the clear again, and the alert not twice');
  // A new quiet problem whose send failed goes back to waiting, so the next run tells it rather than two runs on.
  const ran = [{ key: 'DC|honesty-ran', hiccup: true, quiet: true, text: 'DC check couldn\'t run.', label: 'DC check runs.' }];
  const w = diff(null, ran, T).state;
  const r = diff(w, ran, T + 600_000);
  const back = untell(r.state, w, r.quietKeys, T + 600_000);
  assert.deepEqual([back.open['DC|honesty-ran'], back.waiting['DC|honesty-ran']], [undefined, T]);
  assert.deepEqual(diff(back, ran, T + 1_200_000).tell, ['DC check couldn\'t run.']);
});

test('watch: the two sends share the notify step\'s one budget, so the step never runs past the 9-minute stop', () => {
  const by = T + NOTIFY_MS;
  assert.equal(sendTimeout(by, T), NOTIFY_MS, 'the first send may take all of it');
  assert.equal(sendTimeout(by, T + 50_000), 10_000, 'a first send that took 50 s leaves the second 10 s, not another 60');
  assert.equal(sendTimeout(by, by - SEND_MIN_MS), SEND_MIN_MS);
  assert.equal(sendTimeout(by, by - SEND_MIN_MS + 1), null, 'too little left: the second send waits for the next run');
  assert.equal(sendTimeout(by, by + 1), null);
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
  assert.ok(START_BY_MS + 55_000 + 90_000 + 60_000 + 10_000 <= STOP_MS, 'with 10 s spare for node and the save');
  assert.ok(HONESTY_BY_MS + 90_000 + 60_000 + 10_000 <= STOP_MS);
  assert.ok(START_BY_MS >= 5 * 60_000, 'still most of the run for checking');
});

test('watch: a state left out for time keeps its first hiccup, so two failed loads either side of it are still told', () => {
  const blip = [{ key: 'PA|unreachable', hiccup: true, text: 'PA didn\'t load.', label: 'PA loads.' }];
  const a = diff(null, blip, T, new Set(['PA']));
  const skippedRun = diff(a.state, [], T + 600_000, new Set(['PA']));
  assert.ok(skippedRun.state.waiting['PA|unreachable'], 'kept through the run that left PA out');
  assert.deepEqual(diff(skippedRun.state, blip, T + 1_200_000, new Set(['PA'])).tell, ['PA didn\'t load.']);
  assert.deepEqual(diff(a.state, [], T + 600_000).state.waiting, {}, 'a state that was checked and loaded drops it');
});

test('watch: a state whose honesty check was left out keeps only its honesty problems; a fresh file clears "stale"', () => {
  const prev = diff(null, [{ key: 'PA|stale', text: 'PA stale.', label: 'PA fresh.' }, { key: 'PA|honesty|x', text: 'PA broke a rule.', label: 'PA passes.' }], T).state;
  const r = diff(prev, [], T + 600_000, new Set(['PA|honesty']));
  assert.deepEqual(r.tell, ['Cleared: PA fresh.']);
  assert.ok(r.state.open['PA|honesty|x'], 'the honesty problem waits for a run that checks it');
});
