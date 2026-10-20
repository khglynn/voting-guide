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
