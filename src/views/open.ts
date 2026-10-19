/* An open row: what this race, measure or judge is, who among your sources weighed in, and
   the buttons to decide. One tap deeper ("Full read") is the reader. */
import type { Candidate, Contest, Endorser, Item, Measure } from '../types';
import { S } from '../state';
import { status, isRCV, isMultiSeat, isMultiJudge, isPartisan, rankMax, ranksOf, ordinal, chosen, chosenIds } from '../ballot';
import { esc, hash, plural, host } from '../util';
import { lineup, weighedIn, orderCandidates, tagOf, type Lineup } from '../model/tally';
import { candidateReview, judicialReview, type Review } from '../model/judges';
import { seatLabel, cheatTitle } from '../model/labels';
import { picksOnBallot } from '../model/lens';
import { leanHTML, ext, clampP, escP, sampleBallot, isOpen, leadRest, srcLink } from './common';
import { headsUp, headsHTML } from './ledger';

/* "Report a problem" goes to a Google Form in Kevin's personal account (picked Oct 16).
   The two entry ids prefill "Which race or measure?" and "Where are you voting?". */
const REPORT_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSdTJFFXbh5ZlZzDmoqvbD5uGEKopuk2zy-nsl4dqmjNA65bOQ/viewform';
export function reportLink(it: Item): string {
  const b = S.ballot!;
  const where = [b.places.map((p) => p.label).join(' / ') || b.stateName, S.b.zip].filter(Boolean).join(', ');
  const q = new URLSearchParams({ usp: 'pp_url', 'entry.90887649': `${cheatTitle(it)} [${it.id}]`, 'entry.628621310': where });
  return `${REPORT_URL}?${q.toString()}`;
}

const CHECK = '<svg viewBox="0 0 14 14" aria-hidden="true" focusable="false"><path d="M2.5 7.4l3 3 6-6.6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square"/></svg>';
const ARROW = '<svg viewBox="0 0 18 18" aria-hidden="true" focusable="false"><path d="M6 3l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
const PAGE = 3;

/* ---------- the top of an open row: where it applies ---------- */
function whereHTML(it: Item): string {
  const b = S.ballot!;
  if (it.kind !== 'contest') return b.onlyIn[it.id] ? `<p class="ob-meta">Only on ballots in ${esc(b.onlyIn[it.id].join(', '))}.</p>` : '';
  const g = b.groupOf[it.id];
  if (g) {
    const ans = S.b.districts[g];
    const grp = b.groups.find((x) => x.key === g)!;
    if (ans === it.id) return `<p class="ob-meta">You said you’re in ${esc(seatLabel(it) || 'this district')}. <button class="linkbtn" data-act="district-change" data-g="${esc(g)}">Change</button></p>`;
    return `<p class="ob-meta"><b>May apply.</b> You weren’t sure which ${esc(grp.office)} district is yours, so all ${grp.members.length} show. ${escP(it.scope_plain)} <button class="linkbtn" data-act="district-change" data-g="${esc(g)}">Choose one</button></p>`;
  }
  if (b.onlyIn[it.id]) return `<p class="ob-meta">Only on ballots in ${esc(b.onlyIn[it.id].join(', '))}. <button class="linkbtn" data-act="notmine" data-id="${esc(it.id)}">Not on my ballot</button></p>`;
  if (b.mayApply.has(it.id)) {
    const same = [...b.mayApply].filter((id) => id !== it.id && !S.b.notMine.includes(id) && (b.byId.get(id) as Contest | undefined)?.scope_plain === it.scope_plain);
    return `<div class="may"><p><b>Only some voters see this.</b> ${escP(it.scope_plain)}</p>
      <p class="may-acts"><button class="mini" data-act="notmine" data-id="${esc(it.id)}" data-fk="nm-${esc(it.id)}">Not on my ballot</button>${same.length ? `<button class="mini quiet" data-act="notmine" data-id="${esc(it.id)}" data-all="1">Hide all ${same.length + 1} like this</button>` : ''}</p></div>`;
  }
  return '';
}

/* ---------- the sideways grid ---------- */
function lookedSources(l: Lineup): Endorser[] {
  return [...weighedIn(l), ...l.noStand, ...l.notFound];
}
function quietLines(l: Lineup, it: Item): string {
  const out: string[] = [];
  if (l.notChecked.length) out.push(`Not checked yet: ${l.notChecked.map(tagOf).join(', ')}.`);
  if (l.both.length) out.push(`${l.both.map(tagOf).join(', ')} ${l.both.length === 1 ? 'lists' : 'list'} campaigns on both sides.`);
  const guides = l.guides.filter((e) => e.guide_url || picksOnBallot(S.ballot!, e.id) === 0);
  if (guides.length) {
    const what = it.kind === 'measure' ? 'take positions on measures' : 'pick candidates';
    out.push(`${guides.map((e) => (e.guide_url ? ext(e.guide_url, tagOf(e)) : esc(tagOf(e)))).join(', ')} ${guides.length === 1 ? 'doesn’t' : 'don’t'} ${what}; ${guides.length === 1 ? 'its guide explains' : 'their guides explain'}.`);
  }
  return out.length ? `<p class="gridnote">${out.join(' ')}</p>` : '';
}
function srcCell(e: Endorser): string {
  return `<th scope="row"><span class="sn">${esc(tagOf(e))}</span>${leanHTML(e.lean)}</th>`;
}
function spanCell(it: Item, e: Endorser, cols: string[], n: number): string | null {
  const r = (S.ballot!.ends[it.id] || {})[e.id];
  if (!r) return null;
  if (r.s === 'no_position') return `<td class="span np" colspan="${n}">Took no stand</td>`;
  if (r.s === 'not_found') return `<td class="span nf" colspan="${n}">Nothing found</td>`;
  const c = r.c || [];
  if (!c.some((x) => cols.includes(x))) {
    const names = c.length ? c.map((x) => (it.kind === 'contest' ? (it.candidates.find((k) => k.name === x)?.short || x) : x)).join(', ') : (r.note || 'Endorsed');
    return `<td class="span" colspan="${n}">Backs ${esc(names)}</td>`;
  }
  return null;
}
function gridHTML(it: Item, l: Lineup, cols: { key: string; head: string; sub: string; mine: boolean }[], foot: string): string {
  const rows = lookedSources(l);
  const keys = cols.map((c) => c.key);
  const body = rows.map((e) => {
    const span = spanCell(it, e, keys, cols.length);
    if (span) return `<tr>${srcCell(e)}${span}</tr>`;
    const r = (S.ballot!.ends[it.id] || {})[e.id]!;
    return `<tr>${srcCell(e)}${cols.map((c) => `<td class="${c.mine ? 'col-me' : ''}">${(r.c || []).includes(c.key) ? `<span class="hit" role="img" aria-label="${esc(tagOf(e))} backs ${esc(c.head)}">${CHECK}</span>` : ''}</td>`).join('')}</tr>`;
  }).join('');
  return `<div class="gridwrap"><table class="grid c${cols.length}">
    <colgroup><col class="src">${cols.map(() => '<col>').join('')}</colgroup>
    <thead><tr><th class="corner" scope="col">Your sources</th>${cols.map((c) => `<th scope="col" class="cand${c.mine ? ' col-me' : ''}"><span class="nm">${esc(c.head)}</span>${c.sub ? `<span class="py">${esc(c.sub)}</span>` : ''}</th>`).join('')}</tr></thead>
    <tbody>${body}</tbody>
    ${foot ? `<tfoot><tr><td></td>${foot}</tr></tfoot>` : ''}
  </table></div>`;
}
/* When none of your sources weighed in: one calm line instead of an empty table. */
function noneLineHTML(it: Item, l: Lineup): string {
  const parts: string[] = [];
  if (!chosen().length) parts.push('You haven’t chosen any sources.');
  else if (!l.relevant.length) parts.push(`None of your sources cover this ${it.kind === 'measure' ? 'measure' : 'race'}.`);
  else {
    const bits: string[] = [];
    if (l.noStand.length) bits.push(`${l.noStand.map(tagOf).join(', ')} took no stand`);
    if (l.notFound.length) bits.push(`we found no pick from ${l.notFound.map(tagOf).join(', ')}`);
    if (l.notChecked.length) bits.push(`${l.notChecked.map(tagOf).join(', ')} not checked yet`);
    parts.push(`Your sources haven’t picked here: ${bits.join('; ')}.`);
  }
  return `<p class="none-line">${esc(parts.join(' '))}</p>`;
}
/* Sources outside your lens that did pick here, marked as such. */
function othersHTML(it: Item): string {
  const ids = new Set(chosenIds());
  const others = S.ballot!.endorsers.filter((e) => !ids.has(e.id));
  const ol = lineup(it, others);
  const w = weighedIn(ol);
  if (!w.length) return '';
  const k = it.id;
  const open = S.ui.others.has(k);
  const list = open ? `<ul class="others">${ol.groups.flatMap((g) => g.sources.map((e) => `<li><span class="o-n">${esc(e.short)}</span>${leanHTML(e.lean)}<span class="o-p">${esc(g.label)}</span>
      <button class="mini quiet" data-act="src" data-id="${esc(e.id)}" data-fk="add-${esc(it.id)}-${esc(e.id)}">Add to my sources</button></li>`)).join('')}</ul>` : '';
  return `<div class="others-wrap"><button class="linkbtn" data-act="others" data-id="${esc(k)}" aria-expanded="${open}">${open ? 'Hide' : 'See'} ${plural(w.length, 'other source')} that picked here</button>${list}</div>`;
}

/* ---------- buttons ---------- */
function pickBtn(c: Contest, k: Candidate, cls = 'pick'): string {
  const id = esc(c.id);
  const fk = `pk-${id}-${hash(k.name, 4)}`;
  if (isRCV(c)) {
    const list = ranksOf(c.id);
    const r = list.indexOf(k.name) + 1;
    const label = r ? `Your ${ordinal(r)}<span class="vh">: ${esc(k.short)}. Tap to remove.</span>` : list.length < rankMax(c) ? `Rank<span class="vh"> ${esc(k.short)}</span> ${ordinal(list.length + 1)}` : `Rank<span class="vh"> ${esc(k.short)}</span>`;
    return `<button class="${cls}${r ? ' on' : ''}" data-act="rank" data-id="${id}" data-v="${esc(k.name)}" aria-pressed="${r > 0}" data-fk="${fk}">${label}</button>`;
  }
  if (isMultiSeat(c)) {
    const on = S.b.picks[`${c.id}|${k.name}`] === 'PICK';
    return `<button class="${cls}${on ? ' on' : ''}" data-act="mpick" data-id="${id}" data-v="${esc(k.name)}" aria-pressed="${on}" data-fk="${fk}">${on ? `${CHECK} Marked` : 'Mark'}<span class="vh"> ${esc(k.short)}</span></button>`;
  }
  const on = S.b.picks[c.id] === k.name;
  return `<button class="${cls}${on ? ' on' : ''}" data-act="pick" data-id="${id}" data-v="${esc(k.name)}" aria-pressed="${on}" data-fk="${fk}">${on ? `${CHECK} Your pick` : 'Pick'}<span class="vh"> ${esc(k.short)}</span></button>`;
}
const partyText = (c: Contest, k: Candidate): string => (isPartisan(c) ? k.party || 'No party listed' : '');

/* ---------- races ---------- */
const WINNERS = ['', 'One person wins.', 'Two people win.', 'Three people win.', 'Four people win.', 'Five people win.', 'Six people win.'];
const HOW_ONE = 'If no one has a majority of first choices, last place is dropped and those ballots count for their next choice, until someone has a majority.';
const HOW_MANY = 'Your vote counts for your top choice; if they’re knocked out, or already have enough votes to win, your vote (or the extra part of it) moves to your next choice.';
export function rcvURL(it: Contest): string | null {
  return it.rcv_url || it.sources.find((x) => /ranked.choice|\brcv\b/i.test(`${x.name} ${x.url}`))?.url || null;
}
function rcvHeadHTML(it: Contest): string {
  const url = rcvURL(it);
  return `<div class="rcv"><p><b>Ranked choice: rank up to ${it.rank_up_to}.</b> ${WINNERS[it.winners] || `${it.winners} people win.`}</p>
    <p class="small">${esc(it.rcv_how || (it.winners > 1 ? HOW_MANY : HOW_ONE))}${url ? ` ${ext(url, 'How the count works')} <span class="host">${esc(host(url))}</span>` : ''}</p></div>`;
}
const UP = '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false"><path d="M10 4l-6 6.5M10 4l6 6.5M10 4v12.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></svg>';
const X = '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false"><path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></svg>';
function rankPanelHTML(it: Contest): string {
  const list = ranksOf(it.id);
  const max = rankMax(it);
  const id = esc(it.id);
  const extra = (it.rank_up_to || 0) > it.candidates.length ? ' The ballot also has a write-in line you can rank.' : '';
  if (!list.length) return `<p class="rank-empty">Tap <b>Rank</b> on candidates in the order you like them. You can rank just one. Ranking more never hurts your first choice.${extra}</p>`;
  const rows = list.map((name, i) => {
    const h = hash(name, 4);
    return `<li class="rank-row"><span class="rank-n" aria-hidden="true">${i + 1}</span><span class="rank-nm"><span class="vh">${ordinal(i + 1)}: </span>${esc(name)}</span>
      ${i > 0 ? `<button class="ibtn" data-act="rup" data-id="${id}" data-v="${esc(name)}" aria-label="Move ${esc(name)} up to ${ordinal(i)}" title="Move up" data-fk="ru-${id}-${h}">${UP}</button>` : '<span class="ibtn-ph" aria-hidden="true"></span>'}
      <button class="ibtn" data-act="rx" data-id="${id}" data-v="${esc(name)}" aria-label="Remove ${esc(name)} from your ranking" title="Remove" data-fk="rx-${id}-${h}">${X}</button></li>`;
  }).join('');
  const left = list.length < max ? `${list.length} of ${max} ranked. Tap Rank on another candidate to add them ${ordinal(list.length + 1)}.` : `All ${max} ranked.`;
  return `<div class="rank-panel" role="group" aria-labelledby="rk-${id}"><span class="kick" id="rk-${id}">Your ranking</span>
    <ol class="rank-list">${rows}</ol><p class="small">${left}${list.length < max ? extra : ''}</p>
    <button class="pick on rdone" data-act="rdone" data-id="${id}" data-fk="rd-${id}">Done ranking</button></div>`;
}
function backedBy(c: Contest, k: Candidate, l: Lineup): string {
  const by = l.groups.filter((g) => g.choices.includes(k.name)).flatMap((g) => g.sources);
  return by.length ? `<span class="by">${CHECK}<span>Backed by ${esc(by.map(tagOf).join(', '))}</span></span>` : '';
}
function listHTML(c: Contest, l: Lineup): string {
  const cands = orderCandidates(c, l);
  return `<ol class="clist">${cands.map((k) => `<li class="cl${(isRCV(c) ? ranksOf(c.id).includes(k.name) : isMultiSeat(c) ? S.b.picks[`${c.id}|${k.name}`] === 'PICK' : S.b.picks[c.id] === k.name) ? ' on' : ''}">
      <span class="cl-n"><b>${esc(k.name)}</b><span class="py">${esc([partyText(c, k), k.incumbent ? 'incumbent' : ''].filter(Boolean).join(', '))}</span>${backedBy(c, k, l)}</span>
      ${pickBtn(c, k, 'pick cl-b')}</li>`).join('')}</ol>`;
}
function voicesHTML(c: Contest, cands: Candidate[]): string {
  const bits = cands.map((k) => {
    const o = k.own_words[0];
    if (o) {
      const quote = o.is_quote;
      return `<figure class="pq${quote ? '' : ' para'}"><blockquote class="clamp">${quote ? (/["“”]/.test(o.text) ? esc(o.text) : `“${esc(o.text)}”`) : escP(o.text)}</blockquote>
        <figcaption><b>${esc(k.short)}</b>${quote ? '' : ', in our words'}${o.source ? `. ${srcLink(o.source)}` : ''}</figcaption></figure>`;
    }
    if (k.own_words_status === 'none_found') {
      const ch = k.own_words_checked;
      return `<p class="nostmt"><b>${esc(k.short)}:</b> No campaign statement found${ch ? `; we checked ${esc(ch.where.join(', ') || 'their sites')} on ${esc(fmtShort(ch.on))}` : ''}.</p>`;
    }
    return '';
  }).filter(Boolean);
  return bits.length ? `<div class="voices"><h4>In their own words</h4>${bits.join('')}</div>` : '';
}
const fmtShort = (iso: string): string => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }); };

function raceHTML(c: Contest): string {
  const l = lineup(c);
  const w = weighedIn(l);
  const rcv = isRCV(c);
  const multi = isMultiSeat(c);
  const useGrid = !rcv && w.length > 0 && c.candidates.length <= 6;
  let body = '';
  let shown: Candidate[] = c.candidates;
  if (useGrid) {
    const cands = orderCandidates(c, l);
    const pages = Math.ceil(cands.length / PAGE);
    const mineIdx = cands.findIndex((k) => (multi ? S.b.picks[`${c.id}|${k.name}`] === 'PICK' : S.b.picks[c.id] === k.name));
    const page = Math.min(S.ui.page[c.id] ?? (mineIdx >= 0 ? Math.floor(mineIdx / PAGE) : 0), pages - 1);
    shown = cands.slice(page * PAGE, page * PAGE + PAGE);
    const cols = shown.map((k) => ({ key: k.name, head: k.short, sub: [partyText(c, k), k.incumbent ? 'incumbent' : ''].filter(Boolean).join(', '), mine: multi ? S.b.picks[`${c.id}|${k.name}`] === 'PICK' : S.b.picks[c.id] === k.name }));
    const foot = shown.map((k) => `<td>${pickBtn(c, k)}</td>`).join('');
    body += gridHTML(c, l, cols, foot);
    if (pages > 1) {
      const next = (page + 1) % pages;
      const others = cands.slice(next * PAGE, next * PAGE + PAGE);
      body += `<button class="pager" data-act="page" data-id="${esc(c.id)}" data-v="${next}" data-fk="pg-${esc(c.id)}">${ARROW_LEFT_OR_RIGHT(next > page)}<span>${next > page ? `See the other ${others.length}: ${esc(listNames(others))}` : `Back to ${esc(listNames(others))}`}</span></button>`;
    }
  } else {
    if (!w.length) body += noneLineHTML(c, l);
    if (rcv) body += rankPanelHTML(c);
    body += listHTML(c, l);
  }
  body += quietLines(l, c);
  if (multi) {
    const n = c.candidates.filter((k) => S.b.picks[`${c.id}|${k.name}`] === 'PICK').length;
    body = `<p class="seats"><b>This race fills ${c.vote_for} seats.</b> Mark up to ${c.vote_for} for your cheat sheet. ${n ? `${n} marked.` : ''}</p>${body}${n && n < c.vote_for && status(c) === 'open' ? `<button class="mini" data-act="mdone" data-id="${esc(c.id)}">I’m done with this race</button>` : ''}`;
  }
  const nonpartisan = !isPartisan(c) ? '<p class="ob-meta">Nonpartisan race: no party labels on the ballot.</p>' : '';
  return `${c.office_explainer ? clampP(`ex-${c.id}`, c.office_explainer, 22, 'ob-lede') : ''}
    ${headsHTML(headsUp(`item:${c.id}`))}
    ${rcv ? rcvHeadHTML(c) : ''}${nonpartisan}
    ${body}
    ${othersHTML(c)}
    ${voicesHTML(c, (useGrid ? shown : c.candidates.slice(0, 4)))}`;
}
const listNames = (ks: Candidate[]): string => ks.length <= 1 ? (ks[0]?.short || '') : `${ks.slice(0, -1).map((k) => k.short).join(', ')} and ${ks[ks.length - 1].short}`;
const ARROW_LEFT_OR_RIGHT = (fwd: boolean): string => (fwd ? ARROW : '<svg viewBox="0 0 18 18" aria-hidden="true" focusable="false"><path d="M12 3L6 9l6 6" fill="none" stroke="currentColor" stroke-width="2"/></svg>');

/* ---------- judges ---------- */
function reviewHTML(r: Review | null, c: Candidate): string {
  if (!r) return '';
  const ev = (c.evaluations || []);
  const off = ev.find((e) => e.kind === 'official_commission' || e.kind === 'bar_committee');
  const survey = off && off.survey ? [
    off.survey.attorneys ? `lawyers ${off.survey.attorneys.yes_pct}% yes${off.survey.attorneys.n ? ` (${off.survey.attorneys.n} answered)` : ''}` : '',
    off.survey.non_attorneys ? `others in the courtroom ${off.survey.non_attorneys.yes_pct}% yes${off.survey.non_attorneys.n ? ` (${off.survey.non_attorneys.n} answered)` : ''}` : '',
  ].filter(Boolean).join('; ') : '';
  const notes = [
    ...r.strengths.slice(0, 1).map((x) => `<p class="nq"><b>${esc(x.by)} noted:</b> “${esc(x.text)}”</p>`),
    ...r.concerns.map((x) => `<p class="nq"><b>${esc(x.by)} noted a concern:</b> “${esc(x.text)}”</p>`),
  ].join('');
  return `<div class="finding ${r.tone}"><p class="rt">${esc(r.main)}</p><p class="vt">${esc(r.sub)}</p>
    <p class="q">${esc(r.line)}</p>${notes}${survey ? `<p class="sv">Survey on the same question: ${esc(survey)}.</p>` : ''}
    ${r.links.length ? `<p class="fl">${r.links.map((x) => ext(x.url, x.label)).join(' · ')}</p>` : ''}</div>`;
}
function meansLineHTML(): string {
  const jr = judicialReview();
  if (!jr || !jr.what_the_rating_means) return '';
  return `<p class="ob-meta"><b>What the rating means:</b> ${escP(leadRest(jr.what_the_rating_means, 24)[0])}</p>`;
}
function noReviewHTML(c: Contest): string {
  const jr = judicialReview();
  const out: string[] = [];
  if (c.why_it_matters) out.push(clampP(`wim-${c.id}`, c.why_it_matters, 26, 'ob-lede'));
  if (jr && jr.who_reviews) out.push(`<p class="ob-meta">${escP(jr.who_reviews)}</p>`);
  return out.join('');
}
function judgeHTML(c: Contest): string {
  const j = c.candidates[0];
  const v = S.b.picks[c.id];
  const r = candidateReview(j);
  return `${c.office_explainer ? clampP(`ex-${c.id}`, c.office_explainer, 22, 'ob-lede') : ''}
    ${headsHTML(headsUp(`item:${c.id}`))}
    ${r ? reviewHTML(r, j) + meansLineHTML() : noReviewHTML(c)}
    ${weighedIn(lineup(c)).length ? sourcesYesNo(c) : ''}
    <div class="duo" role="group" aria-label="Keep ${esc(j.name)}?">
      <button class="pick tall${v === 'YES' ? ' on' : ''}" data-act="pick" data-id="${esc(c.id)}" data-v="YES" aria-pressed="${v === 'YES'}" data-fk="pb-${esc(c.id)}-y"><span>Keep</span><small>Mark yes on the ballot</small></button>
      <button class="pick tall${v === 'NO' ? ' on' : ''}" data-act="pick" data-id="${esc(c.id)}" data-v="NO" aria-pressed="${v === 'NO'}" data-fk="pb-${esc(c.id)}-n"><span>Remove</span><small>Mark no on the ballot</small></button>
    </div>`;
}
function multiJudgeHTML(c: Contest): string {
  const p = S.b.picks;
  const done = c.candidates.filter((k) => p[`${c.id}|${k.name}`]).length;
  return `${c.office_explainer ? clampP(`ex-${c.id}`, c.office_explainer, 22, 'ob-lede') : ''}
    ${headsHTML(headsUp(`item:${c.id}`))}${meansLineHTML()}
    <p class="seats"><b>${done} of ${c.candidates.length} answered.</b> You vote keep or remove on each judge.</p>
    <ul class="judges">${c.candidates.map((k) => {
      const key = `${c.id}|${k.name}`;
      const v = p[key];
      const r = candidateReview(k);
      const bk = `jb-${key}`;
      return `<li><div class="j-top"><span class="j-nm"><b>${esc(k.name)}</b>${r ? `<span class="j-rv ${r.tone}">${esc(r.main)}${r.split ? ', split' : ''}</span>` : ''}</span>
        <span class="yn" role="group" aria-label="Keep ${esc(k.name)}?">
          <button class="mini${v === 'YES' ? ' on' : ''}" data-act="jpick" data-k="${esc(key)}" data-v="YES" aria-pressed="${v === 'YES'}" data-fk="jp-${hash(key)}-y">Keep</button>
          <button class="mini${v === 'NO' ? ' on' : ''}" data-act="jpick" data-k="${esc(key)}" data-v="NO" aria-pressed="${v === 'NO'}" data-fk="jp-${hash(key)}-n">Remove</button></span></div>
        ${r || k.background || k.own_words.length ? `<button class="linkbtn" data-act="open" data-k="${esc(bk)}" aria-expanded="${isOpen(bk)}">${isOpen(bk) ? 'Less' : 'About this judge'}</button>` : ''}
        ${isOpen(bk) ? `<div class="j-more">${reviewHTML(r, k)}${k.background ? `<p class="small">${escP(k.background)}</p>` : ''}${!r && k.own_words[0] ? `<p class="small">${escP(k.own_words[0].text)} ${srcLink(k.own_words[0].source)}</p>` : ''}</div>` : ''}</li>`;
    }).join('')}</ul>`;
}
/* Sources' yes/no on a measure or a judge, as a two-column grid. */
function sourcesYesNo(it: Item): string {
  const l = lineup(it);
  const mine = S.b.picks[it.id];
  const judge = it.kind === 'contest';
  const cols = [
    { key: 'YES', head: judge ? 'Keep' : 'Yes', sub: '', mine: mine === 'YES' },
    { key: 'NO', head: judge ? 'Remove' : 'No', sub: '', mine: mine === 'NO' },
  ];
  return `${gridHTML(it, l, cols, '').replace('class="grid c2"', 'class="grid c2 yn"')}${quietLines(l, it)}`;
}

/* ---------- measures ---------- */
const CONFLICT = /conflict|cancel|nullif|more yes votes/i;
function duelHTML(m: Measure): string {
  const b = S.ballot!;
  const others = m.links.map((id) => b.byId.get(id)).filter((x): x is Measure => !!x && x.kind === 'measure');
  if (!others.length) return '';
  const text = [m.plain_summary, m.confusing_wording_note, m.current_law].filter(Boolean).join(' ');
  const rule = text.split(/(?<=[.!?])\s+/).find((s) => CONFLICT.test(s)) || '';
  const yesBoth = S.b.picks[m.id] === 'YES' && others.some((o) => S.b.picks[o.id] === 'YES');
  const picks = others.map((o) => { const v = S.b.picks[o.id]; return `<button class="linkbtn" data-act="goto" data-id="${esc(o.id)}">${esc(o.number)}</button>${v === 'YES' || v === 'NO' ? ` (you: ${v === 'YES' ? 'yes' : 'no'})` : ''}`; }).join(' and ');
  return `<div class="heads${yesBoth ? ' warn' : ''}"><b>Read with ${picks}.</b> ${rule ? escP(rule) : 'They conflict.'}${yesBoth ? ' <b>You picked yes on more than one of these.</b>' : ''}</div>`;
}
function thresholdLine(m: Measure): string {
  const t = m.pass_threshold || '';
  const pct = t.match(/(\d{2}(?:\.\d+)?%)/);
  const label = pct ? `Needs ${pct[1]} yes to pass.` : /two.thirds/i.test(t) ? 'Needs two-thirds yes to pass.' : /majority/i.test(t) ? 'Needs a simple majority to pass.' : '';
  const who = m.referred_by === 'citizen_initiative' ? 'Put on the ballot by a citizen petition.' : m.referred_by === 'legislature' ? 'Put on the ballot by the legislature.' : '';
  return label || who ? `<p class="ob-meta">${esc([label, who].filter(Boolean).join(' '))}</p>` : '';
}
function measureHTML(m: Measure): string {
  const v = S.b.picks[m.id];
  const l = lineup(m);
  return `${m.plain_summary ? clampP(`sum-${m.id}`, m.plain_summary, 30, 'ob-lede') : ''}
    <div class="means">
      <div class="mean${v === 'YES' ? ' mine' : ''}"><h4>A yes vote means</h4><p>${escP(m.yes_means || 'Not written up yet. See the official text.')}</p></div>
      <div class="mean no${v === 'NO' ? ' mine' : ''}"><h4>A no vote means</h4><p>${escP(m.no_means || 'Not written up yet. See the official text.')}</p></div>
    </div>
    ${headsHTML(headsUp(`item:${m.id}`))}
    ${duelHTML(m)}
    ${m.confusing_wording_note ? `<div class="heads"><b>The wording has a catch.</b> ${clampP(`cw-${m.id}`, m.confusing_wording_note, 26).replace(/^<p>|<\/p>$/g, '')}</div>` : ''}
    ${thresholdLine(m)}
    ${weighedIn(l).length ? sourcesYesNo(m) : `${noneLineHTML(m, l)}${quietLines(l, m)}`}
    ${othersHTML(m)}
    <div class="duo" role="group" aria-label="Your vote on ${esc(m.number)}">
      <button class="pick tall${v === 'YES' ? ' on' : ''}" data-act="pick" data-id="${esc(m.id)}" data-v="YES" aria-pressed="${v === 'YES'}" data-fk="pb-${esc(m.id)}-y"><span>Yes</span></button>
      <button class="pick tall${v === 'NO' ? ' on' : ''}" data-act="pick" data-id="${esc(m.id)}" data-v="NO" aria-pressed="${v === 'NO'}" data-fk="pb-${esc(m.id)}-n"><span>No</span></button>
    </div>`;
}

/* ---------- info rows: the candidates depend on your exact address ---------- */
function infoHTML(c: Contest): string {
  const sb = sampleBallot();
  return `${c.office_explainer ? `<p class="ob-lede">${escP(c.office_explainer)}</p>` : ''}<p class="ob-meta">${escP(c.scope_plain)}</p>
    <p class="ob-meta">The candidates depend on your exact address, so they aren’t in this guide.${sb ? ` ${ext(sb.url, sb.label)}.` : ''}</p>`;
}

/* ---------- the foot of every open row ---------- */
function footHTML(it: Item): string {
  const s = status(it);
  const decided = s === 'decided' || s === 'auto' || s === 'skipped';
  const hasNote = !!(S.b.notes[it.id] || '').trim();
  const noteOpen = S.ui.noteOpen.has(it.id) || hasNote;
  const rcv = it.kind === 'contest' && isRCV(it);
  const acts = [
    s !== 'info' ? `<button class="mini quiet" data-act="skip" data-id="${esc(it.id)}" aria-pressed="${s === 'skipped'}" data-fk="sk-${esc(it.id)}">${s === 'skipped' ? 'Skipped. Undo' : 'Skip this one'}</button>` : '',
    decided && s !== 'skipped' ? `<button class="mini quiet" data-act="clear" data-id="${esc(it.id)}" data-fk="cl-${esc(it.id)}">${rcv ? 'Clear my ranking' : 'Clear my pick'}</button>` : '',
    noteOpen ? '' : `<button class="mini quiet" data-act="note" data-id="${esc(it.id)}">Add a note</button>`,
    `<a class="mini quiet" href="${esc(reportLink(it))}" target="_blank" rel="noopener">Report a problem</a>`,
  ].filter(Boolean).join('');
  const auto = S.b.auto[it.id] && decided ? `<p class="filled">${esc(S.b.auto[it.id])}. <button class="linkbtn" data-act="clear" data-id="${esc(it.id)}">Clear it</button></p>` : '';
  return `${auto}<div class="ob-acts">${acts}</div>
    ${noteOpen ? `<label class="note-ed"><span class="kick">Your note</span><textarea data-note="${esc(it.id)}" data-fk="note-${esc(it.id)}" rows="2" maxlength="500" placeholder="Only you see this. It saves as you type.">${esc(S.b.notes[it.id] || '')}</textarea></label>` : ''}
    ${s === 'info' ? '' : `<button class="deeper" data-act="reader" data-id="${esc(it.id)}" data-fk="rd-${esc(it.id)}"><span><b>Full read</b><small>${it.kind === 'measure' ? 'The ballot wording, both sides, the cost, every source’s reason' : it.kind === 'contest' && it.is_retention ? 'The full review, the judge’s background, the links' : 'The candidates in their own words, every source’s reason, official links'}</small></span>${ARROW}</button>`}`;
}

export function openHTML(it: Item): string {
  let body: string;
  if (it.kind === 'measure') body = measureHTML(it);
  else if (status(it) === 'info') body = infoHTML(it);
  else if (isMultiJudge(it)) body = multiJudgeHTML(it);
  else if (it.is_retention) body = judgeHTML(it);
  else body = raceHTML(it);
  return `<div class="ob" id="ob-${esc(it.id)}">${whereHTML(it)}${body}${footHTML(it)}</div>`;
}
