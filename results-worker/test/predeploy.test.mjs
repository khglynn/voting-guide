/* The pre-deploy review fixes (Nov 3, 2026, about 11:40 PM CT): worker-predeploy-review.json and worker-predeploy-codex.md
   in the workbench's claude-plans/2026-11-03-results. One test or more per finding, in the order they were fixed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, fixture, mapFor, memStore } from './helpers.mjs';
import * as clarity from '../src/adapters/clarity.js';
import * as nyc from '../src/adapters/nyc_enr.js';
import * as multco from '../src/adapters/multco.js';
import * as ca_sos from '../src/adapters/ca_sos.js';
import * as lvt from '../src/adapters/lvt.js';
import * as ev from '../src/adapters/enhanced_voting.js';
import * as orsos from '../src/adapters/or_sos.js';
import * as pa from '../src/adapters/pa_dos.js';
import { checkFile } from '../src/checks.js';
import { checkHash } from '../src/fingerprint.js';
import { runTick } from '../src/tick.js';
import { nextEntry, dueSources, clampElectionNight, previewFloor, TICK_LIMIT } from '../src/schedule.js';
import { MAPS } from '../src/maps.gen.js';
import { ADAPTERS } from '../src/adapters/index.js';
import { get } from '../src/fetch.js';
import { gzipSync } from 'node:zlib';
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

test('Enhanced Voting: a record newer than its ballot-items (a cached copy) keeps no token, and the source time is the contests\' own', async () => {
  const map = mapFor('results-GA');
  const rec = JSON.parse(fixture('ev-georgia.election.json'));
  const evRoutes = (record) => ({ '/ballot-items': 'ev-georgia.ballot-items.json', [`/${map.election.feed_election_id}`]: { status: 200, body: JSON.stringify(record) } });
  const newer = { ...rec, asOf: '2026-11-04T04:40:00.000Z', publishVersionId: 'next-publish' };
  const r = await ev.read({ fetch: fakeFetch(evRoutes(newer)), map });
  assert.equal(r.verdict, 'ok');
  assert.equal(r.changed_token, null, 'the next poll reads again in full');
  assert.equal(r.source_updated, '2026-11-04T04:10:18.165Z', "the contests' time, not the record's");
  const same = await ev.read({ fetch: fakeFetch(evRoutes(rec)), map });
  assert.equal(same.changed_token, '30f00d01-f8d8-4735-990c-c41e6b72c01e|2026-11-04T04:10:18.165767Z', 'record and contests agree: the token stands');
  // Washington, Nov 3: its contests were a minute newer than its record. Newer contests are never "behind".
  const wa = await ev.read({ fetch: fakeFetch({ '/ballot-items': 'ev-washington.ballot-items.json', [`/${mapFor('results-WA').election.feed_election_id}`]: 'ev-washington.election.json' }), map: mapFor('results-WA') });
  assert.ok(wa.changed_token);
});

const orRoutes = (fed = fixture('or-sos.fed.html')) => ({
  'type=FED': { status: 200, body: fed },
  'type=SWNON': 'or-sos.swnon.html',
  'type=HOUSE': (url, opts) => ({ status: 200, body: fixture(opts.method === 'POST' ? 'or-sos.house-31-60.html' : 'or-sos.house.html') }),
  'oregonvotes.gov/': 'or-sos.index.html',
});
const orMap = () => {
  const m = mapFor('results-OR');
  m.feed.pages = ['resultsSW.aspx?type=FED&map=CTY', 'resultsSW.aspx?type=SWNON&map=CTY', 'resultsSW.aspx?type=HOUSE&map=CTY', { page: 'resultsSW.aspx?type=HOUSE&map=CTY', post: { name: 'ctl00$MainContent$btnHouse4', value: '31 - 60' } }];
  return m;
};

test('Oregon SOS: a results page older than the home page (a cached copy) is an error, so its numbers are never kept under the new token', async () => {
  const ok = await orsos.read({ fetch: fakeFetch(orRoutes()), map: orMap() });
  assert.equal(ok.verdict, 'ok');
  const old = fixture('or-sos.fed.html').replace('11/3/2026 | 8:15 PM PT', '11/3/2026 | 8:00 PM PT');
  const r = await orsos.read({ fetch: fakeFetch(orRoutes(old)), map: orMap() });
  assert.equal(r.verdict, 'error');
  assert.match(r.error, /cached copy/);
  assert.equal(r.changed_token, undefined);
  const labelled = fixture('or-sos.fed.html').replace(/(<div class="col header-box1">\s*<h3>)([\s\S]*?)(<\/h3>)/, '$1Official$3');
  assert.equal((await orsos.read({ fetch: fakeFetch(orRoutes(labelled)), map: orMap() })).verdict, 'error', 'a label that differs from the home page is a cached copy too');
});

test('Multnomah: an SOS county page older than the SOS home page is an error', async () => {
  const routes = {
    'Multnomah_County_Chair': 'multco.chair.html',
    'Multnomah_County_Auditor': 'multco.auditor.html',
    'blob.core.windows.net': 'multco.chair.json',
    'type=CTYALL': { status: 200, body: fixture('or-sos.multnomah.html').replace('11/3/2026 | 8:15 PM PT', '11/3/2026 | 8:00 PM PT') },
    'oregonvotes.gov/': 'or-sos.index.html',
    'rcvresults.multco.us/': 'multco.index.html',
  };
  const r = await multco.read({ fetch: fakeFetch(routes), map: mapFor('results-OR-multnomah') });
  assert.equal(r.verdict, 'error');
  assert.match(r.error, /cached copy/);
});

test('Georgia: every one-seat race in Fulton, DeKalb and the state needs more than half (runoff Dec 1), so none gets a winner from us, and the check hash is unchanged', async () => {
  for (const id of ['fulton-ga', 'dekalb-ga', 'results-GA']) {
    const map = mapFor(id);
    const asPlurality = { ...map, contests: map.contests.map((c) => (c.checked_kind ? (({ checked_kind, rule_note, ...x }) => ({ ...x, kind: 'plurality' }))(c) : c)) };
    assert.equal(await checkHash(map), await checkHash(asPlurality), `${id}: numbers are built the same way, so a check stands`);
    for (const c of map.contests.filter((x) => Number(x.seats) === 1 && x.kind !== 'measure')) {
      assert.equal(c.kind, 'rule_unknown', `${id} ${c.item}`);
      assert.equal(c.checked_kind, 'plurality', `${id} ${c.item}`);
      assert.match(c.rule_note, /21-2-501/);
    }
  }
  // Fulton's four-way special, at its final-upload flag after the count window: the count shows, with no winner.
  const map = mapFor('fulton-ga');
  const mc = map.contests.find((c) => c.item === 'fulton-commission-4-special');
  const names = Object.keys(mc.choices).filter((k) => mc.choices[k] && mc.choices[k] !== '__other');
  const read = { verdict: 'ok', election: { id: map.election.feed_election_id, name: map.election.feed_name, date: '2026-11-03' }, source_status: 'final_flag', source_updated: '2026-11-08T00:00:00.000Z', reporting: null, labels: [],
    contests: [{ feed_id: mc.feed_id, feed_name: mc.feed_name, reporting: null, choices: names.map((n, i) => ({ name: n, votes: [3800, 3000, 2000, 1200][i] || 0 })) }] };
  const f = buildStateFile({ state: 'GA', maps: [{ ...map, contests: [mc] }], srcs: { [map.id]: { record: { read, fetched: '2026-11-08T00:00:00.000Z' }, checked: true, sched: {} } }, mode: 'public', now: '2026-11-08T00:10:00.000Z' });
  assert.equal(f.items[mc.item].status, 'complete');
  assert.equal(f.items[mc.item].final, null, 'a 38% leader is headed to a runoff, not a winner');
});

/* A fetch that never answers for one host until the request is cut. */
const hangFor = (host, inner) => async (url, opts = {}) => {
  if (!url.includes(host)) return inner(url, opts);
  return new Promise((_, no) => { const s = opts.signal; if (s?.aborted) no(s.reason); else s?.addEventListener('abort', () => no(s.reason), { once: true }); });
};
const DC_OK = { 'getElectionInfo/2026-General-Election': 'dc.info.json', 'getCityWide/2026-General-Election': 'dc.citywide.json' };

test('tick: a source that hangs holds back only its own state; its fetches are cut at the deadline and it backs off', async () => {
  const dc = mapFor('results-DC');
  const nycMap = mapFor('results-NY-nyc');
  const store = memStore();
  const put = store.put.bind(store);
  const at = {};
  store.put = async (k, v) => { at[k] ??= Date.now(); return put(k, v); };
  const t0 = Date.now();
  const out = await runTick({ fetch: hangFor('boenyc.gov', fakeFetch(DC_OK)), store, archive: null, maps: [dc, nycMap], now: '2026-11-04T05:00:00.000Z', deadlineMs: 400, log: () => {} });
  const took = Date.now() - t0;
  assert.ok(took < 2000, `the tick ends soon after its deadline (${took} ms)`);
  assert.ok(at['preview:DC'] - t0 < 300, 'DC went out before the NYC read was cut');
  const ny = out.ran.find((r) => r.id === nycMap.id);
  assert.equal(ny.outcome, 'error');
  assert.match(ny.error, /ran out of time/);
  assert.doesNotMatch(ny.error, /before the retry/, 'no in-tick retry once the clock has run out');
  const s = JSON.parse(await store.get('sched:2026-11-03')).sources[nycMap.id];
  assert.equal(s.fail_count, 1);
  assert.ok(Date.parse(s.next_due) > Date.parse('2026-11-04T05:00:00.000Z'));
});

test('tick: no source starts after the budget; it stays due and goes first next tick', async () => {
  const dc = mapFor('results-DC');
  const nycMap = mapFor('results-NY-nyc');
  const store = memStore();
  // One worker: NYC first (earlier next_due), hanging past the 100 ms budget, so DC never starts this tick.
  await store.put('sched:2026-11-03', JSON.stringify({ sources: { [nycMap.id]: { next_due: '2026-11-04T04:00:00.000Z' }, [dc.id]: { next_due: '2026-11-04T04:30:00.000Z' } }, meta: {} }));
  const out = await runTick({ fetch: hangFor('boenyc.gov', fakeFetch(DC_OK)), store, archive: null, maps: [dc, nycMap], now: '2026-11-04T05:00:00.000Z', workers: 1, budgetMs: 100, deadlineMs: 300, log: () => {} });
  assert.deepEqual(out.skipped, [dc.id]);
  assert.deepEqual(out.ran.map((r) => r.id), [nycMap.id]);
  const sched = JSON.parse(await store.get('sched:2026-11-03'));
  assert.equal(sched.sources[dc.id].next_due, '2026-11-04T04:30:00.000Z', 'untouched, still due');
  const next = await runTick({ fetch: fakeFetch(DC_OK), store, archive: null, maps: [dc, nycMap], now: '2026-11-04T05:01:00.000Z', workers: 1, log: () => {} });
  assert.equal(next.ran[0].id, dc.id);
});

test('schedule: with all 36 sources, every source whose numbers are public is read at least every 5 minutes, and previews every 10', async () => {
  const CHECKED = new Set(['dallas-county-tx', 'williamson-tx', 'bexar-tx', 'harris-county-tx', 'travis-tx', 'results-TX', 'results-CO-jefferson', 'results-CO-adams', 'arapahoe-co', 'results-CO-douglas', 'results-DC']);
  const live = MAPS.filter((m) => ADAPTERS[m.feed.adapter]);
  assert.equal(live.length, 36);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const sched = {}; const runs = {};
  for (let t = 0; t < 90; t++) {
    const now = new Date(Date.parse('2026-11-04T04:40:00Z') + t * 60_000).toISOString();
    clampElectionNight(sched, live, now);
    const ids = dueSources(sched, live.map((m) => m.id), now, undefined, CHECKED);
    assert.ok(ids.length <= TICK_LIMIT);
    for (const id of ids) {
      (runs[id] ??= []).push(t);
      sched[id] = nextEntry(sched[id], { kind: 'ok', changed: rnd() < 0.7, status: 'counting' }, now, live.find((m) => m.id === id));
      if (!CHECKED.has(id)) previewFloor(sched[id], now);
    }
  }
  const gap = (id) => { const r = runs[id] || []; let g = r.length ? r[0] : 90; for (let i = 1; i < r.length; i++) g = Math.max(g, r[i] - r[i - 1]); return g; };
  for (const id of CHECKED) assert.ok(gap(id) <= 5, `${id}: ${gap(id)} minutes`);
  for (const m of live) if (!CHECKED.has(m.id)) assert.ok(gap(m.id) <= 10, `${m.id}: ${gap(m.id)} minutes`);
  // Right after a deploy, 24 new sources with no schedule entry never go ahead of the public ones.
  const fresh = dueSources({}, live.map((m) => m.id), '2026-11-04T05:00:00.000Z', undefined, CHECKED);
  assert.deepEqual(fresh.slice(0, CHECKED.size).sort(), [...CHECKED].sort());
});

test('tick: an older tick that saves last never undoes a newer tick\'s refusal', async () => {
  const dc = mapFor('results-DC');
  const store = memStore();
  let inner = null;
  // Tick A (05:00) loads the schedule, then, while its DC read is in flight, tick B (05:01) runs DC, is refused, and saves.
  const fetchA = async (url, opts) => {
    if (!inner) inner = runTick({ fetch: fakeFetch({ 'getElectionInfo/': { status: 403, body: '' } }), store, archive: null, maps: [dc], now: '2026-11-04T05:01:00.000Z', log: () => {} });
    await inner;
    return fakeFetch(DC_OK)(url, opts);
  };
  const a = await runTick({ fetch: fetchA, store, archive: null, maps: [dc], now: '2026-11-04T05:00:00.000Z', log: () => {} });
  assert.equal(a.ran[0].outcome, 'changed', 'A read DC fine');
  assert.equal((await inner).ran[0].outcome, 'refused', 'B was refused');
  const s = JSON.parse(await store.get('sched:2026-11-03')).sources[dc.id];
  assert.equal(s.stopped, 'refused', "A's later save kept B's newer refusal");
  assert.equal(s.last_run, '2026-11-04T05:01:00.000Z');
});

test('fetch: an error page whose template loads reCAPTCHA is an error that backs off, not a refusal; a visible CAPTCHA still is one', async () => {
  const at = (spec, expect) => get(fakeFetch({ x: spec }), 'https://results.example/x', { expect });
  const page = '<html><head><title>503 Service Unavailable</title><script src="https://www.google.com/recaptcha/api.js" async defer></script></head><body><h1>Service Unavailable</h1><form><div class="g-recaptcha" data-sitekey="k"></div></form></body></html>';
  for (const status of [500, 503, 404]) for (const expect of ['json', 'text', 'html']) {
    const r = await at({ status, body: page }, expect);
    assert.equal(r.verdict, 'error', `${status} ${expect}`);
  }
  const r = await at({ status: 503, body: '<html><body><p>Please complete the CAPTCHA below to continue.</p></body></html>' }, 'html');
  assert.equal(r.verdict, 'refused');
});

test('fetch: a body past 16 MB, or a gzip that unpacks past 32 MB, is an error with a plain reason; real sizes read fine', async () => {
  const resp = (body, headers = {}) => async () => new Response(body, { status: 200, headers });
  let r = await get(resp('{}', { 'content-length': '30000000' }), 'https://results.example/x');
  assert.equal(r.verdict, 'error');
  assert.match(r.error, /larger than 16 MB/);
  // No Content-Length: the stream is counted as it comes.
  const big = new ReadableStream({ start(c) { for (let i = 0; i < 17; i++) c.enqueue(new Uint8Array(1_000_000).fill(32)); c.close(); } });
  r = await get(resp(big), 'https://results.example/x', { expect: 'text' });
  assert.equal(r.verdict, 'error');
  assert.match(r.error, /larger than 16 MB/);
  const bomb = new Uint8Array(gzipSync(Buffer.alloc(33_000_000, 32)));
  assert.ok(bomb.length < 200_000);
  r = await get(resp(bomb), 'https://results.example/x', { expect: 'text' });
  assert.equal(r.verdict, 'error');
  assert.match(r.error, /unzipped data is larger than 32 MB/);
  // The size of St. Louis County's CSV (6.6 MB), and a small gzipped summary, read as usual.
  r = await get(resp('a,b\n'.repeat(1_650_000)), 'https://results.example/x', { expect: 'text' });
  assert.equal(r.verdict, 'ok');
  assert.equal(r.body.length, 6_600_000);
  r = await get(resp(new Uint8Array(gzipSync(Buffer.from('{"a":1}')))), 'https://results.example/x');
  assert.deepEqual(r.json, { a: 1 });
});

test('Pennsylvania: a refusal on any request wins over a plain error on another, so it is never retried', async () => {
  const PA_ROUTES = { GetElectionList: 'pa-dos.electionlist.json', GetDashboardMessage: 'pa-dos.dashboard.json', GetSummaryData: 'pa-dos.summary.json', 'officeId=11&': 'pa-dos.office11.json', 'officeId=12&': 'pa-dos.office12.json', 'officeId=13&': 'pa-dos.office13.json' };
  const map = mapFor('results-PA');
  const r = await pa.read({ fetch: fakeFetch({ ...PA_ROUTES, GetElectionList: { status: 500, body: 'oops' }, GetDashboardMessage: { status: 403, body: '' } }), map });
  assert.equal(r.verdict, 'refused');
  assert.match(r.error, /403/);
  const e = await pa.read({ fetch: fakeFetch({ ...PA_ROUTES, GetElectionList: { status: 500, body: 'oops' } }), map });
  assert.equal(e.verdict, 'error', 'a plain error alone still backs off and retries');
  assert.equal((await pa.read({ fetch: fakeFetch(PA_ROUTES), map })).verdict, 'ok');
});
