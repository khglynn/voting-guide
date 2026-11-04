/* The pre-deploy review fixes (Nov 3, 2026, about 11:40 PM CT): worker-predeploy-review.json and worker-predeploy-codex.md
   in the workbench's claude-plans/2026-11-03-results. One test or more per finding, in the order they were fixed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, fixture, mapFor } from './helpers.mjs';
import * as clarity from '../src/adapters/clarity.js';
import * as nyc from '../src/adapters/nyc_enr.js';
import * as multco from '../src/adapters/multco.js';
import * as ca_sos from '../src/adapters/ca_sos.js';
import * as lvt from '../src/adapters/lvt.js';
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

test('Portland: the county\'s ranked-choice report covers the whole city, so it is the whole race (no "Multnomah County count", nothing missing), still first choices with no outcome', () => {
  const map = mapFor('results-OR-multnomah');
  const ids = ['portland-auditor', 'portland-council-3', 'portland-council-4'];
  const contests = map.contests.filter((c) => ids.includes(c.item)).map((mc) => ({ feed_id: mc.feed_id, feed_name: mc.feed_name, reporting: null, updated: '2026-11-04T04:00:00.000Z', note: 'First choices only.',
    choices: Object.keys(mc.choices).map((name, i) => ({ name, votes: 1000 * (i + 1) })) }));
  const read = { verdict: 'ok', election: { id: map.election.feed_election_id, name: map.election.feed_name, date: '2026-11-03' }, source_updated: '2026-11-04T04:00:00.000Z', reporting: null, labels: [], contests };
  for (const official of [null, { at: '2026-11-30' }]) {
    const f = buildStateFile({ state: 'OR', maps: [{ ...map, official }], srcs: { [map.id]: { record: { read, fetched: '2026-11-04T04:30:00.000Z' }, checked: true, sched: {} } }, mode: 'public', now: '2026-11-04T04:30:00.000Z' });
    assert.deepEqual(checkFile(f), []);
    for (const id of ids) {
      const x = f.items[id];
      assert.equal(x.source, map.id, id);
      assert.equal(x.slices, undefined, id);
      assert.equal(x.missing, undefined, id);
      assert.equal(x.ranked_choice, true, id);
      assert.equal(x.final, null, `${id}: ranked choice never gets an outcome from us`);
      assert.equal(x.status, official ? 'official' : 'counting', id);
    }
  }
});

test('Multnomah: the ranked-choice note quotes the tabulation time, never the report\'s description', () => {
  // The header of City_of_Portland_Councilor_-_District_4, read Nov 3, 2026, 9:21 PM PT.
  const page = `<h1 id="report-title" class="h2">City of Portland Councilor - District 4 – Preliminary Results 1</h1>
          <p class="fst-italic fw-bold">3 Seats Up for Election</p>
          <p>
            Consolidated Multnomah County, Washington County, and Clackamas County Election Results
          </p>
        <p>November 03, 2026 06:56:26 PM</p>
        <p>Published: November 3, 2026 8:00 PM</p>
      </div>`;
  const rep = multco.parseReport(page);
  assert.equal(rep.tabulated, 'November 03, 2026 06:56:26 PM');
  assert.equal(rep.tabulated_at, '2026-11-04T02:56:26.000Z');
  assert.equal(rep.published_at, '2026-11-04T04:00:00.000Z');
  const none = multco.parseReport(page.replace('<p>November 03, 2026 06:56:26 PM</p>', ''));
  assert.equal(none.tabulated, null, 'no time paragraph: no time, not the description');
});

const sosRoutes = {
  '/returns/query?r=': 'ca-sos.query-statewide.json',
  '/returns/ballot-measures': 'ca-sos.ballot-measures.json',
  '/returns/board-of-equalization/district/all': 'ca-sos.boe-all.json',
  '/returns/us-rep/district/all': 'ca-sos.us-rep-all.json',
};
const withHouse = (edit) => { const j = JSON.parse(fixture('ca-sos.us-rep-all.json')); edit(Array.isArray(j) ? j : [j]); return { ...sosRoutes, '/returns/us-rep/district/all': { status: 200, body: JSON.stringify(j) } }; };

test('CA SOS: "0% (0 of N) precincts reporting" beside counted votes is left out; with no votes it stays', async () => {
  assert.equal(ca_sos.progress('0% (0 of 561) precincts reporting', 155542), null);
  assert.equal(ca_sos.progress('0% (0 of 561) precincts reporting', 0), '0% (0 of 561) precincts reporting');
  assert.equal(ca_sos.progress('24.1% (190 of 788) precincts reporting', 1000), '24.1% (190 of 788) precincts reporting');
  // The saved House file's second race reads "0% (0 of 453)"; give it mail votes, as CA-47 had at 9:03 PM PT.
  let title;
  const routes = withHouse((races) => { title = races[1].raceTitle.replace(/\s+/g, ' ').trim(); races[1].candidates[0].Votes = '155,542'; });
  const r = await ca_sos.read({ fetch: fakeFetch(routes), map: mapFor('results-CA') });
  assert.equal(r.contests.find((c) => c.feed_id === title).reporting, null);
  assert.equal(r.contests.find((c) => /\(0 of 299\)/.test(c.reporting || '')).total, 0, 'a race with no votes keeps its words');
  for (const c of r.contests) if (c.total > 0) assert.doesNotMatch(c.reporting || '', /\(0 of /, c.feed_id);
});

test('CA SOS: each race keeps its own time, and the source time is the newest', async () => {
  const routes = withHouse((races) => { races[0].ReportingTime = 'November 3, 2026, 8:30 p.m.'; });
  const r = await ca_sos.read({ fetch: fakeFetch(routes), map: mapFor('results-CA') });
  const house = JSON.parse(routes['/returns/us-rep/district/all'].body)[0];
  assert.equal(r.contests.find((c) => c.feed_id === house.raceTitle.replace(/\s+/g, ' ').trim()).updated, '2026-11-04T04:30:00.000Z');
  assert.equal(r.contests.find((c) => c.feed_id === 'Governor - Statewide Results').updated, '2026-11-04T04:15:00.000Z');
  assert.equal(r.source_updated, '2026-11-04T04:30:00.000Z');
});

test('CA SOS: a House race or measure that changes while the governor\'s line stays the same is read, not skipped', async () => {
  const first = await ca_sos.read({ fetch: fakeFetch(sosRoutes), map: mapFor('results-CA') });
  const routes = withHouse((races) => { races[0].candidates[0].Votes = String(Number(String(races[0].candidates[0].Votes).replace(/,/g, '')) + 1); });
  const r = await ca_sos.read({ fetch: fakeFetch(routes), map: mapFor('results-CA'), prevToken: first.changed_token });
  assert.equal(r.unchanged, undefined);
  assert.notEqual(r.changed_token, first.changed_token);
});

test('NYC: "Uncertified" is never official; only a label made of official words is', async () => {
  for (const s of ['UNCERTIFIED RESULTS', 'UNOFFICIAL ELECTION NIGHT RESULTS', 'UNOFFICIAL RESULTS', 'NOT CERTIFIED', 'CERTIFICATION PENDING', 'PRELIMINARY OFFICIAL RESULTS', '']) assert.equal(nyc.isOfficial(s), false, s);
  for (const s of ['CERTIFIED RESULTS', 'OFFICIAL RESULTS', 'OFFICIAL ELECTION RESULTS', 'Certified Results', 'FINAL CERTIFIED RESULTS']) assert.equal(nyc.isOfficial(s), true, s);
  const routes = (label) => ({ ...nycRoutes(), '/index.html': { status: 200, body: fixture('nyc.index.html').replace('UNOFFICIAL ELECTION NIGHT RESULTS', label) } });
  assert.equal((await nyc.read({ fetch: fakeFetch(routes('UNCERTIFIED RESULTS')), map: mapFor('results-NY-nyc') })).official, false);
  assert.equal((await nyc.read({ fetch: fakeFetch(routes('CERTIFIED RESULTS')), map: mapFor('results-NY-nyc') })).official, true);
  assert.equal((await nyc.read({ fetch: fakeFetch(nycRoutes()), map: mapFor('results-NY-nyc') })).official, false, "tonight's own label");
});

test('LVT: a summary file read mid-upload (no closing </NewDataSet>) is an error, never a race with its first candidates only', async () => {
  const LM = 'Wed, 04 Nov 2026 05:00:00 GMT';
  const full = fixture('lvt-sandiego.summary_25.xml');
  const cut = full.slice(0, full.indexOf('</Table>') + '</Table>'.length);
  const at = (body) => ({ '/sandiegocaenr/25/summary_25.xml': { status: 200, body, headers: { 'Last-Modified': LM } } });
  const r = await lvt.read({ fetch: fakeFetch(at(cut)), map: mapFor('san-diego-county-ca') });
  assert.equal(r.verdict, 'error');
  assert.match(r.error, /cut off/);
  assert.equal(r.changed_token, undefined, 'no token saved, so the next poll reads it again');
  assert.equal((await lvt.read({ fetch: fakeFetch(at(full)), map: mapFor('san-diego-county-ca') })).verdict, 'ok');
  assert.equal((await lvt.read({ fetch: fakeFetch(at(`${full}\r\n  `)), map: mapFor('san-diego-county-ca') })).verdict, 'ok', 'trailing whitespace is fine');
});
