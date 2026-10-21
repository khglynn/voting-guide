/* App state, saved state and the save-my-picks link. */
import type { Index } from './types';
import type { Ballot } from './ballot';
import type { ChipKey } from './model/lens';
import type { GeoResult } from './geo';
import { load, save, hash, b64urlEncode, b64urlDecode } from './util';

export interface Prefs {
  parties: string[] | null;   // null = every party shown
  endorsedOnly: boolean;
  foldDecided: boolean;
  autoPick: boolean;
}
export interface BallotState {
  zip: string;
  picks: Record<string, string>;     // contest/measure id (or "id|judge") -> name | YES | NO | SKIP | DONE | PICK
  ranks: Record<string, string[]>;   // ranked-choice contest id -> candidate names, 1st choice first
  auto: Record<string, string>;      // contest id -> why it was auto-picked
  noAuto: string[];                  // contests the user un-did; never auto-pick again
  notes: Record<string, string>;
  districts: Record<string, string>; // group key -> contest id | "*" (not sure) | "none"
  notMine: string[];                 // "may apply" races the user said aren't on their ballot, or an address took off
  sources: string[] | null;          // null = the defaults
  planSeen: boolean;
  offerDismissed: string | null;     // v2 only; kept so old saved state reads cleanly
  addrNote: string | null;           // what an address lookup set ("Set from your address: ..."), never the address
  party: string | null;              // the party chosen in "A party" (for its sources and its candidates in the fill)
  ticks: string[];                   // Help your friends vote: who you've texted
  setupDone: boolean;                // step 2 ("Pick by endorsements or party") finished on this device
  hideDecided: boolean;              // "Hide races I've decided", on this device; never in the save link
  mine: string[];                    // "may apply" races an address lookup put on your ballot; never in the save link
  secs: SectionsShown;               // the sections and court groups you folded, opened or showed decided rows in, on this device; never in the save link
  addrSet: string[];                 // what the last address lookup settled and the voter hasn't changed since: district questions (group keys), so the race says so, and the "may apply" races it moved (item ids), so a corrected address can undo them; never the address, never in the save link
}
/* What you did to the ballot's sections, kept with it so a reload looks the way you left it (Kevin,
   Oct 20): the UI's folded, unfolded and reveal sets. */
export interface SectionsShown { folded: string[]; unfolded: string[]; reveal: string[] }
export const noSections = (): SectionsShown => ({ folded: [], unfolded: [], reveal: [] });
export const emptyBallotState = (zip = ''): BallotState => ({
  zip, picks: {}, ranks: {}, auto: {}, noAuto: [], notes: {}, districts: {}, notMine: [], sources: null,
  planSeen: false, offerDismissed: null, addrNote: null, party: null, ticks: [], setupDone: false, hideDecided: false, mine: [],
  secs: noSections(), addrSet: [],
});

/* View state for the ledger. Nothing here is saved, except the section sets, which persist() copies to
   S.b.secs and resetUI reads back when a ballot opens. */
export type View = 'ballot' | 'cheat' | 'pass';
export interface UI {
  view: View;
  addrFilled: string | null;  // after a lookup on a filled ballot, what the fill did with the races it added ("Filled both from your sources."), for this visit
  lensEmptied: boolean;       // you turned your last chip or party off by hand, not "Show endorsements": the chips stay so you can choose again
  open: Set<string>;          // generic disclosures ("More", what-ifs, lean basis)
  row: string | null;         // the one open row: an item id or "q:<group key>"
  page: Record<string, number>; // candidate pager per race (3 per page)
  others: Set<string>;        // rows showing sources outside your lens
  folded: Set<string>;        // sections or court groups the voter folded
  unfolded: Set<string>;      // decided sections and long groups the voter opened
  reveal: Set<string>;        // sections whose decided rows show under "Hide races I've decided" (their count, tapped)
  keep: string | null;        // the row just decided ("Next up" goes on from it)
  beat: string | null;        // under "Hide races I've decided", the row just decided, showing its pick for a beat before it folds away
  noteOpen: Set<string>;
  reader: string | null;      // the "Full details" sheet, by item id
  sheet: null | 'sources' | 'party' | 'whatif' | 'picks' | 'toc' | 'report';  // picks: the ballot's Edit sheet; toc: the menu; report: Report a problem or Request a city
  report: Report | null;      // that sheet's fields while it is open (views/report.ts), in memory only
  sheetFrom: string | null;   // data-fk to focus when a sheet closes
  sheetBack: string | null;   // all sources or a party, opened from the Edit sheet: its sheetFrom, kept to go back to it
  addrOpen: boolean;
  addrBusy: boolean;
  addrMsg: string | null;
  addrFail: '' | 'down' | 'miss'; // the lookup didn't answer (Try again) or matched nothing usable
  addrFound: string | null;   // the address the Census matched, tidied, shown back until a reload or another ballot ("Found: ...")
  addrWhich: GeoResult[] | null; // the Census matched several addresses: "Which one is yours?"
  addrMaps: string[];         // after a lookup, what the district maps said beyond the races they set, for this visit only: the voting precinct, a line they didn't guess at, a map that didn't load
  addrMapsPending: boolean;   // the lookup's district maps are still on their way (the Census's answers are in)
  saveOpen: boolean;
  copyFallback: string | null;
  bulk: string | null;        // how many races the last fill from your sources filled, while its Undo is live
  bulkWhy: string | null;     // what that fill drew on, for the head's line (" from your sources")
  setupFill: boolean;         // "Fill in my ballot with their picks" in the Edit sheet
  setupOnly: boolean;         // "Hide races I've decided" in the Edit sheet, applied when it closes (to S.b.hideDecided)
  resume: boolean;            // "Welcome back" above the plan: once per visit to a started ballot, until any tap
}

/* "Report a problem" or "Request a city" while its sheet is open: what you typed, kept here only so a
   repaint can't lose it, and dropped when the sheet closes. Never saved, never in the save link. */
export interface Report {
  kind: 'report' | 'city';
  f: Record<string, string>;  // the fields by name: wrong, what, where, link, reach (a report); city, zip, reach (a city)
  what0: string;              // "Which race or measure?" as it was prefilled
  tag: string;                // the item or source id the sheet was opened from, sent after the race while it still reads as prefilled
  hint: string;               // 'paywall': opened from a paywalled source's "Send it to us"
  state: 'edit' | 'sending' | 'sent' | 'failed' | 'unsure'; // failed: the request was refused outright; unsure: no answer in time, so it may or may not have gone
  err: boolean;               // Send was tapped with the one required field empty
  fk: string;                 // the control that opened it, focused again when it closes
  back: { sheet: UI['sheet']; from: string | null; back: string | null } | null; // the sheet it was opened over, to go back to
}

/* restore: this device has other picks for the ballot, so ask which to keep. shared: a link
   brought picks to a device that had none here, which is often a friend's link, so say so
   instead of quietly calling them "your" picks. */
export interface Pending { kind: 'restore' | 'shared'; key: string; incoming: BallotState; summary: string }

/* The first page's step 2 as chosen so far: the chips, a party, and the two switches. In memory
   only. Before a ZIP they are all there is; once a ballot this device has nothing for loads, they
   become its sources and party (app.ts applyDoor), and the switches apply on "Show my ballot". */
export interface Door { chips: Record<ChipKey, boolean>; party: string | null; fill: boolean; only: boolean; fillSet?: boolean }

export const S = {
  index: null as Index | null,
  /* The first page shows for start, loading and setup. setup: a ballot is loaded for the first page's
     place line and counts, not shown, and nothing is saved until "Show my ballot". */
  view: 'start' as 'start' | 'loading' | 'setup' | 'ballot',
  zip: '',
  zipErr: '' as string,
  zipChoice: null as null | { zip: string; placeIds: string[] },
  /* The place question just answered (its ZIP and places), so the place line's Change can ask again. */
  picked: null as null | { zip: string; placeIds: string[] },
  door: { chips: { papers: true, progressive: false, conservative: false }, party: null, fill: true, only: false } as Door,
  coverage: null as null | { kind: 'not_covered'; state: string | null; zip: string },
  ballot: null as Ballot | null,
  b: emptyBallotState(),
  prefs: { parties: null, endorsedOnly: false, foldDecided: true, autoPick: false } as Prefs,
  ui: {
    view: 'ballot', open: new Set(), row: null, page: {}, others: new Set(), folded: new Set(), unfolded: new Set(), reveal: new Set(), keep: null, beat: null,
    noteOpen: new Set(), reader: null, sheet: null, report: null, sheetFrom: null, sheetBack: null, addrOpen: false, addrBusy: false, addrMsg: null, addrFail: '', addrFound: null, addrWhich: null, addrMaps: [], addrMapsPending: false, saveOpen: false, copyFallback: null, bulk: null, bulkWhy: null, addrFilled: null, lensEmptied: false,
    setupFill: false, setupOnly: false, resume: false,
  } as UI,
  /* ?try=fresh|aunt|straight|sources: a scenario on whatever ballot opens, never saved. */
  tryMode: null as string | null,
  pending: null as Pending | null,
  loadErr: null as string | null,
  /* What "Try again" under a load error does: the same ZIP, ballot or first visit again. */
  retry: null as null | (() => void),
  /* The ballot you left for the first page (Back or Change), while it has picks: the first page says
     it's saved and opens it again in one tap. */
  doorSaved: null as null | { key: string; zip: string; n: number },
};

/* ---------- saved state (localStorage, per ballot) ---------- */
const KEY = 'vg2';
/* last: the ballot this device opened last, which boot opens again; left: you went back to the first
   page from it, so boot shows the first page instead, with a way back to it. */
interface Saved { v: 1; last: { key: string; zip: string; left?: true } | null; prefs: Prefs; ballots: Record<string, BallotState> }
const blank = (): Saved => ({ v: 1, last: null, prefs: S.prefs, ballots: {} });

export function readSaved(): Saved {
  const s = load<Saved>(KEY, blank());
  if (!s || s.v !== 1 || typeof s.ballots !== 'object') return blank();
  return s;
}
export function savedBallot(key: string): BallotState | null {
  const b = readSaved().ballots[key];
  return b ? { ...emptyBallotState(), ...b, ranks: { ...(b.ranks || {}) }, secs: { ...noSections(), ...(b.secs || {}) } } : null;
}
let saveTimer: number | undefined;
let savePending = false;
export function persist(now = false): void {
  if (S.tryMode) return; // a "try as" scenario never touches the real saved picks
  // The first page saves nothing: someone who leaves before "Show my ballot" finds it again.
  const run = () => {
    if (S.view !== 'ballot') return;
    const s = readSaved();
    s.prefs = S.prefs;
    if (S.ballot) {
      S.b.secs = { folded: [...S.ui.folded], unfolded: [...S.ui.unfolded], reveal: [...S.ui.reveal] };
      s.ballots[S.ballot.key] = S.b;
      s.last = { key: S.ballot.key, zip: S.b.zip };
    }
    save(KEY, s);
  };
  window.clearTimeout(saveTimer);
  savePending = !now;
  if (now) run(); else saveTimer = window.setTimeout(() => { savePending = false; run(); }, 250);
}
/* A save still waiting when the page goes away (a reload, a closed tab, a phone switching apps) is
   written right then, so a section folded or a pick made just before isn't lost. */
if (typeof window !== 'undefined') {
  const flush = () => { if (savePending) persist(true); };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
}
/* Back or Change on a ballot: boot shows the first page next time, but the ballot stays remembered,
   so the first page can offer it (UX walk, Oct 20: forgetting it made saved picks look gone). */
export function leaveLast(): void {
  if (S.tryMode) return;
  const s = readSaved();
  if (!s.last || s.last.left) return; // nothing to mark, so nothing to write
  s.last = { ...s.last, left: true };
  save(KEY, s);
}
/* The ballot to offer on the first page: the one you left, while it has picks. */
export function leftBallot(count?: number): { key: string; zip: string; n: number } | null {
  if (S.tryMode) return null;
  const s = readSaved();
  if (!s.last || !s.last.left) return null;
  const b = s.ballots[s.last.key];
  // Without the ballot loaded (a reload), races with a choice or a ranking saved, less the ones you
  // hid; app.ts recounts by the bar's rule once the ballot loads, and passes that count when it has it.
  if (!b) return null;
  const ranked = Object.keys(b.ranks || {}).filter((k) => (b.ranks[k] || []).length);
  const noted = Object.values(b.notes || {}).some((t) => !!t && !!String(t).trim());
  if (!Object.keys(b.picks || {}).length && !ranked.length && !noted) return null; // nothing saved to point to
  const hid = new Set(b.notMine || []);
  const ids = [...Object.keys(b.picks || {}), ...ranked].map((k) => k.split('|')[0]).filter((id) => !hid.has(id));
  return { key: s.last.key, zip: s.last.zip, n: count ?? new Set(ids).size };
}

/* ---------- the save link ----------
   v1: #v1~ST~place+place~zip~picks~districts~notes~sources
   v2: the same plus ~ranks, written only when the ballot holds a ranked-choice ranking, so a
       ballot with no rankings still gets a v1 link, byte for byte what older versions wrote.
   Since Oct 19 (ledger): a 10th field, ~notMine, the "May apply" races the voter said aren't
       on their ballot (hash5 of each id), written only when there are some. The head stays v1
       or v2 as above (an empty ranks field fills slot 9). Older clients read fields by
       position and ignore extras, so these links still open there, minus that one answer.
   Each pick is hash5(key) + Y|N|S|D|P, or hash5(key) + hash3(candidate name).
   Each ranking is hash5(contest id) + hash3(1st choice) + hash3(2nd choice) + ...; hashes are
   lower-case base36, so the fixed widths parse without separators.
   Hashes keep the link short and survive data refreshes: a pick whose candidate can't be
   found is dropped and reported, never guessed. */
const CODE: Record<string, string> = { YES: 'Y', NO: 'N', SKIP: 'S', DONE: 'D', PICK: 'P' };
const UNCODE: Record<string, string> = { Y: 'YES', N: 'NO', S: 'SKIP', D: 'DONE', P: 'PICK' };

export function encodeShare(ballot: Ballot, b: BallotState): string {
  const picks = Object.entries(b.picks).map(([k, v]) => hash(k) + (CODE[v] || hash(v, 3))).join('.');
  const dist = Object.entries(b.districts).map(([g, v]) => hash(g) + (v === '*' ? '*' : v === 'none' ? '-' : hash(v))).join('.');
  const notes = Object.entries(b.notes).filter(([, t]) => t && t.trim()).map(([k, t]) => hash(k) + b64urlEncode(t.trim().slice(0, 500))).join('.');
  const src = b.sources ? (b.sources.length ? b.sources.map((e) => hash(e)).join('.') : '0') : '';
  const ranks = Object.entries(b.ranks || {}).filter(([k, l]) => ballot.byId.has(k) && l && l.length)
    .map(([k, l]) => hash(k) + l.map((n) => hash(n, 3)).join('')).join('.');
  const notMine = (b.notMine || []).filter((id) => ballot.byId.has(id)).map((id) => hash(id)).join('.');
  const places = ballot.places.map((p) => p.id).join('+') || '-';
  const fields = [ranks ? 'v2' : 'v1', ballot.st, places, b.zip || '-', picks, dist, notes, src];
  if (ranks || notMine) fields.push(ranks);
  if (notMine) fields.push(notMine);
  return fields.join('~');
}

export interface ShareHead { v: number; st: string; places: string[]; zip: string; raw: string[] }
export function parseShareHead(hashStr: string): ShareHead | null {
  const h = hashStr.replace(/^#/, '');
  const m = h.match(/^v([12])~/);
  if (!m) return null;
  const raw = h.split('~');
  if (raw.length < 4 || !/^[A-Z]{2}$/.test(raw[1])) return null;
  return { v: +m[1], st: raw[1], places: raw[2] === '-' ? [] : raw[2].split('+').filter(Boolean), zip: raw[3] === '-' ? '' : raw[3], raw };
}

export function decodeShare(ballot: Ballot, head: ShareHead): { state: BallotState; dropped: number } {
  const st = emptyBallotState(head.zip);
  let dropped = 0;
  const [, , , , picks = '', dist = '', notes = '', src = '', ranks = '', notMine = ''] = head.raw;
  // Every key this ballot could hold, by hash. A collision makes both ambiguous; we drop them.
  const keyByHash = new Map<string, string | null>();
  const addKey = (k: string) => { const h = hash(k); keyByHash.set(h, keyByHash.has(h) && keyByHash.get(h) !== k ? null : k); };
  for (const it of ballot.items) {
    addKey(it.id);
    // Per-candidate keys for judges and "mark up to N" seats. Ranked races keep their ranking
    // in its own field, so an old link's seat marks on a now-ranked race drop and get reported.
    if (it.kind === 'contest' && it.candidates.length > 1 && (it.is_retention || (it.vote_for > 1 && !it.ranked_choice))) it.candidates.forEach((c) => addKey(`${it.id}|${c.name}`));
  }
  for (const e of picks.split('.').filter(Boolean)) {
    const key = keyByHash.get(e.slice(0, 5));
    const v = e.slice(5);
    if (!key) { dropped++; continue; }
    if (v.length === 1 && UNCODE[v]) { st.picks[key] = UNCODE[v]; continue; }
    const it = ballot.byId.get(key);
    const cand = it && it.kind === 'contest' ? it.candidates.find((c) => hash(c.name, 3) === v) : null;
    if (cand) st.picks[key] = cand.name; else dropped++;
  }
  const groupByHash = new Map(ballot.groups.map((g) => [hash(g.key), g]));
  for (const e of dist.split('.').filter(Boolean)) {
    const g = groupByHash.get(e.slice(0, 5));
    const v = e.slice(5);
    if (!g) continue;
    if (v === '*') st.districts[g.key] = '*';
    else if (v === '-') st.districts[g.key] = 'none';
    else { const m = g.members.find((id) => hash(id) === v); if (m) st.districts[g.key] = m; }
  }
  for (const e of notes.split('.').filter(Boolean)) {
    const key = keyByHash.get(e.slice(0, 5));
    if (!key) continue;
    try { st.notes[key] = b64urlDecode(e.slice(5)); } catch { /* skip a broken note */ }
  }
  if (src === '0') st.sources = [];
  else if (src) {
    const eByHash = new Map(ballot.endorsers.map((e) => [hash(e.id), e.id]));
    st.sources = src.split('.').map((h) => eByHash.get(h)).filter((x): x is string => !!x);
  }
  if (head.v >= 2) {
    for (const e of ranks.split('.').filter(Boolean)) {
      const key = keyByHash.get(e.slice(0, 5));
      const it = key ? ballot.byId.get(key) : null;
      if (!key || !it || it.kind !== 'contest' || !it.ranked_choice) { dropped++; continue; }
      const max = Math.min(it.rank_up_to || it.candidates.length, it.candidates.length);
      const list: string[] = [];
      for (let i = 5; i + 3 <= e.length; i += 3) {
        const hits = it.candidates.filter((c) => hash(c.name, 3) === e.slice(i, i + 3));
        // A candidate who left the race, or two names sharing a hash, drops out; the rest keep their order.
        if (hits.length === 1 && !list.includes(hits[0].name) && list.length < max) list.push(hits[0].name); else dropped++;
      }
      if (list.length) st.ranks[key] = list;
    }
  }
  if (notMine) {
    // "May apply" races, and the few school-district races an address can take off (model/address.ts);
    // a "may apply" race wins a shared hash, as before.
    const mayByHash = new Map([...ballot.items.filter((it) => !ballot.mayApply.has(it.id)).map((it) => it.id), ...ballot.mayApply].map((id) => [hash(id), id]));
    st.notMine = notMine.split('.').map((h) => mayByHash.get(h)).filter((x): x is string => !!x);
  }
  st.planSeen = true;
  return { state: st, dropped };
}

/* Bring a saved or linked ballot in line with today's data on ranked-choice races.
   - A pick-one choice on a race that is now ranked becomes the 1st choice (that's what it
     was), and the race stays decided.
   - "Mark up to N" seat marks on a race that is now ranked can't be turned into an order
     without guessing, so they're cleared and the race reopens. The count comes back so the
     page can say so.
   - Rankings for candidates no longer listed, or past the ballot's limit, drop out. */
export function normalizeRanks(ballot: Ballot, b: BallotState): number {
  let cleared = 0;
  if (!b.ranks) b.ranks = {};
  for (const it of ballot.items) {
    if (it.kind !== 'contest') continue;
    const rcv = it.ranked_choice && !it.is_retention;
    if (!rcv) { delete b.ranks[it.id]; continue; }
    const names = new Set(it.candidates.map((c) => c.name));
    const seat = it.candidates.filter((c) => b.picks[`${it.id}|${c.name}`]);
    if (seat.length) { seat.forEach((c) => { delete b.picks[`${it.id}|${c.name}`]; }); cleared++; }
    const v = b.picks[it.id];
    if (v && names.has(v)) {
      if (!b.ranks[it.id] || !b.ranks[it.id].length) b.ranks[it.id] = [v];
      b.picks[it.id] = 'DONE';
      delete b.auto[it.id];
    }
    const max = Math.min(it.rank_up_to || it.candidates.length, it.candidates.length);
    const list = (b.ranks[it.id] || []).filter((n, i, a) => names.has(n) && a.indexOf(n) === i).slice(0, max);
    if (list.length) b.ranks[it.id] = list;
    else { delete b.ranks[it.id]; if (b.picks[it.id] === 'DONE') delete b.picks[it.id]; }
  }
  return cleared;
}
