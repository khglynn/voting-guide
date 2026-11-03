#!/usr/bin/env node
/*
 * Model tests: the contracts the views must never break, checked without a browser.
 *
 *   npm run data && node tests/model.mjs        (reads the built bundles in public/data/)
 *
 * Loads the real TypeScript modules through Vite's SSR loader (no new dependencies) and feeds
 * them the real data bundles. What it guards:
 *   - the save link: v1 and v2 formats byte for byte, the pinned pre-ranked-choice v1 link from
 *     the live site, round trips, the optional notMine field, the lens recipe (11th field) and how
 *     an older client reads it
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
for (const m of ['lens', 'tally', 'bulk', 'judges', 'labels', 'plan', 'address', 'coverage', 'adds', 'search', 'sites']) {
  const f = path.join(ROOT, 'src', 'model', `${m}.ts`);
  if (fs.existsSync(f)) mods[m] = await load(`/src/model/${m}.ts`);
}
/* The string views the ledger paints (no DOM needed to build their HTML). */
const views = {};
for (const v of ['ledger', 'cheat', 'open', 'lens', 'mast', 'setup', 'pass', 'planstrip', 'shelf', 'coverage', 'adds']) views[v] = await load(`/src/views/${v}.ts`);
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
/* The same, with its dated text as it reads on `day`. A check about something else compares with the file's own
   text, so it must not change with the day CI runs (Oct 30: Florida's answers switch on Nov 1 and 2); the dated
   lines have their own checks ("stale lines" in model-ledger.mjs). */
function openOn(day, stCode, placeIds) {
  const ballot = open(stCode, placeIds);
  ballot.howto = mods.plan.localHowto(ballot.stateHowto, ballot.places, ballot.county, day);
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

/* ---------- 2a. the lens recipe, an 11th field (Election Day, Nov 3: "our save my plan url is sooooo long") ---------- */
{
  const same = (a, b) => (a === null || b === null ? a === b : JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort()));
  // The plain form of a link: what the encoder wrote before Nov 3 (sources as one hash each in field 8).
  const plainOf = (link, sources) => {
    const f = link.split('~');
    if (f.length < 11) return link;
    const out = [...f.slice(0, 7), sources.map((id) => util.hash(id)).join('.')];
    if (f[8] || f[9]) out.push(f[8]);
    if (f[9]) out.push(f[9]);
    return out.join('~');
  };
  // An older client reads fields by position and stops at the 10th (its decodeShare has no 11th).
  const oldRead = (ballot, link) => { const h = head(link); return st.decodeShare(ballot, { ...h, raw: h.raw.slice(0, 10) }).state; };

  // The Austin example: ZIP 78702, every district answered, 37 races decided, every source on the ballot on.
  const ballot = open('TX', ['austin-tx']);
  const b = st.emptyBallotState('78702');
  ballot.groups.forEach((g) => { b.districts[g.key] = g.members[0]; });
  const inDistrict = (id) => { const g = ballot.groups.find((x) => x.members.includes(id)); return !g || b.districts[g.key] === id; };
  for (const it of ballot.items) {
    if (Object.keys(b.picks).length >= 37) break;
    if (ballot.mayApply.has(it.id) || !inDistrict(it.id)) continue;
    if (it.kind === 'measure') b.picks[it.id] = 'YES';
    else if (it.is_retention && it.candidates.length === 1) b.picks[it.id] = 'YES';
    else if (it.candidates.length > 1 && !it.is_retention && !it.ranked_choice && it.vote_for === 1) b.picks[it.id] = it.candidates[1].name;
  }
  b.sources = ballot.endorsers.map((e) => e.id);
  const link = st.encodeShare(ballot, b);
  const before = plainOf(link, b.sources);
  const f = link.split('~');
  check(`lens recipe: the Austin example (${Object.keys(b.picks).length} picks, ${b.sources.length} sources) goes from ${before.length} to ${link.length} characters`,
    Object.keys(b.picks).length === 37 && b.sources.length > 40 && link.length < before.length * 0.65, `${before.length} -> ${link.length}`);
  check('lens recipe: written as an 11th field, sources field empty, head still v1', f[0] === 'v1' && f.length === 11 && f[7] === '' && f[10] === 'a', link.slice(-20));
  const back = st.decodeShare(ballot, head(link)).state;
  const plainBack = st.decodeShare(ballot, head(before)).state;
  check('lens recipe: the Austin link brings back every source and every pick and district', same(back.sources, b.sources)
    && JSON.stringify(back.picks) === JSON.stringify(b.picks) && JSON.stringify(back.districts) === JSON.stringify(b.districts));
  check('lens recipe: it means what the plain link means', same(back.sources, plainBack.sources) && JSON.stringify(back.picks) === JSON.stringify(plainBack.picks));
  const old = oldRead(ballot, link);
  check('lens recipe: an older client keeps every pick and district and falls back to the default lens', old.sources === null
    && JSON.stringify(old.picks) === JSON.stringify(b.picks) && JSON.stringify(old.districts) === JSON.stringify(b.districts));

  // Every chip mix, a party, one source off, one on, a few by hand: never longer, and the same sources come back.
  const def = ballot.endorsers.filter((e) => e.default_on).map((e) => e.id);
  const chip = (k) => mods.lens.chipMembers(ballot, k).map((e) => e.id);
  const keys = ['papers', 'progressive', 'conservative', 'unions'];
  const lists = [def, def.slice(1), [...def, ...chip('conservative').slice(0, 1)], ballot.endorsers.slice(0, 3).map((e) => e.id), [], null];
  for (let m = 1; m < 16; m++) lists.push([...def, ...keys.filter((_, i) => m & (1 << i)).flatMap(chip)]);
  for (const p of mods.lens.partiesOnBallot(ballot)) lists.push([...def, ...p.sources.map((e) => e.id)]);
  let longer = 0, wrong = 0, oldWrong = 0, used = 0;
  for (const sources of lists) {
    for (const withRanksAndNotMine of [false, true]) {
      const s = { ...b, sources, notMine: withRanksAndNotMine && ballot.mayApply.size ? [[...ballot.mayApply][0]] : [] };
      const l = st.encodeShare(ballot, s);
      if (l.split('~').length === 11) used++;
      if (sources && sources.length && l.length > plainOf(l, sources).length) longer++;
      const got = st.decodeShare(ballot, head(l)).state;
      if (!same(got.sources, sources) || JSON.stringify(got.picks) !== JSON.stringify(s.picks) || JSON.stringify(got.notMine) !== JSON.stringify(s.notMine)) wrong++;
      const o = oldRead(ballot, l);
      if (JSON.stringify(o.picks) !== JSON.stringify(s.picks) || JSON.stringify(o.notMine) !== JSON.stringify(s.notMine)) oldWrong++;
    }
  }
  check(`lens recipe: ${lists.length} lenses on Austin, never a longer link (recipe used ${used} times)`, longer === 0 && used > 10, String(longer));
  check('lens recipe: each lens comes back as the same sources, with the same picks and notMine', wrong === 0, String(wrong));
  check('lens recipe: an older client keeps the picks and notMine on every one', oldWrong === 0, String(oldWrong));
  check('lens recipe: no sources, the defaults and three hand picks stay the plain form', st.encodeShare(ballot, { ...b, sources: [] }).split('~')[7] === '0'
    && st.encodeShare(ballot, { ...b, sources: null }).split('~').length === 8 && st.encodeShare(ballot, { ...b, sources: ballot.endorsers.slice(0, 3).map((e) => e.id) }).split('~').length === 8);

  // What each recipe means, pinned by hand on Lakewood (the data decides the members; the grammar doesn't change).
  const lw = open('CO', ['lakewood-co']);
  const base = 'v1~CO~lakewood-co~80226~ra8yvi07~~~~~~';
  const read = (r) => st.decodeShare(lw, head(base + r)).state.sources;
  const lwDef = lw.endorsers.filter((e) => e.default_on).map((e) => e.id);
  const dp = lwDef[0], extra = lw.endorsers.find((e) => !e.default_on).id;
  check('lens recipe: "a" is every source on the ballot', same(read('a'), lw.endorsers.map((e) => e.id)));
  check('lens recipe: "d" is the defaults, "u" the Unions chip', same(read('d'), lwDef) && same(read('u'), mods.lens.chipMembers(lw, 'unions').map((e) => e.id)));
  check('lens recipe: -hash takes one out, +hash adds one', same(read(`d-${util.hash(dp)}`), lwDef.filter((id) => id !== dp)) && same(read(`d+${util.hash(extra)}`), [...lwDef, extra]));
  check('lens recipe: an unknown hash is dropped, as in the plain form', same(read(`d+zzzzz`), lwDef));
  check('lens recipe: a field it can’t read (a letter it doesn’t know) falls back to the sources field: the defaults', read('dq') === null && read('d+abc') === null && read('A') === null);
  check('lens recipe: an empty 11th field changes nothing', st.decodeShare(lw, head('v1~CO~lakewood-co~80226~ra8yvi07~~~mlkqq~~~')).state.sources.join() === 'denver-post-eb');

  // The 11th field is the link's last: a chat app that keeps the "." or ")" after a link, or a "%20", mustn't wipe the
  // lens back to the defaults (Opus review, Nov 3). Both a recipe ending in a letter and one ending in a +hash.
  const endsInHash = st.encodeShare(ballot, { ...b, sources: [...def, chip('unions')[0]] });
  const tails = ['.', ')', ',', '%20', ').', '.%20'];
  const smeared = [];
  for (const l of [link, endsInHash]) {
    const want = st.decodeShare(ballot, head(l)).state.sources;
    for (const t of tails) if (!same(st.decodeShare(ballot, head(l + t)).state.sources, want)) smeared.push(`${l.split('~')[10]}${t}`);
  }
  check('lens recipe: trailing punctuation after the link reads the same sources', /^d\+[0-9a-z]{5}$/.test(endsInHash.split('~')[10]) && smeared.length === 0, `${endsInHash.split('~')[10]} ${smeared.join(' ')}`);
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

/* ---------- 3b. two candidates with one last name ---------- */
{
  const c = read('state-TX.json').items.find((x) => x.id === 'tx-supreme-court-place-7');
  check('candidates: the two Hawkinses in one race each show a full name', !!c && c.candidates.map((k) => k.short).join() === 'Kyle Hawkins,Kristen Hawkins');
  // The data's `short` for a two-word surname (review of #71, Nov 1): "Reyes Uranga", never "Uranga".
  const wrd = read('place-long-beach-ca.json').items.find((x) => x.id === 'wrd-division-3');
  check('candidates: a two-word surname from the data shows whole', !!wrd && wrd.candidates.find((k) => k.name === 'Tonia Reyes Uranga')?.short === 'Reyes Uranga', wrd && wrd.candidates.map((k) => k.short).join());
  const dupes = fs.readdirSync(DATA).filter((f) => /^(state|place)-.*\.json$/.test(f)).flatMap((f) => (read(f).items || [])
    .filter((x) => x.kind === 'contest' && new Set(x.candidates.map((k) => k.short)).size < x.candidates.length).map((x) => `${f} ${x.id}`));
  check('candidates: no race shows two candidates under one short name', dupes.length === 0, dupes.join(', '));
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
  check('stats: a path that won’t decode, or an address that won’t parse, sends nothing', stats.cleanUrl('https://vote.kevinhg.com/%E0%A4%A') === null && stats.cleanUrl('not an address') === null);
  check('stats: only the path is checked: a preview host with five digits in a row still counts, and a user name goes', stats.cleanUrl('https://voting-guide-a12345bcd-kevinhg.vercel.app/?try=aunt') === 'https://voting-guide-a12345bcd-kevinhg.vercel.app/' && stats.cleanUrl('https://me@vote.kevinhg.com/') === 'https://vote.kevinhg.com/');
  const ev = { type: 'event', url: 'https://vote.kevinhg.com/?try=fresh#v2~CO~aurora-co~80010', payload: { name: 'view', data: { name: 'plan' } } };
  const sent = stats.beforeSend(ev);
  check('stats: beforeSend cuts the address and keeps the rest of the event', !!sent && sent.url === 'https://vote.kevinhg.com/' && sent.type === 'event' && sent.payload === ev.payload && ev.url.includes('#'), JSON.stringify(sent));
  check('stats: beforeSend drops an event whose address still holds a ZIP', stats.beforeSend({ type: 'pageview', url: 'https://vote.kevinhg.com/78704?x=1' }) === null);
  check('stats: it loads on the guide’s Vercel hosts only', ['vote.kevinhg.com', 'voting-guide-silk.vercel.app', 'voting-guide-git-analytics-kevinhg.vercel.app'].every(stats.onVercel)
    && !['localhost', '127.0.0.1', 'evilkevinhg.com', 'vote.kevinhg.com.example.org', 'vercel.app.example.org'].some(stats.onVercel));
  check('stats: event values are short plain tokens, never a ZIP or an at sign', stats.plainData({ state: 'TX', how: 'zip' }) && stats.plainData({ kind: 'follow_up' }) && stats.plainData({ state: 'MO' })
    && !stats.plainData({ state: '78704' }) && !stats.plainData({ state: 'TX-78704' }) && !stats.plainData({ kind: 'a@b.co' }) && !stats.plainData({ n: 5 }) && !stats.plainData({ how: 'two words' }) && !stats.plainData({ how: '' }));
  // A ballot counts by its state only (app.ts shown() sends b.st): a place, or a set of places, that only one ZIP
  // leads to would name the ZIP. Every ballot the index can open, each ZIP's places and each statewide one,
  // must count as a two-letter state the index covers with a statewide ballot (which any of its ZIPs opens).
  const ballotOf = (s, ids) => bl.buildBallot(read(`state-${s}.json`), ids.map((id) => read(`place-${id}.json`)));
  const sets = [...new Set(Object.values(INDEX.zips).map((ids) => ids.join('+')))].map((k) => k ? k.split('+') : []);
  const opens = [...sets.map((ids) => [ids.length ? INDEX.places[ids[0]].state : null, ids]), ...Object.keys(INDEX.states).map((s) => [s, []])].filter(([s]) => s);
  const odd = opens.filter(([s, ids]) => {
    const v = ballotOf(s, ids).st;
    return !(/^[A-Z]{2}$/.test(v) && INDEX.states[v] && stats.plainData({ state: v, how: 'zip' }) && ids.every((id) => INDEX.places[id].state === v));
  }).map(([s, ids]) => ids.join('+') || s);
  check('stats: every ballot the index can open counts as its state code, which has a statewide ballot of its own', opens.length > Object.keys(INDEX.states).length && odd.length === 0, JSON.stringify(odd));
  check('stats: the places one ZIP alone leads to (Ballwin, Clayton, Webster Groves) are in the index, and count as their state', ['ballwin-mo', 'clayton-mo', 'webster-groves-mo'].every((id) => Object.values(INDEX.zips).filter((ids) => ids.includes(id)).length === 1 && ballotOf('MO', [id]).st === 'MO'));
  // Torrance is wholly in Assembly District 66, so the shared LA race is on its ballot outright (its scope says "all of Torrance"), not a "may apply".
  const torr = ballotOf('CA', ['torrance-ca']);
  check('torrance: Assembly District 66 is on the ballot, not a maybe', torr.order.includes('ca-assembly-66') && !torr.mayApply.has('ca-assembly-66'));
  // The referring site, as Vercel's script may see it once startStats() has shadowed document.referrer.
  check('stats: referrerOrigin keeps the origin and drops the path and the query', stats.referrerOrigin('https://referrer.example/search?zip=78704&q=a@b.co#x') === 'https://referrer.example' && stats.referrerOrigin('http://news.example.org:8080/a/b') === 'http://news.example.org:8080' && stats.referrerOrigin('https://me:pw@referrer.example/') === 'https://referrer.example');
  check('stats: referrerOrigin gives nothing for no referrer or one that isn’t a web address', ['', 'not an address', 'about:blank', 'android-app://com.google.android.gm/', 'javascript:alert(1)', 'file:///etc/hosts', null, undefined].every((r) => stats.referrerOrigin(r) === ''));
  // Off Vercel, with no queue: nothing happens and nothing throws.
  const had = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    delete globalThis.window;
    let threw = false;
    try { stats.track('ballot', { state: 'TX', how: 'zip' }); } catch { threw = true; }
    check('stats: track with no analytics does nothing and never throws', !threw && typeof globalThis.window === 'undefined');
    globalThis.window = {};
    threw = false;
    try { stats.track('view', { name: 'plan' }); } catch { threw = true; }
    check('stats: track on a page without Vercel’s queue does nothing', !threw && !('va' in globalThis.window) && !('vaq' in globalThis.window));
    // With a queue (the package's own window.va): exactly the name and the data, and a ZIP or an at sign drops it.
    const got = [];
    globalThis.window = { va: (...a) => got.push(a) };
    stats.track('ballot', { state: 'TX', how: 'zip' });
    stats.track('request', { kind: 'city' });
    stats.track('ballot', { state: '78704', how: 'zip' });
    stats.track('share', { act: 'a@b.co' });
    check('stats: with the queue, track hands it the name and data only, and drops a ZIP or an at sign', got.length === 2
      && JSON.stringify(got) === JSON.stringify([['event', { name: 'ballot', data: { state: 'TX', how: 'zip' } }], ['event', { name: 'request', data: { kind: 'city' } }]]), JSON.stringify(got));
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
  // Oct 28: one fact to a sub-bullet (Kevin: "give it sub-bullets so it's easy to skim"), every one still there.
  const priv = (how.match(/<li class="how-priv"><b>Your privacy\.<\/b><ul class="how-sub">([\s\S]*?)<\/ul><\/li>/) || [])[1] || '';
  const facts = ['<li>No accounts, no ads, no cookies.</li>', 'We count visits with Vercel’s cookie-free analytics.', 'the screens you open', 'when you send a form (never what’s in it)', 'which state your ballot is for', 'the site that sent you here', 'your rough location, browser, operating system and device type',
    'never gets your address, ZIP or picks', 'doesn’t keep your IP address', 'can’t tell who you are', '<li>Your picks stay on your device unless you share your save link.</li>', '<li>An address you type goes only to the Census Bureau’s lookup, and we never keep it.</li>', '<li>If the page breaks, it sends us a crash report with no address, no picks and no IP address.</li>'];
  check('stats: the How text says what is counted and what never is, one fact to a line', (priv.match(/<li>/g) || []).length === 6 && facts.every((f) => priv.includes(f)), facts.filter((f) => !priv.includes(f)).join(' | ') || priv.slice(0, 200));
  check('stats: no page says "no tracking" any more', !/no tracking/i.test(how) && !/no tracking/i.test(sup) && sup.includes('The guide is free, with no ads and no cookies.'));
}

/* ---------- a source you asked for, on your ballot before the merge (Oct 28, model/adds.ts) ----------
   The request's code, the vg-adds store (never vg2 or the link), the form script's status read strictly, and
   what a branch preview may bring: only sources the live data lacks, each record and row rebuilt the way
   build-data writes them, off for everyone else. A source this device holds survives a chip tap before its
   preview answers (the judge's reload gap). */
{
  const ad = mods.adds;
  const mem = new Map();
  const had = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); } }, setTimeout, clearTimeout } });
  const keep = { b: st.S.b, ballot: st.S.ballot, view: st.S.view, uiView: st.S.ui.view, tryMode: st.S.tryMode, index: st.S.index };
  try {
    // The code: 12 letters, every letter as likely as any other (bytes from 234 up are thrown back).
    const codes = Array.from({ length: 400 }, () => ad.newCode());
    check('adds: a request code is 12 lowercase letters, and 400 of them are all different', codes.every((c) => /^[a-z]{12}$/.test(c)) && new Set(codes).size === 400);
    let calls = 0;
    const fixed = (n) => { calls++; const a = new Uint8Array(n); a.fill(calls === 1 ? 255 : 0); if (calls === 1) { a[0] = 0; a[1] = 233; a[2] = 234; a[3] = 25; } return a; };
    check('adds: a byte from 234 up is thrown back, so there is no lean toward early letters', ad.newCode(fixed) === 'azzaaaaaaaaa', ad.newCode(() => new Uint8Array(16)));
    // The store.
    const T = Date.UTC(2026, 9, 28, 18);
    check('adds: remembered under vg-adds only, with whether a reply was asked, never the contact', ad.rememberAdd('abcdefghijkl', ' AURA ', true, T) && [...mem.keys()].join() === 'vg-adds'
      && JSON.stringify(JSON.parse(mem.get('vg-adds'))) === JSON.stringify([{ code: 'abcdefghijkl', name: 'AURA', at: T, reply: true }]), mem.get('vg-adds'));
    check('adds: a code that isn’t 12 letters is never kept', !ad.rememberAdd('ABCDEFGHIJKL', 'x', false, T) && !ad.rememberAdd('abc', 'x', false, T) && ad.readAdds(T).length === 1);
    ad.rememberAdd('bbbbbbbbbbbb', 'Second', false, T + 1000);
    check('adds: newest first', ad.readAdds(T + 2000).map((a) => a.code).join() === 'bbbbbbbbbbbb,abcdefghijkl');
    ad.updateAdd('abcdefghijkl', { st: 'ready', ids: ['aura'] }, T + 2000);
    check('adds: an update keeps the status word and the ids', JSON.stringify(ad.readAdds(T + 2000).find((a) => a.code === 'abcdefghijkl')) === JSON.stringify({ code: 'abcdefghijkl', name: 'AURA', at: T, reply: true, st: 'ready', ids: ['aura'] }));
    check('adds: the ids a device holds', [...ad.heldIds(T + 2000)].join() === 'aura');
    check('adds: gone after three days', ad.readAdds(T + 3 * 864e5 - 1).length === 2 && ad.readAdds(T + 3 * 864e5).map((a) => a.code).join() === 'bbbbbbbbbbbb' && ad.readAdds(T + 3 * 864e5 + 1000).length === 0);
    for (let i = 0; i < 7; i++) ad.rememberAdd(`cccccccccc${String.fromCharCode(97 + i)}${String.fromCharCode(97 + i)}`, `n${i}`, false, T + 5000 + i);
    check('adds: five at most, the newest kept', ad.readAdds(T + 9000).length === 5 && ad.readAdds(T + 9000)[0].code === 'ccccccccccgg');
    ad.forgetAdd('ccccccccccgg', T + 9000);
    check('adds: forgotten', !ad.readAdds(T + 9000).some((a) => a.code === 'ccccccccccgg'));
    mem.set('vg-adds', JSON.stringify({ code: 'abcdefghijkl' }));
    check('adds: anything but a list reads as none', ad.readAdds(T).length === 0);
    mem.set('vg-adds', JSON.stringify([{ code: 'abcdefghijkl', name: 'A', at: T, ids: ['ok-id', 'Bad Id', 7], st: 'nonsense', quiet: 'yes', email: 'a@b.co' }, { code: 'x', at: T }, null, 'abc']));
    const back = ad.readAdds(T);
    check('adds: a stored entry is read field by field: a bad id, state or flag drops, nothing else rides along', back.length === 1 && JSON.stringify(back[0]) === JSON.stringify({ code: 'abcdefghijkl', name: 'A', at: T, ids: ['ok-id'] }), JSON.stringify(back));
    mem.clear();
    // The status, strictly.
    check('adds: no answer, ok false or nonsense is "nothing yet"', ad.readStatus(null) === null && ad.readStatus({ ok: false }) === null && ad.readStatus('ready') === null && ad.readStatus([1]) === null);
    const rs = ad.readStatus({ ok: true, state: 'not_a_source', name: '  The   Paper ', note: 'x'.repeat(400), id: 'the-paper', extra: '<b>' });
    check('adds: a status keeps its word, a one-line name, a note cut at 200, and an id in the shape of one', rs.state === 'not_a_source' && rs.name === 'The Paper' && rs.note.length === 200 && rs.id === 'the-paper' && !('extra' in rs), JSON.stringify(rs).slice(0, 120));
    check('adds: a state the page doesn’t know is "still working", and a bad id is none', ad.readStatus({ ok: true, state: 'launching', id: '../x' }).state === null && ad.readStatus({ ok: true, state: 'ready', id: '../x' }).id === null);

    // What a preview brings: Austin's live bundle without AURA, and the real one as the preview.
    const sbx = read('state-TX.json');
    const real = read('place-austin-tx.json');
    const liveP = JSON.parse(JSON.stringify(real));
    liveP.endorsers = liveP.endorsers.filter((e) => e.id !== 'aura');
    for (const t of Object.keys(liveP.endorsements)) { delete liveP.endorsements[t].aura; if (!Object.keys(liveP.endorsements[t]).length) delete liveP.endorsements[t]; }
    const before = JSON.stringify([sbx, liveP]);
    const liveB = bl.buildBallot(sbx, [liveP]);
    const places = new Set(Object.keys(INDEX.places));
    const live = ad.idsIn([sbx, liveP]);
    const f = ad.pickNew([sbx, real], live, liveB.byId, liveB.order, places);
    const auraRows = Object.entries(real.endorsements).filter(([t, r]) => r.aura && liveB.byId.has(t));
    check('adds: a preview brings only the source the live data lacks', f.endorsers.map((e) => e.id).join() === 'aura', f.endorsers.map((e) => e.id).join());
    const ae = f.endorsers[0];
    check('adds: its record starts off for everyone, is marked as a preview, and keeps its fields', ae.default_on === false && ae.preview === true && ae.name === 'AURA' && ae.type === 'advocacy' && ae.lean === 'lean_left' && ae.lean_basis_kind === 'mission' && ae.guide_url === real.endorsers.find((e) => e.id === 'aura').guide_url && ae.home_places.join() === 'austin-hays-tx,austin-tx,austin-williamson-tx', JSON.stringify(ae).slice(0, 200));
    const same = (a, b) => ['s', 'c', 'note', 'why', 'url', 'date', 'conf'].every((k) => JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null));
    check('adds: every one of its rows on this ballot comes along, as the data has it', auraRows.length > 10 && Object.keys(f.rows).length === auraRows.length && auraRows.every(([t, r]) => f.rows[t] && same(f.rows[t].aura, r.aura)), `${Object.keys(f.rows).length} of ${auraRows.length}`);
    const nb = bl.buildBallot(ad.withFound(sbx, f), [liveP]);
    const realB = bl.buildBallot(sbx, [real]);
    check('adds: the ballot it builds has the source and its rows, as the real data would', nb.eById.has('aura') && nb.endorsers.some((e) => e.id === 'aura') && auraRows.every(([t]) => !!nb.ends[t].aura)
      && nb.order.join() === realB.order.join() && nb.endorsers.length === realB.endorsers.length, `${nb.endorsers.length} vs ${realB.endorsers.length}`);
    check('adds: the live bundles are left exactly as they came', JSON.stringify([sbx, liveP]) === before);
    check('adds: a source the live data already has is never taken again', ad.pickNew([sbx, real], ad.idsIn([sbx, real]), realB.byId, realB.order, places).endorsers.length === 0);
    check('adds: only the ids a request became, once it has some', ad.pickNew([sbx, real], live, liveB.byId, liveB.order, places, ['someone-else']).endorsers.length === 0 && ad.pickNew([sbx, real], live, liveB.byId, liveB.order, places, ['aura']).endorsers.length === 1);
    // Anything that doesn't check out is left out.
    const race = liveB.items.find((it) => it.kind === 'contest' && !it.is_retention && it.candidates.length > 1 && liveB.order.includes(it.id));
    const meas = liveB.items.find((it) => it.kind === 'measure' && liveB.order.includes(it.id));
    const mk = (rows, e = {}) => ({ state: 'TX', endorsers: [{ id: 'new-src', name: 'New Source', short: 'New', type: 'advocacy', lean: null, guide_url: 'https://example.org/g', default_on: true, endorses_candidates: true, endorses_measures: true, ...e }], endorsements: rows });
    const row = (o) => ({ s: 'endorsed', c: null, note: null, why: null, url: 'https://example.org/g', date: '2026-10-28', conf: 'verified', ...o });
    const got = ad.pickNew([mk({
      [race.id]: { 'new-src': row({ c: [race.candidates[0].name] }) },
      [meas.id]: { 'new-src': row({ c: ['MAYBE'] }) },
      'no-such-race': { 'new-src': row({ c: ['YES'] }) },
    }, { guide_url: 'javascript:alert(1)', onclick: 'x', default_on: true, lean_basis_kind: 'mission' })], live, liveB.byId, liveB.order, places);
    const g = got.endorsers[0];
    check('adds: a row naming a candidate on the race is kept; a measure row that isn’t YES or NO, and a race the ballot lacks, are dropped', !!got.rows[race.id] && !got.rows[meas.id] && !got.rows['no-such-race'], JSON.stringify(Object.keys(got.rows)));
    check('adds: a record is rebuilt field by field: no stray field, no script link, off for everyone, no basis kind without a lean', !!g && !('onclick' in g) && g.guide_url === null && g.default_on === false && !('lean_basis_kind' in g), JSON.stringify(g));
    check('adds: a choice that isn’t a candidate on the race drops the row', ad.cleanRow(row({ c: ['Not A Candidate'] }), race) === null && ad.cleanRow(row({ c: [race.candidates[0].name, race.candidates[0].name] }), race) === null && !!ad.cleanRow(row({ c: [race.candidates[0].name] }), race));
    check('adds: a row with a bad status, confidence or a choice on a non-pick is dropped; a bad link or date is cleared', ad.cleanRow(row({ s: 'maybe' }), race) === null && ad.cleanRow(row({ conf: 'sure' }), race) === null && ad.cleanRow(row({ s: 'not_found', c: ['YES'] }), meas) === null
      && ad.cleanRow(row({ c: ['YES'], url: 'http://example.org', date: 'Oct 28' }), meas).url === null && ad.cleanRow(row({ c: ['YES'], date: 'Oct 28' }), meas).date === null);
    check('adds: a source with no row on this ballot doesn’t count', ad.pickNew([mk({ 'no-such-race': { 'new-src': row({ c: ['YES'] }) } })], live, liveB.byId, liveB.order, places).endorsers.length === 0);
    const four = { state: 'TX', endorsers: ['n-a', 'n-b', 'n-c', 'n-d'].map((id) => ({ id, name: id, type: 'other' })), endorsements: { [race.id]: Object.fromEntries(['n-a', 'n-b', 'n-c', 'n-d'].map((id) => [id, row({ c: [race.candidates[0].name] })])) } };
    check('adds: more than three new sources (an old branch) takes none', ad.pickNew([four], live, liveB.byId, liveB.order, places).endorsers.length === 0);
    check('adds: two reads together, and without the ones now live', ad.mergeFound(f, got).endorsers.map((e) => e.id).sort().join() === 'aura,new-src' && ad.withoutIds(ad.mergeFound(f, got), new Set(['aura'])).endorsers.map((e) => e.id).join() === 'new-src' && ad.withoutIds(f, new Set(['aura'])) === null);

    // The reload gap: a held source this ballot lacks right now stays in your list through a chip tap.
    st.S.ballot = liveB; st.S.b = st.emptyBallotState('78704');
    st.S.b.sources = [...liveB.endorsers.filter((e) => e.default_on).map((e) => e.id), 'aura'];
    mods.lens.toggleChip(liveB, 'papers'); mods.lens.toggleChip(liveB, 'papers');
    check('adds: without a held request, a chip tap drops a source the ballot doesn’t have (as before)', st.S.b.sources === null, JSON.stringify(st.S.b.sources));
    mem.set('vg-adds', JSON.stringify([{ code: 'abcdefghijkl', name: 'AURA', at: Date.now(), ids: ['aura'] }]));
    st.S.b.sources = [...liveB.endorsers.filter((e) => e.default_on).map((e) => e.id), 'aura'];
    mods.lens.toggleChip(liveB, 'papers');
    const off = st.S.b.sources;
    mods.lens.toggleChip(liveB, 'papers');
    check('adds: with it held, a chip tap keeps it, off and on again', Array.isArray(off) && off.join() === 'aura' && Array.isArray(st.S.b.sources) && st.S.b.sources.includes('aura') && st.S.b.sources.length === liveB.endorsers.filter((e) => e.default_on).length + 1, `${JSON.stringify(off)} ${JSON.stringify(st.S.b.sources)}`);
    // A save link opened in the gap (the preview timed out, so the ballot lacks AURA) keeps it (Codex, Oct 28), and
    // the link itself is the same as ever.
    const gapState = { ...st.S.b, sources: [...liveB.endorsers.filter((e) => e.default_on).map((e) => e.id), 'aura'] };
    const gapLink = st.encodeShare(liveB, gapState);
    const gapBack = st.decodeShare(liveB, head(gapLink)).state.sources;
    check('adds: a save link opened before the preview answers keeps the held source', Array.isArray(gapBack) && gapBack.includes('aura') && gapBack.length === gapState.sources.length, JSON.stringify(gapBack));
    mem.set('vg-adds', '[]');
    check('adds: with nothing held, the link drops a source the ballot lacks, as before', !st.decodeShare(liveB, head(gapLink)).state.sources.includes('aura'));
    // Since Nov 3 the defaults plus one travel as the lens recipe: the held source is one +hash there, as any switch.
    check('adds: and the held source is one more hash in the link, as any switch', gapLink === st.encodeShare(liveB, gapState)
      && gapLink.split('~')[7] === '' && gapLink.split('~')[10] === `d+${util.hash('aura')}`, gapLink.split('~').slice(7).join('~'));
    mem.set('vg-adds', JSON.stringify([{ code: 'abcdefghijkl', name: 'AURA', at: Date.now(), ids: ['aura'] }]));
    // The other direction (Codex and Opus reviews of the lens recipe, Nov 3): the link made WHILE the preview is on the
    // ballot, opened in a reload gap (the ballot lacks it). A letter never covers a preview, so AURA always travels as
    // its own +hash and survives the gap; without that, "every source" or a chip folded it in and lost it for good.
    const auraH = `+${util.hash('aura')}`;
    const nbDef = nb.endorsers.filter((e) => e.default_on).map((e) => e.id);
    const nbChip = (k) => mods.lens.chipMembers(nb, k).map((e) => e.id);
    const previewCases = [['every source', nb.endorsers.map((e) => e.id)], ['Progressive', nbChip('progressive')], ['defaults + Progressive', [...nbDef, ...nbChip('progressive')]], ['defaults + AURA', [...nbDef, 'aura']]];
    const sorted = (l) => JSON.stringify([...new Set(l || [])].sort());
    const lost = previewCases.filter(([, sources]) => {
      const l = st.encodeShare(nb, { ...st.emptyBallotState('78704'), sources });
      const f = l.split('~');
      const back = st.decodeShare(liveB, head(l)).state.sources;
      return !sources.includes('aura') || f.length !== 11 || !f[10].endsWith(auraH) || !Array.isArray(back) || !back.includes('aura')
        || sorted(st.decodeShare(nb, head(l)).state.sources) !== sorted(sources);
    }).map(([n]) => n);
    check('adds: a link made with the preview on and opened in the reload gap keeps it (its own +hash in the recipe)', lost.length === 0, lost.join(', '));
    // The preview turned off: "every source but AURA" is plain "a", with no -hash to carry.
    const allButAura = st.encodeShare(nb, { ...st.emptyBallotState('78704'), sources: nb.endorsers.map((e) => e.id).filter((id) => id !== 'aura') });
    check('adds: a preview you left off needs no -hash: every other source is just "a"', allButAura.split('~')[10] === 'a' && !st.decodeShare(nb, head(allButAura)).state.sources.includes('aura'), allButAura.split('~').slice(7).join('~'));
    // A friend's "every source" link, made where AURA isn't a preview (live data without it), opened on this device,
    // which holds AURA as a preview: it doesn't switch AURA on for you.
    const friendA = st.encodeShare(liveB, { ...st.emptyBallotState('78704'), sources: liveB.endorsers.map((e) => e.id) });
    const opened = st.decodeShare(nb, head(friendA)).state.sources;
    check('adds: a friend\'s "a" link doesn\'t switch on a preview this device holds', friendA.split('~')[10] === 'a' && Array.isArray(opened) && !opened.includes('aura') && sorted(opened) === sorted(liveB.endorsers.map((e) => e.id)), JSON.stringify(opened && opened.length));
    st.S.ballot = nb;
    mods.lens.setSources(nb, st.S.b.sources.filter((id) => id !== 'aura'));
    check('adds: once the ballot has it, its own switch turns it off', !(st.S.b.sources || []).includes('aura'), JSON.stringify(st.S.b.sources));

    // "Show endorsements" back on keeps a held source too (Codex, Oct 28), and is the defaults otherwise.
    st.S.ballot = liveB;
    st.S.b.sources = ['aura'];
    const on2 = mods.lens.backOn(liveB);
    check('adds: "Show endorsements" back on, with only a held source in the list, keeps it beside the defaults', Array.isArray(on2) && on2.includes('aura') && on2.length === liveB.endorsers.filter((e) => e.default_on).length + 1, JSON.stringify(on2));
    mem.clear();
    check('adds: and with nothing held, back on is the defaults (null)', mods.lens.backOn(liveB) === null);
    // Which source a live request became: only what the requester typed decides (Codex, Oct 28).
    const es = realB.endorsers;
    check('adds: a typed name matches its source exactly, short or long', ad.typedSource('AURA', es)?.id === 'aura' && ad.typedSource('  aura ', es)?.id === 'aura');
    const chron = es.find((e) => /chronicle/i.test(e.name));
    check('adds: a typed name inside a source’s name, as whole words, matches when it’s the only one', !chron || ad.typedSource(chron.name.replace(/^The\s+/i, '').split(' ').slice(0, 2).join(' '), es)?.id === chron.id, chron ? chron.name : 'no Chronicle on this ballot');
    check('adds: a typed link matches the source whose guide is on that site', ad.typedSource('https://www.aura-atx.org/whatever', es)?.id === 'aura');
    check('adds: part of a word, or a short word, matches nothing', ad.typedSource('aur', es) === null && ad.typedSource('the', es) === null && ad.typedSource('', es) === null);
    const two = [{ ...es[0], id: 'x1', name: 'Travis County Democratic Party', short: 'Travis Dems' }, { ...es[0], id: 'x2', name: 'Texas Democratic Party', short: 'Texas Dems' }];
    check('adds: a name more than one source shares matches none', ad.typedSource('Democratic', two) === null);
    check('adds: the status’s id may choose among the ones that match, never add one', ad.typedSource('Democratic', two, 'x2')?.id === 'x2' && ad.typedSource('Democratic', two, 'aura') === null && ad.typedSource('nothing like it', es, 'aura') === null);
    check('adds: the status’s time is kept only in its own shape', ad.readStatus({ ok: true, state: 'live', at: '2026-10-28T18:00:00.000Z' }).at === '2026-10-28T18:00:00.000Z' && ad.readStatus({ ok: true, state: 'live', at: 'yesterday' }).at === null);

    // The banner: one request, its line by its status and how long it has waited.
    const va = views.adds;
    const now = Date.now();
    const A = (o) => ({ code: 'abcdefghijkl', name: 'https://www.aura-atx.org/guide', at: now - 60e3, ...o });
    va.statusOf.clear();
    check('adds banner: a link reads as its site', va.addName(A({})) === 'aura-atx.org' && va.addName(A({ name: 'x'.repeat(80) })).length === 60);
    const line = (o, s0) => { va.statusOf.clear(); if (s0) va.statusOf.set('abcdefghijkl', { state: s0, name: 'AURA', note: s0 === 'not_a_source' ? 'It’s a news story about other people’s picks.' : '', id: null }); return va.addLine(A(o), now); };
    check('adds banner: each status has its line', line({}) === 'Request sent for aura-atx.org. You can keep going.' && line({}, 'reading') === 'Reading AURA’s page.' && line({}, 'checking') === 'Checking AURA’s picks.'
      && line({}, 'held') === 'Kevin is checking AURA himself. If he adds it, it shows up here.' && line({}, 'blocked') === 'We can’t read AURA’s page. Can you paste their picks?'
      && line({}, 'not_a_source') === 'We can’t add AURA. It’s a news story about other people’s picks.' && line({ reply: true }, 'failed') === 'Couldn’t add AURA. Kevin will follow up.' && line({}, 'failed') === 'Couldn’t add AURA. Kevin will take a look.', line({}, 'held'));
    check('adds banner: after 20 minutes, still waiting says Kevin will follow up (or take a look, with no way to reach you)', line({ at: now - 20 * 60e3, reply: true }, 'checking') === 'Still waiting on AURA. Kevin will follow up.' && line({ at: now - 21 * 60e3 }) === 'Still waiting on aura-atx.org. Kevin will take a look.');
    check('adds banner: the last word saved shows before this visit reads one', line({ st: 'blocked' }) === 'We can’t read aura-atx.org’s page. Can you paste their picks?');
    check('adds banner: the newest open request speaks; a closed, folded in or live one doesn’t', ad.bannerAdd([A({ code: 'bbbbbbbbbbbb', quiet: true }), A({ code: 'cccccccccccc', ids: ['aura'] }), A({ code: 'dddddddddddd', st: 'live' }), A({})]).code === 'abcdefghijkl' && ad.bannerAdd([A({ quiet: true })]) === null);
    va.statusOf.clear();
    mem.set('vg-adds', JSON.stringify([A({ st: 'blocked', name: 'The <b>Paper</b>' })]));
    st.S.view = 'ballot'; st.S.ui.view = 'ballot'; st.S.tryMode = null;
    const bh = va.addsHTML(now);
    check('adds banner: blocked offers the paste, opening Add a source with the name as typed, escaped', /data-state="blocked"/.test(bh) && /data-act="shelf" data-kind="source" data-hint="paste"/.test(bh) && /data-src="The &lt;b&gt;Paper&lt;\/b&gt;"/.test(bh) && /data-act="adds-x"/.test(bh) && !/<b>Paper/.test(bh), bh);
    st.S.tryMode = 'fresh';
    check('adds banner: never in a "try as" scenario', va.addsHTML(now) === '');
    st.S.tryMode = null;

    // The shelf: the code goes along, word for word, for Add a source only.
    const along = { page: 'Your ballot', where: 'Austin, 78704', url: 'https://vote.kevinhg.com/', data: '2026-10-28 18:00 UTC', build: 'abc1234', device: 'x', errors: [], request: 'abcdefghijkl' };
    const src = { kind: 'source', f: { src: 'AURA', where: 'Austin, 78704', picks: '', reach: '' }, what: '', tag: '', hint: '', along, state: 'edit', err: false, fk: '', back: null };
    const sb2 = views.shelf.reportBody(src);
    check('adds shelf: Add a source sends "Request: <code>" last in Sent along, and the list shows it', views.shelf.alongLines(src).at(-1) === 'Request: abcdefghijkl' && sb2[common.FORM.wrong].endsWith('\nRequest: abcdefghijkl'), sb2[common.FORM.wrong]);
    check('adds shelf: a city request never carries one', !views.shelf.alongLines({ ...src, kind: 'city' }).some((l) => /^Request:/.test(l)));
    const keepRep = st.S.ui.report;
    st.S.ui.report = { ...src, hint: 'paste', prev: 'bbbbbbbbbbbb', f: { ...src.f, src: 'The Paper' } };
    const ph = views.shelf.shelfHTML();
    check('adds shelf: from the banner, the paste box comes first and open, required, with the policy beside it, the source filled in', ph.indexOf('id="rf-picks"') > 0 && ph.indexOf('id="rf-picks"') < ph.indexOf('id="rf-src"') && /id="rf-picks"[^>]*aria-required="true"/.test(ph) && ph.includes(views.shelf.PASTE_POLICY) && /id="rf-src"[^>]*value="The Paper"/.test(ph) && /data-hint="paste"/.test(ph) && views.shelf.requiredOf(st.S.ui.report) === 'picks', ph.slice(0, 200));
    st.S.ui.report = { ...src, state: 'sent', watched: true };
    check('adds shelf: sent and watched, it says it shows up here', /<b>Sent\.<\/b> If it checks out, it shows up right here\. Keep going\./.test(views.shelf.shelfHTML()), views.shelf.shelfHTML().slice(0, 160));
    st.S.ui.report = { ...src, state: 'sent' };
    check('adds shelf: sent where the device can’t watch, the plain line', /<b>Sent\.<\/b> Kevin reads every one\.<\/p>/.test(views.shelf.shelfHTML()), views.shelf.shelfHTML().slice(0, 160));
    st.S.ui.report = keepRep;
  } finally {
    if (had) Object.defineProperty(globalThis, 'window', had); else delete globalThis.window;
    st.S.b = keep.b; st.S.ballot = keep.ballot; st.S.view = keep.view; st.S.ui.view = keep.uiView; st.S.tryMode = keep.tryMode; st.S.index = keep.index;
  }
}

/* ---------- where to vote (Oct 28): a county's own links, answers and phone lines ----------
   Kevin: "the page for voting locations in austin we link to is confusing as hell. I know somewhere there's a
   simple google map." A place across county lines keeps each county's links: the voter's county's when a ZIP
   wholly in one county or the address lookup names it, each county's, labeled, when it can't tell. */
{
  const plan = mods.plan;
  const ps = views.planstrip;
  const TRAVIS_EARLY = 'https://www.google.com/maps/d/viewer?mid=1t_vWJgd_BRfKnJn_fQoHE25IV2i_0Jo';
  // Nov 3, Election Day: Travis, Williamson and Hays list their sites only as a map with no address search or a PDF, so
  // the button opens Vote.org's address lookup (today's sites, nearest first; 201 for Travis, the county's count), and
  // the county's live wait times sit under it.
  const TRAVIS_DAY = 'https://www.vote.org/polling-place-locator/';
  const TRAVIS_WAIT = 'https://updates.electionlink.net/widgets/travistx/2026-11-03/Election%20Day%20Voting%20Dashboard.html';
  const WILCO_WAIT = 'https://updates.electionlink.net/widgets/williamsontx/2026-11-03/Election%20Day%20Voting%20Dashboard.html';
  const WILCO_EARLY = 'https://updates.electionlink.net/widgets/williamsontx/2026-11-03/Early%20Voting%20Dashboard.html';
  const keep = { ballot: st.S.ballot, b: st.S.b, open: st.S.ui.open };
  const aus = read('place-austin-tx.json');
  check('where: Austin keeps Travis, Williamson and Hays links, Travis first', aus.by_county.map((c) => c.county).join('|') === 'Travis|Williamson|Hays');
  check('where: a ZIP wholly in Travis (78704) names Travis; a split ZIP (78729) names none', plan.voterCounty([aus], '78704', null) === 'Travis' && plan.voterCounty([aus], '78729', null) === null);
  check('where: the address lookup\u2019s county wins over the ZIP', plan.voterCounty([aus], '78704', 'Williamson') === 'Williamson');
  check('where: a place in one county is never localized by county', plan.voterCounty([read('place-dallas-tx.json')], '75201', 'Dallas') === null);
  const tx = read('state-TX.json').howto;
  let b = open('TX', ['austin-tx']);
  bl.localize(b, '78704', null);
  check('where: on a Travis ZIP, the plan\u2019s early voting and Election Day links are Travis\u2019s own (early map, Election Day map)', b.county === 'Travis' && b.howto.early_in_person.lookup_url === TRAVIS_EARLY && b.howto.election_day.lookup_url === TRAVIS_DAY && !b.howto.county_links, `${b.county} ${b.howto.early_in_person.lookup_url}`);
  const early = plan.nextStep(b.howto, '2026-10-28');
  const day = plan.nextStep(b.howto, '2026-11-03', false, 600);
  check('where: during early voting the button opens the early map, on Election Day the address lookup', early.primary.url === TRAVIS_EARLY && early.primary.look === 'early_in_person' && day.primary.url === TRAVIS_DAY && day.primary.look === 'election_day', `${early.primary.url} ${day.primary.url}`);
  check('where: the bundle keeps each county\u2019s wait-times page (Travis, Williamson; none for Hays) and a Travis ballot carries Travis\u2019s', aus.by_county.map((c) => c.lookups.election_day_waits || '-').join('|') === `${TRAVIS_WAIT}|${WILCO_WAIT}|-` && b.howto.election_day.waits_url === TRAVIS_WAIT, b.howto.election_day.waits_url);
  b = open('TX', ['austin-tx']);
  bl.localize(b, '78729', null);
  check('where: on a split ZIP, the state\u2019s lookup stays and each county\u2019s links are listed', b.county === null && b.howto.early_in_person.lookup_url === tx.early_in_person.lookup_url && (b.howto.county_links || []).map((c) => c.county).join('|') === 'Travis|Williamson|Hays');
  st.S.ui.open = new Set();
  // During early voting (pinned: the step depends on the day), when each county's early voting page differs.
  const hadLoc = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { search: '?today=2026-10-28', origin: 'http://x', pathname: '/' } });
  const html = ps.planHTML();
  if (hadLoc) Object.defineProperty(globalThis, 'location', hadLoc); else delete globalThis.location;
  const btns = [...html.matchAll(/<a class="pbtn (gold|line)" href="([^"]+)"[^>]*data-county="([^"]+)">([^<]+)<\/a>/g)].map((m) => `${m[1]} ${m[3]} ${m[4]}`);
  check('where: a split ZIP\u2019s plan during early voting shows one labeled button per county, Travis first in gold', btns.join('|') === 'gold Travis Travis County|line Williamson Williamson County|line Hays Hays County' && /<p class="plan-cty">Find [a-z ]+ in your county:<\/p>/.test(html), btns.join('|'));
  bl.localize(b, '78729', 'Williamson');
  check('where: once the address lookup says Williamson, Williamson\u2019s links, and one button again', b.county === 'Williamson' && b.howto.early_in_person.lookup_url === WILCO_EARLY && b.howto.election_day.lookup_url === TRAVIS_DAY && b.howto.election_day.waits_url === WILCO_WAIT && !b.howto.county_links && !/data-county=/.test(ps.planHTML()));
  // The wait-times link shows only on Election Day while the polls are open (Nov 3).
  {
    const had = Object.getOwnPropertyDescriptor(globalThis, 'location');
    const at = (q) => Object.defineProperty(globalThis, 'location', { configurable: true, value: { search: q, origin: 'http://x', pathname: '/' } });
    const waits = (html) => [...html.matchAll(/<p class="plan-hint plan-waits">(.*?)<\/p>/g)].map((m) => m[1]).join('');
    try {
      at('?today=2026-11-03&now=10:00');
      let bb = open('TX', ['austin-tx']);
      bl.localize(bb, '78702', null);
      let html = ps.planHTML();
      check('where: an Austin 78702 plan on Election Day: "Find where to vote" opens Vote.org, "See live wait times" Travis\u2019s dashboard', html.includes(`<a class="pbtn gold" href="${TRAVIS_DAY}" target="_blank" rel="noopener">Find where to vote</a>`) && waits(html) === `<a href="${TRAVIS_WAIT}" target="_blank" rel="noopener">See live wait times</a>`, waits(html));
      at('?today=2026-11-03&now=19:05');
      check('where: no wait-times link once the polls have closed', !waits(ps.planHTML()) && /Results are rolling in/.test(ps.planHTML()));
      at('?today=2026-11-02');
      check('where: no wait-times link before Election Day', !waits(ps.planHTML()));
      at('?today=2026-11-03&now=10:00');
      // Every county's Election Day button would open the same Vote.org page: one button, and each county's wait link.
      for (const zip of ['78729', '78750']) {
        bb = open('TX', ['austin-tx']);
        bl.localize(bb, zip, null);
        html = ps.planHTML();
        const where = [...html.matchAll(/<a class="pbtn gold" href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => `${m[2]} ${m[1]}`);
        check(`where: a split ZIP (${zip}) on Election Day shows one where-to-vote button, to Vote.org, and a wait-times link for Travis and Williamson`, bb.county === null && (bb.howto.county_links || []).length === 3 && !/data-county=/.test(html) && !/plan-cty/.test(html) && where.join('|') === `Find where to vote ${TRAVIS_DAY}` && waits(html) === `See live wait times: <a href="${TRAVIS_WAIT}" target="_blank" rel="noopener">Travis County</a> · <a href="${WILCO_WAIT}" target="_blank" rel="noopener">Williamson County</a>`, `${bb.county} ${where.join('|')} ${waits(html)}`);
      }
      bb = open('TX', ['san-antonio-tx']);
      check('where: San Antonio\u2019s Election Day button is Bexar County\u2019s own address map, with no second wait link', bb.howto.election_day.lookup_url === 'https://maps.bexar.org/ElectionWaitTimes/' && !waits(ps.planHTML()));
      open('TX', ['austin-williamson-tx']);
      const pub = views.pass.messages().pub || '';
      check('where: the work and school message keeps official links (Williamson\u2019s page, never Vote.org)', !/vote\.org/.test(pub) && /Find where to vote in .*: https:\/\/www\.wilcotx\.gov\/elections/.test(pub), pub);
      at('?today=2026-10-28');
      bb = open('TX', ['austin-tx']);
      bl.localize(bb, '78729', null);
      html = ps.planHTML();
      const cb = [...html.matchAll(/data-county="([^"]+)"/g)].map((m) => m[1]).join('|');
      check('where: the same split ZIP during early voting keeps a button per county (their early voting pages differ), and no wait link', cb === 'Travis|Williamson|Hays' && /Find early voting places in your county:/.test(html) && !waits(html), cb);
    } finally {
      if (had) Object.defineProperty(globalThis, 'location', had); else delete globalThis.location;
    }
  }
  // Nov 1: Lakewood's own Jefferson County mail and hours text, not the state's Denver, Adams and Arapahoe lines.
  // (The state's other mail fields keep statewide facts with a Denver aside; only these four are county-specific.)
  const lkw = open('CO', ['lakewood-co']).howto;
  const lkwText = JSON.stringify([lkw.mail_ballot.request_deadline, lkw.mail_ballot.return_options, lkw.early_in_person.hours_note, lkw.early_in_person.hours_short]);
  check('where: Lakewood’s mail and vote center text is Jefferson County’s, naming no other county', /Jefferson County/.test(lkwText) && !/Denver|Adams|Arapahoe/.test(lkwText), lkwText.slice(0, 200));
  b = open('TX', ['pflugerville-tx']);
  bl.localize(b, '78660', null);
  check('where: Pflugerville\u2019s 78660 is split, so Travis and Williamson both show', b.county === null && (b.howto.county_links || []).map((c) => c.county).join('|') === 'Travis|Williamson');
  // A county's own answer: Orange's lost mail ballot, with its own line; the state's question and buttons stay.
  // As of Oct 30: these answers switch on Nov 1 and 2 (openOn).
  const fl = read('state-FL.json').howto.situations.find((x) => x.id === 'no_mail_ballot_or_lost');
  b = openOn('2026-10-30', 'FL', ['orlando-fl']);
  const own = b.howto.situations.find((x) => x.id === 'no_mail_ballot_or_lost');
  check('where: Orlando\u2019s lost-ballot answer is Orange County\u2019s, with its vote-by-mail line', own.question === fl.question && own.actions.length === fl.actions.length && /27 sites/.test(own.answer) && own.steps.some((x) => /407-836-8683/.test(x)) && own.source === 'https://voteorangefl.gov/request-a-mail-ballot/', own.short);
  b = openOn('2026-10-30', 'FL', ['pensacola-fl']);
  check('where: Pensacola\u2019s answer stands alone (steps: null) and the state\u2019s other questions are untouched', b.howto.situations.find((x) => x.id === 'no_mail_ballot_or_lost').steps === null && JSON.stringify(b.howto.situations.find((x) => x.id === 'college_student')) === JSON.stringify(read('state-FL.json').howto.situations.find((x) => x.id === 'college_student')));
  b = openOn('2026-10-30', 'FL', []);
  check('where: a statewide Florida ballot keeps the state\u2019s answer', JSON.stringify(b.howto.situations.find((x) => x.id === 'no_mail_ballot_or_lost')) === JSON.stringify(fl));
  open('FL', ['orlando-fl']);
  st.S.ui.open = new Set(['whatif', 'bx-office']);
  const office = (ps.planHTML().match(/<p class="office">[\s\S]*?<\/p>/) || [''])[0];
  check('where: Orange\u2019s office shows its general line and its vote-by-mail line, labeled, and its hours', /General line: (<span[^>]*>)?<a[^>]*href="tel:4078362070"/.test(office) && /Vote-by-mail line: (<span[^>]*>)?<a[^>]*href="tel:4078368683"/.test(office) && /Monday to Friday, 8 AM to 5 PM/.test(office), office);
  // No quick answer or mistake's fix still asks you to act by a date that passed before Oct 28 (PR B adds dated text).
  const late = [];
  // "If you were registered by Oct 5" is a condition, not a step.
  const by = /(?<!registered\s)\b(by|before)\s+(about\s+)?((mon|tues|wednes|thurs|fri|satur|sun)day,?\s+)?Oct(ober|\.)?\s+([1-9]|1\d|2[0-7])\b/i;
  for (const s of Object.keys(INDEX.states)) {
    const h = read(`state-${s}.json`).howto;
    for (const x of h.situations || []) if (x.short && by.test(x.short)) late.push(`${s} ${x.id}: ${x.short}`);
    (h.gotcha_shorts || []).forEach((g, i) => { if (g && by.test(g)) late.push(`${s} gotcha ${i + 1}: ${g}`); });
  }
  check('where: no quick answer or mistake\u2019s fix asks you to act by a date before Oct 28', late.length === 0, late.slice(0, 4).join(' | '));
  st.S.ballot = keep.ballot; st.S.b = keep.b; st.S.ui.open = keep.open;
}

/* ---------- where to vote, part B (Oct 28): dated text, county help buttons and trackers, more counties ----------
   Text dated to change does on its own date (a passed deadline can't come back every cycle); the "If something
   goes wrong" buttons and the tracking link open the county's tools where the place has them. */
{
  const plan = mods.plan;
  const ps = views.planstrip;
  const keep = { ballot: st.S.ballot, b: st.S.b, open: st.S.ui.open };
  const tx = read('state-TX.json').howto;
  const g4 = (t) => plan.localHowto(tx, [read('place-dallas-tx.json')], null, t).gotchas[4];
  check('dated: Texas\u2019s vote-center line names the wait-time maps through Oct 30, and drops them from Oct 31', /live early voting wait times/.test(g4('2026-10-30')) && !/wait times/.test(g4('2026-10-31')) && /any polling location in your county on Election Day/.test(g4('2026-11-03')), g4('2026-10-31'));
  check('dated: the day localHowto applied it for is kept, so a page open past midnight re-applies it', plan.localHowto(tx, [], null, '2026-10-31').day === '2026-10-31');
  const nyc = read('place-nyc-brooklyn-ny.json');
  const nyNotes = (t) => plan.applyDated(nyc, nyc.dated, t).notes;
  check('dated: NYC\u2019s borough-office note lists the extended hours, then says Nov 2 is the last day, then Nov 3 is Election Day', /Extended hours/.test(nyNotes('2026-10-29')) && /Today is the last day/.test(nyNotes('2026-11-02')) && /Vote at your own poll site today/.test(nyNotes('2026-11-03')), nyNotes('2026-11-02'));
  check('dated: an entry never touches the place\u2019s ballot (only the parts a path names are copied)', plan.applyDated(nyc, nyc.dated, '2026-11-03').items === nyc.items);
  const pen = read('place-pensacola-fl.json');
  check('dated: Pensacola\u2019s drop-off note says early voting closed once it has (Nov 1)', /^Drop boxes/.test(plan.applyDated(pen, pen.dated, '2026-10-31').notes) && /^Early voting and its drop boxes closed/.test(plan.applyDated(pen, pen.dated, '2026-11-01').notes));
  // The help buttons open the county's tools where the place has them (west-mail-25, fl-10, ny-11, south-midwest-19, east-18).
  const act = (h, sid, label) => ((h.situations.find((x) => x.id === sid) || {}).actions || []).find((a) => a.label === label);
  let b = openOn('2026-10-30', 'FL', ['orlando-fl']); // before the button switches on Nov 1 ("stale lines" in model-ledger)
  check('help buttons: Orlando\u2019s "Find early voting places" opens Orange County\u2019s early voting page', act(b.howto, 'away_on_election_day', 'Find early voting places').url === 'https://voteorangefl.gov/vote-early/', JSON.stringify(act(b.howto, 'away_on_election_day', 'Find early voting places')));
  check('help buttons: Orlando\u2019s tracking link is Orange County\u2019s BallotTrax', b.howto.mail_ballot.tracking_url === 'https://floridaorangevotes.ballottrax.net/voter/' && act(b.howto, 'no_mail_ballot_or_lost', 'Track my ballot').url === 'https://floridaorangevotes.ballottrax.net/voter/');
  b = open('FL', ['tallahassee-fl']);
  check('help buttons: Tallahassee keeps the state\u2019s tracker (Leon\u2019s link is held until someone opens it)', b.howto.mail_ballot.tracking_url === read('state-FL.json').howto.mail_ballot.tracking_url);
  b = openOn('2026-10-30', 'FL', []); // before Florida's dated answers (Nov 1 and 2)
  check('help buttons: a statewide Florida ballot keeps the state\u2019s buttons', JSON.stringify(b.howto.situations) === JSON.stringify(read('state-FL.json').howto.situations));
  b = open('NY', ['nyc-queens-ny']);
  const ny = read('state-NY.json').howto;
  const nyBtns = b.howto.situations.flatMap((x) => x.actions || []).filter((a) => /poll site/i.test(a.label));
  check('help buttons: NYC\u2019s poll-site buttons open the city\u2019s own finder', nyBtns.length > 0 && nyBtns.every((a) => a.url === 'https://findmypollsite.vote.nyc/'), JSON.stringify(nyBtns.slice(0, 2)));
  check('help buttons: NYC\u2019s tracker is the city\u2019s', b.howto.mail_ballot.tracking_url === 'https://requestballot.vote.nyc/tracking' && ny.mail_ballot.tracking_url !== b.howto.mail_ballot.tracking_url);
  b = open('DC', ['dc-ward-6']);
  const dcBtns = b.howto.situations.flatMap((x) => x.actions || []).filter((a) => /vote center|drop box/i.test(a.label));
  check('help buttons: DC\u2019s vote center and drop box buttons open the locator, not the PDF', dcBtns.length > 0 && dcBtns.every((a) => /vote-center-locator-tool|earlyvoting\.dcboe\.org/.test(a.url)), JSON.stringify(dcBtns.slice(0, 2)));
  // More places across county lines.
  b = open('TX', ['round-rock-tx']);
  bl.localize(b, '78665', null);
  check('counties: Round Rock\u2019s 78665 is Williamson\u2019s, with Williamson\u2019s early voting dashboard', b.county === 'Williamson' && /williamsontx/.test(b.howto.early_in_person.lookup_url));
  b = open('TX', ['round-rock-tx']);
  bl.localize(b, '78664', null);
  check('counties: Round Rock\u2019s 78664 crosses into Travis, so both counties\u2019 buttons show, Williamson first', (b.howto.county_links || []).map((c) => c.county).join('|') === 'Williamson|Travis');
  b = open('CO', ['aurora-co']);
  bl.localize(b, '80011', null);
  check('counties: Aurora on a split ZIP lists Arapahoe, Adams and Douglas', (b.howto.county_links || []).map((c) => c.county).join('|') === 'Arapahoe|Adams|Douglas');
  bl.localize(b, '80011', 'Adams');
  check('counties: an Adams address gets Adams\u2019s vote centers and drop boxes', /adamscountyco\.gov/.test(b.howto.early_in_person.lookup_url) && /adamscountyco\.gov/.test(b.howto.mail_ballot.drop_box_lookup_url));
  b = open('GA', ['atlanta-ga']);
  bl.localize(b, '30318', null);
  check('counties: an Atlanta ZIP wholly in Fulton gets Fulton\u2019s early voting map', b.county === 'Fulton' && /847ca4f4304945b2872eeb3bb30891ba/.test(b.howto.early_in_person.lookup_url));
  b = open('TX', ['san-marcos-tx']);
  bl.localize(b, '78666', null);
  const smEarly = b.howto.early_in_person.lookup_url;
  bl.localize(b, '78666', 'Caldwell');
  check('counties: San Marcos uses Hays\u2019s tools, and a Caldwell address gets the state\u2019s instead', /haystx/.test(smEarly) && b.howto.early_in_person.lookup_url === tx.early_in_person.lookup_url && !b.howto.county_links, `${smEarly} / ${b.howto.early_in_person.lookup_url}`);
  // A county's own office, when the voter's county is known.
  b = open('TX', ['pflugerville-tx']);
  bl.localize(b, '78660', 'Williamson');
  st.S.ui.open = new Set(['whatif', 'bx-office']);
  const office = (ps.planHTML().match(/<p class="office">[\s\S]*?<\/p>/) || [''])[0];
  check('offices: a Williamson address in Pflugerville shows Williamson County\u2019s office', /Williamson County Elections Department/.test(office) && /512-943-1630/.test(office), office.slice(0, 200));
  // Codex on part B: a button changes only when its label fits the kind of page; a general one follows the phase.
  const dal = read('place-dallas-tx.json');
  const dallasBtn = (t) => act(plan.localHowto(tx, [dal], null, t), 'wrong_polling_place', 'Find voting places').url;
  check('help buttons: Dallas\u2019s "Find voting places" opens the early voting map through Oct 30, then the Election Day map', /views=Early-Voting/.test(dallasBtn('2026-10-28')) && /views=Election-Day/.test(dallasBtn('2026-10-31')), `${dallasBtn('2026-10-28')} / ${dallasBtn('2026-10-31')}`);
  b = open('IL', ['chicago-il']);
  const il = read('state-IL.json').howto;
  const officeBtns = b.howto.situations.flatMap((x) => x.actions || []).filter((a) => /election office/i.test(a.label));
  check('help buttons: Chicago\u2019s "Find my election office" stays the office directory; "Track my ballot" opens Chicago\u2019s tracker', officeBtns.length > 0 && officeBtns.every((a) => il.situations.some((x) => (x.actions || []).some((y) => y.label === a.label && y.url === a.url))) && b.howto.situations.flatMap((x) => x.actions || []).filter((a) => /track/i.test(a.label)).every((a) => a.url === 'https://chicagoelections.gov/voting/your-voter-information'), JSON.stringify(officeBtns.slice(0, 1)));
  b = open('CA', ['fullerton-ca']);
  const vc = b.howto.situations.flatMap((x) => x.actions || []).filter((a) => /vote center/i.test(a.label));
  check('help buttons: Fullerton\u2019s "Find a vote center" opens Orange County\u2019s vote center list', vc.length > 0 && vc.every((a) => a.url === 'https://ocvote.gov/elections/vote-center-locations'), JSON.stringify(vc.slice(0, 1)));
  b = open('CA', ['san-francisco-ca']);
  check('help buttons: San Francisco\u2019s "Find a vote center" opens its City Hall voting page', b.howto.situations.flatMap((x) => x.actions || []).filter((a) => /vote center/i.test(a.label)).every((a) => a.url === 'https://www.sf.gov/vote-in-person'));
  // A county the place doesn't list gets no office card (the same rule as its links).
  b = open('TX', ['san-marcos-tx']);
  bl.localize(b, '78666', 'Caldwell');
  st.S.ui.open = new Set(['whatif', 'bx-office']);
  check('offices: a Caldwell address on San Marcos\u2019s ballot shows no Hays office', !/<p class="office">/.test(ps.planHTML()) && !/Hays County Elections Office/.test(ps.planHTML()));
  // An open page past midnight: localize (what main.ts's refresh calls) re-applies dated text on a new day.
  const had = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const on = (d) => Object.defineProperty(globalThis, 'location', { configurable: true, value: { search: `?today=${d}`, origin: 'http://x', pathname: '/' } });
  try {
    on('2026-10-30');
    b = open('TX', ['dallas-tx']);
    bl.localize(b, '75201', null);
    const before = b.howto.gotchas[4];
    on('2026-10-31');
    bl.localize(b, '75201', null);
    check('dated: the minute refresh after midnight changes the open ballot\u2019s text (Oct 30 to Oct 31)', /wait times/.test(before) && !/wait times/.test(b.howto.gotchas[4]) && b.howto.day === '2026-10-31', b.howto.gotchas[4]);
  } finally {
    if (had) Object.defineProperty(globalThis, 'location', had); else delete globalThis.location;
  }
  st.S.ballot = keep.ballot; st.S.b = keep.b; st.S.ui.open = keep.open;
}

/* ---------- the closest Election Day sites (Nov 3) ----------
   After an address lookup this visit, the plan's Election Day step names the three vote centers nearest the
   Census's point in the voter's county (Travis, Williamson, Hays), with distances and directions. Everyone else
   sees the plan exactly as before, and nothing is fetched for them. The point never reaches a link or a save. */
{
  const sites = mods.sites;
  const ps = views.planstrip;
  // Three of Travis's real vote centers, and one made-up far one, out of order on purpose.
  const FIX = { county: 'Travis', state: 'TX', election_date: '2026-11-03', list_source: 'https://countyclerk.traviscountytx.gov/', coords_source: 'https://www.vote.org/polling-place-locator/', fetched: '2026-11-03T12:00:00Z', count_official: 4, sites: [
    { name: 'Fixture Far Site', address: 'Far Site, Austin, TX 78653', lat: 30.5, lng: -97.6 },
    { name: 'Terrazas Branch Library', address: '1105 E Cesar Chavez St, Austin, TX 78702', lat: 30.259883, lng: -97.733292 },
    { name: 'Austin City Hall', address: '301 W 2nd St, Austin, TX 78701', lat: 30.26488, lng: -97.746989 },
    { name: 'Emma S Barrientos Mexican American Cultural Center', address: '600 River St, Austin, TX 78701', lat: 30.258218, lng: -97.739836 },
  ] };
  // The Census's point for Austin City Hall (the public building tests/e2e.mjs looks up too).
  const AT = { lat: 30.26496, lon: -97.746669 };
  const near = sites.nearest(FIX.sites, AT, 3);
  check('sites: the three nearest, nearest first, the far one left out', near.map((n) => n.site.name).join('|') === 'Austin City Hall|Emma S Barrientos Mexican American Cultural Center|Terrazas Branch Library', near.map((n) => `${n.site.name} ${n.mi.toFixed(3)}`).join('|'));
  check('sites: distances as the crow flies, in miles (0.02, 0.62, 0.87)', near.map((n) => n.mi.toFixed(2)).join('|') === '0.02|0.62|0.87', near.map((n) => n.mi).join('|'));
  const f = sites.fmtMiles;
  check('sites: distance reads "0.4 mi" under 10 miles, whole miles from 10, "under 0.1 mi" at the door', f(0.44) === '0.4 mi' && f(0.62) === '0.6 mi' && f(9.94) === '9.9 mi' && f(9.96) === '10 mi' && f(12.4) === '12 mi' && f(0.02) === 'under 0.1 mi' && f(0.06) === '0.1 mi', [0.44, 9.94, 9.96, 12.4, 0.02, 0.06].map(f).join('|'));
  const dir = sites.directionsURL(FIX.sites[2]);
  check('sites: directions carry the site’s own address and nothing else', dir === 'https://www.google.com/maps/dir/?api=1&destination=301%20W%202nd%20St%2C%20Austin%2C%20TX%2078701' && !/origin|30\.26|97\.74/.test(dir), dir);
  check('sites: a list that won’t read is not kept', !sites.putSites('bad-tx', { county: 'Travis', election_date: '2026-11-03', sites: [{ name: 'X', address: 'Y', lat: 'no', lng: 0 }] }) && !sites.sitesFile('bad-tx') && !sites.putSites('bad-tx', null));
  check('sites: Austin’s three counties each name their list; San Marcos names Hays’s only', ['Travis', 'Williamson', 'Hays'].map((c) => sites.sitesIdFor([read('place-austin-tx.json')], c)).join('|') === 'travis-tx|williamson-tx|hays-tx'
    && sites.sitesIdFor([read('place-san-marcos-tx.json')], 'Hays County') === 'hays-tx' && sites.sitesIdFor([read('place-san-marcos-tx.json')], 'Caldwell') === null && sites.sitesIdFor([read('place-dallas-tx.json')], 'Dallas') === null);
  // Every list that ships: in Texas, today's date, at least one site, each with a name, an address and a point.
  for (const id of ['travis-tx', 'williamson-tx', 'hays-tx']) {
    const pth = path.join(DATA, 'sites', `${id}.json`);
    if (!fs.existsSync(pth)) { check(`sites: public/data/sites/${id}.json is built`, false, 'missing'); continue; }
    const l = read(`sites/${id}.json`);
    check(`sites: ${id} ships ${l.sites.length} sites for Nov 3, every one named, addressed and inside Texas`, l.election_date === '2026-11-03' && l.state === 'TX' && l.sites.length > 0
      && l.sites.every((x) => x.name.trim() && x.address.trim() && x.lat > 25.8 && x.lat < 36.6 && x.lng > -106.7 && x.lng < -93.5 && /[a-z]/.test(x.name) && !/—/.test(x.name + x.address)), `${l.sites.length} of ${l.count_official}`);
  }

  const keep = { ballot: st.S.ballot, b: st.S.b, ui: { ...st.S.ui } };
  const had = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const at = (q) => Object.defineProperty(globalThis, 'location', { configurable: true, value: { search: q, origin: 'http://x', pathname: '/' } });
  const asked = [];
  sites.onWantSites((id) => asked.push(id));
  const block = (html) => (html.match(/<div class="plan-near">[\s\S]*?<\/div>/) || [''])[0];
  const lookup = (county, point = AT) => { st.S.ui.addrCounty = county; st.S.ui.addrPoint = point; st.S.ui.addrFound = 'Test One, Austin, TX 78701'; st.S.ui.addrOpen = false; };
  const forget = () => { st.S.ui.addrCounty = null; st.S.ui.addrPoint = null; st.S.ui.addrFound = null; st.S.ui.addrOpen = false; };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  // The address box after a lookup (a lookup always leaves its "Set from your address" line), and its
  // "Closest vote center" line, which shows exactly when the plan's block does.
  const headNow = () => { if (!st.S.b.addrNote) st.S.b.addrNote = 'Set from your address: a test.'; return views.ledger.ballotHeadHTML(); };
  const lineOf = (head) => (head.match(/<p class="addr-near">[\s\S]*?<\/p>/) || [''])[0];
  const flat = (t) => t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const gone = []; // [when, head]: every case the block doesn't show, the line mustn't either
  const noLine = (when, formOpen = false) => { const hd = headNow(); gone.push([when, !lineOf(hd) && (formOpen || /class="addr-found"/.test(hd))]); };
  try {
    at('?today=2026-11-03&now=12:00');
    let b = open('TX', ['austin-tx']);
    bl.localize(b, '78702', null);
    forget();
    const plain = ps.planHTML();
    await tick();
    check('sites: no address looked up: no block, and nothing asked for', !block(plain) && !/Closest to your address/.test(plain) && asked.length === 0, asked.join(','));
    lookup('Travis');
    bl.localize(b, '78702', 'Travis');
    let html = ps.planHTML();
    await tick();
    check('sites: a lookup on Election Day with the list not here yet: nothing new shows, and Travis’s list is asked for once', !block(html) && asked.join(',') === 'travis-tx', asked.join(','));
    ps.planHTML(); await tick();
    check('sites: asked once a visit, not on every paint', asked.join(',') === 'travis-tx', asked.join(','));
    noLine('the list not here yet');
    check('sites: with the list not here yet, the address box asks for nothing more', asked.join(',') === 'travis-tx', asked.join(','));
    // A list that didn't load is asked for again after the next lookup; one still on its way never twice.
    {
      const seen = [];
      let pend = null;
      sites.onWantSites((id) => { seen.push(id); return id === 'miss-x' ? false : new Promise((r) => { pend = r; }); });
      sites.wantSites('miss-x'); sites.wantSites('slow-x'); await tick(); await tick();
      sites.wantSites('miss-x'); sites.wantSites('slow-x'); await tick();
      const before = seen.join(',');
      sites.retrySites();
      sites.wantSites('miss-x'); sites.wantSites('slow-x'); await tick(); await tick();
      check('sites: a list that didn’t load is asked again after a new lookup; one on its way is not asked twice', before === 'miss-x,slow-x' && seen.join(',') === 'miss-x,slow-x,miss-x', seen.join(','));
      if (pend) pend(true);
      sites.onWantSites((id) => asked.push(id));
    }
    sites.putSites('travis-tx', FIX);
    html = ps.planHTML();
    const rows = [...block(html).matchAll(/<li><span class="pn-name">([^<]+)<\/span><span class="pn-mi">([^<]+)<\/span><a class="pn-dir" href="([^"]+)"[^>]*data-fk="(pn-dir-\d)"[^>]*>Directions<\/a><\/li>/g)].map((m) => ({ name: m[1], mi: m[2], href: m[3].replace(/&amp;/g, '&'), fk: m[4] }));
    check('sites: once it lands: "Closest to your address:", three rows nearest first, each with its distance and Directions', /<p class="plan-near-h"[^>]*>Closest to your address:<\/p>/.test(html) && rows.map((r) => `${r.name} ${r.mi}`).join('|') === 'Austin City Hall under 0.1 mi|Emma S Barrientos Mexican American Cultural Center 0.6 mi|Terrazas Branch Library 0.9 mi', rows.map((r) => `${r.name} ${r.mi}`).join('|'));
    check('sites: each Directions link is Google Maps to that site’s address, never the voter’s point', rows.length === 3 && rows.every((r, i) => r.href === sites.directionsURL(near[i].site) && !/30\.26|97\.74|origin=/.test(r.href)) && rows.map((r) => r.fk).join(',') === 'pn-dir-0,pn-dir-1,pn-dir-2', rows.map((r) => r.href).join(' '));
    check('sites: one line under it: "You can vote at any site in Travis County."', /<p class="plan-hint plan-near-any">You can vote at any site in Travis County\.<\/p>/.test(html));
    check('sites: the "Find where to vote" button and "See live wait times" stay exactly as they were', html.replace(block(html), '').replace(/\s+/g, ' ') === plain.replace(/\s+/g, ' '), 'the plan without the block differs from the plan before the lookup');
    check('sites: the block sits under the buttons, above the wait times', html.indexOf('class="plan-acts"') < html.indexOf('class="plan-near"') && html.indexOf('class="plan-near"') < html.indexOf('plan-waits'));
    check('sites: no em dashes, nothing in capitals', !/—/.test(block(html)) && !/uppercase/.test(block(html)));
    check('sites: the block\u2019s heading takes the jump\u2019s focus (data-fk "plan-near")', /<p class="plan-near-h" id="plan-near-h" tabindex="-1" data-fk="plan-near">/.test(html));
    {
      const hd = headNow();
      const line = lineOf(hd);
      check('sites: the address box names the nearest under "Found:": "Closest vote center: Austin City Hall, under 0.1 mi. See all 3"', flat(line) === 'Closest vote center: Austin City Hall, under 0.1 mi. See all 3'
        && /<button class="linkbtn" data-act="near" data-fk="addr-near">See all 3<\/button>/.test(line), flat(line));
      check('sites: the line sits right under "Found:", above "Set from your address"', hd.indexOf('class="addr-found"') < hd.indexOf('class="addr-near"') && hd.indexOf('class="addr-near"') < hd.indexOf('class="addr-set"')
        && /<\/p><p class="addr-near">/.test(hd));
      const pt = st.S.ui.addrPoint;
      st.S.ui.addrPoint = null;
      const without = headNow();
      st.S.ui.addrPoint = pt;
      check('sites: the line is the address box\u2019s only change', hd.replace(line, '') === without && /class="addr-found"/.test(without), 'the head without the line differs from the head with no point');
      check('sites: the line carries no coordinates, no em dash and no capitals', !/30\.26|97\.74|—/.test(line) && !/[A-Z]{3,}/.test(flat(line)));
    }
    st.S.ui.addrOpen = true;
    check('sites: "Not it? Try again" (the form open) hides it', !block(ps.planHTML()));
    noLine('the form open', true);
    st.S.ui.addrOpen = false;
    check('sites: Cancel brings it back', !!block(ps.planHTML()) && !!lineOf(headNow()));
    st.S.ui.addrPoint = null;
    check('sites: a lookup with no point shows none', !block(ps.planHTML()));
    noLine('no point');
    lookup('Travis');
    const n0 = asked.length;
    at('?today=2026-11-02');
    check('sites: the day before Election Day: none', !block(ps.planHTML()));
    noLine('the day before');
    at('?today=2026-11-03&now=19:05');
    check('sites: once the polls have closed: none', !block(ps.planHTML()) && /Results are rolling in/.test(ps.planHTML()));
    noLine('the polls closed');
    at('?today=2026-11-03&now=12:00');
    b = open('TX', ['san-marcos-tx']);
    lookup('Caldwell');
    bl.localize(b, '78666', 'Caldwell');
    check('sites: a county the place names no list for (Caldwell on San Marcos’s ballot): none', !block(ps.planHTML()));
    noLine('Caldwell on San Marcos');
    b = open('TX', ['dallas-tx']);
    lookup('Dallas');
    bl.localize(b, '75201', 'Dallas');
    html = ps.planHTML();
    await tick();
    check('sites: a place with no lists (Dallas): none, and nothing more asked for', !block(html) && asked.length === n0, asked.join(','));
    noLine('Dallas');
    // A list for another election day is never used.
    sites.putSites('travis-tx', { ...FIX, election_date: '2026-11-04' });
    b = open('TX', ['austin-tx']);
    lookup('Travis');
    bl.localize(b, '78702', 'Travis');
    check('sites: a list dated for another day shows nothing', !block(ps.planHTML()));
    noLine('a list for another day');
    sites.putSites('travis-tx', FIX);
    check('sites: the address box line goes whenever the block does', gone.length === 8 && gone.every(([, ok]) => ok), gone.filter(([, ok]) => !ok).map(([w]) => w).join(', ') || String(gone.length));
    // A statewide-only ballot (no place: Georgetown, Cedar Park, Leander, Kyle, Buda) takes the state's own map,
    // keyed on the Census's county; a place's list comes first, and nothing outside the three counties.
    {
      const idx = read('index.json');
      const tx = read('state-TX.json').howto.election_day.sites;
      check('sites: Texas maps Travis, Williamson and Hays to their lists, and nothing else', JSON.stringify(tx) === JSON.stringify({ Travis: 'travis-tx', Williamson: 'williamson-tx', Hays: 'hays-tx' }), JSON.stringify(tx));
      check('sites: a statewide ballot picks the list by the Census\u2019s county ("Williamson" or "Williamson County"), none for Bexar or Dallas', ['Travis', 'Williamson', 'Hays', 'Williamson County', 'hays'].map((c) => sites.sitesIdFor([], c, tx)).join('|') === 'travis-tx|williamson-tx|hays-tx|williamson-tx|hays-tx'
        && sites.sitesIdFor([], 'Bexar', tx) === null && sites.sitesIdFor([], 'Dallas', tx) === null && sites.sitesIdFor([], '', tx) === null && sites.sitesIdFor([], 'Travis', null) === null);
      check('sites: a place\u2019s own list comes first, and the state\u2019s fills in only where none names one', sites.sitesIdFor([read('place-san-marcos-tx.json')], 'Hays', { Hays: 'other-tx' }) === 'hays-tx'
        && sites.sitesIdFor([read('place-san-marcos-tx.json')], 'Caldwell', tx) === null && sites.sitesIdFor([read('place-dallas-tx.json')], 'Dallas', tx) === null);
      const others = Object.keys(idx.states).filter((k) => k !== 'TX' && read(`state-${k}.json`).howto.election_day.sites != null);
      check('sites: no other state has lists of its own (a Williamson County, Tennessee address gets none)', others.length === 0 && sites.sitesIdFor([], 'Williamson', read('state-TN.json').howto.election_day.sites) === null, others.join(','));
      // Georgetown: a statewide Texas ballot, the Census at the Williamson County Courthouse (710 S Main St, a public building).
      const n1 = asked.length;
      sites.putSites('williamson-tx', read('sites/williamson-tx.json'));
      const sw = open('TX', []);
      bl.localize(sw, '78626', 'Williamson');
      lookup('Williamson', { lat: 30.637338, lon: -97.677113 });
      const swHtml = ps.planHTML();
      const swRows = [...block(swHtml).matchAll(/<span class="pn-name">([^<]+)<\/span><span class="pn-mi">([^<]+)<\/span>/g)].map((m) => `${m[1]} ${m[2]}`);
      check('sites: a statewide ballot in Georgetown gets Williamson\u2019s three closest, Georgetown City Hall first', sw.places.length === 0 && swRows.join('|') === 'Georgetown City Hall 0.2 mi|Hammerlun Center for Leadership and Learning 0.4 mi|Carver Center for Families 0.8 mi'
        && /You can vote at any site in Williamson County\./.test(block(swHtml)), swRows.join('|') || 'no block');
      check('sites: and its address box says "Closest vote center: Georgetown City Hall, 0.2 mi. See all 3"', flat(lineOf(headNow())) === 'Closest vote center: Georgetown City Hall, 0.2 mi. See all 3', flat(lineOf(headNow())));
      // Codex, Nov 3: the sites close at 7 PM Central on their own. A statewide Texas ballot's step stays open until
      // El Paso's polls close (8 PM Central), and `?now=` reads one time in every zone, so these use real instants.
      {
        const RealDate = globalThis.Date;
        const atInstant = (iso) => { const T = new RealDate(iso).getTime(); globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [T])); } static now() { return T; } }; };
        const COURT = { lat: 30.637338, lon: -97.677113 };
        const seen = () => { const p = ps.planHTML(); return { block: !!block(p), line: !!lineOf(headNow()), head: flat((p.match(/<p class="plan-h"[^>]*>[\s\S]*?<\/p>/) || [''])[0]), key: ps.nearKeyNow(st.S.ballot.howto), step: ps.stepKey(st.S.ballot.howto) }; };
        try {
          at('?today=2026-11-03');
          const g = open('TX', []);
          bl.localize(g, '78626', 'Williamson');
          lookup('Williamson', COURT);
          atInstant('2026-11-04T00:59:00Z');
          const g0 = seen();
          atInstant('2026-11-04T01:05:00Z');
          const g1 = seen();
          check('sites: Georgetown statewide at 6:59 PM Central (00:59Z): the block and the line show', g0.block && g0.line && !!g0.key, JSON.stringify(g0));
          check('sites: Georgetown statewide at 7:05 PM Central (01:05Z): both gone, the statewide step unchanged ("Your local polls close at 7 PM", for El Paso)', !g1.block && !g1.line && g1.key === ''
            && g1.head === 'Today is Election Day. Your local polls close at 7 PM.' && g1.step === g0.step, JSON.stringify(g1));
          check('sites: what main.ts watches flips at 7 PM Central though the step key doesn\u2019t, so an open tab repaints', g0.key !== g1.key && g0.step === g1.step);
          const a = open('TX', ['austin-tx']);
          bl.localize(a, '78702', 'Travis');
          lookup('Travis');
          atInstant('2026-11-04T00:59:00Z');
          const a0 = seen();
          atInstant('2026-11-04T01:05:00Z');
          const a1 = seen();
          check('sites: Austin at 6:59 PM Central: the block and the line show', a0.block && a0.line, JSON.stringify(a0));
          check('sites: Austin at 7:05 PM Central: both gone, results lead', !a1.block && !a1.line && a1.key === '' && /^Results are rolling in\./.test(a1.head), JSON.stringify(a1));
        } finally {
          globalThis.Date = RealDate;
          at('?today=2026-11-03&now=12:00');
        }
        const f = sites.sitesFile('travis-tx');
        check('sites: a list is open until its own 7 PM, and a list with no zone never shows', sites.listOpen('travis-tx', f, '7:00 PM', 1139) && !sites.listOpen('travis-tx', f, '7:00 PM', 1140)
          && !sites.listOpen('nowhere-tx', f, '7:00 PM', 600) && !sites.listOpen('travis-tx', f, null, 600));
        const built = fs.readdirSync(path.join(DATA, 'sites')).map((x) => x.replace(/\.json$/, ''));
        check('sites: every built list has its county\u2019s time zone', built.length > 0 && built.every((id) => sites.LIST_ZONE[id]), built.filter((id) => !sites.LIST_ZONE[id]).join(',') || built.join(','));
      }
      const bx = open('TX', []);
      bl.localize(bx, '78205', 'Bexar');
      lookup('Bexar', { lat: 29.4241, lon: -98.4936 });
      const bxHtml = ps.planHTML();
      await tick();
      check('sites: a statewide ballot in Bexar: no block, no line, nothing asked for', !block(bxHtml) && !lineOf(headNow()) && asked.length === n1, asked.join(','));
      const co = open('CO', []);
      bl.localize(co, '80601', 'Adams');
      lookup('Adams', { lat: 39.8, lon: -104.8 });
      const coHtml = ps.planHTML();
      await tick();
      check('sites: a statewide ballot in another state: no block, no line, nothing asked for', !block(coHtml) && !lineOf(headNow()) && asked.length === n1, asked.join(','));
      b = open('TX', ['austin-tx']);
      lookup('Travis');
      bl.localize(b, '78702', 'Travis');
    }
    // The point never reaches the save link or saved state.
    const mem = new Map();
    const hadW = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); } }, setTimeout, clearTimeout } });
    try {
      const view = st.S.view;
      st.S.view = 'ballot';
      st.S.b.picks['tx-governor'] = st.S.b.picks['tx-governor'] || 'SKIP';
      st.persist(true);
      st.S.view = view;
      const link = st.encodeShare(b, st.S.b);
      const share = views.cheat.shareURL();
      const saved = mem.get('vg2') || '';
      const coords = /30\.26|97\.74|2649|7466|addrPoint/;
      check('sites: after a lookup, the save link, the share link and saved state carry no coordinates', !!saved && !coords.test(saved) && !coords.test(link) && !coords.test(share) && !coords.test(JSON.stringify(st.S.b)) && !('addrPoint' in st.S.b), `${saved.length} ${link}`);
    } finally {
      if (hadW) Object.defineProperty(globalThis, 'window', hadW); else delete globalThis.window;
    }
  } finally {
    if (had) Object.defineProperty(globalThis, 'location', had); else delete globalThis.location;
    sites.onWantSites(() => {});
    st.S.ballot = keep.ballot; st.S.b = keep.b; Object.assign(st.S.ui, keep.ui);
  }
}

/* ---------- results once polls close (Nov 3) ----------
   Kevin: "I want the site not to lead with 'voting has ended'; that gives a 'you missed it' vibe. Instead a 'results
   are rolling in' lead." The first page turns once the first covered state closes (7 PM Eastern), by the same
   every-zone rule as the plan, so a state still voting says when it ends; the plan strip's "Official results" opens
   the most local official page the ballot has. Checked at absolute instants, since states span zones. */
{
  const plan = mods.plan;
  const ps = views.planstrip;
  const mast = views.mast;
  const RealDate = globalThis.Date;
  const hadLoc = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const keep = { ballot: st.S.ballot, b: st.S.b, view: st.S.view, index: st.S.index, zip: st.S.zip, tryMode: st.S.tryMode, open: st.S.ui.open };
  const at = (q) => Object.defineProperty(globalThis, 'location', { configurable: true, value: { search: q, origin: 'http://x', pathname: '/' } });
  // The device's clock at one instant: `new Date()` and Date.now() read it; everything else is the real Date.
  const pin = (iso) => {
    const t = new RealDate(iso).getTime();
    globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [t])); } static now() { return t; } };
  };
  const I = { before: '2026-11-03T22:59:00Z', east: '2026-11-04T00:05:00Z', austin: '2026-11-04T01:05:00Z', mostly: '2026-11-04T02:05:00Z', all: '2026-11-04T04:05:00Z', next: '2026-11-04T15:00:00Z' };
  const lead = (k, t = '2026-11-03') => plan.resultsLead(INDEX.states, t, new RealDate(I[k]));
  const row = (l, stc) => l.rows.find((r) => r.st === stc);
  try {
    check('results: every covered state carries its official results page, its publisher and its poll close in the index', Object.values(INDEX.states).every((x) => /^https:\/\//.test(x.results_url || '') && x.results_source && x.polls_close), Object.entries(INDEX.states).filter(([, x]) => !x.results_url).map(([k]) => k).join(' '));
    check('results: 5:59 PM Central, before any covered state closes: no results lead', lead('before') === null);
    const e = lead('east');
    check('results: 7:05 PM Eastern: results lead, still Election Day, and since some states are still voting, nothing says your polls are past', !!e && !e.after && e.head === 'Results are rolling in.' && e.sub.join(' ') === 'Official results for each state are below. Polls are still open in some states. In line when yours close? Stay in line. You still get to vote.' && !/Already in line/.test(e.sub.join(' ')), JSON.stringify(e && e.sub));
    check('results: 7:05 PM Eastern: Georgia links its official results; Florida (panhandle on Central) still voting, in local time', row(e, 'GA').url === INDEX.states.GA.results_url && row(e, 'GA').source === 'Georgia Secretary of State' && !row(e, 'FL').url && row(e, 'FL').open === 'Voting open until 7 PM local time', JSON.stringify(row(e, 'FL')));
    check('results: 7:05 PM Eastern: California says when it ends, in its own zone, and no results link yet', !row(e, 'CA').url && row(e, 'CA').open === 'Voting open until 8 PM Pacific' && row(e, 'NY').open === 'Voting open until 9 PM Eastern' && row(e, 'CO').open === 'Voting open until 7 PM Mountain', `${row(e, 'CA').open} | ${row(e, 'NY').open} | ${row(e, 'CO').open}`);
    check('results: a state across zones says "local time", never the zone that closes last (Austin read "7 PM Mountain" as 8 PM Central)', row(e, 'TX').open === 'Voting open until 7 PM local time' && row(e, 'OR').open === 'Voting open until 8 PM local time' && !e.rows.some((r) => /Mountain/.test(r.open || '') && ['TX', 'OR'].includes(r.st)), `${row(e, 'TX').open} | ${row(e, 'OR').open}`);
    check('results: Tennessee keeps both zones from its own data', row(e, 'TN').open === 'Voting open until 7 PM Central (8 PM Eastern)', row(e, 'TN').open);
    check('results: no mail-ballot trackers while any state is still voting', e.rows.every((r) => !r.track));
    const m = lead('mostly');
    check('results: 8:05 PM Mountain: every state but the Pacific ones links its results', m.rows.filter((r) => !r.url).map((r) => r.st).sort().join(' ') === 'CA OR WA' && !m.after, m.rows.filter((r) => !r.url).map((r) => r.st).join(' '));
    const a = lead('all');
    check('results: 8:05 PM Pacific: every state links its results, and its mail-ballot tracker', a.after && a.rows.every((r) => r.url && r.track) && a.head === 'Results are rolling in.', JSON.stringify(a.rows.filter((r) => !r.url || !r.track)));
    check('results: 8:05 PM Pacific: every state has closed, so the in-line line is the plain one', a.sub.join(' ') === 'Official results for each state are below. Already in line? Stay in line. You still get to vote.', JSON.stringify(a.sub));
    check('results: 7:05 PM Mountain: still some states voting, still the "still open" line', lead('austin').sub.join(' ').includes('Polls are still open in some states.'), JSON.stringify(lead('austin').sub));
    const n = plan.resultsLead(INDEX.states, '2026-11-04', new RealDate(I.next));
    check('results: Nov 4: "still coming in", counting takes days', n.after && n.head === 'Results are still coming in.' && n.sub.join(' ') === 'Official results for each state are below. Counting can take days, especially for mail ballots.');
    check('results: the race-call desks are AP and Decision Desk HQ, https', plan.RACE_CALLS.map((d) => d.name).join('|') === 'AP|Decision Desk HQ' && plan.RACE_CALLS.every((d) => /^https:\/\//.test(d.url)));

    // The first page at each instant, as the device sees it (Central; ?today pins the device's date).
    st.S.index = INDEX; st.S.view = 'door'; st.S.ballot = null; st.S.zip = ''; st.S.tryMode = null;
    const door = (k, today = '2026-11-03') => { at(`?today=${today}`); pin(I[k]); try { return mast.mastHTML(); } finally { globalThis.Date = RealDate; } };
    at('?today=2026-11-03&now=10:00');
    const morning = mast.mastHTML();
    const d0 = door('before');
    check('door: before the first close it is exactly the plan page it was this morning', d0 === morning && /data-door="plan"/.test(d0) && /Quickly make your voting plan\./.test(d0) && !/Results are/.test(d0));
    const d1 = door('east');
    check('door: 7:05 PM Eastern leads with results, says they are below, and keeps the plan sheet under "Your ballot and local results"', /data-door="results"/.test(d1) && /<h1 class="place res-h">Results are rolling in\.<\/h1>/.test(d1) && /Official results for each state are below\./.test(d1) && /Your ballot and local results/.test(d1) && /id="zip"/.test(d1) && /class="bigbtn" data-act="setup-done"/.test(d1) && !/Quickly make your voting plan/.test(d1));
    check('door: 7:05 PM Eastern: Georgia is a results link, California says when voting ends', d1.includes(`<a class="res-st" href="${INDEX.states.GA.results_url}" target="_blank" rel="noopener">Georgia</a>`) && /<span class="res-st">California<\/span><span class="res-src">Voting open until 8 PM Pacific<\/span>/.test(d1));
    check('door: 7:05 PM Eastern: Texas says "7 PM local time" and the sub says polls are still open in some states', /<span class="res-st">Texas<\/span><span class="res-src">Voting open until 7 PM local time<\/span>/.test(d1) && /Polls are still open in some states\./.test(d1) && !/Already in line/.test(d1));
    // "Show my ballot" fills only when the first page shows the fill switch: on while some state is voting, off once
    // every one has closed and the page hides it (a new voter's ballot got newspaper picks they never saw offered).
    const fillsAt = (k) => { st.S.door.fill = true; pin(I[k]); try { return mast.doorFills(); } finally { globalThis.Date = RealDate; } };
    const keepFill = st.S.door.fill;
    try {
      check('door: the fill runs at 7:05 PM Eastern (switch shown) and not at 8:05 PM Pacific (switch hidden)', fillsAt('east') === true && fillsAt('all') === false);
    } finally { st.S.door.fill = keepFill; }
    check('door: the race-call line shows once, under the list, with both desks', (d1.match(/class="res-calls"/g) || []).length === 1 && d1.includes(`<a href="${plan.RACE_CALLS[0].url}" target="_blank" rel="noopener">AP</a> · <a href="${plan.RACE_CALLS[1].url}" target="_blank" rel="noopener">Decision Desk HQ</a>`) && d1.indexOf('res-calls') > d1.indexOf('res-list'));
    const d3 = door('all');
    check('door: 8:05 PM Pacific: results, a mail-ballot tracker per state, and the ZIP as one quiet line under the list', /data-door="after"/.test(d3) && (d3.match(/class="res-track"/g) || []).length === Object.keys(INDEX.states).length && /See your ballot and county results/.test(d3) && d3.indexOf('res-zip-l') > d3.indexOf('res-calls') && /id="zip"/.test(d3));
    check('door: once every state has closed, nothing talks about making a plan or picking', !/voting plan|Make your plan|Pick by endorsements|class="bigbtn"|Your ballot and local results/i.test(d3), (d3.match(/voting plan|Make your plan|Pick by endorsements|bigbtn/i) || [''])[0]);
    const d4 = door('next', '2026-11-04');
    check('door: Nov 4: "Results are still coming in."', /Results are still coming in\./.test(d4) && /Counting can take days/.test(d4) && /data-door="after"/.test(d4));
    check('door: copy has no em dashes', ![d1, d3, d4].some((h) => /—/.test(h.replace(/<[^>]+>/g, ''))));

    // The plan strip once the polls close: "Official results" to the most local page, "Track your ballot" beside it.
    st.S.ui.open = new Set();
    let b = open('TX', ['austin-tx']);
    bl.localize(b, '78702', null);
    check('strip: Austin 78702 is still Election Day at 7:05 PM Eastern, and results at 7:05 PM Central', plan.nextStep(b.howto, '2026-11-03', false, new RealDate(I.east)).phase === 'election_day' && plan.nextStep(b.howto, '2026-11-03', false, new RealDate(I.austin)).phase === 'polls_closed');
    at('?today=2026-11-03&now=19:05');
    const travisRes = read('place-austin-tx.json').by_county.find((c) => c.county === 'Travis').lookups.results;
    let h = ps.planHTML();
    check('strip: county known (78702, Travis): "Official results" opens Travis County’s page, its source named', h.includes(`<a class="pbtn gold" href="${travisRes}" target="_blank" rel="noopener" data-fk="plan-results">Official results</a>`) && /Source: Travis County Clerk/.test(h) && /<p class="plan-sub">Official results are below\. Already in line\? Stay in line\. You still get to vote\.<\/p>/.test(h), h.slice(h.indexOf('plan-h'), h.indexOf('plan-h') + 600));
    check('strip: "Track your ballot" beside it, the race calls under it, no registration check after the polls close', /<a class="pbtn line" href="[^"]+" target="_blank" rel="noopener">Track your ballot<\/a>/.test(h) && (h.match(/class="plan-hint plan-calls"/g) || []).length === 1 && !/Check my registration/.test(h));
    b = open('TX', ['austin-tx']);
    bl.localize(b, '78729', null);
    h = ps.planHTML();
    const ctys = [...h.matchAll(/<a class="pbtn line" href="([^"]+)"[^>]*data-county="([^"]+)">([^<]+)<\/a>/g)].map((x) => x[3]);
    check('strip: across county lines, county unknown (78729): the state’s results, then each county’s by name', h.includes(`href="${INDEX.states.TX.results_url}" target="_blank" rel="noopener" data-fk="plan-results">Official results</a>`) && /Your county’s results:/.test(h) && ctys.join('|') === 'Travis County|Williamson County|Hays County', ctys.join('|'));
    // A county with no results page of its own (Atlanta's Fulton, Aurora's Douglas): no county buttons at all, only
    // the state's, which covers every county. A lone "DeKalb County" pointed most of Atlanta at the wrong county.
    for (const [stc, id, zip, cty] of [['GA', 'atlanta-ga', '30306', 'Fulton'], ['CO', 'aurora-co', '80012', 'Douglas']]) {
      open(stc, [id]);
      bl.localize(st.S.ballot, zip, null);
      const hx = ps.planHTML();
      check(`strip: ${id} ${zip}, county unknown, ${cty} has no results page: the state’s results only, no county buttons`, st.S.ballot.county == null && read(`place-${id}.json`).by_county.some((c) => c.county === cty && !c.lookups.results) && hx.includes(`href="${INDEX.states[stc].results_url}" target="_blank" rel="noopener" data-fk="plan-results">Official results</a>`) && !/Your county’s results/.test(hx) && !/data-county=/.test(hx), (hx.match(/data-county="[^"]+"/g) || []).join(' '));
    }
    // No "register and vote today" under the results, in any state that offers it.
    const regAt = (q) => { at(q); return Object.keys(INDEX.states).filter((stc) => { open(stc, []); bl.localize(st.S.ballot, null, null); return /class="plan-reg"|Not registered\?/.test(ps.planHTML()); }); };
    const regNoon = regAt('?today=2026-11-03&now=12:00'), regAfter = regAt('?today=2026-11-03&now=23:30');
    check('strip: after the polls close, no registration alert in any state (CA, CO, DC, IL, MD, WA said "register in person and vote today")', ['CA', 'CO', 'WA'].every((x) => regNoon.includes(x)) && regAfter.length === 0, `noon: ${regNoon.join(' ')} | after: ${regAfter.join(' ')}`);
    at('?today=2026-11-03&now=19:05');
    open('TX', ['dallas-tx']);
    bl.localize(st.S.ballot, '75201', null);
    const dallasRes = read('place-dallas-tx.json').lookups.results;
    check('strip: a one-county place (Dallas): its county’s results', ps.planHTML().includes(`href="${dallasRes}" target="_blank" rel="noopener" data-fk="plan-results">Official results</a>`));
    open('TX', []);
    bl.localize(st.S.ballot, '79901', null);
    check('strip: a statewide ballot: the state’s results', ps.planHTML().includes(`href="${INDEX.states.TX.results_url}" target="_blank" rel="noopener" data-fk="plan-results">Official results</a>`) && !/Your county’s results/.test(ps.planHTML()));
    at('?today=2026-11-04');
    open('TX', ['dallas-tx']);
    bl.localize(st.S.ballot, '75201', null);
    h = ps.planHTML();
    check('strip: Nov 4: "Results are still coming in.", counting takes days, results below', /<p class="plan-h" id="plan-h">Results are still coming in\.<\/p>/.test(h) && /Counting can take days, especially for mail ballots\. Official results are below\./.test(h) && /Official results<\/a>/.test(h));
    at('?today=2026-11-03&now=18:59');
    h = ps.planHTML();
    check('strip: a minute before close, the Election Day step is as it was (no results, registration check kept)', /Today is Election Day/.test(h) && !/Official results/.test(h) && !/plan-calls/.test(h));
  } finally {
    globalThis.Date = RealDate;
    if (hadLoc) Object.defineProperty(globalThis, 'location', hadLoc); else delete globalThis.location;
    st.S.ballot = keep.ballot; st.S.b = keep.b; st.S.view = keep.view; st.S.index = keep.index; st.S.zip = keep.zip; st.S.tryMode = keep.tryMode; st.S.ui.open = keep.open;
  }
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
