/* The app's flows: loading data, opening a ballot (saved picks, save links, the restore prompt),
   the ZIP box, the Census address lookup, views and the browser's Back button, and the hidden
   "try as" scenarios. */
import type { Index, PlaceBundle, StateBundle } from './types';
import { S, emptyBallotState, noSections, persist, leaveLast, leftBallot, savedBallot, parseShareHead, decodeShare, normalizeRanks, type BallotState, type View } from './state';
import { buildBallot, entriesBySection, status, isRCV, isMultiSeat, isMultiJudge, rankMax, decisionItems, chosenIds, sectionOf, sameSeat, type Ballot } from './ballot';
import { zipState, censusLookup, placeFromGeo, settleAddress, withPlace, tidyAddress, type GeoResult } from './geo';
import { toast, hideToast } from './util';
import { keepPrivate } from './errors';
import { track, type Events } from './stats';
import { render, renderBallot, renderAddr, anchored, $ } from './render';
import { setInvolved, type GetInvolved } from './views/pass';
import { planAgree, applyFills, planParty, planSetup, forgetUndo, fillStands, canUndo } from './model/bulk';
import { addrSummary, localAnswers, mapNotes, lookupPasses, type MapResult } from './model/address';
import { ballotMaps, fromTopo, answerAt, edgeOf, type FeatureCollection, type Topology } from './model/maps';
import { partiesOnBallot, toggleChip, setSources, setParty, chipMembers, chipState, doorNone, noEndorsements, CHIPS } from './model/lens';

/* ---------- data ---------- */
const BASE = import.meta.env.BASE_URL || '/';
const cache = new Map<string, Promise<unknown>>();
export function getJSON<T>(path: string): Promise<T> {
  if (!cache.has(path)) {
    const p = fetch(`${BASE}data/${path}`, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${path}`);
      return r.json();
    });
    p.catch(() => cache.delete(path));
    cache.set(path, p);
  }
  return cache.get(path) as Promise<T>;
}
export async function ensureIndex(): Promise<Index> {
  if (!S.index) S.index = await getJSON<Index>('index.json');
  return S.index;
}
/* A district map's boundaries (model/maps.ts), once per visit. Fetched only after an address
   lookup on a ballot whose places list it, or while that lookup is out with the Census. A map that
   doesn't answer in a few seconds counts as not loaded: its request is aborted and forgotten, so a
   second lookup asks again instead of waiting on the same stuck request. Not through getJSON, whose
   cache would keep the stuck request. */
const maps = new Map<string, Promise<FeatureCollection>>();
const mapsLoaded = new Set<string>();
export const MAP_TIMEOUT_MS = 6000;
export function loadMap(file: string, timeoutMs = MAP_TIMEOUT_MS): Promise<FeatureCollection> {
  if (!maps.has(file)) {
    const stop = new AbortController();
    const timer = window.setTimeout(() => stop.abort(), timeoutMs);
    const p = fetch(`${BASE}data/${file}`, { cache: 'no-cache', signal: stop.signal })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status} for ${file}`); return r.json() as Promise<Topology>; })
      .then((t) => { const fc = fromTopo(t); mapsLoaded.add(file); return fc; })
      .finally(() => window.clearTimeout(timer));
    p.catch(() => { maps.delete(file); });
    maps.set(file, p);
  }
  return maps.get(file)!;
}
const warmMaps = (b: Ballot | null): void => { if (b) for (const { meta } of ballotMaps(b)) loadMap(meta.file).catch(() => { /* counted when it's needed */ }); };
/* On the first page or the place question, before the ballot opens: the places' maps, from the index. */
const warmPlaces = (idx: Index | null, ids: string[]): void => { for (const id of ids) for (const f of (idx && idx.places[id]?.maps) || []) loadMap(f).catch(() => { /* counted when it's needed */ }); };

/* Optional: ways to get involved, from the data track. A missing file is normal. */
let involvedTried = false;
export async function loadInvolved(): Promise<void> {
  if (involvedTried || !S.index || !S.index.involved) return;
  involvedTried = true;
  try {
    const r = await fetch(`${BASE}data/get-involved.json`, { cache: 'no-cache' });
    if (r.ok) setInvolved(await r.json() as GetInvolved);
  } catch { /* none yet */ }
}

/* ---------- views and the Back button ---------- */
/* Each screen the page shows, counted once each time it changes (stats.ts "view"): the first page, the
   ballot, My plan, Help friends vote, Full details. */
let lastView = '';
export function viewed(): void {
  if (S.view === 'loading') return;
  const name: Events['view']['name'] = S.view !== 'ballot' ? 'start' : S.ui.reader ? 'reader' : S.ui.view === 'cheat' ? 'plan' : S.ui.view === 'pass' ? 'share' : 'ballot';
  if (name === lastView) return;
  lastView = name;
  track('view', { name });
}
export function resetUI(): void {
  const u = S.ui;
  u.view = 'ballot'; u.row = null; u.page = {}; u.others.clear(); u.keep = null; u.beat = null;
  // The sections as you left them on this ballot (S.b.secs, saved with it).
  const secs = S.b.secs || noSections();
  u.folded = new Set(secs.folded); u.unfolded = new Set(secs.unfolded); u.reveal = new Set(secs.reveal);
  u.noteOpen.clear(); u.reader = null; u.sheet = null; u.sheetFrom = null; u.sheetBack = null; u.addrOpen = false; u.addrMsg = null; u.addrFail = ''; u.addrFound = null; u.addrWhich = null; u.addrMaps = []; u.addrMapsPending = false; u.saveOpen = false; u.copyFallback = null; u.bulk = null; u.bulkWhy = null; u.addrFilled = null; u.lensEmptied = false;
  u.resume = false; u.covAsk = '';
  u.open.delete('voted');
}
export function go(view: View, push = true): void {
  if (S.ui.view === view) return;
  S.ui.view = view;
  S.ui.reader = null; S.ui.sheet = null; S.ui.sheetBack = null;
  hideToast(); // a toast belongs to the view it was raised on
  if (push) { try { history.pushState({ vg: view }, '', location.pathname + location.search); } catch { /* ignore */ } }
  render();
  viewed();
  if (view === 'cheat') render(['print']);
  window.scrollTo(0, 0);
  if (view === 'pass') void loadInvolved().then(() => { if (S.ui.view === 'pass') render(['pass']); });
}
export function openReader(id: string, push = true): void {
  S.ui.reader = id;
  if (push) { try { history.pushState({ vg: S.ui.view, reader: id }, '', location.pathname + location.search); } catch { /* ignore */ } }
  render(['sheet']);
  viewed();
  document.body.classList.add('sheet-open');
  ($('[data-fk="reader-x"]'))?.focus({ preventScroll: true });
}
/* The first page. Back after a ZIP lands here (the history entry it left is marked "start"), and
   so does "Change". Picks already saved stay saved; the guide just stops reopening that ballot. */
export function toDoor(): void {
  if (S.view === 'ballot') persist(true);
  if (S.view === 'ballot' && S.b.zip) S.zip = S.b.zip;
  leaveLast();
  // Counted the way the bar counts, while the ballot is still here (rankings count, hidden races don't).
  S.doorSaved = leftBallot(S.view === 'ballot' && S.ballot ? decisionItems().filter((x) => x.done).length : undefined);
  cancelLoad();
  S.view = 'start'; S.ballot = null; S.zipChoice = null; S.picked = null; S.coverage = null; S.pending = null; S.loadErr = null; S.retry = null; S.zipErr = '';
  S.ui.view = 'ballot'; S.ui.reader = null; S.ui.sheet = null; S.ui.sheetBack = null; S.ui.addrOpen = false; S.ui.addrMsg = null; S.ui.addrFail = ''; S.ui.addrFound = null; S.ui.addrWhich = null; S.ui.resume = false;
  forgetUndo();
  hideToast();
  render();
  viewed();
  window.scrollTo(0, 0);
  $('#zip')?.focus({ preventScroll: true });
  // The ZIP still in the box finds its place again (from the cache): the place line and the counts.
  if (/^\d{5}$/.test(S.zip)) void lookZip(S.zip);
}
/* A place picked from the shelf's list of cities while a ballot shows: the ballot is left as Change
   leaves it (saved, remembered as left, and offered on the first page), before the place opens there. */
export function leaveBallot(): void {
  if (S.view !== 'ballot' || !S.ballot) return;
  persist(true);
  leaveLast();
  S.doorSaved = leftBallot(decisionItems().filter((x) => x.done).length);
  S.view = 'start'; // off the ballot now, so the place's load doesn't save this one again as the one to reopen
}
/* "Open my ballot" on the first page: the ballot you left, as you left it. */
export async function openSaved(): Promise<void> {
  const d = S.doorSaved;
  if (!d || !S.index) return;
  const [st, placesStr] = d.key.split('|');
  const places = placesStr === '-' ? [] : placesStr.split('+').filter((p) => S.index!.places[p]);
  if (S.index.states[st] && await openBallot(st, places, d.zip, { noSetup: true, how: 'returning' })) leftDoor(); // Back returns here
}
/* Leaving the first page for a ballot (a ZIP, a place picked, an address): the entry we leave
   becomes the first page, so the phone's Back button returns to it instead of leaving the site. */
function leftDoor(): void {
  S.doorSaved = null;
  try {
    history.replaceState({ vg: 'start' }, '', location.pathname + location.search);
    history.pushState({ vg: 'ballot', door: 1 }, '', location.pathname + location.search);
  } catch { /* ignore */ }
  viewed();
}
window.addEventListener('popstate', (e) => {
  const st = (e.state || {}) as { vg?: View | 'start'; reader?: string };
  if (st.vg === 'start') { if (S.view !== 'start' || S.ballot) toDoor(); return; }
  if (!S.ballot || S.view !== 'ballot') return;
  const view: View = st.vg || 'ballot';
  const fromReader = S.ui.reader;
  S.ui.reader = st.reader || null;
  S.ui.sheet = null; S.ui.sheetBack = null;
  if (view !== S.ui.view) { S.ui.view = view; render(); window.scrollTo(0, 0); }
  else render(['sheet']);
  viewed();
  if (fromReader && !S.ui.reader) document.querySelector<HTMLElement>(`[data-fk="rd-${CSS.escape(fromReader)}"]`)?.focus({ preventScroll: true });
});

/* ---------- opening a ballot ---------- */
/* An address on the first page that matched a ZIP with several places: kept in memory until a
   place is picked, so its districts come along. */
let chooserGeo: { zip: string; r: GeoResult } | null = null;
const countPicks = (b: BallotState): number => Object.keys(b.picks).length + Object.keys(b.ranks || {}).filter((k) => !(k in b.picks)).length;
/* A ballot this device has nothing for yet: no picks, the default sources, no party, and the first
   page never finished. The first page's choices become its sources and party. */
const needsSetup = (b: BallotState | null): boolean => !b || (!b.setupDone && countPicks(b) === 0 && b.sources === null && b.party === null);
/* The first page's chips and party, onto a ballot that has nothing yet: each chip on or off as
   chosen (a group with no picks here stays out, as its chip does), then the party if it is on
   this ballot. A party it doesn't have just drops out. */
function applyDoor(b: Ballot): void {
  // "Fill in my ballot with their picks" starts on for a new ballot (Kevin, Oct 20) unless you set it.
  if (!S.door.fillSet) S.door.fill = true;
  if (doorNone()) { S.b.sources = []; S.b.party = null; return; } // "Don’t show endorsements"
  let ids = chosenIds();
  for (const c of CHIPS) {
    if (c.key !== 'papers' && chipState(b, c.key) === 'empty') continue;
    const members = chipMembers(b, c.key).map((e) => e.id);
    ids = S.door.chips[c.key] ? [...ids, ...members] : ids.filter((id) => !members.includes(id));
  }
  setSources(b, ids);
  const p = S.door.party;
  if (p && partiesOnBallot(b).some((x) => x.party === p)) setParty(b, p);
}
/* The other way: the first page showing a ballot with choices of its own shows those, so the
   choices kept for the next new ZIP become the ones on screen. A chip this ballot hides (no group
   of that kind made picks here) keeps what it was. */
function doorFromBallot(b: Ballot): void {
  S.door.only = S.b.hideDecided;
  // A ballot this device has shown starts with the fill off, so it can't refill races you cleared.
  if (!S.door.fillSet) S.door.fill = false;
  if (noEndorsements()) { S.door.chips = { papers: false, progressive: false, conservative: false }; S.door.party = null; return; }
  for (const c of CHIPS) {
    const st = chipState(b, c.key);
    if (st !== 'empty' || c.key === 'papers') S.door.chips[c.key] = st === 'on' || st === 'some';
  }
  S.door.party = S.b.party;
}
/* Loads race: a ZIP typed again, or cleared, while the last one was still loading. Only the newest
   load lands; `previewing` is the one the first page waits on when "Show my ballot" comes early. */
let loadSeq = 0;
let previewing: Promise<boolean> | null = null;
let lookingUp: string | null = null; // the ZIP lookZip is loading, so the same ZIP again doesn't start over
export function cancelLoad(): void { loadSeq++; previewing = null; lookingUp = null; }
/* Resolves true once the ballot is open (on the first page or shown), false when it couldn't load
   (the first page then shows why, with "Try again") or a newer load took over.
   `door`: for the first page. The ballot loads for the place line and step 2's counts and isn't
   shown until "Show my ballot". A ballot this device has nothing for takes the first page's choices;
   one it has keeps its own. Reopening a ballot from boot that has nothing yet goes there too.
   `noSetup`: the voter is already on a ballot (an address narrowing "Aurora or Denver" to Aurora).
   `after`: what to do once it's open (an address's districts), on the first try or on "Try again".
   `how`: how the voter got here, counted when the ballot shows (stats.ts "ballot"); a save link counts as
   "shared" by itself. A first-page ballot counts when "Show my ballot" shows it (showBallot). None: it
   isn't a new ballot (an address narrowing the one already open), so nothing is counted. */
type How = Events['ballot']['how'];
type OpenOpts = { share?: ReturnType<typeof parseShareHead>; door?: boolean; noSetup?: boolean; how?: How; after?: () => void | Promise<void> };
/* How the ballot on the first page was found, for when "Show my ballot" shows it. */
let doorHow: How = 'zip';
/* A ballot shown, counted by its state code only (stats.ts Events: a place can name the ZIP typed). */
function shown(b: Ballot, how: How): void {
  track('ballot', { state: b.st, how });
}
export function openBallot(st: string, placeIds: string[], zip: string, opts: OpenOpts = {}): Promise<boolean> {
  const p = loadBallot(st, placeIds, zip, opts);
  previewing = p;
  return p;
}
async function loadBallot(st: string, placeIds: string[], zip: string, opts: OpenOpts): Promise<boolean> {
  const seq = ++loadSeq;
  if (S.ballot && S.view === 'ballot') persist(true); // a pick made just now lands on its own ballot
  S.view = 'loading';
  S.loadErr = null;
  S.retry = null;
  if (opts.door) { S.zip = zip; S.zipErr = ''; S.zipChoice = null; S.coverage = null; }
  // Every region, not just the masthead: a ballot that was open (a save link pasted into its tab)
  // leaves with its foot and bar, so the first page's own How row isn't painted beside them (Codex, Oct 21).
  render();
  try {
    await ensureIndex();
    const [sb, ...pbs] = await Promise.all([getJSON<StateBundle>(`state-${st}.json`), ...placeIds.map((id) => getJSON<PlaceBundle>(`place-${id}.json`))]);
    if (seq !== loadSeq) return false;
    const ballot = buildBallot(sb, pbs);
    S.ballot = ballot;
    forgetUndo();
    const existing = S.tryMode ? null : savedBallot(ballot.key);
    const reopened = existing ? normalizeRanks(ballot, existing) : 0;
    S.b = existing || emptyBallotState(zip);
    if (zip) S.b.zip = zip;
    // Back on the first page after a reload, the saved line's count, now by the bar's rule.
    if (S.doorSaved && S.doorSaved.key === ballot.key && !opts.share) {
      S.doorSaved = { ...S.doorSaved, n: decisionItems().filter((x) => x.done).length };
    }
    S.pending = null;
    if (reopened && !opts.share) toast(`${reopened === 1 ? 'A race you marked is' : `${reopened} races you marked are`} ranked choice now. Rank your picks there again.`);
    if (opts.share && !S.tryMode) {
      const { state, dropped } = decodeShare(ballot, opts.share);
      state.setupDone = true; // a ballot that came from a link never asks step 2, even after a reload
      // "Hide races I've decided" and the sections you folded aren't in the link: a link opened on
      // this device keeps this device's.
      state.hideDecided = !!existing && existing.hideDecided;
      state.secs = existing ? existing.secs : noSections();
      normalizeRanks(ballot, state);
      const n = countPicks(state);
      const m = existing ? countPicks(existing) : 0;
      const same = existing && JSON.stringify(existing.picks) === JSON.stringify(state.picks) && JSON.stringify(existing.notes) === JSON.stringify(state.notes)
        && JSON.stringify(existing.ranks) === JSON.stringify(state.ranks);
      if (existing && m > 0 && !same) {
        S.pending = { kind: 'restore', key: ballot.key, incoming: state, summary: `This link has ${n} ${n === 1 ? 'pick' : 'picks'}. This device already has ${m} saved for this ballot. Which do you want to keep?` };
      } else if (!existing || m === 0) {
        // A device that had nothing here: show the picks, and say plainly where they came from.
        S.b = state;
        const where = ballot.places.length ? ballot.places.map((p) => p.label.replace(/\s*\(.*\)$/, '')).join(' or ') : ballot.stateName;
        if (n) S.pending = { kind: 'shared', key: ballot.key, incoming: state, summary: `This link brought ${n} ${n === 1 ? 'pick' : 'picks'} for ${where}${dropped ? ` (${dropped} couldn’t be matched to today’s data)` : ''}. If a friend shared them, use them as a start or start fresh.` };
        else toast('Opened the ballot from your link.');
      } else {
        S.b = state;
        toast(`Restored ${n} ${n === 1 ? 'pick' : 'picks'} from your link.${dropped ? ` ${dropped} couldn’t be matched to today’s data.` : ''}`);
      }
      try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ }
    }
    if (S.tryMode) applyScenario(S.tryMode);
    const door = !opts.share && !opts.noSetup && (!!opts.door || (!S.tryMode && needsSetup(existing)));
    if (door && !S.tryMode && needsSetup(existing)) applyDoor(ballot);
    else if (door) doorFromBallot(ballot);
    if (door) S.zip = zip;
    S.view = door ? 'setup' : 'ballot';
    S.zipChoice = null;
    S.coverage = null;
    resetUI();
    if (!door) S.b.setupDone = true; // a ballot this device has shown never goes back to the first page on its own
    render();
    persist(true); // saves nothing on the first page
    viewed();
    if (door) doorHow = opts.how || 'zip';
    else if (opts.share || opts.how) shown(ballot, opts.share ? 'shared' : opts.how!);
    if (opts.share) track('share', { act: 'opened' });
    if (!door) switchOnNow();
    if (!door) window.scrollTo(0, 0);
    if (S.pending) $('[data-fk="restore-yes"]')?.focus();
    // What the caller does next (an address's districts) can't turn a loaded ballot into a load error.
    if (opts.after) { try { await opts.after(); } catch (e) { console.error(e); } }
    return true;
  } catch (e) {
    if (seq !== loadSeq) return false;
    console.warn('Could not load ballot', e);
    S.view = 'start';
    S.ballot = null;
    // "Try again" opens the same ballot, and the ZIP box holds its ZIP meanwhile.
    if (zip) S.zip = zip;
    S.loadErr = 'We couldn’t load that ballot. Check your connection.';
    S.retry = () => { void openBallot(st, placeIds, zip, opts); };
    render();
    viewed(); // back on the first page, counted like any other screen
    return false;
  }
}

/* ---------- the first page: steps 1 and 2 together ---------- */
/* What a complete ZIP finds, as soon as it's typed: its ballot, loaded for the place line and
   step 2's counts (from the cache when it's been opened before); the place question when it covers
   several places; or why not (an unknown ZIP, one we don't cover). Nothing is shown or saved. */
/* A ZIP that found its ballot: on a touch screen the number pad drops, so step 2 and "Show my ballot"
   come into view (UX walk, Oct 20). Focus moves to step 2's heading rather than nowhere, so a screen
   reader goes on from there. A keyboard keeps its place in the ZIP box. */
function dropKeypad(): void {
  const z = document.activeElement as HTMLElement | null;
  if (!z || z.id !== 'zip' || !window.matchMedia('(pointer: coarse)').matches) return;
  const h = document.getElementById('su-h');
  if (h) h.focus({ preventScroll: true }); else z.blur();
}
export async function lookZip(v: string): Promise<void> {
  if (S.view === 'setup' && S.ballot && S.b.zip === v) return; // already showing this ZIP's place
  if ((S.zipChoice && S.zipChoice.zip === v) || (S.coverage && S.coverage.zip === v)) return;
  if (S.view === 'loading' && lookingUp === v) return;
  cancelLoad();
  lookingUp = v;
  chooserGeo = null;
  S.view = 'start'; S.ballot = null;
  S.zip = v; S.zipErr = ''; S.zipChoice = null; S.picked = null; S.coverage = null; S.loadErr = null; S.retry = null;
  let idx: Index;
  try { idx = await ensureIndex(); } catch {
    S.loadErr = 'We couldn’t reach the guide’s data. Check your connection.';
    S.retry = () => { void lookZip(v); };
    render(['mast']); return;
  }
  if (S.zip !== v) return; // typed on meanwhile
  const places = idx.zips[v] || [];
  if (places.length === 1) { if (await openBallot(idx.places[places[0]].state, places, v, { door: true, how: 'zip' })) dropKeypad(); return; }
  if (places.length > 1) { S.zipChoice = { zip: v, placeIds: places }; S.ui.addrOpen = false; render(['mast']); return; }
  const st = zipState(v);
  if (st && idx.states[st]) { if (await openBallot(st, [], v, { door: true, how: 'zip' })) dropKeypad(); return; }
  if (!st) { S.zipErr = 'We couldn’t find that ZIP. Check the digits and try again.'; render(['mast']); return; }
  S.coverage = { kind: 'not_covered', state: st, zip: v };
  render(['mast']);
}
/* The ZIP box changed. Five digits look the ZIP up; anything less takes back what the last ZIP
   found (its place, its counts, a message about it), so the page never names a place for a ZIP
   that isn't in the box. */
export function zipTyped(v: string): void {
  if (v.length === 5) { void lookZip(v); return; }
  if (S.view === 'start' && !S.zipChoice && !S.coverage && !S.zipErr && !S.loadErr) return;
  cancelLoad();
  chooserGeo = null;
  S.view = 'start'; S.ballot = null;
  S.zipErr = ''; S.zipChoice = null; S.picked = null; S.coverage = null; S.loadErr = null; S.retry = null;
  render(['mast']);
}
/* After a place is picked on the first page (the place question, the list of cities, an address):
   the place line comes into view and focus moves on to step 2. */
function doorFocus(): void {
  if (S.view !== 'setup') return;
  const line = $('.door-place');
  if (line && line.getBoundingClientRect().top < 0) line.scrollIntoView({ block: 'start' });
  $('[data-fk="su-h"]')?.focus({ preventScroll: true });
}
/* "Show my ballot", and Enter in the ZIP box. With the ballot found: one batch of fills (the
   party's candidates, then where your sources agree), so one Undo takes it all back; the "Hide
   races I've decided" filter when something is left; then the ballot, saved for the first time,
   with the first page one Back away. Before that, it finishes what the ZIP box started: waits for a
   load, looks up a complete ZIP, or says what's missing. */
/* What the head's "N filled in" line says the fill drew on: "from your sources", or each part with a
   party ("6 from the Democratic Party, 17 from your sources"). */
export function fillWhy(plan: ReturnType<typeof planSetup>): string {
  const p = plan.party ? plan.party.fills.length : 0;
  const a = plan.agree.fills.length;
  return p ? `: ${[`${p} from the ${S.b.party} Party`, a ? `${a} from your sources` : ''].filter(Boolean).join(', ')}` : ' from your sources';
}
export async function showBallot(): Promise<{ n: number; plan: ReturnType<typeof planSetup> } | null> {
  if (S.view === 'ballot') return null;
  if (S.view === 'start' && !S.zipChoice && !S.coverage && !S.retry) {
    if (!/^\d{5}$/.test(S.zip)) { S.zipErr = 'Enter all 5 digits, like 80205.'; render(['mast']); $('#zip')?.focus(); return null; }
    await lookZip(S.zip);
  }
  if (S.view === 'loading' && previewing) await previewing;
  if (S.view !== 'setup' || !S.ballot) {
    // The place question still needs an answer, or the ZIP box has something to fix.
    const first = S.zipChoice ? $('.choose [data-act="choose-place"]') : null;
    if (first) first.focus(); else if (S.retry) $('[data-fk="retry"]')?.focus(); else $('#zip')?.focus();
    return null;
  }
  const plan = S.door.fill && !S.tryMode ? planSetup(S.b.party) : null;
  const n = plan && plan.fills.length ? applyFills(plan.fills) : 0;
  // A fill runs once: back on the first page later, the switch is off, so it can't refill races
  // you've since cleared. A new ZIP's ballot starts with it on again.
  if (plan) { S.door.fill = false; S.door.fillSet = false; }
  // Saved with the ballot, so a reload, a save link or a later visit on this device keeps it.
  S.b.hideDecided = S.door.only && !S.tryMode;
  S.ui.row = null; S.ui.keep = null;
  S.ui.bulk = n ? String(n) : null;
  S.ui.bulkWhy = n && plan ? fillWhy(plan) : null;
  // What the fill filled shows on this first look, even a section it finished (UX walk, Oct 20:
  // finished sections arrived folded, so the friend never saw the picks they agreed to). Under
  // "Hide races I've decided" the filter does what you asked.
  if (n && plan && !S.b.hideDecided) for (const f of plan.fills) { const it = S.ballot!.byId.get(f.id); if (it) S.ui.unfolded.add(sectionOf(it)); }
  S.b.setupDone = true;
  S.view = 'ballot';
  leftDoor();
  render();
  persist(true);
  shown(S.ballot!, doorHow);
  switchOnNow();
  window.scrollTo(0, 0);
  return plan && n ? { n, plan } : null;
}
/* A "Your source is in" reply links to ?on=<id> (main.ts boot): once a ballot that has that source shows, it is
   switched on and a toast says so, the same as its switch in the sources sheet (so it is saved, and in the save link,
   as that switch would be). A ballot without it leaves the ask for the next ballot this visit; a "try as" scenario
   never takes it.
   While a restore or shared-picks prompt is open it waits, and each of the prompt's answers runs it (actions.ts),
   with that answer's own words first in the toast. Returns whether it switched one on. */
export function switchOnNow(lead = ''): boolean {
  const id = S.switchOn;
  const b = S.ballot;
  if (!id || !b || S.view !== 'ballot' || S.tryMode || S.pending) return false;
  const e = b.eById.get(id);
  if (!e) return false;
  S.switchOn = null;
  if (!chosenIds().includes(id)) { setSources(b, [...chosenIds(), id]); persist(true); render(); }
  toast(`${lead ? `${lead} ` : ''}${e.short || e.name} is on. Its picks show beside your races.`);
  return true;
}

/* "Welcome back. You've decided 12 of 43.": a returning visitor's started ballot, reopened from this
   device (boot's last ballot, never a link or "try as"), with something decided and something left.
   Once per visit, above the plan, until any tap (main.ts). */
export function offerResume(): void {
  if (S.view !== 'ballot' || S.pending || S.tryMode) return;
  const items = decisionItems();
  const done = items.filter((i) => i.done).length;
  if (!done || done === items.length) return;
  S.ui.resume = true;
  render(['restore']);
}
export function dismissResume(): void {
  if (!S.ui.resume) return;
  S.ui.resume = false;
  anchored(() => render(['restore']));
}

/* ---------- address lookup ----------
   The address goes only to the Census geocoder and is never stored. Picking a place from the
   result lives in geo.ts (placeFromGeo, settleAddress), where the state must match before
   anything else. Three places ask: the first page before any ZIP, the place question, a ballot. */
/* A place picked on the place question. If an address brought the question up, its districts
   come along. `how`: "list" from the shelf's list of cities; otherwise the ZIP or address that asked. */
export async function openChosen(ids: string[], zip: string, how?: How): Promise<void> {
  const g = chooserGeo && chooserGeo.zip === zip ? chooserGeo.r : null;
  chooserGeo = null;
  const st = S.index!.places[ids[0]].state;
  const asked = S.zipChoice && S.zipChoice.zip === zip ? S.zipChoice : null;
  if (await openBallot(st, ids, zip, { door: true, how: how || (g ? 'address' : 'zip'), after: g && g.state === st ? () => applyGeo(g) : undefined })) {
    S.picked = asked;
    if (asked) render(['mast']);
    doorFocus();
  }
}
/* "Change" on a place picked from the place question: ask it again. */
export function rechoose(): void {
  const p = S.picked;
  if (!p) return;
  cancelLoad();
  S.view = 'start'; S.ballot = null; S.picked = null;
  S.zip = p.zip; S.zipChoice = p;
  render(['mast']);
  $(`[data-fk="cp-${CSS.escape(p.placeIds[0])}"]`)?.focus();
}
/* What was typed into the address box last, in memory only: "Not it? Try again", "None of these"
   and a message after a match put it back in the box. Never saved, logged or put in the page's
   address. */
let typedAddr = '';
function paintAddr(): void {
  renderAddr();
  const i = $('#addr-in') as HTMLInputElement | null;
  if (i && !i.value) i.value = typedAddr;
}
/* A lookup that went wrong: one line, and what to do next. `down`: the Census didn't answer, so
   "Try again"; `miss`: it answered with nothing we can use. On a ballot, either way, "Pick them
   myself" goes to the first district question. */
function addrFailed(msg: string, fail: 'down' | 'miss'): void {
  S.ui.addrBusy = false; S.ui.addrMsg = msg; S.ui.addrFail = fail;
  paintAddr();
}
export function reopenAddr(): void {
  S.ui.addrOpen = true; S.ui.addrMsg = null; S.ui.addrFail = ''; S.ui.addrWhich = null;
  paintAddr();
  const i = $('#addr-in') as HTMLInputElement | null;
  if (!i) return;
  i.scrollIntoView({ block: 'center' });
  i.focus({ preventScroll: true });
}
export async function runAddress(addr: string): Promise<void> {
  typedAddr = addr;
  const choosing = S.view !== 'ballot' && S.zipChoice;
  const b = S.view === 'ballot' ? S.ballot : null;
  const door = !b && !choosing;
  S.ui.addrFail = '';
  if (addr.trim().length < 6) { S.ui.addrMsg = 'Enter a street address with the city or ZIP.'; paintAddr(); return; }
  // A crash report that mentions it never leaves (errors.ts). Only once it passes as an address: a short
  // word turned away here stays covered as whole words while it sits in the box, and doesn't silence
  // every later report that happens to contain it (Codex, Oct 25).
  keepPrivate(addr);
  S.ui.addrBusy = true; S.ui.addrMsg = null; paintAddr();
  // This ballot's district maps load while the Census answers (they never load before a lookup).
  warmMaps(b);
  // Add the state and ZIP we already know; if that finds nothing (a typo in the ZIP, or an
  // address across a ZIP line), try once more with exactly what they typed.
  const typedZip = /^\d{5}$/.test(S.zip) ? S.zip : null;
  const st = door ? (typedZip ? zipState(typedZip) : null) : choosing && S.zipChoice ? S.index!.places[S.zipChoice.placeIds[0]]?.state || null : b!.st;
  const zip = door ? typedZip : choosing && S.zipChoice ? S.zipChoice.zip : S.b.zip || null;
  const full = withPlace(addr, st, zip);
  keepPrivate(full);
  let list: GeoResult[];
  try {
    list = await censusLookup(full);
    if (!list.length && full !== addr.trim()) list = await censusLookup(addr.trim());
  }
  catch { addrFailed('The Census lookup didn’t answer.', 'down'); return; }
  // What the Census matched, as it sent it and as the page shows it ("Found:", "Which one is yours?"),
  // and where it is: its point and its block's, as numbers written out.
  keepPrivate(...list.flatMap((r) => [r.matched, tidyAddress(r.matched), ...[r.point, r.block].flatMap((p) => (p ? [String(p.lon), String(p.lat)] : []))]));
  S.ui.addrBusy = false;
  if (!list.length) { addrFailed('The Census lookup couldn’t find that address. Try adding the city and ZIP.', 'miss'); return; }
  // Several matches (an address typed without its city can match more than one): "Which one is
  // yours?", and the one tapped goes on as a single match would (useMatch).
  if (list.length > 1) {
    S.ui.addrWhich = list; S.ui.addrMsg = null;
    paintAddr();
    $('[data-fk="aw-0"]')?.focus({ preventScroll: true });
    return;
  }
  await useMatch(list[0]);
}
/* One Census match, from the lookup or tapped from "Which one is yours?": the place it opens on the
   first page or the place question, or the districts it settles on a ballot. */
export async function useMatch(r: GeoResult): Promise<void> {
  const choosing = S.view !== 'ballot' && S.zipChoice;
  const b = S.view === 'ballot' ? S.ballot : null;
  const door = !b && !choosing;
  S.ui.addrWhich = null; S.ui.addrBusy = false; S.ui.addrFail = '';
  const geo = r;
  if (door) {
    let idx: Index;
    try { idx = await ensureIndex(); } catch { addrFailed('We couldn’t reach the guide’s data. Check your connection.', 'down'); return; }
    const hit = settleAddress(idx, r);
    if (hit.kind === 'open' || hit.kind === 'choose') warmPlaces(idx, hit.ids);
    if (hit.kind === 'none') { S.ui.addrMsg = 'We couldn’t tell which place that is. Try your ZIP.'; paintAddr(); return; }
    S.ui.addrOpen = false; S.ui.addrMsg = null; S.zipErr = '';
    if (hit.zip) S.zip = hit.zip;
    if (hit.kind === 'out') {
      cancelLoad();
      S.view = 'start'; S.ballot = null; S.picked = null; S.zipChoice = null;
      S.coverage = { kind: 'not_covered', state: hit.st, zip: hit.zip };
      render(['mast']);
      return;
    }
    if (hit.kind === 'choose') {
      cancelLoad();
      S.view = 'start'; S.ballot = null; S.picked = null;
      chooserGeo = { zip: hit.zip, r };
      S.zipChoice = { zip: hit.zip, placeIds: hit.ids };
      render(['mast']);
      $(`[data-fk="cp-${CSS.escape(hit.ids[0])}"]`)?.focus();
      return;
    }
    if (await openBallot(hit.st, hit.ids, hit.zip, { door: true, how: 'address', after: () => applyGeo(geo) })) doorFocus();
    return;
  }
  if (choosing && S.zipChoice) {
    const idx = S.index!;
    const ids = S.zipChoice.placeIds;
    const hit = placeFromGeo(idx.places, ids, r);
    if (hit) warmPlaces(idx, [hit]);
    if (!hit) {
      const st = idx.places[ids[0]]?.state;
      S.ui.addrMsg = r.state && st && ids.every((id) => idx.places[id].state !== r.state)
        ? `That address is outside ${idx.states[st]?.name || st}. Check the ZIP, or pick a place below.`
        : 'That address didn’t match one of these places. Pick one, or “I’m not sure”.';
      paintAddr(); return;
    }
    const zip = S.zipChoice.zip;
    const asked = S.zipChoice;
    S.ui.addrOpen = false;
    if (await openBallot(idx.places[hit].state, [hit], zip, { door: true, how: 'address', after: () => applyGeo(geo) })) { S.picked = asked; render(['mast']); doorFocus(); }
    return;
  }
  if (!b) return;
  if (r.state && r.state !== b.st) { addrFailed(`That address is outside ${b.stateName}. Change your ZIP first.`, 'miss'); return; }
  if (b.places.length > 1) {
    const hit = placeFromGeo(S.index!.places, b.places.map((p) => p.id), r);
    if (hit) { await openBallot(b.st, [hit], S.b.zip, { noSetup: true, after: () => applyGeo(geo) }); return; }
  }
  await applyGeo(r);
}
/* The districts a Census match settles on this ballot (model/address.ts), and the line that names
   them, which the ballot keeps. What the Census found shows back in the address box (on the first
   page, under the place line) until a reload or another ballot; the address itself is never kept.
   The Census's answers land first; the ballot's district maps fold in as each one arrives (usually
   at once: they load while the Census answers), so a slow or stuck map never holds up Congress.
   Each fold settles everything again from this address (setFromAddress undoes the last pass first)
   but leaves alone every claim the voter made during the lookup (lookupPasses), and a newer lookup, or
   another ballot, makes an older one's late maps change nothing. It returns
   once the first pass is painted, so nothing waits on a slow map ("Show my ballot" included). */
let geoSeq = 0;
export async function applyGeo(r: GeoResult): Promise<void> {
  const b = S.ballot!;
  const seq = ++geoSeq;
  const list = r.point ? ballotMaps(b) : [];
  const at = { point: r.point!, block: r.block };
  const results: MapResult[] = [];
  const fill = { n: 0, added: new Set<string>() };
  const pass = lookupPasses();
  const still = (): boolean => seq === geoSeq && S.ballot === b;
  // Maps already in hand answer in the first pass, the rest as they come.
  const ready = list.filter(({ meta }) => mapsLoaded.has(meta.file));
  const waiting = list.filter((m) => !ready.includes(m));
  for (const { meta } of ready) results.push({ meta, answer: answerAt(await loadMap(meta.file), at, { edge: edgeOf(meta) }) });
  if (!still()) return;
  settleGeo(b, r, results, waiting.length > 0, fill, pass, true);
  void Promise.all(waiting.map(async ({ meta }) => {
    let answer = null;
    try { answer = answerAt(await loadMap(meta.file), at, { edge: edgeOf(meta) }); } catch { /* didn't load: mapNotes says so */ }
    if (!still()) return;
    results.push({ meta, answer });
    settleGeo(b, r, results, results.length < list.length, fill, pass, false);
  }));
}
/* One pass: settle from the Census and the maps so far, fill what that put on the ballot (the fill
   ran here), and paint. `first`: the pass that closes the form and moves focus to what was found. */
function settleGeo(b: Ballot, r: GeoResult, results: MapResult[], pending: boolean, fill: { n: number; added: Set<string> }, pass: ReturnType<typeof lookupPasses>, first: boolean): void {
  const was = { districts: { ...S.b.districts }, mine: [...(S.b.mine || [])] };
  S.b.addrNote = addrSummary(pass(b, S.b, r, localAnswers(results, r)));
  S.ui.addrMaps = mapNotes(b, S.b, r, results, pending);
  S.ui.addrMapsPending = pending;
  // The fill ran on this ballot: the races the address just put on it get it too, by the same rules
  // (the party's candidates, then where your sources agree), in the same Undo, so the order you did
  // things in doesn't leave Congress blank (UX walk, Oct 20). Each pass fills only what it added; the
  // line counts every pass of this lookup.
  if (first) S.ui.addrFilled = null;
  if (S.view === 'ballot' && fillStands()) {
    const added = new Set([
      ...Object.entries(S.b.districts).filter(([k, v]) => v !== was.districts[k] && v !== 'none' && v !== '*').map(([, v]) => v),
      ...(S.b.mine || []).filter((id) => !was.mine.includes(id)),
    ]);
    // One answer can show two races (a Washington district's two House seats): both are new.
    for (const id of [...added]) for (const g of b.groups) for (const m of g.members) if (sameSeat(b.byId.get(id), b.byId.get(m))) added.add(m);
    added.forEach((id) => fill.added.add(id));
    const plan = planSetup(S.b.party);
    const fills = plan.fills.filter((f) => added.has(f.id));
    const live = canUndo();
    const n = fills.length ? applyFills(fills, true) : 0;
    if (n) {
      fill.n += n;
      const p = plan.party ? fills.filter((f) => plan.party!.fills.includes(f)).length : 0;
      const from = p === n ? `with ${S.b.party} candidates` : p ? `from your party and your sources` : 'from your sources';
      const t = fill.n, all = fill.added.size;
      S.ui.addrFilled = `Filled ${t === 1 ? (all === 1 ? 'it' : '1 of them') : t === all ? (t === 2 ? 'both' : `all ${t}`) : `${t} of them`} ${from}.`;
      S.ui.bulk = String((live && S.ui.bulk ? Number(S.ui.bulk) : 0) + n);
      // The head's line names your sources only when no party candidate is in its total: a party
      // breakdown's counts no longer add up after this, and a party fill isn't your sources' pick.
      const before = live ? S.ui.bulkWhy || '' : ' from your sources';
      S.ui.bulkWhy = p || before !== ' from your sources' ? null : ' from your sources';
    }
  }
  if (!first) {
    // A later pass repaints in place: the page doesn't jump, and focus stays where it was.
    const fk = (document.activeElement as HTMLElement | null)?.dataset?.fk;
    anchored(() => render());
    persist();
    if (fk) $(`[data-fk="${CSS.escape(fk)}"]`)?.focus({ preventScroll: true });
    return;
  }
  S.ui.addrFound = tidyAddress(r.matched) || null;
  S.ui.addrOpen = false;
  S.ui.addrMsg = null;
  S.ui.addrFail = '';
  S.ui.addrWhich = null;
  render();
  persist();
  // On a ballot, focus goes to what was found, in the box where the form was.
  if (S.view !== 'ballot') return;
  const f = $('[data-fk="addr-found"]') || $('.addrbox');
  if (!f) return;
  const r0 = f.getBoundingClientRect();
  if (r0.top < 0 || r0.bottom > window.innerHeight) f.scrollIntoView({ block: 'center' });
  if (f.matches('[tabindex]')) f.focus({ preventScroll: true });
}

/* ---------- "try as": scenarios for feeling the guide, never saved ---------- */
function applyScenario(kind: string): void {
  const b = S.ballot!;
  S.b = emptyBallotState(S.b.zip);
  b.groups.forEach((g) => { S.b.districts[g.key] = g.members[0]; });
  if (kind === 'fresh') return;
  if (kind === 'sources') { toggleChip(b, 'progressive'); toggleChip(b, 'conservative'); return; }
  if (kind === 'straight') {
    const p = partiesOnBallot(b).sort((x, y) => y.nominees - x.nominees)[0];
    if (p) { S.b.party = p.party; applyFills(planParty(p.party).fills); forgetUndo(); }
    return;
  }
  if (kind === 'aunt') {
    // Everything decided but the measures: her sources where they agree, then the first name.
    applyFills(planAgree().fills.filter((f) => b.byId.get(f.id)?.kind !== 'measure'));
    for (const [, entries] of entriesBySection()) {
      for (const e of entries) {
        if (e.t !== 'item') continue;
        const it = b.byId.get(e.id)!;
        if (it.kind !== 'contest' || status(it) !== 'open') continue;
        if (isMultiJudge(it)) it.candidates.forEach((c) => { S.b.picks[`${it.id}|${c.name}`] = 'YES'; });
        else if (it.is_retention) S.b.picks[it.id] = 'YES';
        else if (isRCV(it)) { S.b.ranks[it.id] = it.candidates.slice(0, Math.min(2, rankMax(it))).map((c) => c.name); S.b.picks[it.id] = 'DONE'; }
        else if (isMultiSeat(it)) { it.candidates.slice(0, it.vote_for).forEach((c) => { S.b.picks[`${it.id}|${c.name}`] = 'PICK'; }); }
        else if (it.candidates[0]) S.b.picks[it.id] = it.candidates[0].name;
      }
    }
    forgetUndo();
  }
}
export { renderBallot };
