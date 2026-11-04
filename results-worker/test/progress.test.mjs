/* A source's own progress line (`read.reporting`, published as `sources[].reporting` and quoted by the site's footer)
   when the office prints none for its whole county or state: one whole-jurisdiction contest's own line, or null.
   Fixtures are the saved Nov 3, 2026 reads. Two are new: clarity-allegheny.summary.json and clarity-douglas.summary.json
   are the workbench captures research/raw/results-PA/feed-allegheny-pa-round1-2042.json (version 384318, 8:42 PM CT)
   and research/raw/results-CO/feed-results-CO-douglas-round1-2042.json (version 384108, 8:42 PM CT). Their
   electionsettings weren't saved, so Fulton's (whole-election counts 0, like every county's that night) stands in.
   Where the first-run checks (Nov 4) found the feed's count isn't the one on the office's page (Colorado's state site,
   Orange FL, Allegheny, Washington's state site), the line is null: the page's own words or nothing. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, fixture, mapFor } from './helpers.mjs';
import * as clarity from '../src/adapters/clarity.js';
import * as ev from '../src/adapters/enhanced_voting.js';
import * as fl_dos from '../src/adapters/fl_dos.js';
import { wholeProgress } from '../src/util.js';
import { buildStateFile } from '../src/merge.js';

const S = (n) => JSON.parse(fixture(`clarity-${n}.summary.json`));
const E = (n) => JSON.parse(fixture(`clarity-${n}.electionsettings.json`));
async function clarityRead(map, summary, settings, ver = '400001') {
  const m = typeof map === 'string' ? mapFor(map) : map;
  const id = m.election.feed_election_id;
  const f = fakeFetch({
    [`/${id}/current_ver.txt`]: { status: 200, body: ver },
    [`/${id}/${ver}/json/en/summary.json`]: { status: 200, body: JSON.stringify(summary) },
    [`/${id}/${ver}/json/en/electionsettings.json`]: { status: 200, body: JSON.stringify(settings) },
  });
  return clarity.read({ fetch: f, map: m });
}
const withTotals = (settings, total, now) => ({ ...settings, settings: { ...settings.settings, totalprecinctsreporting: total, numberofprecinctsreporting: now } });

test('progress, clarity: a county with no line of its own quotes its whole-county races\' own line', async () => {
  for (const [map, n, words, from] of [
    ['bexar-tx', 'bexar', '0 of 806 precincts reporting', 'United States Senator'], // 58 races at 806, before any votes
    ['dallas-county-tx', 'dallas', '0 of 914 precincts reporting', 'United States Senator'],
    ['travis-tx', 'travis', '0 of 308 precincts reporting', 'United States Senator'],
    ['williamson-tx', 'williamson', '0 of 177 precincts reporting', 'United States Senator'],
    ['fulton-ga', 'fulton', '230 of 437 precincts reporting', 'US Senate'],
  ]) {
    const r = await clarityRead(map, S(n), E(n));
    assert.equal(r.verdict, 'ok', map);
    assert.equal(r.reporting, words, map);
    assert.equal(r.reporting_from, from, map);
    assert.ok(r.contests.some((c) => c.feed_name === from && c.reporting === words), `${map}: the words are that contest's own`);
  }
});

test('progress, clarity: the same feed under a county whose page agrees quotes its whole-county line, never the first race', async () => {
  // Allegheny's own feed, read as if it were a county whose PR matches its page: two races sit at 1,327 precincts.
  const asOther = { ...mapFor('allegheny-pa'), id: 'allegheny-as-a-matching-county' };
  const r = await clarityRead(asOther, S('allegheny'), E('fulton'));
  assert.equal(r.reporting, '854 of 1327 precincts reporting');
  assert.equal(r.reporting_from, 'Governor and Lieutenant Governor');
  // The first race in the feed is a district (PA-12, 451 of 780): never the county's line.
  assert.equal(r.contests[0].reporting, '451 of 780 precincts reporting');
});

test('progress, clarity: where the feed\'s count is not the page\'s, nothing: Allegheny, Orange FL, Colorado\'s state site', async () => {
  // Allegheny: the page's own sum.json and report said 1,322 where PR said 1,321, at the same version (Nov 3).
  let r = await clarityRead('allegheny-pa', S('allegheny'), E('fulton'));
  assert.equal(r.reporting, null);
  assert.ok(r.contests.every((c) => c.reporting === null));
  // Orange hides small precincts' data; its page said 263/263 and 22/22 where PR said 261 and 21 (Nov 4).
  r = await clarityRead('orange-fl', S('orange'), E('orange'));
  assert.equal(E('orange').settings.electiondetails.precinctdatahidden, '1');
  assert.equal(r.reporting, null);
  assert.ok(r.contests.every((c) => c.reporting === null));
  assert.equal(r.contests.find((c) => c.feed_name === 'U.S. Congress, District 9').precincts.reported, 21, 'the count stays as data');
  // Colorado's page: "Election Night Reporting Complete 2/64" where PR said 21 of 64, and no precinct count anywhere.
  r = await clarityRead('results-CO', S('co-state'), E('co-state'));
  assert.equal(r.reporting, null);
  assert.ok(r.contests.every((c) => c.reporting === null));
});

test('progress, clarity: Douglas, votes in and no precinct reported anywhere, has no line, never "0 of 211"', async () => {
  const r = await clarityRead('results-CO-douglas', S('douglas'), E('fulton'));
  assert.equal(r.verdict, 'ok');
  assert.ok(r.contests.some((c) => c.choices.some((ch) => ch.votes > 0)));
  assert.equal(r.reporting, null);
  assert.equal(r.reporting_from, undefined);
  // Its districts below the whole count carry no words either, but even if one did, it would never stand in.
  const district = S('douglas').map((c) => (Number(c.TP) === 210 ? { ...c, PR: 5 } : c));
  assert.equal((await clarityRead('results-CO-douglas', district, E('fulton'))).reporting, null);
});

test('progress, clarity: the largest race is a district race (Dallas June 2026 runoff, city races only): no line', async () => {
  const june = { ...mapFor('dallas-county-tx'), election: { date: '2026-11-03', feed_election_id: '126485' } };
  const summary = S('dallas-june');
  assert.equal(Math.max(...summary.map((c) => Number(c.TP))), 34, 'Farmers Branch Mayor leads alone');
  const r = await clarityRead(june, summary, E('dallas-june'));
  assert.equal(r.reporting, null);
  // The same in a November feed whose county-wide races are gone: Fulton's next largest is one special election.
  const noCounty = S('fulton').filter((c) => Number(c.TP) !== 437);
  assert.equal((await clarityRead('fulton-ga', noCounty, E('fulton'))).reporting, null);
});

test('progress, clarity: the county\'s own total, where given, must match the whole-county races\' count', async () => {
  // The settings' own count is never quoted (no page showed it); its total only checks the races' reach.
  let r = await clarityRead('fulton-ga', S('fulton'), withTotals(E('fulton'), 437, 0));
  assert.equal(r.reporting, '230 of 437 precincts reporting');
  // A total no race reaches means no race is known to cover the county.
  r = await clarityRead('fulton-ga', S('fulton'), withTotals(E('fulton'), 450, 0));
  assert.equal(r.reporting, null);
  // The largest race left is a district one under the county's 437.
  r = await clarityRead('fulton-ga', S('fulton').filter((c) => Number(c.TP) !== 437), withTotals(E('fulton'), 437, 0));
  assert.equal(r.reporting, null);
  r = await clarityRead('fulton-ga', S('fulton'), withTotals(E('fulton'), 437, 231));
  assert.equal(r.reporting, '230 of 437 precincts reporting');
  assert.equal(r.reporting_from, 'US Senate');
});

test('progress, clarity: whole-county races that disagree quote the lowest; one without words means none', async () => {
  const lower = S('fulton').map((c) => (c.C === 'Governor' ? { ...c, PR: 229 } : c));
  let r = await clarityRead('fulton-ga', lower, E('fulton'));
  assert.equal(r.reporting, '229 of 437 precincts reporting');
  assert.equal(r.reporting_from, 'Governor');
  const silent = S('fulton').map((c) => (c.C === 'Governor' ? { ...c, PR: 0 } : c)); // votes in, 0 reported: no words
  r = await clarityRead('fulton-ga', silent, E('fulton'));
  assert.equal(r.reporting, null);
});

test('progress: the line reaches the published file as the source\'s own `reporting`', async () => {
  const map = mapFor('fulton-ga');
  const read = await clarityRead(map, S('fulton'), E('fulton'));
  const f = buildStateFile({ state: 'GA', maps: [map], srcs: { [map.id]: { record: { read, fetched: '2026-11-04T02:45:00.000Z' }, checked: true } }, mode: 'public', now: '2026-11-04T02:45:30.000Z' });
  assert.equal(f.sources[0].reporting, '230 of 437 precincts reporting');
});

const FEEDS = { georgia: 'results-GA', dekalb: 'dekalb-ga', washington: 'results-WA', king: 'king-county-wa' };
async function evRead(n, keep = () => true) {
  const m = mapFor(FEEDS[n]);
  const items = JSON.parse(fixture(`ev-${n}.ballot-items.json`));
  items.data = items.data.filter(keep);
  items.totalRecordCount = items.data.length;
  const f = fakeFetch({ '/ballot-items': { status: 200, body: JSON.stringify(items) }, [`/${m.election.feed_election_id}`]: `ev-${n}.election.json` });
  return ev.read({ fetch: f, map: m });
}

test('progress, enhanced_voting: Georgia quotes a race on every county; county sites keep the record\'s line', async () => {
  // Georgia's page shows "Localities reporting 159/159" on its statewide races (first-run check, Nov 4).
  let r = await evRead('georgia');
  assert.equal(r.reporting, '159 of 159 counties reporting');
  assert.equal(r.reporting_from, 'US Senate');
  // Washington's record says includePrecinctStatuses false and its page shows no count: nothing on the source or races.
  r = await evRead('washington');
  assert.equal(r.reporting, null);
  assert.ok(r.contests.every((c) => c.reporting === null));
  r = await evRead('dekalb');
  assert.equal(r.reporting, 'Partially Reported 191 of 191 precincts');
  assert.equal(r.reporting_from, undefined);
  r = await evRead('king'); // no unit counts anywhere: nothing to quote
  assert.equal(r.reporting, null);
});

test('progress, enhanced_voting: with no statewide race, the largest district race never stands in for the state', async () => {
  const gaDistricts = (c) => Number(c.reportingStatus?.totalUnits || 0) < 159;
  assert.equal((await evRead('georgia', gaDistricts)).reporting, null);
});

const FL_LM = 'Wed, 04 Nov 2026 04:18:03 GMT';
const flRead = (body) => fl_dos.read({ fetch: fakeFetch({ '20261103_ElecResultsFL.txt': { status: 200, body, headers: { 'Last-Modified': FL_LM } } }), map: mapFor('results-FL') });

test('progress, fl_dos: the state\'s line is a statewide race\'s own, a race with a row for all 67 counties', async () => {
  const r = await flRead(fixture('fl-dos.ElecResultsFL.txt'));
  assert.equal(r.reporting, '5567 of 5626 precincts reporting');
  assert.equal(r.reporting_from, 'United States Senator');
});

test('progress, fl_dos: a file of district races only, or a statewide race missing a county, gives no line', async () => {
  const [head, ...rows] = fixture('fl-dos.ElecResultsFL.txt').split(/\r?\n/).filter(Boolean);
  const at = head.split('\t').indexOf('RaceName');
  const county = head.split('\t').indexOf('CountyCode');
  const districts = rows.filter((l) => /District|Circuit|Joseph Lewis/.test(l.split('\t')[at]));
  let r = await flRead([head, ...districts].join('\n'));
  assert.equal(r.verdict, 'ok');
  assert.ok(r.contests.length >= 4);
  assert.equal(r.reporting, null);
  const firstCounty = rows[0].split('\t')[county];
  r = await flRead([head, ...rows.filter((l) => l.split('\t')[county] !== firstCounty)].join('\n'));
  assert.equal(r.reporting, null, 'a race on 66 counties is not known to be statewide');
});

test('progress, wholeProgress: the rules on their own', () => {
  const c = (name, reported, total, words = `${reported} of ${total} precincts reporting`) => ({ feed_name: name, reporting: words, precincts: { reported, total } });
  assert.equal(wholeProgress([]), null);
  assert.equal(wholeProgress([{ feed_name: 'x', reporting: 'Ballots counted 5', precincts: null }]), null);
  assert.deepEqual(wholeProgress([c('A', 5, 10), c('B', 2, 4)]), { reporting: '5 of 10 precincts reporting', from: 'A' });
  assert.equal(wholeProgress([c('A', 5, 10), c('B', 2, 4)], { shared: 2 }), null, 'one race alone at the top');
  assert.deepEqual(wholeProgress([c('A', 5, 10), c('B', 4, 10)], { shared: 2 }), { reporting: '4 of 10 precincts reporting', from: 'B' });
  assert.equal(wholeProgress([c('A', 5, 10), c('B', 5, 10)], { total: 12 }), null);
  assert.equal(wholeProgress([c('A', 5, 10), c('B', 0, 10, null)]), null);
  assert.equal(wholeProgress([c('A', 5, 10), c('B', 2, 4)], { covers: (x) => x.feed_name === 'B' }), null, 'the proof has to hold at the top count');
});
