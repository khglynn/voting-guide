/* The foot of every page, two quiet lines, the same wherever you are (Kevin, Oct 21: the first
   cut had two heavy rows and a first page that differed; "less loud", one design): how many
   cities and whose friends, with the coffee; then "How this guide works" (its text opens below,
   folded), "Report a problem" (the report sheet, views/report.ts, prefilled with the page and the
   place) and "Request a city" (the same sheet, asking for a city). On the ballot and My plan the
   foot is its own region (#r-trust); on the share page it sits above the crowd (pass.ts); on the
   first page it is the small print under the pad (mast.ts), where the city count also opens the
   list of places. */
import type { Index } from '../types';
import { S } from '../state';
import { esc } from '../util';
import { ext, isOpen, kevinLink, coffeeLink, reportAttrs } from './common';

export const HOW_K = 'how';
const BROWSE_K = 'browse';

/* How many cities the guide covers: each place counts once, except that DC's wards are one city
   and New York City's boroughs are one. */
export function cityCount(idx: Pick<Index, 'places'>): number {
  return new Set(Object.entries(idx.places).map(([id, p]) => (p.state === 'DC' ? 'DC' : /^nyc-/.test(id) ? 'NYC' : id))).size;
}

export function trustHTML(inDoor = false): string {
  const idx = S.index;
  const n = idx ? cityCount(idx) : 0;
  // The city count opens the list of places on the first page, where a new ballot starts; on a ballot
  // it is plain text (a place picked there would start over at the first page, as Change does).
  const count = `${n} ${n === 1 ? 'city' : 'cities'}`;
  const cover = idx ? `Covers ${inDoor ? `<button class="linkbtn" data-act="open" data-k="${BROWSE_K}" aria-expanded="${isOpen(BROWSE_K)}" data-fk="browse">${count}</button>` : count} where ${kevinLink()}’s friends live.` : '';
  // The first page names itself even once a ZIP has loaded its ballot for the place line.
  const page = inDoor ? 'First page' : S.ui.view === 'cheat' ? 'My plan page' : S.ui.view === 'pass' ? 'Help friends vote page' : 'The ballot page';
  const links = [
    `<button class="linkbtn" id="how-h" data-act="open" data-k="${HOW_K}" aria-expanded="${isOpen(HOW_K)}" data-fk="how">How this guide works</button>`,
    `<button class="linkbtn" ${reportAttrs({ what: page, fk: 'help-report' })}>Report a problem</button>`,
    `<button class="linkbtn" ${reportAttrs({ city: true, fk: 'help-city' })}>Request a city</button>`,
  ].join(' · ');
  // Two lines (Kevin, Oct 21): who it's for and the coffee, then the three things you can do.
  return `<footer class="trust${inDoor ? '' : ' wrap'}" id="how"><p class="fine foot-line">${[cover, coffeeLink() ? `${coffeeLink()}.` : ''].filter(Boolean).join(' ')}</p>
    <p class="fine foot-line foot-acts">${links}</p>
    ${inDoor && idx && isOpen(BROWSE_K) ? browseHTML(idx) : ''}
    ${isOpen(HOW_K) ? `<div class="how-bd" id="how-bd">${howBodyHTML()}</div>` : ''}
  </footer>`;
}
/* Every place the guide covers, by state; each opens that ballot. */
function browseHTML(idx: Index): string {
  const states = Object.entries(idx.states).sort((a, b) => a[1].name.localeCompare(b[1].name));
  return `<ul class="browse-list">${states.map(([st, s]) => `<li><b>${esc(s.name)}</b>
      ${s.places.map((id) => `<button class="linkbtn" data-act="choose-place" data-from="browse" data-ids="${esc(id)}">${esc(idx.places[id].label)}</button>`).join('')}
      <button class="linkbtn" data-act="choose-state" data-from="browse" data-st="${esc(st)}">${s.places.length ? 'Elsewhere in the state: statewide races only' : 'Statewide races'}</button></li>`).join('')}</ul>`;
}
function howBodyHTML(): string {
  const b = S.ballot;
  const idx = S.index;
  const asOf = idx ? Object.entries(idx.states).sort((x, y) => x[1].name.localeCompare(y[1].name)) : [];
  // "Built for family and friends", not "Kevin built this...": the foot line right above it names him
  // already (Kevin, Oct 21).
  return `<p>Built for family and friends. It never tells you how to vote. It shows what’s on your ballot in plain words, candidates in their own words, and who endorsed whom, with a source link for every claim.</p>
    <ul class="trust-list">
      <li><b>Neutral by default.</b> Newspapers and nonpartisan guides start on. Groups and parties stay off until you turn them on.</li>
      <li><b>Lean labels.</b> Each source sits on a five-step scale from left to right, set by outside ratings, its party or its stated mission, never by whom it endorses. Tap “Why this lean” to see the basis.</li>
      <li><b>Honest gaps.</b> “Took no stand” means a source looked and chose not to endorse. “No endorsement found” means we looked and found none. “Not checked yet” means we haven’t looked. We never fill gaps to look balanced.</li>
      <li><b>Judges.</b> A review comes from the official body or bar association that wrote it, worded as their rating, not ours.</li>
      <li><b>Your privacy.</b> No accounts, no ads, no tracking. Your picks stay on your device unless you share your save link. An address you type goes only to the Census Bureau’s lookup, and we never keep it.</li>
      <li><b>Mistakes.</b> Open any race or measure and tap “Report a problem”.</li>
    </ul>
    <p class="small">“Voting is underway in every state”: ${ext('https://electioninnovation.org/research/dates-for-2026-early-in-person-and-mail-voting/', 'Center for Election Innovation & Research')}.</p>
    ${b ? `<p class="small">Official info for ${esc(b.stateName)}: ${ext(b.howto.official_site.url, b.howto.official_site.name)}${b.howto.registration.check_url ? `. Check your registration: ${ext(b.howto.registration.check_url, 'official lookup')}` : ''}.</p>` : ''}
    ${asOf.length ? `<button class="linkbtn" data-act="open" data-k="asof" aria-expanded="${isOpen('asof')}">When each state was last checked</button>${isOpen('asof') ? `<ul class="asof">${asOf.map(([, s]) => `<li>${esc(s.name)}: ${esc(s.as_of || 'unknown')}. ${ext(s.official_site.url, 'Official site')}</li>`).join('')}</ul>` : ''}` : ''}
    <p class="fine">Data built ${esc(idx ? idx.generated.slice(0, 10) : '')}. Made by ${kevinLink()}. Not affiliated with any campaign, party or government office.</p>`;
}
