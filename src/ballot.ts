/* The ballot model: which items a person sees, in what order, grouped how, and the
   rules for filters, statuses and endorsements. Pure functions over S. */
import type { Contest, Endorsement, Endorser, HowTo, Item, Measure, PlaceBundle, StateBundle } from './types';
import { S } from './state';

export type SectionKey = 'federal' | 'state' | 'judicial' | 'county' | 'city' | 'school' | 'special_district' | 'measures';
export const SECTIONS: [SectionKey, string][] = [
  ['federal', 'Federal'], ['state', 'State'], ['judicial', 'Courts'], ['county', 'County'],
  ['city', 'City'], ['school', 'School'], ['special_district', 'Special districts'], ['measures', 'Measures'],
];

export interface Group {
  key: string;
  level: string;
  office: string;
  members: string[];
  kind: 'cd' | 'upper' | 'lower' | null;
}

export interface Ballot {
  key: string;
  st: string;
  stateName: string;
  howto: HowTo;
  places: PlaceBundle[];
  items: Item[];
  byId: Map<string, Item>;
  order: string[];
  endorsers: Endorser[];
  eById: Map<string, Endorser>;
  ends: Record<string, Record<string, Endorsement>>;
  statewide: Set<string>;
  onlyIn: Record<string, string[]>;
  groups: Group[];
  groupOf: Record<string, string>;
  mayApply: Set<string>;
  hasLocal: boolean;
}

const districtNum = (c: Contest): { kind: Group['kind']; n: number | null } => {
  const d = c.district || '';
  let m = d.match(/^CD-?\s*(\d+)/i);
  if (m) return { kind: 'cd', n: +m[1] };
  m = d.match(/^SD-?\s*(\d+)/i);
  if (m) return { kind: 'upper', n: +m[1] };
  m = d.match(/^(?:HD|AD)-?\s*(\d+)/i);
  if (m) return { kind: 'lower', n: +m[1] };
  return { kind: null, n: null };
};
export const contestDistrict = districtNum;

/* A single regional race a place's own research listed, whose scope names that place's
   county and no district inside it (an appeals court for "LA and three nearby counties"),
   applies to everyone there. Anything scoped to a precinct, ward or numbered district
   still says "May apply". */
const DISTRICTISH = /precinct|ward\b|trustee area|congressional|\bseat\b|\bplace \d|district\s*(?:\d|[a-z]\b)|\b(?:CD|SD|HD|AD)-\d/i;
function coversPlace(c: Contest, places: PlaceBundle[]): boolean {
  if (!places.length || !places.every((p) => p.order.includes(c.id))) return false;
  const scope = c.scope_plain || '';
  if (DISTRICTISH.test(scope)) return false;
  return places.every((p) => p.counties.some((county) => {
    const name = county.replace(/\s*\(.*\)\s*/, '').replace(/\s+County$/i, '').trim();
    return name.length > 2 && scope.toLowerCase().includes(name.toLowerCase());
  }));
}

const SEAT = /^(?:place|position|seat|post|no\.)\s*\d+\b/i;
export function sameScopeSeats(cs: Contest[]): boolean {
  const scope = (c: Contest) => (c.scope_plain || '').trim().toLowerCase();
  return cs.every((c) => SEAT.test((c.district || '').trim())) && cs.every((c) => scope(c) && scope(c) === scope(cs[0]));
}

export function buildBallot(sb: StateBundle, places: PlaceBundle[]): Ballot {
  const byId = new Map<string, Item>();
  sb.items.forEach((i) => byId.set(i.id, i));
  places.forEach((p) => p.items.forEach((i) => { if (!byId.has(i.id)) byId.set(i.id, i); }));
  const statewide = new Set(sb.order);

  // What's on this ballot. With a place: everything statewide that every voter sees, plus
  // everything the place lists. Without one: the whole statewide file, regional items marked.
  let ids: string[];
  const onlyIn: Record<string, string[]> = {};
  if (places.length) {
    const set = new Set<string>();
    const idx = new Map<string, number>();
    sb.order.forEach((id) => { const it = byId.get(id)!; if (it.kind === 'measure' || it.every) set.add(id); });
    places.forEach((p) => p.order.forEach((id, i) => { if (byId.has(id)) { set.add(id); if (!idx.has(id)) idx.set(id, i); } }));
    if (places.length > 1) {
      for (const id of set) {
        if (statewide.has(id)) continue;
        const inPlaces = places.filter((p) => p.order.includes(id)).map((p) => p.label);
        if (inPlaces.length < places.length) onlyIn[id] = inPlaces;
      }
    }
    const swIdx = new Map(sb.order.map((id, i) => [id, i]));
    ids = [...set].sort((a, b) => {
      const sa = statewide.has(a) ? 0 : 1, sbb = statewide.has(b) ? 0 : 1;
      if (sa !== sbb) return sa - sbb;
      const ia = sa === 0 ? swIdx.get(a)! : idx.get(a) ?? 9999;
      const ib = sbb === 0 ? swIdx.get(b)! : idx.get(b) ?? 9999;
      return ia - ib;
    });
  } else {
    ids = [...sb.order];
  }
  const items = ids.map((id) => byId.get(id)!).filter(Boolean);

  // District groups: races only some voters see, for the same office, more than one of them.
  const byOffice = new Map<string, string[]>();
  for (const it of items) {
    if (it.kind !== 'contest' || it.every) continue;
    if (onlyIn[it.id]) continue;
    const k = `${it.level}|${it.office}`;
    byOffice.set(k, [...(byOffice.get(k) || []), it.id]);
  }
  const groups: Group[] = [];
  const groupOf: Record<string, string> = {};
  const mayApply = new Set<string>();
  for (const [k, members] of byOffice) {
    // Numbered seats (Place 1, Position 4, Seat 3) that share one scope are separate races on the
    // same ballot (every Klein ISD voter picks both trustee positions), not districts to choose
    // between, so they never become a question. Each one may still apply, by its scope.
    if (members.length >= 2 && sameScopeSeats(members.map((m) => byId.get(m) as Contest))) {
      members.forEach((m) => { if (!coversPlace(byId.get(m) as Contest, places)) mayApply.add(m); });
      continue;
    }
    if (members.length >= 2) {
      const first = byId.get(members[0]) as Contest;
      groups.push({ key: k, level: first.level, office: first.office, members, kind: districtNum(first).kind });
      members.forEach((m) => { groupOf[m] = k; });
    } else if (!coversPlace(byId.get(members[0]) as Contest, places)) mayApply.add(members[0]);
  }
  Object.keys(onlyIn).forEach((id) => mayApply.add(id));

  const ends: Record<string, Record<string, Endorsement>> = {};
  const eById = new Map<string, Endorser>();
  [sb, ...places].forEach((b) => {
    Object.entries(b.endorsements).forEach(([t, row]) => { ends[t] = { ...(ends[t] || {}), ...row }; });
    b.endorsers.forEach((e) => { if (!eById.has(e.id)) eById.set(e.id, e); });
  });
  const onBallot = new Set(ids);
  const used = new Set<string>();
  Object.entries(ends).forEach(([t, row]) => { if (onBallot.has(t)) Object.keys(row).forEach((e) => used.add(e)); });
  const endorsers = [...eById.values()].filter((e) => used.has(e.id));

  return {
    key: `${sb.state}|${places.map((p) => p.id).join('+') || '-'}`,
    st: sb.state, stateName: sb.name, howto: sb.howto, places,
    items, byId, order: ids, endorsers, eById, ends, statewide, onlyIn, groups, groupOf, mayApply,
    hasLocal: places.some((p) => p.local.length > 0),
  };
}

/* ---------- sections ---------- */
export const sectionOf = (it: Item): SectionKey => (it.kind === 'measure' ? 'measures' : it.level);

export const itemTitle = (it: Item): string => {
  if (it.kind === 'measure') return it.number;
  const d = (it.district || '').replace(/\s*\(.*\)\s*$/, '').trim();
  if (!d || /^your\b/i.test(d) || it.office.endsWith('?') || it.office.includes('(') || it.office.includes(d)) return it.office;
  return `${it.office}, ${d}`;
};
export const shortTitle = (it: Item): string => {
  const t = itemTitle(it);
  return t.length > 64 ? `${t.slice(0, 61)}...` : t;
};

/* ---------- sources ---------- */
export function chosenIds(): string[] {
  const b = S.ballot!;
  if (S.b.sources) return S.b.sources.filter((id) => b.eById.has(id));
  return b.endorsers.filter((e) => e.default_on).map((e) => e.id);
}
export function chosen(): Endorser[] {
  const b = S.ballot!;
  const ids = new Set(chosenIds());
  return b.endorsers.filter((e) => ids.has(e.id));
}
export const endorsement = (tid: string, eid: string): Endorsement | null => (S.ballot!.ends[tid] || {})[eid] || null;

/* Sources that could weigh in here: they endorse this kind of item, or we have a row for it. */
export function relevantChosen(it: Item): Endorser[] {
  return chosen().filter((e) => endorsement(it.id, e.id) || (it.kind === 'measure' ? e.endorses_measures : e.endorses_candidates));
}
export function weighedIn(it: Item): Endorser[] {
  return relevantChosen(it).filter((e) => endorsement(it.id, e.id)?.s === 'endorsed');
}
export function backers(it: Item, choice: string): Endorser[] {
  return chosen().filter((e) => { const en = endorsement(it.id, e.id); return en?.s === 'endorsed' && !!en.c && en.c.includes(choice); });
}

/* ---------- parties ---------- */
const NO_PARTY = /^(nonpartisan|unaffiliated|independent|no party affiliation|no party|write-in|none)$/i;
export const isPartisan = (c: Contest): boolean => c.candidates.some((k) => k.parties.some((p) => !NO_PARTY.test(p)));

/* ---------- statuses ---------- */
export type Status = 'info' | 'unopposed' | 'open' | 'decided' | 'auto' | 'skipped';
export const isMultiJudge = (c: Contest): boolean => c.is_retention && c.candidates.length > 1;
/* Ranked choice: the voter ranks candidates in order. Multi-seat ranked races (Portland
   council, DC at-large) are ranked, not "mark up to N". */
export const isRCV = (c: Contest): boolean => c.ranked_choice && !c.is_retention;
export const isMultiSeat = (c: Contest): boolean => !c.is_retention && !c.ranked_choice && c.vote_for > 1;
/* How many ranks this guide can fill: the ballot's limit, or every candidate if fewer
   (the ballot's extra column is a write-in line). */
export const rankMax = (c: Contest): number => Math.min(c.rank_up_to || c.candidates.length, c.candidates.length);
export const ranksOf = (id: string): string[] => S.b.ranks[id] || [];
export const ordinal = (n: number): string => {
  const t = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] || 'th');
  return `${n}${t}`;
};

/* The candidates (or YES/NO) this voter chose on an item, in order: one pick, the marked
   seats, or the ranking, 1st choice first. */
export function myChoices(it: Item): string[] {
  const p = S.b.picks;
  const v = p[it.id];
  if (v === 'SKIP') return [];
  if (it.kind === 'measure') return v ? [v] : [];
  if (isRCV(it)) return ranksOf(it.id);
  if (isMultiSeat(it)) return it.candidates.filter((c) => p[`${it.id}|${c.name}`] === 'PICK').map((c) => c.name);
  if (isMultiJudge(it)) return [];
  return v && v !== 'DONE' ? [v] : [];
}

export function status(it: Item): Status {
  const p = S.b.picks;
  if (it.kind === 'measure') return p[it.id] === 'SKIP' ? 'skipped' : p[it.id] ? 'decided' : 'open';
  if (it.candidates.length === 0) return 'info';
  if (!it.is_retention && it.candidates.length === 1) return 'unopposed';
  if (p[it.id] === 'SKIP') return 'skipped';
  if (isMultiJudge(it)) return it.candidates.every((c) => p[`${it.id}|${c.name}`]) ? 'decided' : 'open';
  if (isRCV(it)) {
    // Decided once every rank this guide can fill is used, or the voter says they're done.
    const n = ranksOf(it.id).length;
    return n > 0 && (n >= rankMax(it) || p[it.id] === 'DONE') ? 'decided' : 'open';
  }
  if (isMultiSeat(it)) {
    const n = it.candidates.filter((c) => p[`${it.id}|${c.name}`] === 'PICK').length;
    return n >= it.vote_for || (n > 0 && p[it.id] === 'DONE') ? 'decided' : 'open';
  }
  if (p[it.id]) return S.b.auto[it.id] ? 'auto' : 'decided';
  return 'open';
}
export const isDecision = (s: Status): boolean => s !== 'info' && s !== 'unopposed';

/* ---------- what's visible ---------- */
export type Entry =
  | { t: 'item'; id: string }
  | { t: 'question'; group: Group }
  | { t: 'groupline'; group: Group }
  | { t: 'notmine'; id: string };

export function entriesBySection(): Map<SectionKey, Entry[]> {
  const b = S.ballot!;
  const out = new Map<SectionKey, Entry[]>();
  const push = (s: SectionKey, e: Entry) => { out.set(s, [...(out.get(s) || []), e]); };
  const seenGroup = new Set<string>();
  for (const it of b.items) {
    const sec = sectionOf(it);
    const gk = b.groupOf[it.id];
    if (gk) {
      const g = b.groups.find((x) => x.key === gk)!;
      const ans = S.b.districts[gk];
      if (!seenGroup.has(gk)) {
        seenGroup.add(gk);
        push(sec, ans === undefined ? { t: 'question', group: g } : { t: 'groupline', group: g });
      }
      if (ans === '*' || ans === it.id) push(sec, { t: 'item', id: it.id });
      continue;
    }
    if (b.mayApply.has(it.id) && S.b.notMine.includes(it.id)) { push(sec, { t: 'notmine', id: it.id }); continue; }
    push(sec, { t: 'item', id: it.id });
  }
  return out;
}

/* Visible decision items, in order, for progress and "Next undecided". */
export function decisionItems(): { id: string; done: boolean; question?: boolean }[] {
  const out: { id: string; done: boolean; question?: boolean }[] = [];
  for (const [, entries] of entriesBySection()) {
    for (const e of entries) {
      if (e.t === 'question') { out.push({ id: `q:${e.group.key}`, done: false, question: true }); continue; }
      if (e.t !== 'item') continue;
      const it = S.ballot!.byId.get(e.id)!;
      const s = status(it);
      if (!isDecision(s)) continue;
      out.push({ id: it.id, done: s !== 'open' });
    }
  }
  return out;
}

export const measureById = (id: string): Measure | null => { const it = S.ballot!.byId.get(id); return it && it.kind === 'measure' ? it : null; };
