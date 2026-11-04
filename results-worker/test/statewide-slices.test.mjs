/* A county's share of a statewide race (Kevin's call, Nov 4): Philadelphia and Allegheny carry Pennsylvania's governor,
   Los Angeles County carries California's statewide races, each as that county's slice (reaches [county, "other
   counties"], statewide: true). Beneath the state's count when the state has numbers; on its own, named by county and
   never the whole race, when the state source is refused or a link. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStateFile } from '../src/merge.js';
import { checkFile } from '../src/checks.js';
import { lintGuide } from '../bin/map-lint.mjs';

const NOW = '2026-11-04T15:00:00.000Z';
const readOf = (contests) => ({ election: { date: '2026-11-03' }, source_updated: '2026-11-04T14:00:00.000Z', reporting: null, contests });
const GOV = { 'JOSH SHAPIRO': 'Josh Shapiro / Austin Davis', 'STACY GARRITY': 'Stacy Garrity / Jason Richey' };
const STATE = { id: 'results-PA', state: 'PA', name: 'Pennsylvania Department of State', county: 'Pennsylvania', scope: 'state', feed: { adapter: 'pa_dos', results_url: 'https://www.electionreturns.pa.gov/', tz: 'America/New_York' },
  contests: [{ feed_id: '3:1', feed_name: 'Governor', item: 'pa-governor', kind: 'plurality', seats: 1, whole: true, reaches: ['Pennsylvania', 'other counties'], choices: GOV }] };
const county = (id, name, extra = []) => ({ id, state: 'PA', name: `${name} County`, county: name, feed: { adapter: 'clarity', results_url: `https://${id}.example/`, tz: 'America/New_York' },
  contests: [
    { feed_id: 'G', feed_name: 'Governor', item: 'pa-governor', kind: 'plurality', seats: 1, statewide: true, reaches: [name, 'other counties'], choices: GOV },
    { feed_id: 'H', feed_name: 'House 1', item: `${id}-house`, kind: 'plurality', seats: 1, reaches: [name], choices: { ANN: 'Ann' } },
    ...extra,
  ] });
const PHL = county('phl', 'Philadelphia');
const ALL = county('all', 'Allegheny');
const gov = (a, b) => ({ feed_id: 'G', feed_name: 'Governor', choices: [{ name: 'JOSH SHAPIRO', votes: a }, { name: 'STACY GARRITY', votes: b }] });
const house = { feed_id: 'H', feed_name: 'House 1', choices: [{ name: 'ANN', votes: 10 }] };
const src = (contests, extra = {}) => ({ record: { read: readOf(contests), fetched: NOW }, checked: true, sched: {}, ...extra });
const refused = { record: null, checked: true, sched: { stopped: 'refused' } };
const file = (maps, srcs, mode = 'public') => buildStateFile({ state: 'PA', maps, srcs, mode, now: NOW });

test('statewide slice: with the state refused, the race shows one county\'s count, named, never summed, never called', () => {
  const f = file([PHL, STATE, ALL], { phl: src([gov(500000, 100000), house]), 'results-PA': refused, all: src([gov(300000, 200000), house]) });
  const x = f.items['pa-governor'];
  assert.equal(x.status, 'counting');
  assert.equal(x.source, 'phl', 'the largest county\'s count on top');
  assert.equal(x.total_votes, 600000, 'Philadelphia\'s count alone, not 600,000 + 500,000');
  assert.deepEqual(x.slices.map((s) => [s.source, s.county, s.total_votes]), [['phl', 'Philadelphia', 600000], ['all', 'Allegheny', 500000]]);
  assert.deepEqual(x.missing, ['other counties'], 'never the whole state');
  assert.equal(x.final, null);
  assert.deepEqual(checkFile(f), []);
  assert.equal(f.sources.find((s) => s.id === 'results-PA').note, 'source refused us');
});

test('statewide slice: even marked complete, a county\'s share never reads as the race done', () => {
  const done = { ...PHL, count_closes: '2026-11-04T00:00:00Z', complete_marker: { flag: 'final_flag' } };
  const r = src([gov(500000, 100000), house]);
  r.record.read.source_status = 'final_flag';
  const f = file([done, STATE], { phl: r, 'results-PA': refused });
  const x = f.items['pa-governor'];
  assert.equal(x.status, 'counting', 'other counties are missing, so the race is still counting');
  assert.equal(x.final, null);
  assert.equal(f.items['phl-house'].status, 'complete', 'the county\'s own race is done');
});

test('statewide slice: with the state\'s numbers in, the county rides beneath as a county slice', () => {
  const f = file([PHL, STATE], { phl: src([gov(500000, 100000), house]), 'results-PA': src([{ feed_id: '3:1', feed_name: 'Governor', choices: [{ name: 'JOSH SHAPIRO', votes: 3000000 }, { name: 'STACY GARRITY', votes: 2500000 }] }]) });
  const x = f.items['pa-governor'];
  assert.equal(x.source, 'results-PA');
  assert.equal(x.total_votes, 5500000);
  assert.equal(x.slices, undefined);
  assert.deepEqual(x.county_slices.map((s) => [s.source, s.county, s.total_votes]), [['phl', 'Philadelphia', 600000]]);
  assert.deepEqual(checkFile(f), []);
});

test('statewide slice: with no county numbers, the state\'s own link (or numbers) stands, never a county\'s "not posted yet"', () => {
  // The county not read yet, its race missing from its feed, its count still zero, the county refused, or not checked:
  // each time the item is the state's link.
  const cases = {
    'not read yet': { phl: { record: null, checked: true, sched: {} } },
    'missing from its feed': { phl: src([house]) },
    'zero votes': { phl: src([gov(0, 0), house]) },
    'county refused': { phl: refused },
    'county not checked': { phl: { ...src([gov(500000, 100000), house]), checked: false } },
  };
  for (const [why, s] of Object.entries(cases)) {
    const f = file([PHL, STATE], { ...s, 'results-PA': refused });
    const x = f.items['pa-governor'];
    assert.equal(x.status, 'link_only', why);
    assert.equal(x.source, 'results-PA', why);
    assert.equal(x.reason, 'source refused us', why);
    assert.equal(x.url, 'https://www.electionreturns.pa.gov/', why);
    assert.deepEqual(checkFile(f), [], why);
  }
  // The county's own races keep their usual behaviour: not read yet is "not posted yet", missing is a link.
  assert.equal(file([PHL, STATE], { phl: { record: null, checked: true, sched: {} }, 'results-PA': refused }).items['phl-house'].status, 'pending');
  assert.equal(file([PHL, STATE], { phl: src([gov(1, 1)]), 'results-PA': refused }).items['phl-house'].reason, 'not in the feed');
});

test('statewide slice: with the state not checked yet, the public file shows the checked county\'s share; the preview shows the state', () => {
  const srcs = { phl: src([gov(500000, 100000), house]), 'results-PA': src([{ feed_id: '3:1', feed_name: 'Governor', choices: [{ name: 'JOSH SHAPIRO', votes: 3000000 }, { name: 'STACY GARRITY', votes: 2500000 }] }], { checked: false }) };
  const pub = file([PHL, STATE], srcs).items['pa-governor'];
  assert.equal(pub.source, 'phl');
  assert.deepEqual(pub.missing, ['other counties']);
  const pv = file([PHL, STATE], srcs, 'preview').items['pa-governor'];
  assert.equal(pv.source, 'results-PA');
});

/* The lint's rule, both ways, on synthetic bundles shaped like the guide's. */
const stateBundle = { items: [{ id: 'pa-governor', kind: 'contest', level: 'state', vote_for: 1, candidates: [{ name: 'Josh Shapiro / Austin Davis' }, { name: 'Stacy Garrity / Jason Richey' }] }] };
const placeBundle = { items: [{ id: 'phl-house', kind: 'contest', level: 'state', vote_for: 1, candidates: [{ name: 'Ann' }] }], local: ['phl-house'] };
const lintMap = (slice, places = ['philadelphia-pa', 'state-PA']) => ({
  id: 'phl', state: 'PA', county: 'Philadelphia', guide: { places },
  contests: [{ feed_id: 'G', feed_name: 'Governor', item: 'pa-governor', kind: 'plurality', seats: 1, choices: GOV, ...slice }],
});
const lint = (m) => lintGuide(m, { bundles: Object.fromEntries(m.guide.places.map((p) => [p, p.startsWith('state-') ? stateBundle : placeBundle])), stateBundle });

test('map lint: a statewide item in a county map passes only as that county\'s slice', () => {
  assert.deepEqual(lint(lintMap({ statewide: true, reaches: ['Philadelphia', 'other counties'] })).errors, []);
  const bad = {
    'no "other counties"': { statewide: true, reaches: ['Philadelphia'] },
    'marked whole': { statewide: true, whole: true, reaches: ['Philadelphia', 'other counties'] },
    'not marked statewide': { reaches: ['Philadelphia', 'other counties'] },
  };
  for (const [why, slice] of Object.entries(bad)) assert.match(lint(lintMap(slice)).errors.join('\n'), /must be that county's slice/, why);
  assert.match(lint(lintMap({ statewide: true, reaches: ['Philadelphia', 'other counties'] }, ['philadelphia-pa'])).errors.join('\n'), /needs state-PA in guide\.places/);
  // `statewide` belongs only on a statewide item: not on the county's own races, not in a state map.
  const own = { id: 'phl', state: 'PA', county: 'Philadelphia', guide: { places: ['philadelphia-pa'] }, contests: [{ feed_id: 'H', feed_name: 'House 1', item: 'phl-house', kind: 'plurality', seats: 1, choices: { ANN: 'Ann' }, reaches: ['Philadelphia', 'other counties'], statewide: true }] };
  assert.match(lint(own).errors.join('\n'), /only for a statewide item/);
  const st = { ...lintMap({ statewide: true, whole: true, reaches: ['Pennsylvania'] }), scope: 'state', county: 'Pennsylvania' };
  assert.match(lint(st).errors.join('\n'), /only for a statewide item/);
});
