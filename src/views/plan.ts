/* "Your plan": countdown, the one next action, key dates, what to bring.
   Every date and deadline here is read from data/states/{ST}.json. Labels describe which
   field a date came from; the rule text itself is shown word for word. */
import type { HowTo } from '../types';
import { S } from '../state';
import { esc, fmtDate, todayISO, daysBetween, host } from '../util';
import { ext, isOpen, discBtn, sampleBallot, sentences, clampP, bulletsHTML, leadBulletsHTML, telHTML, srcLink, escP } from './common';

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

/* The one next action. `lines` feed the cheat sheet; `note` is the one tip the plan card
   shows under the title (the rest of the plan card already lists the dates). */
export function nextStep(h: HowTo): { title: string; lines: string[]; note: string | null; ctas: [string, string][] } {
  const t = todayISO();
  const ed = h.election_day;
  const mb = h.mail_ballot;
  const ep = h.early_in_person;
  const ctas: [string, string][] = [];
  if (t > h.election_date) return { title: 'Voting has closed', lines: [], note: null, ctas: mb.tracking_url ? [['Track your ballot', mb.tracking_url]] : [] };
  if (t === h.election_date) {
    const lines = [`Polls close at ${ed.polls_close}.`];
    if (ed.in_line_rule) lines.push(ed.in_line_rule);
    if (ed.lookup_url) ctas.push(['Find where to vote', ed.lookup_url]);
    if (isMailState(h) && mb.drop_box_lookup_url) ctas.push(['Find a drop box', mb.drop_box_lookup_url]);
    return { title: 'Today is Election Day', lines, note: lines.join(' '), ctas };
  }
  if (isMailState(h)) {
    const lines = [returnLine(h)];
    if (mb.mail_cutoff_advice) lines.push(mb.mail_cutoff_advice);
    if (mb.drop_box_lookup_url) ctas.push(['Find a drop box', mb.drop_box_lookup_url]);
    if (mb.tracking_url) ctas.push(['Track your ballot', mb.tracking_url]);
    return { title: 'Fill out your ballot and return it', lines, note: mb.mail_cutoff_advice || null, ctas };
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
  return { title, lines, note: null, ctas };
}

function regAlert(h: HowTo): string {
  const t = todayISO();
  const open = h.registration.deadlines.filter((d) => d.date && d.date >= t).sort((a, b) => (a.date! < b.date! ? -1 : 1));
  const online = open.find((d) => d.method === 'online') || open[0];
  if (!online || !online.date || daysBetween(t, online.date) > 14) return '';
  const how = online.method === 'online' ? 'online' : online.method === 'mail' ? 'by mail' : 'in person';
  return `<p class="reg-alert"><strong>Not registered yet?</strong> The last day to register ${how} is ${fmtDate(online.date)}. ${h.registration.check_url ? ext(h.registration.check_url, 'Check your registration') : ''}</p>`;
}

const PHONES: Record<string, string> = { allowed: 'allowed', restricted: 'restricted', prohibited: 'not allowed', unclear: 'unclear' };
const NOTES: Record<string, string> = { allowed: 'allowed', prohibited: 'not allowed', unclear: 'unclear' };
const IDS: Record<string, string> = {
  photo: 'Photo ID required in person', non_photo_ok: 'ID required in person; non-photo ID is OK',
  first_time_only: 'ID needed only for some first-time voters', none: 'No ID needed for most voters',
};

export function planFolded(): boolean { return S.b.planSeen && !S.ui.open.has('plan'); }

/* Who can vote by mail, read from the state file's own words. */
function mailAccess(h: HowTo): 'all' | 'anyone' | 'qualify' {
  if (isMailState(h)) return 'all';
  const who = sentences(h.mail_ballot.who_gets_one || '').slice(0, 3).join(' ');
  return /no excuse|no reason|without giving a reason|for any reason|anyone|any registered/i.test(who) ? 'anyone' : 'qualify';
}

/* ---------- "The basics": one label, one short value, details one tap away ---------- */
interface Fact { label: string; value: string; sub?: string; k?: string; more?: string; detail?: string }
function factRow(f: Fact): string {
  const open = !!f.k && isOpen(f.k);
  return `<div class="fact"><dt>${esc(f.label)}</dt><dd>
    <span class="fact-v">${f.value}</span>${f.sub ? `<span class="fact-sub">${f.sub}</span>` : ''}
    ${f.k && f.detail ? `<button class="btn-text btn btn-xs" data-act="open" data-k="${esc(f.k)}" aria-expanded="${open}" data-fk="${esc(f.k)}">${esc(f.more || 'Details')}</button>` : ''}
    ${open && f.detail ? `<div class="fact-more">${f.detail}</div>` : ''}</dd></div>`;
}
const srcLine = (...urls: (string | null | undefined)[]): string => {
  const u = [...new Set(urls.filter(Boolean) as string[])];
  return u.length ? `<p class="lim">Source: ${u.map((x) => srcLink(x)).join(' ')}</p>` : '';
};
const sub = (label: string, html: string): string => (html ? `<div class="fm-sec"><span class="kicker">${esc(label)}</span>${html}</div>` : '');

function facts(): Fact[] {
  const b = S.ballot!;
  const h = b.howto;
  const ep = h.early_in_person;
  const ed = h.election_day;
  const mb = h.mail_ballot;
  const out: Fact[] = [];

  out.push({
    label: 'Early voting',
    value: ep.available ? (ep.start && ep.end ? `${esc(fmtDate(ep.start))} to ${esc(fmtDate(ep.end))}` : 'Yes. Check your county for dates') : 'Not offered here',
    k: 'pf-ep', more: 'Hours and places',
    detail: ep.available ? `${bulletsHTML(ep.hours_note)}${ep.lookup_url ? `<p>${ext(ep.lookup_url, 'Find early voting places')}</p>` : ''}` : '',
  });

  const openShort = shortText(ed.polls_open, 12);
  out.push({
    label: 'Election Day',
    value: `${esc(fmtDate(h.election_date))}`,
    sub: openShort ? `${esc(ed.polls_open)} to ${esc(ed.polls_close)}` : `Polls close ${esc(ed.polls_close)}`,
    k: 'pf-ed', more: 'Polling places and lines',
    detail: `${openShort ? '' : bulletsHTML(ed.polls_open)}${bulletsHTML(ed.in_line_rule)}${ed.lookup_url ? `<p>${ext(ed.lookup_url, 'Find where to vote')}</p>` : ''}`,
  });

  const access = mailAccess(h);
  const qual = access === 'qualify' ? (h.model_plain || '').match(/qualify:\s*([^.]+)\./i) : null;
  const r = mb.return_deadline;
  const timeShort = shortText(r.time);
  const due = r.rule === 'received_by' ? 'Must arrive by' : r.rule === 'postmarked_by' ? 'Postmark by' : 'Return by';
  const rq = mb.request_deadline;
  const subBits = [
    access !== 'all' && rq && rq.date ? `Request by ${fmtDate(rq.date)}` : '',
    `${due} ${fmtDate(r.date)}${timeShort ? `, ${r.time}` : ''}`,
  ].filter(Boolean);
  out.push({
    label: 'By mail',
    value: access === 'all' ? 'Mailed to every voter' : access === 'anyone' ? 'Anyone can ask for one' : 'Only if you qualify',
    sub: `${qual ? `<span class="fact-line">${esc(qual[1].charAt(0).toUpperCase() + qual[1].slice(1))}.</span>` : ''}<span class="fact-line">${esc(subBits.join(' · '))}</span>`,
    k: 'pf-mail', more: access === 'qualify' ? 'Who qualifies and how' : 'How it works',
    detail: [
      sub(access === 'all' ? 'Who gets one' : 'Who can', bulletsHTML(mb.who_gets_one)),
      access !== 'all' && rq ? sub('Asking for one', `${bulletsHTML(rq.rule)}${srcLine(rq.source)}`) : '',
      sub('Sending it back', `${timeShort ? '' : bulletsHTML(r.time)}${mb.return_options && mb.return_options.length ? `<ul class="bul">${mb.return_options.map((o) => `<li>${escP(o)}</li>`).join('')}</ul>` : ''}${srcLine(r.source)}`),
      sub('When to mail it', bulletsHTML(mb.mail_cutoff_advice)),
      mb.tracking_url || mb.drop_box_lookup_url ? `<p class="row">${mb.tracking_url ? ext(mb.tracking_url, 'Track your ballot') : ''}${mb.drop_box_lookup_url ? ext(mb.drop_box_lookup_url, 'Find a drop box') : ''}</p>` : '',
    ].join(''),
  });

  const idr = h.id_rules;
  out.push({
    label: 'Bring',
    value: esc(IDS[idr.required] || idr.required),
    k: 'pf-id', more: 'Which IDs count',
    detail: `${idr.accepted.length ? `<ul class="bul">${idr.accepted.map((a) => `<li>${escP(a)}</li>`).join('')}</ul>` : ''}${idr.no_id_option ? sub('No ID?', bulletsHTML(idr.no_id_option)) : ''}`,
  });

  const booth = h.in_the_booth;
  out.push({
    label: 'In the booth',
    value: `Notes ${esc(NOTES[booth.notes_allowed] || booth.notes_allowed)}<span class="dot-sep" aria-hidden="true"> · </span><span class="vh">. </span>Phones ${esc(PHONES[booth.phones] || booth.phones)}`,
    k: 'pf-booth', more: 'The exact rules',
    detail: [sub('Notes and this cheat sheet', bulletsHTML(booth.notes_detail)), sub('Phones', bulletsHTML(booth.phones_detail)), sub('What to wear', bulletsHTML(booth.apparel_rule))].join(''),
  });

  const office = b.places.map((p) => p.county_election_office).find(Boolean);
  if (office) {
    const m = office.name.match(/^(.*?)[,:]\s*(\d[\s\S]*)$/);
    const [name, addr] = m ? [m[1], m[2]] : ((): [string, string] => { const ss = sentences(office.name); return [ss[0], ss.slice(1).join(' ')]; })();
    out.push({
      label: 'Your office',
      value: office.url ? ext(office.url, name) : esc(name),
      sub: [office.phone ? `<span class="fact-line">${telHTML(office.phone)}</span>` : '', addr ? `<span class="fact-line fact-addr">${esc(addr)}</span>` : ''].filter(Boolean).join(''),
    });
  }

  const sb = sampleBallot();
  out.push({
    label: 'Your ballot',
    value: b.hasLocal ? 'This guide has your statewide and local races.' : 'We only have statewide races for your area so far.',
    sub: sb ? (b.hasLocal ? `Double-check with ${ext(sb.url, 'your official sample ballot')}.` : `${ext(sb.url, sb.label)}.`) : '',
  });
  return out;
}

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
      ${hasMore && isOpen(k) ? `<div class="small">${r.detail ? bulletsHTML(r.detail) : ''} ${r.source ? ext(r.source, `Source: ${host(r.source)}`) : ''}</div>` : ''}</div></li>`;
  };
  const where = b.places.length ? b.places.map((p) => p.label).join(' or ') : b.stateName;
  const notes = b.places.map((p) => p.notes).filter(Boolean) as string[];
  const moreOpen = isOpen('plan-more');
  return `<section class="plan" id="plan" aria-labelledby="plan-h">
    <div class="plan-top">
      <div class="count" aria-hidden="true">${countWord}</div>
      <div class="count-label"><span class="kicker" id="plan-h">Your plan, ${esc(b.stateName)}</span>
        <strong>${d > 0 ? `${d === 1 ? 'day' : 'days'} until Election Day, ${esc(fmtDate(h.election_date))}` : d === 0 ? 'Election Day is today' : 'Election Day has passed'}</strong></div>
    </div>
    <div class="next" aria-live="polite">
      <span class="kicker">Your next step</span>
      <p class="big">${esc(step.title)}</p>
      ${step.note ? clampP('plan-note', step.note, 24) : ''}
      ${regAlert(h)}
      ${step.ctas.length ? `<div class="row">${step.ctas.map(([l, u], i) => `<a class="btn ${i === 0 ? 'btn-gold' : ''} btn-sm" href="${esc(u)}" target="_blank" rel="noopener">${esc(l)}</a>`).join('')}</div>` : ''}
    </div>
    <div class="plan-sec"><h3 class="kicker">The basics</h3>
      <dl class="facts">${facts().map(factRow).join('')}</dl>
    </div>
    <div class="plan-sec plan-discs">
      ${discBtn('plan-dates', `Every key date${past.length ? `, ${past.length} passed` : ''}`)}
      ${isOpen('plan-dates') ? `<ol class="pdates">${past.map((r) => rowHTML(r, true)).join('')}${future.map((r) => rowHTML(r, false)).join('')}</ol>` : ''}
      ${h.gotchas.length ? `${discBtn('plan-gotchas', `Things people get wrong in ${b.stateName}`)}${isOpen('plan-gotchas') ? leadBulletsHTML(h.gotchas, 'bul bul-lead gotchas') : ''}` : ''}
      ${h.model_plain || notes.length ? `${discBtn('plan-more', `More about voting in ${where}`)}${moreOpen ? `<div class="disc-bd small">${sub(`How voting works in ${b.stateName}`, bulletsHTML(h.model_plain))}${notes.map((n) => sub(`${where} notes`, bulletsHTML(n))).join('')}</div>` : ''}` : ''}
      <p class="lim">Checked ${esc(h.last_verified || '')}. Official info: ${ext(h.official_site.url, h.official_site.name)}.</p>
    </div>
    <div class="plan-ft"><button class="btn btn-sm" data-act="plan-fold" data-fk="plan-fold">Got it. Fold this up</button></div>
  </section>`;
}
