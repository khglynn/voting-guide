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
   doesn't have those, but a district map can (below).
   District maps (model/maps.ts, Oct 21): where a place ships its city's or county's boundaries, the
   features at your address settle each district question and "may apply" race a map's rule names
   (council, trustee, commissioner, justice of the peace, constable, State Board of Education), the
   same way: on (mine) or off (notMine), the question answered, and named in the line ("Austin City
   Council, District 9"). A map that covers one county also rules out its races when the Census puts
   you in another county. */
import type { Contest, Item, MapMeta, SettleRule } from '../types';
import type { Ballot } from '../ballot';
import type { BallotState } from '../state';
import { contestDistrict } from '../ballot';
import { cleanOffice } from './labels';
import { ballotMaps, ruleMatches, ruleIs } from './maps';

export interface Districts { cd: number | null; upper: number | null; lower: number | null; schools?: string[]; county?: string | null }
/* A district map that answered at this address: its record and the feature's properties. */
export interface LocalAnswer { meta: MapMeta; props: Record<string, string> }

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
   District {n}" each, Congress first, then the state senate, then the state house, then school
   districts, then what the district maps put on, in ballot order; empty when it put none there
   (nothing here turns on it, or it only took races off). */
export function setFromAddress(b: Ballot, s: BallotState, r: Districts, local: LocalAnswer[] = []): string[] {
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
      if (g.kind) continue;
      const byAddr = (s.addrSet || []).includes(g.key);
      if (s.districts[g.key] && !byAddr) continue; // your own answer stands
      const each = g.members.map((id) => schoolOf(b.byId.get(id)!));
      const one = each[0];
      if (!one || each.some((x) => !x || x.key !== one.key)) continue;
      if (sds.has(one.key)) {
        // Yours after all (a second lookup, the first one the wrong address): the question comes back.
        if (byAddr) { delete s.districts[g.key]; s.addrSet = (s.addrSet || []).filter((k) => k !== g.key); }
        continue;
      }
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
  const localNamed = settleFromMaps(b, s, r, local, sds);
  return [...KINDS.flatMap((k) => named[k].map((o) => `${o}, District ${num(k)}`)), ...schoolsNamed, ...localNamed];
}

/* A race a map put on your ballot, as the line names it: "Austin City Council, District 9",
   "Justice of the Peace, Precinct 5", "State Board of Education, District 5". */
const localName = (c: Contest): string => {
  const office = cleanOffice(c.office).replace(/^Member,\s*/i, '').replace(/\s+Member$/i, '');
  const seat = (c.district || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[A-Z]{2,6}\s+(?=District\b)/, '');
  return seat ? `${office}, ${seat}` : office;
};
/* Whether a race's scope names a county other than this one, and not this one: a Williamson County
   commissioner's race, to a map of Travis County. */
const COUNTY = /\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?) County\b/g;
const scopeNames = (scope: string, text: string): boolean => { try { return new RegExp(scope, 'i').test(text); } catch { return false; } };
function otherCounty(c: Contest, county: string): boolean {
  const named = [...(c.scope_plain || '').matchAll(COUNTY)].map((m) => m[1].toLowerCase());
  return named.length > 0 && !named.includes(county.toLowerCase());
}
/* What the district maps settle. For each rule of each map that answered:
   - a district question whose races the rule claims (every one, or the rest are another county's
     races of the same office, which a map of this county rules out) gets its race, or "none";
   - a "may apply" race the rule claims goes on or off;
   - a school district's trustee race stays with the school logic above when the Census put you in
     another school district.
   A map of one county whose county isn't yours (the Census says so) answers "none" for the races its
   county-scoped rules claim, without looking at the map. Returns the races it put on the ballot. */
function settleFromMaps(b: Ballot, s: BallotState, r: Districts, all: LocalAnswer[], sds: Set<string>): string[] {
  const on: Contest[] = [];
  // A county map that answers for an address the Census puts in another county (a point at the county
  // line) is set aside: the Census's county decides which county's ballot you get.
  const inCounty = (m: MapMeta): boolean => !(m.county && r.county && m.county.toLowerCase() !== r.county.toLowerCase());
  const local = all.filter((x) => inCounty(x.meta));
  const answered = new Set(local.map((x) => x.meta.file));
  const schoolElsewhere = (c: Contest): boolean => { const sd = schoolOf(c); return !!sd && sds.size > 0 && !sds.has(sd.key); };
  const officeOnly = (rule: SettleRule, c: Contest): boolean => ruleMatches({ office: rule.office, district: rule.district }, c);
  const sets: { meta: MapMeta; rule: SettleRule; props: Record<string, string> | null }[] = [];
  for (const x of local) for (const rule of x.meta.settles) sets.push({ meta: x.meta, rule, props: x.props });
  // Another county: only the rules about that county's own races (their scope names the county),
  // never a statewide one or a school district's.
  if (r.county) {
    for (const { meta } of ballotMaps(b)) {
      if (!meta.county || answered.has(meta.file) || meta.county.toLowerCase() === r.county.toLowerCase()) continue;
      for (const rule of meta.settles) if (rule.scope && scopeNames(rule.scope, `${meta.county} County`)) sets.push({ meta, rule, props: null });
    }
  }
  for (const { meta, rule, props } of sets) {
    for (const g of b.groups) {
      if (g.kind) continue; // the Census's
      const members = g.members.map((id) => b.byId.get(id)).filter((c): c is Contest => !!c && c.kind === 'contest');
      const mine = members.filter((c) => ruleMatches(rule, c));
      if (!mine.length) continue;
      const rest = members.filter((c) => !mine.includes(c));
      // The rest must be another county's races of the same office, ruled out because the map says you
      // are in this county. With no answer (you're in another county), the rest may be yours: leave it.
      if (rest.length && (!props || !(meta.county && rest.every((c) => officeOnly(rule, c) && otherCounty(c, meta.county!))))) continue;
      if (mine.some(schoolElsewhere)) continue;
      const hit = props ? mine.find((c) => ruleIs(rule, c, props)) : undefined;
      s.districts[g.key] = hit ? hit.id : 'none';
      s.addrSet = [...(s.addrSet || []).filter((k) => k !== g.key), g.key];
      if (hit && !on.includes(hit)) on.push(hit);
    }
    for (const id of b.mayApply) {
      const c = b.byId.get(id);
      if (!c || c.kind !== 'contest' || !ruleMatches(rule, c) || schoolElsewhere(c)) continue;
      const yes = !!props && ruleIs(rule, c, props);
      s.notMine = s.notMine.filter((x) => x !== id);
      s.mine = (s.mine || []).filter((x) => x !== id);
      (yes ? s.mine : s.notMine).push(id);
      if (yes && !on.includes(c)) on.push(c);
    }
  }
  const at = (c: Contest) => b.order.indexOf(c.id);
  return on.sort((x, y) => at(x) - at(y)).map(localName);
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
