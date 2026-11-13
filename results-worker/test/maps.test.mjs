import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeFetch, fixture, mapFor, FIX } from './helpers.mjs';
import { ADAPTERS } from '../src/adapters/index.js';
import { sourceSlices, buildStateFile } from '../src/merge.js';
import { checkRead, checkFile } from '../src/checks.js';
import { MAPS } from '../src/maps.gen.js';

const FEEDS = {
  'dallas-county-tx': { '/127396/current_ver.txt': 'clarity-dallas.current_ver.txt', '/127396/382636/json/en/summary.json': 'clarity-dallas.summary.json', '/127396/382636/json/en/electionsettings.json': 'clarity-dallas.electionsettings.json' },
  'bexar-tx': { '/127291/current_ver.txt': 'clarity-bexar.current_ver.txt', '/127291/379718/json/en/summary.json': 'clarity-bexar.summary.json', '/127291/379718/json/en/electionsettings.json': 'clarity-bexar.electionsettings.json' },
  'harris-county-tx': { '/1126/resultsbyballot.json': 'harris.resultsbyballot.json' },
  'results-TX': { 'results.html': 'tx-sos.results.html' },
  'travis-tx': { '/127492/current_ver.txt': 'clarity-travis.current_ver.txt', '/127492/383226/json/en/summary.json': 'clarity-travis.summary.json', '/127492/383226/json/en/electionsettings.json': 'clarity-travis.electionsettings.json' },
  'williamson-tx': { '/127488/current_ver.txt': 'clarity-williamson.current_ver.txt', '/127488/383157/json/en/summary.json': 'clarity-williamson.summary.json', '/127488/383157/json/en/electionsettings.json': 'clarity-williamson.electionsettings.json' },
};

test('maps.gen.js matches maps/*.json, every map (run bin/map-check.mjs --write after editing a map)', () => {
  const ids = fs.readdirSync(path.join(FIX, '..', '..', 'maps')).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  assert.deepEqual(MAPS.map((m) => m.id).sort(), ids.sort());
  for (const id of ids) assert.deepEqual(MAPS.find((m) => m.id === id), mapFor(id), id);
});

/* src/merge.js builds a spanning race's missing list from county counts only, since a whole-race source's reaches lead
   with the state's own name ("California", "all 58 California counties"; statewide review, Nov 4). That is safe only
   while every county map that shares a race with a whole count names that race's counties itself or says "other
   counties"; otherwise, with the state's count unread or at zero, a county's share could pass as the whole race. */
test('a county map that shares a race with a whole-race count names its counties too, or says "other counties"', () => {
  const whole = {};
  for (const m of MAPS) for (const c of m.contests || []) if (c.whole) (whole[m.state] ??= {})[c.item] = { m, c };
  let shared = 0;
  for (const m of MAPS) {
    for (const c of m.contests || []) {
      const w = whole[m.state]?.[c.item];
      if (c.whole || !w || w.m.id === m.id) continue;
      shared++;
      if (c.reaches.includes('other counties')) continue;
      for (const k of w.c.reaches.filter((x) => x !== w.m.county)) assert.ok(c.reaches.includes(k), `${m.id} ${c.item}: ${w.m.id} says the race reaches ${k}; this map says only ${c.reaches.join(', ')}`);
    }
  }
  assert.ok(shared > 200, `${shared} shared races checked`);
});

for (const [id, routes] of Object.entries(FEEDS)) {
  test(`${id}: every mapped contest and choice is in the saved feed; the preview file is clean`, async () => {
    const map = mapFor(id);
    assert.ok(map.contests.length > 0);
    const r = await ADAPTERS[map.feed.adapter].read({ fetch: fakeFetch(routes), map });
    const { raw, ...read } = r;
    assert.equal(checkRead(read, map).ok, true);
    const { status, slices, problems } = sourceSlices(read, map, '2026-11-03T22:00:00.000Z');
    // A page served cut off (the Texas SOS snapshot) may miss mapped races; nothing else may go wrong.
    assert.deepEqual(problems.filter((p) => !(read.dropped > 0 && p.reason === 'contest missing')), []);
    const votes = read.contests.some((c) => c.choices.some((ch) => ch.votes > 0));
    assert.equal(status, votes ? 'counting' : 'pending');
    if (!read.dropped) assert.equal(Object.keys(slices).length, map.contests.length);
    const byId = new Map(read.contests.map((c) => [c.feed_id, c]));
    for (const mc of map.contests) for (const ch of byId.get(mc.feed_id)?.choices || []) assert.ok(ch.name in mc.choices, `${mc.feed_name}: ${ch.name}`);
    for (const s of Object.values(slices)) assert.equal(s.unmatched, undefined, 'no feed choice left unlisted');
    for (const s of Object.values(slices)) if (s.measure) assert.equal(s.measure.threshold, 50, 'every measure carries its threshold (simple majority tonight)');
    const f = buildStateFile({ state: 'TX', maps: [map], srcs: { [id]: { record: { read, fetched: '2026-11-03T22:00:00.000Z' }, checked: false, sched: {} } }, mode: 'preview', now: '2026-11-03T22:00:00.000Z' });
    assert.deepEqual(checkFile(f), []);
  });
}

test('Texas runoff-rule races never get a winner from us: Austin council, Austin ISD, appraisal districts and every local board', () => {
  const austin = mapFor('travis-tx').contests.filter((c) => /^tx-austin-council-(1|3|5|8|9)$/.test(c.item));
  assert.equal(austin.length, 5);
  const local = /^tx-(austin-council-|pflugerville-council-|aisd-|acc-|eaa-|[a-z]+isd-|[a-z]+cad-place-)/;
  for (const id of ['travis-tx', 'williamson-tx', 'bexar-tx', 'harris-county-tx', 'dallas-county-tx']) {
    for (const c of mapFor(id).contests.filter((x) => local.test(x.item) && x.kind !== 'measure')) {
      assert.equal(c.kind, 'rule_unknown', `${id} ${c.item}`);
      assert.equal(c.checked_kind, 'plurality', `${id} ${c.item}`);
      assert.ok(c.rule_note, `${id} ${c.item}`);
    }
  }
});

/* Colorado's state feed as a whole-race source (draft map, Nov 3): an amendment carries the inclusive 55% rule, and a
   county's count for the same race rides beneath the state's, never summed. */
test('results-CO: amendment threshold 55 inclusive; the state count is the item and a county count is a county slice', async () => {
  const base = mapFor('results-CO');
  const map = { ...base, contests: [
    { feed_id: '6000', feed_name: 'Amendment 81 (CONSTITUTIONAL)', item: 'co-amendment-81', kind: 'measure', seats: 1, choices: { 'Yes/For': 'yes', 'No/Against': 'no' }, reaches: ['Colorado'], whole: true, threshold: { pct: 55, inclusive: true }, pass_threshold: '55% (constitutional amendment that adds language)' },
    { feed_id: '7306', feed_name: 'City of Aurora Ballot Issue 3A', item: 'aurora-3a', kind: 'measure', seats: 1, choices: { 'Yes/For': 'yes', 'No/Against': 'no' }, reaches: ['Colorado'], whole: true, pass_threshold: 'simple majority' },
  ] };
  const r = await ADAPTERS.clarity.read({ fetch: fakeFetch({ '/127407/current_ver.txt': 'clarity-co-state.current_ver.txt', '/127407/385063/json/en/summary.json': 'clarity-co-state.summary.json', '/127407/385063/json/en/electionsettings.json': 'clarity-co-state.electionsettings.json' }), map });
  const { raw, ...read } = r;
  assert.equal(checkRead(read, map).ok, true);
  const { slices } = sourceSlices(read, map, '2026-11-04T04:30:00.000Z');
  assert.equal(slices['co-amendment-81'].measure.threshold, 55);
  const county = { id: 'arapahoe-test', state: 'CO', name: 'Arapahoe', county: 'Arapahoe', election: { date: '2026-11-03', feed_election_id: 'x' }, feed: { adapter: 'clarity', results_url: 'https://example.org/' }, contests: [{ feed_id: 'k', item: 'aurora-3a', kind: 'measure', choices: { Yes: 'yes', No: 'no' }, reaches: ['Arapahoe', 'Adams', 'Douglas'] }] };
  const countyRead = { verdict: 'ok', election: read.election, source_updated: '2026-11-04T03:35:06.000Z', reporting: null, contests: [{ feed_id: 'k', feed_name: 'Aurora 3A', choices: [{ name: 'Yes', votes: 31143 }, { name: 'No', votes: 45522 }], reporting: null }] };
  const f = buildStateFile({ state: 'CO', maps: [map, county], srcs: { 'results-CO': { record: { read, fetched: '2026-11-04T04:30:00.000Z' }, checked: true, sched: {} }, 'arapahoe-test': { record: { read: countyRead, fetched: '2026-11-04T04:30:00.000Z' }, checked: true, sched: {} } }, mode: 'preview', now: '2026-11-04T04:30:00.000Z' });
  const a = f.items['aurora-3a'];
  assert.equal(a.source, 'results-CO');
  assert.deepEqual([a.measure.yes, a.measure.no], [35386, 51662]);
  assert.equal(a.final, null);
  assert.equal(a.county_slices.length, 1);
  assert.equal(a.county_slices[0].measure.yes, 31143);
  assert.equal(a.slices, undefined);
  assert.deepEqual(checkFile(f), []);
});
