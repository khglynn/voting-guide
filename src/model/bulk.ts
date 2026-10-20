/* The one-tap fills, each with an Undo for the whole batch:
   - "Use their picks where they agree": undecided rows where every chosen source that weighed in
     made the same pick. Never ranked-choice races (a pick is not a ranking), never a multi-seat
     race unless the sources name the same full set, never anything already decided.
   - "Fill in my party": partisan races by the ballot's normalized `parties` labels (never the
     display text). Skips races where the party has two candidates (top-two) and ranked races.
   - "Keep every judge the review favors": from the judges module.
   Filled picks are marked in S.b.auto so the row can say where the pick came from.
   A multi-seat race you've started picking is never filled (adding a source's full set to
   your own picks would vote for too many), and every fill is checked against the seat count
   before it lands. Undo puts back only what the batch changed, so a pick you make while the
   Undo toast is up survives it. */
import type { Item } from '../types';
import { S } from '../state';
import { entriesBySection, status, isRCV, isMultiSeat, isMultiJudge, isPartisan, isMaybe } from '../ballot';
import { lineup, weighedIn, FILL_SOURCES } from './tally';
import { judgeBatch } from './judges';

export interface Fill { id: string; set: Record<string, string>; single: boolean; why: string }
export interface Plan { fills: Fill[]; single: number; skippedTwo: number; skippedRanked: number; skippedPartial: number }
export const emptyPlan = (): Plan => ({ fills: [], single: 0, skippedTwo: 0, skippedRanked: 0, skippedPartial: 0 });

/* Seats already marked in a multi-seat race. */
const pickedIn = (it: Item, picks: Record<string, string> = S.b.picks): number =>
  it.kind === 'contest' ? it.candidates.filter((c) => picks[`${it.id}|${c.name}`] === 'PICK').length : 0;

/* Open rows the fills may touch: never one tagged "Maybe on your ballot" (another district's race,
   or every district of a question answered "Not sure"), since that race may not be the voter's. */
function visibleOpen(): Item[] {
  const b = S.ballot!;
  const out: Item[] = [];
  for (const [, entries] of entriesBySection()) {
    for (const e of entries) {
      if (e.t !== 'item' || isMaybe(e.id)) continue;
      const it = b.byId.get(e.id)!;
      if (status(it) === 'open') out.push(it);
    }
  }
  return out;
}

export function planAgree(): Plan {
  const fills: Fill[] = [];
  let skippedPartial = 0;
  for (const it of visibleOpen()) {
    if (it.kind === 'contest' && (isRCV(it) || isMultiJudge(it))) continue;
    const l = lineup(it);
    const w = weighedIn(l);
    if (!w.length || l.groups.length !== 1 || l.both.length) continue;
    const g = l.groups[0];
    if (!g.choices.length) continue;
    const why = `${FILL_SOURCES}${w.map((e) => e.short).join(', ')}`;
    if (it.kind === 'measure' || it.is_retention) {
      if (g.choices.length !== 1 || !['YES', 'NO'].includes(g.choices[0])) continue;
      fills.push({ id: it.id, set: { [it.id]: g.choices[0] }, single: w.length === 1, why });
      continue;
    }
    const names = g.choices.filter((n) => it.candidates.some((c) => c.name === n));
    if (names.length !== g.choices.length) continue;
    if (isMultiSeat(it)) {
      if (names.length !== it.vote_for) continue;
      if (pickedIn(it)) { skippedPartial++; continue; }
      fills.push({ id: it.id, set: Object.fromEntries(names.map((n) => [`${it.id}|${n}`, 'PICK'])), single: w.length === 1, why });
      continue;
    }
    if (names.length !== 1) continue;
    fills.push({ id: it.id, set: { [it.id]: names[0] }, single: w.length === 1, why });
  }
  return { fills, single: fills.filter((f) => f.single).length, skippedTwo: 0, skippedRanked: 0, skippedPartial };
}

export function planParty(party: string): Plan {
  const fills: Fill[] = [];
  let skippedTwo = 0, skippedRanked = 0, skippedPartial = 0;
  for (const it of visibleOpen()) {
    if (it.kind !== 'contest' || it.is_retention || !isPartisan(it)) continue;
    const mine = it.candidates.filter((c) => c.parties.includes(party));
    if (!mine.length) continue;
    if (isRCV(it)) { skippedRanked++; continue; }
    const why = `Filled in with the ${party} candidate`;
    if (isMultiSeat(it)) {
      if (mine.length > it.vote_for) { skippedTwo++; continue; }
      if (pickedIn(it)) { skippedPartial++; continue; }
      const set: Record<string, string> = Object.fromEntries(mine.map((c) => [`${it.id}|${c.name}`, 'PICK']));
      if (mine.length < it.vote_for) set[it.id] = 'DONE';
      fills.push({ id: it.id, set, single: false, why });
      continue;
    }
    if (mine.length > 1) { skippedTwo++; continue; }
    fills.push({ id: it.id, set: { [it.id]: mine[0].name }, single: false, why });
  }
  return { fills, single: 0, skippedTwo, skippedRanked, skippedPartial };
}

/* Step 2's "Fill in their picks": the party's candidates first (when a party is chosen), then
   where your sources agree in the races the party left open, as one batch for one Undo. Plan it
   after the party is set: the agree lineup includes the party's own sources. */
export function planSetup(party: string | null): { party: Plan | null; agree: Plan; fills: Fill[] } {
  const p = party ? planParty(party) : null;
  const a = planAgree();
  const taken = new Set(p ? p.fills.map((f) => f.id) : []);
  const rest = a.fills.filter((f) => !taken.has(f.id));
  return { party: p, agree: { ...a, fills: rest, single: rest.filter((f) => f.single).length }, fills: [...(p ? p.fills : []), ...rest] };
}

export function planJudges(): Plan {
  const jb = judgeBatch();
  if (!jb) return emptyPlan();
  const by = new Map<string, Fill>();
  for (const t of jb.targets) {
    const f = by.get(t.id) || { id: t.id, set: {}, single: false, why: 'Filled in from the judges’ review' };
    f.set[t.key] = 'YES';
    by.set(t.id, f);
  }
  return { ...emptyPlan(), fills: [...by.values()] };
}

/* A fill fits when, after it lands, a multi-seat race has no more picks than seats. */
export function fillFits(f: Fill): boolean {
  const it = S.ballot?.byId.get(f.id);
  if (!it || it.kind !== 'contest' || !isMultiSeat(it)) return true;
  return pickedIn(it, { ...S.b.picks, ...f.set }) <= it.vote_for;
}

/* ---------- apply and undo ----------
   The batch remembers, key by key, what it replaced and what it wrote. Undo restores a key
   only while it still holds what the batch wrote. Fills never touch rankings. */
type Was = string | undefined;
interface Batch { picks: Map<string, [Was, string]>; auto: Map<string, [Was, string]> }
let last: Batch | null = null;
export function applyFills(fills: Fill[]): number {
  const batch: Batch = { picks: new Map(), auto: new Map() };
  let n = 0;
  for (const f of fills) {
    if (!fillFits(f)) continue;
    for (const [k, v] of Object.entries(f.set)) {
      if (!batch.picks.has(k)) batch.picks.set(k, [S.b.picks[k], v]); else batch.picks.get(k)![1] = v;
      S.b.picks[k] = v;
    }
    if (!batch.auto.has(f.id)) batch.auto.set(f.id, [S.b.auto[f.id], f.why]); else batch.auto.get(f.id)![1] = f.why;
    S.b.auto[f.id] = f.why;
    n++;
  }
  last = n ? batch : null;
  return n;
}
export function undoFills(): boolean {
  if (!last) return false;
  const put = (o: Record<string, string>, k: string, was: Was) => { if (was === undefined) delete o[k]; else o[k] = was; };
  for (const [k, [was, wrote]] of last.picks) if (S.b.picks[k] === wrote) put(S.b.picks, k, was);
  for (const [k, [was, wrote]] of last.auto) if (S.b.auto[k] === wrote) put(S.b.auto, k, was);
  last = null;
  return true;
}
export const forgetUndo = (): void => { last = null; };
/* A hand edit to a row takes that row out of the pending Undo, even when you set the same value
   the batch did: Undo only ever takes back what the batch did on its own. */
export function touchUndo(id: string): void {
  if (!last) return;
  for (const k of [...last.picks.keys()]) if (k === id || k.startsWith(`${id}|`)) last.picks.delete(k);
  last.auto.delete(id);
}
