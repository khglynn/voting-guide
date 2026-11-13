/* A county's share of a statewide race (Kevin's call, Nov 4; AGENTS.md's results entry says where it is recorded):
   Philadelphia and Allegheny carry Pennsylvania's governor, Los Angeles County carries California's statewide races,
   each as that county's slice (reaches [county, "other counties"], statewide: true). Beneath the state's count when the
   state has numbers; on its own, named by county and never the whole race, when the state has no count to show
   (refused, a link, not checked yet, not read yet or at zero). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStateFile, sourceSlices } from '../src/merge.js';
import { checkFile, checkRead } from '../src/checks.js';
import { ADAPTERS } from '../src/adapters/index.js';
import { lintGuide } from '../bin/map-lint.mjs';
import { checkFingerprints, publishState } from '../src/tick.js';
import { fingerprint, statewideFingerprint, checkHash } from '../src/fingerprint.js';
import { MAPS } from '../src/maps.gen.js';
import { mapFor, fakeFetch, memStore } from './helpers.mjs';

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
    'an extra county': { statewide: true, reaches: ['Philadelphia', 'other counties', 'Invented County'] },
    'a duplicate': { statewide: true, reaches: ['Philadelphia', 'other counties', 'other counties'] },
    'another county instead of this one': { statewide: true, reaches: ['Bucks', 'other counties'] },
  };
  for (const [why, slice] of Object.entries(bad)) assert.match(lint(lintMap(slice)).errors.join('\n'), /must be that county's slice/, why);
  assert.match(lint(lintMap({ statewide: true, reaches: ['Philadelphia', 'other counties'] }, ['philadelphia-pa'])).errors.join('\n'), /needs state-PA in guide\.places/);
  // `statewide` belongs only on a statewide item: not on the county's own races, not in a state map.
  const own = { id: 'phl', state: 'PA', county: 'Philadelphia', guide: { places: ['philadelphia-pa'] }, contests: [{ feed_id: 'H', feed_name: 'House 1', item: 'phl-house', kind: 'plurality', seats: 1, choices: { ANN: 'Ann' }, reaches: ['Philadelphia', 'other counties'], statewide: true }] };
  assert.match(lint(own).errors.join('\n'), /only for a statewide item/);
  const st = { ...lintMap({ statewide: true, whole: true, reaches: ['Pennsylvania'] }), scope: 'state', county: 'Pennsylvania' };
  assert.match(lint(st).errors.join('\n'), /only for a statewide item/);
});
test('map lint: without the state\'s bundle a county map is refused, never linted blind', () => {
  // With no state bundle the governor looks like one of the county's own races and would pass marked wholly inside it.
  const blind = lintMap({ reaches: ['Philadelphia'] }, ['philadelphia-pa', 'state-PA']);
  const errs = lintGuide(blind, { bundles: { 'philadelphia-pa': placeBundle, 'state-PA': stateBundle }, stateBundle: null }).errors;
  assert.match(errs.join('\n'), /no state-PA bundle, so the lint can't tell a statewide item from this county's own races/);
  // A state map needs no state bundle of its own to be told apart from.
  const st = { ...lintMap({ whole: true, reaches: ['Pennsylvania'] }), scope: 'state', county: 'Pennsylvania' };
  assert.doesNotMatch(lintGuide(st, { bundles: { 'philadelphia-pa': placeBundle, 'state-PA': stateBundle }, stateBundle: null }).errors.join('\n'), /no state-PA bundle/);
});

test('statewide slice: a hand-edited map can\'t make a county\'s share the whole race at run time either', () => {
  // Marked whole and wholly inside Philadelphia, past the lint: the merge still reads it as Philadelphia's slice.
  const edited = { ...PHL, contests: PHL.contests.map((c) => (c.statewide ? { ...c, whole: true, reaches: ['Philadelphia'] } : c)) };
  const alone = file([edited, STATE], { phl: src([gov(500000, 100000), house]), 'results-PA': refused }).items['pa-governor'];
  assert.equal(alone.source, 'phl');
  assert.deepEqual(alone.missing, ['other counties'], 'never the whole state');
  assert.equal(alone.final, null);
  const beneath = file([edited, STATE], { phl: src([gov(5000000, 100000), house]), 'results-PA': src([{ feed_id: '3:1', feed_name: 'Governor', choices: [{ name: 'JOSH SHAPIRO', votes: 3000000 }, { name: 'STACY GARRITY', votes: 2500000 }] }]) }).items['pa-governor'];
  assert.equal(beneath.source, 'results-PA', 'the state\'s count stays the race, even with the county ahead of it');
  assert.deepEqual(beneath.county_slices.map((s) => s.source), ['phl']);
});

test('the three maps carry their statewide items only as county slices', () => {
  for (const id of ['philadelphia-pa', 'allegheny-pa', 'los-angeles-county-ca']) {
    const m = mapFor(id);
    const sw = m.contests.filter((c) => c.statewide);
    assert.ok(sw.length > 0, `${id} carries statewide slices`);
    assert.ok(m.guide.places.includes(`state-${m.state}`), `${id} lists its state's bundle`);
    for (const c of sw) {
      assert.equal(c.whole, undefined, `${id} ${c.item}`);
      assert.deepEqual(c.reaches, [m.county, 'other counties'], `${id} ${c.item}`);
    }
  }
  // A statewide fingerprint exactly where there are statewide slices (bin/map-check.mjs --write writes it).
  for (const m of MAPS) {
    const has = (m.contests || []).some((c) => c.statewide);
    if (has) assert.match(m.guide?.statewide_fingerprint || '', /^[0-9a-f]{16}$/, m.id);
    else assert.equal(m.guide?.statewide_fingerprint, undefined, m.id);
  }
});

/* The guide bundles a map was made against, rebuilt from the map itself (each item's kind, seats and candidate names,
   or a measure's threshold); statewide items go in the state's bundle, the rest in the map's first place. */
function bundlesFrom(map) {
  const out = Object.fromEntries(map.guide.places.map((p) => [p, { items: [] }]));
  const first = map.guide.places.find((p) => !p.startsWith('state-'));
  for (const mc of map.contests) {
    const names = [...new Set(Object.values(mc.choices || {}).filter((v) => v && !['yes', 'no', '__other', '__skip'].includes(v)))];
    const it = mc.kind === 'measure' ? { id: mc.item, kind: 'measure', pass_threshold: mc.pass_threshold || null }
      : { id: mc.item, kind: 'contest', is_retention: mc.kind === 'retention', vote_for: mc.seats || 1, candidates: names.map((name) => ({ name })) };
    out[mc.statewide ? `state-${map.state}` : first].items.push(it);
  }
  return out;
}
const madeAgainst = async (map, b) => ({ ...map, guide: { ...map.guide, fingerprint: await fingerprint(map, b), statewide_fingerprint: await statewideFingerprint(map, b) } });
const bundleFetch = (b) => async (url) => ({ ok: true, json: async () => structuredClone(b[url.match(/\/data\/(?:place-)?(.+)\.json$/)[1]]) });
const editItem = (b, id, fn) => { const c = structuredClone(b); for (const x of Object.values(c)) for (const it of x.items) if (it.id === id) fn(it); return c; };

test('fingerprints: a county map\'s own races and its statewide slices hash apart', async () => {
  const la = mapFor('los-angeles-county-ca');
  const b = bundlesFrom(la);
  const own = await fingerprint(la, b);
  const sw = await statewideFingerprint(la, b);
  const prop = editItem(b, 'ca-prop-44', (it) => { it.pass_threshold += ' '; });
  assert.equal(await fingerprint(la, prop), own, 'a state item\'s change leaves the own-races hash alone');
  assert.notEqual(await statewideFingerprint(la, prop), sw);
  const localId = la.contests.find((c) => !c.statewide && c.kind === 'plurality').item;
  const local = editItem(b, localId, (it) => { it.candidates[0].name += ' Jr.'; });
  assert.notEqual(await fingerprint(la, local), own);
  assert.equal(await statewideFingerprint(la, local), sw, 'a local item\'s change leaves the statewide hash alone');
  assert.equal(await statewideFingerprint(mapFor('travis-tx'), {}), null, 'no statewide slices, no statewide hash');
});

/* End to end on real reads: Los Angeles County's own file (Nov 3, 8:17 PM PT bulletin) with the SOS media files
   (Nov 4, 6:27 AM PT), and Allegheny's Clarity files (Nov 4, version 384942, a paced read) with Pennsylvania refused. */
const LA_ROUTES = { 'GetCounterData?electionID=4348': 'la-county.counterdata.json', 'GetElectionData?electionID=4348': 'la-county.electiondata.json' };
const MEDIA = ['governor', 'lieutenant-governor', 'secretary-of-state', 'controller', 'treasurer', 'attorney-general', 'insurance-commissioner', 'superintendent-of-public-instruction', 'supreme-court', 'ballot-measures', 'board-of-equalization', 'us-rep'];
const CA_ROUTES = Object.fromEntries(MEDIA.map((f) => [`/media/${f}.json`, `ca-media.${f}.json`]));
const ALL_ROUTES = { '/127287/current_ver.txt': 'clarity-allegheny-nov4.current_ver.txt', '/127287/384942/json/en/summary.json': 'clarity-allegheny-nov4.summary.json', '/127287/384942/json/en/electionsettings.json': 'clarity-allegheny-nov4.electionsettings.json' };
const readWith = async (id, routes) => { const map = mapFor(id); const { raw, ...read } = await ADAPTERS[map.feed.adapter].read({ fetch: fakeFetch(routes), map }); assert.equal(checkRead(read, map).ok, true, id); return { map, read }; };

test('real reads: Los Angeles County\'s share of California\'s statewide races, alone when the state is refused, beneath it when not', async () => {
  const la = await readWith('los-angeles-county-ca', LA_ROUTES);
  const ca = await readWith('results-CA', CA_ROUTES);
  const { problems, slices } = sourceSlices(la.read, la.map, NOW);
  assert.deepEqual(problems, []);
  const sw = la.map.contests.filter((c) => c.statewide);
  assert.equal(sw.length, 25);
  for (const c of sw) { assert.ok(slices[c.item], c.item); assert.equal(slices[c.item].unmatched, undefined, `${c.item}: every feed choice listed`); }
  const at = (mode, caSrc) => buildStateFile({ state: 'CA', maps: [la.map, ca.map], srcs: { 'los-angeles-county-ca': { record: { read: la.read, fetched: NOW }, checked: true, sched: {} }, 'results-CA': caSrc }, mode, now: NOW });
  // The state refused: Los Angeles County's own count, named, never the whole race.
  let f = at('public', { record: null, checked: true, sched: { stopped: 'refused' } });
  assert.deepEqual(checkFile(f), []);
  for (const c of sw) {
    const x = f.items[c.item];
    assert.equal(x.source, 'los-angeles-county-ca', c.item);
    assert.deepEqual(x.missing, ['other counties'], c.item);
    assert.equal(x.final, null, c.item);
    assert.equal(x.slices.length, 1, c.item);
    assert.equal(x.slices[0].county, 'Los Angeles', c.item);
  }
  assert.equal(f.items['ca-governor'].total_votes, slices['ca-governor'].total_votes);
  assert.equal(f.items['ca-coa-2d-retention'].status, 'link_only', 'a statewide race Los Angeles doesn\'t carry stays the state\'s link');
  assert.equal(f.items['ca-coa-2d-retention'].source, 'results-CA');
  // The state's numbers in: the state's count is the race, Los Angeles rides beneath.
  f = at('public', { record: { read: ca.read, fetched: NOW }, checked: true, sched: {} });
  assert.deepEqual(checkFile(f), []);
  for (const c of sw) {
    const x = f.items[c.item];
    assert.equal(x.source, 'results-CA', c.item);
    assert.equal(x.slices, undefined, c.item);
    assert.deepEqual(x.county_slices.map((s) => s.source), ['los-angeles-county-ca'], c.item);
  }
  assert.ok(f.items['ca-prop-1'].measure.yes > f.items['ca-prop-1'].county_slices[0].measure.yes);
});

test('real reads: Allegheny\'s share of Pennsylvania\'s governor with the state refused', async () => {
  const all = await readWith('allegheny-pa', ALL_ROUTES);
  const f = buildStateFile({ state: 'PA', maps: [all.map, mapFor('philadelphia-pa'), mapFor('results-PA')], srcs: { 'allegheny-pa': { record: { read: all.read, fetched: NOW }, checked: true, sched: {} }, 'philadelphia-pa': { record: null, checked: true, sched: {} }, 'results-PA': { record: null, checked: true, sched: { stopped: 'refused' } } }, mode: 'public', now: NOW });
  assert.deepEqual(checkFile(f), []);
  const x = f.items['pa-governor'];
  assert.equal(x.source, 'allegheny-pa');
  assert.deepEqual(x.candidates.map((c) => [c.name, c.votes]), [['Josh Shapiro / Austin Davis', 367885], ['Stacy Garrity / Jason Richey', 142598], ['Ken Krawchuk / John Thomas', 5513]]);
  assert.deepEqual(x.missing, ['other counties']);
  assert.equal(x.final, null);
  assert.equal(x.slices[0].county, 'Allegheny');
});

/* Verdict 3 of the statewide review (Nov 4): a guide edit to a statewide item used to mark the whole county map out of
   date, turning all of Los Angeles County's live local races into links. Now only its statewide slices drop out. Runs
   the Worker's own hourly check and publish on the saved Los Angeles and SOS reads. */
test('real reads: a changed state-CA item drops only Los Angeles County\'s statewide slices; its own races stay live', async () => {
  const la0 = await readWith('los-angeles-county-ca', LA_ROUTES);
  const ca = await readWith('results-CA', CA_ROUTES);
  const bundles = bundlesFrom(la0.map);
  const la = await madeAgainst(la0.map, bundles);
  const LA = la.id;
  const run = async (b, { caRefused = false } = {}) => {
    const pings = [];
    const ping = async (id, reason) => { pings.push(`${id}: ${reason}`); };
    const sched = { sources: caRefused ? { 'results-CA': { stopped: 'refused' } } : {}, meta: {} };
    await checkFingerprints({ maps: [la], fetch: bundleFetch(b), sched, now: NOW, ping });
    const store = memStore({
      [`src:${LA}`]: JSON.stringify({ read: la0.read, fetched: NOW }),
      [`checked:${LA}`]: await checkHash(la),
      'checked:results-CA': await checkHash(ca.map),
      ...(caRefused ? {} : { 'src:results-CA': JSON.stringify({ read: ca.read, fetched: NOW }) }),
    });
    const out = await publishState({ state: 'CA', maps: [la, ca.map], store, sched, now: NOW, ping, log: () => {} });
    assert.equal(out.public, true, JSON.stringify(out));
    return { sched, pings, file: JSON.parse(await store.get('file:CA')) };
  };
  // Where Los Angeles County's count shows in an item: as the item, or as a slice beside or beneath another count.
  const fromLA = (x) => !!x && x.status !== 'link_only' && (x.source === LA || (x.slices || []).some((s) => s.source === LA) || (x.county_slices || []).some((s) => s.source === LA));
  const own = la.contests.filter((c) => !c.statewide).map((c) => c.item);
  const sw = la.contests.filter((c) => c.statewide).map((c) => c.item);
  const liveOwn = (f) => own.filter((id) => fromLA(f.items[id]));

  const before = await run(bundles);
  assert.deepEqual([before.sched.meta.fp[LA], before.sched.meta.fp_sw[LA]], ['ok', 'ok']);
  assert.deepEqual(before.pings, []);
  assert.ok(liveOwn(before.file).length >= 90, `${liveOwn(before.file).length} of Los Angeles County's own races live`);
  for (const id of sw) assert.ok(fromLA(before.file.items[id]), `${id}: Los Angeles's share beneath the state's count`);

  // The guide edits one state item (a measure's threshold): the statewide hash moves, the own-races hash doesn't.
  const edited = editItem(bundles, 'ca-prop-44', (it) => { it.pass_threshold = `${it.pass_threshold} `; });
  const after = await run(edited);
  assert.deepEqual([after.sched.meta.fp[LA], after.sched.meta.fp_sw[LA]], ['ok', 'mismatch']);
  assert.deepEqual(after.pings, [`${LA}: statewide slices out of date`]);
  assert.deepEqual(liveOwn(after.file), liveOwn(before.file), 'every one of the county\'s own races stays live');
  for (const id of own) assert.notEqual(after.file.items[id]?.reason, 'map out of date', id);
  for (const id of sw) {
    const x = after.file.items[id];
    assert.equal(x.source, 'results-CA', id);
    assert.equal(fromLA(x), false, `${id}: the county's statewide slice is left out`);
    // The state's own result is untouched; only Los Angeles's slice (and any "behind Los Angeles" note) is gone.
    const { county_slices: _cs, note: _n1, ...was } = before.file.items[id];
    const { note: _n2, ...now } = x;
    assert.deepEqual(now, was, `${id}: the state's own result is unchanged`);
  }

  // The state refused: those races are the state's link, never Los Angeles's share; the county's own races stay live.
  const refused = await run(edited, { caRefused: true });
  for (const id of sw) {
    const x = refused.file.items[id];
    assert.equal(x.status, 'link_only', id);
    assert.equal(x.source, 'results-CA', id);
    assert.equal(x.reason, 'source refused us', id);
  }
  assert.ok(liveOwn(refused.file).length >= 90);

  // Unchanged: an edit to one of the county's own items still links out the whole map until it is remade.
  const localId = la.contests.find((c) => !c.statewide && c.kind === 'plurality').item;
  const ownEdit = await run(editItem(bundles, localId, (it) => { it.candidates[0].name += ' Jr.'; }));
  assert.equal(ownEdit.sched.meta.fp[LA], 'mismatch');
  assert.deepEqual(liveOwn(ownEdit.file), []);
  assert.equal(ownEdit.file.items[localId].reason, 'map out of date');
});

/* Verdict 5 of the statewide review (Nov 4): with the state's whole-race count unread or at zero, a county's share used
   to list the state map's reaches ("Pennsylvania", "California", "all 58 California counties") as missing counties. */
test('statewide slice: with the state\'s count unread or at zero, the missing list names counties only, never the state', () => {
  const both = { phl: src([gov(500000, 100000), house]), all: src([gov(300000, 200000), house]) };
  const cases = {
    'state not read yet': { record: null, checked: true, sched: {} },
    'state at zero': src([{ feed_id: '3:1', feed_name: 'Governor', choices: [{ name: 'JOSH SHAPIRO', votes: 0 }, { name: 'STACY GARRITY', votes: 0 }] }]),
  };
  for (const [why, st] of Object.entries(cases)) {
    for (const order of [[PHL, STATE], [STATE, PHL]]) {
      const f = file(order, { phl: both.phl, 'results-PA': st });
      const x = f.items['pa-governor'];
      assert.equal(x.source, 'phl', why);
      assert.deepEqual(x.missing, ['other counties'], why);
      assert.equal(x.status, 'counting', why);
      assert.equal(x.final, null, why);
      assert.deepEqual(checkFile(f), [], why);
    }
    const f = file([PHL, STATE, ALL], { ...both, 'results-PA': st });
    const x = f.items['pa-governor'];
    assert.deepEqual(x.slices.map((s) => s.county), ['Philadelphia', 'Allegheny'], why);
    assert.deepEqual(x.missing, ['other counties'], why);
    assert.deepEqual(checkFile(f), [], why);
  }
});

test('real reads: with the SOS count unread or at zero, Los Angeles County\'s shares list no state or "all 58 counties" as missing', async () => {
  const la = await readWith('los-angeles-county-ca', LA_ROUTES);
  const ca = await readWith('results-CA', CA_ROUTES);
  const zeroed = structuredClone(ca.read);
  for (const c of zeroed.contests) for (const ch of c.choices) ch.votes = 0;
  const sw = la.map.contests.filter((c) => c.statewide);
  const cases = {
    'SOS not read yet': { record: null, checked: true, sched: {} },
    'SOS at zero': { record: { read: zeroed, fetched: NOW }, checked: true, sched: {} },
  };
  for (const [why, caSrc] of Object.entries(cases)) {
    const f = buildStateFile({ state: 'CA', maps: [la.map, ca.map], srcs: { 'los-angeles-county-ca': { record: { read: la.read, fetched: NOW }, checked: true, sched: {} }, 'results-CA': caSrc }, mode: 'public', now: NOW });
    assert.deepEqual(checkFile(f), [], why);
    for (const c of sw) {
      const x = f.items[c.item];
      assert.equal(x.source, 'los-angeles-county-ca', `${why}: ${c.item}`);
      assert.deepEqual(x.missing, ['other counties'], `${why}: ${c.item}`);
      assert.equal(x.final, null, `${why}: ${c.item}`);
    }
    // Every missing name in the file is a county or "other counties": never the state, never "all 58 ... counties".
    for (const [id, x] of Object.entries(f.items)) for (const n of x.missing || []) assert.ok(n !== 'California' && !/^(all \d+|every) /.test(n), `${why}: ${id} lists "${n}" as missing`);
    // A House race Los Angeles shares with Ventura still names Ventura.
    assert.deepEqual(f.items['ca-us-house-26'].missing, ['Ventura', 'other counties'], why);
  }
});
