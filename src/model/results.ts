/* Election results on the ballot (Nov 3, results Phase 1): what each row's right column says, what an open row's count
   says, and the figure at the top of the ballot, all from the results Worker's file for the ballot's state. Pure rules
   over the file in memory (`R`, which src/results.ts fills); nothing here fetches, and nothing from results is saved.

   The honesty rules (the workbench's claude-plans/2026-11-03-results/DESIGN.md, section 6) are built in:
   1. Three status words: counting, unofficial (the source itself marked the count complete), official.
   2. No outcome word ("Passed", "won") unless the file carries `final`, which the Worker sets only from the source's
      own complete or official mark. "won" is kept to the open row and the figure.
   3. Progress is the source's own words, quoted. We never compute a percent of precincts.
   4. A county's slice is never shown as the whole: a race across counties names the county whose count it shows, and
      we never add counties up. The figure compares such a race only where the counties we hold carry it, by which way
      every county count we hold leans, never as won or lost (acrossCounties, Nov 5). A statewide race held only as county shares
      shows a county's share only on that county's ballots; elsewhere it's the state's own page (viewFor).
   5. Unmatched is a link, never a guess. Results are ink; gold stays your pick. */
import type { Contest, Item, ItemResult, ResultCand, ResultSlice, ResultsFile, ResultsSourceEntry, ResultsSource, Measure } from '../types';
import { S } from '../state';
import { isRCV, isMultiSeat, isMultiJudge, isPartisan, isMaybe, status, pageWalk, ranksOf, type SectionKey } from '../ballot';
import { lineup, agreed } from './tally';
import { chipMembers, CHIPS, type ChipKey } from './lens';
import { pickShort } from './labels';
import { todayISO } from '../util';
import { afterPolls, countyKey } from './plan';

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

/* Results mode (overnight, Nov 3): the ballot's polls have closed. From then on a row's right column speaks about
   results only, never the sources' tally, file or no file (Kevin's 9:24 PM screenshot: Colorado's amendments still read
   "No 6, Yes 1 / picks split" because the state's count wasn't in the file yet). The tally lives in the open row. */
export const resultsMode = (): boolean => !!S.ballot && afterPolls(S.ballot.howto);
/* Results show on a ballot once its polls have closed and the file for its state has been read. */
export const resultsOn = (): boolean => !!S.ballot && !!R.file && R.st === S.ballot.st && afterPolls(S.ballot.howto);
export function resultOf(it: Item): ItemResult | null {
  if (!resultsOn()) return null;
  const r = R.file!.items[it.id];
  // A multi-judge row is one item in the guide and several questions on the ballot: the file has no single answer.
  if (!r || (it.kind === 'contest' && isMultiJudge(it))) return null;
  return viewFor(it, r);
}
/* Still waiting on the first read of this state's file (nothing to say yet, not even "not posted"). */
export const resultsWaiting = (): boolean => resultsMode() && !!(S.ballot!.howto.results?.sources || []).length
  && (R.st !== S.ballot!.st || (!R.file && !R.none && !R.failed));

/* ---------- small rules ---------- */
function total(r: { candidates?: ResultCand[]; measure?: { yes: number; no: number }; total_votes?: number }): number {
  return r.measure ? r.measure.yes + r.measure.no : (r.candidates || []).reduce((a, c) => a + c.votes, 0);
}
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
/* The county whose count a race across counties shows: the slice from the item's source (viewOf picks it). */
export function shownCounty(r: ItemResult): string | null {
  if (!spans(r)) return null;
  const sl = (r.slices || []).find((s) => s.source === r.source) || (r.slices || [])[0];
  return sl ? countyLabel(sl.county) : null;
}
/* The same county, briefly, for the row's column ("Travis count"): the Worker's own phrases stay whole. */
export const shortCounty = (c: string): string => c.replace(/\s+County$/i, '');
const bare = (c: string): string => c.replace(/\s*\(.*?\)\s*/g, ' ').trim();
const sliceHas = (s: ResultSlice): boolean => s.status !== 'link_only' && s.status !== 'pending' && total(s) > 0;
/* The voter's county: the address lookup's or the ZIP's (ballot.county), else the first county the ballot's first
   place lists (Travis for Austin). Null on a statewide-only ballot. */
export function homeCounty(): string | null {
  const b = S.ballot;
  if (!b) return null;
  return b.county || b.places[0]?.counties?.[0] || null;
}
/* A race across counties shows one county's count, named (rule 9). Which county (overnight brief, after Kevin's 9:09 PM
   screenshot of ACC trustee reading "Williamson County count" on an Austin ballot): the voter's own county when its
   slice has numbers, else the Worker's pick (the largest county), else the largest slice that has numbers. The item
   comes back with that slice's numbers, words, time and link in its place, but the race's own status: a county that
   finished counting never makes the race read "Unofficial." while other counties count (Opus review, Nov 4). Its
   slices and missing stay, so it still spans: never called, and compared only as acrossCounties allows. Only when the
   item's own source is one of its slices: a whole-race count (a state's) is never swapped for a county's piece of it. */
export function viewOf(r: ItemResult): ItemResult {
  const sl = r.slices || [];
  if (!spans(r) || !sl.some((x) => x.source === r.source)) return r;
  const home = homeCounty();
  const k = home ? countyKey(bare(home)) : null;
  const mine = k ? sl.find((x) => countyKey(bare(x.county)) === k && sliceHas(x)) : undefined;
  const own = sl.find((x) => x.source === r.source);
  const pick = mine || (own && sliceHas(own) ? own : undefined) || [...sl].filter(sliceHas).sort((a, b) => total(b) - total(a))[0];
  return pick ? withSlice(r, pick) : r;
}
/* The item with one county's slice in its place (viewOf says what stays the race's own). */
function withSlice(r: ItemResult, pick: ResultSlice): ItemResult {
  if (pick.source === r.source) return r;
  return {
    ...r, source: pick.source, reporting: pick.reporting, updated: pick.updated, url: pick.url,
    total_votes: pick.total_votes, candidates: pick.candidates, measure: pick.measure, seats: pick.seats ?? r.seats,
    unmatched: pick.unmatched, note: [r.note, pick.note].filter(Boolean).join(' ') || undefined, final: null, rounds: undefined,
  };
}
const pctText = (p: number, dp = 0): string => (p > 0 && p < (dp ? 0.1 : 1) ? `<${dp ? '0.1' : '1'}%` : `${(Math.round(p * 10 ** dp) / 10 ** dp).toFixed(dp)}%`);
export const pct0 = (p: number): string => pctText(p, 0);
export const pct1 = (p: number): string => pctText(p, 1);
/* Yes as a share of yes and no, unrounded. */
const yesShare = (m: { yes: number; no: number }): number => (m.yes + m.no ? (m.yes / (m.yes + m.no)) * 100 : 0);
/* A measure's bar to pass, as a fraction of the yes-and-no vote (n/d): the file's own percent, else the guide's rule when
   it leads with one (a majority is 1/2, two-thirds 2/3). Retention: the file's (the Worker holds each state's), else a
   plain majority. Null when the rule isn't a share of yes and no (Tennessee's amendments also count the governor's race;
   an either-or question): then nothing here says which side is ahead (Codex, Nov 3). */
export interface Bar { n: number; d: number; pct: number }
export function barOf(it: Item, r: ItemResult): Bar | null {
  if (r.measure && typeof r.measure.threshold === 'number' && r.measure.threshold > 0 && r.measure.threshold < 100) return { n: r.measure.threshold, d: 100, pct: r.measure.threshold };
  if (it.kind !== 'measure') return { n: 1, d: 2, pct: 50 };
  const t = (it.pass_threshold || '').trim();
  if (/^(a\s+)?(simple\s+)?majority\b/i.test(t) || !t) return { n: 1, d: 2, pct: 50 };
  const p = t.match(/^(\d{2}(?:\.\d+)?)\s*(%|percent)/i);
  if (p) return { n: +p[1], d: 100, pct: +p[1] };
  if (/^two[- ]thirds\b/i.test(t)) return { n: 2, d: 3, pct: 200 / 3 };
  if (/^three[- ]fifths\b/i.test(t)) return { n: 3, d: 5, pct: 60 };
  return null;
}
export const thresholdOf = (it: Item, r: ItemResult): number | null => barOf(it, r)?.pct ?? null;
/* Which side the count favors against the bar, by whole counts (cross-multiplied, so 55 of 100 against 55% is exactly
   at the bar, never a float's guess): 'yes', 'no', 'at' (exactly at the bar), or null with no rule we hold. */
export function sideOf(it: Item, r: ItemResult): 'yes' | 'no' | 'at' | null {
  const b = barOf(it, r);
  if (!b || !r.measure) return null;
  const lhs = r.measure.yes * b.d, rhs = b.n * (r.measure.yes + r.measure.no);
  return lhs > rhs ? 'yes' : lhs < rhs ? 'no' : 'at';
}
const plainBar = (b: Bar | null): boolean => !!b && b.n * 2 === b.d;
/* A yes share beside its bar: within a point of it, one decimal cut down (never rounded up), so 59.6% against 60% never
   reads "60%" and 54.96% never reads "55.0%" (adversarial pass, Nov 3). */
export const pctNear = (y: number, b: Bar | null): string => (b && !plainBar(b) && Math.abs(y - b.pct) < 1 ? `${(Math.floor(y * 10) / 10).toFixed(1)}%` : pct0(y));
/* Votes in the count for names the guide doesn't hold (unmatched names, a feed's write-in line). When they could match
   the leader, we can't honestly say who leads (rule 8). */
export const otherVotes = (r: ItemResult): number => Math.max(0, (r.total_votes || 0) - (r.candidates || []).reduce((a, c) => a + c.votes, 0));
export const unknownLead = (r: ItemResult): boolean => { const top = leaders(r); return !!top.length && otherVotes(r) >= top[0].votes; };
/* A block vote that elects everyone either way (Dallas's "Uncontested Races": "Vote for All" or "Vote for None"). */
const blockVote = (it: Item): boolean => it.kind === 'contest' && it.candidates.some((k) => /^vote for (all|none)\b/i.test(k.name));
const isMeasureLike = (it: Item): boolean => it.kind === 'measure' || (it.kind === 'contest' && it.is_retention);
/* The guide's name for a candidate in the file ("Paxton" for "Ken Paxton"). */
export function shortOf(it: Item, name: string): string {
  if (/^vote for /i.test(name)) return name;
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

/* ---------- the offices ---------- */
/* The ballot's row in data/results-sources.json for a source id (the place bundles carry them, voter's county first). */
const rowFor = (id: string): ResultsSource | undefined => (S.ballot?.howto.results?.sources || []).find((x) => x.id === id);
/* An office's short name: the row's label ("Travis County", "Texas", "DC"), else the file's name for it. */
export const officeShort = (id: string): string => rowFor(id)?.label || R.file?.sources.find((s) => s.id === id)?.name || 'Official';
/* What a link to an office's results says: "Travis County results", "Texas results". */
export const officeText = (id: string): string => `${officeShort(id)} results`;
const httpsOK = (u: string | null | undefined): u is string => !!u && /^https:\/\//i.test(u.trim());
/* Where a row with nothing in the file sends you (overnight): a race in the state's file to the state's results, the
   rest to the voter's county's (the ballot's first county row), else whatever results page the ballot has. */
export function officeFor(it: Item): { url: string; text: string } | null {
  const b = S.ballot;
  if (!b) return null;
  const rows = (b.howto.results?.sources || []).filter((x) => httpsOK(x.results_url));
  const state = rows.find((x) => x.kind === 'state'), county = rows.find((x) => x.kind === 'county');
  const r = b.statewide.has(it.id) ? state || county : county || state;
  if (r) return { url: r.results_url, text: `${r.label || r.name} results` };
  return httpsOK(b.howto.results_url) ? { url: b.howto.results_url!, text: `${b.howto.results_source || b.stateName} results` } : null;
}

/* ---------- a statewide race held only as county shares ----------
   Rule 9 as amended Nov 4: where the state's own site turns us away, a county's count may carry a statewide race, named
   as that county's and never as the whole race (Los Angeles County's for California's statewide races, Philadelphia's
   and Allegheny's for Pennsylvania's governor). Such a share is about the voters of that county only, so it shows only
   on a ballot in that county; anywhere else ("Los Angeles votes only" on a San Diego voter's governor row) the row is
   the state's own page, as for any race we can't read. */
/* A race every voter in the state sees (a statewide office, or a measure in the state's file), counted here by counties
   only: the item is one of its own county slices. A statewide race with the state's own count isn't one (the Worker
   keeps that count whole, its counties never in `slices`), and neither is a local race across county lines. */
export function sharesOnly(it: Item, r: ItemResult): boolean {
  const b = S.ballot;
  if (!b || !b.statewide.has(it.id) || !(it.kind === 'measure' || (it.kind === 'contest' && it.every))) return false;
  return spans(r) && (r.slices || []).some((x) => x.source === r.source);
}
/* The counties this ballot's voter is in, as far as the guide knows: the address lookup's county (this visit), else
   the ZIP's (ballot.county), else every county the ballot's places list. None on a statewide-only ballot before a
   lookup. */
function ballotCounties(): string[] {
  const b = S.ballot;
  if (!b) return [];
  const known = (S.ui.addrCounty || b.county || '').trim();
  return known ? [known] : b.places.flatMap((p) => p.counties || []);
}
/* The ballot's state row in data/results-sources.json, when its results page passes the rows' https-only guard. */
export function stateRow(): ResultsSource | undefined {
  return (S.ballot?.howto.results?.sources || []).find((x) => x.kind === 'state' && httpsOK(x.results_url));
}
/* What a row shows from the file's item: a statewide race held only as county shares shows the share of a county this
   ballot is in, else the state's own page as a link (no state page: nothing, so the row is a race the file doesn't
   hold, noResCol). Every other race: viewOf. */
export function viewFor(it: Item, r: ItemResult): ItemResult | null {
  if (!sharesOnly(it, r)) return viewOf(r);
  const sl = r.slices || [];
  const mine = ballotCounties().map((c) => sl.find((x) => countyKey(bare(x.county)) === countyKey(bare(c)) && sliceHas(x))).find(Boolean);
  if (mine) return withSlice(r, mine);
  const st = stateRow();
  return st ? { source: st.id, status: 'link_only', reporting: null, updated: null, url: st.results_url, final: null } : null;
}

/* ---------- the row's right column ----------
   One short state per row (overnight, Kevin: "see election office results" was "unclear and wordy and misplaced in some
   spots and hard to act on"): the leader and share with the status word or the county whose count it is; "Not posted
   yet" while the office hasn't posted (its expected time is in the open row); or, where the office posts the race but
   we don't show it here, a real link named for the office ("Travis County results"). "Your pick" only beside numbers,
   never stacked under a non-answer, and just "Your pick" when it's the name right above it. */
export interface ResCol { main: string; sub: string; pick: string; kind: 'num' | 'none' | 'link' | 'wait'; url?: string; area?: string }
const linkCol = (text: string, url: string): ResCol => ({ main: text, sub: '', pick: '', kind: 'link', url });
export function resCol(it: Item, r: ItemResult): ResCol {
  if (r.status === 'link_only') return linkCol(officeText(r.source), r.url);
  if (!hasNumbers(r)) return { main: 'Not posted yet', sub: '', pick: '', kind: 'none' };
  const col = numCol(it, r);
  // A race across counties: the status word stays (it's the whole race's), and a line under it says the numbers are one
  // county's votes (Opus review, Nov 4: "Travis only" read as "this race is only in Travis"; GPT chose the words).
  const county = shownCounty(r);
  if (county && col.kind === 'num') col.area = `${shortCounty(county)} votes only`;
  const pk = picked(it) ? pickShort(it) : '';
  if (col.kind === 'num' && pk) col.pick = col.main.startsWith(`${pk} `) && !col.main.includes(',') ? 'Your pick' : `Your pick: ${pk}`;
  return col;
}
/* The column when the file has nothing for this row, once the polls have closed: "Checking…" until the first read of
   the state's file, then a link to the office that posts it (a state with no file at all, Colorado's amendments before
   the state's count was in). Null before the polls close: the sources' tally, as before. */
export function noResCol(it: Item): ResCol | null {
  if (!resultsMode()) return null;
  if (resultsWaiting()) return { main: 'Checking…', sub: '', pick: '', kind: 'wait' };
  const o = officeFor(it);
  return o ? linkCol(o.text, o.url) : { main: 'Not in this guide', sub: '', pick: '', kind: 'none' };
}
function numCol(it: Item, r: ItemResult): ResCol {
  const pick = '';
  const word = statusWord(r.status);
  const county = shownCounty(r);
  // The status word is the whole race's (viewOf keeps it); resCol adds the county line for a race across counties.
  const sub0 = word;
  if (isMeasureLike(it) && r.measure) {
    const y = yesShare(r.measure);
    const b = barOf(it, r);
    const pass = passedOf(r);
    const judge = it.kind !== 'measure';
    const yes = !judge ? `Yes ${pctNear(y, b)}` : `Keep the judge: ${pctNear(y, b)}`;
    const need = b && !plainBar(b) ? ` · needs ${pct0(b.pct)}` : '';
    if (pass !== null && !county) return { main: judge ? (pass ? 'Stays' : 'Doesn’t stay') : pass ? 'Passed' : 'Did not pass', sub: `${judge ? 'Keep' : 'Yes'} ${pctNear(y, b)}${need} · ${word}`, pick, kind: 'num' };
    // A bar above a plain majority goes beside the share, or "Yes 53%" reads as passing (Florida, 2024: 57% failed).
    if (b && !plainBar(b)) return { main: yes, sub: `needs ${pct0(b.pct)}${judge ? ' to stay' : ' to pass'} · ${sub0}`, pick, kind: 'num' };
    // No rule we hold: the yes share alone, never "No N%" as if no were winning.
    if (b && it.kind === 'measure' && sideOf(it, r) === 'no') return { main: `No ${pct0(100 - y)}`, sub: sub0, pick, kind: 'num' };
    return { main: yes, sub: sub0, pick, kind: 'num' };
  }
  const c = it as Contest;
  const top = leaders(r);
  const cs = [...(r.candidates || [])].sort((a, b) => b.votes - a.votes);
  const w = winnersOf(r);
  // A name we couldn't match could be leading: no leader named (rule 8); the column is the office's page, and the open
  // row says why.
  if (!w && unknownLead(r)) return linkCol(officeText(r.source), r.url);
  // Ranked choice: first choices until the file names the winner after the final round (the column never says "won").
  if (isRCV(c)) return w && !county ? { main: w.map((n) => shortOf(it, n)).join(', '), sub: `final round · ${word}`, pick, kind: 'num' } : { main: top.length === 1 ? `${shortOf(it, top[0].name)} ${pct0(top[0].pct)}` : 'Tied', sub: 'First choices only', pick, kind: 'num' };
  if (isMultiSeat(c)) {
    const n = r.seats || c.winners || c.vote_for;
    return { main: cs.slice(0, n).map((k) => shortOf(it, k.name)).join(', '), sub: `top ${n} · ${sub0}`, pick, kind: 'num' };
  }
  if (top.length > 1) return { main: `Tied: ${top.map((k) => shortOf(it, k.name)).join(', ')}`, sub: sub0, pick, kind: 'num' };
  return { main: `${shortOf(it, top[0].name)} ${pct0(top[0].pct)}`, sub: sub0, pick, kind: 'num' };
}

/* ---------- comparing your pick ---------- */
/* won and lost only from the file's `final`; ahead and behind while counting; `nc` when we can't compare honestly:
   no numbers, a link, a race across counties we hold only part of or whose counties lean apart (acrossCounties), ranked choice before
   its final round, several seats before the count is complete, or a tie at the top. */
export type Cmp = 'won' | 'lost' | 'ahead' | 'behind' | 'nc';
export function compare(it: Item, r: ItemResult | null): Cmp {
  return compareNames(it, r, pickNames(it));
}
/* The same comparison for any set of names: your picks, or a group's or a party's (the card's "Compare with"). For a
   measure or a judge, the names are "YES" or "NO". */
export function compareNames(it: Item, r: ItemResult | null, names: string[]): Cmp {
  if (!hasNumbers(r) || !names.length) return 'nc';
  if (spans(r)) return acrossCounties(it, r, names).cmp;
  if (isMeasureLike(it) && r.measure) {
    const side = names[0];
    if (side !== 'YES' && side !== 'NO') return 'nc';
    const pass = passedOf(r);
    if (pass !== null) return (pass === (side === 'YES')) ? 'won' : 'lost';
    const at = sideOf(it, r);
    if (at === null || at === 'at') return 'nc';
    return (at === 'yes') === (side === 'YES') ? 'ahead' : 'behind';
  }
  if (it.kind !== 'contest' || blockVote(it)) return 'nc';
  const w = winnersOf(r);
  if (!w && unknownLead(r)) return 'nc';
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
/* Which way one count leans, where the rules for one count can say: a measure's side against its bar ('yes' or 'no'),
   or a one-seat race's single leader by name. Null for a tie, a measure at its bar or with no rule we hold, a name not in
   the guide that could lead, ranked choice, several seats or a block vote. */
function leanOf(it: Item, r: ItemResult): string | null {
  if (isMeasureLike(it)) { const s = r.measure ? sideOf(it, r) : null; return s === 'yes' || s === 'no' ? s : null; }
  if (it.kind !== 'contest' || blockVote(it) || isRCV(it) || isMultiSeat(it) || unknownLead(r)) return null;
  const top = leaders(r);
  return top.length === 1 ? top[0].name : null;
}
/* A race across counties (rule 9; Kevin, Nov 5, of Austin's props, every one of them "not compared": "all these ballot
   measures are ahead so I'm confused"). Compared by which way it leans, never won or lost (a county's count is never the
   race's final), and only where the counties we hold carry the race:
   - we hold every county it reaches, with numbers from each (Round Rock, Pflugerville and Leander ISD, Pflugerville's
     council and props); or
   - it is a city's own race or measure, whose missing pieces are corners of the city itself (Hays's sliver of Austin,
     Austin's limited-purpose areas, Collin's part of Dallas), and the city's main county (the Worker's own source, its
     largest) has numbers.
   Then every county count we hold must lean the same way, and the votes we hold, added up, lean that way too (a leader
   in every count leads their sum; so does a side above its bar), so we can say so without a sum.
   Anything else missing a county is part of a count, and part can't tell (gate review, PR #144: Senate 21 read
   "winning" off Travis's count, though most of its votes are in counties the guide doesn't read; New Caney ISD is held
   as Harris's sliver, Montgomery missing). That takes in districts drawn across the state, courts of appeals, ACC
   (Hays, Bastrop and "other counties" missing), and a statewide race held as county shares. The Worker's map knows which
   counties a race reaches but not how many of its voters each holds; a share from it could let more of these compare.
   With the answer, why there is none, for the figure's note (PR #144 review: one reason for every "can't tell" put the
   counties-disagree line where it was false): 'part', 'main' (a city's main county hasn't posted), the race's own reason
   (ranked choice, several seats, a block vote, no rule we hold, a name not in the guide), 'tie' or 'edge' when a county's
   count is tied or right at the bar, and 'span' only when the counties really lean different ways. */
type SpanWhy = '' | 'part' | 'main' | 'span' | 'tie' | 'edge' | 'rcv' | 'multi' | 'block' | 'rule' | 'unknown';
function acrossCounties(it: Item, r: ItemResult, names: string[]): { cmp: Cmp; why: SpanWhy } {
  const no = (why: SpanWhy): { cmp: Cmp; why: SpanWhy } => ({ cmp: 'nc', why });
  const raw = R.file?.items[it.id];
  if (!raw) return no('part');
  if (it.kind === 'contest' && !it.is_retention) {
    if (blockVote(it)) return no('block');
    if (isRCV(it)) return no('rcv');
    if (isMultiSeat(it)) return no('multi');
  }
  const held = (raw.slices || []).filter(sliceHas);
  const whole = !(raw.missing || []).length && held.length === (raw.slices || []).length;
  if (sharesOnly(it, r) || (!whole && it.level !== 'city')) return no('part');
  if (!held.some((x) => x.source === raw.source)) return no('main');
  // Each county's numbers as a count of its own, so the rules for one count apply to it. A county's measure without a
  // bar of its own keeps the race's (a retention vote needing 60% never falls back to half; PR #144 review).
  const one = (x: ResultSlice): ItemResult => ({
    ...raw, source: x.source, status: x.status, reporting: x.reporting, updated: x.updated, url: x.url, total_votes: x.total_votes, candidates: x.candidates,
    measure: x.measure && x.measure.threshold == null && raw.measure?.threshold != null ? { ...x.measure, threshold: raw.measure.threshold } : x.measure,
    seats: x.seats ?? raw.seats, unmatched: x.unmatched, slices: undefined, missing: undefined, final: null, rounds: undefined,
  });
  const counts = held.map(one);
  if (isMeasureLike(it) && counts.some((x) => !x.measure || barOf(it, x) === null)) return no('rule');
  if (!isMeasureLike(it) && counts.some((x) => unknownLead(x))) return no('unknown');
  const ways = counts.map((x) => leanOf(it, x));
  // A county with no lean is tied at the top, or a measure right at its bar: said as that, never as leaning apart.
  if (ways.some((x) => x === null)) return no(isMeasureLike(it) ? 'edge' : 'tie');
  const way = ways[0];
  if (!way || ways.some((x) => x !== way)) return no('span');
  if (isMeasureLike(it)) return names[0] === 'YES' || names[0] === 'NO' ? { cmp: (way === 'yes') === (names[0] === 'YES') ? 'ahead' : 'behind', why: '' } : no('');
  return names.length === 1 ? { cmp: way === names[0] ? 'ahead' : 'behind', why: '' } : no('');
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
    const y = yesShare(r.measure), b = barOf(it, r), pass = passedOf(r), at = sideOf(it, r);
    const judge = it.kind !== 'measure';
    const p = S.b.picks[it.id];
    out.rows = [
      { name: judge ? 'Keep' : 'Yes', party: '', votes: r.measure.yes, pct: r.measure.yes_pct, mine: p === 'YES' },
      { name: judge ? 'Remove' : 'No', party: '', votes: r.measure.no, pct: 100 - r.measure.yes_pct, mine: p === 'NO' },
    ];
    const bar = !b ? ' Passing takes more than a share of yes and no. See the office’s results.' : !plainBar(b) ? ` It needs ${pct0(b.pct)} yes to ${judge ? 'stay' : 'pass'}.` : '';
    const Y = judge ? 'keep' : 'yes', N = judge ? 'remove' : 'no';
    // Against a bar above half, the sentence is about yes and its bar, never "no is ahead" while yes leads no.
    const where = at === null ? `${Y} has ${pct0(y)} so far.`
      : !plainBar(b) ? (at === 'at' ? `${Y} is right at the ${pct0(b!.pct)} it needs so far.` : at === 'yes' ? `${Y} is above the ${pct0(b!.pct)} it needs so far.` : `${Y} is short of the ${pct0(b!.pct)} it needs so far.`)
      : at === 'at' ? `${Y} and ${N} are even so far.` : at === 'yes' ? `${Y} is ahead so far.` : `${N} is ahead so far.`;
    if (pass !== null && !county) out.line = `${judge ? (pass ? 'The judge stays.' : 'The judge does not stay.') : pass ? 'It passed.' : 'It did not pass.'}${b && !plainBar(b) ? ` It needed ${pct0(b.pct)} yes.` : ''}`;
    else if (r.status === 'counting' || county) out.line = `${lead}${where}${b && !plainBar(b) ? '' : bar}`.replace(/^([a-z])/, (m) => m.toUpperCase());
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
    out.line = w && !county ? `${w.map((n) => shortOf(it, n)).join(' and ')} won after the final round. The table shows first choices.` : 'First choices only. Ranked choice counts go in rounds, so the winner can be someone other than the first-choice leader.';
    return out;
  }
  if (!w && unknownLead(r)) { out.line = `${lead}A name in the office’s count isn’t in this guide, so we don’t say who’s ahead. See the office’s results.`.replace(/^In (.*?), A/, 'In $1, a'); return out; }
  if (blockVote(it) && top.length === 1) { out.line = `${lead}${shortOf(it, top[0].name)} has ${pct0(top[0].pct)} so far.`; return out; }
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
/* The races the page shows, in page order (not the other districts' races a district question holds: those brought
   Bexar County into an Austin ballot's sources, overnight). */
export function shownItems(): Item[] {
  const b = S.ballot;
  if (!b) return [];
  return pageWalk().filter((x) => !x.question && !x.folded).map((x) => b.byId.get(x.key)).filter((x): x is Item => !!x);
}
export function ballotSources(): ResultsSourceEntry[] {
  if (!resultsOn()) return [];
  const ids = new Set<string>();
  for (const it of shownItems()) {
    const r = R.file!.items[it.id];
    // The office behind what the row shows: never a county whose share this ballot doesn't show (viewFor).
    const v = r ? viewFor(it, r) : null;
    if (!v) continue;
    ids.add(v.source);
    for (const s of v.slices || []) ids.add(s.source);
  }
  return R.file!.sources.filter((s) => ids.has(s.id));
}
/* A source we couldn't reach. A link-only source (not checked yet, a link by design) is never "down" here: its rows are
   links, and its fetch failing says nothing about numbers we show. */
export const sourceDown = (s: ResultsSourceEntry): boolean => s.status !== 'link_only' && (!!s.failing_since || s.status === 'failing');
/* A banner that counts something can contradict the numbers beside it (Nov 3: Travis's "Unofficial Results 0/201 Vote
   Centers Reporting" over six-figure counts, Williamson's template "X of X Vote Centers Completely Reported"), so a
   label with a count in it is never quoted; progress comes from the source's `reporting` only. */
const COUNTS = /\b(\d+|X)\s*(of|\/)\s*(\d+|X)\b/i;
export function cleanLabels(s: ResultsSourceEntry | undefined): string[] {
  const seen = new Set<string>();
  return (s?.labels || []).filter((x) => typeof x === 'string' && x.trim() && !COUNTS.test(x)).map((x) => x.trim().replace(/\.$/, ''))
    .filter((x) => (seen.has(x.toLowerCase()) ? false : (seen.add(x.toLowerCase()), true)));
}
/* The source's own banner words, quoted ("“Early Voting Totals Only.”"), or ''. */
export const labelWords = (s: ResultsSourceEntry | undefined): string => {
  const l = cleanLabels(s);
  return l.length ? ` “${l.slice(0, 2).join('. ')}.”` : '';
};
/* An office's progress in its own words: its own `reporting`, or nothing. Never one race's words passed off as the
   office's (Opus review, Nov 4: Bexar's "7 of 7" was one district's), never a label, never a percent of our own (rule
   5). Each race's own progress is in its open row. */
export function progressOf(s: ResultsSourceEntry): string {
  const t = s.reporting && s.reporting.trim();
  return t ? t.replace(/\.$/, '') : '';
}
/* How many rows on this page each office's numbers fill (after viewOf picks a county). */
function rowsBy(): Map<string, number> {
  const n = new Map<string, number>();
  for (const it of shownItems()) { const r = resultOf(it); if (r && hasNumbers(r)) n.set(r.source, (n.get(r.source) || 0) + 1); }
  return n;
}
export const sourceName = (id: string): string => R.file?.sources.find((s) => s.id === id)?.name || 'The election office';
/* "We checked 10:13 PM CT": when our fetcher last read the sources, never the page's own load. With several sources,
   the oldest of their times, so it never claims a newer read than every one of them had (overnight: the run of each
   county's time was a paragraph; each one's own update time is in the menu and the figure). A source that is down
   still counts at its last good read, since its numbers stay on the page (Codex); the outage is said apart. */
export function checkedAt(srcs = ballotSources()): string {
  const read = srcs.filter((s) => s.fetched && s.status !== 'link_only').map((s) => s.fetched!).filter((t) => !Number.isNaN(Date.parse(t)));
  if (!read.length) return '';
  return fmtTime(read.sort((a, b) => Date.parse(a) - Date.parse(b))[0]);
}
export function checkedLine(srcs = ballotSources()): string {
  const t = checkedAt(srcs);
  return t ? `We checked ${t}` : '';
}
/* Each source in its own words: "Travis County last posted 9:35 PM CT. “120 of 200 precincts reporting.”", or
   "Couldn't reach Travis County. Showing its 9:12 PM CT numbers." */
export function sourceLines(srcs = ballotSources()): string[] {
  return srcs.filter((s) => s.status !== 'link_only').map((s) => {
    if (sourceDown(s)) return `Couldn’t reach ${s.name}. Showing its ${s.updated ? `${fmtTime(s.updated)} ` : 'last '}numbers.`;
    if (s.status === 'refused') return `${s.name} isn’t letting us read its results. See its own page.`;
    const when = s.updated ? `${s.name} last posted ${fmtTime(s.updated)}.` : `${s.name}: source update time unavailable.`;
    const p = progressOf(s);
    return `${when}${labelWords(s)}${p ? ` “${p}.”` : ''}`;
  });
}
/* The bottom bar's results line (second overnight pass, DESIGN-OVERNIGHT-2 section 2): one line, never wrapping on a
   phone. The status word, one office's own progress words shortened by dropping filler, that office's own update
   time, and Refresh. Which office: the voter's county's when it gives progress words, else the state's, else the one
   behind most rows on this page; with none giving words, the voter's county's (so the age of the local numbers is on
   screen), else the one behind most rows. Our check time is in the menu. `kind`: 'wait' before the first read,
   'links' when nothing on this page has numbers here (it then carries the office's link), 'failed' when the first
   read failed. */
export interface FootInfo { kind: 'res' | 'wait' | 'links' | 'failed'; word: string; who: string; prog: string; progShort: string; at: string; down: boolean; link: { url: string; text: string } | null }
export function footSource(): ResultsSourceEntry | null {
  const n = rowsBy();
  const fed = ballotSources().filter((x) => x.status !== 'link_only' && (n.get(x.id) || 0) > 0);
  if (!fed.length) return null;
  const most = [...fed].sort((a, z) => (n.get(z.id) || 0) - (n.get(a.id) || 0))[0];
  const home = homeSource(fed);
  const state = fed.find((x) => rowFor(x.id)?.kind === 'state');
  const worded = (x: ResultsSourceEntry | undefined): boolean => !!x && !sourceDown(x) && !!progressOf(x);
  return [home, state, most].find(worded) || home || most;
}
/* The voter's county's office among these: the address or ZIP's county, else the place's first county. */
function homeSource(srcs: ResultsSourceEntry[]): ResultsSourceEntry | undefined {
  const home = homeCounty();
  const k = home ? countyKey(bare(home)) : null;
  if (!k) return undefined;
  const rows = (S.ballot?.howto.results?.sources || []).filter((x) => x.kind === 'county');
  const hc = rows.find((x) => [...(x.counties || []), x.label || '', x.name].some((c) => c && countyKey(bare(c)) === k));
  return hc ? srcs.find((x) => x.id === hc.id) : undefined;
}
/* An office's progress words with the filler dropped, never reworded into a number it didn't print: "Polling Locations
   Reporting: 27%" is "27% of polling places", "128 of 186 Vote Centers Reporting" is "128 of 186 vote centers".
   `tiny`: the shortest honest form, for a line that would overflow ("27%", "128 of 186"). Anything else stays as the
   office wrote it. */
export function shortProgress(p: string, tiny = false): string {
  const t = p.trim().replace(/\.$/, '').replace(/\s+/g, ' ');
  const noun = (x: string): string => x.trim().toLowerCase().replace(/\bpolling locations\b/, 'polling places').replace(/\bvoting locations\b/, 'voting places');
  let m = t.match(/^(.+?)\s+reporting:?\s*(\d+(?:\.\d+)?%)$/i);
  // A percent keeps its noun even in the shortest form: a bare "27%" says nothing about what was counted (PR #139 review).
  if (m) return `${m[2]} of ${noun(m[1])}`;
  m = t.match(/^(\d+(?:\.\d+)?%)\s+(?:of\s+)?(.+?)(?:\s+(?:reporting|reported))?$/i);
  if (m) return `${m[1]} of ${noun(m[2])}`;
  m = t.match(/^([\d,]+)\s*(?:of|\/)\s*([\d,]+)\s+(.+?)(?:\s+(?:completely\s+)?(?:reporting|reported))?$/i);
  if (m) return tiny ? `${m[1]} of ${m[2]}` : `${m[1]} of ${m[2]} ${noun(m[3])}`;
  return t;
}
function footTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const tz = zoneOf() || undefined;
  try {
    const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
    const day = d.toLocaleDateString('en-CA', { timeZone: tz });
    // Today where the polls are (the page's own clock honors ?today= for checks).
    const today = /[?&]today=\d{4}-\d{2}-\d{2}/.test(typeof location !== 'undefined' ? location.search : '') ? todayISO() : new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const date = day === today ? '' : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz })}, `;
    const ab = tz ? ZONE_ABBR[tz] || '' : '';
    let viewer = '';
    try { viewer = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* keep the zone */ }
    return `${date}${t}${ab && ZONE_ABBR[viewer] !== ab ? ` ${ab}` : ''}`;
  } catch { return fmtTime(iso); }
}
export function footInfo(): FootInfo | null {
  if (!resultsMode()) return null;
  const b = S.ballot!;
  const rows = (b.howto.results?.sources || []).filter((x) => httpsOK(x.results_url));
  const home = rows.find((x) => x.kind === 'county') || rows.find((x) => x.kind === 'state');
  const link = home ? { url: home.results_url, text: `${home.label || home.name} results` } : httpsOK(b.howto.results_url) ? { url: b.howto.results_url!, text: `${b.howto.results_source || b.stateName} results` } : null;
  const base: FootInfo = { kind: 'res', word: '', who: '', prog: '', progShort: '', at: '', down: false, link };
  if (resultsWaiting()) return { ...base, kind: 'wait' };
  if (!resultsOn()) return { ...base, kind: R.failed ? 'failed' : 'links' };
  const f = figure(null);
  const m = footSource();
  if (!f || !f.posted || !m) return { ...base, kind: 'links' };
  const down = sourceDown(m);
  const p = down ? '' : progressOf(m);
  // The office's own time: its day whenever it isn't today where the polls are, and its zone whenever the viewer is in
  // another one, so an old update never reads as today's (PR #139 review). fitFoot never drops it.
  const at = m.updated ? footTime(m.updated) : '';
  return { ...base, word: f.word, who: shortCounty(officeShort(m.id)), prog: p ? shortProgress(p) : '', progShort: p ? shortProgress(p, true) : '', at, down };
}
/* "Hide races I've decided" only before the close (Opus review, Nov 4): after it, every row carries its count, so the
   switch (still saved as it was) hides nothing. */
export const hideDecidedNow = (): boolean => !!S.b?.hideDecided && !resultsMode();
/* The newest source time we hold, for "No change since 9:35 PM CT". */
export function newestUpdate(srcs = ballotSources()): string {
  const t = srcs.map((s) => s.updated || s.fetched || '').filter(Boolean).sort().pop();
  return t ? fmtTime(t) : '';
}
/* What each source's fetch time is, to tell a Refresh that really read something from one that didn't. */
export const fetchedSig = (f: ResultsFile | null): string => (f ? f.sources.map((s) => `${s.id}:${s.fetched || ''}`).join('|') : '');

/* ---------- compare with (second overnight pass, DESIGN-OVERNIGHT-2 section 1) ----------
   What the results card compares the count with: your own picks, a group from the picking step, or a party. Chosen for
   this visit only (S.ui.cmp), never saved; choosing a group or a party never changes your picks or your sources. */
export type CmpSel = { kind: 'mine' } | { kind: 'group'; key: ChipKey } | { kind: 'party'; party: string };
/* A group's pick on a race, in one place so Kevin can switch it in the morning. 'agree' is today's "Fill in my ballot
   with their picks" rule (bulk.ts planAgree: every source in the group that weighed in made the same pick; anything
   else is split). 'majority' takes the pick most of them made, a tie being split. */
export const GROUP_RULE: 'agree' | 'majority' = 'agree';
/* Whether this ballot has a pick of your own on a race the page shows (what "Your picks" compares). */
export const anyPick = (): boolean => !!S.ballot && shownItems().some((it) => picked(it));
/* Whether you've made any choice at all on this ballot, finished or not: a pick, a skip, a seat of several, a ranking
   started (Codex, Nov 4). "Make these my picks" is offered only without one, so it never overwrites your own work. */
export const anyChoice = (): boolean => !!S.ballot && (Object.keys(S.b.picks || {}).length > 0 || Object.values(S.b.ranks || {}).some((r) => Array.isArray(r) && r.length > 0));
/* Compare with starts over on each ballot: Your picks whenever it has some (PR #139 review). app.ts resetUI calls this. */
export function resetCompare(): void { S.ui.cmp = undefined; S.ui.takeWas = null; S.ui.open.delete('cmp-party'); }
/* What the card compares with now: what you chose this visit, else your picks when you have some, else nothing. */
export function cmpSel(): CmpSel | null {
  const v = S.ui.cmp;
  if (v === undefined || v === 'mine') return anyPick() ? { kind: 'mine' } : null;
  if (!v) return null;
  if (v.startsWith('party:')) return { kind: 'party', party: v.slice(6) };
  return CHIPS.some((c) => c.key === v) ? { kind: 'group', key: v as ChipKey } : null;
}
/* The names a choice picks on a row ("YES" or "NO" for a measure or a judge), 'split' when a group's sources split,
   or null when it has no pick there. A party picks its own candidate in a partisan race, and nothing where it has two
   (a top-two race) or none. */
export function lensNames(it: Item, sel: CmpSel): string[] | 'split' | null {
  if (sel.kind === 'mine') return picked(it) ? pickNames(it) : null;
  // A row that may not be on this ballot ("Maybe on your ballot") counts for nobody but you: the fill leaves it too.
  if (isMaybe(it.id)) return null;
  if (it.kind === 'contest' && isMultiJudge(it)) return null;
  if (sel.kind === 'party') {
    if (it.kind !== 'contest' || it.is_retention || !isPartisan(it)) return null;
    const theirs = it.candidates.filter((c) => c.parties.includes(sel.party));
    if (!theirs.length) return null;
    if (isMultiSeat(it)) return theirs.length <= it.vote_for ? theirs.map((c) => c.name) : null;
    return theirs.length === 1 ? [theirs[0].name] : null;
  }
  const members = chipMembers(S.ballot!, sel.key);
  if (!members.length) return null;
  const l = lineup(it, members);
  let ch: string[];
  const ag = agreed(l);
  if (ag === null) return null;
  if (ag !== 'split') ch = ag;
  else {
    // The majority rule counts every group, a group without a pick included; a tie, or a top group with no pick, is split.
    if (GROUP_RULE !== 'majority' || l.groups.length < 2) return 'split';
    const top = [...l.groups].sort((a, z) => z.sources.length - a.sources.length);
    if (top[0].sources.length === top[1].sources.length || !top[0].choices.length) return 'split';
    ch = top[0].choices;
  }
  if (isMeasureLike(it)) return ch.length === 1 && (ch[0] === 'YES' || ch[0] === 'NO') ? [ch[0]] : null;
  if (it.kind !== 'contest') return null;
  const names = ch.filter((n) => it.candidates.some((c) => c.name === n));
  if (names.length !== ch.length) return null;
  // Several seats: up to the seat count, as for a party. Ranked choice: one agreed first choice, never compared until the
  // final round (compareNames), as for a party or your own ranking (PR #139 review).
  if (isMultiSeat(it)) return names.length >= 1 && names.length <= it.vote_for ? names : null;
  return names.length === 1 ? names : null;
}
/* How a choice is named in the card ("Your picks", "Progressive groups", "the Democratic Party"). */
export const selName = (sel: CmpSel): string => (sel.kind === 'mine' ? 'Your picks' : sel.kind === 'group' ? CHIPS.find((c) => c.key === sel.key)!.label : `${sel.party} Party`);

/* ---------- the figure ----------
   A dot per race. A pick: `up` winning or won, `down` losing or lost, `wq` numbers here but we can't tell (a tie,
   ranked choice, counties leaning different ways; the notes say which), `wp` no numbers here (not posted yet, or on the
   office's own site). No pick: `po`; with nothing chosen to compare (the printed page of a ballot with no picks), `po`
   with numbers, `w` without, `ln` the office's site. */
export type DotKind = 'up' | 'down' | 'wq' | 'wp' | 'po' | 'w' | 'ln';
export interface Dot { id: string; sec: SectionKey; pick: boolean; cmp: Cmp; kind: DotKind; posted: boolean; why: '' | 'rcv' | 'multi' | 'span' | 'main' | 'part' | 'tie' | 'rule' | 'edge' | 'partial' | 'unknown' | 'block' }
export interface Figure {
  word: 'Counting' | 'Unofficial' | 'Official';
  explain: string;
  rows: { sec: SectionKey; dots: Dot[] }[];
  picks: number;
  counts: Record<Cmp, number>;
  others: number;
  othersKinds: { races: number; measures: number };
  posted: number; total: number;
  /* races whose results are a link to the office's own page, and whether every race on the ballot is one */
  links: number; allLinks: boolean;
  questions: { n: number; first: string | null };
  notes: string[];
  /* what the dots compare with (null: nothing chosen), and how many races a group's sources split on */
  sel: CmpSel | null;
  splits: number;
}
export function figure(sel: CmpSel | null = cmpSel()): Figure | null {
  if (!resultsOn()) return null;
  const b = S.ballot!;
  const walk = pageWalk().filter((x) => !x.folded);
  const rows: Figure['rows'] = [];
  const counts: Record<Cmp, number> = { won: 0, lost: 0, ahead: 0, behind: 0, nc: 0 };
  const why = new Set<string>();
  let others = 0, posted = 0, total = 0, links = 0, pending = 0, done = 0, official = 0, splits = 0;
  const kinds = { races: 0, measures: 0 };
  let qn = 0; let first: string | null = null;
  for (const x of walk) {
    if (x.question) { if (!x.done) { qn++; first = first || x.key; } continue; }
    const it = b.byId.get(x.key);
    if (!it) continue;
    const r = resultOf(it);
    const ln = sel ? lensNames(it, sel) : null;
    if (ln === 'split') splits++;
    const names = Array.isArray(ln) && ln.length ? ln : null;
    const pick = !!names;
    const cmp = names ? compareNames(it, r, names) : 'nc';
    const num = hasNumbers(r);
    // A row the file has nothing for is a link to its office now (noResCol), so it counts as one.
    const link = isLink(r) || (!r && !!officeFor(it));
    total++;
    if (num) { posted++; if (r!.status === 'complete' || r!.status === 'official') done++; if (r!.status === 'official') official++; }
    else if (link) links++;
    else pending++;
    let w: Dot['why'] = '';
    if (pick && cmp === 'nc' && num) {
      const c = it.kind === 'contest' ? it : null;
      // A race across counties says its own reason (acrossCounties), never one picked for it here.
      w = spans(r!) ? acrossCounties(it, r!, names!).why : c && blockVote(c) ? 'block' : c && !winnersOf(r!) && unknownLead(r!) ? 'unknown'
        : c && (isRCV(c) || isMultiSeat(c)) ? (winnersOf(r!) ? 'partial' : isRCV(c) ? 'rcv' : 'multi')
        : isMeasureLike(it) ? (sideOf(it, r!) === null ? 'rule' : 'edge') : 'tie';
      if (w) why.add(w);
    }
    // Beside your picks, a race you didn't pick is one small dot whatever its count (Kevin, Nov 5: the key's four
    // words were "confusing af"), so the key has one line for it; set once the loop knows there are picks.
    const kind: DotKind = pick ? (cmp === 'won' || cmp === 'ahead' ? 'up' : cmp === 'lost' || cmp === 'behind' ? 'down' : num ? 'wq' : 'wp') : num ? 'po' : link ? 'ln' : 'w';
    if (pick) counts[cmp]++; else { others++; if (it.kind === 'measure') kinds.measures++; else kinds.races++; }
    const dot: Dot = { id: it.id, sec: x.sec, pick, cmp, kind, posted: num, why: w };
    const last = rows[rows.length - 1];
    if (last && last.sec === x.sec) last.dots.push(dot); else rows.push({ sec: x.sec, dots: [dot] });
  }
  // With picks to show, every race without one is the same small dot (a choice with none keeps the posted-ness marks,
  // which its printed key names; PR #144 review).
  if (sel && Object.values(counts).some((n) => n > 0)) for (const row of rows) for (const d of row.dots) if (!d.pick) d.kind = 'po';
  // "Unofficial" and "Official" only when every race on the ballot has a count here marked so; a race that links out or
  // isn't in the file may still be counting (adversarial pass, Nov 3).
  const word: Figure['word'] = total && done === total ? (official === total ? 'Official' : 'Unofficial') : 'Counting';
  // One short sentence under the status word, and nothing else: offices and times are in the bar and the menu.
  const explain = !posted ? (links && !pending ? 'Results for these races are on the election offices’ own sites.' : 'No numbers posted yet. Offices post as they count.')
    : word === 'Counting' ? (done === posted ? 'These results are unofficial. Other races may still be counting.' : 'Offices are still counting. Numbers may change.')
    : word === 'Unofficial' ? 'Offices marked their counts complete. They become official later.'
    : 'Offices made these counts official.';
  // Why a pick with numbers reads "can't tell yet", one short line each, only for what this ballot has.
  const notes: string[] = [];
  if (why.has('rcv')) notes.push('Ranked choice: we can’t tell until the final round.');
  if (why.has('multi')) notes.push('Races for more than one seat: we can’t tell until the count is complete.');
  if (why.has('partial')) notes.push('Several seats where some picks won and some lost: we count it as neither.');
  if (why.has('span')) notes.push('Races across county lines: we can’t tell while the counties’ counts lean different ways.');
  if (why.has('main')) notes.push('Races across county lines: we can’t tell until the biggest county in the race posts here.');
  if (why.has('part')) notes.push('Races where we have only some counties’ counts: we can’t tell from part of a race.');
  if (why.has('tie')) notes.push('A tie at the top: we can’t tell yet.');
  if (why.has('unknown')) notes.push('A name not in this guide could be leading: we can’t tell.');
  if (why.has('edge')) notes.push('A measure right at its bar to pass: we can’t tell yet.');
  if (why.has('rule')) notes.push('A measure whose rule to pass is more than a share of yes and no: we can’t tell here.');
  if (why.has('block')) notes.push('A block vote elects everyone either way, so we count it as neither.');
  return { word, explain, rows, picks: Object.values(counts).reduce((a, n) => a + n, 0), counts, others, othersKinds: kinds, posted, total, links, allLinks: !posted && !pending && links > 0, questions: { n: qn, first }, notes, sel, splits };
}
/* The card's headline once something is chosen: "Your 16 picks: 8 winning · 3 losing · 1 can’t tell yet · 4 not posted
   here", "Picks from progressive groups in 16 races: ..." (true whether one source or several weighed in; PR #139
   review), "Democratic Party candidates in 12 races: ...". Words about the pick, not the race (Kevin, Nov 5: "ahead"
   beside a measure read as the measure passing, whichever side you took). */
export function countLine(f: Figure): string {
  if (!f.picks || !f.sel) return '';
  const c = f.counts;
  const n = (k: DotKind): number => f.rows.reduce((a, r) => a + r.dots.filter((d) => d.kind === k).length, 0);
  const parts = [
    c.won ? `${c.won} won` : '', c.ahead ? `${c.ahead} winning` : '', c.lost ? `${c.lost} lost` : '', c.behind ? `${c.behind} losing` : '',
    n('wq') ? `${n('wq')} can’t tell yet` : '', n('wp') ? `${n('wp')} not posted here` : '',
  ].filter(Boolean);
  const head = f.sel.kind === 'mine' ? `Your ${f.picks === 1 ? '1 pick' : `${f.picks} picks`}`
    : f.sel.kind === 'group' ? `Picks from ${selName(f.sel).toLowerCase()} in ${f.picks === 1 ? '1 race' : `${f.picks} races`}`
    : `${selName(f.sel)} candidates in ${f.picks === 1 ? '1 race' : `${f.picks} races`}`;
  return `${head}: ${parts.join(' · ')}`;
}
/* A group's sources that split: listed, never compared. */
export const splitLine = (f: Figure): string => (f.sel && f.sel.kind === 'group' && f.splits ? `Their picks differ in ${f.splits === 1 ? '1 more race' : `${f.splits} more races`}.` : '');
export function othersLine(f: Figure): string {
  if (!f.others) return '';
  const { races, measures } = f.othersKinds;
  const what = races && measures ? 'races and measures' : measures ? (measures === 1 ? 'measure' : 'measures') : races === 1 ? 'race' : 'races';
  return `${f.others} other ${what}${f.picks ? '' : ''}`;
}
/* The open row's line about one dot, for the figure's list: "Paxton 51% · your pick Talarico", or with a group chosen
   "Paxton 51% · counting · their pick Talarico" or "· their picks differ". */
export function dotLine(it: Item, sel: CmpSel | null = cmpSel()): string {
  const r = resultOf(it);
  const ln = sel && sel.kind !== 'mine' ? lensNames(it, sel) : null;
  const pk = sel && sel.kind !== 'mine'
    ? (ln === 'split' ? 'their picks differ' : Array.isArray(ln) && ln.length ? `their pick ${ln.map((n) => (n === 'YES' ? 'Yes' : n === 'NO' ? 'No' : shortOf(it, n))).join(', ')}` : null)
    : picked(it) ? `your pick ${pickShort(it)}` : null;
  const col = r ? resCol(it, r) : noResCol(it);
  if (!col) return pk ? `Not in this guide’s results · ${pk}` : 'Not in this guide’s results';
  const main = col.kind === 'num' ? `${col.main}${col.sub ? ` · ${col.sub}` : ''}${col.area ? ` · ${col.area}` : ''}` : col.main;
  return `${main}${pk ? ` · ${pk}` : ''}`;
}
export type { Measure };
