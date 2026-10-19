/* "Full details": one item in one editorial language (headings and rules, no chips or grids).
   Candidates' own words with quotes marked and paraphrases labeled, every source's reason with
   its link and date, official text verbatim, official links. */
import type { Candidate, Contest, Endorser, Evaluation, Item, Measure } from '../types';
import { S } from '../state';
import { chosenIds, isMultiJudge, isPartisan, isRCV } from '../ballot';
import { esc, host } from '../util';
import { rowTitle, courtOf, choiceShort } from '../model/labels';
import { judicialReview, evalState, surveyLines, surveySentence, strengthOf, hasRatings } from '../model/judges';
import { explainsOnly } from '../model/lens';
import { ext, escP, sourceLean, srcLink, confLabel } from './common';
import { sectionTitle } from './ledger';
import { rcvURL, reportLink, raceRatingsHTML } from './open';
import { sectionOf } from '../ballot';

const sec = (title: string, body: string, sub = ''): string => (body ? `<section class="rd-sec"><h3>${esc(title)}</h3>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}${body}</section>` : '');
const para = (t: string | null | undefined): string => (t ? `<p>${escP(t)}</p>` : '');

function ownWords(c: Candidate): string {
  if (!c.own_words.length) {
    if (c.own_words_status === 'none_found') {
      const ch = c.own_words_checked;
      return `<p class="fine">No campaign statement found${ch ? `. We checked ${esc(ch.where.join(', ') || 'their sites')} on ${esc(ch.on)}` : ''}.</p>`;
    }
    return '<p class="fine">We haven’t looked up their own words yet.</p>';
  }
  return c.own_words.map((o) => `<figure class="pq${o.is_quote ? '' : ' para'}"><blockquote>${o.is_quote ? (/["“”]/.test(o.text) ? esc(o.text) : `“${esc(o.text)}”`) : escP(o.text)}</blockquote>
    <figcaption>${o.is_quote ? 'In their words' : 'Paraphrased by us'}${o.source ? `. ${srcLink(o.source)}` : ''}</figcaption></figure>`).join('');
}
function backers(it: Item, name: string): { mine: Endorser[]; others: Endorser[] } {
  const b = S.ballot!;
  const ids = new Set(chosenIds());
  const row = b.ends[it.id] || {};
  const all = Object.entries(row).filter(([, en]) => en.s === 'endorsed' && en.c && en.c.includes(name)).map(([eid]) => b.eById.get(eid)).filter((e): e is Endorser => !!e);
  return { mine: all.filter((e) => ids.has(e.id)), others: all.filter((e) => !ids.has(e.id)) };
}
function candBlock(c: Contest, k: Candidate): string {
  const by = backers(c, k.name);
  const who = [isPartisan(c) ? k.party || 'No party listed' : '', k.incumbent ? 'Incumbent' : ''].filter(Boolean).join('. ');
  return `<div class="cand-blk"><h4>${esc(k.name)}</h4>${who ? `<p class="who">${esc(who)}</p>` : ''}
    ${ownWords(k)}
    ${k.background ? `<p class="bg">${escP(k.background)}</p>` : ''}
    ${by.mine.length ? `<p class="backs"><b>Endorsed by your sources:</b> ${esc(by.mine.map((e) => e.short).join(', '))}.</p>` : ''}
    ${by.others.length ? `<p class="backs"><b>Also endorsed by:</b> ${esc(by.others.map((e) => e.short).join(', '))}.</p>` : ''}
    ${k.website || k.lwv_url ? `<p class="site">${k.website ? `${ext(k.website, 'Campaign site')}${k.website_confidence === 'unverified' ? ' <span class="flag">We’re not sure this is their site</span>' : ''}` : ''}${k.website && k.lwv_url ? ' · ' : ''}${k.lwv_url ? ext(k.lwv_url, k.lwv_status === 'responded' ? 'Their answers to the League of Women Voters' : 'League of Women Voters guide') : ''}</p>` : ''}
  </div>`;
}
function sourcesSaid(it: Item): string {
  const b = S.ballot!;
  const ids = new Set(chosenIds());
  const row = b.ends[it.id] || {};
  const list = Object.entries(row).map(([eid, en]) => ({ e: b.eById.get(eid)!, en })).filter((x) => x.e && !(explainsOnly(x.e) && x.en.s !== 'endorsed'));
  list.sort((a, c) => (ids.has(c.e.id) ? 1 : 0) - (ids.has(a.e.id) ? 1 : 0) || (a.en.s === 'endorsed' ? -1 : 1) - (c.en.s === 'endorsed' ? -1 : 1) || a.e.name.localeCompare(c.e.name));
  if (!list.length) return '';
  return list.map(({ e, en }) => {
    const st = en.s === 'no_position' ? '<p class="st np">Took no stand</p>' : en.s === 'not_found' ? '<p class="st nf">No endorsement found</p>'
      : `<p class="st end">${en.both ? 'Lists campaigns on both sides' : esc((en.c || []).map((x) => choiceShort(it, x)).join(', ') || en.note || 'Endorsed')}${en.note && en.c ? ` (${esc(en.note)})` : ''}</p>`;
    return `<div class="ent"><div class="ent-h"><b>${esc(e.name)}</b>${ids.has(e.id) ? '<span class="mine-tag">your source</span>' : ''}</div>${sourceLean(e)}${st}
      ${en.why ? `<p>${escP(en.why)}</p>` : ''}
      <p class="src">${[en.url ? ext(en.url, host(en.url)) : '', en.date ? esc(en.date) : '', confLabel(en.conf)].filter(Boolean).join(' · ')}</p></div>`;
  }).join('');
}
function guides(it: Item): string {
  const b = S.ballot!;
  const ids = new Set(chosenIds());
  const g = b.endorsers.filter((e) => ids.has(e.id) && e.guide_url && (explainsOnly(e) || (it.kind === 'measure' ? !e.endorses_measures : !e.endorses_candidates)));
  return g.map((e) => `<div class="guide">${ext(e.guide_url, `${e.short}’s guide`, 'gt')}<p class="by">${esc(e.name)}. Explains without picking.</p></div>`).join('');
}
/* One reviewer's entry, with the same rules as the open row: survey rows say how many
   answered (none under 5 as a percentage), boilerplate never shows as a strength when the
   survey disagrees, and a reason for not rating is labeled as a reason, not a finding.
   Lawyer polls are counts, shown for the whole race (raceRatingsHTML), never here. */
function evalBlock(e: Evaluation, name: string): string {
  if (e.kind === 'bar_poll') return '';
  const st = evalState(e);
  const plain = surveySentence(e, name);
  const lines = plain ? [] : surveyLines(e);
  const strength = strengthOf(e);
  const reason = !!e.noted_concern && (st === 'declined' || st === 'unrated');
  const sv = e.survey;
  const survey = plain ? `<p>${esc(plain.sentence)}</p>${plain.note ? `<p class="fine">${esc(plain.note)}</p>` : ''}${sv && sv.question ? `<p class="fine">The survey asked: “${esc(sv.question)}”</p>` : ''}${sv && sv.report_url ? `<p class="fine">${ext(sv.report_url, 'Full survey report')}</p>` : ''}`
    : lines.length
    ? `<p>${esc(sv && sv.question ? `The survey asked: ${sv.question}` : 'The survey:')}</p><ul class="bul">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>${sv && sv.caution ? `<p class="fine">${esc(sv.caution)}</p>` : ''}${sv && sv.report_url ? `<p class="fine">${ext(sv.report_url, 'The survey report')}</p>` : ''}`
    : e.survey_note ? `<p class="fine">${esc(e.survey_note)}</p>` : '';
  return `<div class="ent"><div class="ent-h"><b>${esc(e.by)}</b></div><p class="st end">${esc(e.rating)}${e.vote ? ` (vote ${esc(e.vote)}${e.vote_note ? `; ${esc(e.vote_note.replace(/\.$/, ''))}` : ''})` : ''}${st === 'declined' ? ' <span class="muted">(the candidate did not take part in this screening)</span>' : ''}</p>
    ${survey}
    ${strength ? `<p><b>Noted:</b> “${esc(strength)}”</p>` : ''}${e.noted_concern ? `<p><b>${reason ? 'Their reason' : 'A concern'}:</b> “${esc(e.noted_concern)}”</p>` : ''}
    <p class="src">${ext(e.url, host(e.url))}${e.verified_on ? ` · checked ${esc(e.verified_on)}` : ''}${confLabel(e.confidence) ? ` · ${confLabel(e.confidence)}` : ''}</p></div>`;
}
/* Every bar rating in a contested race as the group published it: the full rating text (it carries
   the scope and date, like "June 11, 2026 primary review"), any vote, the source and when we
   checked it. The summary above counts them; this is the record. Polls are counts, shown above. */
function ratingsAsPublished(c: Contest): string {
  const blocks = c.candidates.map((k) => {
    const ev = (k.evaluations || []).filter((e) => e.kind !== 'bar_poll');
    if (!ev.length) return '';
    return `<li><b>${esc(k.name)}</b><ul class="bul">${ev.map((e) => `<li>${esc(e.by)}: ${escP(e.rating)}${e.vote ? ` (vote ${esc(e.vote)})` : ''}. ${ext(e.url, host(e.url))}${e.verified_on ? ` <span class="host">checked ${esc(e.verified_on)}</span>` : ''}</li>`).join('')}</ul></li>`;
  }).filter(Boolean);
  return blocks.length ? `<ul class="links rated">${blocks.join('')}</ul>` : '';
}
function links(list: { name: string; url: string }[]): string {
  return list.length ? `<ul class="links">${list.map((s) => `<li>${ext(s.url, s.name)} <span class="host">${esc(host(s.url))}</span></li>`).join('')}</ul>` : '';
}

function raceRead(c: Contest): string {
  const r = rowTitle(c);
  return `<span class="num">${esc(sectionTitle(sectionOf(c)))}</span><h2>${esc(r.title)}</h2>${r.sub ? `<p class="facts">${esc(r.sub)}</p>` : ''}
    ${c.office_explainer ? `<p class="lede">${escP(c.office_explainer)}</p>` : ''}
    <p class="facts">${[c.scope_plain ? escP(c.scope_plain.replace(/\s*$/, '').replace(/([^.!?])$/, '$1.')) : '', c.term_years ? `${c.term_years}-year term.` : '', c.open_seat ? 'Open seat: no incumbent running.' : c.incumbent ? `Now held by ${esc(c.incumbent)}.` : '', !isPartisan(c) ? 'Nonpartisan race: no party labels on the ballot.' : ''].filter(Boolean).join(' ')}</p>
    ${isRCV(c) ? `<p class="facts"><b>Ranked choice: rank up to ${c.rank_up_to}.</b> ${esc(c.rcv_how || '')} ${rcvURL(c) ? ext(rcvURL(c), 'How the count works') : ''}</p>` : ''}
    ${c.why_it_matters ? sec('Why it matters', para(c.why_it_matters)) : ''}
    ${sec('The candidates, in their own words', c.candidates.map((k) => candBlock(c, k)).join(''), 'Quote marks mean their exact words. Anything else is our summary, labeled.')}
    ${hasRatings(c) ? sec('Lawyer polls and bar association ratings', raceRatingsHTML(c)) : ''}
    ${sec('Ratings, word for word', ratingsAsPublished(c), 'With what each one covered, when, and a link to the reviewer’s own page.')}
    ${sec('Guides that explain without endorsing', guides(c))}
    ${sec('What each source said', sourcesSaid(c), 'Your sources come first.')}
    ${sec('Official and source links', links(c.sources))}`;
}
function measureRead(m: Measure): string {
  return `<span class="num">${esc(m.jurisdiction)}</span><h2>${esc(m.number)}</h2>
    ${m.plain_summary ? `<p class="lede">${escP(m.plain_summary)}</p>` : ''}
    ${m.pass_threshold ? `<p class="facts"><b>To pass:</b> ${escP(m.pass_threshold)}</p>` : ''}
    ${sec('What your vote does', `<div class="case"><h4>A yes vote means</h4><p>${escP(m.yes_means || 'Not written up yet.')}</p></div><div class="case"><h4>A no vote means</h4><p>${escP(m.no_means || 'Not written up yet.')}</p></div>${m.current_law ? `<div class="case"><h4>The law today</h4><p>${escP(m.current_law)}</p></div>` : ''}`)}
    ${m.confusing_wording_note ? sec('The catch in the wording', para(m.confusing_wording_note)) : ''}
    ${m.supporters_case || m.opponents_case ? sec('The case for and against', `${m.supporters_case ? `<div class="case"><h4>Supporters say</h4><p>${escP(m.supporters_case.text)} ${srcLink(m.supporters_case.source)}</p></div>` : ''}${m.opponents_case ? `<div class="case"><h4>Opponents say</h4><p>${escP(m.opponents_case.text)} ${srcLink(m.opponents_case.source)}</p></div>` : ''}`) : ''}
    ${m.fiscal_impact ? sec('What it costs', para(m.fiscal_impact)) : ''}
    ${sec('What each source said', sourcesSaid(m), 'Your sources come first.')}
    ${sec('Guides that explain without picking', guides(m))}
    ${m.explainers.length ? sec('News explainers', links(m.explainers.map((e) => ({ name: e.title ? `${e.source}: ${e.title}` : e.source, url: e.url })))) : ''}
    ${m.official_title ? sec('The ballot language, word for word', `<p class="fine ballot-lang">${esc(m.official_title)}</p>`) : ''}
    ${sec('Official links', links([m.official_text_url ? { name: 'Official text', url: m.official_text_url } : null, m.official_guide_url ? { name: 'Official voter guide', url: m.official_guide_url } : null].filter((x): x is { name: string; url: string } => !!x)))}`;
}
function judgeRead(c: Contest): string {
  const jr = judicialReview();
  const judges = isMultiJudge(c) ? c.candidates : [c.candidates[0]];
  const blocks = judges.map((k) => `<div class="cand-blk"><h4>${esc(k.name)}</h4>
    ${(k.evaluations || []).map((e) => evalBlock(e, k.name)).join('')}
    ${k.background ? `<p class="bg">${escP(k.background)}</p>` : ''}${k.own_words.length || k.own_words_status ? ownWords(k) : ''}
    ${k.website ? `<p class="site">${ext(k.website, 'More about this judge')}</p>` : ''}</div>`).join('');
  return `<span class="num">${esc(courtOf(c))}</span><h2>${esc(isMultiJudge(c) ? courtOf(c) : c.candidates[0].name)}</h2>
    ${c.office_explainer ? `<p class="lede">${escP(c.office_explainer)}</p>` : ''}
    ${c.why_it_matters ? para(c.why_it_matters) : ''}
    ${sec(isMultiJudge(c) ? 'The judges and their reviews' : 'Reviews of this judge', blocks)}
    ${jr ? sec('What judges’ reviews mean here', [jr.what_the_rating_means, jr.who_reviews, jr.what_it_doesnt_mean, jr.how_judges_get_here, jr.to_keep_a_judge, jr.history].filter(Boolean).map((t) => para(t)).join('') + (jr.read_one ? `<p>${ext(jr.read_one.url, jr.read_one.label)}</p>` : '') + links(jr.sources)) : ''}
    ${sec('What each source said', sourcesSaid(c))}
    ${sec('Official and source links', links(c.sources))}`;
}

export function readerHTML(id: string): string {
  const it = S.ballot!.byId.get(id);
  if (!it) return '';
  const body = it.kind === 'measure' ? measureRead(it) : it.is_retention ? judgeRead(it) : raceRead(it);
  return `<div class="reader screen-only" role="dialog" aria-modal="true" aria-label="Full details" data-keep="reader">
    <div class="reader-bar"><span class="crumb">Full details</span><button class="closebtn" data-act="reader-close" data-fk="reader-x">Back to my ballot</button></div>
    <article class="rd wrap">${body}<p class="fine report">${ext(reportLink(it), 'Report a problem with this page')}. It’s a short form, no sign-in needed.</p></article></div>`;
}
