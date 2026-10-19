/* Judges: what official reviews, bar ratings and lawyer polls say, worded as the reviewer's own
   rating, never ours. Read from candidates' structured `evaluations` (the Oct 19 data contract).
   Each bar group's entry is one of five states, kept apart on purpose:
     yes       the group recommends or approves
     no        the group does not, on the merits
     declined  a negative or blank rating because the candidate did not take part in screening
     unrated   the group did not rate this candidate ("Not listed", "N/A")
     mixed     a rating the group itself calls mixed
   A lawyer preference poll (bar_poll) is a vote count, not a rating: it never gets a tone. */
import type { Candidate, Contest, Evaluation, JudicialReview, SurveyRow } from '../types';
import { S } from '../state';
import { entriesBySection, status, isMultiJudge } from '../ballot';

export type EvalState = 'yes' | 'no' | 'declined' | 'unrated' | 'mixed';
const DID_NOT_TAKE_PART = /declin|did not (participate|take part|appear)|failed to appear|not participate|chose not to (participate|be screened)|automatic/i;
export function evalState(e: Evaluation): EvalState {
  const why = `${e.rating} ${e.noted_concern || ''}`;
  if (e.verdict === 'favorable') return 'yes';
  if (e.verdict === 'unfavorable') return DID_NOT_TAKE_PART.test(why) ? 'declined' : 'no';
  if (e.verdict === 'mixed') return 'mixed';
  return DID_NOT_TAKE_PART.test(why) ? 'declined' : 'unrated';
}
const isOfficial = (e: Evaluation) => e.kind === 'official_commission' || e.kind === 'bar_committee';
const isPoll = (e: Evaluation) => e.kind === 'bar_poll';
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const nameOf = (c: Candidate) => c.short || c.name.split(' ').pop() || c.name;
const voteAgainst = (v: string | null): number => { const m = (v || '').match(/^\s*(\d+)\s*[-–]\s*(\d+)\s*$/); return m ? +m[2] : 0; };

/* A rating short enough for the narrow column, never cut mid-word. */
export function shortRating(e: Evaluation): string {
  const st = evalState(e);
  if (st === 'unrated') return 'Not rated';
  if (st === 'declined') return 'Did not take part';
  const r = e.rating.split(/\s*[(;:]/)[0].replace(/\bperformance\s+/i, '').replace(/\bjudicial\s+/i, '').replace(/\boverall\s+/i, '').trim();
  const s = sentence(r.toLowerCase());
  if (s.length <= 24) return s;
  return st === 'yes' ? 'Favorable review' : st === 'no' ? 'Unfavorable review' : 'Mixed review';
}

export interface Review {
  main: string;           // the narrow column: "Meets standards", "13 of 14 recommend", "Declined screening"
  sub: string;            // "Commission 10-0", "bar groups"
  tone: 'fav' | 'unfav' | 'mixed' | 'none';
  line: string;           // one plain sentence for the open row
  split: boolean;         // a reviewer voted against, or groups disagree on the merits
  concerns: { by: string; text: string; reason: boolean }[];   // reason: why a group did not rate, not a finding
  strengths: { by: string; text: string }[];
  links: { label: string; url: string }[];
  /* every bar group's own rating, full name first, for "See each group" */
  groups?: { by: string; rating: string; url: string; state: EvalState }[];
}

/* Colorado's Eighteenth District narratives say respondents "found no performance issues in any
   evaluation criteria" even where the survey shows many said no. Never show that sentence as a
   strength when the survey says otherwise. */
const BOILERPLATE = /no performance issues/i;
export const surveyDisagrees = (e: Evaluation): boolean =>
  !!e.survey && [e.survey.attorneys, e.survey.non_attorneys, e.survey.judges].some((r) => !!r && (r.n ?? 0) >= 5 && (r.no_pct ?? 0) >= 20);
export const strengthOf = (e: Evaluation): string | null => (e.noted_strength && !(BOILERPLATE.test(e.noted_strength) && surveyDisagrees(e)) ? e.noted_strength : null);

/* "Lawyers: 85% yes, 15% no (13 answered this question)"; under 5 answers, no percentage at all. */
export function surveyLines(e: Evaluation): string[] {
  const sv = e.survey;
  if (!sv) return [];
  const row = (label: string, r: SurveyRow | null) => {
    if (!r) return '';
    if (r.n != null && r.n < 5) return `${label}: fewer than 5 answered this question`;
    return `${label}: ${r.yes_pct}% yes${r.no_pct != null ? `, ${r.no_pct}% no` : ''}${r.n != null ? ` (${r.n} answered this question)` : ''}`;
  };
  return [row('Lawyers', sv.attorneys), row('Others in the courtroom', sv.non_attorneys), row('Other judges', sv.judges)].filter(Boolean);
}

/* `retention`: a keep-or-remove question, where a group's yes is "say keep" and its no "say
   don't keep", in the row and the open row alike. A contested race says "recommend". */
/* The survey in one plain sentence: "In the survey, 9 of 9 lawyers and 4 of 9 others who saw
   Judge Garrido in court said the judge meets standards. Small groups, so read with care." A
   count is shown only when it reproduces the published percentage exactly; otherwise that group
   keeps its percentage and how many answered. Under 5 answers, no number at all. Null when the
   question isn't the standards question, so the caller shows the rows instead. */
export function surveySentence(e: Evaluation, name: string): { sentence: string; note: string } | null {
  const sv = e.survey;
  if (!sv || !/meets? (judicial )?performance standards/i.test(sv.question || '')) return null;
  const last = name.replace(/,?\s+(Jr\.|Sr\.|II|III|IV)$/, '').split(/\s+/).pop() || name;
  const one = (r: SurveyRow | null, who: string): string => {
    if (!r) return '';
    if (r.n == null) return `${r.yes_pct}% of ${who}`;
    if (r.n < 5) return `fewer than 5 ${who} answered, so no count is shown`;
    const x = Math.round((r.yes_pct * r.n) / 100);
    return Math.round((x / r.n) * 100) === Math.round(r.yes_pct) ? `${x} of ${r.n} ${who}` : `${r.yes_pct}% of the ${r.n} ${who} who answered`;
  };
  const parts = [one(sv.attorneys, 'lawyers'), one(sv.non_attorneys, `others who saw Judge ${last} in court`), one(sv.judges, 'other judges')].filter(Boolean);
  if (!parts.length) return null;
  const counted = parts.filter((p) => !/fewer than 5/.test(p));
  const small = [sv.attorneys, sv.non_attorneys, sv.judges].some((r) => r && r.n != null && r.n < 10);
  const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0]);
  const sentence = counted.length
    ? `In the survey, ${list(counted)} said the judge meets standards.${parts.length > counted.length ? ` For the rest, ${parts.filter((p) => /fewer than 5/.test(p)).join('; ')}.` : ''}${small ? ' Small groups, so read with care.' : ''}`
    : `In the survey, ${list(parts)}.`;
  // Keep any part of the caution that isn't about sample size (which the sentence covers).
  const note = (sv.caution || '').replace(/^Small samples\.\s*n counts everyone who answered the question, including 'no opinion'\.\s*/i, '').trim();
  return { sentence, note };
}

export function candidateReview(c: Candidate, retention = false): Review | null {
  const ev = (c.evaluations || []).filter((e) => !isPoll(e));
  if (!ev.length) return null;
  const concerns = ev.filter((e) => e.noted_concern).map((e) => ({ by: e.by_short, text: e.noted_concern!, reason: ['declined', 'unrated'].includes(evalState(e)) }));
  const strengths = ev.map((e) => ({ by: e.by_short, text: strengthOf(e) })).filter((x): x is { by: string; text: string } => !!x.text);
  const links = ev.filter((e, i, a) => a.findIndex((x) => x.url === e.url) === i).slice(0, 4).map((e) => ({ label: `${e.by_short}: the full review`, url: e.url }));
  const off = ev.find(isOfficial);
  if (off) {
    const against = voteAgainst(off.vote);
    const st = evalState(off);
    const tone: Review['tone'] = st === 'yes' ? (against ? 'mixed' : 'fav') : st === 'no' ? 'unfav' : st === 'mixed' ? 'mixed' : 'none';
    const verbal = /^(meets|does not meet|substantially meets|exceeds)\b/i.test(off.rating);
    const tally = /^\s*\d+\s*[-–]\s*\d+\s*$/.test(off.vote || '') ? off.vote : null;
    const note = off.vote_note && tally ? ` (${off.vote_note.replace(/\.$/, '')})` : '';
    const line = verbal
      ? `${off.by} ${tally ? `voted ${tally}` : 'found'}${note} that Judge ${nameOf(c)} ${off.rating.toLowerCase()}.`
      : `${off.by}: ${off.rating}${tally ? ` (vote ${tally})` : ''}.${off.vote_note && !tally ? ` ${off.vote_note}` : ''}`;
    return { main: shortRating(off), sub: [off.by_short, tally].filter(Boolean).join(' '), tone, line, split: against > 0, concerns, strengths, links };
  }
  const groups = ev.filter((e) => e.kind === 'bar_group');
  if (groups.length > 1) {
    const by = (s: EvalState) => groups.filter((e) => evalState(e) === s);
    const yes = by('yes'), no = by('no'), declined = by('declined'), unrated = by('unrated'), mixed = by('mixed');
    const declinedNR = declined.filter((e) => /\bnot recommended\b|^\s*NR\b/i.test(e.rating));
    const declinedOther = declined.filter((e) => !declinedNR.includes(e));
    const rated = yes.length + no.length + mixed.length;
    const who = nameOf(c);
    let main: string; let tone: Review['tone'];
    // Counted out of every group, so a group that did not rate or was not screened is never
    // read as agreeing. The tone is favorable only when no group said no, gave a mixed rating
    // or went unscreened: the same rule the "keep every judge the review favors" batch uses.
    const n = groups.length;
    const yesW = retention ? 'say keep' : 'recommend';
    const noW = retention ? 'say don’t keep' : 'do not recommend';
    if (!rated) { main = declined.length === n ? 'Declined screening' : declined.length ? `Not rated; ${declined.length} not screened` : 'Not rated'; tone = 'none'; }
    else if (no.length) { main = `${no.length} of ${n} ${retention ? 'say don’t keep' : 'say no'}`; tone = no.length * 2 > rated ? 'unfav' : 'mixed'; }
    else { main = `${yes.length} of ${n} ${yesW}`; tone = mixed.length || declined.length ? 'mixed' : 'fav'; }
    // Counts in the sentence; each group's full name and rating sit behind "See each group".
    const parts = [
      yes.length ? `${yes.length === groups.length ? `all ${yes.length}` : yes.length} ${yesW}` : '',
      no.length ? `${no.length} ${noW}` : '',
      mixed.length ? `${mixed.length} give a mixed rating` : '',
      // Only a group whose published rating is "not recommended" is said to have rated them so;
      // "Failed to Appear" and the like are a group that didn't rate them.
      declinedNR.length ? `${declinedNR.length} rate ${who} not recommended because the candidate did not take part in their screening` : '',
      declinedOther.length ? `${declinedOther.length} did not rate ${who} because the candidate did not take part in their screening (${[...new Set(declinedOther.map((e) => `“${e.rating.split(/\s*\(/)[0]}”`))].join(', ')})` : '',
      unrated.length ? `${unrated.length} did not rate ${who}` : '',
    ].filter(Boolean);
    const sub = declined.length && rated ? `bar groups; ${declined.length} did not take part` : 'bar groups';
    const each = groups.map((e) => ({ by: e.by, rating: e.rating, url: e.url, state: evalState(e) }));
    return { main, sub, tone, line: `Of ${groups.length} bar groups, ${parts.join(', ')}.`, split: no.length > 0 && yes.length > 0, concerns, strengths, links: [], groups: each };
  }
  const e = ev[0];
  const st = evalState(e);
  const tone: Review['tone'] = st === 'yes' ? 'fav' : st === 'no' ? 'unfav' : st === 'mixed' ? 'mixed' : 'none';
  return { main: shortRating(e), sub: e.by_short, tone, line: `${e.by}: ${e.rating}.`, split: false, concerns, strengths, links };
}

/* One contest: a single judge's review, or a summary across a batch of judges. */
export function judgeReview(it: Contest): Review | null {
  if (!isMultiJudge(it)) {
    return it.candidates[0] ? candidateReview(it.candidates[0], !!it.is_retention) : null;
  }
  const rs = it.candidates.map((c) => candidateReview(c, !!it.is_retention));
  const have = rs.filter((r): r is Review => !!r);
  if (!have.length) return null;
  // The review's finding counts on its own; a dissent doesn't make a favorable finding less so.
  // Split votes are reported beside it.
  const favorable = (c: Candidate, r: Review | null): boolean => {
    const off = (c.evaluations || []).find(isOfficial);
    return off ? evalState(off) === 'yes' : !!r && r.tone === 'fav';
  };
  const fav = it.candidates.filter((c, i) => favorable(c, rs[i])).length;
  const splits = have.filter((r) => r.split).length;
  const n = it.candidates.length;
  const tone: Review['tone'] = fav === n ? 'fav' : have.some((r) => r.tone === 'unfav') ? 'unfav' : 'mixed';
  const base = have[0].sub.replace(/\s*\d+\s*[-–]\s*\d+$/, '');
  return {
    main: fav === n ? `All ${n} favorable` : `${fav} of ${n} favorable`,
    sub: splits ? `${base}; ${splits} by a split vote` : base,
    tone, line: `${fav} of ${n} judges got a favorable review.${splits ? ` ${splits === 1 ? 'One was' : `${splits} were`} by a split vote.` : ''}`, split: splits > 0,
    concerns: have.flatMap((r) => r.concerns), strengths: [], links: [],
  };
}

/* ---------- the plain answer, first ----------
   One or two plain sentences that answer "what does this rating mean?" before any process: a
   "meets standards" review is a passing grade, not an endorsement (with how many passed, from
   the state's own history line); bar groups' ratings say fit or not and a "no" can mean a
   skipped interview; a lawyer poll is a poll; no review at all says so. The process stays one
   tap away. Built from the ballot's evaluations and the state's judicial_review fields. */
export function judgesLead(): string {
  const b = S.ballot!;
  const jr = judicialReview();
  const evs = b.items.flatMap((it) => (it.kind === 'contest' && it.level === 'judicial' ? it.candidates.flatMap((c) => c.evaluations || []) : []));
  const official = evs.filter(isOfficial);
  const meets = official.filter((e) => /meets/i.test(e.rating)).length;
  const first = (t: string | null | undefined) => ((t || '').match(/^(.+?[.!?])(\s|$)/) || [])[1] || '';
  if (official.length && meets * 2 > official.length) {
    const h = (jr?.history || '').match(/(\d+) of (\d+) judges[^.]*met performance standards/i);
    return `“Meets standards” is a passing grade on a job review, not an endorsement.${h ? ` ${h[1]} of ${h[2]} judges on the ballot in ${b.stateName} passed this year.` : ''}`;
  }
  if (official.length) return first(jr?.what_it_doesnt_mean) || first(jr?.what_the_rating_means);
  if (evs.some((e) => e.kind === 'bar_group')) {
    const skipped = evs.some((e) => evalState(e) === 'declined');
    return `Bar groups rate whether a judge is fit for the job.${skipped ? ' A “no” sometimes just means the judge skipped the interview, so check the reason.' : ' A rating isn’t an endorsement.'}`;
  }
  if (evs.some(isPoll)) return 'Some bar groups poll lawyers on who they prefer. It’s a poll of lawyers, not a job review.';
  if (jr && /\bno\b[^.]*\b(official|published)\b/i.test(`${jr.who_reviews || ''} ${jr.what_the_rating_means || ''}`)) return `${b.stateName} has no official review of these judges. Read each candidate’s own statement below.`;
  return first(jr?.what_it_doesnt_mean) || first(jr?.what_the_rating_means);
}
/* The band's one line: how a judge keeps the seat or wins it, in a few words. */
export function judgesRule(): string {
  const jr = judicialReview();
  const t = (jr?.to_keep_a_judge || '').trim();
  if (!t) return '';
  if (/^vote for the candidate/i.test(t)) return 'How judges win here: most votes wins. These aren’t keep-or-remove questions.';
  const pct = t.match(/at least (\d+) percent yes/i);
  if (pct) return `A judge needs ${pct[1]}% yes to stay.`;
  if (/^more yes than no votes keeps/i.test(t)) return 'A judge stays with more yes than no votes.';
  const s = (t.match(/^(.+?[.!?])(\s|$)/) || [])[1] || t;
  return s.replace(/\.?$/, '.');
}

/* ---------- lawyer preference polls (Texas): counts side by side, no tone ---------- */
export interface Poll { by: string; by_short: string; label: string; caveat: string; url: string; counts: { name: string; short: string; votes: number | null }[] }
export function pollsFor(c: Contest): Poll[] {
  const out = new Map<string, Poll>();
  for (const k of c.candidates) {
    for (const e of (k.evaluations || []).filter(isPoll)) {
      let p = out.get(e.by);
      if (!p) {
        const m = e.rating.match(/^(.*?):\s*[\d,]+\s+votes?\.\s*(.*)$/);
        p = { by: e.by, by_short: e.by_short, label: m ? m[1].trim() : e.rating, caveat: m ? m[2].trim() : '', url: e.url, counts: [] };
        out.set(e.by, p);
      }
      const n = parseInt(String(e.vote || '').replace(/,/g, ''), 10);
      p.counts.push({ name: k.name, short: k.short, votes: Number.isFinite(n) ? n : null });
    }
  }
  // Every candidate in the race appears in every poll's line, so a missing count shows as such.
  for (const p of out.values()) for (const k of c.candidates) if (!p.counts.some((x) => x.name === k.name)) p.counts.push({ name: k.name, short: k.short, votes: null });
  return [...out.values()];
}
export const hasRatings = (c: Contest): boolean => c.candidates.some((k) => (k.evaluations || []).length > 0);
/* Bar ratings for a contested race, one line per candidate who has any. */
export function raceRatings(c: Contest): { name: string; review: Review }[] {
  return c.candidates.map((k) => ({ name: k.name, review: candidateReview(k) })).filter((x): x is { name: string; review: Review } => !!x.review);
}

export const judicialReview = (): JudicialReview | null => S.ballot?.howto.judicial_review || null;

/* ---------- the batch: keep every judge the review favors ---------- */
export interface JudgeBatch {
  label: string;
  targets: { key: string; id: string; name: string }[];
  readFirst: { id: string; name: string; why: string }[];   // split votes, concerns, groups that said no or did not rate
  left: number;                                            // judges the batch leaves alone
}
export function judgeBatch(): JudgeBatch | null {
  const b = S.ballot!;
  const open: { it: Contest; c: Candidate; key: string }[] = [];
  for (const [, entries] of entriesBySection()) {
    for (const e of entries) {
      if (e.t !== 'item') continue;
      const it = b.byId.get(e.id);
      if (!it || it.kind !== 'contest' || !it.is_retention) continue;
      if (isMultiJudge(it)) { it.candidates.forEach((c) => { if (!S.b.picks[`${it.id}|${c.name}`] && S.b.picks[it.id] !== 'SKIP') open.push({ it, c, key: `${it.id}|${c.name}` }); }); }
      else if (status(it) === 'open' && it.candidates[0]) open.push({ it, c: it.candidates[0], key: it.id });
    }
  }
  if (!open.length) return null;
  const evs = (c: Candidate) => (c.evaluations || []).filter((e) => !isPoll(e));
  const withOfficial = open.filter((x) => evs(x.c).some(isOfficial));
  const withBars = open.filter((x) => evs(x.c).filter((e) => e.kind === 'bar_group').length > 1);
  let targets: typeof open = [];
  let label = '';
  const readFirst: JudgeBatch['readFirst'] = [];
  if (withOfficial.length) {
    targets = withOfficial.filter((x) => evalState(evs(x.c).find(isOfficial)!) === 'yes');
    const ratings = targets.map((x) => evs(x.c).find(isOfficial)!.rating);
    const common = [...ratings].sort((a, c) => ratings.filter((r) => r === c).length - ratings.filter((r) => r === a).length)[0] || '';
    const n = targets.length;
    const verb = /^substantially meets/i.test(common) ? 'substantially meet standards' : /^meets/i.test(common) ? 'meet standards' : '';
    label = !verb ? `Keep the ${n} ${n === 1 ? 'judge' : 'judges'} the review rated “${common.toLowerCase()}”`
      : n === 1 ? `Keep the 1 judge the review says ${verb.replace('meet', 'meets')}` : `Keep all ${n} judges the review says ${verb}`;
    for (const x of withOfficial) {
      const off = evs(x.c).find(isOfficial)!;
      const why = [voteAgainst(off.vote) ? `a ${off.vote} vote` : '', evs(x.c).some((e) => e.noted_concern) ? 'a noted concern' : '', evalState(off) !== 'yes' ? off.rating.toLowerCase() : ''].filter(Boolean).join(' and ');
      if (why) readFirst.push({ id: x.it.id, name: x.c.name, why });
    }
  } else if (withBars.length) {
    const st = (x: (typeof open)[number]) => evs(x.c).filter((e) => e.kind === 'bar_group').map(evalState);
    targets = withBars.filter((x) => { const s = st(x); return s.includes('yes') && s.every((v) => v === 'yes' || v === 'unrated'); });
    label = `Keep the ${targets.length} ${targets.length === 1 ? 'judge' : 'judges'} the bar groups recommend`;
    for (const x of withBars) {
      const s = st(x);
      const no = s.filter((v) => v === 'no').length, dec = s.filter((v) => v === 'declined').length;
      const why = [no ? `${no} of ${s.length} groups say no` : '', dec ? `skipped ${dec} ${dec === 1 ? 'screening' : 'screenings'}` : ''].filter(Boolean).join(' and ');
      if (why) readFirst.push({ id: x.it.id, name: x.c.name, why });
    }
  } else return null;
  if (!targets.length) return null;
  return { label, targets: targets.map((x) => ({ key: x.key, id: x.it.id, name: x.c.name })), readFirst, left: open.length - targets.length };
}
