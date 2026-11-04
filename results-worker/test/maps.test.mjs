import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, fixture, mapFor } from './helpers.mjs';
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

test('maps.gen.js matches maps/*.json (run bin/map-check.mjs --write after editing a map)', () => {
  for (const id of Object.keys(FEEDS)) assert.deepEqual(MAPS.find((m) => m.id === id), mapFor(id), id);
});

for (const [id, routes] of Object.entries(FEEDS)) {
  test(`${id}: every mapped contest and choice is in the saved feed; the preview file is clean`, async () => {
    const map = mapFor(id);
    assert.ok(map.contests.length > 0);
    const r = await ADAPTERS[map.feed.adapter].read({ fetch: fakeFetch(routes), map });
    const { raw, ...read } = r;
    assert.equal(checkRead(read, map).ok, true);
    const { status, slices, problems } = sourceSlices(read, map, '2026-11-03T22:00:00.000Z');
    assert.deepEqual(problems, []);
    const votes = read.contests.some((c) => c.choices.some((ch) => ch.votes > 0));
    assert.equal(status, votes ? 'counting' : 'pending');
    assert.equal(Object.keys(slices).length, map.contests.length);
    const byId = new Map(read.contests.map((c) => [c.feed_id, c]));
    for (const mc of map.contests) for (const ch of byId.get(mc.feed_id).choices) assert.ok(ch.name in mc.choices, `${mc.feed_name}: ${ch.name}`);
    for (const s of Object.values(slices)) assert.equal(s.unmatched, undefined, 'no feed choice left unlisted');
    for (const s of Object.values(slices)) if (s.measure) assert.equal(s.measure.threshold, 50, 'every measure carries its threshold (simple majority tonight)');
    const f = buildStateFile({ state: 'TX', maps: [map], srcs: { [id]: { record: { read, fetched: '2026-11-03T22:00:00.000Z' }, checked: false, sched: {} } }, mode: 'preview', now: '2026-11-03T22:00:00.000Z' });
    assert.deepEqual(checkFile(f), []);
  });
}
