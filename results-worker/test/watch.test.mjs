/* The outside watch's judgment and its tell-only-what-changed rules (bin/watch.mjs, Nov 4). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NOTIFY_MS, URGENT_SEND_MS, QUIET_SEND_MS } from '../bin/watch.mjs';
import { judgeFile, honestyProblems, diff, message, split, runOrder, STATES, START_BY_MS, HONESTY_BY_MS, STOP_MS, LATE_MIN, REMIND_H, quiet, QUIET_DAYS, mayStop } from '../bin/watch.mjs';

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
  assert.deepEqual([a.tell, a.hushed], [[ran[0].text], [ran[0].text]], 'the 4 AM timeout of Nov 15: told, but quiet');
  assert.ok(a.state.open['DC|honesty-ran'].quiet);
  const again = diff(a.state, ran, T + 600_000 + REMIND_H * 3600_000);
  assert.deepEqual(again.hushed, again.tell, 'its reminder is quiet too');
  const cleared = diff(a.state, [], T + 1_200_000);
  assert.deepEqual([cleared.tell, cleared.hushed], [['Cleared: The honesty check on DC\'s file runs again.'], ['Cleared: The honesty check on DC\'s file runs again.']]);
  const broke = diff(null, [{ key: 'PA|stale', text: 'PA stalled.', label: 'PA fresh.' }, { key: 'TX|honesty|x', text: 'TX broke a rule.' }], T);
  assert.deepEqual(broke.hushed, [], 'a stalled Worker and a broken rule reach him at once');
  const fixed = diff(broke.state, [], T + 600_000);
  assert.deepEqual(fixed.hushed, fixed.tell, 'their clears need nothing of him');
});

test('watch: with a quiet command, the hushed lines wait for it; without, everything is urgent, as before', () => {
  const tell = ['PA stalled.', 'Cleared: DC runs again.', 'TX broke a rule.'];
  const hushed = ['Cleared: DC runs again.'];
  assert.deepEqual(split(tell, hushed, 'later'), { urgent: ['PA stalled.', 'TX broke a rule.'], later: ['Cleared: DC runs again.'] });
  assert.deepEqual(split(tell, hushed, undefined), { urgent: tell, later: [] }, 'no quiet command: one message as before');
  assert.deepEqual(split(hushed, hushed, 'later'), { urgent: [], later: hushed });
});

test('watch: the two sends have fixed times that fit the run, the urgent one with its full minute (review round 3)', () => {
  assert.equal(URGENT_SEND_MS, 60_000);
  assert.equal(NOTIFY_MS, URGENT_SEND_MS + QUIET_SEND_MS);
  assert.ok(START_BY_MS + 55_000 + 90_000 + NOTIFY_MS + 10_000 <= STOP_MS, 'a state started last still ends, both sends included');
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

test('watch: stops after five days with no new results anywhere (Kevin, Nov 7), and only on a run that read every state', () => {
  const day = 86_400_000;
  const at = (daysAgo) => new Date(T - daysAgo * day).toISOString();
  const files = {
    TX: { sources: [{ id: 'bexar-tx', name: 'Bexar County', updated: at(6) }, { id: 'tx-sos', updated: null }] },
    CA: { sources: { 'results-CA': { id: 'results-CA', name: 'California Secretary of State', updated: at(QUIET_DAYS + 0.5) } } },
  };
  const q = quiet(files, T, true);
  assert.ok(q, 'nothing new for more than five days: stop');
  assert.equal(q.from, 'California Secretary of State (California)');
  assert.equal(q.newest, T - (QUIET_DAYS + 0.5) * day);
  assert.equal(quiet(files, T, false), null, 'a run that missed a state never stops the watch');
  files.CA.sources['results-CA'].updated = at(QUIET_DAYS - 1);
  assert.equal(quiet(files, T, true), null, 'one source counting within five days keeps it going');
  assert.equal(quiet({ TX: { sources: [{ id: 'x', updated: null }] } }, T, true), null, 'no source time at all: no judgment');
  assert.equal(quiet({}, T, true), null);
  // A time from the future (a source's clock wrong) doesn't count as new, nor does it hide an old one.
  assert.ok(quiet({ TX: { sources: [{ id: 'a', updated: at(-2) }, { id: 'b', updated: at(9) }] } }, T, true));
});

test('watch: the season stops only on a run of every state, and never while the Worker may have stopped (#149 review)', () => {
  assert.equal(mayStop(STATES, {}), true);
  assert.equal(mayStop(['TX'], {}), false, 'a run by hand with --states TX never ends the season');
  // Frozen times can be our own reading stalled, not the offices gone quiet: hold the stop while that is open.
  assert.equal(mayStop(STATES, { 'CA|stale': { since: T } }), false);
  assert.equal(mayStop(STATES, { 'CA|unreachable': { since: T }, 'PA|honesty|x': { since: T } }), true,
    'other open problems do not hold it');
});
