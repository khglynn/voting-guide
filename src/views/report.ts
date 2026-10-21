/* "Report a problem" and "Request a city": one sheet, two openings (Kevin, Oct 21: "Let's move the
   report and request forms into the web app"). It posts straight into Kevin's Google Form (common.FORM),
   so the form's response sheet stays the queue the pipeline reads: a triage script opens a Pen card,
   Kevin approves, an agent adds the city or makes the fix. Nothing new runs anywhere.
   What you type lives only in this sheet while it is open (S.ui.report, in memory): never in
   localStorage or the save link. The form in a new tab, prefilled with what you typed, is always one
   tap away, and it's what a failed send offers. */
import { S, type Report } from '../state';
import { esc } from '../util';
import { FORM, formURL } from './common';

interface Field { k: string; label: string; type: 'area' | 'text' | 'url' | 'zip'; required?: boolean; optional?: boolean; hint?: string; ph?: string; auto?: string; max: number }
const REACH: Field = { k: 'reach', label: 'How can Kevin reach you?', type: 'text', optional: true, hint: 'Only if you’d like a reply.', auto: 'off', max: 300 };
/* The form's own questions in the guide's words; its hints where it has them. */
const REPORT: Field[] = [
  { k: 'wrong', label: 'What’s wrong?', type: 'area', required: true, hint: 'For example: a wrong date, a missing candidate, an endorsement that’s off, or a broken link.', max: 5000 },
  { k: 'what', label: 'Which race or measure?', type: 'text', max: 300 },
  { k: 'where', label: 'Where are you voting?', type: 'text', ph: 'City or ZIP', max: 300 },
  { k: 'link', label: 'A link that shows the right info', type: 'url', optional: true, max: 1000 },
  REACH,
];
const CITY: Field[] = [
  { k: 'city', label: 'Which city?', type: 'text', required: true, ph: 'City or town', auto: 'address-level2', max: 200 },
  { k: 'zip', label: 'Your ZIP', type: 'zip', max: 5 },
  { ...REACH, hint: 'Only if you’d like to hear when it’s added.' },
];
/* Opened from a paywalled paper's "Send it to us": the first box asks for its picks instead. */
const PAYWALL_HINT = 'Paste their picks here, or put a link to a PDF below.';
const fieldsOf = (r: Report): Field[] => (r.kind === 'city' ? CITY : REPORT);
/* The one question the form requires: the sheet won't send without it. */
export const requiredOf = (r: Report): string => (r.kind === 'city' ? 'city' : 'wrong');

/* What the form gets, by its ids. A city request goes in as the city form always has ("Please add my
   city" for the race, the ZIP for the place) with the city in "What's wrong?" after "Please add ". A
   report opened from a row or a source sends that id after the race while the race still reads as it
   was prefilled, so a fix can find the record; change the race and only your words go. fvv and
   pageHistory are the two hidden fields the form's own page sends. */
export function reportBody(r: Report): Record<string, string> {
  const v = (k: string): string => (r.f[k] || '').trim();
  const city = v('city');
  const what = r.kind === 'city' ? 'Please add my city' : r.tag && v('what') === r.what0.trim() ? `${v('what')} [${r.tag}]` : v('what');
  return {
    [FORM.what]: what,
    [FORM.where]: v(r.kind === 'city' ? 'zip' : 'where'),
    [FORM.wrong]: r.kind === 'city' ? (city ? `Please add ${city}` : '') : v('wrong'),
    [FORM.link]: r.kind === 'city' ? '' : v('link'),
    [FORM.reach]: v('reach'),
    fvv: '1',
    pageHistory: '0',
  };
}
/* "Open the form in a new tab instead": the same answers, prefilled. */
export function reportFallbackURL(r: Report): string {
  const b = reportBody(r);
  return formURL(b[FORM.what], b[FORM.where], { wrong: b[FORM.wrong], link: b[FORM.link], reach: b[FORM.reach] });
}
const altLink = (r: Report, text = 'Open the form in a new tab instead'): string =>
  `<a href="${esc(reportFallbackURL(r))}" target="_blank" rel="noopener" data-rp-alt>${esc(text)}</a>`;

function fieldHTML(r: Report, f: Field): string {
  const id = `rf-${f.k}`;
  const val = r.f[f.k] || '';
  const bad = r.err && f.k === requiredOf(r);
  const hint = f.k === 'wrong' && r.hint === 'paywall' ? PAYWALL_HINT : f.hint;
  const desc = [hint ? `${id}-h` : '', bad ? 'rf-err' : ''].filter(Boolean).join(' ');
  const attrs = `id="${id}" name="${f.k}" data-rf="${f.k}" data-fk="${id}" maxlength="${f.max}"${f.required ? ' aria-required="true"' : ''}${desc ? ` aria-describedby="${desc}"` : ''}${bad ? ' aria-invalid="true"' : ''}${f.ph ? ` placeholder="${esc(f.ph)}"` : ''}${f.auto ? ` autocomplete="${f.auto}"` : ''}`;
  const input = f.type === 'area' ? `<textarea ${attrs} rows="4">${esc(val)}</textarea>`
    : f.type === 'zip' ? `<input ${attrs} inputmode="numeric" pattern="[0-9]*" autocomplete="postal-code" value="${esc(val)}">`
      : `<input ${attrs} type="${f.type === 'url' ? 'url' : 'text'}"${f.type === 'url' ? ' inputmode="url" autocapitalize="off"' : ''} value="${esc(val)}">`;
  const err = bad ? `<p class="zip-err rp-err" id="rf-err">${f.k === 'city' ? 'Type the city first.' : 'Say what’s wrong first.'}</p>` : '';
  return `<div class="rp-f"><label for="${id}"><b>${esc(f.label)}</b>${f.optional ? ' <span class="rp-opt">optional</span>' : ''}</label>
    ${hint ? `<p class="rp-h" id="${id}-h">${esc(hint)}</p>` : ''}${input}${err}</div>`;
}

export function reportSheetHTML(): string {
  const r = S.ui.report;
  if (!r) return '';
  const title = r.kind === 'city' ? 'Request a city' : 'Report a problem';
  const sent = r.state === 'sent';
  const sending = r.state === 'sending';
  // Sent: the form gives way to the answer, in place, and Done closes the sheet.
  const body = sent
    ? `<div class="rp-sent" role="status"><p><b>Sent.</b> Kevin reads every one.</p>
        <button class="bigbtn" data-act="sheet-close" data-fk="report-done">Done</button></div>`
    : `<form class="rp-form" data-form="report" novalidate>
        ${fieldsOf(r).map((f) => fieldHTML(r, f)).join('')}
        <p class="fine rp-fine">Goes to Kevin’s Google Form. Nothing you type here is saved in the guide.</p>
        ${r.state === 'failed' ? `<p class="rp-fail" role="alert">That didn’t send. ${altLink(r)}.</p>` : ''}
        <button class="bigbtn" type="submit" data-fk="report-send"${sending ? ' aria-disabled="true"' : ''}>${sending ? 'Sending...' : 'Send'}</button>
        ${r.state === 'failed' ? '' : `<p class="fine rp-alt">${altLink(r)}</p>`}
      </form>`;
  return `<div class="scrim report screen-only" data-act="sheet-close"></div>
  <div class="sheet-panel report screen-only" role="dialog" aria-modal="true" aria-labelledby="sh-h" data-kind="${r.kind}">
    <div class="sheet-hd"><h2 id="sh-h">${title}</h2><button class="closebtn" data-act="sheet-close" data-fk="sheet-x">${sent ? 'Close' : 'Cancel'}</button></div>
    <div class="sheet-bd" data-keep="report">${body}</div></div>`;
}
