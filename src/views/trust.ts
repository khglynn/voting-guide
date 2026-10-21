/* The foot of every page, the same wherever you are (Kevin, Oct 21): "How this guide works" (the
   promises, in plain words) and "Report a problem or request a city" (the report form, one tap
   away), each folded to one row (Kevin, Oct 20: "long winded and takes up too much space"), then
   the credit. The rows open in place. On the ballot and My plan the block is its own region
   (#r-trust); on the share page it sits above the crowd (pass.ts); on the first page the How row
   sits over the page's own small print, which already asks for your city (mast.ts). */
import { S } from '../state';
import { esc } from '../util';
import { ext, isOpen, creditHTML, reportURL, formURL, askCityURL } from './common';

export const HOW_K = 'how';
export const HELP_K = 'help';
const CHEV = '<svg class="chev" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 5l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
/* One folded row: its heading is the button; its body (#<k>-bd) shows while open. actions.ts
   toggleFold grows and folds it. */
const rowHTML = (k: string, label: string): string =>
  `<h2 class="how-h" id="${k}-h"><button class="how-tog" data-act="open" data-k="${k}" aria-expanded="${isOpen(k)}" data-fk="${k}"><span>${label}</span>${CHEV}</button></h2>`;
export const howRowHTML = (): string => `${rowHTML(HOW_K, 'How this guide works')}${isOpen(HOW_K) ? `<div class="how-bd" id="how-bd">${howBodyHTML()}</div>` : ''}`;
export const helpRowHTML = (): string => `${rowHTML(HELP_K, 'Report a problem or request a city')}${isOpen(HELP_K) ? `<div class="how-bd help-bd" id="help-bd">${helpBodyHTML()}</div>` : ''}`;

export function trustHTML(): string {
  return `<section class="trust wrap" id="how" aria-label="About this guide">
    ${howRowHTML()}
    ${helpRowHTML()}
    <p class="fine how-credit">${creditHTML()}</p>
  </section>`;
}
function howBodyHTML(): string {
  const b = S.ballot;
  const idx = S.index;
  const asOf = idx ? Object.entries(idx.states).sort((x, y) => x[1].name.localeCompare(y[1].name)) : [];
  return `<p>Kevin built this for friends and family. It never tells you how to vote. It shows what’s on your ballot in plain words, candidates in their own words, and who endorsed whom, with a source link for every claim.</p>
    <ul class="trust-list">
      <li><b>Neutral by default.</b> Newspapers and nonpartisan guides start on. Groups and parties stay off until you turn them on.</li>
      <li><b>Lean labels.</b> Each source sits on a five-step scale from left to right, set by outside ratings, its party or its stated mission, never by whom it endorses. Tap “Why this lean” to see the basis.</li>
      <li><b>Honest gaps.</b> “Took no stand” means a source looked and chose not to endorse. “No endorsement found” means we looked and found none. “Not checked yet” means we haven’t looked. We never fill gaps to look balanced.</li>
      <li><b>Judges.</b> A review comes from the official body or bar association that wrote it, worded as their rating, not ours.</li>
      <li><b>Your privacy.</b> No accounts, no ads, no tracking. Your picks stay on your device unless you share your save link. An address you type goes only to the Census Bureau’s lookup, and we never keep it.</li>
      <li><b>Mistakes.</b> Open any race or measure and tap “Report a problem”, or use the row below.</li>
    </ul>
    <p class="small">“Voting is underway in every state”: ${ext('https://electioninnovation.org/research/dates-for-2026-early-in-person-and-mail-voting/', 'Center for Election Innovation & Research')}.</p>
    ${b ? `<p class="small">Official info for ${esc(b.stateName)}: ${ext(b.howto.official_site.url, b.howto.official_site.name)}${b.howto.registration.check_url ? `. Check your registration: ${ext(b.howto.registration.check_url, 'official lookup')}` : ''}.</p>` : ''}
    ${asOf.length ? `<button class="linkbtn" data-act="open" data-k="asof" aria-expanded="${isOpen('asof')}">When each state was last checked</button>${isOpen('asof') ? `<ul class="asof">${asOf.map(([, s]) => `<li>${esc(s.name)}: ${esc(s.as_of || 'unknown')}. ${ext(s.official_site.url, 'Official site')}</li>`).join('')}</ul>` : ''}` : ''}
    <p class="fine">Data built ${esc(idx ? idx.generated.slice(0, 10) : '')}. Not affiliated with any campaign, party or government office.</p>`;
}
/* The report form, prefilled with the page you're on (a race's own "Report a problem" names the
   race) and the ballot's place, and the same form for a city we don't cover yet. */
function helpBodyHTML(): string {
  const b = S.ballot;
  const page = S.ui.view === 'cheat' ? 'My plan page' : S.ui.view === 'pass' ? 'Help friends vote page' : 'The ballot page';
  const report = b ? reportURL(page) : formURL('First page', S.zip);
  const ask = askCityURL(b ? S.b.zip : S.zip);
  return `<p>A wrong fact, a broken link, a missing race, or a city you’d like added: tell Kevin. The form takes a minute and goes straight to him.</p>
    <div class="row-btns"><a class="mini dark" href="${esc(report)}" target="_blank" rel="noopener" data-fk="help-report">Report a problem</a><a class="mini" href="${esc(ask)}" target="_blank" rel="noopener" data-fk="help-city">Request a city</a></div>`;
}
