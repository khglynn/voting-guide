/* Enhanced Voting (GA SOS, DeKalb, WA SOS, King, Sullivan NY), from reads saved on Nov 3, 2026 at about 10:20 PM CT.
   The fixtures are the live answers trimmed of per-vote-group splits, party colors and measure text. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, fixture, mapFor } from './helpers.mjs';
import * as ev from '../src/adapters/enhanced_voting.js';
import { NAMED_UA } from '../src/fetch.js';
import { checkRead } from '../src/checks.js';
import { sourceSlices, buildStateFile } from '../src/merge.js';
import { checkFile } from '../src/checks.js';

const FEEDS = { georgia: 'results-GA', dekalb: 'dekalb-ga', sullivan: 'results-NY-sullivan', washington: 'results-WA', king: 'king-county-wa' };
const routes = (n, extra = {}) => ({ ...extra, '/ballot-items': `ev-${n}.ballot-items.json`, [`/${mapFor(FEEDS[n]).election.feed_election_id}`]: `ev-${n}.election.json` });
const readOf = async (n, opts = {}) => { const f = fakeFetch(routes(n, opts.extra)); const r = await ev.read({ fetch: f, map: opts.map || mapFor(FEEDS[n]), prevToken: opts.prevToken }); return { r, f }; };
const contest = (r, name) => r.contests.find((c) => c.feed_name === name);

test('enhanced_voting: Georgia SOS reads as the Nov 3 election with 273 contests and per-contest progress', async () => {
  const { r, f } = await readOf('georgia');
  assert.equal(r.verdict, 'ok');
  assert.deepEqual(r.election, { id: '11032026GeneralAndSpecialElection', name: 'November 3, 2026 - General & Special Elections', date: '2026-11-03' });
  assert.equal(r.contests.length, 273);
  const senate = contest(r, 'US Senate');
  assert.deepEqual(senate.choices, [{ name: 'Mike Collins (Rep)', votes: 1654533 }, { name: 'Jon Ossoff (I) (Dem)', votes: 2370291 }]);
  assert.equal(senate.total, 1654533 + 2370291);
  assert.equal(senate.reporting, '159 of 159 counties reporting');
  assert.equal(senate.updated, '2026-11-04T04:10:18.165Z');
  // The election record claims nothing reported (ballotsCast 0, no precinct status), so the source line has no words.
  assert.equal(r.reporting, null);
  assert.equal(r.source_updated, '2026-11-04T04:10:18.165Z');
  assert.equal(r.official, false);
  assert.deepEqual(r.labels, ['Unofficial Results']);
  assert.deepEqual(contest(r, 'Proposed Constitutional Amendment 1').choices.map((c) => c.name), ['Yes', 'No']);
  assert.equal(r.changed_token, '30f00d01-f8d8-4735-990c-c41e6b72c01e|2026-11-04T04:10:18.165767Z');
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((c) => c.headers['User-Agent'] === NAMED_UA), 'every request names us');
  assert.equal(checkRead(r, mapFor('results-GA')).ok, true);
});

test('enhanced_voting: an unchanged publish costs one request', async () => {
  const { r, f } = await readOf('georgia', { prevToken: '30f00d01-f8d8-4735-990c-c41e6b72c01e|2026-11-04T04:10:18.165767Z' });
  assert.equal(r.unchanged, true);
  assert.equal(f.calls.length, 1);
});

test('enhanced_voting: DeKalb quotes its own reporting groups, and a vote-for-2 race is multi', async () => {
  const { r } = await readOf('dekalb');
  assert.equal(r.contests.length, 52);
  assert.equal(r.reporting, 'Partially Reported 191 of 191 precincts');
  assert.deepEqual(r.labels, ['Unofficial Results', 'Election Night Complete']);
  const doraville = contest(r, 'Spec City Council - District 2, Post 2 At Large - Doraville');
  assert.equal(doraville.reporting, 'Partially Reported 3 of 3 precincts');
  assert.deepEqual(doraville.choices.map((c) => c.name), ['Schuyler "Sky" Clark', 'Tammi Bailey Fults', 'Tom Hart', 'Brian Kyser', 'Angie Riley Tooley']);
  assert.equal(contest(r, 'DeKalb Co Soil and Water Conservation District Supervisor').vote_for, 2);
  assert.equal(checkRead(r, mapFor('dekalb-ga')).ok, true);
});

test('enhanced_voting: Sullivan NY adds a candidate\'s party lines together (fusion) and keeps each line', async () => {
  const { r } = await readOf('sullivan');
  assert.deepEqual(r.election, { id: 'GE2026', name: '2026 General Election', date: '2026-11-03' });
  assert.equal(r.reporting, 'Election Night Complete 96 of 96 election districts');
  const gov = contest(r, 'Governor and Lieutenant Governor');
  // DEM 10,085 + WOR 1,097; REP 11,573 + CON 1,366 + VAF 251.
  assert.deepEqual(gov.choices.map((c) => [c.name, c.votes]), [['Kathy C. Hochul and Adrienne E. Adams', 11182], ['Bruce A. Blakeman and Todd Hood', 13190], ['Write-in', 36]]);
  assert.deepEqual(gov.choices[1].lines, [{ party: 'REP', votes: 11573 }, { party: 'CON', votes: 1366 }, { party: 'VAF', votes: 251 }]);
  assert.equal(gov.note, ev.FUSION_NOTE);
  const callicoon = contest(r, 'Town of Callicoon Supervisor');
  // REP 676 + CON 135.
  assert.deepEqual(callicoon.choices, [{ name: 'Thomas R. Bose', votes: 811, lines: [{ party: 'REP', votes: 676 }, { party: 'CON', votes: 135 }] }, { name: 'Write-in', votes: 18 }]);
  assert.equal(callicoon.reporting, 'Election Night Complete 5 of 5 election districts');
  assert.equal(contest(r, 'Village of Woodridge Mayor').note, undefined, 'no fusion note where no name repeats');
  assert.ok(contest(r, 'Town of Callicoon Superintedent of Highways'), "the office's own spelling");
});

test('enhanced_voting: a fused line with a bad count is passed through so the number check refuses the read', () => {
  const opts = [{ name: [{ text: 'A B' }], voteCount: 5, party: { abbreviation: 'DEM' } }, { name: [{ text: 'A B' }], voteCount: null, party: { abbreviation: 'WOR' } }];
  const [c] = ev.combineLines(opts);
  assert.equal(c.votes, null);
});

test('enhanced_voting: Washington reads "Legislative" as vote for 1 and names each contest group', async () => {
  const { r } = await readOf('washington');
  assert.deepEqual(r.election, { id: '20261103', name: '2026 General', date: '2026-11-03' });
  assert.equal(r.contests.length, 173);
  const i645 = contest(r, 'Initiative Measure No. IP26-645');
  assert.equal(i645.category, 'State Measures');
  assert.equal(i645.is_measure, true);
  assert.deepEqual(i645.choices, [{ name: 'Yes', votes: 519652 }, { name: 'No', votes: 742291 }]);
  assert.equal(i645.reporting, '22 of 39 counties reporting');
  assert.ok(r.contests.every((c) => Number.isInteger(c.vote_for) && c.vote_for >= 1));
  // The office's message runs long (maps and links), so only the short status label rides along.
  assert.deepEqual(r.labels, ['Unofficial Results']);
});

test('enhanced_voting: King County gives no progress counts and a next update time', async () => {
  const { r } = await readOf('king');
  assert.equal(r.contests.length, 115);
  assert.ok(r.contests.every((c) => c.reporting === null), 'totalUnits 0 everywhere: no words, never "0 of 0"');
  assert.equal(r.next_update, '2026-11-05T00:00:00.000Z');
  assert.deepEqual(contest(r, 'City of Seattle - Council District No. 5').choices, [{ name: 'Nilu Jenks', votes: 15122 }, { name: 'Julie Kang', votes: 10626 }, { name: 'Write-in', votes: 109 }]);
  assert.equal(contest(r, 'City of Seattle - Proposition No. 1').category, 'City');
});

test('enhanced_voting: progress words never say "0 of N" beside counted votes', () => {
  assert.equal(ev.progressWords({ reportingUnits: 0, totalUnits: 1 }, 'counties', true), null);
  assert.equal(ev.progressWords({ reportingUnits: 0, totalUnits: 1 }, 'counties', false), '0 of 1 counties reporting');
  assert.equal(ev.progressWords({ reportingUnits: 0, totalUnits: 0, reportingStatusDetails: [{ groupName: [{ text: 'Fully Reported' }], reportingStatusClientTextKey: 'reporting-status-fully-reported', value: 0 }] }, 'precincts', true), null);
  const two = { totalUnits: 96, reportingStatusDetails: [
    { groupName: [{ text: 'Fully Reported' }], reportingStatusClientTextKey: 'reporting-status-fully-reported', value: 10 },
    { groupName: [{ text: 'Partially Reported' }], reportingStatusClientTextKey: 'reporting-status-partially-reported', value: 86 },
    { groupName: [{ text: 'Not Reported' }], reportingStatusClientTextKey: 'reporting-status-not-reported', value: 0 }] };
  assert.equal(ev.progressWords(two, 'election districts', true), 'Fully Reported 10 of 96 election districts, Partially Reported 86');
});

test('enhanced_voting: refused, a bot page, a short contest list, test data, and the wrong election', async () => {
  const map = mapFor('dekalb-ga');
  let r = await ev.read({ fetch: fakeFetch({ '/11032026': { status: 403, body: 'denied' } }), map });
  assert.equal(r.verdict, 'refused');
  r = await ev.read({ fetch: fakeFetch({ '/11032026': { status: 200, body: '<html>Just a moment...</html>' } }), map });
  assert.equal(r.verdict, 'refused');

  const items = JSON.parse(fixture('ev-dekalb.ballot-items.json'));
  const short = { ...items, data: items.data.slice(0, 10) };
  r = await ev.read({ fetch: fakeFetch({ '/ballot-items': { status: 200, body: JSON.stringify(short) }, '/11032026': 'ev-dekalb.election.json' }), map });
  assert.equal(r.verdict, 'error');
  assert.match(r.error, /10 of 52/);

  const testData = { ...JSON.parse(fixture('ev-dekalb.election.json')), isProduction: false };
  r = await ev.read({ fetch: fakeFetch({ '/11032026': { status: 200, body: JSON.stringify(testData) } }), map });
  assert.equal(r.verdict, 'error');

  const other = { ...items, data: items.data.map((c) => ({ ...c, publishPublicElectionId: '05192026GeneralPrimary' })) };
  r = await ev.read({ fetch: fakeFetch({ '/ballot-items': { status: 200, body: JSON.stringify(other) }, '/11032026': 'ev-dekalb.election.json' }), map });
  assert.equal(r.verdict, 'ok');
  const check = checkRead(r, map);
  assert.equal(check.sourceBlocked, true);
  assert.ok(check.problems.some((p) => p.reason === 'election mismatch'));
});

test('enhanced_voting: a hand map over Sullivan builds a clean preview file; fused lines count once per person', async () => {
  const { r } = await readOf('sullivan');
  const map = { ...mapFor('results-NY-sullivan'), contests: [
    { feed_id: contest(r, 'Town of Callicoon Supervisor').feed_id, feed_name: 'Town of Callicoon Supervisor', item: 't-sup', kind: 'plurality', seats: 1, choices: { 'Thomas R. Bose': 'Thomas R. Bose', 'Write-in': '__other' }, reaches: ['Sullivan'], item_url: null },
    { feed_id: contest(r, 'Representative in Congress 19th District').feed_id, feed_name: 'Representative in Congress 19th District', item: 't-cd19', kind: 'plurality', seats: 1, choices: Object.fromEntries(contest(r, 'Representative in Congress 19th District').choices.map((c) => [c.name, c.name === 'Write-in' ? '__other' : c.name])), reaches: ['Sullivan', 'other counties'], item_url: null },
  ] };
  const { raw, ...read } = r;
  const { status, slices, problems } = sourceSlices(read, map, '2026-11-04T04:30:00.000Z');
  assert.deepEqual(problems, []);
  assert.equal(status, 'counting');
  assert.deepEqual(slices['t-sup'].candidates, [{ name: 'Thomas R. Bose', votes: 811, pct: 97.83 }]);
  const names = slices['t-cd19'].candidates.map((c) => c.name);
  assert.equal(new Set(names).size, names.length, 'each person once');
  const f = buildStateFile({ state: 'NY', maps: [map], srcs: { [map.id]: { record: { read, fetched: '2026-11-04T04:30:00.000Z' }, checked: false, sched: {} } }, mode: 'preview', now: '2026-11-04T04:30:00.000Z' });
  assert.deepEqual(checkFile(f), []);
  assert.equal(f.items['t-sup'].final, null, 'counting: no outcome');
  assert.equal(f.items['t-cd19'].slices?.length ?? 1, 1);
  assert.deepEqual(f.sources[0].labels, ['Unofficial Results']);
  assert.equal(f.sources[0].feed_version, '081791bf-5b46-4b09-afb1-2092f76a22bd');
});

test('enhanced_voting: King\'s next update rides on its source entry', async () => {
  const { r } = await readOf('king');
  const { raw, ...read } = r;
  const map = mapFor('king-county-wa');
  const f = buildStateFile({ state: 'WA', maps: [map], srcs: { [map.id]: { record: { read, fetched: '2026-11-04T04:30:00.000Z' }, checked: false, sched: {} } }, mode: 'preview', now: '2026-11-04T04:30:00.000Z' });
  assert.equal(f.sources[0].next_update, '2026-11-05T00:00:00.000Z');
  assert.deepEqual(checkFile(f), []);
});
