/* The pre-deploy review fixes (Nov 3, 2026, about 11:40 PM CT): worker-predeploy-review.json and worker-predeploy-codex.md
   in the workbench's claude-plans/2026-11-03-results. One test or more per finding, in the order they were fixed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, mapFor } from './helpers.mjs';
import * as clarity from '../src/adapters/clarity.js';
import { sourceSlices } from '../src/merge.js';

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
