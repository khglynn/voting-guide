/* The pa-co family (Nov 3, 2026): Pennsylvania's Department of State JSON, Philadelphia's City Commissioners pages,
   Denver's JSON and Boulder County's static page. Fixtures are trimmed reads from about 10:20 PM CT on Nov 3. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, fixture } from './helpers.mjs';
import { NAMED_UA } from '../src/fetch.js';
import * as pa from '../src/adapters/pa_dos.js';
import * as philly from '../src/adapters/philadelphia.js';
import * as denver from '../src/adapters/denver.js';
import * as boulder from '../src/adapters/boulder.js';
import { ADAPTERS } from '../src/adapters/index.js';
import { sourceSlices, buildStateFile } from '../src/merge.js';
import { checkRead, checkFile } from '../src/checks.js';

const NOW = '2026-11-04T04:30:00.000Z';

const PA_ROUTES = { GetElectionList: 'pa-dos.electionlist.json', GetDashboardMessage: 'pa-dos.dashboard.json', GetSummaryData: 'pa-dos.summary.json', 'officeId=11&': 'pa-dos.office11.json', 'officeId=12&': 'pa-dos.office12.json', 'officeId=13&': 'pa-dos.office13.json' };
const PA_MAP = { id: 'results-PA', state: 'PA', name: 'Pennsylvania Department of State', county: 'Pennsylvania', scope: 'state', election: { date: '2026-11-03', feed_election_id: '117', feed_name: '2026 General Election' }, feed: { adapter: 'pa_dos', base: 'https://www.electionreturns.pa.gov', results_url: 'https://www.electionreturns.pa.gov/', election_type: 'G', offices: ['11', '12', '13'] } };

const PH_ROUTES = { 'type=QUE': 'philadelphia.QUE.html', 'type=CON': 'philadelphia.CON.html', 'type=STS': 'philadelphia.STS.html', 'type=STR': 'philadelphia.STR.html' };
const PH_MAP = { id: 'philadelphia-pa', state: 'PA', name: 'Philadelphia City Commissioners', county: 'Philadelphia', election: { date: '2026-11-03', feed_election_id: '2026 General Election Results', feed_name: '2026 General Election Results' }, feed: { adapter: 'philadelphia', base: 'https://philadelphiaresults.azurewebsites.us', results_url: 'https://philadelphiaresults.azurewebsites.us/', tabs: ['QUE', 'CON', 'STS', 'STR'] } };

const DE_ROUTES = { GetElectionHeaderinfo: 'denver.header.json', 'api/Election': 'denver.election.json' };
const DE_MAP = { id: 'denver-co', state: 'CO', name: 'Denver Elections Division', county: 'Denver', election: { date: '2026-11-03', feed_election_id: '20261103', feed_name: '2026 General Election' }, feed: { adapter: 'denver', base: 'https://denvergov.org/electionresults', results_url: 'https://denvergov.org/electionresults' } };

const BO_ROUTES = { 'electionresults.bouldercounty.gov': { status: 200, body: fixture('boulder.index.html'), headers: { 'Last-Modified': 'Wed, 04 Nov 2026 03:44:08 GMT' } } };
const BO_MAP = { id: 'boulder-county-co', state: 'CO', name: 'Boulder County Elections', county: 'Boulder', election: { date: '2026-11-03', feed_election_id: '2026 General Election', feed_name: '2026 General Election' }, feed: { adapter: 'boulder', base: 'https://electionresults.bouldercounty.gov', page: 'https://electionresults.bouldercounty.gov/', results_url: 'https://electionresults.bouldercounty.gov/' } };

test('adapters: the four are registered by the names their maps use', () => {
  for (const n of ['pa_dos', 'philadelphia', 'denver', 'boulder']) assert.equal(typeof ADAPTERS[n]?.read, 'function', n);
});

test('pa_dos: the state JSON reads as the Nov 3 general (117, type G), no clock time, statewide words only on statewide races', async () => {
  const f = fakeFetch(PA_ROUTES);
  const r = await pa.read({ fetch: f, map: PA_MAP });
  assert.equal(r.verdict, 'ok');
  assert.deepEqual(r.election, { id: '117', name: '2026 General Election', date: '2026-11-03' });
  assert.equal(r.source_updated, null, 'the feed has no clock time; freshness is our fetch time');
  assert.equal(r.official, false);
  assert.deepEqual(r.labels, ['Unofficial Results']);
  assert.equal(r.reporting, '3,733 Out of 9,065 Districts (41.18%) - IN PERSON BALLOT REPORTING ONLY');
  assert.equal(r.contests.length, 1 + 17 + 25 + 36, 'Governor, 17 U.S. House, 25 State Senate, 36 State House in the trimmed fixture');
  const gov = r.contests[0];
  assert.equal(gov.feed_id, '3:1');
  assert.equal(gov.feed_name, 'Governor');
  assert.deepEqual(gov.choices.map((c) => [c.name, c.votes]), [['JOSH SHAPIRO', 2752244], ['STACY GARRITY', 1750407], ['KEN KRAWCHUK', 59334]]);
  assert.equal(gov.reporting, r.reporting);
  const hd10 = r.contests.find((c) => c.feed_id === '13:82');
  assert.equal(hd10.feed_name, 'Representative in the General Assembly, 10th Legislative District');
  assert.deepEqual(hd10.choices.map((c) => [c.name, c.votes]), [['AMEN BROWN', 16696]]);
  assert.equal(hd10.reporting, null, 'a district race never carries the statewide district count');
  assert.ok(r.contests.some((c) => c.feed_name === 'Representative in Congress, 1st Congressional District'));
  // the named fetcher, the www host, the exact method names, one call per office id
  assert.equal(f.calls.length, 6);
  for (const c of f.calls) { assert.equal(c.headers['User-Agent'], NAMED_UA); assert.ok(c.url.startsWith('https://www.electionreturns.pa.gov/api/')); }
  assert.ok(f.calls.some((c) => c.url.includes('methodName=GetSummaryData&electionid=117&electiontype=G')));
  for (const o of ['11', '12', '13']) assert.equal(f.calls.filter((c) => c.url.includes(`officeId=${o}&methodName=GetOfficeDetails`)).length, 1);
});

test('pa_dos: the same bytes again are unchanged; an empty string (a wrong method) and a missing election are errors', async () => {
  const r = await pa.read({ fetch: fakeFetch(PA_ROUTES), map: PA_MAP });
  const again = await pa.read({ fetch: fakeFetch(PA_ROUTES), map: PA_MAP, prevToken: r.changed_token });
  assert.equal(again.unchanged, true);
  const empty = await pa.read({ fetch: fakeFetch({ ...PA_ROUTES, 'officeId=12&': { status: 200, body: '""' } }), map: PA_MAP });
  assert.equal(empty.verdict, 'error');
  assert.match(empty.error, /office12: the feed answered an empty string/);
  const primary = await pa.read({ fetch: fakeFetch(PA_ROUTES), map: { ...PA_MAP, feed: { ...PA_MAP.feed, election_type: 'S' } } });
  assert.equal(primary.verdict, 'error');
  assert.match(primary.error, /no election 117, type S/);
  const blocked = await pa.read({ fetch: fakeFetch({ ...PA_ROUTES, GetSummaryData: { status: 200, body: '<html>Incapsula incident</html>' } }), map: PA_MAP });
  assert.equal(blocked.verdict, 'refused');
});

test('pa_dos: a retention race reads as Yes and No', () => {
  const body = { Election: { 'Justice of the Supreme Court': [{ 'Retention$$9$$': [{ DistrictId: '9', District: 'Retention', Candidates: [{ CandidateName: 'A JUDGE', IsRetention: '1', Votes: '0', YesVotes: '120', NoVotes: '45' }] }] }] } };
  const [c] = pa.contestsOf(body, '20', null);
  assert.deepEqual(c.choices, [{ name: 'Yes', votes: 120 }, { name: 'No', votes: 45 }]);
});

test('philadelphia: four tabs read with the page\'s own Eastern stamp, each race\'s own division count', async () => {
  const f = fakeFetch(PH_ROUTES);
  const r = await philly.read({ fetch: f, map: PH_MAP });
  assert.equal(r.verdict, 'ok');
  assert.deepEqual(r.election, { id: '2026 General Election Results', name: '2026 General Election Results', date: '2026-11-03' });
  assert.equal(r.changed_token, '11/3/2026 11:12:47 PM');
  assert.equal(r.source_updated, '2026-11-04T04:12:47.000Z', '11:12:47 PM Eastern');
  assert.equal(r.reporting, '1,684 of 1,703 divisions reported');
  assert.deepEqual(r.labels, ['Unofficial 2026 General Election Results'], 'the testing banner is served hidden tonight, so it is not quoted');
  assert.equal(r.contests.length, 2 + 3 + 3 + 20);
  const q1 = r.contests.find((c) => c.feed_id === '401356');
  assert.equal(q1.feed_name, 'QUESTION #1');
  assert.deepEqual(q1.choices, [{ name: 'Yes', votes: 343793 }, { name: 'No', votes: 92551 }]);
  assert.equal(q1.reporting, 'Divisions Reported: 1684 / 1703');
  const cd2 = r.contests.find((c) => c.feed_id === '401363');
  assert.equal(cd2.feed_name, 'REPRESENTATIVE IN CONGRESS 2ND DISTRICT');
  assert.deepEqual(cd2.choices.map((c) => c.name), ['BRENDAN F BOYLE DEM', 'JESSICA ARRIAGA REP', 'Write-In']);
  assert.equal(cd2.reporting, 'Divisions Reported: 726 / 737');
  for (const c of r.contests) assert.equal(c.total, c.source_total, `${c.feed_name}: our sum equals the page's Total Votes`);
  assert.equal(f.calls.length, 4);
  for (const c of f.calls) assert.equal(c.headers['User-Agent'], NAMED_UA);
});

test('philadelphia: an unchanged stamp costs one request; tabs read across an update are an error; a visible banner is quoted', async () => {
  const f = fakeFetch(PH_ROUTES);
  const r = await philly.read({ fetch: f, map: PH_MAP, prevToken: '11/3/2026 11:12:47 PM' });
  assert.equal(r.unchanged, true);
  assert.equal(f.calls.length, 1);
  const moved = fixture('philadelphia.STR.html').replace('11/3/2026 11:12:47 PM', '11/3/2026 11:20:02 PM');
  const across = await philly.read({ fetch: fakeFetch({ ...PH_ROUTES, 'type=STR': { status: 200, body: moved } }), map: PH_MAP });
  assert.equal(across.verdict, 'error');
  assert.match(across.error, /read across an update/);
  const shown = fixture('philadelphia.QUE.html').replace(/(<div id="pnlTestBanner"[^>]*?) display:none;/, '$1');
  const b = await philly.read({ fetch: fakeFetch({ ...PH_ROUTES, 'type=QUE': { status: 200, body: shown } }), map: PH_MAP });
  assert.equal(b.labels[0], '*** Testing in Progress ***');
});

test('denver: the header\'s time is the token; under and over votes are left out; "Winning" is never an outcome', async () => {
  const f = fakeFetch(DE_ROUTES);
  const r = await denver.read({ fetch: f, map: DE_MAP });
  assert.equal(r.verdict, 'ok');
  assert.deepEqual(r.election, { id: '20261103', name: '2026 General Election', date: '2026-11-03' });
  assert.equal(r.changed_token, 'Results as of 8:30 PM on 11/03/2026');
  assert.equal(r.source_updated, '2026-11-04T03:30:00.000Z', '8:30 PM Mountain');
  assert.equal(r.reporting, null, 'Denver gives no progress words');
  assert.equal(r.contests.length, 68);
  const q2h = r.contests.find((c) => c.feed_id === '62');
  assert.equal(q2h.feed_name, 'Referred Question 2H');
  assert.deepEqual(q2h.choices, [{ name: 'YES/FOR', votes: 156076 }, { name: 'NO/AGAINST', votes: 24663 }]);
  const sen = r.contests.find((c) => c.feed_id === '1');
  assert.equal(sen.total, 192884, 'TotalVotes leaves out 3,211 under and 47 over votes');
  assert.ok(r.contests.every((c) => c.declared === null));
  const again = fakeFetch(DE_ROUTES);
  const u = await denver.read({ fetch: again, map: DE_MAP, prevToken: r.changed_token });
  assert.equal(u.unchanged, true);
  assert.equal(again.calls.length, 1);
  const other = await denver.read({ fetch: fakeFetch(DE_ROUTES), map: { ...DE_MAP, election: { ...DE_MAP.election, feed_election_id: '20260630' } } });
  assert.equal(other.verdict, 'error');
});

test('boulder: 90 races from the county page, its own Mountain time and ballot count; a 304 is one request', async () => {
  const r = await boulder.read({ fetch: fakeFetch(BO_ROUTES), map: BO_MAP });
  assert.equal(r.verdict, 'ok');
  assert.deepEqual(r.election, { id: '2026 General Election', name: '2026 General Election', date: '2026-11-03' });
  assert.equal(r.source_updated, '2026-11-04T03:41:00.000Z', '8:41 PM Mountain');
  assert.equal(r.reporting, 'Total Ballots Counted: 113,748');
  assert.deepEqual(r.labels, ['Unofficial Results']);
  assert.equal(r.contests.length, 90);
  const sen = r.contests.find((c) => c.feed_id === '1');
  assert.equal(sen.feed_name, 'United States Senator');
  assert.equal(sen.total, 112031, 'equals the grid\'s own sum');
  const mayor = r.contests.find((c) => c.feed_id === '23');
  assert.equal(mayor.choices.length, 0);
  assert.equal(mayor.is_rcv, true);
  const council = r.contests.find((c) => c.feed_id === '24');
  assert.equal(council.feed_name, 'City of Boulder Council Candidates');
  assert.equal(council.vote_for, 5);
  const j = r.contests.find((c) => c.feed_id === '59');
  assert.deepEqual(j.choices, [{ name: 'Yes/For', votes: 15813 }, { name: 'No/Against', votes: 12269 }]);
  const f = fakeFetch({ 'electionresults.bouldercounty.gov': { status: 304, body: '' } });
  const u = await boulder.read({ fetch: f, map: BO_MAP, prevToken: r.changed_token });
  assert.equal(u.unchanged, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].headers['If-Modified-Since'], 'Wed, 04 Nov 2026 03:44:08 GMT');
  const broken = await boulder.read({ fetch: fakeFetch({ 'electionresults.bouldercounty.gov': { status: 200, body: fixture('boulder.index.html').replace('"data":{"Data":[{"CandidateDetailID":1890', '"data":{"Data":[{CandidateDetailID:1890') } }), map: BO_MAP });
  assert.equal(broken.verdict, 'error', 'a race block that cannot be read stops the read rather than dropping the race');
});

/* Each adapter through the same checks and file builder as the live maps, with a one-race map per source. */
const ONE = {
  'results-PA': { map: { ...PA_MAP, contests: [{ feed_id: '3:1', feed_name: 'Governor', item: 'pa-governor', kind: 'plurality', seats: 1, choices: { 'JOSH SHAPIRO': 'Josh Shapiro', 'STACY GARRITY': 'Stacy Garrity', 'KEN KRAWCHUK': 'Ken Krawchuk' }, reaches: ['Pennsylvania'], whole: true }] }, routes: PA_ROUTES },
  'philadelphia-pa': { map: { ...PH_MAP, contests: [{ feed_id: '401356', feed_name: 'QUESTION #1', item: 'philadelphia-question-1', kind: 'measure', seats: 1, choices: { Yes: 'yes', No: 'no' }, reaches: ['Philadelphia'], pass_threshold: 'simple majority' }] }, routes: PH_ROUTES },
  'denver-co': { map: { ...DE_MAP, contests: [{ feed_id: '62', feed_name: 'Referred Question 2H', item: 'denver-2h', kind: 'measure', seats: 1, choices: { 'YES/FOR': 'yes', 'NO/AGAINST': 'no' }, reaches: ['Denver'], pass_threshold: 'simple majority' }] }, routes: DE_ROUTES },
  'boulder-county-co': { map: { ...BO_MAP, contests: [{ feed_id: '59', feed_name: 'City of Boulder Ballot Issue 2J', item: 'boulder-2j', kind: 'measure', seats: 1, choices: { 'Yes/For': 'yes', 'No/Against': 'no' }, reaches: ['Boulder'], pass_threshold: 'simple majority' }] }, routes: BO_ROUTES },
};
for (const [id, { map, routes }] of Object.entries(ONE)) {
  test(`${id}: a read passes the checks and builds a clean preview file, counting, never final`, async () => {
    const r = await ADAPTERS[map.feed.adapter].read({ fetch: fakeFetch(routes), map });
    const { raw, ...read } = r;
    assert.ok(raw && Object.keys(raw).length > 0, 'raw bodies are kept for the archive');
    const chk = checkRead(read, map);
    assert.equal(chk.ok, true, JSON.stringify(chk.problems));
    const { status, slices, problems } = sourceSlices(read, map, NOW);
    assert.deepEqual(problems, []);
    assert.equal(status, 'counting');
    const sl = slices[map.contests[0].item];
    assert.ok(sl.total_votes > 0);
    const f = buildStateFile({ state: map.state, maps: [map], srcs: { [id]: { record: { read, fetched: NOW }, checked: false, sched: {} } }, mode: 'preview', now: NOW });
    assert.deepEqual(checkFile(f), []);
    const src = f.sources.find((s) => s.id === id);
    assert.equal(src.updated, read.source_updated);
    assert.equal(src.fetched, NOW);
    const it = f.items[map.contests[0].item];
    assert.equal(it.final, null, 'no outcome while counting');
  });
}
