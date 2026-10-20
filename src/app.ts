/* The app's flows: loading data, opening a ballot (saved picks, save links, the restore prompt),
   the ZIP box, the Census address lookup, views and the browser's Back button, and the hidden
   "try as" scenarios. */
import type { Index, PlaceBundle, StateBundle, Contest } from './types';
import { S, emptyBallotState, persist, forgetLast, savedBallot, parseShareHead, decodeShare, normalizeRanks, type BallotState, type View } from './state';
import { buildBallot, contestDistrict, entriesBySection, status, isRCV, isMultiSeat, isMultiJudge, rankMax, decisionItems, chosenIds, type Ballot } from './ballot';
import { zipState, censusLookup, placeFromGeo, settleAddress, withPlace, type GeoResult } from './geo';
import { toast, hideToast, plural } from './util';
import { render, renderBallot, renderAddr, anchored, $ } from './render';
import { setInvolved, type GetInvolved } from './views/pass';
import { addressCount } from './views/ledger';
import { planAgree, applyFills, planParty, planSetup, forgetUndo } from './model/bulk';
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
export function resetUI(): void {
  const u = S.ui;
  u.view = 'ballot'; u.row = null; u.page = {}; u.others.clear(); u.folded.clear(); u.unfolded.clear(); u.keep = null;
  u.noteOpen.clear(); u.reader = null; u.sheet = null; u.sheetFrom = null; u.sheetBack = null; u.addrOpen = false; u.addrMsg = null; u.addrFail = ''; u.saveOpen = false; u.copyFallback = null; u.bulk = null;
  u.resume = false;
  u.open.delete('voted');
}
export function go(view: View, push = true): void {
  if (S.ui.view === view) return;
  S.ui.view = view;
  S.ui.reader = null; S.ui.sheet = null; S.ui.sheetBack = null;
  hideToast(); // a toast belongs to the view it was raised on
  if (push) { try { history.pushState({ vg: view }, '', location.pathname + location.search); } catch { /* ignore */ } }
  render();
  if (view === 'cheat') render(['print']);
  window.scrollTo(0, 0);
  if (view === 'pass') void loadInvolved().then(() => { if (S.ui.view === 'pass') render(['pass']); });
}
export function openReader(id: string, push = true): void {
  S.ui.reader = id;
  if (push) { try { history.pushState({ vg: S.ui.view, reader: id }, '', location.pathname + location.search); } catch { /* ignore */ } }
  render(['sheet']);
  document.body.classList.add('sheet-open');
  ($('[data-fk="reader-x"]'))?.focus({ preventScroll: true });
}
/* The first page. Back after a ZIP lands here (the history entry it left is marked "start"), and
   so does "Change". Picks already saved stay saved; the guide just stops reopening that ballot. */
export function toDoor(): void {
  if (S.view === 'ballot') persist(true);
  if (S.view === 'ballot' && S.b.zip) S.zip = S.b.zip;
  forgetLast();
  cancelLoad();
  S.view = 'start'; S.ballot = null; S.zipChoice = null; S.picked = null; S.coverage = null; S.pending = null; S.loadErr = null; S.retry = null; S.zipErr = '';
  S.ui.view = 'ballot'; S.ui.reader = null; S.ui.sheet = null; S.ui.sheetBack = null; S.ui.addrOpen = false; S.ui.addrMsg = null; S.ui.addrFail = ''; S.ui.resume = false;
  forgetUndo();
  hideToast();
  render();
  window.scrollTo(0, 0);
  $('#zip')?.focus({ preventScroll: true });
  // The ZIP still in the box finds its place again (from the cache): the place line and the counts.
  if (/^\d{5}$/.test(S.zip)) void lookZip(S.zip);
}
/* Leaving the first page for a ballot (a ZIP, a place picked, an address): the entry we leave
   becomes the first page, so the phone's Back button returns to it instead of leaving the site. */
function leftDoor(): void {
  try {
    history.replaceState({ vg: 'start' }, '', location.pathname + location.search);
    history.pushState({ vg: 'ballot', door: 1 }, '', location.pathname + location.search);
  } catch { /* ignore */ }
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
   `after`: what to do once it's open (an address's districts), on the first try or on "Try again". */
type OpenOpts = { share?: ReturnType<typeof parseShareHead>; door?: boolean; noSetup?: boolean; after?: () => void };
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
  render(['mast']);
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
    S.pending = null;
    if (reopened && !opts.share) toast(`${reopened === 1 ? 'A race you marked is' : `${reopened} races you marked are`} ranked choice now. Rank your picks there again.`);
    if (opts.share && !S.tryMode) {
      const { state, dropped } = decodeShare(ballot, opts.share);
      state.setupDone = true; // a ballot that came from a link never asks step 2, even after a reload
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
    if (!door) window.scrollTo(0, 0);
    if (S.pending) $('[data-fk="restore-yes"]')?.focus();
    // What the caller does next (an address's districts) can't turn a loaded ballot into a load error.
    if (opts.after) { try { opts.after(); } catch (e) { console.error(e); } }
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
    return false;
  }
}

/* ---------- the first page: steps 1 and 2 together ---------- */
/* What a complete ZIP finds, as soon as it's typed: its ballot, loaded for the place line and
   step 2's counts (from the cache when it's been opened before); the place question when it covers
   several places; or why not (an unknown ZIP, one we don't cover). Nothing is shown or saved. */
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
  if (places.length === 1) { await openBallot(idx.places[places[0]].state, places, v, { door: true }); return; }
  if (places.length > 1) { S.zipChoice = { zip: v, placeIds: places }; S.ui.addrOpen = false; render(['mast']); return; }
  const st = zipState(v);
  if (st && idx.states[st]) { await openBallot(st, [], v, { door: true }); return; }
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
  // you've since cleared.
  if (plan) S.door.fill = false;
  S.ui.onlyUndecided = S.door.only && !S.tryMode && decisionItems().some((i) => !i.done);
  S.ui.row = null; S.ui.keep = null;
  S.ui.bulk = n ? String(n) : null;
  S.b.setupDone = true;
  S.view = 'ballot';
  leftDoor();
  render();
  persist(true);
  window.scrollTo(0, 0);
  return plan && n ? { n, plan } : null;
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
   come along. */
export async function openChosen(ids: string[], zip: string): Promise<void> {
  const g = chooserGeo && chooserGeo.zip === zip ? chooserGeo.r : null;
  chooserGeo = null;
  const st = S.index!.places[ids[0]].state;
  const asked = S.zipChoice && S.zipChoice.zip === zip ? S.zipChoice : null;
  if (await openBallot(st, ids, zip, { door: true, after: g && g.state === st ? () => applyGeo(g) : undefined })) {
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
/* A lookup that went wrong: one line, and what to do next. `down`: the Census didn't answer, so
   "Try again"; `miss`: it answered with nothing we can use. On a ballot, either way, "Pick them
   myself" goes to the first district question. */
function addrFailed(msg: string, fail: 'down' | 'miss'): void {
  S.ui.addrBusy = false; S.ui.addrMsg = msg; S.ui.addrFail = fail;
  renderAddr();
}
export async function runAddress(addr: string): Promise<void> {
  const choosing = S.view !== 'ballot' && S.zipChoice;
  const b = S.view === 'ballot' ? S.ballot : null;
  const door = !b && !choosing;
  S.ui.addrFail = '';
  if (addr.trim().length < 6) { S.ui.addrMsg = 'Enter a street address with the city or ZIP.'; renderAddr(); return; }
  S.ui.addrBusy = true; S.ui.addrMsg = null; renderAddr();
  // Add the state and ZIP we already know; if that finds nothing (a typo in the ZIP, or an
  // address across a ZIP line), try once more with exactly what they typed.
  const typedZip = /^\d{5}$/.test(S.zip) ? S.zip : null;
  const st = door ? (typedZip ? zipState(typedZip) : null) : choosing && S.zipChoice ? S.index!.places[S.zipChoice.placeIds[0]]?.state || null : b!.st;
  const zip = door ? typedZip : choosing && S.zipChoice ? S.zipChoice.zip : S.b.zip || null;
  const full = withPlace(addr, st, zip);
  let r: GeoResult | null;
  try {
    r = await censusLookup(full);
    if (!r && full !== addr.trim()) r = await censusLookup(addr.trim());
  }
  catch { addrFailed('The Census lookup didn’t answer.', 'down'); return; }
  S.ui.addrBusy = false;
  if (!r) { addrFailed('The Census lookup couldn’t find that address. Try adding the city and ZIP.', 'miss'); return; }
  const geo = r;
  if (door) {
    let idx: Index;
    try { idx = await ensureIndex(); } catch { addrFailed('We couldn’t reach the guide’s data. Check your connection.', 'down'); return; }
    const hit = settleAddress(idx, r);
    if (hit.kind === 'none') { S.ui.addrMsg = 'We couldn’t tell which place that is. Try your ZIP.'; renderAddr(); return; }
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
    if (await openBallot(hit.st, hit.ids, hit.zip, { door: true, after: () => applyGeo(geo) })) doorFocus();
    return;
  }
  if (choosing && S.zipChoice) {
    const idx = S.index!;
    const ids = S.zipChoice.placeIds;
    const hit = placeFromGeo(idx.places, ids, r);
    if (!hit) {
      const st = idx.places[ids[0]]?.state;
      S.ui.addrMsg = r.state && st && ids.every((id) => idx.places[id].state !== r.state)
        ? `That address is outside ${idx.states[st]?.name || st}. Check the ZIP, or pick a place below.`
        : 'That address didn’t match one of these places. Pick one, or “I’m not sure”.';
      renderAddr(); return;
    }
    const zip = S.zipChoice.zip;
    const asked = S.zipChoice;
    S.ui.addrOpen = false;
    if (await openBallot(idx.places[hit].state, [hit], zip, { door: true, after: () => applyGeo(geo) })) { S.picked = asked; render(['mast']); doorFocus(); }
    return;
  }
  if (!b) return;
  if (r.state && r.state !== b.st) { addrFailed(`That address is outside ${b.stateName}. Change your ZIP first.`, 'miss'); return; }
  if (b.places.length > 1) {
    const hit = placeFromGeo(S.index!.places, b.places.map((p) => p.id), r);
    if (hit) { await openBallot(b.st, [hit], S.b.zip, { noSetup: true, after: () => applyGeo(geo) }); return; }
  }
  applyGeo(r);
}
export function applyGeo(r: { cd: number | null; upper: number | null; lower: number | null; state?: string | null }): void {
  const b = S.ballot!;
  const num = (k: 'cd' | 'upper' | 'lower') => (b.st === 'DC' && k === 'upper' ? null : r[k]);
  let answered = 0;
  for (const g of b.groups) {
    if (!g.kind || num(g.kind) == null) continue;
    const hit = g.members.find((id) => contestDistrict(b.byId.get(id) as Contest).n === num(g.kind!));
    S.b.districts[g.key] = hit || 'none';
    answered++;
  }
  for (const id of b.mayApply) {
    const c = b.byId.get(id);
    if (!c || c.kind !== 'contest') continue;
    const d = contestDistrict(c);
    if (!d.kind || num(d.kind) == null) continue;
    S.b.notMine = S.b.notMine.filter((x) => x !== id);
    if (d.n !== num(d.kind)) S.b.notMine.push(id);
    answered++;
  }
  const parts = [r.cd != null ? `Congressional District ${r.cd}` : '', r.upper != null ? (b.st === 'DC' ? `Ward ${r.upper}` : `State Senate ${r.upper}`) : '', r.lower != null ? `State House ${r.lower}` : ''].filter(Boolean);
  S.b.addrNote = parts.length ? `Your districts: ${parts.join(', ')}. We didn’t save your address. Double-check with your sample ballot.` : null;
  S.ui.addrOpen = false;
  S.ui.addrMsg = null;
  S.ui.addrFail = '';
  render();
  persist();
  toast(answered ? `Filled in ${plural(answered, 'district')} from your address.`
    : b.groups.some((g) => !S.b.districts[g.key]) ? 'Found your address, but it doesn’t answer the district questions here. Use the finder links in each one.'
      : addressCount() > 0 ? 'Found your address. Check the rest with your sample ballot.' : 'Found your address. Nothing on this ballot depends on it.');
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
