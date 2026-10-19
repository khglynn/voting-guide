/* "Who do you trust?": the chips are presets over S.b.sources, the explicit list of endorser
   ids that save links already carry. A chip never stores itself; it reads and writes that list.
   Membership is a rule over each source's own fields (type, lean, party), never a hand list,
   and never inferred from whom a source endorsed. */
import type { Endorser } from '../types';
import type { Ballot } from '../ballot';
import { S } from '../state';
import { chosenIds, isPartisan } from '../ballot';

export type ChipKey = 'papers' | 'progressive' | 'conservative';
const LEFT = ['left', 'lean_left'];
const RIGHT = ['lean_right', 'right'];

/* Papers and guides: newsrooms and nonpartisan civic groups. These are the defaults
   (Kevin's founding rule: neutral by default, partisan by choice). */
export const isPaper = (e: Endorser): boolean => e.type === 'publication' || e.type === 'civic_nonpartisan';
const isGroup = (e: Endorser): boolean => e.type !== 'party' && e.type !== 'publication';
/* A source that never picks anything (an explainer: Colorado Sun, CalMatters, VOTE411). */
export const explainsOnly = (e: Endorser): boolean => !e.endorses_candidates && !e.endorses_measures;

export const CHIPS: { key: ChipKey; label: string; empty: string }[] = [
  { key: 'papers', label: 'Papers and guides', empty: 'Papers and guides here haven’t made picks on this ballot yet.' },
  { key: 'progressive', label: 'Progressive groups', empty: 'No progressive groups we checked made picks on this ballot.' },
  { key: 'conservative', label: 'Conservative groups', empty: 'No conservative groups we checked made picks on this ballot.' },
];

export function chipMembers(b: Ballot, key: ChipKey): Endorser[] {
  if (key === 'papers') return b.endorsers.filter(isPaper);
  if (key === 'progressive') return b.endorsers.filter((e) => isGroup(e) && !!e.lean && LEFT.includes(e.lean));
  return b.endorsers.filter((e) => isGroup(e) && !!e.lean && RIGHT.includes(e.lean));
}

/* How many items on this ballot a source made a pick on. */
const pickCache = new WeakMap<Ballot, Map<string, number>>();
export function picksOnBallot(b: Ballot, eid: string): number {
  let m = pickCache.get(b);
  if (!m) {
    m = new Map();
    for (const id of b.order) {
      const row = b.ends[id];
      if (!row) continue;
      for (const [e, en] of Object.entries(row)) if (en.s === 'endorsed') m.set(e, (m.get(e) || 0) + 1);
    }
    pickCache.set(b, m);
  }
  return m.get(eid) || 0;
}
export const withPicks = (b: Ballot, list: Endorser[]): Endorser[] => list.filter((e) => picksOnBallot(b, e.id) > 0);

/* ---------- parties ---------- */
const PARTY_WORDS: [RegExp, string][] = [
  [/statehood green/i, 'DC Statehood Green'], [/working families|\bwfp\b/i, 'Working Families'],
  [/democrat|\bdems?\b/i, 'Democratic'], [/republican|\bgop\b/i, 'Republican'], [/conservative party/i, 'Conservative'],
  [/libertarian/i, 'Libertarian'], [/green party/i, 'Green'],
];
/* The party a party organization speaks for: the data's `party`, else read from its name
   and matched to the party labels candidates carry on this ballot. */
export function partyOf(e: Endorser, b: Ballot | null = S.ballot): string | null {
  if (e.party) return e.party;
  if (e.type !== 'party') return null;
  const text = `${e.name} ${e.id.replace(/-/g, ' ')}`;
  const hit = PARTY_WORDS.find(([re]) => re.test(text));
  if (!hit) return null;
  const labels = b ? ballotPartyLabels(b) : [];
  return labels.find((l) => l === hit[1]) || labels.find((l) => l.toLowerCase().includes(hit[1].toLowerCase())) || hit[1];
}
const labelCache = new WeakMap<Ballot, string[]>();
/* Party labels on partisan races here, from the normalized `parties` lists (never the display text). */
export function ballotPartyLabels(b: Ballot): string[] {
  let l = labelCache.get(b);
  if (!l) {
    const set = new Set<string>();
    for (const it of b.items) if (it.kind === 'contest' && !it.is_retention && isPartisan(it)) it.candidates.forEach((c) => c.parties.forEach((p) => { if (!/^(nonpartisan|unaffiliated|independent|no party.*|write-in|none)$/i.test(p)) set.add(p); }));
    l = [...set].sort();
    labelCache.set(b, l);
  }
  return l;
}
export interface PartyChoice { party: string; sources: Endorser[]; picks: number; nominees: number }
/* Every party on this ballot: with party sources that made picks, or with nominees. A-Z. */
export function partiesOnBallot(b: Ballot): PartyChoice[] {
  const map = new Map<string, PartyChoice>();
  const get = (p: string) => { let x = map.get(p); if (!x) { x = { party: p, sources: [], picks: 0, nominees: 0 }; map.set(p, x); } return x; };
  for (const e of b.endorsers) {
    if (e.type !== 'party') continue;
    const p = partyOf(e, b);
    if (!p) continue;
    const n = picksOnBallot(b, e.id);
    if (!n) continue;
    const x = get(p); x.sources.push(e); x.picks += n;
  }
  for (const it of b.items) {
    if (it.kind !== 'contest' || it.is_retention || !isPartisan(it)) continue;
    const seen = new Set<string>();
    it.candidates.forEach((c) => c.parties.forEach((p) => { if (ballotPartyLabels(b).includes(p) && !seen.has(p)) { seen.add(p); get(p).nominees++; } }));
  }
  return [...map.values()].sort((a, c) => a.party.localeCompare(c.party));
}

/* ---------- chips over the chosen list ---------- */
export type ChipState = 'on' | 'some' | 'off' | 'empty';
export function chipState(b: Ballot, key: ChipKey): ChipState {
  const members = chipMembers(b, key);
  const live = withPicks(b, members);
  const ids = new Set(chosenIds());
  const pool = live.length ? live : members;
  if (!pool.length) return 'empty';
  const on = pool.filter((e) => ids.has(e.id)).length;
  const st: ChipState = on === pool.length ? 'on' : on ? 'some' : 'off';
  return !live.length && st === 'off' ? 'empty' : st;
}
const defaultIds = (b: Ballot): string[] => b.endorsers.filter((e) => e.default_on).map((e) => e.id);
/* Write a list back, as null when it is exactly the defaults, so a link stays short and new
   default sources join on their own. */
export function setSources(b: Ballot, ids: string[]): void {
  const uniq = [...new Set(ids)].filter((id) => b.eById.has(id));
  const def = defaultIds(b);
  S.b.sources = uniq.length === def.length && def.every((id) => uniq.includes(id)) ? null : uniq;
}
export function toggleChip(b: Ballot, key: ChipKey): boolean {
  const st = chipState(b, key);
  const members = chipMembers(b, key).map((e) => e.id);
  const cur = chosenIds();
  const turnOn = st !== 'on';
  setSources(b, turnOn ? [...cur, ...members] : cur.filter((id) => !members.includes(id)));
  return turnOn;
}
/* The party lens: turning a party on adds its sources (and remembers the party for
   "Fill in my party"); off removes them. */
export function setParty(b: Ballot, party: string | null): void {
  const prev = S.b.party;
  const cur = chosenIds();
  const ids = (p: string | null) => (p ? (partiesOnBallot(b).find((x) => x.party === p)?.sources || []).map((e) => e.id) : []);
  const drop = ids(prev);
  setSources(b, [...cur.filter((id) => !drop.includes(id)), ...ids(party)]);
  S.b.party = party;
}
