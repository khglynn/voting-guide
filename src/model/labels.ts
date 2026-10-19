/* Names for things on the ledger: row titles, seat labels, courts, and the words for a pick.
   Every one is a rule over the data (or a data field when the research supplies one), never a
   hand list for one ballot, and the sweep checks them on every ballot the guide can show. */
import type { Contest, Item, Measure } from '../types';
import type { Ballot } from '../ballot';
import { S } from '../state';
import { isMultiJudge, isMultiSeat, isRCV, ranksOf } from '../ballot';

/* Parentheticals that add nothing a voter needs on a one-line row. Anything else (a vacancy
   name, a court's county) stays, because it is often the only thing that tells two rows apart. */
const QUIET_PAREN = /\s*\((?:non-?partisan|partisan|countywide|municipal court district|retention|unexpired term|[A-Z]{2,6})\)/gi;

export function cleanOffice(office: string): string {
  return office.replace(QUIET_PAREN, '').replace(/\s+judges? retention$/i, ' judges').replace(/\s{2,}/g, ' ').trim();
}

/* "Circuit Court of Cook County: retain Judge Lewis Nixon?" -> "Circuit Court of Cook County".
   "District Court judge retention" + "18th Judicial District (Arapahoe County)" ->
   "District Court, 18th Judicial District (Arapahoe County)". */
export function courtOf(c: Contest): string {
  const o = c.office.trim();
  const colon = o.match(/^(.*?):\s*(?:retain\b|.*continuance in office)/i);
  if (colon) return colon[1].trim();
  if (/\bjudge retention$/i.test(o)) {
    const base = o.replace(/\s*judges? retention$/i, '').trim();
    const d = (c.district || '').trim();
    return d && !/county court$/i.test(d) ? `${base}, ${d}` : d || base;
  }
  return cleanOffice(o.replace(/\s*\(retention\)\s*$/i, ''));
}
/* Courts grouped for long judge sections: divisions of one court share a heading. */
export function courtGroup(c: Contest): string {
  if (c.is_retention) return courtOf(c).replace(/,\s*Division\s+\d+\s*$/i, '');
  return cleanOffice(c.office).replace(/,\s*(?:Place|Position|No\.)\s*\d+\s*$/i, '');
}

/* A short label that tells repeated offices apart: data's seat_label, else the district. */
export function seatLabel(c: Contest): string | null {
  if (c.seat_label) return c.seat_label;
  let d = (c.district || '').trim();
  if (!d || /^your\b/i.test(d)) return null;
  let extra = '';
  const paren = d.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (paren) {
    d = paren[1].trim();
    if (/county|term\b/i.test(paren[2]) && paren[2].length <= 28) extra = paren[2].trim();
  }
  d = d.split(':')[0].trim();
  d = d.replace(/^(?:CD|SD|HD|AD|LD|[A-Z]{2})-\s*(\d+[A-Z]?)\b\s*/, (_m, n) => `District ${n} `).trim();
  d = d.replace(/^(District \d+[A-Z]?) (Position \d+)/, '$1, $2');
  if (d.length > 40) d = d.split(',')[0].trim();
  if (!d) return null;
  if (c.office.toLowerCase().includes(d.toLowerCase())) return extra || null;
  // "Jefferson County" under a county race in the Jefferson County section says nothing new.
  const b = S.ballot;
  const here = (b ? b.places.flatMap((p) => [p.label, ...p.counties]) : []).map((x) => x.replace(/\s*\(.*\)$/, '').replace(/\s+County$/i, '').toLowerCase());
  if (!extra && here.includes(d.replace(/\s+County( Court)?$/i, '').toLowerCase()) && !/court/i.test(d)) return null;
  return extra ? `${d}, ${extra}` : d;
}

const MEASURE_WORDS = /^(?:ballot (?:issue|question)|question|proposition|prop\.?|amendment|measure|referred question|initiated ordinance|charter amendment|initiative measure no\.?|proposal|local amendment)\s+/i;
/* The bit of a measure number that fits a narrow column: "81", "2G", "NN". Null when the
   number is a phrase ("Cook County advisory question: ...") and should be the title instead. */
export function measureTag(m: Measure): string | null {
  const n = m.number.trim().replace(/\s*\([^)]*\)\s*$/, '');
  const tail = n.replace(MEASURE_WORDS, '');
  if (tail !== n && /^[#]?[A-Z0-9-]{1,9}$/i.test(tail)) return tail.replace(/^#/, '');
  const end = n.match(/\b(?:proposition|prop\.?|amendment|measure|question|issue|proposal)\s+#?([A-Z0-9-]{1,4})$/i);
  return end ? end[1] : null;
}
/* "Ballot Issue 2G" stays; "Cypress-Fairbanks ISD Proposition A" stays; a long advisory
   question title is the number itself. */
export function measureName(m: Measure): string {
  return m.number.trim();
}
const jurisdictionShort = (m: Measure): string => m.jurisdiction.replace(/\s*\([^)]*\)/g, '').replace(/\.\s.*$/, '').split(':')[0].trim();

/* One plain line about what a measure does, for the row under its number. */
export function measureLine(m: Measure): string {
  const s = (m as Measure & { short_title?: string }).short_title || m.plain_summary || m.official_title || '';
  return s.trim();
}

/* ---------- row titles ---------- */
export interface RowTitle { title: string; sub: string | null }
export function rowTitle(it: Item): RowTitle {
  if (it.kind === 'measure') return { title: measureName(it), sub: measureLine(it) || null };
  if (it.is_retention && !isMultiJudge(it) && it.candidates[0]) return { title: it.candidates[0].name, sub: courtOf(it) };
  if (it.is_retention) return { title: courtOf(it), sub: `${it.candidates.length} judges` };
  return { title: cleanOffice(it.office), sub: seatLabel(it) };
}

/* The title on the cheat sheet and in the copied text: one line, unique on this ballot. */
const titleCache = new WeakMap<Ballot, Map<string, string>>();
export function cheatTitle(it: Item): string {
  const b = S.ballot;
  if (!b) return baseCheatTitle(it);
  let m = titleCache.get(b);
  if (!m) { m = uniqueTitles(b); titleCache.set(b, m); }
  return m.get(it.id) || baseCheatTitle(it);
}
function baseCheatTitle(it: Item): string {
  if (it.kind === 'measure') {
    const n = measureName(it);
    const jur = jurisdictionShort(it);
    return it.level !== 'state' && jur && !n.toLowerCase().includes(jur.split(' ')[0].toLowerCase()) && n.length <= 24 ? `${n} (${jur})` : n;
  }
  const r = rowTitle(it);
  if (it.is_retention && !isMultiJudge(it)) return `${r.sub}: ${r.title}`;
  return r.sub ? `${r.title}, ${r.sub}` : r.title;
}
const countyFromScope = (it: Item): string | null => {
  const text = it.kind === 'measure' ? it.jurisdiction : it.scope_plain;
  const m = (text || '').match(/\b([A-Z][a-zA-Z.]+(?: [A-Z][a-zA-Z.]+)?) County\b/);
  return m ? `${m[1]} County` : null;
};
function uniqueTitles(b: Ballot): Map<string, string> {
  const out = new Map<string, string>();
  const by = new Map<string, Item[]>();
  for (const it of b.items) { const t = baseCheatTitle(it); out.set(it.id, t); by.set(t, [...(by.get(t) || []), it]); }
  for (const [t, list] of by) {
    if (list.length < 2) continue;
    const extra = list.map((it) => countyFromScope(it) || (it.kind === 'measure' ? jurisdictionShort(it) : null));
    const distinct = new Set(extra).size === list.length && extra.every(Boolean);
    list.forEach((it, i) => out.set(it.id, distinct ? `${t} (${extra[i]})` : `${t} (${i + 1} of ${list.length})`));
  }
  return out;
}

/* ---------- the words for a pick ---------- */
const candOf = (c: Contest, name: string) => c.candidates.find((k) => k.name === name);
export function pickLabel(it: Item): string | null {
  const p = S.b.picks;
  if (it.kind === 'measure') return p[it.id] === 'YES' ? 'Yes' : p[it.id] === 'NO' ? 'No' : p[it.id] === 'SKIP' ? 'Skipped' : null;
  if (p[it.id] === 'SKIP') return 'Skipped';
  if (isMultiJudge(it)) {
    const y = it.candidates.filter((c) => p[`${it.id}|${c.name}`] === 'YES').length;
    const n = it.candidates.filter((c) => p[`${it.id}|${c.name}`] === 'NO').length;
    const left = it.candidates.length - y - n;
    if (!y && !n) return null;
    // The ballot asks yes or no on each judge, so the cheat sheet says it that way.
    return `Yes on ${y}, No on ${n}${left ? `, ${left} blank` : ''}`;
  }
  if (isRCV(it)) {
    const list = ranksOf(it.id);
    return list.length ? list.map((n, i) => `${i + 1}. ${n}`).join(', ') : null;
  }
  if (isMultiSeat(it)) {
    const names = it.candidates.filter((c) => p[`${it.id}|${c.name}`] === 'PICK');
    return names.length ? names.map((c) => c.name).join(', ') : null;
  }
  const v = p[it.id];
  if (!v || v === 'DONE') return null;
  if (it.is_retention) return v === 'YES' ? 'Yes, keep' : v === 'NO' ? 'No, remove' : v;
  const c = candOf(it, v);
  return c ? `${c.name}${c.party ? ` (${c.party})` : ''}` : v;
}
/* The pick in a narrow column: last names, "Yes", "Keep". */
export function pickShort(it: Item): string | null {
  const p = S.b.picks;
  if (it.kind === 'measure') return p[it.id] === 'YES' ? 'Yes' : p[it.id] === 'NO' ? 'No' : p[it.id] === 'SKIP' ? 'Skipped' : null;
  if (p[it.id] === 'SKIP') return 'Skipped';
  if (isMultiJudge(it)) {
    const y = it.candidates.filter((c) => p[`${it.id}|${c.name}`] === 'YES').length;
    const n = it.candidates.filter((c) => p[`${it.id}|${c.name}`] === 'NO').length;
    if (!y && !n) return null;
    return n ? `Keep ${y}, remove ${n}` : `Keep ${y}`;
  }
  if (isRCV(it)) {
    const list = ranksOf(it.id);
    if (!list.length) return null;
    const first = candOf(it, list[0]);
    return `1. ${first ? first.short : list[0]}${list.length > 1 ? ` +${list.length - 1}` : ''}`;
  }
  if (isMultiSeat(it)) {
    const names = it.candidates.filter((c) => p[`${it.id}|${c.name}`] === 'PICK').map((c) => c.short);
    return names.length ? names.join(', ') : null;
  }
  const v = p[it.id];
  if (!v || v === 'DONE') return null;
  if (it.is_retention) return v === 'YES' ? 'Keep' : v === 'NO' ? 'Remove' : v;
  const c = candOf(it, v);
  return c ? c.short : v;
}

/* Choice words: YES, NO, FOR, AGAINST in sentence case; candidates by their short name. */
const CHOICE: Record<string, string> = { YES: 'Yes', NO: 'No', FOR: 'For', AGAINST: 'Against' };
export function choiceShort(it: Item, choice: string): string {
  if (CHOICE[choice]) return it.kind === 'contest' && it.is_retention ? (choice === 'YES' ? 'Keep' : choice === 'NO' ? 'Remove' : CHOICE[choice]) : CHOICE[choice];
  if (it.kind === 'contest') { const c = candOf(it, choice); if (c) return c.short; }
  return choice;
}

/* Office titles in a district question: "State Senate", plus the options' labels. */
export function optionLabel(c: Contest): [string, string] {
  const label = seatLabel(c) || cleanOffice(c.office);
  const paren = (c.district || '').match(/\(([^)]*)\)\s*$/);
  const hint = paren && !/county|term\b/i.test(paren[1]) ? paren[1] : '';
  return [label, hint];
}
