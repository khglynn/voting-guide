/* My plan (the cheat sheet, "Your voting plan"): picks and notes in ballot order with seat labels,
   ranked choices in order, the plan essentials and "Save it before you go"; Print (a real print
   sheet), Copy as text, Save a link. It ends there; Pass it
   on is its own step after it. Test hooks: #cheat and #r-print tables, tr[data-cs] rows. */
import type { Contest, Item } from '../types';
import { S, encodeShare } from '../state';
import { SECTIONS, entriesBySection, status, decisionItems, unclaimed, isMultiJudge, isRCV, isMaybe, ranksOf, ordinal } from '../ballot';
import { esc, fmtDate, todayISO } from '../util';
import { cheatTitle, pickLabel } from '../model/labels';
import { nextStep } from '../model/plan';
import { sectionTitle } from './ledger';

/* maybe: a pick on a race the ballot marks "Maybe on your ballot", so the sheet says "if it's on
   your ballot" instead of presenting it as certain. */
interface Line { sec: string; it: Item | null; title: string; label: string | null; note: string; unopposed: boolean; question?: boolean; q?: string; maybe?: boolean }

const rankedList = (it: Item | null): string[] => (it && it.kind === 'contest' && isRCV(it) && S.b.picks[it.id] !== 'SKIP' ? ranksOf(it.id) : []);
const rankNote = (it: Contest): string => `Ranked choice: rank up to ${it.rank_up_to}`;

const MAYBE = 'If it’s on your ballot';
/* An unanswered district question: the ballot's own words, and a tap that takes you to it. */
const Q_SUB = 'Depends on your district';
const Q_ACT = 'Pick your district';

function lines(): Line[] {
  const b = S.ballot!;
  const by = entriesBySection();
  const out: Line[] = [];
  // Races folded under "Other school districts that touch ..." stay off the sheet, as on the
  // ballot, unless you claimed one: opened the fold, or picked or noted one of them.
  const hidden = unclaimed();
  for (const [k] of SECTIONS) {
    const label = sectionTitle(k);
    for (const e of by.get(k) || []) {
      if (e.t === 'question') { out.push({ sec: label, it: null, title: e.group.office, label: null, note: '', unopposed: false, question: true, q: e.group.key }); continue; }
      if (e.t !== 'item') continue;
      const it = b.byId.get(e.id)!;
      const s = status(it);
      if (s === 'info') continue;
      const note = (S.b.notes[it.id] || '').trim();
      const unopposed = s === 'unopposed';
      const pick = unopposed ? null : pickLabel(it);
      if (hidden.has(it.id)) continue;
      out.push({ sec: label, it, title: cheatTitle(it), label: unopposed && it.kind === 'contest' ? `${it.candidates[0].name} (unopposed)` : pick, note, unopposed, maybe: !!pick && s !== 'skipped' && isMaybe(it.id) });
    }
  }
  return out;
}

export function essentials(t = todayISO()): string[] {
  const h = S.ballot!.howto;
  const step = nextStep(h, t);
  const head = step.head.map((p) => p[0]).join('');
  // While the next step is mailing your ballot, the box gives the mail steps, not the rules for a
  // voting booth you may never see (Oct 20: LA's box said "In the booth" to someone at home).
  if (step.phase === 'mail') return [head, ...step.sub];
  const out = [head, ...step.sub.slice(0, 1)];
  const booth = h.in_the_booth;
  const rule = (v: string, yes: string, no: string) => (v === 'allowed' ? yes : v === 'prohibited' ? no : v === 'restricted' ? 'are restricted' : 'rules are unclear');
  out.push(`In the booth: notes ${rule(booth.notes_allowed, 'are allowed', 'are not allowed')}; phones ${rule(booth.phones, 'are allowed', 'are not allowed')}.`);
  return out;
}

/* What follows "Save it before you go.", worded from the state's phone rule: a tab can reload to
   "No internet" in line at the polls. Nothing once voting has closed. */
export function saveLine(t = todayISO()): string | null {
  const b = S.ballot!;
  const phase = nextStep(b.howto, t).phase;
  if (phase === 'closed' || phase === 'polls_closed') return null;
  const phones = b.howto.in_the_booth.phones;
  if (phones === 'prohibited') return 'Print it or write it down.';
  return phones === 'allowed' ? 'Print it, copy it, or take a screenshot.' : 'Print it or copy it.';
}

export function shareURL(): string {
  return `${location.origin}${location.pathname}#${encodeShare(S.ballot!, S.b)}`;
}

export function cheatText(): string {
  const b = S.ballot!;
  const where = b.places.length ? b.places.map((p) => p.label).join(' or ') : b.stateName;
  const out = [`My ballot: ${where}${S.b.zip ? ` ${S.b.zip}` : ''}. Election Day ${fmtDate(b.howto.election_date)}.`, ...essentials(), ''];
  let sec = '';
  for (const l of lines()) {
    if (l.unopposed) continue;
    if (l.sec !== sec) { sec = l.sec; out.push(`${sec}:`); }
    const it = l.it;
    const ranks = rankedList(it);
    if (ranks.length) {
      out.push(`${l.title} (${rankNote(it as Contest).toLowerCase()})${l.maybe ? ` (${MAYBE.toLowerCase()})` : ''}:`);
      ranks.forEach((n, i) => out.push(`  ${ordinal(i + 1)}: ${n}`));
      if (l.note) out.push(`  Note: ${l.note}`);
      continue;
    }
    if (l.question) { out.push(`${l.title}: ____ (${Q_SUB.toLowerCase()})`); continue; }
    const short = it && it.kind === 'measure' && it.short_title ? ` (${it.short_title})` : '';
    out.push(`${l.title}${short}: ${l.label || '____'}${l.maybe ? ` (${MAYBE.toLowerCase()})` : ''}`);
    if (it && it.kind === 'contest' && isMultiJudge(it)) {
      it.candidates.forEach((c) => { const v = S.b.picks[`${it.id}|${c.name}`]; out.push(`  ${c.name}: ${v === 'YES' ? 'Yes' : v === 'NO' ? 'No' : '____'}`); });
    }
    if (l.note) out.push(`  Note: ${l.note}`);
  }
  out.push('', `Official info: ${b.howto.official_site.url}`);
  return out.join('\n');
}

function tableHTML(forPrint: boolean): string {
  let sec = '';
  const rows: string[] = [];
  const blank = '<span class="screen-only">Not decided</span><span class="print-only">________________</span>';
  for (const l of lines()) {
    if (l.unopposed && !forPrint) continue;
    if (l.sec !== sec) { sec = l.sec; rows.push(`<tr class="cs-sec"><th colspan="2" scope="colgroup">${esc(sec)}</th></tr>`); }
    if (l.question) {
      // The line goes back to the ballot with that question open, like every other line.
      const qgo = forPrint ? '' : ` data-act="goto" data-q="${esc(l.q!)}"`;
      rows.push(`<tr class="cs-q"${qgo}><th scope="row">${esc(l.title)}<span class="cs-sub">${Q_SUB}</span>${qgo ? `<button class="cs-go"${qgo}>${Q_ACT}<span class="vh"> for ${esc(l.title)}</span></button>` : ''}</th><td class="undecided">${forPrint ? '________________' : Q_ACT}</td></tr>`);
      continue;
    }
    const it = l.it;
    const go = it && !forPrint ? ` data-act="goto" data-id="${esc(it.id)}"` : '';
    const ranks = rankedList(it);
    // The title stays a plain text node (tests read it that way). The whole line is the tap
    // target; the "Change" button stays for keyboards and screen readers, shown only on focus.
    const short = it && it.kind === 'measure' && it.short_title ? `<span class="cs-sub">${esc(it.short_title)}</span>` : '';
    const maybe = l.maybe ? `<span class="cs-sub cs-if">${MAYBE}</span>` : '';
    const title = (extra = '') => `<th scope="row">${esc(l.title)}${short}${extra}${l.note ? `<span class="cs-note">Note: ${esc(l.note)}</span>` : ''}${go ? `<button class="cs-go"${go}>Change<span class="vh"> ${esc(l.title)}</span></button>` : ''}</th>`;
    if (it && it.kind === 'contest' && isRCV(it) && (ranks.length || !l.label)) {
      const body = ranks.length ? `<ol class="cs-ranks">${ranks.map((n, i) => `<li><span class="cs-rk">${ordinal(i + 1)}</span> ${esc(n)}</li>`).join('')}</ol>` : blank;
      rows.push(`<tr data-cs="${esc(it.id)}"${go}>${title(`<span class="cs-sub">${esc(rankNote(it))}</span>`)}<td class="${ranks.length ? '' : 'undecided'}">${body}${maybe}</td></tr>`);
      continue;
    }
    const multi = !!it && it.kind === 'contest' && isMultiJudge(it);
    const sub = it && it.kind === 'contest' && multi ? `<ul class="cs-judges">${it.candidates.map((c) => { const v = S.b.picks[`${it.id}|${c.name}`]; return `<li>${esc(c.name)}: <strong>${v === 'YES' ? 'Yes' : v === 'NO' ? 'No' : '<span class="print-only">____</span><span class="screen-only">not decided</span>'}</strong></li>`; }).join('')}</ul>` : '';
    rows.push(`<tr${it ? ` data-cs="${esc(it.id)}"` : ''}${go}>${title()}<td class="${l.label ? '' : 'undecided'}">${l.label ? esc(l.label) : blank}${maybe}${sub}</td></tr>`);
  }
  return `<table class="cs-table"><tbody>${rows.join('')}</tbody></table>`;
}

export function cheatHTML(forPrint = false): string {
  const b = S.ballot!;
  // The bar's own count (the one rule in ballot.ts), so the sheet and the bar never give two
  // totals for one ballot.
  const all = decisionItems();
  const done = all.filter((i) => i.done).length;
  const where = b.places.length ? b.places.map((p) => p.label).join(' or ') : b.stateName;
  const save = forPrint ? null : saveLine();
  // On screen the sheet is paper torn off a pad: a rendered top and a fill that continues its light.
  return `<div class="cheat">${forPrint ? '' : '<span class="sheet-top" aria-hidden="true"></span><span class="sheet-fill" aria-hidden="true"></span>'}
    <div class="cheat-head"><p class="kick">${esc(where)}${S.b.zip ? `, ${esc(S.b.zip)}` : ''}. Election Day ${esc(fmtDate(b.howto.election_date))}</p>
      ${forPrint ? '<h2 id="cs-p">Your voting plan</h2>' : '<div class="step cs-step"><span class="step-n" aria-hidden="true">4</span><h2 id="cs-h">Your voting plan</h2></div>'}
      <p class="sub">${done} of ${all.length} decided.${forPrint ? ' Blank lines are yours to fill in.' : ' Tap any line to change it.'}</p>
      <div class="remind">${essentials().map((x) => `<p>${esc(x)}</p>`).join('')}</div>
      ${save ? `<p class="notice save-go"><b>Save it before you go.</b> ${esc(save)}</p>` : ''}</div>
    ${tableHTML(forPrint)}
    <p class="fine cs-foot">From Kevin’s 2026 voting guide.${b.howto.last_verified ? ` Checked ${esc(fmtDate(b.howto.last_verified, { weekday: false }))}.` : ''} Official info: <span class="p-url" data-url="${esc(b.howto.official_site.url)}">${esc(b.howto.official_site.name)}</span>.</p>
  </div>`;
}

export function cheatSectionHTML(): string {
  const url = S.ui.saveOpen ? shareURL() : '';
  const body = `My voting picks: ${url}`;
  return `<section class="cheat-wrap wrap" id="cheat" aria-labelledby="cs-h">
    <button class="back" data-act="view" data-v="ballot" data-fk="cs-back">Back to the ballot</button>
    ${cheatHTML(false)}
    <div class="cheat-acts screen-only">
      <button class="cbtn dark" data-act="print" data-fk="cs-print">Print</button>
      <button class="cbtn" data-act="copy" data-fk="cs-copy">Copy as text</button>
      <button class="cbtn wide" data-act="save-open" aria-expanded="${S.ui.saveOpen}" data-fk="cs-save">Save a link to my picks</button>
    </div>
    ${S.ui.copyFallback ? `<label class="small screen-only" for="cf">Copy didn’t work here. Select this text and copy it.</label><textarea class="copy-fallback screen-only" id="cf" readonly>${esc(S.ui.copyFallback)}</textarea>` : ''}
    ${S.ui.saveOpen ? `<div class="save screen-only">
      <p class="small">This link holds your picks and notes. Open it on any device to get them back. <b>No account needed.</b> Anyone with the link can see your picks.</p>
      <input class="save-url" readonly value="${esc(url)}" aria-label="Your save link" data-fk="save-url">
      <div class="row-btns"><button class="mini dark" data-act="copy-link">Copy link</button>
        <a class="mini" href="sms:?&body=${encodeURIComponent(body)}">Text it to me</a>
        <a class="mini" href="mailto:?subject=${encodeURIComponent('My voting picks')}&body=${encodeURIComponent(body)}">Email it to me</a></div>
      <p class="fine">Text and email open your phone’s apps, if it has them. Copy always works. Your picks also save on this device.</p>
    </div>` : ''}
    <div class="next-step screen-only"><p><b>Next:</b> help your friends and family make a plan.</p>
      <button class="bigbtn" data-act="view" data-v="pass" data-fk="cs-pass">Help friends vote</button></div>
  </section>`;
}
