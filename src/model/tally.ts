/* The verdict column: who among your sources weighed in on an item, and what the row says.
   Endorsement states stay distinct: endorsed, took no stand, nothing found, not checked yet.
   Colors keep one job each (decided in the view): sage = every source that weighed in agrees,
   clay = they disagree, gold = your pick, dusk = a judge's official review. */
import type { Contest, Endorsement, Endorser, Item } from '../types';
import type { Ballot } from '../ballot';
import { S } from '../state';
import { chosen, status, entriesBySection, isDecision, isRCV } from '../ballot';
import { choiceShort, pickShort } from './labels';
import { explainsOnly } from './lens';
import { judgeReview } from './judges';

export interface LGroup { key: string; label: string; choices: string[]; sources: Endorser[] }
export interface Lineup {
  groups: LGroup[];          // largest first; ties in ballot order
  both: Endorser[];          // a campaign listed on both sides of a measure
  noStand: Endorser[];       // looked, took no position
  notFound: Endorser[];      // looked, found nothing
  notChecked: Endorser[];    // covers this kind of item here, no row yet
  guides: Endorser[];        // explain without picking (this kind of item)
  relevant: Endorser[];      // everyone above except guides
}

/* Does a source cover this item's area? It has a row on some item of the same kind here
   (statewide races, statewide judges, statewide measures, or local items at the same level).
   Without this, a Boulder paper with one row on a shared rail measure would read as
   "not checked" on every Lakewood race. */
const areaCache = new WeakMap<Ballot, Map<string, Set<string>>>();
const areaKey = (b: Ballot, it: Item): string => {
  const sw = b.statewide.has(it.id);
  if (it.kind === 'measure') return sw ? 'sw|m' : `loc|m|${it.level}`;
  const judge = it.level === 'judicial' || it.is_retention;
  return sw ? `sw|c|${judge ? 'j' : 'o'}` : `loc|c|${it.level}`;
};
function covers(b: Ballot, e: Endorser, it: Item): boolean {
  let m = areaCache.get(b);
  if (!m) {
    m = new Map();
    for (const t of b.items) {
      const row = b.ends[t.id];
      if (!row) continue;
      const k = areaKey(b, t);
      for (const eid of Object.keys(row)) { let s = m.get(eid); if (!s) { s = new Set(); m.set(eid, s); } s.add(k); }
    }
    areaCache.set(b, m);
  }
  return !!m.get(e.id)?.has(areaKey(b, it));
}
const makesKind = (e: Endorser, it: Item): boolean => (it.kind === 'measure' ? e.endorses_measures : e.endorses_candidates);
const en = (b: Ballot, it: Item, e: Endorser): Endorsement | null => (b.ends[it.id] || {})[e.id] || null;

/* Order choices the way the ballot lists them (candidates in ballot order, Yes before No). */
function choiceRank(it: Item, key: string): number {
  if (it.kind === 'contest') {
    const first = key.split('+')[0];
    const i = it.candidates.findIndex((c) => c.name === first);
    return i < 0 ? 999 : i;
  }
  return key === 'YES' || key === 'FOR' ? 0 : key === 'NO' || key === 'AGAINST' ? 1 : 2;
}

/* Lineups for the chosen sources are cached per ballot and per source list; they depend on
   nothing else. Picks never change a lineup. */
let lineCache: { b: Ballot; sig: string; m: Map<string, Lineup> } | null = null;
export function lineup(it: Item, sources?: Endorser[]): Lineup {
  const b = S.ballot!;
  if (!sources) {
    const sig = S.b.sources ? S.b.sources.join(',') : '*';
    if (!lineCache || lineCache.b !== b || lineCache.sig !== sig) lineCache = { b, sig, m: new Map() };
    let l = lineCache.m.get(it.id);
    if (!l) { l = computeLineup(it, chosen()); lineCache.m.set(it.id, l); }
    return l;
  }
  return computeLineup(it, sources);
}
/* For tests that rewrite endorsement rows in place. */
export const clearLineups = (): void => { lineCache = null; };
function computeLineup(it: Item, sources: Endorser[]): Lineup {
  const b = S.ballot!;
  const out: Lineup = { groups: [], both: [], noStand: [], notFound: [], notChecked: [], guides: [], relevant: [] };
  const groups = new Map<string, LGroup>();
  for (const e of sources) {
    const r = en(b, it, e);
    const picks = makesKind(e, it);
    if (!r) {
      if (!picks || explainsOnly(e)) { if (covers(b, e, it) || explainsOnly(e)) out.guides.push(e); continue; }
      if (covers(b, e, it)) { out.notChecked.push(e); out.relevant.push(e); }
      continue;
    }
    if (r.s !== 'endorsed' && (explainsOnly(e) || !picks)) { out.guides.push(e); continue; }
    out.relevant.push(e);
    if (r.s === 'no_position') { out.noStand.push(e); continue; }
    if (r.s === 'not_found') { out.notFound.push(e); continue; }
    if (r.both) { out.both.push(e); continue; }
    // Two sources naming the same candidates in a different order agree. Order is kept only
    // where it means something: a ranking in a ranked-choice race.
    const ranked = it.kind === 'contest' && isRCV(it);
    const choices = r.c && r.c.length ? (ranked ? [...r.c] : [...new Set(r.c)].sort((x, y) => choiceRank(it, x) - choiceRank(it, y) || (x < y ? -1 : x > y ? 1 : 0))) : [];
    const key = choices.length ? choices.join('+') : `note:${r.note || 'endorsed'}`;
    let g = groups.get(key);
    if (!g) {
      const label = choices.length ? choices.map((c) => choiceShort(it, c)).join(', ') : (r.note || 'Endorsed');
      g = { key, label, choices, sources: [] };
      groups.set(key, g);
    }
    g.sources.push(e);
  }
  out.groups = [...groups.values()].sort((a, c) => c.sources.length - a.sources.length || choiceRank(it, a.key) - choiceRank(it, c.key));
  return out;
}
export const weighedIn = (l: Lineup): Endorser[] => l.groups.flatMap((g) => g.sources);

/* A source's name, short enough for a lineup in the narrow column: "Denver Post" -> "Post",
   "LWV Colorado" -> "LWV", "Colorado Sun" -> "Sun". A leading word is dropped only when it is a
   place this guide covers (a state or a place label from the index), and a tag that would be
   shared by two sources on one ballot ("Houston Chronicle", "Austin Chronicle") keeps its full
   short name. */
const tagCache = new WeakMap<Ballot, Map<string, string>>();
function placeWords(): string[] {
  const idx = S.index;
  const words = new Set<string>();
  if (idx) {
    Object.values(idx.states).forEach((s) => words.add(s.name));
    Object.values(idx.places).forEach((p) => { words.add(p.label.replace(/\s*\(.*\)$/, '')); p.counties.forEach((c) => words.add(c.replace(/\s*\(.*\)$/, ''))); });
  }
  if (S.ballot) { words.add(S.ballot.stateName); S.ballot.places.forEach((p) => words.add(p.label)); }
  return [...words].filter((w) => w.length > 2).sort((a, b) => b.length - a.length);
}
function rawTag(e: Endorser, places: string[]): string {
  let t = e.short.replace(/^The\s+/, '').replace(/\s+(Editorial Board|Editorial Page|Endorsements?)$/i, '').trim();
  if (/^(LWV|League of Women Voters)\b/i.test(t)) return 'LWV';
  for (const w of places) {
    if (t.startsWith(`${w} `) && t.length > w.length + 3) { t = t.slice(w.length + 1); break; }
  }
  return t;
}
export function tagOf(e: Endorser): string {
  const b = S.ballot;
  if (!b) return e.short;
  let m = tagCache.get(b);
  if (!m) {
    m = new Map();
    const places = placeWords();
    for (const x of b.endorsers) m.set(x.id, rawTag(x, places));
    tagCache.set(b, m);
  }
  return m.get(e.id) || e.short;
}
/* Tags for one lineup: if two would read the same ("LWV" and "LWV"), those two keep their names. */
function lineupTags(list: Endorser[]): Map<string, string> {
  const raw = new Map(list.map((e) => [e.id, tagOf(e)]));
  const n = new Map<string, number>();
  raw.forEach((t) => n.set(t, (n.get(t) || 0) + 1));
  return new Map(list.map((e) => [e.id, (n.get(raw.get(e.id)!) || 0) > 1 ? e.short : raw.get(e.id)!]));
}
const TAG_MAX = 14;
/* "Post no, Gazette yes" when three or fewer sources weighed in and their names are short;
   null when the row should show a tally instead. */
export function namedLineup(l: Lineup, it: Item): string | null {
  const w = weighedIn(l);
  if (!w.length || w.length > 3) return null;
  const tags = lineupTags(w);
  if (w.some((e) => tags.get(e.id)!.length > TAG_MAX)) return null;
  if (l.groups.length === 1) return w.map((e) => tags.get(e.id)!).join(', ');
  const lower = it.kind === 'measure' || (it.kind === 'contest' && it.is_retention);
  return l.groups.flatMap((g) => g.sources.map((e) => `${tags.get(e.id)} ${lower ? g.label.toLowerCase() : g.label}`)).join(', ');
}
/* "Yes 5, No 2" / "Allen 3, Griswold 1": leading side first. */
export function tally(l: Lineup): string {
  return l.groups.map((g) => `${g.label} ${g.sources.length}`).join(', ');
}

export type VKind = 'mine' | 'agree' | 'split' | 'none' | 'review';
export type NoneWhy = 'no_stand' | 'not_found' | 'not_checked' | 'no_cover' | 'no_sources' | 'both' | 'mixed';
export interface Verdict { kind: VKind; main: string; sub: string; why?: NoneWhy; filled?: boolean; tone?: 'fav' | 'unfav' | 'mixed' | 'none' }

export const NONE_WORDS: Record<NoneWhy, string> = {
  no_stand: 'Took no stand', not_found: 'No picks found', not_checked: 'Not checked yet',
  no_cover: 'None of your sources cover this', no_sources: 'No sources chosen', both: 'Listed both sides',
  mixed: 'No picks yet',
};
export function noneWhy(l: Lineup, anyChosen: boolean): NoneWhy {
  if (!anyChosen) return 'no_sources';
  if (!l.relevant.length) return l.both.length ? 'both' : 'no_cover';
  // One word only when every source that covers this is in the same state; "Took no stand"
  // never speaks for a source nobody has checked yet.
  const states: NoneWhy[] = [];
  if (l.noStand.length) states.push('no_stand');
  if (l.notFound.length) states.push('not_found');
  if (l.notChecked.length) states.push('not_checked');
  if (l.both.length) states.push('both');
  return states.length === 1 ? states[0] : 'mixed';
}
/* "2 took no stand, 1 not checked yet": the counts behind "No picks yet". */
export function noneCounts(l: Lineup): string {
  return [
    l.noStand.length ? `${l.noStand.length} took no stand` : '',
    l.notFound.length ? `nothing found for ${l.notFound.length}` : '',
    l.notChecked.length ? `${l.notChecked.length} not checked yet` : '',
    l.both.length ? `${l.both.length} listed both sides` : '',
  ].filter(Boolean).join(', ');
}

/* What the sources said, in small type, under your own pick. */
const yesNo = (it: Item): boolean => it.kind === 'measure' || (it.kind === 'contest' && it.is_retention);
function lineupUnderPick(l: Lineup, it: Item): string {
  const w = weighedIn(l);
  if (!w.length) return '';
  const named = namedLineup(l, it);
  if (l.groups.length > 1) return named || tally(l);
  const lab = yesNo(it) ? l.groups[0].label.toLowerCase() : l.groups[0].label;
  return named ? `${named}: ${lab}` : `all ${w.length}: ${lab}`;
}

export function verdict(it: Item): Verdict {
  const l = lineup(it);
  const s = status(it);
  if (s === 'decided' || s === 'auto' || s === 'skipped') {
    return { kind: 'mine', main: pickShort(it) || 'Decided', sub: s === 'skipped' ? '' : lineupUnderPick(l, it), filled: !!S.b.auto[it.id] };
  }
  // Judges: the official review, in its own neutral style. It is not one of your sources.
  if (it.kind === 'contest' && it.is_retention) {
    const r = judgeReview(it);
    if (r) return { kind: 'review', main: r.main, sub: r.sub, tone: r.tone };
  }
  const w = weighedIn(l);
  if (!w.length) {
    const why = noneWhy(l, chosen().length > 0);
    // A judge with no review in our data yet and no source picks: point to what the row holds.
    // (A wording choice only: no fact is read out of the prose.)
    if (it.kind === 'contest' && it.is_retention && (why === 'no_cover' || why === 'not_checked')) {
      const reviewed = /commission|evaluat|review|rated|recommend|bar association|poll/i.test(`${it.why_it_matters || ''} ${it.candidates.map((c) => c.own_words.map((o) => o.text).join(' ')).join(' ')}`);
      return { kind: 'none', main: reviewed ? 'See the review' : 'Keep or remove?', sub: '', why };
    }
    return { kind: 'none', main: NONE_WORDS[why], sub: why === 'mixed' ? noneCounts(l) : '', why };
  }
  // A source whose pick is a note, not a candidate or yes/no ("option 1: five districts"): name
  // who weighed in and leave the words for the open row.
  if (l.groups.some((g) => !g.choices.length)) {
    return { kind: l.groups.length === 1 ? 'agree' : 'split', main: w.length === 1 ? tagOf(w[0]) : `${w.length} sources`, sub: 'weighed in; open to read' };
  }
  if (l.groups.length === 1) {
    const g = l.groups[0];
    const named = namedLineup(l, it);
    return { kind: 'agree', main: g.label, sub: named || (w.length === 1 ? w[0].short : `all ${w.length} agree`) };
  }
  const named = namedLineup(l, it);
  return { kind: 'split', main: named || tally(l), sub: named ? '' : 'they split' };
}

/* "Your 4 sources picked on 18 of 42 races and measures." Over what's visible now. */
export function coverage(): { sources: number; picked: number; total: number } {
  const b = S.ballot!;
  const src = chosen().filter((e) => !explainsOnly(e));
  let picked = 0, total = 0;
  for (const [, entries] of entriesBySection()) {
    for (const e of entries) {
      if (e.t !== 'item') continue;
      const it = b.byId.get(e.id)!;
      if (!isDecision(status(it))) continue;
      if (it.kind === 'contest' && it.is_retention) continue;
      total++;
      if (weighedIn(lineup(it, src)).length) picked++;
    }
  }
  return { sources: src.length, picked, total };
}

/* Candidates in the grid: backed by your sources first, then ballot order. */
export function orderCandidates(c: Contest, l: Lineup): Contest['candidates'] {
  const score = (name: string) => l.groups.filter((g) => g.choices.includes(name)).reduce((n, g) => n + g.sources.length, 0);
  return c.candidates.map((k, i) => ({ k, i, s: score(k.name) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.k);
}
