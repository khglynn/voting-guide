/* "Your plan": countdown, the one next action, key dates, what to bring.
   Every date and deadline here is read from data/states/{ST}.json. Labels describe which
   field a date came from; the rule text itself is shown word for word. */
import type { HowTo } from '../types';
import { S } from '../state';
import { esc, fmtDate, todayISO, daysBetween, host } from '../util';
import { ext, isOpen, discBtn, sampleBallot } from './common';

interface Row { date: string; label: string; detail: string | null; source: string | null; key: string }

const isMailState = (h: HowTo) => h.voting_model === 'all_mail' || h.voting_model === 'mail_to_all_plus_in_person';
const shortText = (s: string | null | undefined, n = 28) => !!s && s.length <= n;

function returnLine(h: HowTo): string {
  const r = h.mail_ballot.return_deadline;
  const verb = r.rule === 'received_by' ? 'received' : r.rule === 'postmarked_by' ? 'postmarked' : 'returned';
  const short = shortText(r.time);
  return `Mail ballots must be ${verb} by ${fmtDate(r.date)}${short ? `, ${r.time}` : ''}.${!short && r.time ? ` ${r.time}` : ''}`;
}

function rows(h: HowTo): Row[] {
  const out: Row[] = [];
  const labels: Record<string, string> = { online: 'Last day to register online', mail: 'Last day to register by mail', in_person: 'Last day to register in person' };
  h.registration.deadlines.forEach((d, i) => {
    if (d.date) out.push({ date: d.date, label: labels[d.method] || `Registration deadline (${d.method})`, detail: d.rule, source: d.source, key: `reg${i}` });
  });
  const rq = h.mail_ballot.request_deadline;
  if (rq && rq.date) out.push({ date: rq.date, label: 'Mail ballot request deadline', detail: rq.rule, source: rq.source, key: 'req' });
  const ep = h.early_in_person;
  if (ep.available && ep.start) out.push({ date: ep.start, label: 'Early voting starts', detail: ep.hours_note, source: ep.lookup_url, key: 'eps' });
  if (ep.available && ep.end) out.push({ date: ep.end, label: 'Early voting ends', detail: ep.hours_note, source: ep.lookup_url, key: 'epe' });
  const r = h.mail_ballot.return_deadline;
  const verb = r.rule === 'received_by' ? 'received' : r.rule === 'postmarked_by' ? 'postmarked' : 'returned';
  out.push({ date: r.date, label: `Mail ballot must be ${verb}${shortText(r.time) ? ` by ${r.time}` : ''}`, detail: shortText(r.time) ? null : r.time, source: r.source, key: 'ret' });
  const ed = h.election_day;
  out.push({
    date: h.election_date,
    label: shortText(ed.polls_open, 12) ? `Election Day. Polls open ${ed.polls_open} to ${ed.polls_close}` : `Election Day. Polls close ${ed.polls_close}`,
    detail: [shortText(ed.polls_open, 12) ? null : ed.polls_open, ed.in_line_rule].filter(Boolean).join(' ') || null,
    source: ed.lookup_url, key: 'ed',
  });
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function nextStep(h: HowTo): { title: string; lines: string[]; ctas: [string, string][] } {
  const t = todayISO();
  const ed = h.election_day;
  const mb = h.mail_ballot;
  const ep = h.early_in_person;
  const ctas: [string, string][] = [];
  if (t > h.election_date) return { title: 'Voting has closed', lines: [], ctas: mb.tracking_url ? [['Track your ballot', mb.tracking_url]] : [] };
  if (t === h.election_date) {
    const lines = [`Polls close at ${ed.polls_close}.`];
    if (ed.in_line_rule) lines.push(ed.in_line_rule);
    if (ed.lookup_url) ctas.push(['Find where to vote', ed.lookup_url]);
    if (isMailState(h) && mb.drop_box_lookup_url) ctas.push(['Find a drop box', mb.drop_box_lookup_url]);
    return { title: 'Today is Election Day', lines, ctas };
  }
  if (isMailState(h)) {
    const lines = [returnLine(h)];
    if (mb.mail_cutoff_advice) lines.push(mb.mail_cutoff_advice);
    if (mb.drop_box_lookup_url) ctas.push(['Find a drop box', mb.drop_box_lookup_url]);
    if (mb.tracking_url) ctas.push(['Track your ballot', mb.tracking_url]);
    return { title: 'Fill out your ballot and return it', lines, ctas };
  }
  const lines: string[] = [];
  let title: string;
  if (ep.available && ep.start && ep.end && t < ep.start) {
    title = `Early voting starts ${fmtDate(ep.start)}`;
    lines.push(`It runs ${fmtDate(ep.start)} to ${fmtDate(ep.end)}.`);
  } else if (ep.available && ep.end && t <= ep.end) {
    title = `Vote early, through ${fmtDate(ep.end)}`;
    if (ep.start) lines.push(`Early voting runs ${fmtDate(ep.start)} to ${fmtDate(ep.end)}.`);
  } else {
    title = `Vote on Election Day, ${fmtDate(h.election_date)}`;
  }
  lines.push(shortText(ed.polls_open, 12) ? `On Election Day, polls are open ${ed.polls_open} to ${ed.polls_close}.` : `On Election Day, polls close at ${ed.polls_close}.`);
  lines.push(`Voting by mail instead? ${returnLine(h)}`);
  const look = ep.lookup_url || ed.lookup_url;
  if (look) ctas.push(['Find where to vote', look]);
  return { title, lines, ctas };
}

function regAlert(h: HowTo): string {
  const t = todayISO();
  const open = h.registration.deadlines.filter((d) => d.date && d.date >= t).sort((a, b) => (a.date! < b.date! ? -1 : 1));
  const online = open.find((d) => d.method === 'online') || open[0];
  if (!online || !online.date || daysBetween(t, online.date) > 14) return '';
  const how = online.method === 'online' ? 'online' : online.method === 'mail' ? 'by mail' : 'in person';
  return `<p class="reg-alert"><strong>Not registered yet?</strong> The last day to register ${how} is ${fmtDate(online.date)}. ${h.registration.check_url ? ext(h.registration.check_url, 'Check your registration') : ''}</p>`;
}

const PHONES: Record<string, string> = { allowed: 'Allowed', restricted: 'Restricted', prohibited: 'Not allowed', unclear: 'Unclear' };
const NOTES: Record<string, string> = { allowed: 'Allowed', prohibited: 'Not allowed', unclear: 'Unclear' };
const IDS: Record<string, string> = {
  photo: 'Photo ID required in person', non_photo_ok: 'ID required in person; non-photo ID is OK',
  first_time_only: 'ID needed only for some first-time voters', none: 'No ID needed for most voters',
};

export function planFolded(): boolean { return S.b.planSeen && !S.ui.open.has('plan'); }

export function planHTML(): string {
  const b = S.ballot!;
  const h = b.howto;
  const t = todayISO();
  const d = daysBetween(t, h.election_date);
  const step = nextStep(h);
  const countWord = d < 0 ? 'Closed' : d === 0 ? 'Today' : String(d);
  if (planFolded()) {
    return `<section class="plan plan-folded" id="plan" aria-label="Your plan">
      <div class="fold-main"><span class="fold-t">Your plan</span><span class="fold-v">${d > 0 ? `${d} ${d === 1 ? 'day' : 'days'} left. ` : ''}${esc(step.title)}</span></div>
      <button class="btn btn-sm" data-act="plan-open" data-fk="plan-open">Open</button></section>`;
  }
  const all = rows(h);
  const past = all.filter((r) => r.date < t);
  const future = all.filter((r) => r.date >= t);
  const rowHTML = (r: Row, isPast: boolean) => {
    const k = `pd-${r.key}`;
    const hasMore = !!(r.detail || r.source);
    const label = `${esc(r.label)}${isPast ? ' <span class="badge">Passed</span>' : ''}`;
    return `<li class="${isPast ? 'past' : ''}"><span class="pd-date">${esc(fmtDate(r.date))}</span>
      <div class="pd-body">${hasMore ? `<button class="pd-btn" data-act="open" data-k="${k}" aria-expanded="${isOpen(k)}">${label}</button>` : `<span>${label}</span>`}
      ${hasMore && isOpen(k) ? `<p class="small">${r.detail ? esc(r.detail) : ''} ${r.source ? ext(r.source, `Source: ${host(r.source)}`) : ''}</p>` : ''}</div></li>`;
  };
  const booth = h.in_the_booth;
  const sb = sampleBallot();
  const office = b.places.map((p) => p.county_election_office).find(Boolean);
  const ballotLine = b.hasLocal
    ? `This guide has your statewide and local races.${sb ? ` Double-check with ${ext(sb.url, 'your official sample ballot')}.` : ''}`
    : `We only have statewide races for your area so far.${sb ? ` ${ext(sb.url, sb.label)}.` : ''}`;
  return `<section class="plan" id="plan" aria-labelledby="plan-h">
    <div class="plan-top">
      <div class="count" aria-hidden="true">${countWord}</div>
      <div class="count-label"><span class="kicker" id="plan-h">Your plan, ${esc(b.stateName)}</span>
        <strong>${d > 0 ? `${d === 1 ? 'day' : 'days'} until Election Day, ${esc(fmtDate(h.election_date))}` : d === 0 ? 'Election Day is today' : 'Election Day has passed'}</strong></div>
    </div>
    <div class="next" aria-live="polite">
      <span class="kicker">Your next step</span>
      <p class="big">${esc(step.title)}</p>
      ${step.lines.map((l) => `<p>${esc(l)}</p>`).join('')}
      ${regAlert(h)}
      ${step.ctas.length ? `<div class="row">${step.ctas.map(([l, u], i) => `<a class="btn ${i === 0 ? 'btn-gold' : ''} btn-sm" href="${esc(u)}" target="_blank" rel="noopener">${esc(l)}</a>`).join('')}</div>` : ''}
    </div>
    <div class="plan-sec"><span class="kicker">Key dates <span class="lim">Tap one for details</span></span>
      ${past.length ? `${discBtn('plan-past', `${past.length} earlier ${past.length === 1 ? 'date has' : 'dates have'} passed`, 'btn-text btn btn-xs')}` : ''}
      <ol class="pdates">${isOpen('plan-past') ? past.map((r) => rowHTML(r, true)).join('') : ''}${future.map((r) => rowHTML(r, false)).join('')}</ol>
    </div>
    <div class="plan-sec"><span class="kicker">What to bring</span>
      <ul class="bring">
        <li><strong>ID:</strong> ${esc(IDS[h.id_rules.required] || h.id_rules.required)}. ${discBtn('plan-id', 'Which IDs count', 'btn-text btn btn-xs')}</li>
        ${isOpen('plan-id') ? `<li class="small"><ul class="idlist">${h.id_rules.accepted.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>${h.id_rules.no_id_option ? `<p>${esc(h.id_rules.no_id_option)}</p>` : ''}</li>` : ''}
        <li><strong>Notes or this cheat sheet:</strong> ${esc(NOTES[booth.notes_allowed] || booth.notes_allowed)}. <strong>Phones:</strong> ${esc(PHONES[booth.phones] || booth.phones)}. ${discBtn('plan-booth', 'The exact rules', 'btn-text btn btn-xs')}</li>
        ${isOpen('plan-booth') ? `<li class="small">${[booth.notes_detail, booth.phones_detail, booth.apparel_rule].filter(Boolean).map((x) => `<p>${esc(x)}</p>`).join('')}</li>` : ''}
      </ul>
    </div>
    <div class="plan-sec">
      ${h.model_plain ? `<p class="small"><strong>How voting works here.</strong> ${esc(h.model_plain)}</p>` : ''}
      <p class="small">${ballotLine}</p>
      ${office ? `<p class="small">Your elections office: ${office.url ? ext(office.url, office.name) : esc(office.name)}${office.phone ? `, <span class="phone">${esc(office.phone)}</span>` : ''}.</p>` : ''}
      ${b.places.map((p) => p.notes).filter(Boolean).map((n) => `<p class="small">${esc(n)}</p>`).join('')}
      ${h.gotchas.length ? `${discBtn('plan-gotchas', `Things people get wrong in ${b.stateName}`)}${isOpen('plan-gotchas') ? `<ul class="gotchas">${h.gotchas.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}` : ''}
      <p class="lim">Checked ${esc(h.last_verified || '')}. Official info: ${ext(h.official_site.url, h.official_site.name)}.</p>
    </div>
    <div class="plan-ft"><button class="btn btn-sm" data-act="plan-fold" data-fk="plan-fold">Got it. Fold this up</button></div>
  </section>`;
}
