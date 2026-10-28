/* The shelf: one sheet from the bottom of the screen for everything the foot offers (Kevin, Oct 21:
   "report a bug and request a state open a shelf from the bottom. I like that paradigm. Let's use that
   for all of them"). Six openings: the list of cities (the foot's city count), How this guide works,
   Report a problem, Request a city, Support, and Add a source (Oct 25: from the sources sheet and the
   coverage line; a paste box for picks behind a login, so nothing needs an upload).
   The two forms post straight into Kevin's Google Form (common.FORM), so its response sheet stays the
   queue the pipeline reads. They ask for one sentence and an optional way back; everything else is
   collected here and shown under "We'll send along" before it goes (Kevin: "much cleaner forms that
   don't feel overwhelming. We want people to send feedback"). What you type lives only in this sheet
   while it is open (S.ui.report, in memory): never in localStorage or the save link. The form in a new
   tab, prefilled with the same answers, is always one tap away, and it's what a failed send offers.
   While a send is out the fields are read-only, so nothing typed then is lost when "Sent" takes the
   form's place (Codex, Oct 21). */
import { S, type Shelf, type ShelfKind, type Along } from '../state';
import type { Index } from '../types';
import { ballotCoverage, askedWord, type Ask } from '../model/coverage';
import { esc, fmtDate } from '../util';
import { lastErrors, lastErrorId } from '../errors';
import { FORM, formURL, ext, isOpen, kevinLink, reportWhere, BUY_ME_A_COFFEE_URL } from './common';

export const SHELF_TITLE: Record<ShelfKind, string> = {
  cities: 'Cities in the guide', how: 'How this guide works', report: 'Report a problem', city: 'Request a city', support: 'Support the guide', source: 'Add a source',
};
export const isForm = (k: ShelfKind): boolean => k === 'report' || k === 'city' || k === 'source';

/* ---------- the forms ---------- */
interface Field { k: string; label: string; type: 'area' | 'text' | 'zip'; required?: boolean; optional?: boolean; hint?: string; auto?: string; max: number; fold?: boolean }
const REPORT: Field[] = [
  { k: 'wrong', label: 'What’s wrong?', type: 'area', required: true, max: 5000 },
  { k: 'reach', label: 'Want a reply?', type: 'text', optional: true, hint: 'An email or phone, only if you’d like one back.', auto: 'off', max: 300 },
];
const CITY: Field[] = [
  { k: 'city', label: 'Which city or town?', type: 'text', required: true, auto: 'address-level2', max: 200 },
  { k: 'zip', label: 'ZIP', type: 'zip', optional: true, max: 5 },
  { k: 'reach', label: 'Want to hear when it’s up?', type: 'text', optional: true, hint: 'An email or phone, only if you’d like a note.', auto: 'off', max: 300 },
];
/* Add a source (Kevin, Oct 25: "the option to add their own source (URL, and then if paywalled maybe a
   clever way they can export a PDF and upload it for us)"): a name or a link, where you vote, and a
   paste box. A person with a login can select all and paste, so nothing needs an upload endpoint.
   The paste box is folded under one row (Kevin, Oct 28: "collapse the paste-in-their-picks and call it
   that ... optional, and if you expand it we show it, just so it looks like a more simple form"). */
const SOURCE: Field[] = [
  { k: 'src', label: 'Which source?', type: 'text', required: true, hint: 'Its name or a link.', auto: 'off', max: 500 },
  { k: 'where', label: 'Where you vote', type: 'text', optional: true, auto: 'off', max: 200 },
  { k: 'picks', label: 'Paste in their picks', type: 'area', optional: true, fold: true, hint: 'Behind a login? Copy their endorsement list and paste it here.', max: 5000 },
  { k: 'reach', label: 'Want a reply?', type: 'text', optional: true, hint: 'An email or phone.', auto: 'off', max: 300 },
];
/* The fold's key in S.ui.open: shut each time the form opens (actions.ts openShelf). */
export const PICKS_FOLD = 'rf-picks-fold';
/* Opened from a paywalled paper's "Send it to us": the box asks for its picks instead. A bot-checked
   source's (Oct 25) the same, without the login. */
const PAYWALL = { intro: 'Have a login? Send Kevin their picks.', label: 'Their picks, or a link to a PDF' };
const BLOCKED_INTRO = 'Can you see their picks? Send them to Kevin.';
const unreadHint = (r: Pick<Shelf, 'hint'>): boolean => r.hint === 'paywall' || r.hint === 'blocked';
/* "Tell me when it's in" / "Tell me what he finds" (the coverage card after its one tap, Oct 25 copy pass:
   "if we're doing the notify-me button opens the shelf, it should be pre-filled for them"): a follow-up
   to the request already sent, never a second "Please add my city". The request shows as text; an email
   or phone is the one thing to type, so it's required here. Everything else is read from the ballot and
   the request this device remembers (model/coverage.ts). */
const FOLLOW_FIELDS: Field[] = [
  { k: 'reach', label: 'Email or phone', type: 'text', required: true, hint: 'Kevin uses it once, to tell you.', auto: 'email', max: 300 },
];
interface Follow { title: string; intro: string; request: string; button: string; sent: string; what: string; wrong: string }
export const isFollow = (r: Pick<Shelf, 'kind' | 'hint'>): boolean => r.kind === 'city' && r.hint === 'follow';
export function followOf(): Follow {
  const c = S.ballot && S.index ? ballotCoverage(S.ballot, S.index, S.b.zip) : null;
  const on = c ? c.askedOn : null;
  const sentOn = on ? ` Sent ${askedWord(on)}.` : '';
  const from = on ? `Follow-up to the one-tap request from ${fmtDate(on, { weekday: false })}.` : 'Follow-up to the one-tap request.';
  if (c && c.kind === 'thin') {
    return {
      title: 'Tell me what he finds', button: 'Tell me what he finds', what: 'Follow-up: tell me what you find',
      intro: `Your request is in. Leave an email or phone number and Kevin will tell you what he finds for ${c.name}, even if it’s nothing.`,
      request: `local picks for ${c.name}${c.zip ? `, ZIP ${c.zip}` : ''}.${sentOn}`,
      sent: 'Kevin will tell you what he finds.',
      wrong: `Tell me what you find for ${c.name}. ${from}`,
    };
  }
  const zip = c ? c.zip : '';
  const st = S.ballot ? S.ballot.stateName : '';
  return {
    title: 'Tell me when it’s in', button: 'Tell me when it’s in', what: 'Follow-up: tell me when it’s in',
    intro: 'Your request is in. Leave an email or phone number and Kevin will tell you when your city’s races are in the guide.',
    request: `your city’s races${zip ? `, for ZIP ${zip}` : ''}${st ? ` in ${st}` : ''}.${sentOn}`,
    sent: 'Kevin will tell you when it’s in.',
    wrong: `Tell me when the city${zip ? ` for ZIP ${zip}` : ''} is in. ${from}`,
  };
}
const fieldsOf = (r: Shelf): Field[] => (isFollow(r) ? FOLLOW_FIELDS : r.kind === 'city' ? CITY : r.kind === 'source' ? SOURCE : REPORT);
/* The one question the form requires: the sheet won't send without it. */
export const requiredOf = (r: Shelf): string => (isFollow(r) ? 'reach' : r.kind === 'city' ? 'city' : r.kind === 'source' ? 'src' : 'wrong');

/* ---------- what a form sends along by itself ---------- */
/* The page it was opened on, in the words the guide uses for its pages. */
function pageName(): string {
  const page = S.view !== 'ballot' || !S.ballot ? 'First page' : S.ui.view === 'cheat' ? 'My plan' : S.ui.view === 'pass' ? 'Help friends vote' : 'Your ballot';
  return S.ui.reader ? `${page}, Full details` : page;
}
/* The browser in a few words, not the whole user agent: "Safari 18 on iPhone, 390px wide". The app a
   link was opened in comes first when it says so (a link sent by text often opens inside one). */
export function deviceWords(ua: string, width: number, touchPoints = 0): string {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /CrOS/.test(ua) ? 'Chromebook' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  const apps: [RegExp, string][] = [[/Instagram/, 'Instagram app'], [/FBAN|FBAV|FB_IAB/, 'Facebook app'], [/\bGSA\//, 'Google app'], [/\bLine\//, 'Line app']];
  const app = apps.find(([re]) => re.test(ua));
  const kinds: [RegExp, string][] = [[/(?:Edg|EdgiOS|EdgA)\/(\d+)/, 'Edge'], [/SamsungBrowser\/(\d+)/, 'Samsung Internet'], [/OPR\/(\d+)/, 'Opera'], [/(?:Firefox|FxiOS)\/(\d+)/, 'Firefox'],
    [/(?:CriOS|Chrome)\/(\d+)/, 'Chrome'], [/Version\/(\d+)[.\d]* (?:Mobile\/\S+ )?Safari/, 'Safari']];
  let browser = '';
  for (const [re, name] of kinds) { const m = ua.match(re); if (m) { browser = `${name} ${m[1]}`; break; } }
  const who = app ? app[1] : browser || 'A browser';
  return `${who}${os ? ` on ${os}` : ''}, ${Math.round(width)}px wide`;
}
/* The page's address without its hash (the save link lives there) and with only the test settings
   from its query. */
export function pageURL(loc: { origin: string; pathname: string; search: string }): string {
  const q = new URLSearchParams(loc.search);
  const keep = new URLSearchParams();
  for (const k of ['today', 'now', 'try']) { const v = q.get(k); if (v) keep.set(k, v); }
  const s = keep.toString();
  return `${loc.origin}${loc.pathname}${s ? `?${s}` : ''}`;
}
const dataWhen = (iso: string): string => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : iso);
/* Read when a form opens: nothing here can come from the address box, the save link or the Census. */
export function collectAlong(): Along {
  const idx = S.index;
  return {
    page: pageName(),
    where: reportWhere(),
    url: pageURL(location),
    data: idx ? dataWhen(idx.generated) : '',
    build: import.meta.env.VITE_BUILD || 'dev',
    device: deviceWords(navigator.userAgent, window.innerWidth, navigator.maxTouchPoints || 0),
    errors: lastErrors().map((e) => `${e.msg}${e.at ? ` (${e.at})` : ''} at ${e.time}`),
    crash: lastErrorId() || '',
  };
}
/* The values the page fills in itself. One place, so the list and the post can't drift apart. */
const aboutOf = (r: Pick<Shelf, 'what' | 'tag'>): string => (r.tag && r.what ? `${r.what} [${r.tag}]` : '');
const linkOf = (a: Along): string => `${a.url} (build ${a.build || 'dev'})`;
/* The "We'll send along" list. Every value the page fills in is on it word for word (Codex, Oct 21:
   "you can see what we send" has to hold): the page (or, from a row, the race with its record id), the
   place and ZIP, the page's address with the build, the data date, the browser, the errors caught, and
   the id of the crash report the page sent, when Sentry took one in (so a note and its crash meet).
   It also goes into "What's wrong?" after "Sent along:". A city request's is shorter. */
export function alongLines(r: Pick<Shelf, 'kind' | 'what' | 'tag' | 'along'>): string[] {
  const a = r.along;
  const head = [`Page: ${a.page}`, a.where ? `Place: ${a.where}` : ''];
  const tail = [`Page address: ${linkOf(a)}`, `Data built: ${a.data || 'unknown'}`];
  if (r.kind === 'city' || r.kind === 'source') return [...head, ...tail].filter(Boolean);
  const about = aboutOf(r);
  return [...head, about ? `About: ${about}` : '', ...tail, `Browser: ${a.device}`, ...a.errors.map((e) => `Error the page caught: ${e}`), a.crash ? `Crash report: ${a.crash}` : ''].filter(Boolean);
}

/* What the form gets, by its ids (Kevin's sheet keeps its five questions). A report: the race or
   measure it came from with its record id (or the page), the place and ZIP, your note with "Sent
   along:" under it, the page's address with the build, and how to reach you. A city request goes in as
   the city form always has ("Please add my city" for the race, the ZIP for the place, "Please add
   {city}" first in "What's wrong?"). fvv and pageHistory are the two hidden fields the form's own page
   sends. */
export function reportBody(r: Shelf): Record<string, string> {
  const v = (k: string): string => (r.f[k] || '').trim();
  if (isFollow(r)) {
    // The follow-up: its own words for the race and for "What's wrong?", the place and ZIP, the email or phone.
    const f = followOf();
    return {
      [FORM.what]: f.what,
      [FORM.where]: r.along.where,
      [FORM.wrong]: `${f.wrong}\n\nSent along:\n${alongLines(r).join('\n')}`,
      [FORM.link]: linkOf(r.along),
      [FORM.reach]: v('reach'),
      fvv: '1',
      pageHistory: '0',
    };
  }
  if (r.kind === 'source') {
    // Add a source: its name or link for the race, where you vote, the picks you pasted (or a plain ask)
    // with "Sent along:" under them, and the link itself when you gave one.
    const src = v('src');
    return {
      [FORM.what]: `Add source: ${src}`,
      [FORM.where]: v('where'),
      [FORM.wrong]: [v('picks') || 'Please add this source', `Sent along:\n${alongLines(r).join('\n')}`].join('\n\n'),
      [FORM.link]: /^https?:\/\/\S+$/i.test(src) ? src : linkOf(r.along),
      [FORM.reach]: v('reach'),
      fvv: '1',
      pageHistory: '0',
    };
  }
  const city = r.kind === 'city';
  const note = city ? (v('city') ? `Please add ${v('city')}` : '') : v('wrong');
  const sent = `Sent along:\n${alongLines(r).join('\n')}`;
  return {
    [FORM.what]: city ? 'Please add my city' : aboutOf(r) || r.along.page,
    [FORM.where]: city ? v('zip') : r.along.where,
    [FORM.wrong]: [note, sent].filter(Boolean).join('\n\n'),
    [FORM.link]: linkOf(r.along),
    [FORM.reach]: v('reach'),
    fvv: '1',
    pageHistory: '0',
  };
}
/* "Open the form in a new tab instead": the same answers, prefilled. */
const fallbackOf = (b: Record<string, string>): string => formURL(b[FORM.what], b[FORM.where], { wrong: b[FORM.wrong], link: b[FORM.link], reach: b[FORM.reach] });
export const reportFallbackURL = (r: Shelf): string => fallbackOf(reportBody(r));
/* A one-tap request (views/coverage.ts): the same five answers with nothing typed. Its own words for the
   race and for "What's wrong?", the place and ZIP, and a city request's "Sent along" list. */
export function askBody(a: Ask, along: Along): Record<string, string> {
  return {
    [FORM.what]: a.what,
    [FORM.where]: along.where,
    [FORM.wrong]: `${a.wrong}\n\nSent along:\n${alongLines({ kind: 'city', what: a.what, tag: '', along }).join('\n')}`,
    [FORM.link]: linkOf(along),
    [FORM.reach]: '',
    fvv: '1',
    pageHistory: '0',
  };
}
export const askFallbackURL = (a: Ask): string => fallbackOf(askBody(a, collectAlong()));
const altLink = (r: Shelf, text = 'Open the form in a new tab instead'): string =>
  `<a href="${esc(reportFallbackURL(r))}" target="_blank" rel="noopener" data-rp-alt>${esc(text)}</a>`;

function fieldHTML(r: Shelf, f: Field): string {
  const id = `rf-${f.k}`;
  // Read-only, not disabled, while it sends: a field you pressed Enter in keeps the focus.
  const busy = r.state === 'sending' ? ' readonly' : '';
  const val = r.f[f.k] || '';
  const bad = r.err && f.k === requiredOf(r);
  const label = f.k === 'wrong' && unreadHint(r) ? PAYWALL.label : f.label;
  const desc = [f.hint ? `${id}-h` : '', bad ? 'rf-err' : ''].filter(Boolean).join(' ');
  const attrs = `id="${id}" name="${f.k}" data-rf="${f.k}" data-fk="${id}" maxlength="${f.max}"${f.required ? ' aria-required="true"' : ''}${desc ? ` aria-describedby="${desc}"` : ''}${bad ? ' aria-invalid="true"' : ''}${f.auto ? ` autocomplete="${f.auto}"` : ''}${busy}`;
  const input = f.type === 'area' ? `<textarea ${attrs} rows="3">${esc(val)}</textarea>`
    : f.type === 'zip' ? `<input ${attrs} inputmode="numeric" pattern="[0-9]*" autocomplete="postal-code" value="${esc(val)}">`
      : `<input ${attrs} type="text" value="${esc(val)}">`;
  const err = bad ? `<p class="zip-err rp-err" id="rf-err">${f.k === 'city' ? 'Type the city first.' : f.k === 'reach' ? 'Type an email or phone first.' : f.k === 'src' ? 'Type its name or a link first.' : unreadHint(r) ? 'Paste their picks or a link first.' : 'Say what’s wrong first.'}</p>` : '';
  const opt = f.optional ? ' <span class="rp-opt">optional</span>' : '';
  if (f.fold) {
    // A folded row: its label is the button that opens it, and names the box once it shows. What's typed
    // in it is kept (and sent) while it's folded.
    const open = isOpen(PICKS_FOLD);
    const box = input.replace(`id="${id}"`, `id="${id}" aria-labelledby="${id}-b"`);
    return `<div class="rp-f rp-fold"><button type="button" class="rp-fold-b" id="${id}-b" data-act="open" data-k="${PICKS_FOLD}" data-fk="${id}-b" aria-expanded="${open}"${open ? ` aria-controls="${id}"` : ''}><b>${esc(label)}</b>${opt}<svg class="chev" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 5l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></button>
    ${open ? `${f.hint ? `<p class="rp-h" id="${id}-h">${esc(f.hint)}</p>` : ''}${box}` : ''}</div>`;
  }
  return `<div class="rp-f"><label for="${id}"><b>${esc(label)}</b>${opt}</label>
    ${f.hint ? `<p class="rp-h" id="${id}-h">${esc(f.hint)}</p>` : ''}${input}${err}</div>`;
}
/* The follow-up form: the request as a line of text, the one field, the button, and what goes along folded
   shut under it. Sent, it never shows the email or phone back (a shared phone would). */
function followHTML(r: Shelf): string {
  const f = followOf();
  if (r.state === 'sent') {
    return `<div class="rp-sent" role="status"><p><b>Got it.</b> ${esc(f.sent)}</p>
      <button class="bigbtn" data-act="sheet-close" data-fk="report-done">Done</button></div>`;
  }
  const sending = r.state === 'sending';
  const missed = r.state === 'failed' || r.state === 'unsure';
  return `<form class="rp-form" data-form="report" novalidate${sending ? ' aria-busy="true"' : ''}>
      <p class="rp-intro">${esc(f.intro)}</p>
      <p class="rp-req"><b>Your request:</b> ${esc(f.request)}</p>
      ${FOLLOW_FIELDS.map((x) => fieldHTML(r, x)).join('')}
      <p class="fine rp-fine">Goes to Kevin’s Google Form. Nothing you type here is saved in the guide.</p>
      ${missed ? `<p class="rp-fail" role="alert">${r.state === 'unsure' ? 'Couldn’t confirm it sent.' : 'That didn’t send.'} ${altLink(r)}.</p>` : ''}
      <button class="bigbtn" type="submit" data-fk="report-send"${sending ? ' aria-disabled="true"' : ''}>${esc(sending ? 'Sending...' : f.button)}</button>
      ${missed ? '' : `<p class="fine rp-alt">${altLink(r)}</p>`}
      <details class="rp-along" id="rp-along"><summary>We’ll send along</summary>
        <ul>${alongLines(r).map((l) => `<li>${esc(l)}</li>`).join('')}</ul></details>
    </form>`;
}
function formHTML(r: Shelf): string {
  if (isFollow(r)) return followHTML(r);
  if (r.state === 'sent') {
    return `<div class="rp-sent" role="status"><p><b>Sent.</b> ${r.kind === 'source' ? 'Kevin reads every one; a source usually shows up within a day.' : 'Kevin reads every one.'}</p>
      <button class="bigbtn" data-act="sheet-close" data-fk="report-done">Done</button></div>`;
  }
  const sending = r.state === 'sending';
  // Refused outright ("That didn't send.") or no answer in 15 seconds ("Couldn't confirm it sent.": it
  // may have arrived, so it doesn't say it didn't).
  const missed = r.state === 'failed' || r.state === 'unsure';
  const intro = r.kind === 'city' ? 'Tell Kevin which city to add next.' : r.kind === 'source' ? 'Tell Kevin which source to add.'
    : r.hint === 'paywall' ? PAYWALL.intro : r.hint === 'blocked' ? BLOCKED_INTRO : 'Tell Kevin what’s off. A sentence is plenty.';
  return `<form class="rp-form" data-form="report" novalidate${sending ? ' aria-busy="true"' : ''}>
      <p class="rp-intro">${esc(intro)}</p>
      ${fieldsOf(r).map((f) => fieldHTML(r, f)).join('')}
      <div class="rp-along" id="rp-along"><p><b>We’ll send along</b></p>
        <ul>${alongLines(r).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
        <p>Add anything else in your note.</p></div>
      <p class="fine rp-fine">Goes to Kevin’s Google Form. Nothing you type here is saved in the guide.</p>
      ${missed ? `<p class="rp-fail" role="alert">${r.state === 'unsure' ? 'Couldn’t confirm it sent.' : 'That didn’t send.'} ${altLink(r)}.</p>` : ''}
      <button class="bigbtn" type="submit" data-fk="report-send"${sending ? ' aria-disabled="true"' : ''}>${sending ? 'Sending...' : 'Send'}</button>
      ${missed ? '' : `<p class="fine rp-alt">${altLink(r)}</p>`}
    </form>`;
}

/* ---------- the other three openings ---------- */
/* Every place the guide covers, by state; each opens that ballot on the first page. From a ballot it
   starts over the way Change does, the ballot you leave saved and offered there (Kevin, Oct 21: "33
   cities lost its link and it should use the same shelf"). */
function citiesHTML(idx: Index): string {
  const states = Object.entries(idx.states).sort((a, b) => a[1].name.localeCompare(b[1].name));
  const onBallot = S.view === 'ballot' && !!S.ballot;
  return `<p class="sh-lede">${onBallot ? 'Pick a place to open its ballot. The one you have open stays saved.' : 'Pick a place to open its ballot.'}</p>
    <ul class="browse-list">${states.map(([st, s]) => `<li><b>${esc(s.name)}</b>
      ${s.places.map((id) => `<button class="linkbtn" data-act="choose-place" data-from="browse" data-ids="${esc(id)}">${esc(idx.places[id].label)}</button>`).join('')}
      <button class="linkbtn" data-act="choose-state" data-from="browse" data-st="${esc(st)}">${s.places.length ? 'Elsewhere in the state: statewide races only' : 'Statewide races'}</button></li>`).join('')}</ul>`;
}
/* How this guide works. "Built for family and friends", not "Kevin built this...": the foot line names
   him already (Kevin, Oct 21). "When each state was last checked" opens in place (actions.ts A.open
   repaints the sheet). */
function howHTML(): string {
  const b = S.ballot;
  const idx = S.index;
  const asOf = idx ? Object.entries(idx.states).sort((x, y) => x[1].name.localeCompare(y[1].name)) : [];
  return `<div class="how-bd"><p>Built for family and friends. It never tells you how to vote. It shows what’s on your ballot in plain words, candidates in their own words, and who endorsed whom, with a source link for every claim.</p>
    <ul class="trust-list">
      <li><b>Neutral by default.</b> Newspapers and nonpartisan guides start on. Groups and parties stay off until you turn them on.</li>
      <li><b>Lean labels.</b> Each source sits on a five-step scale from left to right, set by outside ratings, its party or its stated mission, never by whom it endorses. Tap “Why this lean” to see the basis.</li>
      <li><b>Honest gaps.</b> “Took no stand” means a source looked and chose not to endorse. “No endorsement found” means we looked and found none. “Not checked yet” means we haven’t looked. We never fill gaps to look balanced.</li>
      <li><b>Judges.</b> A review comes from the official body or bar association that wrote it, worded as their rating, not ours.</li>
      <li><b>Your privacy.</b> No accounts, no ads, no cookies. We count visits with Vercel’s cookie-free analytics (pages, rough location, device type), which never sees your address, ZIP, picks or who you are. Your picks stay on your device unless you share your save link. An address you type goes only to the Census Bureau’s lookup, and we never keep it. If the page breaks, it sends us a crash report with no address, no picks and no IP.</li>
      <li><b>Mistakes.</b> Open any race or measure and tap “Report a problem”.</li>
    </ul>
    <p class="small">“Voting is underway in every state”: ${ext('https://electioninnovation.org/research/dates-for-2026-early-in-person-and-mail-voting/', 'Center for Election Innovation & Research')}.</p>
    ${b ? `<p class="small">Official info for ${esc(b.stateName)}: ${ext(b.howto.official_site.url, b.howto.official_site.name)}${b.howto.registration.check_url ? `. Check your registration: ${ext(b.howto.registration.check_url, 'official lookup')}` : ''}.</p>` : ''}
    ${asOf.length ? `<button class="linkbtn" data-act="open" data-k="asof" data-fk="asof" aria-expanded="${isOpen('asof')}">When each state was last checked</button>${isOpen('asof') ? `<ul class="asof">${asOf.map(([, s]) => `<li>${esc(s.name)}: ${esc(s.as_of || 'unknown')}. ${ext(s.official_site.url, 'Official site')}</li>`).join('')}</ul>` : ''}` : ''}
    <p class="fine">Data built ${esc(idx ? idx.generated.slice(0, 10) : '')}. Made by ${kevinLink()}. Not affiliated with any campaign, party or government office.</p></div>`;
}
/* Support (Kevin, Oct 21: "support ... uses that shelf with buy me a coffee embedded there"): a few
   words and one button in the guide's own style. Only a link: no Buy Me a Coffee script, nothing
   third-party loads. Then the other way to help, sharing: Help friends vote when a ballot is open,
   else the guide's own link. */
function supportHTML(): string {
  return `<div class="sp"><p>The guide is free, with no ads and no cookies. It’s built for family and friends, and it stays that way.</p>
    <p>If it helped you, a coffee says thanks.</p>
    <a class="bigbtn" href="${esc(BUY_ME_A_COFFEE_URL)}" target="_blank" rel="noopener" data-fk="coffee">Buy Kevin a coffee</a>
    <p class="sp-share">Or <button class="linkbtn" data-act="shelf-share" data-fk="shelf-share">send the guide to a friend</button>.</p></div>`;
}

export function shelfHTML(): string {
  const r = S.ui.report;
  if (!r) return '';
  const form = isForm(r.kind);
  const body = form ? formHTML(r) : r.kind === 'cities' ? (S.index ? citiesHTML(S.index) : '') : r.kind === 'how' ? howHTML() : supportHTML();
  return `<div class="scrim shelf screen-only" data-act="sheet-close"></div>
  <div class="sheet-panel shelf screen-only" role="dialog" aria-modal="true" aria-labelledby="sh-h" data-kind="${r.kind}"${isFollow(r) ? ' data-hint="follow"' : ''}>
    <div class="sheet-hd"><h2 id="sh-h">${esc(isFollow(r) ? followOf().title : SHELF_TITLE[r.kind])}</h2><button class="closebtn" data-act="sheet-close" data-fk="sheet-x">${form && r.state !== 'sent' ? 'Cancel' : 'Close'}</button></div>
    <div class="sheet-bd" data-keep="shelf">${body}</div></div>`;
}
