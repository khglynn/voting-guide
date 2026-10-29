/* The ballot model: which items a person sees, in what order, grouped how, and the
   rules for filters, statuses and endorsements. Pure functions over S. */
import type { Contest, Endorsement, Endorser, HowTo, Item, Measure, PlaceBundle, StateBundle } from './types';
import { S } from './state';
import { localHowto, voterCounty } from './model/plan';
import { todayISO } from './util';
import { seatless, hasSeat } from './model/maps';

export type SectionKey = 'federal' | 'state' | 'judicial' | 'county' | 'city' | 'school' | 'special_district' | 'measures';
export const SECTIONS: [SectionKey, string][] = [
  ['federal', 'Federal'], ['state', 'State'], ['judicial', 'Courts'], ['county', 'County'],
  ['city', 'City'], ['school', 'School'], ['special_district', 'Other local districts'], ['measures', 'Ballot measures'],
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
  /* the state file's own plan facts, before any place override: for text about the whole state */
  stateHowto: HowTo;
  /* the voter's county `howto` was made for, on a ballot that spans counties (localize); null when unknown */
  county: string | null;
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

/* Which Census district a race is for, read from its district: Congress (cd), the state senate
   (upper) or the state house or assembly (lower), with its number. The research mostly writes "CD-37",
   "SD-14", "HD-49" or "AD-51", and a few places another way (Oct 20): a U.S. House seat as "GA-5" or
   "NY-13", a legislature seat spelled out ("Senate District 35", "House District 53"), and Washington's
   legislative districts, which elect one senator each ("LD-32") and two representatives ("LD-32
   Position 1" and "Position 2", both on that district's ballot, so one answer shows both: sameSeat).
   Anything else is no Census district. */
const US_HOUSE = /\bU\.?\s?S\.?\s+(?:House|Representative)|\bCongress/i;
const districtNum = (c: Contest): { kind: Group['kind']; n: number | null } => {
  const d = (c.district || '').trim();
  let m = d.match(/^CD-?\s*(\d+)/i);
  if (m) return { kind: 'cd', n: +m[1] };
  m = d.match(/^SD-?\s*(\d+)/i);
  if (m) return { kind: 'upper', n: +m[1] };
  m = d.match(/^(?:HD|AD)-?\s*(\d+)/i);
  if (m) return { kind: 'lower', n: +m[1] };
  m = d.match(/^[A-Z]{2}-(\d+)$/);
  if (m && US_HOUSE.test(c.office)) return { kind: 'cd', n: +m[1] };
  m = d.match(/^(?:State )?Senate District (\d+)$/i);
  if (m) return { kind: 'upper', n: +m[1] };
  m = d.match(/^(?:State )?(?:House|Assembly) District (\d+)$/i);
  if (m) return { kind: 'lower', n: +m[1] };
  m = d.match(/^LD-?\s*(\d+)$/i);
  if (m && /senat/i.test(c.office)) return { kind: 'upper', n: +m[1] };
  m = d.match(/^LD-?\s*(\d+)\s+Position\s+\d+$/i);
  if (m && /representative|house/i.test(c.office)) return { kind: 'lower', n: +m[1] };
  return { kind: null, n: null };
};
/* Two seats of one district in a district question: Washington's "LD-32 Position 1" and "LD-32
   Position 2" are both on every 32nd District ballot, so answering the question with one puts both
   on (review, Oct 20: picking a position hid the other one). */
const seatBase = (c: Item | undefined): string => (c && c.kind === 'contest' && hasSeat(c.district || '') ? seatless(c.district || '') : '');
export const sameSeat = (a: Item | undefined, c: Item | undefined): boolean => !!a && !!c && a !== c && a.kind === 'contest' && c.kind === 'contest' && a.office === c.office && !!seatBase(a) && seatBase(a) === seatBase(c);
export const contestDistrict = districtNum;

/* A single regional race a place's own research listed, whose scope names that place's
   county and no district inside it (an appeals court for "LA and three nearby counties"),
   applies to everyone there. Anything scoped to a precinct, ward or numbered district
   still says "May apply". */
/* Read from the measure's own jurisdiction note, the way coversPlace reads a race's scope: a
   district named as covering only part of the place ("including part of northwest Houston",
   "central San Antonio", "only voters inside this territory"), one county of a place that spans
   several, or a school district that names neither the place nor its county, may apply. So does
   a small city's own question inside a county-wide place (Goodlettsville's sales tax on a
   Nashville ballot: "City of Goodlettsville voters only"), whose scope says so and never names
   the place. */
const PARTIAL = /\b(part of|parts of|small part|much of|touching|only|not already|except|excluding|outside|reaches|central|far (north|south|east|west)\w*|northwest|northeast|southwest|southeast)\b/i;
function measureCovers(m: Measure, places: PlaceBundle[]): boolean {
  if (!places.length) return true;
  const j = m.jurisdiction || '';
  if (/\bevery\b[^)]*\bvoter/i.test(j)) return true;
  const named = (c: string) => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(j);
  if (m.level === 'city' && PARTIAL.test(j) && !places.some((p) => named(p.label.replace(/\s*\(.*\)$/, '')))) return false;
  if (!['school', 'special_district', 'county'].includes(m.level)) return true;
  if (PARTIAL.test(j)) return false;
  const counties = (p: PlaceBundle) => p.counties.map((c) => c.replace(/\s*\([^)]*\)/g, '').replace(/\s+County$/i, '').trim()).filter(Boolean);
  // A place in several counties: a measure that names some of them but not all (Aurora: "17th
  // Judicial District (Adams County and ...)") reaches only part of it.
  if (places.some((p) => counties(p).length > 1 && counties(p).some(named) && !counties(p).every(named))) return false;
  if (m.level === 'school') {
    const names = places.flatMap((p) => [p.label.replace(/\s*\(.*\)$/, ''), ...counties(p)]).map((x) => x.toLowerCase());
    return names.some((x) => x && j.toLowerCase().includes(x));
  }
  return true;
}
/* A scope that names a district inside the place: a precinct, ward, numbered district or judicial
   subcircuit ("Only voters in Cook County Judicial Subcircuit 1"), or a neighborhood's own
   district ("Only voters who live inside the Vista Lakes Community Development District in
   southeast Orange County"). Naming the county only to say where such a district sits never
   makes it cover the place. */
const DISTRICTISH = /precinct|ward\b|trustee area|congressional|\bseat\b|\bplace \d|district\s*(?:\d|[a-z]\b)|\b(?:CD|SD|HD|AD)-\d|\bsubcircuit\s*\d|community development district/i;
/* A ward's own race on that ward's ballot: "Only Ward 6 voters" on "DC Ward 6" covers it. An ANC
   race ("You vote in one ANC race") names its ward too, but stays a maybe: each voter has one of
   many single-member districts. */
const OWN_WARD = /^only ward (\d+) voters\b/i;
const placeWard = (p: PlaceBundle): string | null => (p.label.match(/\bward (\d+)$/i) || [])[1] || null;
function coversPlace(c: Contest, places: PlaceBundle[]): boolean {
  if (!places.length || !places.every((p) => p.order.includes(c.id))) return false;
  const scope = c.scope_plain || '';
  const ward = (scope.match(OWN_WARD) || [])[1];
  if (ward && places.every((p) => placeWard(p) === ward)) return true;
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
  // A local measure for a school or special district that covers only part of the place
  // (Cy-Fair ISD on a downtown Houston ballot) may apply too, by its own scope.
  for (const it of items) if (it.kind === 'measure' && !statewide.has(it.id) && !measureCovers(it, places)) mayApply.add(it.id);

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
    st: sb.state, stateName: sb.name, howto: localHowto(sb.howto, places), stateHowto: sb.howto, county: null, places,
    items, byId, order: ids, endorsers, eById, ends, statewide, onlyIn, groups, groupOf, mayApply,
    hasLocal: places.some((p) => p.local.length > 0),
  };
}

/* The plan facts for this voter's county (Oct 28), on a ballot whose place spans counties: from the address
   lookup's county (this visit only) or the ZIP. Called when a ballot opens, when a lookup names the county, and
   once a minute (main.ts), so text dated to change (plan.applyDated) changes at midnight on an open page. */
export function localize(b: Ballot, zip: string | null | undefined, addrCounty: string | null | undefined): void {
  const county = voterCounty(b.places, zip, addrCounty);
  if (county === b.county && b.howto.day === todayISO()) return;
  b.county = county;
  b.howto = localHowto(b.stateHowto, b.places, county);
}

/* ---------- sections ---------- */
export const sectionOf = (it: Item): SectionKey => (it.kind === 'measure' ? 'measures' : it.level);

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

/* Cached per ballot and per district answers: a render asks for this many times. */
let entriesCache: { b: Ballot; sig: string; v: Map<SectionKey, Entry[]> } | null = null;
export function entriesBySection(): Map<SectionKey, Entry[]> {
  const b = S.ballot!;
  const sig = `${JSON.stringify(S.b.districts)}|${S.b.notMine.join(',')}`;
  if (entriesCache && entriesCache.b === b && entriesCache.sig === sig) return entriesCache.v;
  const v = computeEntries(b);
  entriesCache = { b, sig, v };
  return v;
}
function computeEntries(b: Ballot): Map<SectionKey, Entry[]> {
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
      if (ans === '*' || ans === it.id || (ans !== 'none' && sameSeat(b.byId.get(ans), it))) push(sec, { t: 'item', id: it.id });
      continue;
    }
    // A "may apply" race you said isn't yours, or one school district's race your address took off.
    if (S.b.notMine.includes(it.id)) { push(sec, { t: 'notmine', id: it.id }); continue; }
    push(sec, { t: 'item', id: it.id });
  }
  return out;
}

/* "Maybe on your ballot": a race or measure this ballot can't promise is yours. A "may apply"
   item the voter hasn't hidden (its row says "Maybe on your ballot", or "Only in <place>" on a
   ballot for several places), or a race in a district group answered "Not sure". The row tag,
   the one-tap fills and the cheat sheet all read this one rule, so a fill never picks a race the
   row itself calls a maybe. A "may apply" race your address put on your ballot (S.b.mine) is no
   longer a maybe. */
export function isMaybe(id: string): boolean {
  const b = S.ballot!;
  if (b.mayApply.has(id)) return !S.b.notMine.includes(id) && !(S.b.mine || []).includes(id);
  const g = b.groupOf[id];
  return !!g && S.b.districts[g] === '*';
}

/* ---------- counting: "N of M decided" ----------
   One rule for the bar, the section bands, the menu and the cheat sheet:
   - every choice the page shows counts, "Maybe on your ballot" rows too;
   - a district question counts as one race until it's answered, then its race (or, for "Not
     sure", each of its races) takes its place;
   - the races folded under "Other school districts that touch ..." count only once you claim
     one: open the fold, or pick or note one of them. */
/* Other school districts' races: "may apply" school races outside any district question. Three
   or more fold into one row on the ballot ("Other school districts that touch Austin"). One your
   address put on your ballot (S.b.mine) is yours, so it stands as its own row. */
export const OTH_KEY = 'school|oth';
export function otherSchools(entries: Entry[]): Entry[] {
  const b = S.ballot!;
  const oth = entries.filter((e) => e.t === 'item' && b.mayApply.has(e.id) && b.byId.get(e.id)!.kind === 'contest' && !b.groupOf[e.id] && status(b.byId.get(e.id)!) !== 'unopposed' && !(S.b.mine || []).includes(e.id));
  return oth.length >= 3 ? oth : [];
}
export const othOpen = (oth: Entry[]): boolean => S.ui.unfolded.has(OTH_KEY) || oth.some((e) => e.t === 'item' && (e.id === S.ui.row || e.id === S.ui.keep));
/* Anything of yours on a race: a pick (a seat, a judge, a rank) or a note. */
const touched = (id: string): boolean => !!S.b.picks[id] || (S.b.ranks[id] || []).length > 0 || !!(S.b.notes[id] || '').trim()
  || Object.keys(S.b.picks).some((k) => k.startsWith(`${id}|`));
/* The folded races that don't count: their fold is closed and you haven't picked or noted them. */
export function unclaimed(): Set<string> {
  const out = new Set<string>();
  const oth = otherSchools(entriesBySection().get('school') || []);
  if (!oth.length || othOpen(oth)) return out;
  for (const e of oth) if (e.t === 'item' && !touched(e.id)) out.add(e.id);
  return out;
}
/* Every choice and district question in the order the page draws them: sections in SECTIONS
   order, then each section's own order. key is an item id or "q:<group key>". `folded` marks an
   unclaimed race in the closed "Other school districts" fold: the page draws none of them, so
   the count leaves them out and "Next" passes them by. */
export interface Walked { key: string; done: boolean; sec: SectionKey; question?: boolean; folded?: boolean }
export function pageWalk(): Walked[] {
  const b = S.ballot!;
  const by = entriesBySection();
  const shut = unclaimed();
  const out: Walked[] = [];
  for (const [sec] of SECTIONS) {
    for (const e of by.get(sec) || []) {
      if (e.t === 'question') { out.push({ key: `q:${e.group.key}`, done: false, sec, question: true }); continue; }
      if (e.t !== 'item') continue;
      const s = status(b.byId.get(e.id)!);
      if (isDecision(s)) out.push({ key: e.id, done: s !== 'open', sec, ...(shut.has(e.id) ? { folded: true } : {}) });
    }
  }
  return out;
}
/* What "N of M decided" counts, in page order: M is the length, N the ones done. */
export function decisionItems(): { id: string; done: boolean; question?: boolean }[] {
  return pageWalk().filter((x) => !x.folded).map((x) => ({ id: x.key, done: x.done, ...(x.question ? { question: true } : {}) }));
}
