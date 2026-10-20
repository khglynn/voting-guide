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
for (const m of ['lens', 'tally', 'bulk', 'judges', 'labels', 'plan']) {
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
