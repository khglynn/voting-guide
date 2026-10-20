/* What an address lookup does to a ballot, from the Census's district numbers alone (the address
   itself never comes here). The Census answers Congress and the state legislature, so:
   - each district question for one of those offices gets its race, or "none" when your district
     isn't one of them;
   - each "may apply" race for one of those offices goes on your ballot (S.b.mine) or off it
     (S.b.notMine);
   - and the line the address box keeps names the races it put on your ballot, office by office:
     "Set from your address: U.S. Representative, District 37 · State Representative, District 49."
     An office it took off (a question answered "none", a race moved to notMine) isn't named, so
     the line never names a race you can't find: its row already says "Not on your ballot".
   DC's "upper" layer is its ward, which the place already settles, so it sets nothing there. */
import type { Contest } from '../types';
import type { Ballot } from '../ballot';
import type { BallotState } from '../state';
import { contestDistrict } from '../ballot';
import { cleanOffice } from './labels';

export interface Districts { cd: number | null; upper: number | null; lower: number | null }
type Kind = keyof Districts;
const KINDS: Kind[] = ['cd', 'upper', 'lower'];

/* Sets what the address settles on `s` and returns the races it put on the ballot, "{office},
   District {n}" each, Congress first, then the state senate, then the state house; empty when it
   put none there (nothing here turns on it, or it only took races off). */
export function setFromAddress(b: Ballot, s: BallotState, r: Districts): string[] {
  const num = (k: Kind): number | null => (b.st === 'DC' && k === 'upper' ? null : r[k]);
  const named: Record<Kind, string[]> = { cd: [], upper: [], lower: [] };
  const name = (k: Kind, office: string) => { const o = cleanOffice(office); if (!named[k].includes(o)) named[k].push(o); };
  for (const g of b.groups) {
    const n = g.kind ? num(g.kind) : null;
    if (!g.kind || n == null) continue;
    const hit = g.members.find((id) => contestDistrict(b.byId.get(id) as Contest).n === n);
    s.districts[g.key] = hit || 'none';
    if (hit) name(g.kind, g.office);
  }
  if (!s.mine) s.mine = [];
  for (const id of b.mayApply) {
    const c = b.byId.get(id);
    if (!c || c.kind !== 'contest') continue;
    const d = contestDistrict(c);
    const n = d.kind ? num(d.kind) : null;
    if (!d.kind || n == null) continue;
    s.notMine = s.notMine.filter((x) => x !== id);
    s.mine = s.mine.filter((x) => x !== id);
    const on = d.n === n;
    (on ? s.mine : s.notMine).push(id);
    if (on) name(d.kind, c.office);
  }
  return KINDS.flatMap((k) => named[k].map((o) => `${o}, District ${num(k)}`));
}

/* What the address box keeps (S.b.addrNote): the line naming what was set, or, when the lookup
   found the address but put no race on this ballot, FOUND_ONLY. Never the address. */
export const FOUND_ONLY = 'Found your address.';
export const addrSummary = (set: string[]): string => (set.length ? `Set from your address: ${set.join(' · ')}.` : FOUND_ONLY);

/* What the address can't settle, in a voter's words, for the address box: "The address lookup doesn't
   cover races like city council or school board." Each office still depending on the address gets a
   kind; the two most common come first. Anything that matches no kind says nothing. */
const OFFICE_KINDS: [RegExp, string][] = [
  [/state board of education/i, 'state board of education'],
  [/board of equalization/i, 'Board of Equalization'],
  [/board of supervisors/i, 'board of supervisors'],
  [/county (clerk|treasurer|assessor|sheriff|surveyor|coroner|recorder)/i, 'county office'],
  [/county.*(commission|council|board)|(commission|council|board).*county|commissioners court/i, 'county board'],
  [/council|alder|selectm/i, 'city council'],
  [/school|education|\bisd\b|trustee|college|regent|universit/i, 'school board'],
  [/justice of the peace/i, 'justice of the peace'],
  [/constable/i, 'constable'],
  [/judge|court|justice/i, 'judge'],
  [/neighborhood|advisory/i, 'neighborhood commission'],
  [/rtd|bart|transit/i, 'transit board'],
  [/water|aquifer|soil/i, 'water district'],
  [/utilit/i, 'utility board'],
  [/hospital/i, 'hospital district'],
  [/development district/i, 'development district'],
  [/town|highway|village/i, 'town office'],
  [/mayor|city commission/i, 'city office'],
  [/state (representative|senator|house|senate)|assembly|delegate/i, 'state legislature'],
  [/u\.?\s?s\.?\s|congress/i, 'U.S. House'],
];
export function addressKinds(offices: string[]): string[] {
  const n = new Map<string, number>();
  for (const o of offices) {
    const k = OFFICE_KINDS.find(([re]) => re.test(o));
    if (k) n.set(k[1], (n.get(k[1]) || 0) + 1);
  }
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}
