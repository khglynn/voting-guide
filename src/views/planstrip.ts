/* The plan strip (dusk): the next step and its date, one short line, the main button,
   "Am I registered?", "What if..." and "I already voted". Behind "What if..." sit the
   situations, the gotchas, the key dates and the rules for ID and the booth: everything the
   v2 plan card held, one tap away. Every date is read from the state file. */
import type { HowTo } from '../types';
import { S } from '../state';
import { esc, fmtDate, todayISO, host } from '../util';
import { nextStep, registrationAlert, isMailState } from '../model/plan';
import { ext, isOpen, bulletsHTML, leadBulletsHTML, escP, srcLink, sentences, telHTML } from './common';

export function planHTML(): string {
  const b = S.ballot!;
  const h = b.howto;
  const step = nextStep(h);
  const head = step.head.map(([t, em]) => (em ? `<span class="d">${esc(t)}</span>` : esc(t))).join('');
  const reg = registrationAlert(h);
  const open = isOpen('whatif');
  const check = h.registration.check_url;
  return `<section class="plan" id="plan" aria-labelledby="plan-h"><div class="wrap plan-in">
      <h2 class="vh">Your next step</h2>
      <p class="plan-h" id="plan-h">${head}</p>
      ${step.sub.length ? `<p class="plan-sub">${esc(step.sub.join(' '))}</p>` : ''}
      ${reg ? `<p class="plan-reg">${esc(reg)}</p>` : ''}
      <div class="plan-acts">${step.primary ? `<a class="pbtn gold" href="${esc(step.primary.url)}" target="_blank" rel="noopener">${esc(step.primary.label)}</a>` : ''}
        ${check ? `<a class="pbtn line" href="${esc(check)}" target="_blank" rel="noopener">Am I registered?</a>` : ''}</div>
      <div class="plan-row"><button class="whatif-tog" data-act="open" data-k="whatif" aria-expanded="${open}" data-fk="whatif"><span>What if…, key dates, ID</span><svg class="chev" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 5l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></button>
        <button class="voted" data-act="view" data-v="pass" data-voted="1" data-fk="voted">I already voted</button></div>
    </div></section>
    ${open ? whatIfHTML(h) : ''}`;
}

interface Row { date: string; label: string; detail: string | null; source: string | null; key: string }
function dateRows(h: HowTo): Row[] {
  const out: Row[] = [];
  const labels: Record<string, string> = { online: 'Last day to register online', mail: 'Last day to register by mail', in_person: 'Last day to register in person' };
  h.registration.deadlines.forEach((d, i) => { if (d.date) out.push({ date: d.date, label: labels[d.method] || `Registration deadline (${d.method})`, detail: d.rule, source: d.source, key: `reg${i}` }); });
  const rq = h.mail_ballot.request_deadline;
  if (rq && rq.date) out.push({ date: rq.date, label: 'Last day to ask for a mail ballot', detail: rq.rule, source: rq.source, key: 'req' });
  const ep = h.early_in_person;
  if (ep.available && ep.start) out.push({ date: ep.start, label: 'Early voting starts', detail: ep.hours_note, source: ep.lookup_url, key: 'eps' });
  if (ep.available && ep.end) out.push({ date: ep.end, label: 'Early voting ends', detail: ep.hours_note, source: ep.lookup_url, key: 'epe' });
  const r = h.mail_ballot.return_deadline;
  out.push({ date: r.date, label: `Mail ballots must be ${r.rule === 'received_by' ? 'received' : r.rule === 'postmarked_by' ? 'postmarked' : 'returned'}`, detail: r.time, source: r.source, key: 'ret' });
  out.push({ date: h.election_date, label: `Election Day. Polls close ${h.election_day.polls_close}`, detail: h.election_day.in_line_rule, source: h.election_day.lookup_url, key: 'ed' });
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
const IDS: Record<string, string> = {
  photo: 'Photo ID required in person', non_photo_ok: 'ID required in person; non-photo ID is OK',
  first_time_only: 'ID needed only for some first-time voters', none: 'No ID needed for most voters',
};
const RULE: Record<string, string> = { allowed: 'allowed', restricted: 'restricted', prohibited: 'not allowed', unclear: 'unclear' };

function whatIfHTML(h: HowTo): string {
  const b = S.ballot!;
  const t = todayISO();
  const sits = (h.situations || []).filter((x) => x && x.question && x.answer);
  const disc = (k: string, q: string, body: string) => `<li><button class="wi-q" data-act="open" data-k="${esc(k)}" aria-expanded="${isOpen(k)}"><span>${esc(q)}</span><svg class="chev" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 5l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></button>${isOpen(k) ? `<div class="wi-a">${body}</div>` : ''}</li>`;
  const sitList = sits.map((x) => disc(`wi-${x.id}`, x.question, `<p>${escP(x.answer)}</p>${x.steps && x.steps.length ? `<ol>${x.steps.map((s) => `<li>${escP(s)}</li>`).join('')}</ol>` : ''}${x.source ? `<p class="meta">Source: ${srcLink(x.source)}${x.confidence === 'unverified' ? '. Not yet confirmed' : ''}</p>` : ''}`)).join('');
  const dates = dateRows(h).map((r) => `<li class="${r.date < t ? 'past' : ''}"><span class="pd-d">${esc(fmtDate(r.date))}</span><span class="pd-l">${esc(r.label)}${r.date < t ? ' <span class="passed">passed</span>' : ''}${r.source ? ` ${ext(r.source, host(r.source))}` : ''}</span></li>`).join('');
  const idr = h.id_rules;
  const booth = h.in_the_booth;
  const office = b.places.map((p) => p.county_election_office).find(Boolean);
  const mail = h.mail_ballot;
  const basics = [
    disc('bx-dates', 'Every key date', `<ol class="pdates">${dates}</ol>`),
    disc('bx-id', `What to bring: ${IDS[idr.required] || idr.required}`, `${idr.accepted.length ? `<ul>${idr.accepted.map((a) => `<li>${escP(a)}</li>`).join('')}</ul>` : ''}${idr.no_id_option ? `<p><b>No ID?</b> ${escP(idr.no_id_option)}</p>` : ''}`),
    disc('bx-booth', `In the booth: notes ${RULE[booth.notes_allowed] || booth.notes_allowed}, phones ${RULE[booth.phones] || booth.phones}`, `${booth.notes_detail ? `<p><b>Notes and this cheat sheet.</b> ${escP(booth.notes_detail)}</p>` : ''}${booth.phones_detail ? `<p><b>Phones.</b> ${escP(booth.phones_detail)}</p>` : ''}${booth.apparel_rule ? `<p><b>What to wear.</b> ${escP(booth.apparel_rule)}</p>` : ''}`),
    disc('bx-mail', isMailState(h) ? 'Voting by mail: how it works' : 'Voting by mail instead', `${bulletsHTML(mail.who_gets_one)}${mail.return_options && mail.return_options.length ? `<ul>${mail.return_options.map((o) => `<li>${escP(o)}</li>`).join('')}</ul>` : ''}${mail.mail_cutoff_advice ? `<p>${escP(mail.mail_cutoff_advice)}</p>` : ''}<p>${[mail.tracking_url ? ext(mail.tracking_url, 'Track your ballot') : '', mail.drop_box_lookup_url ? ext(mail.drop_box_lookup_url, 'Find a drop box') : ''].filter(Boolean).join(' · ')}</p>`),
    office ? disc('bx-office', 'Your election office', (() => { const m = office.name.match(/^(.*?)[,:]\s*(\d[\s\S]*)$/); const [n, a] = m ? [m[1], m[2]] : [sentences(office.name)[0], sentences(office.name).slice(1).join(' ')]; return `<p>${office.url ? ext(office.url, n) : esc(n)}${office.phone ? `<br>${telHTML(office.phone)}` : ''}${a ? `<br>${esc(a)}` : ''}</p>`; })()) : '',
    h.model_plain ? disc('bx-how', `How voting works in ${b.stateName}`, bulletsHTML(h.model_plain)) : '',
    ...b.places.filter((p) => p.notes).map((p) => disc(`bx-n-${p.id}`, `Notes for ${p.label}`, bulletsHTML(p.notes))),
  ].join('');
  return `<section class="whatifs" aria-label="What if, key dates and rules"><div class="wrap">
    ${sits.length ? `<h3 class="wi-h">What if…</h3><p class="wi-sub">Answers come from ${ext(h.official_site.url, h.official_site.name)}.</p><ul class="wi-list">${sitList}</ul>` : ''}
    ${h.gotchas.length ? `<h3 class="wi-h">Things people get wrong in ${esc(b.stateName)}</h3>${leadBulletsHTML(h.gotchas, 'bul bul-lead gotchas')}` : ''}
    <h3 class="wi-h">The basics</h3><ul class="wi-list">${basics}</ul>
    <p class="meta">Checked ${esc(h.last_verified || '')}. Official info: ${ext(h.official_site.url, h.official_site.name)}.</p>
  </div></section>`;
}
