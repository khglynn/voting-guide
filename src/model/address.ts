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
   DC's "upper" layer is its ward, which the place already settles, so it sets nothing there.
   The Census also names your school district (Kevin, Oct 20), so a race or measure for one school
   district goes on or off by it: "Round Rock ISD Trustee, Place 3" and an ISD's bond on, or off when
   you're in another district; a trustee question for a district you're not in answers "none". A
   trustee district inside your own school district still needs the sample ballot: the Census
   doesn't have those. */
import type { Contest, Item } from '../types';
import type { Ballot } from '../ballot';
import type { BallotState } from '../state';
import { contestDistrict } from '../ballot';
import { cleanOffice } from './labels';

export interface Districts { cd: number | null; upper: number | null; lower: number | null; schools?: string[] }

/* A school district's name in the Census's words and ours, made comparable: Texas's "Independent
   School District" is our "ISD"; "No." and punctuation drop. */
const sdKey = (s: string): string => s.toLowerCase().replace(/consolidated independent school district/g, 'cisd').replace(/independent school district/g, 'isd')
  .replace(/\bno\.\s*/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
/* The school district a race or measure belongs to, when its scope names one the way the Census
   does ("Round Rock ISD voters (...)", "Del Valle ISD (southeast Travis County)", "San Diego Unified
   School District (...)"), and whether every voter there votes on it. A college district, "Public
   Schools" or anything else stays with the sample ballot. */
export function schoolOf(c: Item): { name: string; key: string; whole: boolean } | null {
  const t = (c.kind === 'contest' ? c.scope_plain : c.jurisdiction) || '';
  const m = t.match(/^(?:Every |Voters in (?:the )?)?((?:[A-Z][\w.'-]*\s)+?(?:C?ISD|Unified School District))\b(.*)$/);
  if (!m) return null;
  const rest = m[2].split('(')[0];
  return { name: m[1], key: sdKey(m[1]), whole: !/district \d|single.member|trustee district|subdistrict|area \d|precinct|zone/i.test(rest) };
}
type Kind = 'cd' | 'upper' | 'lower';
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
    s.addrSet = [...(s.addrSet || []).filter((k) => k !== g.key), g.key];
    if (hit) name(g.kind, g.office);
  }
  if (!s.mine) s.mine = [];
  // School districts: only when the Census named at least one, so a missing layer changes nothing.
  const sds = new Set((r.schools || []).map(sdKey));
  const schoolsNamed: string[] = [];
  if (sds.size) {
    for (const g of b.groups) {
      if (g.kind || s.districts[g.key]) continue;
      const each = g.members.map((id) => schoolOf(b.byId.get(id)!));
      const one = each[0];
      if (!one || each.some((x) => !x || x.key !== one.key) || sds.has(one.key)) continue;
      s.districts[g.key] = 'none'; // a trustee question for a school district you're not in
      s.addrSet = [...(s.addrSet || []).filter((k) => k !== g.key), g.key];
    }
    for (const id of b.mayApply) {
      const it = b.byId.get(id);
      const sd = it ? schoolOf(it) : null;
      if (!sd) continue;
      const on = sds.has(sd.key);
      if (on && !sd.whole) continue; // yours, but which trustee district is the sample ballot's to say
      s.notMine = s.notMine.filter((x) => x !== id);
      s.mine = s.mine.filter((x) => x !== id);
      (on ? s.mine : s.notMine).push(id);
      if (on && !schoolsNamed.includes(sd.name)) schoolsNamed.push(sd.name);
    }
    // A school district's race a whole city sees (Austin ISD's at-large seat, for all of Austin) comes
    // off when your school district is another one, the way a "may apply" row does.
    for (const it of b.items) {
      if (b.mayApply.has(it.id) || b.groupOf[it.id] || b.statewide.has(it.id)) continue;
      const sd = schoolOf(it);
      if (!sd || !sd.whole) continue;
      s.notMine = s.notMine.filter((x) => x !== it.id);
      if (!sds.has(sd.key)) s.notMine.push(it.id);
    }
  }
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
  return [...KINDS.flatMap((k) => named[k].map((o) => `${o}, District ${num(k)}`)), ...schoolsNamed];
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
];
/* Congress and the legislature have no kind: the lookup answers them, so one left after it (Washington's
   two representative seats per district) is the guide's own gap, and the line doesn't blame the lookup. */
export function addressKinds(offices: string[]): string[] {
  const n = new Map<string, number>();
  for (const o of offices) {
    const k = OFFICE_KINDS.find(([re]) => re.test(o));
    if (k) n.set(k[1], (n.get(k[1]) || 0) + 1);
  }
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}
