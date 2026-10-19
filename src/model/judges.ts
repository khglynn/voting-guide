/* Judges: what their official reviews and bar ratings say, in one line, worded as the
   reviewer's rating and never as ours. Read from candidates' structured `evaluations`
   (the Oct 19 data contract). A judge with none shows no review line, not a guess. */
import type { Candidate, Contest, Evaluation, JudicialReview } from '../types';
import { S } from '../state';
import { entriesBySection, status, isMultiJudge } from '../ballot';

export interface Review {
  main: string;           // the narrow column: "Meets standards", "7 of 13 say no"
  sub: string;            // "Commission 10-0", "bar groups"
  tone: 'fav' | 'unfav' | 'mixed';
  line: string;           // one plain sentence for the open row
  split: boolean;         // a reviewer voted against, or groups disagree
  concerns: { by: string; text: string }[];
  strengths: { by: string; text: string }[];
  links: { label: string; url: string }[];
}

const isOfficial = (e: Evaluation) => e.kind === 'official_commission' || e.kind === 'bar_committee';
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/* "Meets Performance Standards" -> "Meets standards"; long ratings fall back to the verdict. */
export function shortRating(e: Evaluation): string {
  const r = e.rating.replace(/\bperformance\s+/i, '').replace(/\bjudicial\s+/i, '').replace(/\boverall\s+/i, '').trim();
  const s = sentence(r.toLowerCase());
  if (s.length <= 22) return s;
  return e.verdict === 'favorable' ? 'Favorable review' : e.verdict === 'unfavorable' ? 'Unfavorable review' : e.verdict === 'mixed' ? 'Mixed review' : sentence(e.rating.split(/[,;:]/)[0].toLowerCase()).slice(0, 22);
}
const lastName = (c: Candidate) => c.short || c.name.split(' ').pop() || c.name;
const voteAgainst = (v: string | null): number => { const m = (v || '').match(/(\d+)\s*[-–]\s*(\d+)/); return m ? +m[2] : 0; };

export function candidateReview(c: Candidate): Review | null {
  const ev = c.evaluations || [];
  if (!ev.length) return null;
  const concerns = ev.filter((e) => e.noted_concern).map((e) => ({ by: e.by_short, text: e.noted_concern! }));
  const strengths = ev.filter((e) => e.noted_strength).map((e) => ({ by: e.by_short, text: e.noted_strength! }));
  const links = ev.filter((e, i, a) => a.findIndex((x) => x.url === e.url) === i).slice(0, 4).map((e) => ({ label: `${e.by_short}: the full review`, url: e.url }));
  const off = ev.find(isOfficial);
  if (off) {
    const against = voteAgainst(off.vote);
    const tone: Review['tone'] = off.verdict === 'favorable' ? (against ? 'mixed' : 'fav') : off.verdict === 'unfavorable' ? 'unfav' : 'mixed';
    const verbal = /^(meets|does not meet|substantially meets|exceeds)\b/i.test(off.rating);
    const line = verbal
      ? `${off.by} ${off.vote ? `voted ${off.vote}` : 'found'} that Judge ${lastName(c)} ${off.rating.toLowerCase()}.`
      : `${off.by}: ${off.rating}${off.vote ? ` (vote ${off.vote})` : ''}.`;
    return { main: shortRating(off), sub: [off.by_short, off.vote].filter(Boolean).join(' '), tone, line, split: against > 0, concerns, strengths, links };
  }
  const bars = ev.filter((e) => e.kind === 'bar_group');
  if (bars.length > 1) {
    const no = bars.filter((e) => e.verdict === 'unfavorable');
    const yes = bars.filter((e) => e.verdict === 'favorable');
    const tone: Review['tone'] = !no.length ? 'fav' : no.length * 2 > bars.length ? 'unfav' : 'mixed';
    const main = no.length ? `${no.length} of ${bars.length} say no` : `${yes.length} of ${bars.length} say keep`;
    const line = no.length
      ? `${no.length} of ${bars.length} bar groups say don’t keep Judge ${lastName(c)}: ${no.map((e) => e.by_short).join(', ')}. ${yes.length} say keep.`
      : `All ${bars.length} bar groups that rated Judge ${lastName(c)} say keep.`;
    return { main, sub: 'bar groups', tone, line, split: no.length > 0 && yes.length > 0, concerns, strengths, links };
  }
  const e = ev[0];
  const tone: Review['tone'] = e.verdict === 'favorable' ? 'fav' : e.verdict === 'unfavorable' ? 'unfav' : 'mixed';
  return { main: shortRating(e), sub: e.by_short, tone, line: `${e.by}: ${e.rating}.`, split: false, concerns, strengths, links };
}

/* One contest: a single judge's review, or a summary across a batch of judges. */
export function judgeReview(it: Contest): Review | null {
  if (!isMultiJudge(it)) return it.candidates[0] ? candidateReview(it.candidates[0]) : null;
  const rs = it.candidates.map(candidateReview);
  const have = rs.filter((r): r is Review => !!r);
  if (!have.length) return null;
  const fav = have.filter((r) => r.tone === 'fav').length;
  const n = it.candidates.length;
  const tone: Review['tone'] = fav === n ? 'fav' : have.some((r) => r.tone === 'unfav') ? 'unfav' : 'mixed';
  return {
    main: fav === n ? `All ${n} favorable` : `${fav} of ${n} favorable`,
    sub: have[0].sub.replace(/\s*\d+\s*[-–]\s*\d+$/, ''),
    tone, line: `${fav} of ${n} judges got a favorable review.`, split: have.some((r) => r.split),
    concerns: have.flatMap((r) => r.concerns), strengths: [], links: [],
  };
}

export const judicialReview = (): JudicialReview | null => S.ballot?.howto.judicial_review || null;
export const hasEvaluations = (it: Contest): boolean => it.candidates.some((c) => (c.evaluations || []).length > 0);

/* ---------- the batch: keep every judge the review favors ---------- */
export interface JudgeBatch {
  label: string;
  targets: { key: string; id: string; name: string }[];
  readFirst: { id: string; name: string; why: string }[];   // split votes and noted concerns, listed for a careful voter
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
  const withOfficial = open.filter((x) => (x.c.evaluations || []).some(isOfficial));
  const withBars = open.filter((x) => (x.c.evaluations || []).filter((e) => e.kind === 'bar_group').length > 1);
  let targets: typeof open = [];
  let label = '';
  const readFirst: JudgeBatch['readFirst'] = [];
  if (withOfficial.length) {
    targets = withOfficial.filter((x) => (x.c.evaluations || []).find(isOfficial)!.verdict === 'favorable');
    const ratings = targets.map((x) => (x.c.evaluations || []).find(isOfficial)!.rating);
    const common = ratings.sort((a, c) => ratings.filter((r) => r === c).length - ratings.filter((r) => r === a).length)[0] || '';
    label = `Keep every judge the review rated “${common.toLowerCase()}”`;
    for (const x of withOfficial) {
      const off = (x.c.evaluations || []).find(isOfficial)!;
      const why = [voteAgainst(off.vote) ? `a ${off.vote} vote` : '', (x.c.evaluations || []).some((e) => e.noted_concern) ? 'a noted concern' : '', off.verdict !== 'favorable' ? off.rating.toLowerCase() : ''].filter(Boolean).join(' and ');
      if (why) readFirst.push({ id: x.it.id, name: x.c.name, why });
    }
  } else if (withBars.length) {
    targets = withBars.filter((x) => (x.c.evaluations || []).filter((e) => e.kind === 'bar_group').every((e) => e.verdict === 'favorable'));
    label = 'Keep every judge all the bar groups recommend';
    for (const x of withBars) {
      const bars = (x.c.evaluations || []).filter((e) => e.kind === 'bar_group');
      const no = bars.filter((e) => e.verdict === 'unfavorable').length;
      if (no) readFirst.push({ id: x.it.id, name: x.c.name, why: `${no} of ${bars.length} groups say no` });
    }
  } else return null;
  if (!targets.length) return null;
  return { label, targets: targets.map((x) => ({ key: x.key, id: x.it.id, name: x.c.name })), readFirst, left: open.length - targets.length };
}
