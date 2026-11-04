/* The pre-deploy review fixes (Nov 3, 2026, about 11:40 PM CT): worker-predeploy-review.json and worker-predeploy-codex.md
   in the workbench's claude-plans/2026-11-03-results. One test or more per finding, in the order they were fixed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, mapFor } from './helpers.mjs';
import * as clarity from '../src/adapters/clarity.js';
import * as nyc from '../src/adapters/nyc_enr.js';
import { checkFile } from '../src/checks.js';
import { sourceSlices, buildStateFile } from '../src/merge.js';

const route = (eid, ver, pre) => ({ [`/${eid}/current_ver.txt`]: `${pre}.current_ver.txt`, [`/${eid}/${ver}/json/en/summary.json`]: `${pre}.summary.json`, [`/${eid}/${ver}/json/en/electionsettings.json`]: `${pre}.electionsettings.json` });

test('Orange FL: over and under votes are votes for no one, so they are in no total and lower no percent', async () => {
  const map = mapFor('orange-fl');
  for (const c of map.contests) for (const [k, v] of Object.entries(c.choices)) if (/^(over|under) votes$/i.test(k)) assert.equal(v, '__skip', `${c.item} ${k}`);
  const r = await clarity.read({ fetch: fakeFetch(route('127356', '384974', 'clarity-orange')), map });
  const { raw, ...read } = r;
  const { slices } = sourceSlices(read, map, '2026-11-04T04:30:00.000Z');
  const mc = map.contests.find((c) => c.feed_name === 'County Mayor');
  const fc = read.contests.find((c) => c.feed_name === 'County Mayor');
  const cast = fc.choices.filter((c) => !/^(over|under) votes$/i.test(c.name)).reduce((a, c) => a + c.votes, 0);
  const s = slices[mc.item];
  assert.equal(s.total_votes, cast, 'the total is votes for candidates only');
  for (const k of s.candidates) assert.equal(k.pct, Math.round((k.votes / cast) * 10000) / 100, k.name);
  assert.ok(fc.choices.find((c) => c.name === 'Under Votes').votes > 0, 'the fixture really has under votes to leave out');
});

/* Two sources for one race: the state's whole count and a county's slice. */
const STATE_PA = { id: 'st', state: 'PA', name: 'Pennsylvania Department of State', county: 'Pennsylvania', scope: 'state', feed: { adapter: 'pa_dos', results_url: 'https://pa.example/', tz: 'America/New_York' },
  contests: [{ feed_id: 'HD10', feed_name: 'HD 10', item: 'pa-hd-10', kind: 'plurality', seats: 1, whole: true, reaches: ['Pennsylvania'], choices: { 'AMEN BROWN': 'Amen Brown' } }] };
const PHILLY = { id: 'ph', state: 'PA', name: 'Philadelphia County', county: 'Philadelphia', feed: { adapter: 'philadelphia', results_url: 'https://ph.example/', tz: 'America/New_York' },
  contests: [{ feed_id: '1', feed_name: 'HD 10', item: 'pa-hd-10', kind: 'plurality', seats: 1, reaches: ['Philadelphia', 'other counties'], choices: { 'AMEN BROWN DEM': 'Amen Brown', 'Write-In': '__other', 'Over Votes': '__skip' } }] };
const paRead = (feedId, choices) => ({ verdict: 'ok', election: { id: 'x', name: 'x', date: '2026-11-03' }, source_updated: '2026-11-04T04:00:00.000Z', reporting: null, contests: [{ feed_id: feedId, feed_name: 'HD 10', choices, reporting: null }] });
const both = (stateChoices, cityChoices) => buildStateFile({ state: 'PA', maps: [STATE_PA, PHILLY], mode: 'public', now: '2026-11-04T04:30:00.000Z',
  srcs: { st: { record: { read: paRead('HD10', stateChoices), fetched: '2026-11-04T04:30:00.000Z' }, checked: true, sched: {} }, ph: { record: { read: paRead('1', cityChoices), fetched: '2026-11-04T04:30:00.000Z' }, checked: true, sched: {} } } }).items['pa-hd-10'];

test('state behind note: a county\'s write-in, over and under lines the state leaves out never make the state "behind"', () => {
  // pa-hd-10 on Nov 3, 11:01 PM CT: the state's 16,696 equals Philadelphia's candidate votes; Philadelphia adds 197 write-ins.
  const x = both([{ name: 'AMEN BROWN', votes: 16696 }], [{ name: 'AMEN BROWN DEM', votes: 16696 }, { name: 'Write-In', votes: 197 }, { name: 'Over Votes', votes: 40 }]);
  assert.equal(x.source, 'st');
  assert.equal(x.note, undefined);
  assert.equal(x.county_slices[0].total_votes, 16893, 'the county slice still counts its write-ins');
  const y = both([{ name: 'AMEN BROWN', votes: 16000 }], [{ name: 'AMEN BROWN DEM', votes: 16696 }, { name: 'Write-In', votes: 197 }]);
  assert.equal(y.note, "The state's count is behind Philadelphia County's own count, which already has more votes.", 'a county truly ahead on candidate votes still says so');
});

const nycRoutes = () => {
  const r = { '/index.html': 'nyc.index.html' };
  for (const p of mapFor('results-NY-nyc').feed.pages) r[`/${p}`] = `nyc.${p}`;
  return r;
};

test('NYC: a race wholly inside the city is the whole race (no borough "missing") and can become official; a city portion stays a slice', async () => {
  const map = mapFor('results-NY-nyc');
  const r = await nyc.read({ fetch: fakeFetch(nycRoutes()), map });
  const { raw, ...read } = r;
  for (const official of [false, true]) {
    const f = buildStateFile({ state: 'NY', maps: [{ ...map, official: official ? { at: '2026-11-28' } : null }], srcs: { [map.id]: { record: { read, fetched: '2026-11-04T04:30:00.000Z' }, checked: true, sched: {} } }, mode: 'public', now: '2026-11-04T05:00:00.000Z' });
    assert.deepEqual(checkFile(f), []);
    for (const id of ['ny-ad-23', 'ny-us-house-12', 'nyc-council-3', 'nyc-proposal-1']) {
      const x = f.items[id];
      assert.equal(x.missing, undefined, id);
      assert.equal(x.slices, undefined, id);
      assert.equal(x.status, official ? 'official' : 'counting', id);
    }
    const ny3 = f.items['ny-us-house-3'];
    assert.deepEqual(ny3.missing, ['Nassau', 'other counties'], 'the part outside the city is the only part missing');
    assert.equal(ny3.status, 'counting');
    assert.equal(ny3.final, null);
  }
});

test('NYC: a contest the board marks as the city portion is never the whole race, even if a map says it is', async () => {
  const base = mapFor('results-NY-nyc');
  const map = { ...base, contests: base.contests.map((c) => (c.item === 'ny-us-house-3' ? { ...c, reaches: ['New York City'] } : c)) };
  const { raw, ...read } = await nyc.read({ fetch: fakeFetch(nycRoutes()), map });
  const f = buildStateFile({ state: 'NY', maps: [{ ...map, official: { at: '2026-11-28' } }], srcs: { [map.id]: { record: { read, fetched: '2026-11-04T04:30:00.000Z' }, checked: true, sched: {} } }, mode: 'public', now: '2026-11-04T05:00:00.000Z' });
  assert.deepEqual(f.items['ny-us-house-3'].missing, ['other counties']);
  assert.equal(f.items['ny-us-house-3'].final, null);
});
