/* The one-tap fills, each with an Undo for the whole batch:
   - "Use their picks where they agree": undecided rows where every chosen source that weighed in
     made the same pick. Never ranked-choice races (a pick is not a ranking), never a multi-seat
     race unless the sources name the same full set, never anything already decided.
   - "Fill in my party": partisan races by the ballot's normalized `parties` labels (never the
     display text). Skips races where the party has two candidates (top-two) and ranked races.
   - "Keep every judge the review favors": from the judges module.
   Filled picks are marked in S.b.auto so the row can say where the pick came from. */
import type { Item } from '../types';
import { S } from '../state';
import { entriesBySection, status, isRCV, isMultiSeat, isMultiJudge, isPartisan } from '../ballot';
import { lineup, weighedIn } from './tally';
import { judgeBatch } from './judges';

export interface Fill { id: string; set: Record<string, string>; single: boolean; why: string }
export interface Plan { fills: Fill[]; single: number; skippedTwo: number; skippedRanked: number }

function visibleOpen(): Item[] {
  const b = S.ballot!;
  const out: Item[] = [];
  for (const [, entries] of entriesBySection()) {
    for (const e of entries) {
      if (e.t !== 'item') continue;
      const it = b.byId.get(e.id)!;
      if (status(it) === 'open') out.push(it);
    }
  }
  return out;
}

export function planAgree(): Plan {
  const fills: Fill[] = [];
  for (const it of visibleOpen()) {
    if (it.kind === 'contest' && (isRCV(it) || isMultiJudge(it))) continue;
    const l = lineup(it);
    const w = weighedIn(l);
    if (!w.length || l.groups.length !== 1 || l.both.length) continue;
    const g = l.groups[0];
    if (!g.choices.length) continue;
    const why = `Filled from your sources: ${w.map((e) => e.short).join(', ')}`;
    if (it.kind === 'measure' || it.is_retention) {
      if (g.choices.length !== 1 || !['YES', 'NO'].includes(g.choices[0])) continue;
      fills.push({ id: it.id, set: { [it.id]: g.choices[0] }, single: w.length === 1, why });
      continue;
    }
    const names = g.choices.filter((n) => it.candidates.some((c) => c.name === n));
    if (names.length !== g.choices.length) continue;
    if (isMultiSeat(it)) {
      if (names.length !== it.vote_for) continue;
      fills.push({ id: it.id, set: Object.fromEntries(names.map((n) => [`${it.id}|${n}`, 'PICK'])), single: w.length === 1, why });
      continue;
    }
    if (names.length !== 1) continue;
    fills.push({ id: it.id, set: { [it.id]: names[0] }, single: w.length === 1, why });
  }
  return { fills, single: fills.filter((f) => f.single).length, skippedTwo: 0, skippedRanked: 0 };
}

export function planParty(party: string): Plan {
  const fills: Fill[] = [];
  let skippedTwo = 0, skippedRanked = 0;
  for (const it of visibleOpen()) {
    if (it.kind !== 'contest' || it.is_retention || !isPartisan(it)) continue;
    const mine = it.candidates.filter((c) => c.parties.includes(party));
    if (!mine.length) continue;
    if (isRCV(it)) { skippedRanked++; continue; }
    const why = `Filled: the ${party} candidate on the ballot`;
    if (isMultiSeat(it)) {
      if (mine.length > it.vote_for) { skippedTwo++; continue; }
      const set: Record<string, string> = Object.fromEntries(mine.map((c) => [`${it.id}|${c.name}`, 'PICK']));
      if (mine.length < it.vote_for) set[it.id] = 'DONE';
      fills.push({ id: it.id, set, single: false, why });
      continue;
    }
    if (mine.length > 1) { skippedTwo++; continue; }
    fills.push({ id: it.id, set: { [it.id]: mine[0].name }, single: false, why });
  }
  return { fills, single: 0, skippedTwo, skippedRanked };
}

export function planJudges(): Plan {
  const jb = judgeBatch();
  if (!jb) return { fills: [], single: 0, skippedTwo: 0, skippedRanked: 0 };
  const by = new Map<string, Fill>();
  for (const t of jb.targets) {
    const f = by.get(t.id) || { id: t.id, set: {}, single: false, why: 'Filled: the judges’ review' };
    f.set[t.key] = 'YES';
    by.set(t.id, f);
  }
  return { fills: [...by.values()], single: 0, skippedTwo: 0, skippedRanked: 0 };
}

/* ---------- apply and undo ---------- */
interface Snapshot { picks: Record<string, string>; auto: Record<string, string>; ranks: Record<string, string[]> }
let last: Snapshot | null = null;
export function applyFills(fills: Fill[]): number {
  last = { picks: { ...S.b.picks }, auto: { ...S.b.auto }, ranks: JSON.parse(JSON.stringify(S.b.ranks || {})) };
  for (const f of fills) {
    Object.assign(S.b.picks, f.set);
    S.b.auto[f.id] = f.why;
  }
  return fills.length;
}
export function undoFills(): boolean {
  if (!last) return false;
  S.b.picks = last.picks; S.b.auto = last.auto; S.b.ranks = last.ranks;
  last = null;
  return true;
}
export const canUndo = (): boolean => !!last;
export const forgetUndo = (): void => { last = null; };
