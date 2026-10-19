/* "How this guide works": the promises, in plain words. */
import { S } from '../state';
import { esc } from '../util';
import { ext, isOpen } from './common';

export function trustHTML(): string {
  const b = S.ballot;
  const idx = S.index;
  const asOf = idx ? Object.entries(idx.states).sort((x, y) => x[1].name.localeCompare(y[1].name)) : [];
  return `<section class="trust wrap" id="how" aria-labelledby="how-h">
    <h2 id="how-h">How this guide works</h2>
    <p>Kevin built this for friends and family. It never tells you how to vote. It shows what’s on your ballot in plain words, candidates in their own words, and who endorsed whom, with a source link for every claim.</p>
    <ul class="trust-list">
      <li><b>Neutral by default.</b> Newspapers and nonpartisan guides start on. Groups and parties stay off until you turn them on under “Show endorsements from”.</li>
      <li><b>Lean labels.</b> Each source sits on a five-step scale from left to right, set by outside ratings, its party or its stated mission, never by whom it endorses. Tap “Why this lean” to see the basis.</li>
      <li><b>Honest gaps.</b> “Took no stand” means a source looked and chose not to endorse. “No endorsement found” means we looked and found none. “Not checked yet” means we haven’t looked. We never fill gaps to look balanced.</li>
      <li><b>Judges.</b> A review comes from the official body or bar association that wrote it, worded as their rating, not ours.</li>
      <li><b>Your privacy.</b> No accounts, no ads, no tracking. Your picks stay on your device unless you share your save link. An address you type goes only to the Census Bureau’s lookup, and we never keep it.</li>
      <li><b>Mistakes.</b> Open any race or measure and tap “Report a problem”.</li>
    </ul>
    ${b ? `<p class="small">Official info for ${esc(b.stateName)}: ${ext(b.howto.official_site.url, b.howto.official_site.name)}${b.howto.registration.check_url ? `. Check your registration: ${ext(b.howto.registration.check_url, 'official lookup')}` : ''}.</p>` : ''}
    ${asOf.length ? `<button class="linkbtn" data-act="open" data-k="asof" aria-expanded="${isOpen('asof')}">When each state was last checked</button>${isOpen('asof') ? `<ul class="asof">${asOf.map(([, s]) => `<li>${esc(s.name)}: ${esc(s.as_of || 'unknown')}. ${ext(s.official_site.url, 'Official site')}</li>`).join('')}</ul>` : ''}` : ''}
    <p class="fine">Data built ${esc(idx ? idx.generated.slice(0, 10) : '')}. Not affiliated with any campaign, party or government office.</p>
  </section>`;
}
