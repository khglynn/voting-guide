/* A source you asked for, on your own ballot minutes after you ask (Oct 28; Kevin: "I'd love for it to just load
   with a banner saying when it's ready and then without losing any other work or steps they've started moving
   through and then show their source ... we can do further checks before it shows for everyone").
   - Add a source makes a code when it opens: 12 random lowercase letters, sent as "Request: <code>" under "Sent
     along:" (views/shelf.ts alongLines). The workbench's vg source names the request's site branch src-<code>
     and pushes it only after its judge, its script checks and a GPT security check pass, and the form script
     answers the request's status by the code (app.ts STATUS_URL).
   - This device keeps each request it sent in localStorage `vg-adds`: no picks, never in `vg2` or the save
     link, every read and write wrapped (util.load and save), dropped after three days. `reply` is only
     whether they asked for a reply, never how; `st` the last status word; `ids` the sources it became, once
     they are on this device's ballot; `quiet` once its banner was closed.
   - Once the status says ready, the branch's Vercel preview holds exactly what the merge will ship. The page
     reads the open ballot's bundles there and takes in only the sources the live bundles lack, each record
     and row checked here the way build-data checks its own (a preview hasn't merged yet). Everyone else gets
     the source at the merge, through CI and the review.
   Pure: no fetches, no DOM. app.ts does the reading and the swap. */
import type { Endorsement, Endorser, Item, Lean, PlaceBundle, StateBundle } from '../types';
import { load, save } from '../util';

export type AddState = 'reading' | 'checking' | 'ready' | 'live' | 'held' | 'blocked' | 'not_a_source' | 'failed';
export const ADD_STATES: AddState[] = ['reading', 'checking', 'ready', 'live', 'held', 'blocked', 'not_a_source', 'failed'];
export interface Add {
  code: string;
  name: string;      // what they typed in "Which source?" (a name or a link)
  at: number;        // when it was sent, ms since 1970
  reply?: true;      // they asked for a reply (only that they did, never the email or phone)
  st?: AddState;     // the last status word this device read
  ids?: string[];    // the source ids it became, once they are on this device's ballot
  quiet?: true;      // its banner was closed
}
/* What the form script says about a request (app.ts reads it): its stage, the source's name as the guide
   will show it, a note in plain words (why it isn't a source), and the source's id when it sends one. */
export interface AddStatus { state: AddState | null; name: string; note: string; id: string | null }

const KEY = 'vg-adds';
const MAX = 5;
export const KEEP_MS = 3 * 864e5;   // three days, like vg-asked
export const WATCH_MS = 30 * 60e3;  // the 20-second checks stop 30 minutes after the send
export const LONG_MS = 20 * 60e3;   // the banner says Kevin will follow up after 20 minutes
export const POLL_MS = 20e3;
const CODE = /^[a-z]{12}$/;
/* A source id, as main.ts reads ?on=. */
export const SOURCE_ID = /^[a-z0-9][a-z0-9-]{1,79}$/;
const DONE: AddState[] = ['blocked', 'not_a_source', 'failed'];
/* A request whose status is one of these is finished one way or another, and its banner says so. */
export const settled = (a: Pick<Add, 'st'>): boolean => !!a.st && DONE.includes(a.st);

/* 12 letters a to z, each from one random byte: bytes from 234 up are thrown back, so every letter is as likely
   as any other (234 is 9 times 26). */
export function newCode(rand: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  let out = '';
  while (out.length < 12) for (const x of rand(16)) if (x < 234 && out.length < 12) out += String.fromCharCode(97 + (x % 26));
  return out;
}

/* ---------- the store ---------- */
const clean = (raw: unknown, now: number): Add | null => {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.code !== 'string' || !CODE.test(a.code) || typeof a.at !== 'number' || !Number.isFinite(a.at)) return null;
  // Past three days, or more than a day ahead (a clock set wrong when it was sent), it's gone.
  if (now - a.at >= KEEP_MS || a.at - now > 864e5) return null;
  const out: Add = { code: a.code, name: typeof a.name === 'string' ? a.name.trim().slice(0, 500) : '', at: a.at };
  if (a.reply === true) out.reply = true;
  if (typeof a.st === 'string' && (ADD_STATES as string[]).includes(a.st)) out.st = a.st as AddState;
  if (Array.isArray(a.ids)) { const ids = a.ids.filter((x): x is string => typeof x === 'string' && SOURCE_ID.test(x)).slice(0, 3); if (ids.length) out.ids = ids; }
  if (a.quiet === true) out.quiet = true;
  return out;
};
/* Every request this device sent in the last three days, newest first. Anything else in the key reads as none.
   One past its three days is let go here, the first time it's read after. */
export function readAdds(now = Date.now()): Add[] {
  const raw: unknown = load<unknown>(KEY, []);
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const list = raw.map((x) => clean(x, now)).filter((a): a is Add => !!a && !seen.has(a.code) && !!seen.add(a.code)).sort((x, y) => y.at - x.at).slice(0, MAX);
  if (list.length !== raw.length) save(KEY, list);
  return list;
}
const write = (list: Add[]): boolean => save(KEY, list.slice(0, MAX));
/* Sent: remember it. False when the device can't keep it (storage blocked), so the page doesn't promise it. */
export function rememberAdd(code: string, name: string, reply: boolean, now = Date.now()): boolean {
  if (!CODE.test(code)) return false;
  const a: Add = { code, name: name.trim().slice(0, 500), at: now, ...(reply ? { reply: true as const } : {}) };
  if (!write([a, ...readAdds(now).filter((x) => x.code !== code)])) return false;
  return readAdds(now).some((x) => x.code === code);
}
export function updateAdd(code: string, patch: Partial<Pick<Add, 'st' | 'ids' | 'quiet'>>, now = Date.now()): void {
  const list = readAdds(now);
  const a = list.find((x) => x.code === code);
  if (!a) return;
  Object.assign(a, patch);
  if (!a.ids || !a.ids.length) delete a.ids;
  write(list);
}
export function forgetAdd(code: string, now = Date.now()): void {
  const list = readAdds(now);
  if (list.some((x) => x.code === code)) write(list.filter((x) => x.code !== code));
}
/* The source ids this device is holding for a request that isn't in the guide for everyone yet. setSources
   (model/lens.ts) keeps them in your list while the ballot doesn't have them, so a chip tapped before the
   preview answers after a reload can't take them out (the judge's "reload gap", Oct 28). */
export function heldIds(now = Date.now()): Set<string> {
  return new Set(readAdds(now).flatMap((a) => a.ids || []));
}

/* ---------- the status ---------- */
/* The form script's answer, read strictly: an unknown state is "still working" (null), the name and the note
   are short plain text, and an id only in the shape of a source id. Anything that isn't {ok: true, ...} is
   "nothing yet" (the request hasn't been read, or the code is unknown). */
export function readStatus(raw: unknown): AddStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.ok !== true) return null;
  const line = (v: unknown, n: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
  const state = typeof r.state === 'string' && (ADD_STATES as string[]).includes(r.state) ? r.state as AddState : null;
  const id = typeof r.id === 'string' && SOURCE_ID.test(r.id) ? r.id : null;
  return { state, name: line(r.name, 120), note: line(r.note, 200), id };
}

/* ---------- what a preview brings ---------- */
/* The sources a preview adds to one ballot: each record, and its rows by race. */
export interface Found { endorsers: Endorser[]; rows: Record<string, Record<string, Endorsement>> }
export const noneFound = (): Found => ({ endorsers: [], rows: {} });
const LEAN_OK: Lean[] = ['left', 'lean_left', 'neutral', 'lean_right', 'right'];
const TYPES = ['publication', 'civic_nonpartisan', 'party', 'advocacy', 'labor', 'business', 'elected_official', 'other'];
const str = (v: unknown, n: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const https = (v: unknown): string | null => {
  if (typeof v !== 'string' || v.length > 2000) return null;
  try { return new URL(v).protocol === 'https:' ? v : null; } catch { return null; }
};
/* One endorser record from a preview, rebuilt field by field from what build-data writes, so nothing else rides
   along. It starts off for everyone (default_on false), whatever the preview says: on this device it goes on
   because you asked for it (app.ts switchOnNow), and anywhere else only at the merge. */
export function cleanEndorser(raw: unknown, places: Set<string>): Endorser | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const id = typeof e.id === 'string' && SOURCE_ID.test(e.id) ? e.id : null;
  const name = str(e.name, 200);
  if (!id || !name) return null;
  const type = typeof e.type === 'string' && TYPES.includes(e.type) ? e.type : 'other';
  const lean = typeof e.lean === 'string' && (LEAN_OK as string[]).includes(e.lean) ? e.lean as Lean : null;
  const out: Endorser = {
    id, name, short: str(e.short, 80) || name, type, lean,
    lean_basis: str(e.lean_basis, 2000), lean_note: str(e.lean_note, 500), guide_url: https(e.guide_url),
    default_on: false, endorses_candidates: e.endorses_candidates === true, endorses_measures: e.endorses_measures === true,
    preview: true,
  };
  const party = (type === 'party' || type === 'elected_official') ? str(e.party, 60) : null;
  if (party) out.party = party;
  // A source with no lean carries no basis kind (the data's rule since Oct 28).
  if (lean && typeof e.lean_basis_kind === 'string' && ['outside_rating', 'party', 'mission'].includes(e.lean_basis_kind)) out.lean_basis_kind = e.lean_basis_kind as Endorser['lean_basis_kind'];
  if (e.paywall === true) {
    out.paywall = true;
    if (e.paywall_note_ok === false) out.paywall_note_ok = false;
    const n = str(e.paywall_note, 300); if (n) out.paywall_note = n;
  }
  if (e.blocked === true) { out.blocked = true; const n = str(e.blocked_note, 300); if (n) out.blocked_note = n; }
  if (Array.isArray(e.home_places)) {
    const h = [...new Set(e.home_places.filter((p): p is string => typeof p === 'string' && places.has(p)))].sort();
    if (h.length) out.home_places = h;
  }
  return out;
}
const STATUS = ['endorsed', 'no_position', 'not_found'];
const CONF = ['verified', 'sourced', 'unverified'];
/* One row from a preview, for a race or measure this ballot has. Its choices must be what build-data would have
   written for that item: a candidate's exact name in a race, YES or NO on a measure or a one-judge retention,
   none on a several-judge retention (its words stay in the note). Anything else drops the row. */
export function cleanRow(raw: unknown, it: Item): Endorsement | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.s !== 'string' || !STATUS.includes(r.s) || typeof r.conf !== 'string' || !CONF.includes(r.conf)) return null;
  let c: string[] | null = null;
  if (r.c != null) {
    if (r.s !== 'endorsed' || !Array.isArray(r.c) || !r.c.length || r.c.length > 12 || !r.c.every((x) => typeof x === 'string')) return null;
    const yn = it.kind === 'measure' || (it.is_retention && it.candidates.length <= 1);
    if (yn) { if (r.c.length !== 1 || !['YES', 'NO'].includes(r.c[0] as string)) return null; }
    else if (it.is_retention) return null;
    else if (!(r.c as string[]).every((n) => it.candidates.some((k) => k.name === n)) || new Set(r.c).size !== r.c.length) return null;
    c = [...r.c as string[]];
  }
  const date = typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : null;
  const out: Endorsement = { s: r.s as Endorsement['s'], c, note: str(r.note, 1000), why: str(r.why, 1000), url: https(r.url), date, conf: r.conf as Endorsement['conf'] };
  if (r.both === true && it.kind === 'measure' && r.s === 'endorsed') out.both = true;
  if (r.unreadable === true && r.s === 'not_found') out.unreadable = true;
  return out;
}

/* The sources one ballot's preview bundles hold that its live bundles don't, with their rows. `live`: every
   endorser id in the live bundles; `byId` and `order`: the live ballot's items and what it shows; `only`: the
   ids a request already became, so nothing else is taken on a later read. A source needs one row on this
   ballot to count. More than three new ones means the branch is old (sources since removed from the guide
   are still on it), so none is taken. A record or row that doesn't check out is left out, like build-data's
   skipped records. */
export function pickNew(bundles: (StateBundle | PlaceBundle)[], live: Set<string>, byId: Map<string, Item>, order: string[], places: Set<string>, only: string[] | null = null): Found {
  const shown = new Set(order);
  const recs = new Map<string, Endorser>();
  for (const b of bundles) {
    if (!b || !Array.isArray(b.endorsers)) continue;
    for (const raw of b.endorsers) {
      const id = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : null;
      if (typeof id !== 'string' || live.has(id) || recs.has(id) || (only && !only.includes(id))) continue;
      const e = cleanEndorser(raw, places);
      if (e) recs.set(id, e);
    }
  }
  const rows: Found['rows'] = {};
  for (const b of bundles) {
    if (!b || !b.endorsements || typeof b.endorsements !== 'object') continue;
    for (const [t, row] of Object.entries(b.endorsements)) {
      const it = byId.get(t);
      if (!it || !row || typeof row !== 'object') continue;
      for (const [eid, raw] of Object.entries(row)) {
        if (!recs.has(eid)) continue;
        const en = cleanRow(raw, it);
        if (en) (rows[t] = rows[t] || {})[eid] = en;
      }
    }
  }
  const keep = [...recs.values()].filter((e) => Object.entries(rows).some(([t, r]) => shown.has(t) && r[e.id]));
  if (keep.length > 3) return noneFound();
  const ids = new Set(keep.map((e) => e.id));
  for (const t of Object.keys(rows)) {
    for (const eid of Object.keys(rows[t])) if (!ids.has(eid)) delete rows[t][eid];
    if (!Object.keys(rows[t]).length) delete rows[t];
  }
  return { endorsers: keep, rows };
}
/* Two reads for one ballot, together (a second request beside the first). The later one wins a source both have. */
export function mergeFound(a: Found | null, b: Found | null): Found {
  const out = noneFound();
  for (const f of [a, b]) {
    if (!f) continue;
    for (const e of f.endorsers) { out.endorsers = out.endorsers.filter((x) => x.id !== e.id); out.endorsers.push(e); }
    for (const [t, r] of Object.entries(f.rows)) out.rows[t] = { ...(out.rows[t] || {}), ...r };
  }
  return out;
}
/* Found without the sources the live bundles now have (merged), or `drop` names. */
export function withoutIds(f: Found | null, drop: Set<string>): Found | null {
  if (!f) return null;
  const out = noneFound();
  out.endorsers = f.endorsers.filter((e) => !drop.has(e.id));
  const keep = new Set(out.endorsers.map((e) => e.id));
  for (const [t, r] of Object.entries(f.rows)) {
    const kept = Object.fromEntries(Object.entries(r).filter(([eid]) => keep.has(eid)));
    if (Object.keys(kept).length) out.rows[t] = kept;
  }
  return out.endorsers.length ? out : null;
}
/* A copy of the live state bundle with the found sources and their rows in it, for buildBallot, which merges
   every bundle's rows by race (a place race's row works from here too). The live bundle is left as it came. */
export function withFound(sb: StateBundle, f: Found | null): StateBundle {
  if (!f || !f.endorsers.length) return sb;
  const ends = { ...sb.endorsements };
  for (const [t, r] of Object.entries(f.rows)) ends[t] = { ...(ends[t] || {}), ...r };
  return { ...sb, endorsers: [...sb.endorsers, ...f.endorsers], endorsements: ends };
}
/* Every endorser id in a set of bundles. */
export const idsIn = (bundles: (StateBundle | PlaceBundle)[]): Set<string> => new Set(bundles.flatMap((b) => (b && Array.isArray(b.endorsers) ? b.endorsers.map((e) => e.id) : [])));

/* ---------- the banner ---------- */
/* The one request the banner speaks for: the newest one that's still waiting or finished without a source,
   whose banner wasn't closed. A request whose source is on this ballot already, or that is live, has none. */
export function bannerAdd(list: Add[]): Add | null {
  return list.find((a) => !a.quiet && !a.ids && a.st !== 'live') || null;
}
