/* Cheat sheet: picks and notes in ballot order, plus the plan essentials. Print, copy, save link. */
import type { Item } from '../types';
import { S, encodeShare } from '../state';
import { SECTIONS, entriesBySection, status, isDecision, itemTitle, isMultiJudge } from '../ballot';
import { esc, fmtDate } from '../util';
import { pickLabel } from './items';
import { nextStep } from './plan';

interface Line { sec: string; it: Item | null; title: string; label: string | null; note: string; unopposed: boolean; question?: boolean }

const cheatTitle = (it: Item): string => (it.kind === 'measure' && it.level !== 'state' ? `${it.number} (${it.jurisdiction})` : itemTitle(it));

function lines(): Line[] {
  const b = S.ballot!;
  const by = entriesBySection();
  const out: Line[] = [];
  for (const [k, label] of SECTIONS) {
    for (const e of by.get(k) || []) {
      if (e.t === 'question') { out.push({ sec: label, it: null, title: e.group.office, label: null, note: 'Depends on your district. Pick it in the guide or check your sample ballot.', unopposed: false, question: true }); continue; }
      if (e.t !== 'item') continue;
      const it = b.byId.get(e.id)!;
      const s = status(it);
      if (s === 'info') continue;
      const unopposed = s === 'unopposed';
      out.push({ sec: label, it, title: cheatTitle(it), label: unopposed && it.kind === 'contest' ? `${it.candidates[0].name} (unopposed)` : pickLabel(it), note: (S.b.notes[it.id] || '').trim(), unopposed });
    }
  }
  return out;
}

function essentials(): string[] {
  const h = S.ballot!.howto;
  const step = nextStep(h);
  const out = [step.title + '.', ...step.lines.slice(0, 1)];
  const booth = h.in_the_booth;
  out.push(`In the booth: notes ${booth.notes_allowed === 'allowed' ? 'are allowed' : booth.notes_allowed === 'prohibited' ? 'are not allowed' : 'rules are unclear'}; phones ${booth.phones === 'allowed' ? 'are allowed' : booth.phones === 'prohibited' ? 'are not allowed' : booth.phones === 'restricted' ? 'are restricted' : 'rules are unclear'}.`);
  return out;
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
    out.push(`${l.title}: ${l.label || '____'}`);
    const it = l.it;
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
  for (const l of lines()) {
    if (l.unopposed && !forPrint) continue;
    if (l.sec !== sec) { sec = l.sec; rows.push(`<tr class="cs-sec"><th colspan="2" scope="colgroup">${esc(sec)}</th></tr>`); }
    const it = l.it;
    const multi = !!it && it.kind === 'contest' && isMultiJudge(it);
    const sub = it && it.kind === 'contest' && multi ? `<ul class="cs-judges">${it.candidates.map((c) => { const v = S.b.picks[`${it.id}|${c.name}`]; return `<li>${esc(c.name)}: <strong>${v === 'YES' ? 'Yes' : v === 'NO' ? 'No' : '<span class="print-only">____</span><span class="screen-only">not decided</span>'}</strong></li>`; }).join('')}</ul>` : '';
    rows.push(`<tr><th scope="row">${esc(l.title)}${l.note ? `<span class="cs-note">Note: ${esc(l.note)}</span>` : ''}</th>
      <td class="${l.label ? '' : 'undecided'}">${l.label ? esc(l.label) : '<span class="screen-only">Not decided</span><span class="print-only">________________</span>'}${sub}</td></tr>`);
  }
  return `<table><tbody>${rows.join('')}</tbody></table>`;
}

export function cheatHTML(forPrint = false): string {
  const b = S.ballot!;
  const all = lines().filter((l) => !l.it || isDecision(status(l.it)));
  const done = all.filter((l) => l.label).length;
  const where = b.places.length ? b.places.map((p) => p.label).join(' or ') : b.stateName;
  return `<div class="cheat">
    <div class="cheat-hd"><span class="kicker">${esc(where)}${S.b.zip ? `, ${esc(S.b.zip)}` : ''}. Election Day ${esc(fmtDate(b.howto.election_date))}</span>
      <h2 class="h2" id="${forPrint ? 'cs-p' : 'cs-h'}">Your cheat sheet</h2>
      <p class="small muted">${done} of ${all.length} decided. Blank lines are yours to fill in.</p></div>
    <div class="cheat-plan">${essentials().map((x) => `<p>${esc(x)}</p>`).join('')}</div>
    ${tableHTML(forPrint)}
    <div class="cheat-ft"><p class="lim">From the 2026 voting guide. Checked ${esc(b.howto.last_verified || '')}. Official info: <span class="p-url" data-url="${esc(b.howto.official_site.url)}">${esc(b.howto.official_site.name)}</span>.</p></div>
  </div>`;
}

export function cheatSectionHTML(): string {
  const url = S.ui.saveOpen ? shareURL() : '';
  const body = `My voting picks: ${url}`;
  return `<section class="cheat-wrap" id="cheat" aria-labelledby="cs-h">
    ${cheatHTML(false)}
    <div class="row cheat-actions screen-only">
      <button class="btn btn-primary" data-act="print">Print</button>
      <button class="btn" data-act="copy">Copy as text</button>
      <button class="btn" data-act="save-open" aria-expanded="${S.ui.saveOpen}">Save my picks</button>
    </div>
    ${S.ui.copyFallback ? `<label class="small screen-only" for="cf">Copy didn’t work here. Select this text and copy it.</label><textarea class="copy-fallback screen-only" id="cf" readonly>${esc(S.ui.copyFallback)}</textarea>` : ''}
    ${S.ui.saveOpen ? `<div class="save screen-only">
      <p class="small"><strong>No account needed.</strong> This link holds your picks and notes. Open it on any device to get them back. Anyone with the link can see your picks.</p>
      <input class="save-url" readonly value="${esc(url)}" aria-label="Your save link" data-fk="save-url">
      <div class="row"><button class="btn btn-sm btn-primary" data-act="copy-link">Copy link</button>
        <a class="btn btn-sm" href="sms:?&body=${encodeURIComponent(body)}">Text it to me</a>
        <a class="btn btn-sm" href="mailto:?subject=${encodeURIComponent('My voting picks')}&body=${encodeURIComponent(body)}">Email it to me</a></div>
      <p class="lim">Text and email open your phone’s apps, if it has them. Copy always works. Your picks also save on this device.</p>
    </div>` : ''}
  </section>`;
}
