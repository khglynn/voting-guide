/* How covered your ballot is (model/coverage.ts), in three spots that say the same thing: step 2 on the
   first page and in the ballot's Edit sheet (setup.ts pickControlsHTML), and a shorter line under the
   ballot's "Endorsements: ... Edit" (ledger.ts ballotHeadHTML). A statewide ballot's request lives in
   its head's one notice instead (ledger.ts statewideHTML). Plain words, counts in words where they
   read better ("none with picks"), never "minutes": the pipeline runs scouts, a judge and Kevin's
   review before anything lands, so "about a day" is the honest number. */
import { S } from '../state';
import { esc, fmtDate, plural } from '../util';
import { ballotCoverage, type Cov } from '../model/coverage';
import { shelfAttrs } from './common';
import { askFallbackURL } from './shelf';

export const covOf = (): Cov | null => (S.ballot && S.index ? ballotCoverage(S.ballot, S.index, S.b.zip) : null);

const when = (c: Cov): string => (c.checked ? ` Last checked ${fmtDate(c.checked, { weekday: false })}.` : '');
const withWord = (c: Cov): string => (c.withPicks === 0 ? 'none with picks' : c.withPicks === c.sources ? 'all with picks' : `${c.withPicks} with picks`);
const count = (c: Cov): string => `<span class="cov-n">${esc(c.sources ? plural(c.sources, 'source') : 'No sources')}</span>`;
/* "24 sources for Chicago, 12 with picks. Last checked Oct 19." Without the place on the ballot (the
   masthead names it): "24 sources, 12 with picks. ..." */
export function countLine(c: Cov, named = true): string {
  const where = !named ? '' : c.kind === 'statewide' ? ` for ${esc(c.name)}’s statewide races` : ` for ${esc(c.name)}`;
  return `${count(c)}${where}, ${esc(withWord(c))}.${esc(when(c))}`;
}

/* The one-tap button, its "Sending..." while the post is out, and what a failed send offers. */
export function askBtn(c: Cov, label: string, cls = 'mini', fk = 'cov-ask'): string {
  const busy = S.ui.covAsk === 'sending';
  return `<button class="${cls}" data-act="cov-ask" data-fk="${fk}"${busy ? ' aria-disabled="true"' : ''}>${esc(busy ? 'Sending...' : label)}</button>`;
}
export function askFailHTML(c: Cov): string {
  const f = S.ui.covAsk;
  if (!c.ask || (f !== 'failed' && f !== 'unsure')) return '';
  return `<p class="rp-fail" role="alert">${f === 'unsure' ? 'Couldn’t confirm it sent.' : 'That didn’t send.'} <a href="${esc(askFallbackURL(c.ask))}" target="_blank" rel="noopener" data-rp-alt>Open the form in a new tab instead</a>.</p>`;
}
/* "Want to hear when it's in?": Request a city, with the place (or just the ZIP) filled in, for the
   optional email or phone. Kevin tells people himself from the queue; nothing is automated. */
export const hearBtn = (c: Cov, cls = 'linkbtn', fk = 'cov-hear'): string =>
  `<button class="${cls}" ${shelfAttrs({ kind: 'city', hint: 'follow', city: c.kind === 'thin' ? c.name : '', fk })}>Want to hear when it’s in?</button>`;

/* Step 2, under "Picks in N of your M races", once a ballot is found. A full place gets the count line;
   a thin place, or a statewide ballot found by its ZIP, gets the notice with its one tap. */
export function covHTML(): string {
  const c = covOf();
  if (!c) return '';
  if (c.kind === 'full' || !c.ask || c.state === 'landed') return `<p class="su-src">${countLine(c)}</p>`;
  const thin = c.kind === 'thin';
  if (c.state === 'asked') {
    const lead = thin ? `We’re gathering ${c.name}’s endorsements.` : 'We’re adding your city.';
    const rest = thin ? 'It usually takes about a day. Your ballot works now, and local picks show up when they’re in.'
      : `It usually takes about a day. You can use ${c.name}’s statewide races now.`;
    return `<div class="su-src cov-note" role="status"><p><b>${esc(lead)}</b> ${esc(rest)}</p><p>${hearBtn(c)}</p></div>`;
  }
  const lead = thin ? `We don’t have endorsements from ${c.name}’s local sources yet.` : `We only have ${c.name}’s statewide races for your area so far.`;
  const rest = thin ? `${count(c)} checked, ${esc(withWord(c))}.${esc(when(c))}` : `${count(c)} for them, ${esc(withWord(c))}.${esc(when(c))}`;
  return `<div class="su-src cov-note"><p><b>${esc(lead)}</b> ${rest}</p>
    ${askFailHTML(c)}<p class="row-btns">${askBtn(c, thin ? `Add ${c.name}’s endorsements for me` : 'Add my city for me')}</p></div>`;
}

/* Under the ballot's picks line, shorter: the count, or a thin place's notice as one quiet line with its
   tap inline, so the head still holds one notice (the address box) and one sample-ballot button. */
export function headCovHTML(): string {
  const c = covOf();
  if (!c) return '';
  if (c.kind !== 'thin' || !c.ask) return `<p class="picks-cov">${countLine(c, false)}</p>`;
  if (c.state === 'asked') return `<p class="picks-cov" role="status">Gathering ${esc(c.name)}’s endorsements, usually about a day. ${hearBtn(c, 'linkbtn', 'hd-hear')}</p>`;
  return `<p class="picks-cov">No endorsements from ${esc(c.name)}’s local sources yet. ${askBtn(c, 'Add them for me', 'linkbtn', 'hd-ask')}</p>${askFailHTML(c)}`;
}
