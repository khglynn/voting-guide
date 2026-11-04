/* Election results on the ballot (Nov 3, results Phase 1): what each row's right column says, what an open row's count
   says, and the figure at the top of the ballot, all from the results Worker's file for the ballot's state. Pure rules
   over the file in memory (`R`, which src/results.ts fills); nothing here fetches, and nothing from results is saved.

   The honesty rules (the workbench's claude-plans/2026-11-03-results/DESIGN.md, section 6) are built in:
   1. Three status words: counting, unofficial (the source itself marked the count complete), official.
   2. No outcome word ("Passed", "won") unless the file carries `final`, which the Worker sets only from the source's
      own complete or official mark. "won" is kept to the open row and the figure.
   3. Progress is the source's own words, quoted. We never compute a percent of precincts.
   4. A county's slice is never shown as the whole: a race across counties names the county whose count it shows,
      and the figure doesn't compare it at all (we never add counties up).
   5. Unmatched is a link, never a guess. Results are ink; gold stays your pick. */
import type { Contest, Item, ItemResult, ResultCand, ResultsFile, ResultsSourceEntry, Measure } from '../types';
import { S } from '../state';
import { isRCV, isMultiSeat, isMultiJudge, status, pageWalk, ranksOf, type SectionKey } from '../ballot';
import { pickShort } from './labels';
import { afterPolls } from './plan';

/* ---------- the file in memory ---------- */
export interface ResultsStore {
  /* the state whose file this is ('' before any) */
  st: string;
  file: ResultsFile | null;
  /* the last fetch of the file failed or returned something unreadable; the last good file stays */
  failed: boolean;
  /* the state has no results file (a 404): nothing about results shows */
  none: boolean;
  /* a Refresh is on its way */
  checking: boolean;
  /* a Refresh found nothing new: the newest source time it still shows ("No change since 9:35 PM CT") */
  nochange: string | null;
}
export const R: ResultsStore = { st: '', file: null, failed: false, none: false, checking: false, nochange: null };
export function resetResults(st = ''): void {
  R.st = st; R.file = null; R.failed = false; R.none = false; R.checking = false; R.nochange = null;
}

/* A file the page will read: this election, this state, items an object, sources a list, every status one we know.
   Anything else is ignored, and the last good file stays. */
const ITEM_ST = ['pending', 'counting', 'complete', 'official', 'link_only'];
const SRC_ST = ['pending', 'counting', 'complete', 'official', 'failing', 'refused', 'link_only'];
const whole = (n: unknown): boolean => typeof n === 'number' && Number.isInteger(n) && n >= 0;
export function readable(f: unknown, st: string): f is ResultsFile {
  if (!f || typeof f !== 'object') return false;
  const x = f as ResultsFile;
  if (x.election !== '2026-11-03' || x.state !== st || typeof x.generated !== 'string') return false;
  if (!Array.isArray(x.sources) || !x.items || typeof x.items !== 'object' || Array.isArray(x.items)) return false;
  if (!x.sources.every((s) => s && typeof s.id === 'string' && typeof s.name === 'string' && SRC_ST.includes(s.status))) return false;
  const nums = (r: { candidates?: ResultCand[]; measure?: { yes: number; no: number } }): boolean =>
    (!r.candidates || (Array.isArray(r.candidates) && r.candidates.every((c) => c && typeof c.name === 'string' && whole(c.votes) && typeof c.pct === 'number')))
    && (!r.measure || (whole(r.measure.yes) && whole(r.measure.no)));
  return Object.values(x.items).every((r) => !!r && typeof r.source === 'string' && ITEM_ST.includes(r.status) && typeof r.url === 'string' && /^https:\/\//.test(r.url)
    && nums(r) && (!r.slices || (Array.isArray(r.slices) && r.slices.every((s) => s && typeof s.county === 'string' && typeof s.url === 'string' && /^https:\/\//.test(s.url) && nums(s)))));
}

/* Results show on a ballot once its polls have closed and the file for its state has been read. */
export const resultsOn = (): boolean => !!S.ballot && !!R.file && R.st === S.ballot.st && afterPolls(S.ballot.howto);
export function resultOf(it: Item): ItemResult | null {
  if (!resultsOn()) return null;
  const r = R.file!.items[it.id];
  // A multi-judge row is one item in the guide and several questions on the ballot: the file has no single answer.
  if (!r || (it.kind === 'contest' && isMultiJudge(it))) return null;
  return r;
}

/* ---------- small rules ---------- */
const total = (r: { candidates?: ResultCand[]; measure?: { yes: number; no: number }; total_votes?: number }): number =>
  r.measure ? r.measure.yes + r.measure.no : (r.candidates || []).reduce((a, c) => a + c.votes, 0);
/* Numbers to show: a count that isn't link_only or pending and has votes in it. */
export const hasNumbers = (r: ItemResult | null): r is ItemResult => !!r && r.status !== 'link_only' && r.status !== 'pending' && total(r) > 0;
export const isLink = (r: ItemResult | null): boolean => !!r && r.status === 'link_only';
/* A race whose voters span counties: its numbers are one county's. */
export const spans = (r: ItemResult): boolean => (r.slices || []).length > 1 || (r.missing || []).length > 0;
export const statusWord = (s: ItemResult['status']): string => (s === 'complete' ? 'unofficial' : s === 'official' ? 'official' : s === 'counting' ? 'counting' : '');
/* "Travis County" from a slice's "Travis". */
export const countyLabel = (c: string): string => {
  const t = c.trim();
  // The Worker's own phrases ("other counties", "Austin's limited-purpose areas (reported apart)") stay as written.
  if (/\b(county|counties|city|parish|borough|district|areas?)\b/i.test(t)) return t.charAt(0).toUpperCase() + t.slice(1);
  return `${t} County`;
};
/* The county whose count a race across counties shows: the slice from the item's own source (the largest). */
export function shownCounty(r: ItemResult): string | null {
  if (!spans(r)) return null;
  const sl = (r.slices || []).find((s) => s.source === r.source) || (r.slices || [])[0];
  return sl ? countyLabel(sl.county) : null;
}
const pctText = (p: number, dp = 0): string => (p > 0 && p < (dp ? 0.1 : 1) ? `<${dp ? '0.1' : '1'}%` : `${(Math.round(p * 10 ** dp) / 10 ** dp).toFixed(dp)}%`);
export const pct0 = (p: number): string => pctText(p, 0);
export const pct1 = (p: number): string => pctText(p, 1);
/* Yes as a share of yes and no, unrounded. */
const yesShare = (m: { yes: number; no: number }): number => (m.yes + m.no ? (m.yes / (m.yes + m.no)) * 100 : 0);
/* A measure's bar to pass, as a percent: the file's own, else the guide's rule when it leads with one. 50 is a plain
   majority. Retention: the file's (the Worker holds each state's), else a plain majority. */
export function thresholdOf(it: Item, r: ItemResult): number {
  if (r.measure && typeof r.measure.threshold === 'number') return r.measure.threshold;
  if (it.kind !== 'measure') return 50;
  const t = (it.pass_threshold || '').trim();
  const p = t.match(/^(\d{2}(?:\.\d+)?)\s*(%|percent)/i);
  if (p) return +p[1];
  if (/^two[- ]thirds\b/i.test(t)) return 200 / 3;
  if (/^three[- ]fifths\b/i.test(t)) return 60;
  return 50;
}
const isMeasureLike = (it: Item): boolean => it.kind === 'measure' || (it.kind === 'contest' && it.is_retention);
/* The guide's name for a candidate in the file ("Paxton" for "Ken Paxton"). */
export function shortOf(it: Item, name: string): string {
  if (it.kind === 'contest') { const k = it.candidates.find((c) => c.name === name); if (k) return k.short; }
  return name.replace(/,?\s+(jr|sr|ii|iii|iv)\.?$/i, '').split(/\s+/).pop() || name;
}
/* The leaders: the top candidate, or every candidate tied at the top. Sorted by votes, whatever order the file has. */
export function leaders(r: ItemResult): ResultCand[] {
  const cs = [...(r.candidates || [])].sort((a, b) => b.votes - a.votes);
  if (!cs.length || cs[0].votes === 0) return [];
  return cs.filter((c) => c.votes === cs[0].votes);
}
const winnersOf = (r: ItemResult): string[] | null => (r.final && 'winners' in r.final ? r.final.winners : null);
const passedOf = (r: ItemResult): boolean | null => (r.final && 'passed' in r.final ? r.final.passed : null);

/* Whether the voter has a pick on this row (a skip is not one). */
export function picked(it: Item): boolean {
  const s = status(it);
  if (s !== 'decided' && s !== 'auto') return false;
  return !!pickShort(it) && pickShort(it) !== 'Left blank';
}
/* The voter's choice as names (or "YES"/"NO"). */
function pickNames(it: Item): string[] {
  const p = S.b.picks;
  if (it.kind === 'measure') return p[it.id] === 'YES' || p[it.id] === 'NO' ? [p[it.id]] : [];
  if (isRCV(it)) return ranksOf(it.id).slice(0, 1);
  if (isMultiSeat(it)) return it.candidates.filter((c) => p[`${it.id}|${c.name}`] === 'PICK').map((c) => c.name);
  return p[it.id] ? [p[it.id]] : [];
}

/* ---------- the row's right column ---------- */
export interface ResCol { main: string; sub: string; pick: string; kind: 'num' | 'none' | 'link' }
export function resCol(it: Item, r: ItemResult): ResCol {
  const pick = picked(it) ? `Your pick: ${pickShort(it)}` : '';
  if (r.status === 'link_only') return { main: 'See election office results', sub: '', pick, kind: 'link' };
  if (!hasNumbers(r)) return { main: 'No numbers posted yet', sub: '', pick, kind: 'none' };
  const word = statusWord(r.status);
  const county = shownCounty(r);
  // A race across counties: the county named in place of the status word ("Travis County count"), since its status
  // is the whole race's, and no number here is the whole.
  const sub0 = county ? `${county} count` : word;
  if (isMeasureLike(it) && r.measure) {
    const y = yesShare(r.measure);
    const t = thresholdOf(it, r);
    const pass = passedOf(r);
    const yes = it.kind === 'measure' ? `Yes ${pct0(y)}` : `Keep the judge: ${pct0(y)}`;
    if (pass !== null && !county) return { main: pass ? 'Passed' : 'Did not pass', sub: `${it.kind === 'measure' ? `Yes ${pct0(y)}` : `Keep ${pct0(y)}`} · ${word}`, pick, kind: 'num' };
    // A bar above a plain majority goes beside the share, or "Yes 53%" reads as passing (Florida, 2024: 57% failed).
    if (t !== 50) return { main: yes, sub: `needs ${pct0(t)}${it.kind === 'measure' ? ' to pass' : ' to stay'}${county ? ` · ${county} count` : ''}`, pick, kind: 'num' };
    if (it.kind === 'measure' && y < 50) return { main: `No ${pct0(100 - y)}`, sub: sub0, pick, kind: 'num' };
    return { main: yes, sub: sub0, pick, kind: 'num' };
  }
  const c = it as Contest;
  const top = leaders(r);
  const cs = [...(r.candidates || [])].sort((a, b) => b.votes - a.votes);
  if (isRCV(c)) return { main: top.length === 1 ? `${shortOf(it, top[0].name)} ${pct0(top[0].pct)}` : 'Tied', sub: 'First choices only', pick, kind: 'num' };
  if (isMultiSeat(c)) {
    const n = r.seats || c.winners || c.vote_for;
    return { main: cs.slice(0, n).map((k) => shortOf(it, k.name)).join(', '), sub: `top ${n} · ${county ? `${county} count` : word}`, pick, kind: 'num' };
  }
  if (top.length > 1) return { main: `Tied: ${top.map((k) => shortOf(it, k.name)).join(', ')}`, sub: sub0, pick, kind: 'num' };
  return { main: `${shortOf(it, top[0].name)} ${pct0(top[0].pct)}`, sub: sub0, pick, kind: 'num' };
}

/* ---------- comparing your pick ---------- */
/* won and lost only from the file's `final`; ahead and behind while counting; `nc` when we can't compare honestly:
   no numbers, a link, a race across counties, ranked choice before its final round, several seats before the count is
   complete, or a tie at the top. */
export type Cmp = 'won' | 'lost' | 'ahead' | 'behind' | 'nc';
export function compare(it: Item, r: ItemResult | null): Cmp {
  if (!hasNumbers(r) || spans(r)) return 'nc';
  const names = pickNames(it);
  if (!names.length) return 'nc';
  if (isMeasureLike(it) && r.measure) {
    const side = it.kind === 'measure' ? names[0] : S.b.picks[it.id];
    if (side !== 'YES' && side !== 'NO') return 'nc';
    const pass = passedOf(r);
    if (pass !== null) return (pass === (side === 'YES')) ? 'won' : 'lost';
    const y = yesShare(r.measure), t = thresholdOf(it, r);
    if (y === t) return 'nc';
    return (y > t) === (side === 'YES') ? 'ahead' : 'behind';
  }
  if (it.kind !== 'contest') return 'nc';
  const w = winnersOf(r);
  if (isRCV(it) || isMultiSeat(it)) {
    if (!w) return 'nc';
    const inW = names.filter((n) => w.includes(n)).length;
    return inW === names.length ? 'won' : inW === 0 ? 'lost' : 'nc';
  }
  if (w) return w.includes(names[0]) ? 'won' : 'lost';
  const top = leaders(r);
  if (top.length !== 1) return top.some((k) => k.name === names[0]) ? 'nc' : 'behind';
  return top[0].name === names[0] ? 'ahead' : 'behind';
}

/* ---------- an open row ---------- */
export interface ResTableRow { name: string; party: string; votes: number; pct: number; mine: boolean; other?: boolean }
export interface ResOpen {
  /* "Counting." and the sentence after it */
  word: string; line: string;
  rows: ResTableRow[];
  /* the feed's names we couldn't match to the guide's, listed rather than dropped */
  unmatched: string[];
}
const isWriteIn = (it: Item, name: string): boolean => it.kind === 'contest' && !!it.candidates.find((k) => k.name === name && (k.parties.includes('Write-in') || /^write-?in$/i.test(k.party || '')));
const WORD: Record<string, string> = { counting: 'Counting.', complete: 'Unofficial.', official: 'Official.' };
export function resOpen(it: Item, r: ItemResult): ResOpen {
  const word = WORD[r.status] || '';
  const county = shownCounty(r);
  // A race across counties speaks for one county's count only, and says so first (rule 9).
  const lead = county ? `In ${county}’s count, ` : '';
  const low = (t: string): string => (lead ? t.charAt(0).toLowerCase() + t.slice(1) : t);
  const out: ResOpen = { word, line: '', rows: [], unmatched: [...(r.unmatched || [])] };
  if (isMeasureLike(it) && r.measure) {
    const y = yesShare(r.measure), t = thresholdOf(it, r), pass = passedOf(r);
    const judge = it.kind !== 'measure';
    const p = S.b.picks[it.id];
    out.rows = [
      { name: judge ? 'Keep' : 'Yes', party: '', votes: r.measure.yes, pct: r.measure.yes_pct, mine: p === 'YES' },
      { name: judge ? 'Remove' : 'No', party: '', votes: r.measure.no, pct: 100 - r.measure.yes_pct, mine: p === 'NO' },
    ];
    const bar = t !== 50 ? ` It needs ${pct0(t)} yes to ${judge ? 'stay' : 'pass'}.` : '';
    if (pass !== null && !county) out.line = judge ? (pass ? 'The judge stays.' : 'The judge does not stay.') : pass ? 'It passed.' : 'It did not pass.';
    else if (r.status === 'counting' || county) out.line = `${lead}${y === t ? (lead ? 'yes and no are even so far.' : 'Yes and no are even so far.') : y > t ? `${judge ? 'keep' : 'yes'} is ahead so far.` : `${judge ? 'remove' : 'no'} is ahead so far.`}${bar}`.replace(/^([a-z])/, (m) => m.toUpperCase());
    else out.line = `The office marks the count complete.${bar}`;
    return out;
  }
  const c = it as Contest;
  const names = new Set(pickNames(it));
  const cs = [...(r.candidates || [])].sort((a, b) => b.votes - a.votes);
  const party = (n: string): string => (c.candidates.find((k) => k.name === n)?.party || '');
  const wi = cs.filter((k) => isWriteIn(it, k.name) && !names.has(k.name));
  const main = wi.length >= 2 ? cs.filter((k) => !wi.includes(k)) : cs;
  out.rows = main.map((k) => ({ name: k.name, party: party(k.name), votes: k.votes, pct: k.pct, mine: names.has(k.name) }));
  if (wi.length >= 2) out.rows.push({ name: `Write-ins combined (${wi.length} candidates)`, party: '', votes: wi.reduce((a, k) => a + k.votes, 0), pct: wi.reduce((a, k) => a + k.pct, 0), mine: false, other: true });
  // Votes in the count that aren't any name in the guide (a feed's own write-in line): shown, so the shares add up.
  const rest = (r.total_votes || 0) - cs.reduce((a, k) => a + k.votes, 0);
  if (rest > 0 && r.total_votes) out.rows.push({ name: 'Other names and write-ins', party: '', votes: rest, pct: (rest / r.total_votes) * 100, mine: false, other: true });
  const top = leaders(r);
  const w = winnersOf(r);
  if (isRCV(c)) {
    out.line = w ? `${w.map((n) => shortOf(it, n)).join(' and ')} won.` : 'First choices only. Ranked choice counts go in rounds, so the winner can be someone other than the first-choice leader.';
    return out;
  }
  if (w && !county) { out.line = `${w.map((n) => shortOf(it, n)).join(', ').replace(/, ([^,]*)$/, ' and $1')} won.`; return out; }
  if (isMultiSeat(c)) {
    const n = r.seats || c.winners || c.vote_for;
    out.line = `Fills ${n} seats. ${lead}${low(r.status === 'counting' || county ? `The top ${n} so far` : `The top ${n}`)}: ${cs.slice(0, n).map((k) => shortOf(it, k.name)).join(', ')}.`;
    return out;
  }
  if (top.length > 1) out.line = `${lead}${top.map((k) => shortOf(it, k.name)).join(' and ')} are tied${r.status === 'counting' || county ? ' so far' : ''}.`;
  else if (r.status === 'counting' || county) out.line = `${lead}${shortOf(it, top[0].name)} is ahead so far.`;
  else out.line = `${shortOf(it, top[0].name)} has the most votes. The office marks the count complete.`;
  return out;
}

/* ---------- times ---------- */
const ZONE_ABBR: Record<string, string> = { 'America/New_York': 'ET', 'America/Detroit': 'ET', 'America/Chicago': 'CT', 'America/Denver': 'MT', 'America/Boise': 'MT', 'America/Phoenix': 'MT', 'America/Los_Angeles': 'PT' };
const zoneOf = (): string | null => S.ballot?.howto.zones?.[0] || null;
/* "9:42 PM CT", in the place's own zone; another day than Election Day adds the date ("Nov 4, 9:42 AM CT"). */
export function fmtTime(iso: string | null | undefined, zone: string | null = zoneOf()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const tz = zone || undefined;
  try {
    const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
    const day = d.toLocaleDateString('en-CA', { timeZone: tz });
    const date = day !== (S.ballot?.howto.election_date || '2026-11-03') ? `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz })}, ` : '';
    const ab = zone ? ZONE_ABBR[zone] || '' : '';
    return `${date}${t}${ab ? ` ${ab}` : ''}`;
  } catch { return ''; }
}

/* ---------- the sources behind this ballot's numbers ---------- */
export function ballotSources(): ResultsSourceEntry[] {
  if (!resultsOn()) return [];
  const ids = new Set<string>();
  for (const it of S.ballot!.items) {
    const r = R.file!.items[it.id];
    if (!r) continue;
    ids.add(r.source);
    for (const s of r.slices || []) ids.add(s.source);
  }
  return R.file!.sources.filter((s) => ids.has(s.id));
}
/* A source we couldn't reach. A link-only source (not checked yet, a link by design) is never "down" here: its rows are
   links, and its fetch failing says nothing about numbers we show. */
export const sourceDown = (s: ResultsSourceEntry): boolean => s.status !== 'link_only' && (!!s.failing_since || s.status === 'failing');
/* The source's own banner words, quoted ("“Early Voting Totals Only.”"), or ''. */
export const labelWords = (s: ResultsSourceEntry | undefined): string => {
  const l = (s?.labels || []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().replace(/\.$/, ''));
  return l.length ? ` “${l.slice(0, 2).join('. ')}.”` : '';
};
export const sourceName = (id: string): string => R.file?.sources.find((s) => s.id === id)?.name || 'The election office';
/* "We checked: 9:42 PM CT", or per source on a ballot across counties ("We checked Travis County: 9:42 PM CT ·
   Williamson County: 9:41 PM CT"). Each time is when our fetcher last read that source, never the page's own load. */
export function checkedLine(srcs = ballotSources()): string {
  const read = srcs.filter((s) => s.fetched && s.status !== 'link_only' && !sourceDown(s));
  if (!read.length) return '';
  const times = [...new Set(read.map((s) => fmtTime(s.fetched)))];
  if (times.length === 1) return `We checked: ${times[0]}`;
  return `We checked ${read.map((s) => `${s.name}: ${fmtTime(s.fetched)}`).join(' · ')}`;
}
/* Each source in its own words: "Travis County updated: 9:35 PM CT. “120 of 200 precincts reporting.”", or
   "Couldn't reach Travis County. Showing its 9:12 PM CT numbers." */
export function sourceLines(srcs = ballotSources()): string[] {
  return srcs.filter((s) => s.status !== 'link_only').map((s) => {
    if (sourceDown(s)) return `Couldn’t reach ${s.name}. Showing its ${s.updated ? `${fmtTime(s.updated)} ` : 'last '}numbers.`;
    if (s.status === 'refused') return `${s.name} isn’t letting us read its results. See its own page.`;
    const when = s.updated ? `${s.name} updated: ${fmtTime(s.updated)}.` : `${s.name}: source update time unavailable.`;
    return `${when}${labelWords(s)}${s.reporting ? ` “${s.reporting.replace(/\.$/, '')}.”` : ''}`;
  });
}
/* The newest source time we hold, for "No change since 9:35 PM CT". */
export function newestUpdate(srcs = ballotSources()): string {
  const t = srcs.map((s) => s.updated || s.fetched || '').filter(Boolean).sort().pop();
  return t ? fmtTime(t) : '';
}
/* What each source's fetch time is, to tell a Refresh that really read something from one that didn't. */
export const fetchedSig = (f: ResultsFile | null): string => (f ? f.sources.map((s) => `${s.id}:${s.fetched || ''}`).join('|') : '');

/* ---------- the figure ---------- */
export type DotKind = 'up' | 'down' | 'wp' | 'po' | 'w';
export interface Dot { id: string; sec: SectionKey; pick: boolean; cmp: Cmp; kind: DotKind; posted: boolean; why: '' | 'rcv' | 'multi' | 'span' | 'tie' }
export interface Figure {
  word: 'Counting' | 'Unofficial' | 'Official';
  explain: string;
  rows: { sec: SectionKey; dots: Dot[] }[];
  picks: number;
  counts: Record<Cmp, number>;
  others: number;
  othersKinds: { races: number; measures: number };
  posted: number; total: number;
  questions: { n: number; first: string | null };
  notes: string[];
}
export function figure(): Figure | null {
  if (!resultsOn()) return null;
  const b = S.ballot!;
  const walk = pageWalk().filter((x) => !x.folded);
  const rows: Figure['rows'] = [];
  const counts: Record<Cmp, number> = { won: 0, lost: 0, ahead: 0, behind: 0, nc: 0 };
  const why = new Set<string>();
  let others = 0, posted = 0, total = 0;
  const kinds = { races: 0, measures: 0 };
  let qn = 0; let first: string | null = null;
  const sts: ItemResult['status'][] = [];
  for (const x of walk) {
    if (x.question) { if (!x.done) { qn++; first = first || x.key; } continue; }
    const it = b.byId.get(x.key);
    if (!it) continue;
    const r = resultOf(it);
    if (r && r.status !== 'link_only') sts.push(r.status);
    const pick = picked(it);
    const cmp = pick ? compare(it, r) : 'nc';
    const num = hasNumbers(r);
    total++;
    if (num) posted++;
    let w: Dot['why'] = '';
    if (pick && cmp === 'nc' && num) {
      w = spans(r!) ? 'span' : it.kind === 'contest' && isRCV(it) ? 'rcv' : it.kind === 'contest' && isMultiSeat(it) ? 'multi' : 'tie';
      why.add(w);
    }
    const kind: DotKind = pick ? (cmp === 'won' || cmp === 'ahead' ? 'up' : cmp === 'lost' || cmp === 'behind' ? 'down' : 'wp') : num ? 'po' : 'w';
    if (pick) counts[cmp]++; else { others++; if (it.kind === 'measure') kinds.measures++; else kinds.races++; }
    const dot: Dot = { id: it.id, sec: x.sec, pick, cmp, kind, posted: num, why: w };
    const last = rows[rows.length - 1];
    if (last && last.sec === x.sec) last.dots.push(dot); else rows.push({ sec: x.sec, dots: [dot] });
  }
  const live = sts.filter((s) => s !== 'pending');
  const word: Figure['word'] = !live.length || sts.some((s) => s === 'counting' || s === 'pending') ? 'Counting' : live.every((s) => s === 'official') ? 'Official' : 'Unofficial';
  const explain = !live.length ? 'No numbers posted yet. Election offices post as they count.'
    : word === 'Counting' ? 'Election offices are still counting, so these numbers will change.'
    : word === 'Unofficial' ? 'The election offices marked their counts complete. They become official later.'
    : 'The election offices made these counts official.';
  const notes: string[] = [];
  if (why.has('rcv')) notes.push('Ranked choice races aren’t compared until the final round.');
  if (why.has('multi')) notes.push('Races that fill more than one seat aren’t compared until the count is complete.');
  if (why.has('span')) notes.push('Races across county lines aren’t compared: each county posts its own count, and we don’t add them up.');
  if (why.has('tie')) notes.push('A race tied at the top isn’t compared.');
  return { word, explain, rows, picks: Object.values(counts).reduce((a, n) => a + n, 0), counts, others, othersKinds: kinds, posted, total, questions: { n: qn, first }, notes };
}
/* "Your 25 picks: 15 ahead · 9 behind · 1 we can't compare yet" */
export function countLine(f: Figure): string {
  if (!f.picks) return '';
  const c = f.counts;
  const parts = [
    c.won ? `${c.won} won` : '', c.ahead ? `${c.ahead} ahead` : '', c.lost ? `${c.lost} didn’t win` : '', c.behind ? `${c.behind} behind` : '',
    c.nc ? `${c.nc} we can’t compare yet` : '',
  ].filter(Boolean);
  return `Your ${f.picks === 1 ? '1 pick' : `${f.picks} picks`}: ${parts.join(' · ')}`;
}
export function othersLine(f: Figure): string {
  if (!f.others) return '';
  const { races, measures } = f.othersKinds;
  const what = races && measures ? 'races and measures' : measures ? (measures === 1 ? 'measure' : 'measures') : races === 1 ? 'race' : 'races';
  return `${f.others} other ${what}${f.picks ? '' : ''}`;
}
/* The open row's line about one dot, for the figure's list: "Paxton 51% · your pick Talarico". */
export function dotLine(it: Item): string {
  const r = resultOf(it);
  const pk = picked(it) ? pickShort(it) : null;
  if (!r) return pk ? `Not in this guide’s results · your pick ${pk}` : 'Not in this guide’s results';
  const col = resCol(it, r);
  const main = col.kind === 'num' ? `${col.main}${col.sub ? ` ${col.sub}` : ''}` : col.main;
  return `${main}${pk ? ` · your pick ${pk}` : ''}`;
}
export type { Measure };
