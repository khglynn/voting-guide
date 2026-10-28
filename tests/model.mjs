#!/usr/bin/env node
/*
 * Model tests: the contracts the views must never break, checked without a browser.
 *
 *   npm run data && node tests/model.mjs        (reads the built bundles in public/data/)
 *
 * Loads the real TypeScript modules through Vite's SSR loader (no new dependencies) and feeds
 * them the real data bundles. What it guards:
 *   - the save link: v1 and v2 formats byte for byte, the pinned pre-ranked-choice v1 link from
 *     the live site, round trips, the optional notMine field
 *   - normalizeRanks migrations, rank order, ranked races never filled by a bulk action
 *   - district filtering and the "every voter sees each seat" rule
 *   - lens membership, the verdict for every state of a lineup, the bulk fills and their undo
 * Exit code 1 if anything fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'public', 'data');
if (!fs.existsSync(path.join(DATA, 'index.json'))) {
  console.error('No built data. Run `npm run data` first.');
  process.exit(2);
}
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const INDEX = read('index.json');

const vite = await createServer({ root: ROOT, configFile: false, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
const load = (p) => vite.ssrLoadModule(p);
const st = await load('/src/state.ts');
const bl = await load('/src/ballot.ts');
const util = await load('/src/util.ts');
const geo = await load('/src/geo.ts');
const common = await load('/src/views/common.ts');
const mods = {};
for (const m of ['lens', 'tally', 'bulk', 'judges', 'labels', 'plan', 'address', 'coverage']) {
  const f = path.join(ROOT, 'src', 'model', `${m}.ts`);
  if (fs.existsSync(f)) mods[m] = await load(`/src/model/${m}.ts`);
}
/* The string views the ledger paints (no DOM needed to build their HTML). */
const views = {};
for (const v of ['ledger', 'cheat', 'open', 'lens', 'mast', 'setup', 'pass', 'planstrip', 'shelf', 'coverage']) views[v] = await load(`/src/views/${v}.ts`);
views.errors = await load('/src/errors.ts'); // not a view: the errors a problem report sends along (the shelf reads it)
views.scrub = await load('/src/scrub.ts'); // not a view: what a crash report may carry (sentry.ts runs every event through it)

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? `  (${extra})` : ''}`); };

/* Build a ballot the way the app does and make it the current one. */
function open(stCode, placeIds, b = null) {
  const sb = read(`state-${stCode}.json`);
  const pbs = placeIds.map((id) => read(`place-${id}.json`));
  const ballot = bl.buildBallot(sb, pbs);
  st.S.ballot = ballot;
  st.S.b = b || st.emptyBallotState('');
  return ballot;
}
const head = (link) => st.parseShareHead(link);

/* ---------- 0. the address lookup adds the state and ZIP the guide already knows ---------- */
{
  const w = geo.withPlace;
  check('Address: a bare street gets the state and ZIP', w('2 Main St', 'TX', '78701') === '2 Main St, TX 78701', w('2 Main St', 'TX', '78701'));
  check('Address: a street with a city gets the state and ZIP after it', w('2 Main St, Austin', 'TX', '78701') === '2 Main St, Austin, TX 78701');
  check('Address: one that ends in a ZIP is left alone', w('2 Main St, Austin, TX 78702', 'TX', '78701') === '2 Main St, Austin, TX 78702');
  check('Address: one that ends in the state gets only the ZIP', w('2 Main St Austin TX', 'TX', '78701') === '2 Main St Austin TX 78701' && w('2 Main St, Austin, Texas', 'TX', '78701') === '2 Main St, Austin, Texas 78701');
  check('Address: with no ZIP known, the state alone', w('2 Main St', 'CO', null) === '2 Main St, CO');
  check('Address: trailing commas and spaces are trimmed', w('2 Main St, ', 'CO', '80205') === '2 Main St, CO 80205');
}

/* ---------- 0b. a publication sided only by its own mission sits with the groups, off by default ---------- */
{
  const lens = await load('/src/model/lens.ts');
  const b = open('CA', ['los-angeles-ca']);
  const knock = b.endorsers.find((e) => e.id === 'knock-la');
  const ids = (k) => lens.chipMembers(b, k).map((e) => e.id);
  check('Lens: Knock LA is off by default', !!knock && knock.default_on === false, JSON.stringify(knock && { d: knock.default_on, k: knock.lean_basis_kind }));
  check('Lens: Knock LA is a progressive group, not a newspaper', ids('progressive').includes('knock-la') && !ids('papers').includes('knock-la'));
  check('Lens: papers rated from outside stay in the default', ['la-times-eb', 'sac-bee-eb'].some((id) => ids('papers').includes(id)), ids('papers').join(','));
}

/* ---------- 1. the pinned v1 link from the live site (DC Ward 1, before ranked choice) ---------- */
{
  const OLD = '#v1~DC~dc-ward-1~20010~l0g49h8j.it941rdf.3z3i9P.ik2ysP.1rq6ag1n~~l0g49T2xkIGxpbmsgbm90ZQ~';
  const h = head(OLD);
  check('old v1 link: head parses', !!h && h.v === 1 && h.st === 'DC' && h.places.join() === 'dc-ward-1' && h.zip === '20010');
  const ballot = open('DC', ['dc-ward-1']);
  const { state, dropped } = st.decodeShare(ballot, h);
  st.normalizeRanks(ballot, state);
  const n = Object.keys(state.picks).length + Object.keys(state.ranks).filter((k) => !(k in state.picks)).length;
  check('old v1 link: restores 3 picks', n === 3, `${n} picks, ${dropped} dropped: ${JSON.stringify(state.picks)} ${JSON.stringify(state.ranks)}`);
  check('old v1 link: Ward 1 pick becomes the 1st choice', (state.ranks['dc-ward-1-council'] || []).join() === 'Aparna Raj' && state.picks['dc-ward-1-council'] === 'DONE');
  check('old v1 link: Mayor pick becomes the 1st choice', (state.ranks['dc-mayor'] || []).join() === 'Rhonda Hamilton');
  check('old v1 link: Chair restores as a pick', /^Phil Mendelson/.test(state.picks['dc-council-chair'] || ''));
  check('old v1 link: at-large seat marks are cleared to rank again', !Object.keys(state.picks).some((k) => k.startsWith('dc-council-at-large|')) && !state.ranks['dc-council-at-large']);
  check('old v1 link: the note comes back', state.notes['dc-ward-1-council'] === 'Old link note' || Object.values(state.notes).includes('Old link note'), JSON.stringify(state.notes));
  check('old v1 link: notMine stays empty (no field)', state.notMine.length === 0);
}

/* ---------- 2. round trips ---------- */
function roundTrip(name, stCode, places, mutate) {
  const ballot = open(stCode, places);
  const b = st.emptyBallotState('99999');
  mutate(b, ballot);
  const link = st.encodeShare(ballot, b);
  const { state } = st.decodeShare(ballot, head(link));
  return { ballot, b, link, state };
}
{
  // Denver: picks, a measure, a skip, a note, a district answer, custom sources. No ranks: must be v1.
  const r = roundTrip('denver', 'CO', ['denver-co'], (b, ballot) => {
    const races = ballot.items.filter((i) => i.kind === 'contest' && i.candidates.length > 1 && !i.is_retention && !i.ranked_choice && i.vote_for === 1);
    b.picks[races[0].id] = races[0].candidates[1].name;
    b.picks[races[1].id] = 'SKIP';
    const m = ballot.items.find((i) => i.kind === 'measure');
    b.picks[m.id] = 'NO';
    const j = ballot.items.find((i) => i.kind === 'contest' && i.is_retention);
    b.picks[j.id] = 'YES';
    b.notes[m.id] = 'A note with ünïcode and ~tildes~ and dots.';
    if (ballot.groups[0]) b.districts[ballot.groups[0].key] = ballot.groups[0].members[1];
    b.sources = ballot.endorsers.slice(0, 3).map((e) => e.id);
  });
  check('round trip: no ranks gives a v1 link', r.link.startsWith('v1~CO~denver-co~99999~'), r.link.slice(0, 40));
  check('round trip: v1 link has exactly 8 fields', r.link.split('~').length === 8, String(r.link.split('~').length));
  check('round trip: picks come back identical', JSON.stringify(r.state.picks) === JSON.stringify(r.b.picks));
  check('round trip: notes come back identical', JSON.stringify(r.state.notes) === JSON.stringify(r.b.notes));
  check('round trip: districts come back identical', JSON.stringify(r.state.districts) === JSON.stringify(r.b.districts));
  check('round trip: sources come back identical', JSON.stringify(r.state.sources) === JSON.stringify(r.b.sources));
  // Sources off and defaults.
  const off = roundTrip('off', 'CO', ['denver-co'], (b) => { b.sources = []; });
  check('round trip: all sources off encodes as 0 and returns []', off.link.split('~')[7] === '0' && Array.isArray(off.state.sources) && off.state.sources.length === 0);
  const def = roundTrip('def', 'CO', ['denver-co'], () => {});
  check('round trip: default sources encode as empty and return null', def.link.split('~')[7] === '' && def.state.sources === null);
}
{
  // Portland: a ranking makes it v2; rank order survives.
  const r = roundTrip('portland', 'OR', ['portland-or'], (b, ballot) => {
    const g = ballot.groups.find((x) => x.key.includes('Council'));
    b.districts[g.key] = 'portland-council-3';
    b.ranks['portland-council-3'] = ['Angelita Morillo', 'Steve Novick', 'Kellie Torres'];
    b.picks['portland-council-3'] = 'DONE';
  });
  check('round trip: a ranking gives a v2 link', r.link.startsWith('v2~OR~portland-or~99999~') && r.link.split('~').length === 9);
  check('round trip: ranks come back in order', (r.state.ranks['portland-council-3'] || []).join('|') === 'Angelita Morillo|Steve Novick|Kellie Torres');
}
{
  // Multi-judge and multi-seat per-candidate keys.
  const ca = open('CA', ['los-angeles-ca']);
  const mj = ca.items.find((i) => i.kind === 'contest' && i.is_retention && i.candidates.length > 1);
  if (mj) {
    const b = st.emptyBallotState('90004');
    mj.candidates.forEach((c, i) => { b.picks[`${mj.id}|${c.name}`] = i % 2 ? 'NO' : 'YES'; });
    const { state } = st.decodeShare(ca, head(st.encodeShare(ca, b)));
    check('round trip: multi-judge per-judge picks', mj.candidates.every((c, i) => state.picks[`${mj.id}|${c.name}`] === (i % 2 ? 'NO' : 'YES')));
  } else check('round trip: multi-judge contest found on LA', false);
  const co = open('CO', ['boulder-co']);
  const ms = co.items.find((i) => i.kind === 'contest' && bl.isMultiSeat(i));
  if (ms) {
    const b = st.emptyBallotState('80302');
    ms.candidates.slice(0, 2).forEach((c) => { b.picks[`${ms.id}|${c.name}`] = 'PICK'; });
    b.picks[ms.id] = 'DONE';
    const { state } = st.decodeShare(co, head(st.encodeShare(co, b)));
    check('round trip: multi-seat marks and Done', JSON.stringify(state.picks) === JSON.stringify(b.picks));
  } else check('round trip: multi-seat contest found on Boulder', false);
}

{
  // Golden: the exact bytes today's encoder writes for a fixed state, captured 2026-10-19 from the
  // v2 site before the ledger. If this changes, every saved link people hold changes meaning.
  const ballot = open('CO', ['lakewood-co']);
  const b = st.emptyBallotState('80226');
  b.picks = { 'co-us-senate': 'Golden Name', 'co-amendment-81': 'NO', 'co-amendment-82': 'YES', 'co-retention-loewer': 'SKIP' };
  b.notes = { 'co-amendment-81': 'Golden note' };
  b.districts = { 'state|State Senate': 'co-sd-22' };
  b.sources = ['denver-post-eb', 'lwv-colorado'];
  const GOLD = 'v1~CO~lakewood-co~80226~ra8yvi07.0e8wrN.adulqY.vpldxS~my33za6t20~0e8wrR29sZGVuIG5vdGU~mlkqq.v3egq';
  const got = st.encodeShare(ballot, b);
  check('golden: the v1 link is byte for byte what v2 wrote', got === GOLD, got);
  b.notMine = [];
  check('golden: an empty notMine adds nothing to the link', st.encodeShare(ballot, b) === GOLD);
  // "Hide races I've decided" (Oct 20) is saved on this device only: the link is the same either way.
  b.hideDecided = true;
  check('golden: "Hide races I\'ve decided" adds nothing to the link', st.encodeShare(ballot, b) === GOLD);
  check('hideDecided: a link never brings it, so a new ballot from a link starts with it off', st.decodeShare(ballot, head(GOLD)).state.hideDecided === false);
}

/* ---------- 2b. saved state: a field added since a save is back-filled; the new one is kept ---------- */
{
  // A tiny localStorage for util.load and util.save (the model has no browser).
  const mem = new Map();
  const had = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); } }, setTimeout, clearTimeout } });
  try {
    // A ballot saved before hideDecided existed (the live site's shape on Oct 19).
    const old = { zip: '80226', picks: { 'co-amendment-81': 'NO' }, ranks: {}, auto: {}, noAuto: [], notes: {}, districts: {}, notMine: [], sources: null, planSeen: true, offerDismissed: null, addrNote: null, party: null, ticks: [], setupDone: true };
    mem.set('vg2', JSON.stringify({ v: 1, last: { key: 'CO|lakewood-co', zip: '80226' }, prefs: st.S.prefs, ballots: { 'CO|lakewood-co': old } }));
    const back = st.savedBallot('CO|lakewood-co');
    check('hideDecided: an older save reads it as off, with every pick kept', !!back && back.hideDecided === false && back.picks['co-amendment-81'] === 'NO' && back.setupDone === true, JSON.stringify(back));
    // Turned on, it is saved with that ballot and comes back on.
    const ballot = open('CO', ['lakewood-co'], back);
    const view = st.S.view;
    st.S.view = 'ballot';
    st.S.b.hideDecided = true;
    st.persist(true);
    st.S.view = view;
    const again = st.savedBallot(ballot.key);
    check('hideDecided: turned on, it is saved with the ballot and reads back on', !!again && again.hideDecided === true && again.picks['co-amendment-81'] === 'NO', JSON.stringify(again && again.hideDecided));
    check('hideDecided: the save link from that ballot is unchanged', st.encodeShare(ballot, again) === st.encodeShare(ballot, { ...again, hideDecided: false }));
  } finally {
    if (had) Object.defineProperty(globalThis, 'window', had); else delete globalThis.window;
    st.S.b = st.emptyBallotState('');
  }
}

/* ---------- 3. normalizeRanks ---------- */
{
  const ballot = open('OR', ['portland-or']);
  const b = st.emptyBallotState('97214');
  b.picks['portland-council-3'] = 'Steve Novick';
  b.ranks['multnomah-chair'] = ['Nobody Real', 'Nobody Real'];
  const cleared = st.normalizeRanks(ballot, b);
  check('normalizeRanks: a pick-one choice on a ranked race becomes 1st choice', (b.ranks['portland-council-3'] || []).join() === 'Steve Novick' && b.picks['portland-council-3'] === 'DONE' && cleared === 0);
  check('normalizeRanks: unknown names drop out', !b.ranks['multnomah-chair']);
}

/* ---------- 4. districts ---------- */
{
  const ballot = open('TX', ['austin-tx']);
  const g = ballot.groups.find((x) => x.office.includes('City Council'));
  check('districts: Austin asks which council district', !!g && g.members.includes('tx-austin-council-3'));
  st.S.b.districts[g.key] = 'tx-austin-council-3';
  const ids = [...bl.entriesBySection().values()].flat().filter((e) => e.t === 'item').map((e) => e.id);
  check('districts: the answer shows District 3 and hides District 1', ids.includes('tx-austin-council-3') && !ids.includes('tx-austin-council-1'));
  st.S.b.districts[g.key] = '*';
  const all = [...bl.entriesBySection().values()].flat().filter((e) => e.t === 'item').map((e) => e.id);
  check('districts: "not sure" shows every member', g.members.every((m) => all.includes(m)));
}

/* ---------- 5. district maps (model/maps.ts, Oct 21) ---------- */
{
  const maps = await load('/src/model/maps.ts');
  const address = mods.address;
  const fc = (...features) => ({ type: 'FeatureCollection', features });
  const poly = (label, ...rings) => ({ type: 'Feature', properties: { label }, geometry: { type: 'Polygon', coordinates: rings } });
  const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  // pointIn: a square, a square with a hole, a MultiPolygon, and a map that overlaps itself.
  const unit = fc(poly('A', sq(0, 0, 1, 1)));
  check('maps: a point inside a unit square gets its label, one outside gets none', maps.pointIn(unit, 0.5, 0.5) === 'A' && maps.pointIn(unit, 1.5, 0.5) === null && maps.pointIn(unit, 0.5, -0.1) === null);
  const holed = fc(poly('H', sq(0, 0, 4, 4), sq(1, 1, 3, 3)));
  check('maps: a hole subtracts', maps.pointIn(holed, 0.5, 0.5) === 'H' && maps.pointIn(holed, 2, 2) === null && maps.pointIn(holed, 3.5, 2) === 'H');
  const multi = fc({ type: 'Feature', properties: { label: 'M' }, geometry: { type: 'MultiPolygon', coordinates: [[sq(0, 0, 1, 1)], [sq(2, 0, 3, 1)]] } });
  check('maps: a MultiPolygon answers in each of its parts, not between them', maps.pointIn(multi, 0.5, 0.5) === 'M' && maps.pointIn(multi, 2.5, 0.5) === 'M' && maps.pointIn(multi, 1.5, 0.5) === null);
  check('maps: where a map overlaps itself, it answers nothing', maps.pointIn(fc(poly('X', sq(0, 0, 2, 2)), poly('Y', sq(1, 1, 3, 3))), 1.5, 1.5) === null);
  // fromTopo: two squares sharing one arc, quantized and delta-encoded, the right one reading it backwards.
  const topo = { type: 'Topology', transform: { scale: [1, 1], translate: [0, 0] },
    arcs: [[[1, 0], [0, 1]], [[1, 1], [-1, 0], [0, -1], [1, 0]], [[1, 0], [1, 0], [0, 1], [-1, 0]]],
    objects: { t: { type: 'GeometryCollection', geometries: [{ type: 'Polygon', arcs: [[1, 0]], properties: { label: 'L' } }, { type: 'Polygon', arcs: [[-1, 2]], properties: { label: 'R', n: 7 } }] } } };
  const tf = maps.fromTopo(topo);
  check('maps: TopoJSON decodes, shared border and all', tf.features.length === 2 && maps.pointIn(tf, 0.5, 0.5) === 'L' && maps.pointIn(tf, 1.5, 0.5) === 'R' && maps.pointIn(tf, 2.5, 0.5) === null && tf.features[1].properties.n === '7', JSON.stringify(tf.features.map((f) => f.geometry.coordinates)));
  // Two witnesses, on two squares about a kilometre wide in Austin, the line between them at lon -97.74.
  const two = fc(poly('W', sq(-97.75, 30.26, -97.74, 30.27)), poly('E', sq(-97.74, 30.26, -97.73, 30.27)));
  const at = (pt, bk) => maps.answerAt(two, { point: { lon: pt[0], lat: pt[1] }, block: bk ? { lon: bk[0], lat: bk[1] } : null });
  const deepE = [-97.735, 30.265];
  const a1 = at([-97.7451, 30.265], [-97.746, 30.2655]);
  check('maps: both witnesses in one district: that district', a1.at === 'in' && a1.props.label === 'W' && a1.by === 'both');
  const a2 = at([-97.74005, 30.265], deepE); // the address point about 5 m west of the line, its block deep in E
  check('maps: the address point at a line, its block across it: the block’s district', a2.at === 'in' && a2.props.label === 'E' && a2.by === 'block', JSON.stringify(a2));
  const a3 = at([-97.742, 30.265], deepE); // 190 m from the line, and the block says otherwise
  check('maps: the witnesses disagree away from any line: no guess', a3.at === 'near', JSON.stringify(a3));
  check('maps: one witness near a line: no guess; well inside: its district', at([-97.74005, 30.265]).at === 'near' && at([-97.745, 30.265]).at === 'in');
  check('maps: an address outside every district: out', at([-97.8, 30.265], [-97.8001, 30.2651]).at === 'out');
  check('maps: edge distance is in metres', Math.abs(maps.edgeDistance(two, -97.7405, 30.265) - 48) < 1, String(maps.edgeDistance(two, -97.7405, 30.265)));
  check('maps: a template fills from a feature, and a missing property fills nothing', maps.fillTemplate('Precinct {jp}', { jp: '5' }) === 'Precinct 5' && maps.fillTemplate('Precinct {jp}', {}) === null);
  check('maps: "Precinct 4 (unexpired term)" is Precinct 4', maps.normDistrict('Precinct 4 (unexpired term)') === maps.normDistrict('Precinct 4'));

  // setFromAddress with a fake council map, on and off.
  const ballot = open('TX', ['austin-tx']);
  const council = ballot.groups.find((x) => x.office === 'Austin City Council Member');
  const fake = { kind: 'council', file: 'maps/test/council.topo.json', bytes: 1, name: 'council district', title: 'test', county: null, shows: null, source_url: 'https://example.org', source_org: 'test', layer_dated: null, fetched: '2026-10-21',
    settles: [{ office: '^Austin City Council Member$', district: 'District {label}' }] };
  const none = { cd: null, upper: null, lower: null };
  let set = address.setFromAddress(ballot, st.S.b, none, [{ meta: fake, props: { label: '3' } }]);
  check('maps: a council map answering 3 answers the council question, and the line names it', st.S.b.districts[council.key] === 'tx-austin-council-3' && st.S.b.addrSet.includes(council.key) && set.join('|') === 'Austin City Council, District 3', set.join('|'));
  set = address.setFromAddress(ballot, st.S.b, none, [{ meta: fake, props: { label: '2' } }]);
  check('maps: a district with no race this year answers "none", and the line names nothing', st.S.b.districts[council.key] === 'none' && !set.length, set.join('|'));
  // A "may apply" race, on and off: Travis's one constable race, from the precinct map's JP code.
  const pm = ballot.places[0].maps.find((m) => m.kind === 'precincts');
  // (In Travis County, as the Census says: a county's map answers only for its own county's addresses.)
  set = address.setFromAddress(ballot, st.S.b, { ...none, county: 'Travis' }, [{ meta: pm, props: { label: '1', commissioner: '4', jp: '4', sboe: '5' } }]);
  check('maps: the precinct map puts the constable race on in its precinct, with commissioner, JP and SBOE', st.S.b.mine.includes('tx-travis-constable-4') && st.S.b.mine.includes('tx-sboe-5')
    && st.S.b.districts['county|County Commissioner'] === 'tx-travis-commissioner-4' && st.S.b.districts['judicial|Justice of the Peace'] === 'tx-travis-jp-4'
    && set.join(' · ') === 'State Board of Education, District 5 · County Commissioner, Precinct 4 · Justice of the Peace, Precinct 4 · Constable, Precinct 4', set.join(' · '));
  address.setFromAddress(ballot, st.S.b, { ...none, county: 'Travis' }, [{ meta: pm, props: { label: '2', commissioner: '3', jp: '5', sboe: '10' } }]);
  check('maps: and off everywhere else', st.S.b.notMine.includes('tx-travis-constable-4') && !st.S.b.mine.includes('tx-travis-constable-4') && st.S.b.notMine.includes('tx-sboe-5') && st.S.b.districts['county|County Commissioner'] === 'none');
  // The Census puts you in Williamson County: the Travis map's county races are off without looking.
  st.S.b = st.emptyBallotState('');
  address.setFromAddress(ballot, st.S.b, { ...none, county: 'Williamson' }, []);
  check('maps: another county’s address takes a county map’s own races off, and leaves SBOE alone', st.S.b.districts['county|County Commissioner'] === 'none' && st.S.b.districts['judicial|Justice of the Peace'] === 'none' && st.S.b.notMine.includes('tx-travis-constable-4') && !st.S.b.notMine.includes('tx-sboe-5') && st.S.b.districts['city|Austin City Council Member'] === undefined);
  // A trustee map stays out of a school district the Census says isn't yours.
  st.S.b = st.emptyBallotState('');
  const dv = ballot.places[0].maps.find((m) => m.kind === 'dvisd-trustee');
  address.setFromAddress(ballot, st.S.b, { ...none, schools: ['Austin Independent School District'] }, [{ meta: dv, props: { label: '7' } }]);
  check('maps: a Del Valle trustee map can’t put an Austin ISD address in Del Valle', st.S.b.districts['school|Del Valle ISD Trustee'] === 'none', JSON.stringify(st.S.b.districts));
  // Pflugerville's commissioner question mixes Travis and Williamson races: a Travis answer settles it.
  const pf = open('TX', ['pflugerville-tx']);
  const pmap = pf.places[0].maps.find((m) => m.kind === 'precincts');
  address.setFromAddress(pf, st.S.b, { ...none, county: 'Travis' }, [{ meta: pmap, props: { label: '172', commissioner: '1', jp: '2', sboe: '5' } }]);
  check('maps: Pflugerville, Travis side: a Travis precinct answers the questions that mix both counties’ races', st.S.b.districts['county|County Commissioner'] === 'none' && st.S.b.districts['judicial|Justice of the Peace'] === 'tx-travis-jp-2', JSON.stringify(st.S.b.districts));
  st.S.b = st.emptyBallotState('');
  address.setFromAddress(pf, st.S.b, { ...none, county: 'Williamson' }, []);
  check('maps: Pflugerville, Williamson side: those mixed questions stay open (their Williamson races may be yours), the Travis constable race goes off', st.S.b.districts['county|County Commissioner'] === undefined && st.S.b.districts['judicial|Justice of the Peace'] === undefined && st.S.b.notMine.includes('tx-travis-constable-4'), JSON.stringify(st.S.b.districts));
  st.S.b = st.emptyBallotState('');
  address.setFromAddress(ballot, st.S.b, { ...none, county: 'Williamson' }, [{ meta: pm, props: { label: '1', commissioner: '4', jp: '4', sboe: '5' } }]);
  check('maps: a Travis map answering for an address the Census puts in Williamson is set aside', st.S.b.districts['county|County Commissioner'] === 'none' && !st.S.b.mine.includes('tx-sboe-5'), JSON.stringify(st.S.b.districts));

  // The shipped maps, end to end at Austin City Hall (its point and its block, as the Census gave them).
  const hall = { point: { lon: -97.746669, lat: 30.26496 }, block: { lon: -97.7472987, lat: 30.2646818 } };
  const au = open('TX', ['austin-tx']);
  const answers = au.places[0].maps.map((meta) => ({ meta, a: maps.answerAt(maps.fromTopo(JSON.parse(fs.readFileSync(path.join(DATA, meta.file), 'utf8'))), hall, { edge: maps.edgeOf(meta) }) })).filter((x) => x.a.at === 'in').map((x) => ({ meta: x.meta, props: x.a.props }));
  const by = Object.fromEntries(answers.map((x) => [x.meta.kind, x.props]));
  check('maps: City Hall on the shipped maps: council 9, AISD 5, precinct 301 (commissioner 3, JP 5, SBOE 5)', by.council?.label === '9' && by['aisd-trustee']?.label === '5' && by.precincts?.label === '301' && by.precincts.commissioner === '3' && by.precincts.jp === '5' && by.precincts.sboe === '5' && !by['dvisd-trustee'], JSON.stringify(by));
  const line = address.addrSummary(address.setFromAddress(au, st.S.b, { cd: 10, upper: 14, lower: 49, schools: ['Austin Independent School District'], county: 'Travis' }, answers));
  check('maps: City Hall’s line names every race the address put on', line === 'Set from your address: U.S. Representative, District 10 · State Representative, District 49 · State Board of Education, District 5 · Justice of the Peace, Precinct 5 · Austin City Council, District 9.', line);
  check('maps: and nothing on City Hall’s ballot still depends on the address', views.ledger.addressCount() === 0, String(views.ledger.addressCount()));
  // Correcting an address (Codex review of #17, Oct 21): a new lookup undoes what the last one settled
  // before it settles anything, so a corrected address never keeps an answer it can't give itself.
  {
    const pf2 = open('TX', ['pflugerville-tx']);
    const pm2 = pf2.places[0].maps.find((m) => m.kind === 'precincts');
    address.setFromAddress(pf2, st.S.b, { ...none, county: 'Travis' }, [{ meta: pm2, props: { label: '172', commissioner: '1', jp: '2', sboe: '5' } }]);
    const first = JSON.stringify([st.S.b.districts, st.S.b.mine]);
    address.setFromAddress(pf2, st.S.b, { ...none, county: 'Williamson' }, []);
    check('maps, corrected: Pflugerville, Travis then Williamson: the Travis answers go, the mixed questions open again, SBOE is a maybe again',
      st.S.b.districts['county|County Commissioner'] === undefined && st.S.b.districts['judicial|Justice of the Peace'] === undefined && !st.S.b.mine.includes('tx-sboe-5') && !st.S.b.notMine.includes('tx-sboe-5') && st.S.b.notMine.includes('tx-travis-constable-4'),
      `${first} then ${JSON.stringify([st.S.b.districts, st.S.b.mine, st.S.b.notMine])}`);
    // City Hall, then the same Census answer with witnesses that disagree (no map answers): council,
    // commissioner, JP and the constable race open again, Congress stays, and the box names the maps.
    const au2 = open('TX', ['austin-tx']);
    const cityHall = { cd: 10, upper: 14, lower: 49, schools: ['Austin Independent School District'], county: 'Travis' };
    address.setFromAddress(au2, st.S.b, cityHall, answers);
    address.setFromAddress(au2, st.S.b, cityHall, []);
    check('maps, corrected: City Hall, then witnesses that disagree: what the maps set opens again, what the Census set stays',
      st.S.b.districts['city|Austin City Council Member'] === undefined && st.S.b.districts['county|County Commissioner'] === undefined && st.S.b.districts['judicial|Justice of the Peace'] === undefined
      && !st.S.b.notMine.includes('tx-travis-constable-4') && !st.S.b.mine.includes('tx-sboe-5') && st.S.b.districts['federal|U.S. Representative'] === 'tx-us-house-10' && st.S.b.districts['school|Austin ISD Trustee'] === undefined,
      JSON.stringify([st.S.b.districts, st.S.b.mine, st.S.b.notMine]));
    const nearAll = au2.places[0].maps.map((meta) => ({ meta, answer: meta.kind === 'dvisd-trustee' ? { at: 'out' } : { at: 'near', why: 'line' } }));
    const notes = address.mapNotes(au2, st.S.b, cityHall, nearAll);
    check('maps, corrected: and the box names the maps it couldn’t settle', notes.join(' ') === 'Your address is right at a council district, Austin ISD trustee district and county precinct line, so we didn’t guess. Your official sample ballot shows which are yours.', notes.join(' | '));
    // The voter's own answers survive a correction: a trustee district picked by hand, and "It's on my
    // ballot" on a race the address took off, through the functions their actions call.
    st.S.b = st.emptyBallotState('');
    address.setFromAddress(au2, st.S.b, cityHall, answers);
    address.claimAnswer(st.S.b, 'school|Austin ISD Trustee', 'tx-aisd-district-4'); // A.district
    address.claimOn(st.S.b, 'tx-travis-constable-4'); // A['notmine-undo']
    address.claimOff(st.S.b, ['tx-sboe-5']); // A.notmine: the voter's own "not on my ballot"
    address.setFromAddress(au2, st.S.b, cityHall, []);
    check('maps, corrected: the voter’s own answers stay', st.S.b.districts['school|Austin ISD Trustee'] === 'tx-aisd-district-4' && !st.S.b.notMine.includes('tx-travis-constable-4') && st.S.b.notMine.includes('tx-sboe-5'), JSON.stringify([st.S.b.districts, st.S.b.notMine]));
    // The precinct line follows the same county rule as the answers.
    const hit = au2.places[0].maps.map((meta) => ({ meta, answer: meta.kind === 'precincts' ? { at: 'in', props: { label: '301', commissioner: '3', jp: '5', sboe: '5' }, by: 'both' } : { at: 'out' } }));
    st.S.b = st.emptyBallotState('');
    address.setFromAddress(au2, st.S.b, { ...cityHall, county: 'Williamson' }, address.localAnswers(hit, { ...cityHall, county: 'Williamson' }));
    check('maps: a Travis precinct the Census’s county rejects names no precinct', !address.mapNotes(au2, st.S.b, { ...cityHall, county: 'Williamson' }, hit).some((t) => /voting precinct/.test(t)) && address.localAnswers(hit, { ...cityHall, county: 'Williamson' }).length === 0);
    st.S.b = st.emptyBallotState('');
    address.setFromAddress(au2, st.S.b, cityHall, address.localAnswers(hit, cityHall));
    check('maps: and one it agrees with does', address.mapNotes(au2, st.S.b, cityHall, hit).includes('Your voting precinct: 301 (Travis County).'));
    const failedCouncil = au2.places[0].maps.map((meta) => ({ meta, answer: meta.kind === 'council' ? null : { at: 'out' } }));
    check('maps: a map that didn’t load is named while its races are open, and not once they’re answered, and the pending line comes last',
      address.mapNotes(au2, st.S.b, cityHall, failedCouncil).join(' ') === 'We couldn’t check your council district just now. Your official sample ballot shows it.'
      && (() => { st.S.b.districts['city|Austin City Council Member'] = 'tx-austin-council-1'; return !address.mapNotes(au2, st.S.b, cityHall, failedCouncil).length; })()
      && address.mapNotes(au2, st.S.b, cityHall, [], true).join('|') === address.CHECKING);
    st.S.b = st.emptyBallotState('');
  }
  // The Oct 21 adversarial review (maps-austin-review.md), findings 2 to 9.
  {
    const au3 = open('TX', ['austin-tx']);
    const cityHall = { cd: 10, upper: 14, lower: 49, schools: ['Austin Independent School District'], county: 'Travis' };
    const meta = (kind) => au3.places[0].maps.find((m) => m.kind === kind);
    // 2. A city's limits cut blocks: one witness outside the city and one inside is no guess. A county's
    // line follows blocks, so there the block's answer still stands.
    const city = fc(poly('C', sq(-97.75, 30.26, -97.74, 30.27)));
    const edgeCase = { point: { lon: -97.73995, lat: 30.265 }, block: { lon: -97.745, lat: 30.265 } }; // the point about 5 m outside, its block inside
    const farCase = { point: { lon: -97.735, lat: 30.265 }, block: { lon: -97.745, lat: 30.265 } }; // the point 480 m outside
    const c1 = maps.answerAt(city, edgeCase, { edge: 'cuts' }), c2 = maps.answerAt(city, edgeCase, { edge: 'blocks' }), c3 = maps.answerAt(city, farCase, { edge: 'cuts' });
    check('maps: at a city’s limits, a point outside with its block inside is no guess; at a county’s line the block stands', c1.at === 'near' && c1.why === 'line' && c2.at === 'in' && c2.by === 'block' && c3.at === 'near' && c3.why === 'unsure', JSON.stringify([c1, c2, c3]));
    check('maps: a map with no county is a city’s (its edge cuts blocks); a county’s follows them', maps.edgeOf(meta('council')) === 'cuts' && maps.edgeOf(meta('precincts')) === 'blocks');
    // 4. The voter's own answers stand against the maps: council 3 and SBOE "not on my ballot" by hand
    // (out of addrSet, as their actions leave them), then a City Hall lookup. "Not sure" is no answer.
    st.S.b = st.emptyBallotState('');
    address.claimAnswer(st.S.b, 'city|Austin City Council Member', 'tx-austin-council-3');
    address.claimAnswer(st.S.b, 'judicial|Justice of the Peace', '*');
    address.claimOff(st.S.b, ['tx-sboe-5']);
    address.setFromAddress(au3, st.S.b, cityHall, answers);
    check('maps: a council district and an SBOE "not on my ballot" the voter gave stand; their "Not sure" gets the map’s answer',
      st.S.b.districts['city|Austin City Council Member'] === 'tx-austin-council-3' && st.S.b.notMine.includes('tx-sboe-5') && !st.S.b.mine.includes('tx-sboe-5') && st.S.b.districts['judicial|Justice of the Peace'] === 'tx-travis-jp-5' && !st.S.b.addrSet.includes('city|Austin City Council Member'),
      JSON.stringify([st.S.b.districts, st.S.b.mine, st.S.b.notMine]));
    // 3. Williamson-side Austin: the Travis races are off, named as Travis's, and the box says whose
    // county races are the voter's.
    st.S.b = st.emptyBallotState('');
    const wil = { cd: 11, upper: 24, lower: 136, schools: ['Round Rock Independent School District'], county: 'Williamson' };
    address.setFromAddress(au3, st.S.b, wil, []);
    const stripH = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const off = stripH(views.ledger.offHTML());
    st.S.ui.open.add('off');
    const offOpen = stripH(views.ledger.offHTML());
    st.S.ui.open.delete('off');
    check('maps: Williamson-side Austin: the off list names the Travis races as Travis County’s', /Travis County Commissioner/.test(off) && /Travis County Justice of the Peace/.test(off) && !/(^|[:,] )(Justice of the Peace|County Commissioner)\b/.test(off) && /Travis County Constable/.test(offOpen), `${off} || ${offOpen}`);
    const wnotes = address.mapNotes(au3, st.S.b, wil, au3.places[0].maps.map((m) => ({ meta: m, answer: m.kind === 'council' ? { at: 'in', props: { label: '6' }, by: 'both' } : { at: 'out' } })));
    check('maps: and the box says the voter’s county races are Williamson County’s', wnotes[0] === 'Your county races are Williamson County’s. This guide lists Travis County’s; your official sample ballot shows yours.' && wnotes.length === 1, wnotes.join(' | '));
    check('maps: a Travis address gets no such line', !address.mapNotes(au3, st.S.b, cityHall, []).some((t) => /Your county races/.test(t)));
    // 5. The precinct number shows only when both witnesses agree.
    const pr = (by) => [{ meta: meta('precincts'), answer: { at: 'in', props: { label: '349', commissioner: '2', jp: '2', sboe: '5' }, by } }];
    check('maps: the voting precinct shows when both witnesses agree, not when the block alone decided', address.mapNotes(au3, st.S.b, cityHall, pr('both')).includes('Your voting precinct: 349 (Travis County).') && !address.mapNotes(au3, st.S.b, cityHall, pr('block')).some((t) => /voting precinct/.test(t)));
    // 6. Witnesses that disagree away from a line: "couldn't tell", not "right at a line".
    st.S.b = st.emptyBallotState('');
    address.setFromAddress(au3, st.S.b, cityHall, []);
    const unsureCouncil = [{ meta: meta('council'), answer: { at: 'near', why: 'unsure' } }];
    const atAisd = address.mapNotes(au3, st.S.b, cityHall, [{ meta: meta('aisd-trustee'), answer: { at: 'near', why: 'line' } }]);
    check('maps: "an Austin ISD trustee district line", not "a Austin"', atAisd.join(' ') === 'Your address is right at an Austin ISD trustee district line, so we didn’t guess. Your official sample ballot shows yours.', atAisd.join(' | '));
    check('maps: witnesses that disagree with no line near say "We couldn’t tell"', address.mapNotes(au3, st.S.b, cityHall, unsureCouncil).join(' ') === 'We couldn’t tell your council district from your address. Your official sample ballot shows it.', address.mapNotes(au3, st.S.b, cityHall, unsureCouncil).join(' | '));
    // 8. The AISD district question answered "none" (City Hall's district 5 isn't up) while the at-large
    // seat is still on the ballot: the off list calls it the district seats.
    st.S.b = st.emptyBallotState('');
    st.S.b.districts['school|Austin ISD Trustee'] = 'none';
    const offHall = stripH(views.ledger.offHTML());
    check('maps: the off list calls the AISD district question its district seats, beside the at-large seat still on the ballot', offHall === 'Not on your ballot: Austin ISD Trustee (district seats).', offHall);
    st.S.b.districts = { 'city|Austin City Council Member': 'none' };
    check('maps: an office with no other race on the ballot keeps its plain name', stripH(views.ledger.offHTML()) === 'Not on your ballot: Austin City Council Member.', stripH(views.ledger.offHTML()));
    // 9. The index lists each place's maps, so the first page can start them with the place's bundle.
    check('maps: the index names Austin’s maps', JSON.stringify(INDEX.places['austin-tx'].maps) === JSON.stringify(au3.places[0].maps.map((m) => m.file)) && !INDEX.places['san-antonio-tx'].maps);
    st.S.b = st.emptyBallotState('');
  }
  // Codex's confirming round on #17 (Oct 26): who owns an answer across a lookup's passes, and what
  // the box still warns about. The voter's changes go through the functions the actions call
  // (model/address.ts claimAnswer, claimOn, claimOff), and a lookup's passes through lookupPasses,
  // as app.ts applyGeo runs them: the Census and the quick maps first, each late map after.
  {
    const au4 = open('TX', ['austin-tx']);
    const cityHall = { cd: 10, upper: 14, lower: 49, schools: ['Austin Independent School District'], county: 'Travis' };
    const councilOnly = answers.filter((x) => x.meta.kind === 'council');
    const on = (id) => address.claimOn(st.S.b, id);
    const off = (ids) => address.claimOff(st.S.b, ids);
    const answer = (k, v) => address.claimAnswer(st.S.b, k, v);
    const passes = () => address.lookupPasses();
    const S = () => st.S.b;
    // 1. "It's on my ballot" on a race the maps took off (City Hall is in constable precinct 5, the race
    // is precinct 4's): it stays on through a late map and through a new lookup at the same address.
    st.S.b = st.emptyBallotState('');
    let pass = passes();
    pass(au4, S(), cityHall, answers);
    const offAtFirst = S().notMine.includes('tx-travis-constable-4');
    on('tx-travis-constable-4');
    pass(au4, S(), cityHall, answers);
    const afterFold = !S().notMine.includes('tx-travis-constable-4') && S().mine.includes('tx-travis-constable-4');
    address.setFromAddress(au4, S(), cityHall, answers);
    check('maps, ownership: "It’s on my ballot" on a race a map took off stays on through a later pass and a new lookup',
      offAtFirst && afterFold && !S().notMine.includes('tx-travis-constable-4') && S().mine.includes('tx-travis-constable-4') && !S().addrSet.includes('tx-travis-constable-4'),
      JSON.stringify([offAtFirst, afterFold, S().mine, S().notMine]));
    // The same for a race the Census took off: the Austin ISD at-large seat for a Round Rock ISD address.
    st.S.b = st.emptyBallotState('');
    pass = passes();
    const rr = { ...cityHall, schools: ['Round Rock Independent School District'] };
    pass(au4, S(), rr, []);
    const atLargeOff = S().notMine.includes('tx-aisd-at-large-9');
    on('tx-aisd-at-large-9');
    pass(au4, S(), rr, councilOnly);
    check('maps, ownership: "It’s on my ballot" on the at-large seat the Census took off stays on when a map folds in',
      atLargeOff && !S().notMine.includes('tx-aisd-at-large-9'), JSON.stringify([atLargeOff, S().notMine]));
    // 2. A late map after the voter changed things: the Census and the council map answer first; then
    // the voter picks Congress 11, says the state Senate race (the Census took off) and Del Valle's
    // Prop A (the school district took off) are on their ballot, and asks the council question again;
    // then the precinct and trustee maps arrive. Their changes stand; the new maps still answer theirs.
    st.S.b = st.emptyBallotState('');
    pass = passes();
    pass(au4, S(), cityHall, councilOnly);
    const firstPass = S().districts['federal|U.S. Representative'] === 'tx-us-house-10' && S().notMine.includes('tx-senate-21') && S().notMine.includes('tx-dvisd-prop-a') && S().districts['city|Austin City Council Member'] === 'tx-austin-council-9';
    answer('federal|U.S. Representative', 'tx-us-house-11');
    on('tx-senate-21');
    on('tx-dvisd-prop-a');
    answer('city|Austin City Council Member', null);
    pass(au4, S(), cityHall, answers);
    check('maps, ownership: a late map keeps what the voter changed after the first answers (Congress, a Census race, a school measure, a question asked again)',
      firstPass && S().districts['federal|U.S. Representative'] === 'tx-us-house-11' && S().mine.includes('tx-senate-21') && !S().notMine.includes('tx-senate-21')
      && S().mine.includes('tx-dvisd-prop-a') && !S().notMine.includes('tx-dvisd-prop-a') && S().districts['city|Austin City Council Member'] === undefined,
      JSON.stringify([firstPass, S().districts, S().mine, S().notMine]));
    check('maps, ownership: and the maps that arrived still answer their own races (JP 5, the constable race off)',
      S().districts['judicial|Justice of the Peace'] === 'tx-travis-jp-5' && S().notMine.includes('tx-travis-constable-4') && S().districts['federal|U.S. Representative'] === 'tx-us-house-11',
      JSON.stringify(S().districts));
    // Any claim during a lookup counts, whatever the question was before (Codex, Oct 26, the fourth
    // hole of this kind): the Census answers first with the council map still out, and the voter
    // answers the still-open council question themselves (District 3), taps Change on it, or says
    // "Not sure"; then the council map arrives saying 9. Each time the voter's choice stands.
    const openThenMap = (act) => {
      st.S.b = st.emptyBallotState('');
      const p = passes();
      p(au4, S(), cityHall, []);
      const wasOpen = S().districts['city|Austin City Council Member'] === undefined;
      act();
      p(au4, S(), cityHall, answers);
      return [wasOpen, S().districts['city|Austin City Council Member']];
    };
    const pick3 = openThenMap(() => answer('city|Austin City Council Member', 'tx-austin-council-3'));
    const change = openThenMap(() => { answer('city|Austin City Council Member', 'tx-austin-council-1'); answer('city|Austin City Council Member', null); });
    const unsure = openThenMap(() => answer('city|Austin City Council Member', '*'));
    check('maps, ownership: a claim on a question still open when the voter made it (District 3, Change, "Not sure") survives the late map',
      pick3[0] && pick3[1] === 'tx-austin-council-3' && change[0] && change[1] === undefined && unsure[0] && unsure[1] === '*',
      JSON.stringify({ pick3, change, unsure }));
    // The same for a race the lookup hadn't placed yet: "Not on my ballot" on SBOE before the precinct
    // map arrives (it would put SBOE on).
    st.S.b = st.emptyBallotState('');
    pass = passes();
    pass(au4, S(), cityHall, councilOnly);
    const sboeOpen = !S().mine.includes('tx-sboe-5') && !S().notMine.includes('tx-sboe-5');
    off(['tx-sboe-5']);
    pass(au4, S(), cityHall, answers);
    check('maps, ownership: and "Not on my ballot" on a race the lookup hadn’t placed yet survives the map that would place it',
      sboeOpen && S().notMine.includes('tx-sboe-5') && !S().mine.includes('tx-sboe-5'), JSON.stringify([sboeOpen, S().mine, S().notMine]));
    // A guess made before the lookup is still the lookup's to replace: the Census's districts are the
    // official ones, and asking is how the voter meant to find out (unchanged from before the maps).
    st.S.b = st.emptyBallotState('');
    answer('federal|U.S. Representative', 'tx-us-house-37');
    passes()(au4, S(), cityHall, []);
    check('maps, ownership: a Congress guess from before the lookup gets the Census’s answer', S().districts['federal|U.S. Representative'] === 'tx-us-house-10', JSON.stringify(S().districts));
    // "Not on my ballot" takes a race out of `mine` (and so off the ballot) whoever put it there.
    st.S.b = st.emptyBallotState('');
    passes()(au4, S(), cityHall, answers);
    off(['tx-sboe-5']);
    check('maps, ownership: "Not on my ballot" on a race the address put on takes it off, as the voter’s', S().notMine.includes('tx-sboe-5') && !S().mine.includes('tx-sboe-5') && !S().addrSet.includes('tx-sboe-5'), JSON.stringify([S().mine, S().notMine]));
    // The way back on a race in `mine`: named as the address's only when the address put it there.
    const flat = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    st.S.b = st.emptyBallotState('');
    passes()(au4, S(), cityHall, answers);
    const byAddr = views.open.openHTML(au4.byId.get('tx-sboe-5'));
    on('tx-travis-constable-4');
    const byYou = views.open.openHTML(au4.byId.get('tx-travis-constable-4'));
    check('maps, ownership: a race on your ballot keeps "Not on my ballot", saying when it was your address',
      /Your address puts it on your ballot\. Not on my ballot/.test(flat(byAddr)) && /data-act="notmine" data-id="tx-sboe-5"/.test(byAddr)
      && /On your ballot\. Not on my ballot/.test(flat(byYou)) && !/Your address puts it/.test(flat(byYou)) && !/Only on some ballots/.test(flat(byYou)),
      `${flat(byAddr).slice(0, 200)} || ${flat(byYou).slice(0, 200)}`);
    // 3. "Not sure" ('*') is no answer: the box still says which maps couldn't settle the question,
    // and the address answers what it can.
    const council = (answer1) => au4.places[0].maps.map((meta) => ({ meta, answer: meta.kind === 'council' ? answer1 : { at: 'out' } }));
    const notesFor = (res) => { st.S.b = st.emptyBallotState(''); S().districts['city|Austin City Council Member'] = '*'; address.setFromAddress(au4, S(), cityHall, address.localAnswers(res, cityHall)); return address.mapNotes(au4, S(), cityHall, res).join(' '); };
    const nFail = notesFor(council(null)), nLine = notesFor(council({ at: 'near', why: 'line' })), nUnsure = notesFor(council({ at: 'near', why: 'unsure' }));
    check('maps, ownership: with council "Not sure", a council map that didn’t load, sat at a line or couldn’t tell still says so',
      nFail === 'We couldn’t check your council district just now. Your official sample ballot shows it.'
      && nLine === 'Your address is right at a council district line, so we didn’t guess. Your official sample ballot shows yours.'
      && nUnsure === 'We couldn’t tell your council district from your address. Your official sample ballot shows it.',
      [nFail, nLine, nUnsure].join(' | '));
    st.S.b = st.emptyBallotState('');
    S().districts['school|Del Valle ISD Trustee'] = '*';
    address.setFromAddress(au4, S(), cityHall, []);
    check('maps, ownership: "Not sure" on Del Valle’s trustees, and the Census says Austin ISD: answered "none"', S().districts['school|Del Valle ISD Trustee'] === 'none', JSON.stringify(S().districts));
    st.S.b = st.emptyBallotState('');
  }
  // Williamson County (Oct 26): Round Rock, the Williamson side of Pflugerville, and Williamson-side
  // Austin, on the shipped maps at public buildings (scripts/maps/test-points.json).
  {
    const TP = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'maps', 'test-points.json'), 'utf8')).points.map((p) => [p.name, p]));
    const w = (name) => ({ point: { lon: TP[name].point[0], lat: TP[name].point[1] }, block: { lon: TP[name].block[0], lat: TP[name].block[1] } });
    const topo = new Map();
    const fcOf = (meta) => { if (!topo.has(meta.file)) topo.set(meta.file, maps.fromTopo(JSON.parse(fs.readFileSync(path.join(DATA, meta.file), 'utf8')))); return topo.get(meta.file); };
    const resultsAt = (ballot, name) => maps.ballotMaps(ballot).map(({ meta }) => ({ meta, answer: maps.answerAt(fcOf(meta), w(name), { edge: maps.edgeOf(meta) }) }));
    const lookup = (ballot, r, name) => {
      st.S.b = st.emptyBallotState('');
      const res = resultsAt(ballot, name);
      const line = address.addrSummary(address.setFromAddress(ballot, st.S.b, r, address.localAnswers(res, r)));
      return { line, notes: address.mapNotes(ballot, st.S.b, r, res), s: st.S.b };
    };
    const rr = open('TX', ['round-rock-tx']);
    const pf = open('TX', ['pflugerville-tx']);
    const au5 = open('TX', ['austin-tx']);
    const rrHall = { cd: 17, upper: 5, lower: 136, schools: ['Round Rock Independent School District'], county: 'Williamson' };
    const kinds = (ballot) => maps.ballotMaps(ballot).map(({ meta }) => `${meta.file.split('/')[1]}/${meta.kind}`).sort().join(' ');
    check('maps, Williamson: Round Rock and Pflugerville read both counties’ precincts and the Williamson SBOE map; Austin adds only the SBOE map',
      kinds(rr) === 'travis-county-tx/precincts williamson-county-tx/precincts williamson-county-tx/sboe' && kinds(pf) === kinds(rr)
      && kinds(au5) === 'austin-tx/council travis-county-tx/aisd-trustee travis-county-tx/dvisd-trustee travis-county-tx/precincts williamson-county-tx/sboe', `${kinds(rr)} || ${kinds(au5)}`);
    // Round Rock City Hall: voting precinct 150, commissioner and JP precinct 1, SBOE District 10.
    const a = lookup(rr, rrHall, 'Round Rock City Hall');
    check('maps, Williamson: Round Rock City Hall: JP 1 on, commissioner "none" (precinct 1 isn’t up), SBOE 5 off, and the line names the JP race',
      a.s.districts['judicial|Justice of the Peace'] === 'tx-wilco-jp-1' && a.s.districts['county|County Commissioner'] === 'none' && a.s.notMine.includes('tx-sboe-5') && /Justice of the Peace, Precinct 1\b/.test(a.line),
      JSON.stringify([a.line, a.s.districts, a.s.notMine]));
    check('maps, Williamson: and the box shows its voting precinct, with no "your county races" line', a.notes.join(' | ') === 'Your voting precinct: 150 (Williamson County).', a.notes.join(' | '));
    // A Williamson building on Pflugerville's ballot, where both counties' races are listed: the
    // Williamson map answers, the Travis races in the same questions go, and no one is told their
    // county's races are missing. Pflugerville City Hall (Travis) the other way round.
    const b = lookup(pf, rrHall, 'Williamson County Jester Annex');
    check('maps, Williamson: Pflugerville, Williamson side: JP 1 (Williamson’s), commissioner "none", SBOE 5 off, no "your county races" line',
      b.s.districts['judicial|Justice of the Peace'] === 'tx-wilco-jp-1' && b.s.districts['county|County Commissioner'] === 'none' && b.s.notMine.includes('tx-sboe-5') && !b.notes.some((t) => /Your county races/.test(t)) && b.notes.includes('Your voting precinct: 145 (Williamson County).'),
      JSON.stringify([b.s.districts, b.notes]));
    const pfHall = { cd: 10, upper: 14, lower: 50, schools: ['Pflugerville Independent School District'], county: 'Travis' };
    const c = lookup(pf, pfHall, 'Pflugerville City Hall');
    check('maps, Williamson: Pflugerville, Travis side: Travis JP 2, SBOE 5 on, and no "your county races" line now that the ballot lists both counties’',
      c.s.districts['judicial|Justice of the Peace'] === 'tx-travis-jp-2' && c.s.mine.includes('tx-sboe-5') && !c.notes.some((t) => /Your county races/.test(t)),
      JSON.stringify([c.s.districts, c.notes]));
    // Travis-side Round Rock (a Travis building stands in): SBOE from the Travis precinct, the
    // Williamson races off, and the box says whose county races these are.
    const d = lookup(rr, { ...rrHall, county: 'Travis' }, 'Canyon Vista Middle School');
    check('maps, Williamson: Round Rock, Travis side: SBOE 5 on from the Travis precinct, Williamson’s commissioner and JP "none", and the box says so',
      d.s.mine.includes('tx-sboe-5') && d.s.districts['county|County Commissioner'] === 'none' && d.s.districts['judicial|Justice of the Peace'] === 'none'
      && d.notes[0] === 'Your county races are Travis County’s. This guide lists Williamson County’s; your official sample ballot shows yours.',
      JSON.stringify([d.s.districts, d.s.mine, d.notes]));
    // A county's map answers only when the Census names that county (Codex on #23). The SBOE map
    // reaches 1.5 km past Williamson on purpose; Canyon Vista Middle School sits in Travis close to
    // the line, inside that reach, so it is the case that matters: the map has an answer there.
    const sboeMeta = maps.ballotMaps(rr).find(({ meta }) => meta.file.includes('williamson-county-tx/sboe')).meta;
    const sboeAt = maps.answerAt(fcOf(sboeMeta), w('Canyon Vista Middle School'), { edge: maps.edgeOf(sboeMeta) });
    const fromWilco = (r, name) => address.localAnswers(resultsAt(rr, name), r).filter((x) => x.meta.county === 'Williamson').map((x) => `${x.meta.kind} ${x.props.label}`);
    check('maps, Williamson county guard: the SBOE map does answer at Canyon Vista Middle School (Travis, within its 1.5 km reach), so the guard is what keeps it out',
      sboeAt.at === 'in' && sboeAt.props.label === '5', JSON.stringify(sboeAt));
    check('maps, Williamson county guard: Williamson’s maps answer for a Williamson address, and for no other county’s',
      fromWilco(rrHall, 'Round Rock City Hall').join(' ') === 'precincts 150 sboe 10' && fromWilco({ ...rrHall, county: 'Travis' }, 'Canyon Vista Middle School').length === 0, JSON.stringify([fromWilco(rrHall, 'Round Rock City Hall'), fromWilco({ ...rrHall, county: 'Travis' }, 'Canyon Vista Middle School')]));
    const noCounty = [null, undefined, '', '  '].map((county) => {
      const x = lookup(rr, { ...rrHall, county }, 'Canyon Vista Middle School');
      return { county, wilco: fromWilco({ ...rrHall, county }, 'Canyon Vista Middle School').length, sboe: x.s.mine.includes('tx-sboe-5') ? 'on' : x.s.notMine.includes('tx-sboe-5') ? 'off' : 'open', comm: x.s.districts['county|County Commissioner'], jp: x.s.districts['judicial|Justice of the Peace'], notes: x.notes.length };
    });
    check('maps, Williamson county guard: when the Census names no county, no county’s map answers: SBOE, commissioner and JP stay for the sample ballot',
      noCounty.every((x) => x.wilco === 0 && x.sboe === 'open' && x.comm === undefined && x.jp === undefined), JSON.stringify(noCounty));
    // Hays-side Austin (a Travis building stands in; the Census says Hays): the city's council map still
    // answers, every county's map is set aside, Travis's county races come off, SBOE stays open.
    const h = lookup(au5, { cd: 37, upper: 25, lower: 45, schools: ['Austin Independent School District'], county: 'Hays' }, 'Southeast Branch Library');
    check('maps, Williamson county guard: Hays-side Austin: council from the city’s map, Travis’s county races off, SBOE open, and the box says whose',
      /^tx-austin-council-\d$|^none$/.test(h.s.districts['city|Austin City Council Member'] || '') && h.s.districts['county|County Commissioner'] === 'none' && h.s.districts['judicial|Justice of the Peace'] === 'none'
      && !h.s.mine.includes('tx-sboe-5') && !h.s.notMine.includes('tx-sboe-5') && /^Your county races are Hays County’s/.test(h.notes[0] || ''),
      JSON.stringify([h.s.districts, h.s.mine, h.notes]));
    // Williamson-side Austin: the SBOE race settles now (District 5 there), Travis's county races stay off.
    const e = lookup(au5, { cd: 37, upper: 14, lower: 136, schools: ['Round Rock Independent School District'], county: 'Williamson' }, 'Spicewood Springs Branch Library');
    check('maps, Williamson: Williamson-side Austin: SBOE 5 on from the Williamson SBOE map, Travis’s county races off, and the box still says whose',
      e.s.mine.includes('tx-sboe-5') && e.s.districts['county|County Commissioner'] === 'none' && /State Board of Education, District 5/.test(e.line) && /^Your county races are Williamson County’s/.test(e.notes[0] || ''),
      JSON.stringify([e.line, e.s.districts, e.notes]));
    st.S.b = st.emptyBallotState('');
  }
  // A district's seats (Oct 26): Dallas elects two justices of the peace in each precinct ("Precinct 1,
  // Place 1" and "Place 2"), both on every ballot in that precinct, as Washington elects two
  // representatives per district ("Position 1" and "Position 2"). One answer must show both.
  {
    const da = open('TX', ['dallas-tx']);
    const jp = da.groups.find((g) => g.key === 'judicial|Justice of the Peace');
    st.S.ui.row = `q:${jp.key}`;
    const qh = views.ledger.sectionHTML('judicial', bl.entriesBySection().get('judicial') || []);
    const picks = [...qh.matchAll(/data-act="district" data-g="judicial\|Justice of the Peace" data-v="(tx-dallas-jp-[^"]+)"[^>]*><b>([^<]*)<\/b>/g)].map((m) => `${m[1]}=${m[2]}`);
    check('seats: Dallas’s JP question offers each precinct once, by its precinct, and counts 5 districts',
      picks.join(' | ') === 'tx-dallas-jp-1-1=Precinct 1 | tx-dallas-jp-2-1=Precinct 2 | tx-dallas-jp-3-1=Precinct 3 | tx-dallas-jp-4-1=Precinct 4 | tx-dallas-jp-5-1=Precinct 5' && /Dallas has 5 of these districts\./.test(qh), picks.join(' | '));
    st.S.ui.row = null;
    st.S.b.districts[jp.key] = 'tx-dallas-jp-3-1';
    const shown = (bl.entriesBySection().get('judicial') || []).filter((e) => e.t === 'item' && /dallas-jp/.test(e.id)).map((e) => e.id);
    check('seats: answering Precinct 3 shows both of its places, and no other precinct’s', shown.join(' ') === 'tx-dallas-jp-3-1 tx-dallas-jp-3-2', shown.join(' '));
    const gl = views.ledger.sectionHTML('judicial', bl.entriesBySection().get('judicial') || []).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    check('seats: and the answered question names the precinct, not one place', /Justice of the Peace: Precinct 3 Change/.test(gl), gl.slice(0, 160));
    check('seats: places of different precincts aren’t one seat',
      !bl.sameSeat(da.byId.get('tx-dallas-jp-3-1'), da.byId.get('tx-dallas-jp-4-2')) && bl.sameSeat(da.byId.get('tx-dallas-jp-3-1'), da.byId.get('tx-dallas-jp-3-2')));
    // Two offices that happen to share a seat ("At-Large Position 1" and "2" of two different boards) aren't
    // one seat either (Codex on #24: the check above compared only JP races).
    const seat = (office, district) => ({ kind: 'contest', id: `${office}|${district}`, office, district });
    check('seats: the same seat of two different offices isn’t one seat; of one office it is',
      !bl.sameSeat(seat('Board A Director', 'At-Large Position 1'), seat('Board B Director', 'At-Large Position 2'))
      && bl.sameSeat(seat('Board A Director', 'At-Large Position 1'), seat('Board A Director', 'At-Large Position 2')));
    // "Not sure" shows every race, so a question whose districts have two seats counts races (Codex on #24).
    st.S.b.districts[jp.key] = '*';
    const comm = da.groups.find((g) => g.key === 'county|County Commissioner');
    st.S.b.districts[comm.key] = '*';
    const unsure = (sec) => views.ledger.sectionHTML(sec, bl.entriesBySection().get(sec) || []).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    check('seats: "Not sure" on Dallas’s JP question says "showing all 10 races"; on its commissioner question, "showing all 2 districts"',
      /Justice of the Peace: showing all 10 races/.test(unsure('judicial')) && /County Commissioner: showing all 2 districts/.test(unsure('county')),
      `${(unsure('judicial').match(/Justice of the Peace: [^C]*/) || [''])[0]} | ${(unsure('county').match(/County Commissioner: [^C]*/) || [''])[0]}`);
    st.S.b.districts = {};
    const se = open('WA', ['seattle-wa']);
    const hd = se.groups.find((g) => /State Representative/.test(g.office));
    const a = se.byId.get(hd.members[0]);
    check('seats: Washington’s two House positions per district are still one seat', hd.members.filter((m) => bl.sameSeat(a, se.byId.get(m))).length === 1, hd.members.join(' '));
    st.S.b = st.emptyBallotState('');
  }
  // Dallas County (Oct 26): one map, the county's 791 precincts merged into 28 pieces by commissioner,
  // JP and SBOE district, settles all four county questions. At public buildings:
  {
    const TP = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'maps', 'test-points.json'), 'utf8')).points.map((p) => [p.name, p]));
    const da = open('TX', ['dallas-tx']);
    const metas = maps.ballotMaps(da).map((x) => x.meta);
    const fc = maps.fromTopo(JSON.parse(fs.readFileSync(path.join(DATA, metas[0].file), 'utf8')));
    const at = (name) => { const p = TP[name]; return [{ meta: metas[0], answer: maps.answerAt(fc, { point: { lon: p.point[0], lat: p.point[1] }, block: { lon: p.block[0], lat: p.block[1] } }, { edge: maps.edgeOf(metas[0]) }) }]; };
    const lookup = (r, name) => { st.S.b = st.emptyBallotState(''); const res = at(name); const line = address.addrSummary(address.setFromAddress(da, st.S.b, r, address.localAnswers(res, r))); return { line, notes: address.mapNotes(da, st.S.b, r, res), s: st.S.b }; };
    check('maps, Dallas: one small map', metas.length === 1 && metas[0].kind === 'county-districts' && metas[0].bytes < 40000 && fc.features.length === 28, JSON.stringify(metas.map((m) => [m.kind, m.bytes, fc.features.length])));
    const hall = lookup({ cd: 33, upper: 23, lower: 114, schools: ['Dallas Independent School District'], county: 'Dallas' }, 'Dallas City Hall');
    const jpRows = (bl.entriesBySection().get('judicial') || []).filter((e) => e.t === 'item' && /dallas-jp/.test(e.id)).map((e) => e.id);
    check('maps, Dallas: City Hall: JP Precinct 1 (both places), Constable 1, SBOE 13, commissioner "none" (precinct 3 isn’t up)',
      hall.s.districts['judicial|Justice of the Peace'] === 'tx-dallas-jp-1-1' && jpRows.join(' ') === 'tx-dallas-jp-1-1 tx-dallas-jp-1-2' && hall.s.districts['county|Constable'] === 'tx-dallas-constable-1'
      && hall.s.districts['state|Member, State Board of Education'] === 'tx-sboe-13' && hall.s.districts['county|County Commissioner'] === 'none',
      JSON.stringify([hall.s.districts, jpRows]));
    check('maps, Dallas: and the line names the precinct once, not a place', /State Board of Education, District 13 · Justice of the Peace, Precinct 1 · Constable, Precinct 1\.$/.test(hall.line) && !/Place/.test(hall.line), hall.line);
    check('maps, Dallas: nothing on City Hall’s ballot still depends on the address, and the box adds nothing', views.ledger.addressCount() === 0 && hall.notes.length === 0, `${views.ledger.addressCount()} | ${hall.notes.join(' | ')}`);
    const irving = lookup({ cd: 33, upper: 9, lower: 105, schools: ['Irving Independent School District'], county: 'Dallas' }, 'Irving City Hall');
    check('maps, Dallas: Irving City Hall: commissioner Precinct 4, JP 4', irving.s.districts['county|County Commissioner'] === 'tx-dallas-commissioner-4' && irving.s.districts['judicial|Justice of the Peace'] === 'tx-dallas-jp-4-1', JSON.stringify(irving.s.districts));
    // Collin-side Dallas: Dallas County's races aren't theirs, and the box says so; SBOE stays open.
    const collin = lookup({ cd: 4, upper: 2, lower: 70, schools: ['Plano Independent School District'], county: 'Collin' }, 'Renner Frankford Branch Library');
    check('maps, Dallas: Collin-side Dallas: Dallas County’s commissioner, JP and constable "none", SBOE open, and whose county races they are',
      collin.s.districts['county|County Commissioner'] === 'none' && collin.s.districts['judicial|Justice of the Peace'] === 'none' && collin.s.districts['county|Constable'] === 'none' && collin.s.districts['state|Member, State Board of Education'] === undefined
      && collin.notes[0] === 'Your county races are Collin County’s. This guide lists Dallas County’s; your official sample ballot shows yours.',
      JSON.stringify([collin.s.districts, collin.notes]));
    st.S.b = st.emptyBallotState('');
  }
  // Harris County (Oct 26): Houston's one map, the county's 1,224 precincts merged into 37 pieces by
  // commissioner, JP and SBOE district. Houston's JP races are each precinct's Place 2 alone.
  {
    const TP = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'maps', 'test-points.json'), 'utf8')).points.map((p) => [p.name, p]));
    const hou = open('TX', ['houston-tx']);
    const metas = maps.ballotMaps(hou).map((x) => x.meta);
    const fc = maps.fromTopo(JSON.parse(fs.readFileSync(path.join(DATA, metas[0].file), 'utf8')));
    const at = (name) => { const p = TP[name]; return [{ meta: metas[0], answer: maps.answerAt(fc, { point: { lon: p.point[0], lat: p.point[1] }, block: { lon: p.block[0], lat: p.block[1] } }, { edge: maps.edgeOf(metas[0]) }) }]; };
    const lookup = (r, name) => { st.S.b = st.emptyBallotState(''); const res = at(name); const line = address.addrSummary(address.setFromAddress(hou, st.S.b, r, address.localAnswers(res, r))); return { line, notes: address.mapNotes(hou, st.S.b, r, res), s: st.S.b }; };
    check('maps, Harris: one map, 37 pieces', metas.length === 1 && metas[0].kind === 'county-districts' && fc.features.length === 37 && metas[0].bytes < 75000, JSON.stringify(metas.map((m) => [m.kind, m.bytes, fc.features.length])));
    const hall = lookup({ cd: 18, upper: 13, lower: 147, schools: ['Houston Independent School District'], county: 'Harris' }, 'Houston City Hall');
    check('maps, Harris: City Hall: JP Precinct 1 (its Place 2), SBOE 4 (the unexpired term), commissioner "none" (precinct 1 isn’t up)',
      hall.s.districts['judicial|Justice of the Peace'] === 'tx-harris-jp-1-2' && hall.s.districts['state|Member, State Board of Education'] === 'tx-sboe-4' && hall.s.districts['county|County Commissioner'] === 'none',
      JSON.stringify(hall.s.districts));
    check('maps, Harris: the line names SBOE District 4 and JP Precinct 1, and nothing is left for the sample ballot',
      /State Board of Education, District 4 · Justice of the Peace, Precinct 1\.$/.test(hall.line) && views.ledger.addressCount() === 0 && hall.notes.length === 0, `${hall.line} | ${views.ledger.addressCount()}`);
    const pas = lookup({ cd: 9, upper: 6, lower: 144, schools: ['Pasadena Independent School District'], county: 'Harris' }, 'Pasadena City Hall');
    check('maps, Harris: Pasadena City Hall: commissioner Precinct 2, JP 2', pas.s.districts['county|County Commissioner'] === 'tx-harris-commissioner-2' && pas.s.districts['judicial|Justice of the Peace'] === 'tx-harris-jp-2-2', JSON.stringify(pas.s.districts));
    // Fort Bend-side Houston: Harris County's races aren't theirs, and the box says so; SBOE stays open.
    const fb = lookup({ cd: 18, upper: 13, lower: 27, schools: ['Fort Bend Independent School District'], county: 'Fort Bend' }, 'Missouri City City Hall');
    check('maps, Harris: Fort Bend-side: Harris County’s commissioner and JP "none", SBOE open, and whose county races they are',
      fb.s.districts['county|County Commissioner'] === 'none' && fb.s.districts['judicial|Justice of the Peace'] === 'none' && fb.s.districts['state|Member, State Board of Education'] === undefined
      && fb.notes[0] === 'Your county races are Fort Bend County’s. This guide lists Harris County’s; your official sample ballot shows yours.',
      JSON.stringify([fb.s.districts, fb.notes]));
    st.S.b = st.emptyBallotState('');
  }
  // The Census answer keeps the point and the block's interior point, for the maps only.
  const g = geo.parseCensus({ result: { addressMatches: [{ matchedAddress: 'TEST CITY HALL, AUSTIN, TX, 78701', coordinates: { x: -97.746669, y: 30.26496 }, geographies: { States: [{ STATE: '48' }], '2020 Census Blocks': [{ INTPTLAT: '+30.2646818', INTPTLON: '-097.7472987' }] } }] } })[0];
  check('maps: parseCensus keeps the point and the block’s interior point', g.point.lon === -97.746669 && g.point.lat === 30.26496 && g.block.lon === -97.7472987 && g.block.lat === 30.2646818, JSON.stringify([g.point, g.block]));
  const g0 = geo.parseCensus({ result: { addressMatches: [{ matchedAddress: 'TEST', geographies: {} }] } })[0];
  check('maps: and none when the Census sends none', g0.point === null && g0.block === null);
  st.S.b = st.emptyBallotState('');
}

/* ---------- visit counts (Oct 28): what may reach Vercel Web Analytics (src/stats.ts) ---------- */
{
  const stats = await load('/src/stats.ts');
  // Every address is cut to its origin and path: a save link's hash and ?try= never go.
  check('stats: cleanUrl drops the hash and the query', stats.cleanUrl('https://vote.kevinhg.com/?try=aunt&today=2026-11-03#v1~TX~austin-tx~78704~abc') === 'https://vote.kevinhg.com/');
  check('stats: cleanUrl passes a plain path as it is', stats.cleanUrl('https://vote.kevinhg.com/') === 'https://vote.kevinhg.com/' && stats.cleanUrl('https://voting-guide-git-analytics-kevinhg.vercel.app/') === 'https://voting-guide-git-analytics-kevinhg.vercel.app/');
  check('stats: a ZIP in the path, written or encoded, sends nothing', stats.cleanUrl('https://vote.kevinhg.com/78704') === null && stats.cleanUrl('https://vote.kevinhg.com/78%3704') === null);
  check('stats: an at sign in the path, written or encoded, sends nothing', stats.cleanUrl('https://vote.kevinhg.com/a@b.co') === null && stats.cleanUrl('https://vote.kevinhg.com/a%40b.co') === null);
  check('stats: a path that won’t decode sends nothing', stats.cleanUrl('https://vote.kevinhg.com/%E0%A4%A') === null);
  const ev = { type: 'event', url: 'https://vote.kevinhg.com/?try=fresh#v2~CO~aurora-co~80010', payload: { name: 'view', data: { name: 'plan' } } };
  const sent = stats.beforeSend(ev);
  check('stats: beforeSend cuts the address and keeps the rest of the event', !!sent && sent.url === 'https://vote.kevinhg.com/' && sent.type === 'event' && sent.payload === ev.payload && ev.url.includes('#'), JSON.stringify(sent));
  check('stats: beforeSend drops an event whose address still holds a ZIP', stats.beforeSend({ type: 'pageview', url: 'https://vote.kevinhg.com/78704?x=1' }) === null);
  check('stats: it loads on the guide’s Vercel hosts only', ['vote.kevinhg.com', 'voting-guide-silk.vercel.app', 'voting-guide-git-analytics-kevinhg.vercel.app'].every(stats.onVercel)
    && !['localhost', '127.0.0.1', 'evilkevinhg.com', 'vote.kevinhg.com.example.org', 'vercel.app.example.org'].some(stats.onVercel));
  check('stats: event values are short plain tokens, never a ZIP or an at sign', stats.plainData({ place: 'austin-tx', how: 'zip' }) && stats.plainData({ place: 'dc-ward-1' }) && stats.plainData({ place: 'MO' })
    && !stats.plainData({ place: '78704' }) && !stats.plainData({ place: 'austin-tx-78704' }) && !stats.plainData({ kind: 'a@b.co' }) && !stats.plainData({ n: 5 }) && !stats.plainData({ how: 'two words' }) && !stats.plainData({ how: '' }));
  // The place a ballot counts as: its one place, or its state. Each set of several places in the index belongs
  // to exactly one ZIP (DC's wards, Aurora and Denver), so every one of them must count as the state.
  const ballotOf = (s, ids) => bl.buildBallot(read(`state-${s}.json`), ids.map((id) => read(`place-${id}.json`)));
  const multi = Object.values(INDEX.zips).filter((ids) => ids.length > 1);
  const counted = multi.map((ids) => { const b = ballotOf(INDEX.places[ids[0]].state, ids); return [ids.join('+'), stats.ballotPlace(b), b.st]; });
  check('stats: every ballot of several places in the index counts as its state code, never the places', multi.length > 0 && counted.every(([, p, s]) => p === s && /^[A-Z]{2}$/.test(p)), JSON.stringify(counted.filter(([, p, s]) => p !== s)));
  check('stats: one place counts as its id, a statewide ballot as its state', stats.ballotPlace(ballotOf('TX', ['austin-tx'])) === 'austin-tx' && stats.ballotPlace(ballotOf('TX', [])) === 'TX');
  // Off Vercel, with no queue: nothing happens and nothing throws.
  const had = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    delete globalThis.window;
    let threw = false;
    try { stats.track('ballot', { place: 'austin-tx', how: 'zip' }); } catch { threw = true; }
    check('stats: track with no analytics does nothing and never throws', !threw && typeof globalThis.window === 'undefined');
    globalThis.window = {};
    threw = false;
    try { stats.track('view', { name: 'plan' }); } catch { threw = true; }
    check('stats: track on a page without Vercel’s queue does nothing', !threw && !('va' in globalThis.window) && !('vaq' in globalThis.window));
    // With a queue (the package's own window.va): exactly the name and the data, and a ZIP or an at sign drops it.
    const got = [];
    globalThis.window = { va: (...a) => got.push(a) };
    stats.track('ballot', { place: 'austin-tx', how: 'zip' });
    stats.track('request', { kind: 'city' });
    stats.track('ballot', { place: '78704', how: 'zip' });
    stats.track('share', { act: 'a@b.co' });
    check('stats: with the queue, track hands it the name and data only, and drops a ZIP or an at sign', got.length === 2
      && JSON.stringify(got) === JSON.stringify([['event', { name: 'ballot', data: { place: 'austin-tx', how: 'zip' } }], ['event', { name: 'request', data: { kind: 'city' } }]]), JSON.stringify(got));
    globalThis.window = { va: () => { throw new Error('queue broke'); } };
    threw = false;
    try { stats.track('view', { name: 'ballot' }); } catch { threw = true; }
    check('stats: a broken queue never breaks the page', !threw);
  } finally {
    if (had) Object.defineProperty(globalThis, 'window', had); else delete globalThis.window;
  }
  // The promise the page makes (views/shelf.ts): the How text's privacy item and the Support shelf.
  const was = st.S.ui.report;
  st.S.ui.report = { kind: 'how', f: {}, what: '', tag: '', hint: '', along: null, state: 'edit', err: false, fk: '', back: null };
  const how = st.S.ui.report && views.shelf.shelfHTML();
  st.S.ui.report = { ...st.S.ui.report, kind: 'support' };
  const sup = views.shelf.shelfHTML();
  st.S.ui.report = was;
  check('stats: the How text says what is counted and what never is', how.includes('<li><b>Your privacy.</b> No accounts, no ads, no cookies. We count visits with Vercel’s cookie-free analytics (pages, rough location, device type), which never sees your address, ZIP, picks or who you are. Your picks stay on your device unless you share your save link. An address you type goes only to the Census Bureau’s lookup, and we never keep it. If the page breaks, it sends us a crash report with no address, no picks and no IP.</li>'));
  check('stats: no page says "no tracking" any more', !/no tracking/i.test(how) && !/no tracking/i.test(sup) && sup.includes('The guide is free, with no ads and no cookies.'));
}

/* ---------- extension points: run when the ledger's model modules exist ---------- */
const extra = path.join(ROOT, 'tests', 'model-ledger.mjs');
if (fs.existsSync(extra)) {
  const { run } = await import(extra);
  await run({ st, bl, util, geo, common, mods, views, open, head, read, INDEX, check });
}

await vite.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} model checks passed.`);
process.exit(failed.length ? 1 : 0);
