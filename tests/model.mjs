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
for (const m of ['lens', 'tally', 'bulk', 'judges', 'labels', 'plan', 'address']) {
  const f = path.join(ROOT, 'src', 'model', `${m}.ts`);
  if (fs.existsSync(f)) mods[m] = await load(`/src/model/${m}.ts`);
}
/* The string views the ledger paints (no DOM needed to build their HTML). */
const views = {};
for (const v of ['ledger', 'cheat', 'open', 'lens', 'mast', 'setup', 'pass', 'planstrip']) views[v] = await load(`/src/views/${v}.ts`);

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
  set = address.setFromAddress(ballot, st.S.b, none, [{ meta: pm, props: { label: '1', commissioner: '4', jp: '4', sboe: '5' } }]);
  check('maps: the precinct map puts the constable race on in its precinct, with commissioner, JP and SBOE', st.S.b.mine.includes('tx-travis-constable-4') && st.S.b.mine.includes('tx-sboe-5')
    && st.S.b.districts['county|County Commissioner'] === 'tx-travis-commissioner-4' && st.S.b.districts['judicial|Justice of the Peace'] === 'tx-travis-jp-4'
    && set.join(' · ') === 'State Board of Education, District 5 · County Commissioner, Precinct 4 · Justice of the Peace, Precinct 4 · Constable, Precinct 4', set.join(' · '));
  address.setFromAddress(ballot, st.S.b, none, [{ meta: pm, props: { label: '2', commissioner: '3', jp: '5', sboe: '10' } }]);
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

  // The shipped maps, end to end at Austin City Hall (its point and its block, as the Census gave them).
  const hall = { point: { lon: -97.746669, lat: 30.26496 }, block: { lon: -97.7472987, lat: 30.2646818 } };
  const au = open('TX', ['austin-tx']);
  const answers = au.places[0].maps.map((meta) => ({ meta, a: maps.answerAt(maps.fromTopo(JSON.parse(fs.readFileSync(path.join(DATA, meta.file), 'utf8'))), hall) })).filter((x) => x.a.at === 'in').map((x) => ({ meta: x.meta, props: x.a.props }));
  const by = Object.fromEntries(answers.map((x) => [x.meta.kind, x.props]));
  check('maps: City Hall on the shipped maps: council 9, AISD 5, precinct 301 (commissioner 3, JP 5, SBOE 5)', by.council?.label === '9' && by['aisd-trustee']?.label === '5' && by.precincts?.label === '301' && by.precincts.commissioner === '3' && by.precincts.jp === '5' && by.precincts.sboe === '5' && !by['dvisd-trustee'], JSON.stringify(by));
  const line = address.addrSummary(address.setFromAddress(au, st.S.b, { cd: 10, upper: 14, lower: 49, schools: ['Austin Independent School District'], county: 'Travis' }, answers));
  check('maps: City Hall’s line names every race the address put on', line === 'Set from your address: U.S. Representative, District 10 · State Representative, District 49 · State Board of Education, District 5 · Justice of the Peace, Precinct 5 · Austin City Council, District 9.', line);
  check('maps: and nothing on City Hall’s ballot still depends on the address', views.ledger.addressCount() === 0, String(views.ledger.addressCount()));
  // The Census answer keeps the point and the block's interior point, for the maps only.
  const g = geo.parseCensus({ result: { addressMatches: [{ matchedAddress: 'TEST CITY HALL, AUSTIN, TX, 78701', coordinates: { x: -97.746669, y: 30.26496 }, geographies: { States: [{ STATE: '48' }], '2020 Census Blocks': [{ INTPTLAT: '+30.2646818', INTPTLON: '-097.7472987' }] } }] } })[0];
  check('maps: parseCensus keeps the point and the block’s interior point', g.point.lon === -97.746669 && g.point.lat === 30.26496 && g.block.lon === -97.7472987 && g.block.lat === 30.2646818, JSON.stringify([g.point, g.block]));
  const g0 = geo.parseCensus({ result: { addressMatches: [{ matchedAddress: 'TEST', geographies: {} }] } })[0];
  check('maps: and none when the Census sends none', g0.point === null && g0.block === null);
  st.S.b = st.emptyBallotState('');
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
