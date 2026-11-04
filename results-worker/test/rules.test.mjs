import test from 'node:test';
import assert from 'node:assert/strict';
import { outcomeFor, parseThreshold } from '../src/outcome.js';
import { nextEntry, dueSources, afterQuiet } from '../src/schedule.js';
import { buildStateFile } from '../src/merge.js';
import { validateResultsFile } from '../src/schema.js';
import { TEST_FILES } from '../static/test-files.js';
import { checkFile } from '../src/checks.js';

const c = (name, votes) => ({ name, votes, pct: 0 });

test('outcome: nothing while counting; plurality, ties, multi, measures, retention, spanning', () => {
  assert.equal(outcomeFor({ status: 'counting', kind: 'plurality', candidates: [c('A', 9), c('B', 1)] }), null);
  assert.deepEqual(outcomeFor({ status: 'complete', kind: 'plurality', candidates: [c('A', 9), c('B', 1)] }), { winners: ['A'] });
  assert.equal(outcomeFor({ status: 'complete', kind: 'plurality', candidates: [c('A', 5), c('B', 5)] }), null);
  assert.deepEqual(outcomeFor({ status: 'official', kind: 'multi', seats: 2, candidates: [c('A', 9), c('B', 7), c('C', 3)] }), { winners: ['A', 'B'] });
  assert.equal(outcomeFor({ status: 'official', kind: 'multi', seats: 2, candidates: [c('A', 9), c('B', 3), c('C', 3)] }), null);
  const th = parseThreshold('simple majority');
  assert.deepEqual(outcomeFor({ status: 'complete', kind: 'measure', measure: { yes: 51, no: 49 }, threshold: th }), { passed: true });
  assert.deepEqual(outcomeFor({ status: 'complete', kind: 'measure', measure: { yes: 50, no: 50 }, threshold: th }), { passed: false });
  // Florida 2024: 57% yes did not pass a 60% rule
  assert.deepEqual(outcomeFor({ status: 'complete', kind: 'measure', measure: { yes: 57, no: 43 }, threshold: parseThreshold('60%') }), { passed: false });
  assert.deepEqual(outcomeFor({ status: 'complete', kind: 'measure', measure: { yes: 60, no: 40 }, threshold: parseThreshold('at least 60%') }), { passed: true });
  assert.deepEqual(outcomeFor({ status: 'complete', kind: 'measure', measure: { yes: 60, no: 40 }, threshold: parseThreshold('60%') }), { passed: false }, 'inclusive only where the rule says at least');
  assert.equal(outcomeFor({ status: 'complete', kind: 'rcv', candidates: [c('A', 9)] }), null);
  assert.equal(outcomeFor({ status: 'complete', kind: 'plurality', candidates: [c('A', 9), c('B', 1)], spanning: true }), null);
  assert.deepEqual(outcomeFor({ status: 'complete', kind: 'plurality', candidates: [c('A', 9), c('B', 1)], declared: ['B'] }), { winners: ['B'] }, "the source's declared outcome first");
});

test('ladder: 1, 5, 15, 60 minutes; complete every 6 hours; official stops; refused stops', () => {
  const t0 = '2026-11-05T02:00:00.000Z';
  const at = (m) => new Date(Date.parse(t0) + m * 60000).toISOString();
  let e = nextEntry({}, { kind: 'ok', changed: true, status: 'counting' }, t0);
  assert.equal(e.next_due, at(1));
  for (let i = 1; i <= 3; i++) e = nextEntry(e, { kind: 'ok', changed: false, status: 'counting' }, at(i));
  assert.equal(e.next_due, at(3 + 5));
  e = nextEntry(e, { kind: 'ok', changed: false, status: 'counting' }, at(31));
  assert.equal(e.next_due, at(31 + 15));
  e = nextEntry(e, { kind: 'ok', changed: false, status: 'counting' }, at(121));
  assert.equal(e.next_due, at(121 + 60));
  e = nextEntry(e, { kind: 'ok', changed: true, status: 'complete' }, at(200));
  assert.equal(e.next_due, at(200 + 360));
  e = nextEntry(e, { kind: 'ok', changed: true, status: 'official' }, at(600));
  assert.equal(e.stopped, 'official');
  assert.equal(e.next_due, null);
  const r = nextEntry({}, { kind: 'refused', error: 'HTTP 403' }, t0);
  assert.equal(r.stopped, 'refused');
  assert.deepEqual(dueSources({ a: r, b: {} }, ['a', 'b'], t0), ['b']);
});

test('ladder: failures back off 1, 2, 5, 15, 60', () => {
  const t0 = '2026-11-04T02:00:00.000Z';
  let e = {};
  const waits = [];
  let t = t0;
  for (let i = 0; i < 6; i++) { e = nextEntry(e, { kind: 'error', error: 'x' }, t); waits.push((Date.parse(e.next_due) - Date.parse(t)) / 60000); t = e.next_due; }
  assert.deepEqual(waits, [1, 2, 5, 15, 60, 60]);
  assert.equal(e.failing_since, t0);
});

test('ladder: quiet hours from Nov 4, 6 AM local, unless changed in the last hour; never before the source says', () => {
  // Nov 5, 11:30 PM Central = Nov 6 05:30Z: pushed to 6 AM Central (12:00Z)
  assert.equal(afterQuiet('2026-11-06T05:30:00.000Z', { last_change: '2026-11-05T12:00:00.000Z' }, 'America/Chicago'), '2026-11-06T12:00:00.000Z');
  assert.equal(afterQuiet('2026-11-06T05:30:00.000Z', { last_change: '2026-11-06T05:00:00.000Z' }, 'America/Chicago'), '2026-11-06T05:30:00.000Z');
  // election night itself is never quiet
  assert.equal(afterQuiet('2026-11-04T06:30:00.000Z', {}, 'America/Chicago'), '2026-11-04T06:30:00.000Z');
  const e = nextEntry({}, { kind: 'ok', changed: true, status: 'counting', sourceNext: '2026-11-04T02:30:00.000Z' }, '2026-11-04T02:00:00.000Z');
  assert.equal(e.next_due, '2026-11-04T02:30:00.000Z');
  // past certify_by + 3 days with no change: stops
  const s = nextEntry({}, { kind: 'ok', changed: false, status: 'counting' }, '2026-11-21T12:00:00.000Z', { certify_by: '2026-11-17' });
  assert.equal(s.stopped, 'past certification');
});

const MAP_A = { id: 'a-tx', state: 'TX', name: 'A County', county: 'A', feed: { adapter: 'clarity', results_url: 'https://a.example/', tz: 'America/Chicago' }, count_closes: '2026-11-04T23:00:00Z', complete_marker: { flag: 'final_flag' },
  contests: [
    { feed_id: '1', feed_name: 'Mayor', item: 'mayor', kind: 'plurality', seats: 1, choices: { 'SMITH, ANN': 'Ann Smith', 'JONES, BO': 'Bo Jones', 'Write-in': '__other', 'Cy Doe (W)': null }, reaches: ['A'] },
    { feed_id: '2', feed_name: 'Prop A', item: 'prop-a', kind: 'measure', seats: 1, threshold: { pct: 50, inclusive: false }, choices: { FOR: 'yes', AGAINST: 'no' }, reaches: ['A', 'B', 'C'] },
  ], unmatched_guide: ['council-1'] };
const MAP_B = { id: 'b-tx', state: 'TX', name: 'B County', county: 'B', feed: { adapter: 'clarity', results_url: 'https://b.example/', tz: 'America/Chicago' },
  contests: [{ feed_id: '9', feed_name: 'Prop A', item: 'prop-a', kind: 'measure', seats: 1, threshold: { pct: 50, inclusive: false }, choices: { YES: 'yes', NO: 'no' }, reaches: ['A', 'B', 'C'] }], unmatched_guide: [] };
const readOf = (contests, extra = {}) => ({ election: { date: '2026-11-03' }, source_updated: '2026-11-04T02:00:00.000Z', reporting: '1 of 2', contests, ...extra });

test('file: counting race, spanning measure never summed, unmatched and unchecked as links, schema clean', () => {
  const srcs = {
    'a-tx': { record: { read: readOf([{ feed_id: '1', feed_name: 'Mayor', reporting: '3 of 9 precincts reporting', choices: [{ name: 'SMITH, ANN', votes: 600 }, { name: 'JONES, BO', votes: 300 }, { name: 'Write-in', votes: 50 }, { name: 'Cy Doe (W)', votes: 50 }] }, { feed_id: '2', feed_name: 'Prop A', choices: [{ name: 'FOR', votes: 700 }, { name: 'AGAINST', votes: 300 }] }]), fetched: '2026-11-04T02:01:00.000Z' }, checked: true, sched: {} },
    'b-tx': { record: { read: readOf([{ feed_id: '9', feed_name: 'Prop A', choices: [{ name: 'YES', votes: 60 }, { name: 'NO', votes: 40 }] }]), fetched: '2026-11-04T02:01:00.000Z' }, checked: false, sched: {} },
  };
  const now = '2026-11-04T02:02:00.000Z';
  const pub = buildStateFile({ state: 'TX', maps: [MAP_A, MAP_B], srcs, mode: 'public', now });
  assert.deepEqual(checkFile(pub), []);
  const mayor = pub.items.mayor;
  assert.equal(mayor.status, 'counting');
  assert.equal(mayor.total_votes, 1000);
  assert.deepEqual(mayor.candidates, [{ name: 'Ann Smith', votes: 600, pct: 60 }, { name: 'Bo Jones', votes: 300, pct: 30 }]);
  assert.deepEqual(mayor.unmatched, ['Cy Doe (W)'], 'a named choice not in the guide is listed, the write-in total is not');
  assert.equal(mayor.final, null);
  const prop = pub.items['prop-a'];
  assert.equal(prop.slices.length, 1, 'B is unchecked, so only A is shown publicly');
  assert.deepEqual(prop.missing, ['B', 'C']);
  assert.equal(prop.measure.yes, 700, 'never summed');
  assert.equal(pub.items['council-1'].status, 'link_only');
  assert.equal(pub.items['council-1'].reason, 'not matched');
  assert.equal(pub.sources.find((s) => s.id === 'b-tx').status, 'link_only');

  const pv = buildStateFile({ state: 'TX', maps: [MAP_A, MAP_B], srcs, mode: 'preview', now });
  assert.deepEqual(checkFile(pv), []);
  assert.equal(pv.items['prop-a'].slices.length, 2);
  assert.deepEqual(pv.items['prop-a'].missing, ['C']);
  assert.equal(pv.items['prop-a'].source, 'a-tx', 'the largest slice on top');
  const withNote = buildStateFile({ state: 'TX', maps: [{ ...MAP_A, contests: MAP_A.contests.map((c) => (c.item === 'mayor' ? { ...c, reaches: ['A', 'other counties'], note: 'Write-in candidates are counted together.' } : c)) }], srcs, mode: 'preview', now });
  assert.equal(withNote.items.mayor.note, 'Write-in candidates are counted together.', 'a spanning race keeps its note');
  assert.deepEqual(withNote.items.mayor.unmatched, ['Cy Doe (W)']);
});

test('file: complete only after the count window closes, and an outcome only then', () => {
  const read = readOf([{ feed_id: '1', feed_name: 'Mayor', choices: [{ name: 'SMITH, ANN', votes: 600 }, { name: 'JONES, BO', votes: 400 }, { name: 'Write-in', votes: 0 }, { name: 'Cy Doe (W)', votes: 0 }] }, { feed_id: '2', feed_name: 'Prop A', choices: [{ name: 'FOR', votes: 7 }, { name: 'AGAINST', votes: 3 }] }], { source_status: 'final_flag' });
  const srcs = { 'a-tx': { record: { read, fetched: '2026-11-04T06:00:00.000Z' }, checked: true, sched: {} } };
  let f = buildStateFile({ state: 'TX', maps: [MAP_A], srcs, mode: 'public', now: '2026-11-04T06:00:00.000Z' });
  assert.equal(f.items.mayor.status, 'counting', 'final flag before Nov 4, 5 PM CT is still counting');
  assert.equal(f.items.mayor.final, null);
  f = buildStateFile({ state: 'TX', maps: [MAP_A], srcs, mode: 'public', now: '2026-11-05T00:00:00.000Z' });
  assert.equal(f.items.mayor.status, 'complete');
  assert.deepEqual(f.items.mayor.final, { winners: ['Ann Smith'] });
  assert.equal(f.items['prop-a'].final, null, 'a race spanning counties never gets an outcome from us');
  assert.deepEqual(checkFile(f), []);
});

test('the hand-written test file passes the schema', () => {
  assert.deepEqual(validateResultsFile(TEST_FILES.TX), []);
  assert.deepEqual(checkFile(TEST_FILES.TX), []);
});

test('ladder: never past the polls closing before numbers; every minute after it while nothing is posted', () => {
  const map = { polls_close: '2026-11-04T01:00:00Z' };
  let e = { status: 'pending', last_change: '2026-11-03T20:00:00.000Z', unchanged_polls: 40 };
  e = nextEntry(e, { kind: 'ok', changed: false, status: 'pending' }, '2026-11-04T00:30:00.000Z', map);
  assert.equal(e.next_due, '2026-11-04T01:00:00.000Z');
  e = nextEntry(e, { kind: 'ok', changed: false, status: 'pending' }, '2026-11-04T01:00:00.000Z', map);
  assert.equal(e.next_due, '2026-11-04T01:01:00.000Z');
});

test('a placeholder precinct count (0 of N) with votes posted is counting, and keeps the source words', () => {
  const read = readOf([{ feed_id: '1', feed_name: 'Mayor', reporting: '0 of 437 precincts reporting', choices: [{ name: 'SMITH, ANN', votes: 60 }, { name: 'JONES, BO', votes: 40 }, { name: 'Write-in', votes: 0 }, { name: 'Cy Doe (W)', votes: 0 }] }, { feed_id: '2', feed_name: 'Prop A', reporting: '437 of 437 precincts reporting', choices: [{ name: 'FOR', votes: 1 }, { name: 'AGAINST', votes: 1 }] }]);
  const f = buildStateFile({ state: 'TX', maps: [MAP_A], srcs: { 'a-tx': { record: { read, fetched: '2026-11-04T02:00:00.000Z' }, checked: true, sched: {} } }, mode: 'public', now: '2026-11-04T02:00:00.000Z' });
  assert.equal(f.items.mayor.status, 'counting');
  assert.equal(f.items.mayor.reporting, '0 of 437 precincts reporting');
  assert.equal(f.items['prop-a'].status, 'counting', 'every precinct in is still not complete without the source\'s own marker');
});

test('outcome: none while an unmatched name holds votes, or when the write-in line could reach the winner', () => {
  const done = { status: 'complete', kind: 'plurality', candidates: [c('A', 60), c('B', 30)] };
  assert.deepEqual(outcomeFor(done), { winners: ['A'] });
  assert.equal(outcomeFor({ ...done, unmatchedVotes: 1 }), null);
  assert.equal(outcomeFor({ ...done, otherVotes: 60 }), null);
  assert.deepEqual(outcomeFor({ ...done, otherVotes: 5 }), { winners: ['A'] });
  assert.equal(outcomeFor({ status: 'complete', kind: 'measure', measure: { yes: 60, no: 40 }, threshold: { pct: 50, inclusive: false }, unmatchedVotes: 3 }), null);
});

test('file: an unmatched leader never gets a final; a race with no reaches is one county\'s slice', () => {
  const read = readOf([{ feed_id: '1', feed_name: 'Mayor', choices: [{ name: 'SMITH, ANN', votes: 300 }, { name: 'JONES, BO', votes: 200 }, { name: 'Write-in', votes: 0 }, { name: 'Cy Doe (W)', votes: 900 }] }, { feed_id: '2', feed_name: 'Prop A', choices: [{ name: 'FOR', votes: 7 }, { name: 'AGAINST', votes: 3 }] }], { source_status: 'final_flag' });
  const srcs = { 'a-tx': { record: { read, fetched: '2026-11-05T00:00:00.000Z' }, checked: true, sched: {} } };
  const f = buildStateFile({ state: 'TX', maps: [MAP_A], srcs, mode: 'public', now: '2026-11-05T00:00:00.000Z' });
  assert.equal(f.items.mayor.status, 'complete');
  assert.equal(f.items.mayor.final, null, 'Cy Doe leads and is not a guide candidate');
  const noReach = { ...MAP_A, contests: MAP_A.contests.map((x) => (x.item === 'mayor' ? { ...x, reaches: undefined } : x)) };
  const g = buildStateFile({ state: 'TX', maps: [noReach], srcs, mode: 'public', now: '2026-11-05T00:00:00.000Z' });
  assert.deepEqual(g.items.mayor.missing, ['other counties']);
  assert.equal(g.items.mayor.slices.length, 1);
  assert.equal(g.items.mayor.status, 'counting', 'never complete while a part is missing');
  assert.equal(g.items.mayor.final, null);
});

test('ladder: before the count window closes, a failing source waits at most 5 minutes', () => {
  let e = {};
  let t = '2026-11-04T02:00:00.000Z';
  const waits = [];
  for (let i = 0; i < 6; i++) { e = nextEntry(e, { kind: 'error', error: 'HTTP 502' }, t, { count_closes: '2026-11-04T23:00:00Z' }); waits.push((Date.parse(e.next_due) - Date.parse(t)) / 60000); t = e.next_due; }
  assert.deepEqual(waits, [1, 2, 5, 5, 5, 5]);
});

test('file: a whole-race source is the item; county counts ride beneath as county_slices, never summed', () => {
  const STATE = { id: 'st', state: 'TX', name: 'Secretary of State', county: 'Texas', scope: 'state', feed: { adapter: 'tx_sos', results_url: 'https://sos.example/', tz: 'America/Chicago' },
    contests: [{ feed_id: 'MAYOR', feed_name: 'MAYOR', item: 'mayor', kind: 'plurality', seats: 1, whole: true, reaches: ['Texas'], choices: { 'ANN SMITH': 'Ann Smith', 'BO JONES': 'Bo Jones' } }] };
  const srcs = {
    st: { record: { read: readOf([{ feed_id: 'MAYOR', feed_name: 'MAYOR', reporting: 'Polling Locations Reporting: 11%', choices: [{ name: 'ANN SMITH', votes: 5000 }, { name: 'BO JONES', votes: 4000 }] }]), fetched: '2026-11-04T02:00:00.000Z' }, checked: true, sched: {} },
    'a-tx': { record: { read: readOf([{ feed_id: '1', feed_name: 'Mayor', choices: [{ name: 'SMITH, ANN', votes: 600 }, { name: 'JONES, BO', votes: 300 }, { name: 'Write-in', votes: 0 }, { name: 'Cy Doe (W)', votes: 0 }] }, { feed_id: '2', feed_name: 'Prop A', choices: [{ name: 'FOR', votes: 1 }, { name: 'AGAINST', votes: 1 }] }]), fetched: '2026-11-04T02:00:00.000Z' }, checked: true, sched: {} },
  };
  const f = buildStateFile({ state: 'TX', maps: [STATE, MAP_A], srcs, mode: 'public', now: '2026-11-04T02:00:00.000Z' });
  const x = f.items.mayor;
  assert.equal(x.source, 'st');
  assert.equal(x.total_votes, 9000, 'the state count, not 9000 + 900');
  assert.equal(x.reporting, 'Polling Locations Reporting: 11%');
  assert.equal(x.slices, undefined);
  assert.equal(x.county_slices.length, 1);
  assert.equal(x.county_slices[0].total_votes, 900);
  assert.deepEqual(checkFile(f), []);
});

test('file: a whole-race count of zero, or an emptied race, never hides county numbers', () => {
  const STATE = { id: 'st', state: 'TX', name: 'Secretary of State', county: 'Texas', scope: 'state', feed: { adapter: 'tx_sos', results_url: 'https://sos.example/', tz: 'America/Chicago' },
    contests: [{ feed_id: 'MAYOR', feed_name: 'MAYOR', item: 'mayor', kind: 'plurality', seats: 1, whole: true, reaches: ['Texas'], choices: { 'ANN SMITH': 'Ann Smith', 'BO JONES': 'Bo Jones' } }] };
  const county = { record: { read: readOf([{ feed_id: '1', feed_name: 'Mayor', choices: [{ name: 'SMITH, ANN', votes: 600 }, { name: 'JONES, BO', votes: 300 }, { name: 'Write-in', votes: 0 }, { name: 'Cy Doe (W)', votes: 100 }] }, { feed_id: '2', feed_name: 'Prop A', choices: [{ name: 'FOR', votes: 1 }, { name: 'AGAINST', votes: 1 }] }]), fetched: '2026-11-04T02:00:00.000Z' }, checked: true, sched: {} };
  for (const choices of [[{ name: 'ANN SMITH', votes: 0 }, { name: 'BO JONES', votes: 0 }], []]) {
    const srcs = { st: { record: { read: readOf([{ feed_id: 'MAYOR', feed_name: 'MAYOR', choices }]), fetched: '2026-11-04T02:00:00.000Z' }, checked: true, sched: {} }, 'a-tx': county };
    const f = buildStateFile({ state: 'TX', maps: [STATE, MAP_A], srcs, mode: 'public', now: '2026-11-04T02:00:00.000Z' });
    assert.equal(f.items.mayor.source, 'a-tx');
    assert.equal(f.items.mayor.total_votes, 1000);
  }
});

test('file: over and under votes (__skip) are neither counted nor named; ranked choice is marked', () => {
  const MAP = { id: 'dc', state: 'DC', name: 'DC Board', county: 'District of Columbia', scope: 'state', feed: { adapter: 'dc', results_url: 'https://dc.example/', tz: 'America/New_York' },
    contests: [{ feed_id: '5', feed_name: 'MAYOR', item: 'dc-mayor', kind: 'rcv', seats: 1, whole: true, reaches: ['District of Columbia'], choices: { 'DEM A B': 'A B', 'IND C D': 'C D', 'Write-in': '__other', 'OVER VOTES': '__skip', 'UNDER VOTES': '__skip' } }] };
  const read = readOf([{ feed_id: '5', feed_name: 'MAYOR', choices: [{ name: 'DEM A B', votes: 80 }, { name: 'IND C D', votes: 15 }, { name: 'Write-in', votes: 5 }, { name: 'OVER VOTES', votes: 40 }, { name: 'UNDER VOTES', votes: 900 }] }]);
  const f = buildStateFile({ state: 'DC', maps: [MAP], srcs: { dc: { record: { read, fetched: '2026-11-04T02:00:00.000Z' }, checked: true, sched: {} } }, mode: 'public', now: '2026-11-04T02:00:00.000Z' });
  const x = f.items['dc-mayor'];
  assert.equal(x.total_votes, 100);
  assert.deepEqual(x.candidates.map((c) => [c.name, c.pct]), [['A B', 80], ['C D', 15]]);
  assert.equal(x.unmatched, undefined);
  assert.equal(x.ranked_choice, true);
  assert.equal(x.final, null);
  assert.deepEqual(checkFile(f), []);
});

test('ladder: on election night itself a quiet source waits at most 5 minutes', () => {
  const map = { feed: { tz: 'America/Chicago' } };
  const e = nextEntry({ status: 'counting', last_change: '2026-11-04T01:00:00.000Z', unchanged_polls: 20 }, { kind: 'ok', changed: false, status: 'counting' }, '2026-11-04T03:50:00.000Z', map);
  assert.equal(e.next_due, '2026-11-04T03:55:00.000Z');
  const later = nextEntry({ status: 'counting', last_change: '2026-11-05T13:00:00.000Z', unchanged_polls: 20 }, { kind: 'ok', changed: false, status: 'counting' }, '2026-11-05T16:00:00.000Z', map);
  assert.equal(later.next_due, '2026-11-05T17:00:00.000Z', 'after election night the plan\'s hourly rung stands');
});
