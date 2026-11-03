/* The plan strip (green paper): the next step and its date, one short line, the main button,
   "Check my registration" (with "Lookup can't find you?" under it, since state lookups match names
   exactly and a failed search reads as "I've been purged"; Kevin, Oct 20), "Dates, ID, ..." and "I already voted". Behind "Dates, ID, ...", on the same
   paper, sit the key dates and the rules for ID and the booth, the gotchas, and what to do if
   something goes wrong: everything the v2 plan card held, one tap away. Every date is read from the state file. */
import type { HowTo, HelpAction, OfficeLine, PlaceEarly } from '../types';
import { S } from '../state';
import { esc, fmtDate, todayISO, host } from '../util';
import { nextStep, registrationAlert, registerAction, isMailState, applyDated, countyKey, type Step } from '../model/plan';
import { ext, isOpen, bulletsHTML, leadBulletsHTML, escP, srcLink, sentences, telHTML, wordCount, deshout } from './common';
import { queryOf, textOf, best, type Item } from '../model/search';

/* What the strip last showed, so main.ts can repaint it when the step changes while the page
   sits open (the polls close, midnight passes). */
export let planKey = '';
export const stepKey = (h: HowTo): string => { const s = nextStep(h); return `${s.phase}|${s.head.map((p) => p[0]).join('')}`; };
export function planHTML(): string {
  const b = S.ballot!;
  const h = b.howto;
  const step = nextStep(h);
  planKey = `${step.phase}|${step.head.map((p) => p[0]).join('')}`;
  const head = step.head.map(([t, em]) => (em ? `<span class="d">${esc(t)}</span>` : esc(t))).join('');
  const reg = registrationAlert(h);
  const regBtn = reg ? registerAction(h) : null;
  const open = isOpen('whatif');
  const check = h.registration.check_url;
  const sub = planSub(step);
  return `<section class="plan" id="plan" aria-labelledby="plan-h"><div class="wrap plan-in">
      <h2 class="vh" id="plan-k" tabindex="-1" data-fk="plan-k">Your next step</h2>
      <p class="plan-h" id="plan-h">${head}</p>
      ${sub.length ? `<p class="plan-sub">${esc(sub.join(' '))}</p>` : ''}
      ${reg ? `<div class="plan-reg"><p>${esc(reg)}</p>${regBtn ? `<a class="pbtn line" href="${esc(regBtn.url)}" target="_blank" rel="noopener" data-fk="plan-register">${esc(regBtn.label)}</a>` : ''}</div>` : ''}
      ${countyActs(h, step)}
      <div class="plan-acts">${step.primary && !countyActs(h, step) ? `<a class="pbtn gold" href="${esc(step.primary.url)}" target="_blank" rel="noopener">${esc(step.primary.label)}</a>` : ''}
        ${check ? `<a class="pbtn line" href="${esc(check)}" target="_blank" rel="noopener">Check my registration</a>` : ''}</div>
      ${check && (h.situations || []).some((x) => x.id === 'lookup_cant_find') ? `<p class="plan-hint">Lookup can’t find you? <button class="linkbtn" data-act="whatif-sit" data-k="lookup_cant_find" data-fk="plan-cant-find">Try your name these ways</button></p>` : ''}
      <div class="plan-row"><button class="whatif-tog" data-act="open" data-k="whatif" aria-expanded="${open}" data-fk="whatif"><span>Dates, ID, and if you moved or lost <span class="nw">your ballot<svg class="chev" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 5l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></span></span></button>
        <button class="voted" data-act="view" data-v="pass" data-voted="1" data-fk="voted">I already voted</button></div>
      ${open ? whatIfHTML(h) : ''}
    </div></section>`;
}

/* A ballot across county lines whose voter's county the guide doesn't know yet (Austin reaches into Williamson
   and Hays, and a ZIP can too; Oct 28): the step's where-to-vote button becomes one per county, labeled, the
   main county's first. In Texas you vote early only in your own county, so a single county's map would be
   wrong for some. An address lookup, or a ZIP wholly in one county, brings back the one button. */
function countyActs(h: HowTo, step: Step): string {
  const links = h.county_links || [];
  const look = step.primary?.look;
  if (links.length < 2 || !look) return '';
  const btns = links.map((l, i) => {
    const url = l.lookups[look] || (look === 'drop_box' ? l.lookups.election_day : null) || step.primary!.url;
    return `<a class="pbtn ${i ? 'line' : 'gold'}" href="${esc(url)}" target="_blank" rel="noopener" data-county="${esc(l.county)}">${esc(`${l.county} County`)}</a>`;
  }).join('');
  return `<p class="plan-cty">${esc(step.primary!.label)} in your county:</p><div class="plan-acts plan-ctys">${btns}</div>`;
}

/* The line under the next step. While you can vote in person (not in a mail state), "Bring a
   photo ID." ends it where the state asks for one. During early voting, when the place gives its
   sites' hours in one line, that line stands in for the step's own lines (under "Early voting is
   open through Sun, Nov 1.": "Orange County sites are open 8 AM to 8 PM every day. Bring a photo
   ID."); before it opens, the date it runs through stays first. The rest stays behind "Dates,
   ID, ...". */
const IN_PERSON: Step['phase'][] = ['early_before', 'early_open', 'election_day', 'election_day_next'];
function planSub(step: Step): string[] {
  const h = S.ballot!.howto;
  if (isMailState(h) || !IN_PERSON.includes(step.phase)) return step.sub;
  const id = h.id_rules.required === 'photo' ? ['Bring a photo ID.'] : [];
  const hours = hoursLine(step);
  if (!hours) return [...step.sub, ...id];
  const runs = step.phase === 'early_before' ? step.sub.filter((s) => /^It runs through /.test(s)) : [];
  return [...runs, hours, ...id];
}
/* A place's early-voting hours in one line (its `hours_short`, else an `hours_note` that already
   fits), when every place on the ballot gives the same one and lies in one county. One county's
   hours can't speak for a place across county lines: Austin reaches into Williamson and Hays,
   and in Texas you vote early only in your own county. */
export function hoursLine(step: Step): string {
  if (step.phase !== 'early_before' && step.phase !== 'early_open') return '';
  if (S.ballot!.places.some((p) => p.counties.length !== 1)) return '';
  const line = (e: PlaceEarly | undefined): string => {
    const n = (e?.hours_note || '').trim();
    return (e?.hours_short || '').trim() || (n && wordCount(n) <= 12 && sentences(n).length === 1 ? n : '');
  };
  const lines = [...new Set(S.ballot!.places.map((p) => line(p.early_in_person)))];
  return lines.length === 1 ? lines[0] : '';
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
  // Where the window is a minimum with a later county day (statewide Florida: Oct 31, then Nov 1), both ends.
  const later = ep.available && ep.end && ep.latest_end && ep.latest_end > ep.end ? ep.latest_end : null;
  if (ep.available && ep.end) out.push({ date: ep.end, label: later ? 'Early voting ends in some counties' : 'Early voting ends', detail: ep.available && ep.start ? null : ep.hours_note, source: ep.lookup_url, key: 'epe' });
  if (later) out.push({ date: later, label: 'Early voting ends in the rest', detail: null, source: ep.lookup_url, key: 'epl' });
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

/* A common question, opened: the quick answer and its buttons, with the full answer, steps and
   source behind "More" (Kevin, Oct 20: quick answers with things you can do). A question with no
   short answer in the data shows the full answer as before. */
type Situation = NonNullable<HowTo['situations']>[number];
const moreBtn = (k: string, label: string): string => `<button class="pd-more" data-act="open" data-k="${esc(k)}" data-fk="${esc(k)}" aria-expanded="${isOpen(k)}" aria-label="${esc(isOpen(k) ? `Less: ${label}` : `More: ${label}`)}">${isOpen(k) ? 'Less' : 'More'}</button>`;
/* A short line with any phone number in it tappable. */
const shortHTML = (s: string): string => telHTML(deshout(s));
const actsHTML = (acts: HelpAction[] | undefined): string => (acts && acts.length ? `<div class="plan-acts wi-acts">${acts.map((a) => `<a class="pbtn line" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.label)}</a>`).join('')}</div>` : '');
function sitBody(x: Situation, showFull = false): string {
  const full = `<p>${escP(x.answer)}</p>${x.steps && x.steps.length ? `<ol>${x.steps.map((s) => `<li>${escP(s)}</li>`).join('')}</ol>` : ''}${x.source ? `<p class="meta">Source: ${srcLink(x.source)}${x.confidence === 'unverified' ? '. Not yet confirmed' : ''}</p>` : ''}`;
  if (!x.short) return full;
  const k = `wim-${x.id}`;
  // Found by a search in its full text: the full text shows, with no More to tap.
  if (showFull) return `<p class="wi-short">${shortHTML(x.short)}</p>${actsHTML(x.actions)}<div class="wi-full">${full}</div>`;
  // An answer we haven't confirmed says so beside its quick answer, not only behind "More".
  return `<p class="wi-short">${shortHTML(x.short)}</p>${actsHTML(x.actions)}<p class="meta wi-more">${x.confidence === 'unverified' ? 'Not yet confirmed. ' : ''}${moreBtn(k, x.question)}</p>${isOpen(k) ? `<div class="wi-full">${full}</div>` : ''}`;
}
/* "Gotchas": each one's fix in a line, the full text behind its "More". A gotcha with no short line in the
   data shows as before. `only`: while searching, the gotchas found, and which of them show their full text. */
function gotchaLi(h: HowTo, i: number, full = false): string {
  const t = h.gotchas[i];
  const sh = (h.gotcha_shorts || [])[i];
  if (!sh) { const ss = sentences(t); return `<li><strong>${escP(ss[0] || t)}</strong>${ss.length > 1 ? ` <span class="bul-rest">${escP(ss.slice(1).join(' '))}</span>` : ''}</li>`; }
  const k = `gm-${i}`;
  return `<li class="g-short">${shortHTML(sh)}${full ? ` <span class="pd-x">${escP(t)}</span>` : ` ${moreBtn(k, sh)}${isOpen(k) ? `<span class="pd-x">${escP(t)}</span>` : ''}`}</li>`;
}
function gotchasHTML(h: HowTo, only?: { shown: number[]; full: Set<number> }): string {
  const shorts = h.gotcha_shorts || [];
  if (!only && !shorts.some(Boolean)) return leadBulletsHTML(h.gotchas, 'bul bul-lead gotchas');
  const list = only ? only.shown : h.gotchas.map((_, i) => i);
  return `<ul class="bul bul-lead gotchas">${list.map((i) => gotchaLi(h, i, !!only && only.full.has(i))).join('')}</ul>`;
}

/* The county's election office: its name (linked), phone and address. */
/* The places on this ballot as of today: text dated to change (their notes, an office's hours) has. */
const placesNow = () => { const t = todayISO(); return S.ballot!.places.map((p) => (p.dated ? applyDated(p, p.dated, t) : p)); };
/* The election office: on a ballot across county lines whose voter's county is known, that county's office
   when the place lists one (Oct 28: Williamson's for north Pflugerville); otherwise the place's. */
function officeOf(): { name: string; url: string | null; phone: string | null; addr: string; phone_label?: string; lines: OfficeLine[]; hours?: string } | null {
  const b = S.ballot!;
  const ps = placesNow();
  const known = b.county;
  const own = known ? ps.map((p) => p.by_county?.find((c) => countyKey(c.county) === countyKey(known))?.office).find(Boolean) : undefined;
  // A county the place doesn't list (a Caldwell address on San Marcos's ballot) gets no office card, rather
  // than the wrong county's: the same rule as its links (plan.lookupsFor).
  const elsewhere = !!known && ps.some((p) => p.by_county && p.by_county.length && !p.by_county.some((c) => countyKey(c.county) === countyKey(known)));
  const office = own || (elsewhere ? null : ps.map((p) => p.county_election_office).find(Boolean));
  if (!office) return null;
  const m = office.name.match(/^(.*?)[,:]\s*(\d[\s\S]*)$/);
  const [n, a] = m ? [m[1], m[2]] : [sentences(office.name)[0], sentences(office.name).slice(1).join(' ')];
  return { name: n, url: office.url || null, phone: office.phone || null, addr: a, phone_label: office.phone_label, lines: office.lines || [], hours: office.hours };
}
/* The office card: its name and link, its main phone (labeled when there are direct lines too), each direct
   line with its label (Oct 28: Orange's vote-by-mail line), the address, then its hours. */
function officeHTML(o: NonNullable<ReturnType<typeof officeOf>>): string {
  const phone = o.phone ? `<br>${o.phone_label ? `${esc(o.phone_label)}: ` : ''}${telHTML(o.phone)}` : '';
  const lines = o.lines.map((l) => `<br>${esc(l.label)}: ${telHTML(l.phone)}${l.hours ? ` (${esc(l.hours)})` : ''}`).join('');
  return `<p class="office">${officeName(o)}${phone}${lines}${o.addr ? `<br>${esc(o.addr)}` : ''}${o.hours ? `<br>${esc(o.hours)}` : ''}</p>`;
}
const officeName = (o: NonNullable<ReturnType<typeof officeOf>>): string => (o.url ? ext(o.url, o.name) : esc(o.name));

/* Everything behind "Dates, ID, ...", as the search reads it: each piece's heading (its question, or what it's
   about, and its quick answer) and its body (the full text behind "More", the dates, the ID list). */
type Part = { sec: 'basic' | 'gotcha' | 'sit'; i: number; k: string; q: string; body: string; full: string; item: Item };
const strip = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
function partsOf(h: HowTo): Part[] {
  const b = S.ballot!;
  const t = todayISO();
  const out: Part[] = [];
  // `full`: what a piece shows when a search found it behind its "More" or "Details" (Codex, Oct 28: a word only
  // in a date's fine print showed "Key dates" with that fine print folded away).
  const add = (sec: Part['sec'], i: number, k: string, q: string, head: string, body: string, bodyText = strip(body), full = body) => out.push({ sec, i, k, q, body, full, item: { head: textOf(`${q} ${head}`), body: textOf(bodyText) } });
  const rows = dateRows(h);
  // Each date keeps its fine print (the rule, the hours, the noon cutoff) one tap away; `all` shows every one.
  const dates = (all: boolean) => rows.map((r) => {
    const k = `kd-${r.key}`;
    const open = !!r.detail && (all || isOpen(k));
    const more = r.detail && !all ? ` <button class="pd-more" data-act="open" data-k="${k}" data-fk="${k}" aria-expanded="${open}" aria-label="${esc(open ? `Hide details: ${r.label}` : `Details: ${r.label}`)}">${open ? 'Hide details' : 'Details'}</button>` : '';
    return `<li class="${r.date < t ? 'past' : ''}"><span class="pd-d">${esc(fmtDate(r.date))}</span><span class="pd-l">${esc(r.label)}${r.date < t ? ' <span class="passed">passed</span>' : ''}${r.source ? ` ${ext(r.source, host(r.source))}` : ''}${more}${open ? `<span class="pd-x">${escP(r.detail)}</span>` : ''}</span></li>`;
  }).join('');
  const idr = h.id_rules;
  const booth = h.in_the_booth;
  const mail = h.mail_ballot;
  const office = officeOf();
  const basics: [string, string, string, string][] = [
    ['bx-dates', 'Key dates', `<ol class="pdates">${dates(false)}</ol>`, `deadline ${rows.map((r) => r.label).join(' ')}`],
    ['bx-id', `What to bring: ${IDS[idr.required] || idr.required}`, `${idr.accepted.length ? `<ul>${idr.accepted.map((a) => `<li>${escP(a)}</li>`).join('')}</ul>` : ''}${idr.no_id_option ? `<p><b>No ID?</b> ${escP(idr.no_id_option)}</p>` : ''}`, ''],
    ['bx-booth', `In the booth: notes ${RULE[booth.notes_allowed] || booth.notes_allowed}, phones ${RULE[booth.phones] || booth.phones}`, `${booth.notes_detail ? `<p><b>Notes and your plan.</b> ${escP(booth.notes_detail)}</p>` : ''}${booth.phones_detail ? `<p><b>Phones.</b> ${escP(booth.phones_detail)}</p>` : ''}${booth.apparel_rule ? `<p><b>What to wear.</b> ${escP(booth.apparel_rule)}</p>` : ''}`, booth.apparel_rule ? 'what to wear' : ''],
    ['bx-mail', isMailState(h) ? 'How voting by mail works' : 'Voting by mail instead', `${bulletsHTML(mail.who_gets_one)}${mail.return_options && mail.return_options.length ? `<ul>${mail.return_options.map((o) => `<li>${escP(o)}</li>`).join('')}</ul>` : ''}${mail.mail_cutoff_advice ? `<p>${escP(mail.mail_cutoff_advice)}</p>` : ''}<p>${[mail.tracking_url ? ext(mail.tracking_url, 'Track your ballot') : '', mail.drop_box_lookup_url ? ext(mail.drop_box_lookup_url, 'Find a drop box') : ''].filter(Boolean).join(' · ')}</p>`, ''],
  ];
  if (office) basics.push(['bx-office', 'Your election office', officeHTML(office), `contact call help ${office.lines.map((l) => l.label).join(' ')}`]);
  if (h.model_plain) basics.push(['bx-how', `How voting works in ${b.stateName}`, bulletsHTML(h.model_plain), '']);
  placesNow().filter((p) => p.notes).forEach((p) => basics.push([`bx-n-${p.id}`, `Notes for ${p.label}`, bulletsHTML(p.notes), '']));
  basics.forEach(([k, q, body, extra], i) => (k === 'bx-dates'
    ? add('basic', i, k, q, extra, body, rows.map((r) => r.detail || '').join(' '), `<ol class="pdates">${dates(true)}</ol>`)
    : add('basic', i, k, q, extra, body)));
  h.gotchas.forEach((g, i) => { const sh = (h.gotcha_shorts || [])[i]; add('gotcha', i, `gm-${i}`, sh || g, '', sh ? g : ''); });
  sitsOf(h).forEach((x, i) => add('sit', i, `wi-${x.id}`, x.question, x.short || '', `${x.answer} ${(x.steps || []).join(' ')}`));
  return out;
}
const sitsOf = (h: HowTo): Situation[] => (h.situations || []).filter((x) => x && x.question && x.answer);

/* The three groups: dates and ID, then the state's gotchas, then what to do if something goes wrong (Kevin,
   Oct 20). While a search is on (Kevin, Oct 28: "can we add it to the gotchas section too?"), only what it
   found, each answer showing (the full text too when that's where the words were), and no match says so and
   names the election office, which answers what the guide doesn't. Repainted alone as you type (actions.ts). */
const discHTML = (k: string, q: string, body: string) => `<li><button class="wi-q" data-act="open" data-k="${esc(k)}" data-fk="${esc(k)}" aria-expanded="${isOpen(k)}"><span>${esc(q)}</span><svg class="chev" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 5l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></button>${isOpen(k) ? `<div class="wi-a">${body}</div>` : ''}</li>`;
const foundHTML = (q: string, body: string) => `<li class="wi-found"><p class="wi-rq">${esc(q)}</p><div class="wi-a">${body}</div></li>`;
function partsFound(h: HowTo): { parts: Part[]; shown: Part[] | null; full: Set<string> } {
  const parts = partsOf(h);
  const q = queryOf(S.ui.wiQ);
  if (!q) return { parts, shown: null, full: new Set() };
  const r = best(q, parts.map((p) => p.item));
  return { parts, shown: r.shown.map((i) => parts[i]), full: new Set([...r.inBody].map((i) => parts[i].k)) };
}
export function whatIfBody(h: HowTo): string {
  const b = S.ballot!;
  const { parts, shown, full } = partsFound(h);
  const sits = sitsOf(h);
  const pick = (sec: Part['sec']) => (shown || parts).filter((p) => p.sec === sec);
  const basics = pick('basic').map((p) => (shown ? foundHTML(p.q, full.has(p.k) ? p.full : p.body) : discHTML(p.k, p.q, p.body))).join('');
  const gotchas = pick('gotcha');
  const sitParts = pick('sit');
  const sitList = sitParts.map((p) => { const x = sits[p.i]; return shown ? foundHTML(x.question, sitBody(x, full.has(p.k))) : discHTML(p.k, x.question, sitBody(x)); }).join('');
  if (shown && !shown.length) {
    const o = officeOf();
    const who = o ? `Contact your election office: ${officeName(o)}${o.phone ? ` · ${telHTML(o.phone)}` : ''}.` : `Contact ${ext(h.official_site.url, h.official_site.name)}.`;
    return `<p class="wi-none">No answers match “${esc(S.ui.wiQ.trim())}”. ${who}</p>`;
  }
  return `${basics ? `<h3 class="wi-h">Dates, ID and voting rules</h3><ul class="wi-list">${basics}</ul>` : ''}
    ${gotchas.length ? `<h3 class="wi-h">Gotchas in ${esc(b.stateName)}</h3>${gotchasHTML(h, shown ? { shown: gotchas.map((p) => p.i), full: new Set(gotchas.filter((p) => full.has(p.k)).map((p) => p.i)) } : undefined)}` : ''}
    ${sitList ? `<h3 class="wi-h">If something goes wrong</h3><p class="wi-sub">Answers come from ${ext(h.official_site.url, h.official_site.name)}.</p><ul class="wi-list">${sitList}</ul>` : ''}`;
}
/* How many answers the search found, for a screen reader once typing pauses. */
export function wiMatchWords(): string {
  const { shown } = partsFound(S.ballot!.howto);
  const n = shown ? shown.length : 0;
  return n ? `${n} ${n === 1 ? 'answer matches' : 'answers match'}.` : 'No answers match.';
}
function whatIfHTML(h: HowTo): string {
  const q = S.ui.wiQ;
  return `<div class="whatifs" role="region" aria-label="Dates, ID, gotchas and what to do">
    <form class="wi-find" data-form="wi-q" role="search">
      <label class="vh" for="wi-q">Search voting dates, ID rules and help</label>
      <input id="wi-q" type="search" placeholder="Search: lost ballot, ID, moved…" value="${esc(q)}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="search" data-wi-q data-fk="wi-q">
      <button type="button" class="linkbtn s-q-x" data-act="wi-q-x" data-fk="wi-q-x" aria-label="Clear search"${q ? '' : ' hidden'}>Clear</button>
    </form>
    <div class="wi-res" id="wi-res">${whatIfBody(h)}</div>
    <p class="meta">Checked ${esc(h.last_verified || '')}. Official info: ${ext(h.official_site.url, h.official_site.name)}.</p>
  </div>`;
}
