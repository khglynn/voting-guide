/* Small render helpers shared by every view. */
import type { Endorser, Lean } from '../types';
import { S } from '../state';
import { esc, host } from '../util';
import { hasPaywallNote } from '../model/lens';

/* "Report a problem" goes to a Google Form in Kevin's personal account (picked Oct 16).
   The two entry ids prefill "Which race or measure?" (`what`) and "Where are you voting?". */
const REPORT_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSdTJFFXbh5ZlZzDmoqvbD5uGEKopuk2zy-nsl4dqmjNA65bOQ/viewform';
/* The form, prefilled, reading no state: the first page has no ballot yet. */
export function formURL(what: string, where: string): string {
  const q = new URLSearchParams({ usp: 'pp_url', 'entry.90887649': what, 'entry.628621310': where });
  return `${REPORT_URL}?${q.toString()}`;
}
export function reportURL(what: string): string {
  const b = S.ballot!;
  const where = [b.places.map((p) => p.label).join(' / ') || b.stateName, S.b.zip].filter(Boolean).join(', ');
  return formURL(what, where);
}
/* "Ask for yours" on the first page: the same form, with whatever ZIP is in the box. */
export const askCityURL = (zip: string): string => formURL('Please add my city', zip);

/* The two switches, the same words wherever they show (step 2, the Edit sheet, the menu, the rail). */
export const FILL = 'Fill in my ballot with their picks';
export const HIDE = 'Hide races I’ve decided';
/* The chip that turns every source off (step 2 and the Edit sheet); the ballot's Picks line then
   reads "No endorsements shown". */
export const NO_ENDS = 'Don’t show endorsements';

/* The credit, on the first page and at the end of "How this guide works". Buy him a coffee shows
   while this has a link. */
export const BUY_ME_A_COFFEE_URL = 'https://buymeacoffee.com/kevinhg';
export const KEVIN_URL = 'https://kevinhg.com';
export const creditHTML = (): string => ['Made by Kevin', ext(KEVIN_URL, 'kevinhg.com'), BUY_ME_A_COFFEE_URL ? ext(BUY_ME_A_COFFEE_URL, 'Buy him a coffee') : ''].filter(Boolean).join(' · ');

/* ---------- paywalled sources (Kevin, Oct 19) ----------
   A paper whose endorsements sit behind a paywall we couldn't read: the picks we only saw
   secondhand are out of the data, and a short note asks a subscriber to send a PDF or the
   picks through the report form, prefilled with the source's name. The words come from the
   copy table. */
export { hasPaywallNote };
/* The form's "Which race or measure?" line for a source's picks, so the report names the paper. */
export const reportSourceLink = (e: Endorser, where = ''): string => reportURL(`${e.name}: picks${where ? ` on ${where}` : ''} [${e.id}]`);
const PW_NOTE = 'Behind a paywall, so we couldn’t read its endorsements. Have a login? We’d love a PDF or the list.';
const PW_LINK = 'Send it to us';
/* The row's form: lower case after the source names, its or their by count. */
const PW_ROW = (n: number): string => `behind a paywall, so we couldn’t read ${n === 1 ? 'its' : 'their'} endorsements here. Have a login? We’d love a PDF or the list.`;
/* In the sources sheet, under one paywalled source. */
export function paywallSourceHTML(e: Endorser): string {
  if (!hasPaywallNote(e)) return '';
  return `<p class="pw-note">${esc(e.paywall_note || PW_NOTE)} ${ext(reportSourceLink(e), PW_LINK)}.</p>`;
}
/* In an open row, once, when chosen paywalled sources have no readable pick there. `what` is
   the row's title for the form. */
export function paywallRowHTML(list: Endorser[], what: string): string {
  const pw = list.filter(hasPaywallNote);
  if (!pw.length) return '';
  const links = pw.map((e) => ext(reportSourceLink(e, what), `${PW_LINK} (${e.short})`)).join(', ');
  return `<p class="pw-note">${esc(pw.map((e) => e.short).join(', '))}: ${esc(PW_ROW(pw.length))} ${links}.</p>`;
}

export const LEANS: Record<Lean, [number, string]> = {
  left: [0, 'left'], lean_left: [1, 'leans left'], neutral: [2, 'center'], lean_right: [3, 'leans right'], right: [4, 'right'],
};

/* The neutral five-step lean scale plus a word. Ink only, never red or blue; the middle step
   is round. "Not rated" is its own visible state, never a blank scale. */
export function leanHTML(lean: Lean | null, words = true, basis = ''): string {
  const word = lean ? LEANS[lean][1] : 'not rated';
  const idx = lean ? LEANS[lean][0] : -1;
  const cells = [0, 1, 2, 3, 4].map((i) => `<i class="${i === 2 ? 'mid' : ''}${i === idx ? ' on' : ''}"></i>`).join('');
  const lean_ = `<span class="lean${lean ? '' : ' unrated'}"><span class="ls" aria-hidden="true">${cells}</span>${words ? `<span class="lw">${word}</span>` : `<span class="vh">Lean: ${word}</span>`}</span>`;
  return basis ? `<span class="lean-b">${lean_}<span class="lk">${esc(basis)}</span></span>` : lean_;
}

/* How a lean was placed, in plain words: an outside rating names the rater, a party is a
   party, anything else is read from the group's own mission statement. Never from whom a
   source endorsed. Empty when there is no lean. */
export function basisWords(e: Endorser): string {
  if (!e.lean || !e.lean_basis_kind) return '';
  if (e.lean_basis_kind === 'party') return 'from its party';
  if (e.lean_basis_kind === 'mission') return 'from its mission statement';
  // Name the rater only when the basis names exactly one and doesn't say that rater has none
  // ("no AllSides rating found; Ad Fontes rates it..."). Otherwise stay general; the full basis
  // is one tap away in See all sources.
  const b = e.lean_basis || '';
  const named = (re: RegExp, no: RegExp) => re.test(b) && !no.test(b);
  const raters = [
    named(/AllSides/i, /\bno\s+AllSides|AllSides\s+(has|had|gives)\s+no|not\s+(rated|listed)\s+(by|on)\s+AllSides|without\s+an?\s+AllSides/i) ? 'AllSides' : '',
    named(/Ad Fontes/i, /\bno\s+Ad Fontes|Ad Fontes\s+(has|had|gives)\s+no|not\s+(rated|listed)\s+(by|on)\s+Ad Fontes|without\s+an?\s+Ad Fontes/i) ? 'Ad Fontes Media' : '',
  ].filter(Boolean);
  return raters.length === 1 ? `rated by ${raters[0]}` : 'an outside media-bias rating';
}
/* The lean scale for a source, with how it was placed beneath. */
export const sourceLean = (e: Endorser, words = true): string => {
  const k = basisWords(e);
  return leanHTML(e.lean, words, k);
};

export const confLabel = (c: string | null | undefined): string =>
  c === 'unverified' ? 'Not yet confirmed' : c === 'sourced' ? 'Secondhand source' : '';

export const ext = (url: string | null | undefined, text: string, cls = ''): string =>
  url ? `<a href="${esc(url)}" target="_blank" rel="noopener"${cls ? ` class="${cls}"` : ''}>${esc(text)}</a>` : esc(text);

export const srcLink = (url: string | null | undefined): string =>
  url ? `<a class="src" href="${esc(url)}" target="_blank" rel="noopener">${esc(host(url))}</a>` : '';

/* The official place to see your exact ballot: the place file's lookup, then the state file's
   own sample_ballot_url, then any state source named like a sample ballot, then the state's
   registration lookup. */
export function sampleBallot(): { url: string; label: string } | null {
  const b = S.ballot;
  if (!b) return null;
  const p = b.places.find((x) => x.sample_ballot_url);
  if (p && p.sample_ballot_url) return { url: p.sample_ballot_url, label: 'See your official sample ballot' };
  if (b.howto.sample_ballot_url) return { url: b.howto.sample_ballot_url, label: 'See official sample ballots' };
  const src = b.howto.sources.find((s) => /sample ballot/i.test(s.name));
  if (src) return { url: src.url, label: 'See official sample ballots' };
  const look = b.howto.sources.find((s) => /voter lookup|my voter|myvote|voterview|my vote/i.test(s.name));
  if (look) return { url: look.url, label: `Look up your ballot (${host(look.url)})` };
  if (b.howto.registration.check_url) return { url: b.howto.registration.check_url, label: `Your official voter lookup (${host(b.howto.registration.check_url)})` };
  return { url: b.howto.official_site.url, label: b.howto.official_site.name };
}

/* Disclosures: the key lives in S.ui.open. */
export const isOpen = (k: string): boolean => S.ui.open.has(k);

/* ---------- no shouting ----------
   Research notes sometimes stress a word in capitals ("must be RECEIVED", "NOT in the
   district"). Kevin asked for no all caps, so those words show in lower case. Acronyms
   (USPS, DCBOE) stay, and anything inside quotation marks stays word for word, because
   quoted ballot language is printed in capitals on purpose. */
const SHOUT = new Set(('NOT ONE TWO THREE ANY YOUR ONLY MORE LESS AFTER BEFORE NOON RECEIVED ARRIVE ARRIVES POSTMARKED ' +
  'WITH NEW EVERY SIGN AND DATE MONDAY TUESDAY OCTOBER NOVEMBER PROVISIONAL APPLICATION BALLOT VOTE CENTER COUNTIES ' +
  'POLLING PLACE EVERYTHING ELSE REPEALS NOTE HAVE IMPORTANT EARLY MAIL ABSENTEE MEETS PERFORMANCE STANDARDS NEVER ' +
  'MUST CANNOT DOES WILL SUNDAY BOTH EITHER NEITHER ALSO LEGALIZED WEAR CAMPAIGN BUTTONS YES NO FOR AGAINST ' +
  'REACH WITHOUT FIRST EXPIRED REQUEST NOTARIZED AFFIDAVIT MINIMUM CONFIRMED DATES').split(' '));
/* Place names written in capitals for emphasis take title case, never lower case. */
const PROPER = new Set('ORANGE LEON ESCAMBIA CHICAGO SUBURBAN COOK COLLAR'.split(' '));
const QUOTED = /“[^”]*”|"[^"]*"|(^|[\s(])('[^']*')(?=[\s.,;:)!?]|$)/g;
/* "NO" naming the vote before a word for a stance stays as written: "Explicit NO recommendation"
   is a recommendation to vote no, and "no recommendation" would say there was none. */
const NO_STANCE = /^\s+(?:recommendations?|positions?|endorsements?|stands?|stances?|picks?|choices?|opinions?)\b/i;
export function deshout(text: string): string {
  // NO is the one two-letter word on the list ("A NO vote means..."), so it needs its own check.
  if (!text || !/[A-Z]{3}|\bNO\b/.test(text)) return text;
  const fix = (seg: string, atStart: boolean) => seg.replace(/\b[A-Z]{2,}\b/g, (w, i: number) => {
    if ((!SHOUT.has(w) && !PROPER.has(w)) || seg[i - 1] === '-' || seg[i + w.length] === '-') return w;
    if (w === 'NO' && NO_STANCE.test(seg.slice(i + 2))) return w;
    const lower = w.toLowerCase();
    if (PROPER.has(w)) return lower.charAt(0).toUpperCase() + lower.slice(1);
    const before = seg.slice(0, i);
    const start = (atStart && /^\s*$/.test(before)) || /[.!?:]\s+$/.test(before);
    return start ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
  });
  let out = '';
  let last = 0;
  for (const m of text.matchAll(QUOTED)) {
    const at = m.index! + (m[2] ? m[1].length : 0);
    const q = m[2] || m[0];
    out += fix(text.slice(last, at), last === 0) + q;
    last = at + q.length;
  }
  return out + fix(text.slice(last), last === 0);
}
export const escP = (s: string | null | undefined): string => esc(deshout(s || ''));

/* ---------- skimmable prose ----------
   Long research prose is split for display only: into sentences, into a lead plus "More",
   or into bullets. Nothing is reworded, so every fact, date and URL stays as written. */
const ABBR = /(?:\b(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec|Mon|Tues?|Wed|Thur?s?|Fri|Sat|Sun|St|Ave|Blvd|Rd|Dr|Hwy|Ste|Bldg|No|Nos|Pct|Mr|Mrs|Ms|Jr|Sr|Inc|Co|Corp|Dept|vs|approx|Gov|Sen|Rep|Lt|Ft|Mt|Gen|Prof|Hon|Rev|Art|Sec|Ch|Stat|Rev|Reg)\.|(?:^|[\s(])[A-Z]\.|\b(?:e\.g|i\.e|a\.m|p\.m|U\.S)\.)$/;
export function sentences(text: string): string[] {
  const s = String(text || '').trim();
  if (!s) return [];
  const parts = s.replace(/([.!?][)"”’']?)\s+(?=[A-Z0-9"“‘(])/g, '$1\u0000').split('\u0000');
  const out: string[] = [];
  for (const p of parts) {
    if (out.length && ABBR.test(out[out.length - 1])) out[out.length - 1] += ` ${p}`;
    else out.push(p);
  }
  return out;
}
export const wordCount = (s: string | null | undefined): number => (s ? s.trim().split(/\s+/).filter(Boolean).length : 0);

/* The first sentence or two (up to `max` words), and the rest. */
export function leadRest(text: string, max = 30): [string, string] {
  const ss = sentences(text);
  if (!ss.length) return ['', ''];
  let n = wordCount(ss[0]);
  let i = 1;
  while (i < ss.length && n + wordCount(ss[i]) <= max) { n += wordCount(ss[i]); i++; }
  return [ss.slice(0, i).join(' '), ss.slice(i).join(' ')];
}

/* A paragraph that shows its lead and tucks the rest behind an inline "More". */
export function clampP(key: string, text: string | null | undefined, max = 30, cls = ''): string {
  if (!text) return '';
  const [lead, rest] = leadRest(text, max);
  const c = cls ? ` class="${cls}"` : '';
  if (!rest) return `<p${c}>${escP(text)}</p>`;
  const open = isOpen(key);
  return `<p${c}>${escP(lead)}${open ? ` ${escP(rest)}` : ''} <button class="more" data-act="open" data-k="${esc(key)}" aria-expanded="${open}">${open ? 'Less' : 'More'}</button></p>`;
}

/* One sentence per bullet. A sentence like "You qualify if you: a; b; or c." becomes an
   intro with its own sub-list. With `lead`, each bullet's first sentence is bold. */
function listify(s: string): string {
  const m = s.match(/^(.{0,160}?):\s+(.+)$/);
  if (m) {
    const segs = m[2].split(/;\s+/);
    if (segs.length >= 3) return `${escP(m[1])}:<ul>${segs.map((x) => `<li>${escP(x.replace(/;$/, ''))}</li>`).join('')}</ul>`;
  }
  return escP(s);
}
export function bulletsHTML(text: string | null | undefined, cls = 'bul'): string {
  const ss = sentences(text || '');
  if (!ss.length) return '';
  return `<ul class="${cls}">${ss.map((s) => `<li>${listify(s)}</li>`).join('')}</ul>`;
}
export function leadBulletsHTML(items: string[], cls = 'bul bul-lead'): string {
  if (!items.length) return '';
  return `<ul class="${cls}">${items.map((t) => {
    const ss = sentences(t);
    return `<li><strong>${escP(ss[0] || t)}</strong>${ss.length > 1 ? ` <span class="bul-rest">${escP(ss.slice(1).join(' '))}</span>` : ''}</li>`;
  }).join('')}</ul>`;
}

/* Each phone number in a string like "512-238-VOTE (8683)" becomes a tel: link. */
const KEYPAD: Record<string, string> = { A: '2', B: '2', C: '2', D: '3', E: '3', F: '3', G: '4', H: '4', I: '4', J: '5', K: '5', L: '5', M: '6', N: '6', O: '6', P: '7', Q: '7', R: '7', S: '7', T: '8', U: '8', V: '8', W: '9', X: '9', Y: '9', Z: '9' };
const PHONE_RE = /(?:\+?1[-\s.]?)?\(?\d{3}\)?[-\s.]?\d{3}[-\s.]?[0-9A-Z]{4}(?:\s\(\d{4}\))?/g;
export function telHTML(phone: string | null | undefined): string {
  if (!phone) return '';
  let out = '';
  let last = 0;
  for (const m of phone.matchAll(PHONE_RE)) {
    const digits = m[0].replace(/\s\(\d{4}\)$/, '').replace(/[A-Z]/g, (c) => KEYPAD[c] || '').replace(/\D/g, '');
    out += esc(phone.slice(last, m.index)) + `<a href="tel:${digits}">${esc(m[0])}</a>`;
    last = m.index! + m[0].length;
  }
  return `<span class="phone">${out}${esc(phone.slice(last))}</span>`;
}
