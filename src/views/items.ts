/* The ballot: sections, race and measure cards, folded lines, district questions. */
import type { Candidate, Contest, Endorsement, Item, Measure } from '../types';
import { S } from '../state';
import {
  SECTIONS, type SectionKey, type Entry, type Group, entriesBySection, status, isDecision, itemTitle, shortTitle,
  relevantChosen, weighedIn, endorsement, backers, filterCands, isPartisan, isMultiJudge, isMultiSeat, chosen, sectionOf,
  contestDistrict, isRCV, rankMax, ranksOf, ordinal,
} from '../ballot';
import { esc, hash, host, plural } from '../util';
import { confLabel, discBtn, ext, firstSentence, isOpen, sampleBallot, srcLink, clampP, escP, deshout, choiceWord } from './common';

/* "Report a problem" goes to a Google Form in Kevin's personal account (picked Oct 16).
   The two entry ids prefill "Which race or measure?" and "Where are you voting?". */
export const REPORT_URL: string | null = 'https://docs.google.com/forms/d/e/1FAIpQLSdTJFFXbh5ZlZzDmoqvbD5uGEKopuk2zy-nsl4dqmjNA65bOQ/viewform';
const REPORT_ENTRY_ITEM = 'entry.90887649';
const REPORT_ENTRY_WHERE = 'entry.628621310';
function reportLink(it: Item): string {
  const b = S.ballot!;
  const where = [b.places.map((p) => p.label).join(' / ') || b.stateName, S.b.zip].filter(Boolean).join(', ');
  const q = new URLSearchParams({ usp: 'pp_url', [REPORT_ENTRY_ITEM]: `${itemTitle(it)} [${it.id}]`, [REPORT_ENTRY_WHERE]: where });
  return `${REPORT_URL}?${q.toString()}`;
}

/* ---------- labels ---------- */
export function pickLabel(it: Item): string | null {
  const p = S.b.picks;
  if (it.kind === 'measure') return p[it.id] === 'YES' ? 'Yes' : p[it.id] === 'NO' ? 'No' : p[it.id] === 'SKIP' ? 'Skipped' : null;
  if (p[it.id] === 'SKIP') return 'Skipped';
  if (isMultiJudge(it)) {
    const y = it.candidates.filter((c) => p[`${it.id}|${c.name}`] === 'YES').length;
    const n = it.candidates.filter((c) => p[`${it.id}|${c.name}`] === 'NO').length;
    const left = it.candidates.length - y - n;
    if (!y && !n) return null;
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
  if (!v) return null;
  if (it.is_retention) return v === 'YES' ? 'Yes, keep' : v === 'NO' ? 'No, remove' : v;
  const c = it.candidates.find((k) => k.name === v);
  return c ? `${c.name}${c.party ? ` (${c.party})` : ''}` : v;
}

function choiceLabel(it: Item, en: Endorsement): string {
  if (en.s !== 'endorsed') return en.s === 'no_position' ? 'No stand' : 'None found';
  if (en.both) return 'Both sides';
  if (!en.c || !en.c.length) { const n = deshout(en.note || ''); return n ? (n.length > 26 ? `${n.slice(0, 24)}...` : n) : 'Endorsed'; }
  if (it.kind === 'measure' || (it.kind === 'contest' && it.is_retention)) return en.c.map(choiceWord).join(' and ');
  const c = it as Contest;
  return en.c.map((n) => (c.candidates.find((k) => k.name === n) || { short: choiceWord(n) }).short).join(' and ');
}

/* ---------- endorsements on a card ---------- */
function endorseHTML(it: Item): string {
  const all = chosen();
  if (!all.length) return `<div class="esum"><p class="small muted">You haven't turned on any sources. <button class="btn-text btn btn-sm" data-act="go-sources">Pick sources</button></p></div>`;
  const rel = relevantChosen(it);
  if (!rel.length) return `<div class="esum"><p class="small muted">None of your sources cover this kind of ${it.kind === 'measure' ? 'measure' : 'race'}.</p></div>`;
  const yes = weighedIn(it);
  const key = it.id;
  const openId = S.ui.why[key] || null;
  const chips = yes.map((e) => {
    const en = endorsement(it.id, e.id)!;
    return `<button class="chip" data-act="why" data-k="${esc(key)}" data-e="${esc(e.id)}" aria-expanded="${openId === e.id}" data-fk="ch-${esc(key)}-${esc(e.id)}">${esc(e.short)}<span class="st">${esc(choiceLabel(it, en))}</span></button>`;
  }).join('');
  let why = '';
  if (openId) {
    const e = S.ballot!.eById.get(openId);
    const en = e ? endorsement(it.id, e.id) : null;
    if (e && en) {
      const head = en.both ? `${e.name} lists campaigns on both sides.` : `${e.name}: ${choiceLabel(it, en)}${en.note && en.c ? ` (${deshout(en.note)})` : ''}.`;
      why = `<div class="why" role="region" aria-label="Why ${esc(e.short)}"><strong>${esc(head)}</strong>
        ${en.why ? clampP(`why-${key}-${e.id}`, en.why, 40) : '<p class="muted">They didn’t give a reason.</p>'}
        <div class="meta">${en.url ? ext(en.url, 'Read their endorsement') : ''}${en.date ? `<span>${esc(en.date)}</span>` : ''}${confLabel(en.conf) ? `<span>${confLabel(en.conf)}</span>` : ''}</div></div>`;
    }
  }
  const np = rel.filter((e) => endorsement(it.id, e.id)?.s === 'no_position').map((e) => e.short);
  const nf = rel.filter((e) => endorsement(it.id, e.id)?.s === 'not_found').map((e) => e.short);
  const nc = rel.filter((e) => !endorsement(it.id, e.id)).map((e) => e.short);
  const quiet = [np.length ? `No stand: ${np.join(', ')}.` : '', nf.length ? `Looked, none found: ${nf.join(', ')}.` : '', nc.length ? `Not checked yet: ${nc.join(', ')}.` : ''].filter(Boolean).join(' ');
  return `<div class="esum">
    <span class="kicker">Your sources: ${yes.length} of ${rel.length} weighed in${yes.length ? ' <span class="lim">(tap for why)</span>' : ''}</span>
    ${yes.length ? `<div class="chips">${chips}</div>` : ''}${why}
    ${quiet ? `<p class="quiet">${esc(quiet)}</p>` : ''}</div>`;
}

/* ---------- pieces ---------- */
function ownWordsHTML(c: Candidate, label: string): string {
  if (!c.own_words.length) return '';
  return `<div class="stack-xs"><span class="kicker">${esc(label)}</span><ul class="ow">${c.own_words.map((o) =>
    `<li>${o.is_quote ? (/["“”]/.test(o.text) ? esc(o.text) : `“${esc(o.text)}”`) : escP(o.text)}${srcLink(o.source)}</li>`).join('')}</ul></div>`;
}
function webHTML(c: Candidate): string {
  const bits: string[] = [];
  if (c.website) bits.push(`${ext(c.website, 'Campaign site')}${c.website_confidence === 'unverified' ? ' <span class="web-flag">We’re not sure this is their site</span>' : ''}`);
  if (c.lwv_url) bits.push(ext(c.lwv_url, c.lwv_status === 'responded' ? 'Their answers to the League of Women Voters' : 'League of Women Voters guide'));
  return bits.length ? `<div class="web">${bits.join('<span class="dot-sep" aria-hidden="true"> · </span>')}</div>` : '';
}
function footHTML(it: Item, canSkip: boolean): string {
  const s = status(it);
  const hasNote = !!(S.b.notes[it.id] || '').trim();
  const noteOpen = S.ui.noteOpen.has(it.id) || hasNote;
  const decidedOpen = (s === 'decided' || s === 'auto') && S.ui.expanded.has(it.id);
  const rcv = it.kind === 'contest' && isRCV(it);
  return `<div class="r-ft">
    ${canSkip ? `<button class="btn btn-sm" data-act="skip" data-id="${esc(it.id)}" aria-pressed="${s === 'skipped'}">${s === 'skipped' ? 'Skipped. Undo' : 'Skip'}</button>` : ''}
    ${decidedOpen && !rcv ? `<button class="btn btn-sm" data-act="fold" data-id="${esc(it.id)}">Done</button><button class="btn-text btn btn-sm" data-act="clear" data-id="${esc(it.id)}">Clear my pick</button>` : ''}
    ${rcv && ranksOf(it.id).length ? `<button class="btn-text btn btn-sm" data-act="clear" data-id="${esc(it.id)}" data-fk="rc-${esc(it.id)}">Clear my ranking</button>` : ''}
    ${noteOpen ? '' : `<button class="btn-text btn btn-sm" data-act="note" data-id="${esc(it.id)}">Add note</button>`}
    ${it.kind === 'contest' && it.sources.length ? `<button class="btn-text btn btn-sm" data-act="open" data-k="srcs-${esc(it.id)}" aria-expanded="${isOpen(`srcs-${it.id}`)}">Sources (${it.sources.length})</button>` : ''}
    <button class="btn-text btn btn-sm" data-act="open" data-k="rep-${esc(it.id)}" aria-expanded="${isOpen(`rep-${it.id}`)}">Report a problem</button>
  </div>
  ${it.kind === 'contest' && isOpen(`srcs-${it.id}`) ? `<ul class="r-srcs">${it.sources.map((x) => `<li>${ext(x.url, x.name)}</li>`).join('')}</ul>` : ''}
  ${noteOpen ? `<label class="note-ed"><span class="kicker">Your note</span><textarea data-note="${esc(it.id)}" data-fk="note-${esc(it.id)}" rows="2" maxlength="500" placeholder="Only you see this. It saves as you type.">${esc(S.b.notes[it.id] || '')}</textarea></label>` : ''}
  ${isOpen(`rep-${it.id}`) ? reportHTML(it) : ''}`;
}
function reportHTML(it: Item): string {
  if (REPORT_URL) return `<p class="disclose">${ext(reportLink(it), 'Tell us what’s wrong')}. It’s a short form, no sign-in needed. Thanks for checking our work.</p>`;
  return `<p class="disclose">Thanks for checking our work. Reporting isn’t set up yet. For now, tell the person who sent you this guide, and mention “${esc(shortTitle(it))}”.</p>`;
}
function headHTML(it: Item, kicker: string): string {
  const b = S.ballot!;
  const badges: string[] = [];
  if (b.onlyIn[it.id]) badges.push(`<span class="badge badge-dash">Only in ${esc(b.onlyIn[it.id].join(', '))}</span>`);
  else if (b.mayApply.has(it.id) || (b.groupOf[it.id] && S.b.districts[b.groupOf[it.id]] === '*')) badges.push('<span class="badge badge-dash">May apply</span>');
  if (it.confidence === 'unverified') badges.push('<span class="badge badge-dash">Not yet confirmed</span>');
  return `<header class="r-hd"><div class="row"><span class="kicker">${esc(kicker)}</span>${badges.join('')}</div>
    <h3 class="h3" id="h-${esc(it.id)}">${esc(itemTitle(it))}</h3></header>`;
}
function mayApplyHTML(it: Contest): string {
  const b = S.ballot!;
  if (!b.mayApply.has(it.id) && !(b.groupOf[it.id] && S.b.districts[b.groupOf[it.id]] === '*')) return '';
  const canHide = b.mayApply.has(it.id);
  return `<div class="mayapply"><p><strong>Only some voters see this.</strong> ${escP(it.scope_plain)}</p>
    ${canHide ? `<button class="btn btn-sm" data-act="notmine" data-id="${esc(it.id)}">Not on my ballot</button>` : ''}</div>`;
}

/* ---------- contest card ---------- */
function candHTML(it: Contest, c: Candidate): string {
  const p = S.b.picks;
  const multi = isMultiSeat(it);
  const rcv = isRCV(it);
  const list = rcv ? ranksOf(it.id) : [];
  const rank = rcv ? list.indexOf(c.name) + 1 : 0;
  const picked = rcv ? rank > 0 : multi ? p[`${it.id}|${c.name}`] === 'PICK' : p[it.id] === c.name;
  const by = backers(it, c.name).map((e) => e.short);
  const bgK = `bg-${it.id}-${c.name}`;
  const partisan = isPartisan(it);
  const fk = `pk-${esc(it.id)}-${hash(c.name, 4)}`;
  let btn: string;
  if (rcv) {
    // Tap to give the next rank; tap a ranked candidate to take them out (the rest move up).
    const label = rank ? `Your ${ordinal(rank)}: ${esc(c.short)}<span class="vh">. Tap to remove.</span>`
      : list.length < rankMax(it) ? `Rank ${esc(c.short)} ${ordinal(list.length + 1)}` : `Rank ${esc(c.short)}`;
    btn = `<button class="btn btn-sm ${rank ? 'btn-primary' : ''}" data-act="rank" data-id="${esc(it.id)}" data-v="${esc(c.name)}" aria-pressed="${rank > 0}" data-fk="${fk}">${label}</button>`;
  } else {
    btn = `<button class="btn btn-sm ${picked ? 'btn-primary' : ''}" data-act="${multi ? 'mpick' : 'pick'}" data-id="${esc(it.id)}" data-v="${esc(c.name)}" aria-pressed="${picked}" data-fk="${fk}">${picked ? `Your pick: ${esc(c.short)}` : `Pick ${esc(c.short)}`}</button>`;
  }
  return `<div class="cand-c ${picked ? 'is-picked' : ''}">
    <div class="nm">${rank ? `<span class="rank-n" aria-hidden="true">${rank}</span>` : ''}<h4 class="cand-name">${esc(c.name)}</h4>${partisan ? `<span class="party">${esc(c.party || 'No party listed')}</span>` : ''}${c.incumbent ? '<span class="badge">Incumbent</span>' : ''}</div>
    ${by.length ? `<div class="endby"><span class="kicker">Backed by</span>${by.map((x) => `<span class="badge badge-fill">${esc(x)}</span>`).join('')}</div>` : ''}
    ${ownWordsHTML(c, 'In their own words')}
    ${webHTML(c)}
    <div class="row">
      ${btn}
      ${c.background ? `<button class="btn-text btn btn-sm" data-act="open" data-k="${esc(bgK)}" aria-expanded="${isOpen(bgK)}">Background</button>` : ''}
    </div>
    ${c.background && isOpen(bgK) ? `<p class="small">${escP(c.background)}</p>` : ''}
  </div>`;
}

/* ---------- ranked choice ---------- */
const WINNERS = ['', 'One person wins.', 'Two people win.', 'Three people win.', 'Four people win.', 'Five people win.', 'Six people win.'];
const HOW_ONE = 'If no one has a majority of first choices, last place is dropped and those ballots count for their next choice, until someone has a majority.';
const HOW_MANY = 'Your vote counts for your top choice; if they’re knocked out, or already have enough votes to win, your vote (or the extra part of it) moves to your next choice.';
export function rcvURL(it: Contest): string | null {
  return it.rcv_url || it.sources.find((x) => /ranked.choice|\brcv\b/i.test(`${x.name} ${x.url}`))?.url || null;
}
/* The calm header: how many to rank, how many win, how the count works, where it says so. */
function rcvHeadHTML(it: Contest): string {
  const url = rcvURL(it);
  const win = WINNERS[it.winners] || `${it.winners} people win.`;
  return `<div class="rcv">
    <p><strong>Ranked choice: rank up to ${it.rank_up_to}.</strong> ${win}</p>
    <p class="small">${esc(it.rcv_how || (it.winners > 1 ? HOW_MANY : HOW_ONE))}${url ? ` ${ext(url, 'How the count works')} <span class="lim">${esc(host(url))}</span>` : ''}</p>
  </div>`;
}
const UP = '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false"><path d="M10 4l-6 6.5M10 4l6 6.5M10 4v12.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></svg>';
const X = '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false"><path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></svg>';
/* The voter's ranking, in ballot order, with move-up and remove on each row. */
function rankPanelHTML(it: Contest): string {
  const list = ranksOf(it.id);
  const max = rankMax(it);
  const id = esc(it.id);
  const extra = (it.rank_up_to || 0) > it.candidates.length ? ' The ballot also has a write-in line you can rank.' : '';
  if (!list.length) return `<p class="rank-empty small">Tap <strong>Rank</strong> on candidates in the order you like them. You can rank just one. Ranking more never hurts your first choice.${extra}</p>`;
  const rows = list.map((name, i) => {
    const h = hash(name, 4);
    return `<li class="rank-row"><span class="rank-n" aria-hidden="true">${i + 1}</span>
      <span class="rank-nm"><span class="vh">${ordinal(i + 1)}: </span>${esc(name)}</span>
      ${i > 0 ? `<button class="ibtn" data-act="rup" data-id="${id}" data-v="${esc(name)}" aria-label="Move ${esc(name)} up to ${ordinal(i)}" title="Move up" data-fk="ru-${id}-${h}">${UP}</button>` : '<span class="ibtn-ph" aria-hidden="true"></span>'}
      <button class="ibtn" data-act="rx" data-id="${id}" data-v="${esc(name)}" aria-label="Remove ${esc(name)} from your ranking" title="Remove" data-fk="rx-${id}-${h}">${X}</button></li>`;
  }).join('');
  const s = status(it);
  const left = list.length < max ? `${list.length} of ${max} ranked. Tap Rank on another candidate to add them ${ordinal(list.length + 1)}.` : `All ${max} ranked.`;
  const done = s === 'open' || S.ui.expanded.has(it.id);
  return `<div class="rank-panel" role="group" aria-labelledby="rk-${id}">
    <span class="kicker" id="rk-${id}">Your ranking</span>
    <ol class="rank-list">${rows}</ol>
    <p class="small muted">${left}${list.length < max ? extra : ''}</p>
    ${done ? `<button class="btn btn-sm btn-primary" data-act="rdone" data-id="${id}" data-fk="rd-${id}">Done ranking</button>` : ''}
  </div>`;
}
function retentionHTML(it: Contest): string {
  const j = it.candidates[0];
  const v = S.b.picks[it.id];
  return `<div class="cand-c">
      <div class="nm"><h4 class="cand-name">${esc(j.name)}</h4>${j.incumbent ? '<span class="badge">Now serving</span>' : ''}</div>
      ${j.background ? clampP(`bgj-${it.id}`, j.background, 30, 'small') : ''}
      ${ownWordsHTML(j, 'About this judge')}${webHTML(j)}
    </div>
    <div class="pickbar" role="group" aria-label="Keep ${esc(j.name)}?">
      <button data-act="pick" data-id="${esc(it.id)}" data-v="YES" aria-pressed="${v === 'YES'}" data-fk="pb-${esc(it.id)}-y">Yes, keep</button>
      <button data-act="pick" data-id="${esc(it.id)}" data-v="NO" aria-pressed="${v === 'NO'}" data-fk="pb-${esc(it.id)}-n">No, remove</button>
      <button data-act="skip" data-id="${esc(it.id)}" aria-pressed="${v === 'SKIP'}" data-fk="pb-${esc(it.id)}-s">Skip</button></div>`;
}
function multiJudgeHTML(it: Contest): string {
  const p = S.b.picks;
  const done = it.candidates.filter((c) => p[`${it.id}|${c.name}`]).length;
  return `<p class="small"><strong>${done} of ${it.candidates.length} answered.</strong> You vote yes or no on each judge.</p>
    <ul class="judges">${it.candidates.map((c) => {
      const k = `${it.id}|${c.name}`;
      const v = p[k];
      const bgK = `bg-${k}`;
      return `<li><div class="j-nm"><span>${esc(c.name)}</span>${c.background || c.own_words.length ? `<button class="btn-text btn btn-sm" data-act="open" data-k="${esc(bgK)}" aria-expanded="${isOpen(bgK)}">About</button>` : ''}</div>
        <div class="yn-inline" role="group" aria-label="Keep ${esc(c.name)}?">
          <button data-act="jpick" data-k="${esc(k)}" data-v="YES" aria-pressed="${v === 'YES'}" data-fk="jp-${hash(k)}-y">Yes</button>
          <button data-act="jpick" data-k="${esc(k)}" data-v="NO" aria-pressed="${v === 'NO'}" data-fk="jp-${hash(k)}-n">No</button></div>
        ${isOpen(bgK) ? `<div class="j-bg">${c.background ? `<p class="small">${escP(c.background)}</p>` : ''}${ownWordsHTML(c, 'About this judge')}</div>` : ''}</li>`;
    }).join('')}</ul>`;
}
function contestCard(it: Contest): string {
  const s = status(it);
  const [first, rest] = firstSentence(it.scope_plain || '');
  const kicker = it.every && first.length <= 60 ? first : S.ballot!.statewide.has(it.id) ? `${S.ballot!.stateName} race` : 'Local race';
  let body = '';
  if (isMultiJudge(it)) body = multiJudgeHTML(it);
  else if (it.is_retention) body = retentionHTML(it);
  else {
    const f = filterCands(it);
    const cands = f.shown.length ? f.shown.map((c) => candHTML(it, c)).join('') : '<p class="empty-src">No candidates match your filters here.</p>';
    const hidden = f.hidden ? `<p class="hidden-note">${plural(f.hidden, 'candidate')} hidden by your filters. <button class="btn-text btn btn-sm" data-act="showall" data-id="${esc(it.id)}">Show all</button></p>` : '';
    const shownAll = S.ui.showAll.has(it.id) ? `<p class="hidden-note">Showing everyone. <button class="btn-text btn btn-sm" data-act="showall" data-id="${esc(it.id)}">Apply my filters</button></p>` : '';
    body = `${isMultiSeat(it) ? `<p class="small"><strong>This race fills ${it.vote_for} seats.</strong> You can mark up to ${it.vote_for} here for your cheat sheet.</p>` : ''}
      ${isRCV(it) ? rankPanelHTML(it) : ''}
      <div class="C-cands">${cands}</div>${hidden}${shownAll}
      ${isMultiSeat(it) && s === 'open' && it.candidates.some((c) => S.b.picks[`${it.id}|${c.name}`] === 'PICK') ? `<button class="btn btn-sm" data-act="mdone" data-id="${esc(it.id)}">I’m done with this race</button>` : ''}`;
  }
  return `<article class="card-r" id="i-${esc(it.id)}" data-item="${esc(it.id)}" ${s === 'open' ? 'data-undecided' : ''} aria-labelledby="h-${esc(it.id)}">
    ${headHTML(it, kicker)}
    ${mayApplyHTML(it)}
    ${it.office_explainer ? `<p class="explainer">${escP(it.office_explainer)}</p>` : ''}
    ${it.every && rest ? clampP(`scope-${it.id}`, rest, 24, 'small muted') : ''}
    ${isRCV(it) ? rcvHeadHTML(it) : ''}
    ${it.why_it_matters ? clampP(`wim-${it.id}`, it.why_it_matters, 28, 'r-why') : ''}
    ${!isPartisan(it) && !it.is_retention ? '<p class="lim">Nonpartisan race: no party labels on the ballot.</p>' : ''}
    ${endorseHTML(it)}
    ${body}
    ${footHTML(it, !it.is_retention || isMultiJudge(it))}
  </article>`;
}

/* ---------- measure card ---------- */
function thresholdBadge(m: Measure): string {
  const t = m.pass_threshold || '';
  const pct = t.match(/(\d{2}(?:\.\d+)?%)/);
  const label = pct ? `Needs ${pct[1]}` : /majority/i.test(t) ? 'Needs a majority' : '';
  return label ? `<span class="badge" title="${esc(t)}">${esc(label)}</span>` : '';
}
function linkedHTML(m: Measure): string {
  if (!m.links.length) return '';
  const others = m.links.map((id) => S.ballot!.byId.get(id)).filter((x): x is Measure => !!x && x.kind === 'measure');
  if (!others.length) return '';
  const yesAll = S.b.picks[m.id] === 'YES' && others.some((o) => S.b.picks[o.id] === 'YES');
  return `<div class="linked"><span class="kicker">Linked: read these together</span>
    <p class="small">${esc(m.number)} is tied to ${others.map((o) => esc(o.number)).join(' and ')}. The note above explains how they collide.</p>
    <ul class="small">${others.map((o) => { const l = pickLabel(o); return `<li>${esc(o.number)}: <strong>${l ? esc(l) : 'not decided yet'}</strong> <button class="btn-text btn btn-sm" data-act="jump" data-id="${esc(o.id)}">See ${esc(o.number)}</button></li>`; }).join('')}</ul>
    ${yesAll ? `<p class="disclose" role="status"><strong>You picked Yes on more than one of these.</strong> They conflict. Read the note above before you vote.</p>` : ''}</div>`;
}
function measureCard(m: Measure): string {
  const s = status(m);
  const v = S.b.picks[m.id];
  const k = `lang-${m.id}`;
  return `<article class="card-r" id="i-${esc(m.id)}" data-item="${esc(m.id)}" ${s === 'open' ? 'data-undecided' : ''} aria-labelledby="h-${esc(m.id)}">
    ${headHTML(m, m.jurisdiction)}
    <div class="row">${thresholdBadge(m)}${m.referred_by === 'citizen_initiative' ? '<span class="badge">Citizen initiative</span>' : m.referred_by === 'legislature' ? '<span class="badge">From the legislature</span>' : ''}</div>
    ${m.plain_summary ? clampP(`sum-${m.id}`, m.plain_summary, 32, 'summary') : ''}
    <div class="yn">
      <div class="yn-box ${v === 'YES' ? 'is-picked' : ''}"><span class="yn-label">A <strong>yes</strong> vote means</span><p>${escP(m.yes_means || 'Not written up yet. See the official text.')}</p></div>
      <div class="yn-box ${v === 'NO' ? 'is-picked' : ''}"><span class="yn-label">A <strong>no</strong> vote means</span><p>${escP(m.no_means || 'Not written up yet. See the official text.')}</p></div>
    </div>
    ${m.confusing_wording_note ? `<div class="heads-up"><span class="kicker">Heads up: confusing wording</span>${clampP(`cw-${m.id}`, m.confusing_wording_note, 28)}</div>` : ''}
    ${linkedHTML(m)}
    ${endorseHTML(m)}
    <div class="pickbar" role="group" aria-label="Your vote on ${esc(m.number)}">
      <button data-act="pick" data-id="${esc(m.id)}" data-v="YES" aria-pressed="${v === 'YES'}" data-fk="pb-${esc(m.id)}-y">Yes</button>
      <button data-act="pick" data-id="${esc(m.id)}" data-v="NO" aria-pressed="${v === 'NO'}" data-fk="pb-${esc(m.id)}-n">No</button>
      <button data-act="skip" data-id="${esc(m.id)}" aria-pressed="${v === 'SKIP'}" data-fk="pb-${esc(m.id)}-s">Skip</button></div>
    ${m.explainers && m.explainers.length ? `<p class="small explainers">Read a news explainer: ${m.explainers.map((e) => ext(e.url, e.source)).join(' · ')}</p>` : ''}
    <div>${discBtn(k, 'Exact ballot wording, both sides, cost')}
    ${isOpen(k) ? `<div class="disc-bd">
      ${m.official_title ? `<div class="ballot-lang" tabindex="0">${esc(m.official_title)}</div>` : ''}
      ${m.supporters_case || m.opponents_case ? `<div class="C-sides">
        ${m.supporters_case ? `<div class="C-side"><span class="kicker">Supporters say</span><p>${escP(m.supporters_case.text)} ${srcLink(m.supporters_case.source)}</p></div>` : ''}
        ${m.opponents_case ? `<div class="C-side"><span class="kicker">Opponents say</span><p>${escP(m.opponents_case.text)} ${srcLink(m.opponents_case.source)}</p></div>` : ''}</div>` : ''}
      ${m.current_law ? `<p class="small"><strong>Current law:</strong> ${escP(m.current_law)}</p>` : ''}
      ${m.fiscal_impact ? `<p class="small"><strong>Cost and money:</strong> ${escP(m.fiscal_impact)}</p>` : ''}
      ${m.pass_threshold ? `<p class="small"><strong>To pass:</strong> ${escP(m.pass_threshold)}</p>` : ''}
      <p class="small">${[m.official_text_url ? ext(m.official_text_url, 'Official text') : '', m.official_guide_url ? ext(m.official_guide_url, 'Official voter guide') : ''].filter(Boolean).join(' · ')}</p>
    </div>` : ''}</div>
    ${footHTML(m, false)}
  </article>`;
}

/* ---------- folded and info ---------- */
function foldedHTML(it: Item): string {
  const s = status(it);
  const label = pickLabel(it) || '';
  let agree = '';
  if (s !== 'skipped' && it.kind === 'contest' && isRCV(it)) {
    const first = ranksOf(it.id)[0];
    const by = first ? backers(it, first).map((e) => e.short) : [];
    if (by.length) agree = `<span class="fold-agree">${esc(by.join(', '))} ${by.length === 1 ? 'backs' : 'back'} your 1st choice</span>`;
  } else if (s !== 'skipped') {
    const v = S.b.picks[it.id];
    const by = v && v !== 'SKIP' ? backers(it, v).map((e) => e.short) : [];
    if (by.length) agree = `<span class="fold-agree">${esc(by.join(', '))} ${by.length === 1 ? 'agrees' : 'agree'}</span>`;
  }
  const note = (S.b.notes[it.id] || '').trim();
  return `<div class="fold ${s === 'skipped' ? 'is-skipped' : ''}" id="i-${esc(it.id)}" data-item="${esc(it.id)}">
    <div class="fold-main"><span class="fold-t">${esc(shortTitle(it))}</span><span class="fold-v">${esc(label)}</span>${agree}</div>
    <button class="btn btn-sm" data-act="change" data-id="${esc(it.id)}" data-fk="chg-${esc(it.id)}">Change</button>
    ${s === 'auto' ? `<p class="fold-auto"><strong>Picked for you.</strong> ${esc(S.b.auto[it.id])} <button class="btn-text btn btn-sm" data-act="undo-auto" data-id="${esc(it.id)}">Undo</button></p>` : ''}
    ${note ? `<p class="fold-note"><span class="kicker">Note</span> ${esc(note)}</p>` : ''}
  </div>`;
}
function infoHTML(it: Contest): string {
  const sb = sampleBallot();
  return `<article class="card-r is-info" id="i-${esc(it.id)}" aria-labelledby="h-${esc(it.id)}">
    ${headHTML(it, 'Depends on your address')}
    ${it.office_explainer ? `<p class="explainer">${esc(it.office_explainer)}</p>` : ''}
    <p class="small">${escP(it.scope_plain)}</p>
    <p class="small muted">The candidates depend on your exact address, so they aren’t in this guide.${sb ? ` ${ext(sb.url, sb.label)}.` : ''}</p>
  </article>`;
}
export function itemHTML(it: Item): string {
  const s = status(it);
  if (it.kind === 'contest' && s === 'info') return infoHTML(it);
  if ((s === 'decided' || s === 'auto' || s === 'skipped') && S.prefs.foldDecided && !S.ui.expanded.has(it.id)) return foldedHTML(it);
  if ((s === 'decided' || s === 'auto' || s === 'skipped') && !S.prefs.foldDecided && !S.ui.expanded.has(it.id)) {
    // Not folding: show the full card, plus the auto-pick note so it's never silent.
    const card = it.kind === 'measure' ? measureCard(it) : contestCard(it);
    if (s === 'auto') return card.replace('</header>', `</header><p class="fold-auto"><strong>Picked for you.</strong> ${esc(S.b.auto[it.id])} <button class="btn-text btn btn-sm" data-act="undo-auto" data-id="${esc(it.id)}">Undo</button></p>`);
    return card;
  }
  return it.kind === 'measure' ? measureCard(it) : contestCard(it);
}

/* ---------- district questions ---------- */
const optLabel = (c: Contest): [string, string] => {
  const d = (c.district || c.office).replace(/^(?:CD|SD|HD|AD)-\s*(\d+)/i, 'District $1');
  const m = d.match(/^(.*?)\s*\((.*)\)\s*$/);
  if (m) return [m[1], m[2]];
  const sm = (c.scope_plain || '').match(/\(([^)]*)\)\s*\.?$/);
  return [d, sm ? sm[1] : ''];
};
export const groupId = (g: Group): string => `q-${hash(g.key)}`;
function questionHTML(g: Group): string {
  const b = S.ballot!;
  const members = g.members.map((id) => b.byId.get(id) as Contest);
  return `<div class="q" id="${groupId(g)}" data-undecided data-q="${esc(g.key)}">
    <span class="kicker">${esc(g.office)}</span>
    <h3 class="h3">Which district is yours?</h3>
    <p class="small muted">Your ZIP touches ${members.length} of them. Your sample ballot or voter registration card says which.</p>
    <div class="choices">${members.map((c) => { const [l, sub] = optLabel(c); return `<button class="choice" data-act="district" data-g="${esc(g.key)}" data-v="${esc(c.id)}" data-fk="d-${esc(c.id)}"><strong>${esc(l)}</strong>${sub ? `<span>${esc(sub)}</span>` : ''}</button>`; }).join('')}
      <button class="choice choice-unsure" data-act="district" data-g="${esc(g.key)}" data-v="*"><strong>I’m not sure</strong><span>Show all ${members.length}, each marked “May apply”</span></button>
    </div>
    ${g.kind ? '<button class="btn-text btn btn-sm" data-act="addr-open">Answer this from my address</button>' : ''}
  </div>`;
}
function groupLineHTML(g: Group): string {
  const b = S.ballot!;
  const ans = S.b.districts[g.key];
  let v = '';
  if (ans === '*') v = `Showing all ${g.members.length}`;
  else if (ans === 'none') v = 'None on your ballot, from your address';
  else { const c = b.byId.get(ans) as Contest | undefined; v = c ? optLabel(c)[0] : ''; }
  return `<div class="fold q-line" id="${groupId(g)}"><div class="fold-main"><span class="fold-t">${esc(g.office)}</span><span class="fold-v">${esc(v)}</span></div>
    <button class="btn btn-sm" data-act="district-change" data-g="${esc(g.key)}">Change</button></div>`;
}
function notMineHTML(it: Item): string {
  return `<div class="fold is-skipped" id="i-${esc(it.id)}"><div class="fold-main"><span class="fold-t">${esc(shortTitle(it))}</span><span class="fold-v">Not on my ballot</span></div>
    <button class="btn btn-sm" data-act="notmine-undo" data-id="${esc(it.id)}">Undo</button></div>`;
}

/* ---------- sections ---------- */
function unopposedHTML(sec: SectionKey, list: Contest[]): string {
  if (!list.length) return '';
  const k = `unopp-${sec}`;
  return `<div class="unopp">${discBtn(k, `${plural(list.length, 'unopposed race')}. Nothing to decide.`)}
    ${isOpen(k) ? `<ul class="unopp-list">${list.map((c) => {
      const k1 = c.candidates[0];
      return `<li id="i-${esc(c.id)}"><span class="fold-t">${esc(shortTitle(c))}</span> <strong>${esc(k1.name)}</strong>${k1.party ? ` <span class="party">${esc(k1.party)}</span>` : ''}${S.ballot!.mayApply.has(c.id) ? ' <span class="badge badge-dash">May apply</span>' : ''}</li>`;
    }).join('')}</ul>` : ''}</div>`;
}
function entryHTML(e: Entry): string {
  const b = S.ballot!;
  if (e.t === 'question') return questionHTML(e.group);
  if (e.t === 'groupline') return groupLineHTML(e.group);
  if (e.t === 'notmine') return notMineHTML(b.byId.get(e.id)!);
  return itemHTML(b.byId.get(e.id)!);
}
/* "2 of 3 decided" for a section header. */
export function sectionCount(entries: Entry[]): string {
  const b = S.ballot!;
  let decided = 0, total = 0, unopp = 0;
  for (const e of entries) {
    if (e.t === 'question') { total++; continue; }
    if (e.t !== 'item') continue;
    const s = status(b.byId.get(e.id)!);
    if (s === 'unopposed') { unopp++; continue; }
    if (isDecision(s)) { total++; if (s !== 'open') decided++; }
  }
  return total ? `${decided} of ${total} decided` : unopp ? 'Nothing to decide' : '';
}
export function sectionHTML(sec: SectionKey, label: string, entries: Entry[]): string {
  const b = S.ballot!;
  const unopp: Contest[] = [];
  const rows: string[] = [];
  let lastJur = '';
  for (const e of entries) {
    if (e.t === 'item') {
      const it = b.byId.get(e.id)!;
      if (status(it) === 'unopposed') { unopp.push(it as Contest); continue; }
      if (sec === 'measures' && it.kind === 'measure' && it.jurisdiction !== lastJur) {
        lastJur = it.jurisdiction;
        rows.push(`<h3 class="sub-hd kicker">${esc(it.jurisdiction)}</h3>`);
      }
    }
    rows.push(entryHTML(e));
  }
  if (!rows.length && !unopp.length) return '';
  const collapsed = S.ui.collapsed.has(sec);
  return `<section class="sec" id="sec-${sec}" data-sec="${sec}" aria-labelledby="sh-${sec}">
    <h2 class="sec-h" id="sh-${sec}"><button class="sec-hd" data-act="sec" data-sec="${sec}" aria-expanded="${!collapsed}" data-fk="sec-${sec}">
      <span class="h2">${esc(label)}</span><span class="lim sec-count">${sectionCount(entries)}</span><span class="chev" aria-hidden="true"></span></button></h2>
    ${collapsed ? '' : `<div class="sec-bd">${rows.join('')}${unopposedHTML(sec, unopp)}</div>`}
  </section>`;
}
export function ballotHTML(): string {
  const by = entriesBySection();
  const fresh = Object.keys(S.b.picks).length === 0;
  const tip = fresh ? '<p class="tip">Your ballot, in order. Read a race, then tap Pick or Skip, and it folds to one line. Your picks save on this device. Your cheat sheet is at the bottom.</p>' : '';
  return tip + SECTIONS.map(([k, label]) => sectionHTML(k, label, by.get(k) || [])).join('');
}
export const sectionOfId = (id: string): SectionKey | null => {
  const it = S.ballot?.byId.get(id);
  return it ? sectionOf(it) : null;
};
export { contestDistrict };
