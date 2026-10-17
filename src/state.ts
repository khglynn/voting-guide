/* App state, saved state and the save-my-picks link. */
import type { Index } from './types';
import type { Ballot } from './ballot';
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
  auto: Record<string, string>;      // contest id -> why it was auto-picked
  noAuto: string[];                  // contests the user un-did; never auto-pick again
  notes: Record<string, string>;
  districts: Record<string, string>; // group key -> contest id | "*" (not sure) | "none"
  notMine: string[];                 // "may apply" races the user said aren't on their ballot
  sources: string[] | null;          // null = the defaults
  planSeen: boolean;
  offerDismissed: string | null;
  addrNote: string | null;           // "Matched from your address" summary, no address kept
}
export const emptyBallotState = (zip = ''): BallotState => ({
  zip, picks: {}, auto: {}, noAuto: [], notes: {}, districts: {}, notMine: [], sources: null,
  planSeen: false, offerDismissed: null, addrNote: null,
});

export interface UI {
  open: Set<string>;          // generic disclosures
  expanded: Set<string>;      // decided races reopened with "Change"
  collapsed: Set<string>;     // collapsed ballot sections
  noteOpen: Set<string>;
  showAll: Set<string>;       // races where the user asked to see filtered-out candidates
  why: Record<string, string | null>;
  filterOpen: boolean;
  gridOpen: boolean;          // the side-by-side grid, inside the Filter shelf
  shelfFrom: string | null;   // data-fk to focus when the shelf closes
  addrOpen: boolean;
  addrBusy: boolean;
  addrMsg: string | null;
  saveOpen: boolean;
  copyFallback: string | null;
}

export interface Pending { kind: 'restore'; key: string; incoming: BallotState; summary: string }

export const S = {
  index: null as Index | null,
  view: 'start' as 'start' | 'loading' | 'ballot',
  zip: '',
  zipErr: '' as string,
  zipChoice: null as null | { zip: string; placeIds: string[] },
  coverage: null as null | { kind: 'not_covered'; state: string | null; zip: string },
  ballot: null as Ballot | null,
  b: emptyBallotState(),
  prefs: { parties: null, endorsedOnly: false, foldDecided: true, autoPick: false } as Prefs,
  ui: {
    open: new Set(), expanded: new Set(), collapsed: new Set(), noteOpen: new Set(), showAll: new Set(), why: {},
    filterOpen: false, gridOpen: false, shelfFrom: null, addrOpen: false, addrBusy: false, addrMsg: null, saveOpen: false, copyFallback: null,
  } as UI,
  pending: null as Pending | null,
  loadErr: null as string | null,
};

/* ---------- saved state (localStorage, per ballot) ---------- */
const KEY = 'vg2';
interface Saved { v: 1; last: { key: string; zip: string } | null; prefs: Prefs; ballots: Record<string, BallotState> }
const blank = (): Saved => ({ v: 1, last: null, prefs: S.prefs, ballots: {} });

export function readSaved(): Saved {
  const s = load<Saved>(KEY, blank());
  if (!s || s.v !== 1 || typeof s.ballots !== 'object') return blank();
  return s;
}
export function savedBallot(key: string): BallotState | null {
  const b = readSaved().ballots[key];
  return b ? { ...emptyBallotState(), ...b } : null;
}
let saveTimer: number | undefined;
export function persist(now = false): void {
  const run = () => {
    const s = readSaved();
    s.prefs = S.prefs;
    if (S.ballot) {
      s.ballots[S.ballot.key] = S.b;
      s.last = { key: S.ballot.key, zip: S.b.zip };
    }
    save(KEY, s);
  };
  window.clearTimeout(saveTimer);
  if (now) run(); else saveTimer = window.setTimeout(run, 250);
}
export function forgetLast(): void {
  const s = readSaved();
  s.last = null;
  save(KEY, s);
}

/* ---------- the save link ----------
   #v1~ST~place+place~zip~picks~districts~notes~sources
   Each pick is hash5(key) + Y|N|S|D|P, or hash5(key) + hash3(candidate name).
   Hashes keep the link short and survive data refreshes: a pick whose candidate can't be
   found is dropped and reported, never guessed. */
const CODE: Record<string, string> = { YES: 'Y', NO: 'N', SKIP: 'S', DONE: 'D', PICK: 'P' };
const UNCODE: Record<string, string> = { Y: 'YES', N: 'NO', S: 'SKIP', D: 'DONE', P: 'PICK' };

export function encodeShare(ballot: Ballot, b: BallotState): string {
  const picks = Object.entries(b.picks).map(([k, v]) => hash(k) + (CODE[v] || hash(v, 3))).join('.');
  const dist = Object.entries(b.districts).map(([g, v]) => hash(g) + (v === '*' ? '*' : v === 'none' ? '-' : hash(v))).join('.');
  const notes = Object.entries(b.notes).filter(([, t]) => t && t.trim()).map(([k, t]) => hash(k) + b64urlEncode(t.trim().slice(0, 500))).join('.');
  const src = b.sources ? (b.sources.length ? b.sources.map((e) => hash(e)).join('.') : '0') : '';
  const places = ballot.places.map((p) => p.id).join('+') || '-';
  return ['v1', ballot.st, places, b.zip || '-', picks, dist, notes, src].join('~');
}

export interface ShareHead { st: string; places: string[]; zip: string; raw: string[] }
export function parseShareHead(hashStr: string): ShareHead | null {
  const h = hashStr.replace(/^#/, '');
  if (!h.startsWith('v1~')) return null;
  const raw = h.split('~');
  if (raw.length < 4 || !/^[A-Z]{2}$/.test(raw[1])) return null;
  return { st: raw[1], places: raw[2] === '-' ? [] : raw[2].split('+').filter(Boolean), zip: raw[3] === '-' ? '' : raw[3], raw };
}

export function decodeShare(ballot: Ballot, head: ShareHead): { state: BallotState; dropped: number } {
  const st = emptyBallotState(head.zip);
  let dropped = 0;
  const [, , , , picks = '', dist = '', notes = '', src = ''] = head.raw;
  // Every key this ballot could hold, by hash. A collision makes both ambiguous; we drop them.
  const keyByHash = new Map<string, string | null>();
  const addKey = (k: string) => { const h = hash(k); keyByHash.set(h, keyByHash.has(h) && keyByHash.get(h) !== k ? null : k); };
  for (const it of ballot.items) {
    addKey(it.id);
    if (it.kind === 'contest' && (it.candidates.length > 1 && (it.is_retention || it.vote_for > 1))) it.candidates.forEach((c) => addKey(`${it.id}|${c.name}`));
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
  st.planSeen = true;
  return { state: st, dropped };
}
