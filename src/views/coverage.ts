/* How covered your ballot is (model/coverage.ts), from the copy pass after Kevin's phone test (Oct 25:
   "It reads as a standard header, not a callout that you should wait ... It's especially confusing
   because there ARE endorsements"; spec: claude-plans/2026-10-21-third-pass/coverage-copy-pass.md).
   - One gold coverage card per screen, in the place slot: under the place line in step 1 on the first
     page (mast.ts whereHTML), under the masthead on the ballot page (mast.ts restoreHTML). It leads
     with what's missing, says what's here, and owns the screen's one action: "Ask Kevin to add my
     city", "Ask Kevin to look for local picks". After the tap it keeps its slot and its gold, leads
     with a tick and "Request sent.", and offers "Tell me when it's in". A thin place we already looked
     hard for (Oct 29) gets no ask: the card says we looked, when and where, and where its picks come from.
   - Everywhere else a quiet line with no button, in the same nouns with the same date: at the top of the
     sources sheet (lens.ts), under the ballot's "Endorsements: ... Edit" (ledger.ts). Step 2 and the Edit
     sheet say only "Pick a group above, or choose individual sources" (setup.ts; Kevin, Oct 28: the two
     lines there were "repetative").
   Never "minutes": the pipeline runs scouts, a judge and Kevin's review, so "about a day" is honest. */
import { S } from '../state';
import { andList, esc, fmtDate, plural } from '../util';
import { ballotCoverage, askedWord, type Cov } from '../model/coverage';
import { noEndorsements } from '../model/lens';
import { shelfAttrs, reportAttrs, sampleBallot } from './common';
import { askFallbackURL } from './shelf';

export const covOf = (): Cov | null => (S.ballot && S.index ? ballotCoverage(S.ballot, S.index, S.b.zip, undefined, Array.isArray(S.b.away) ? S.b.away : []) : null);

const day = (iso: string): string => fmtDate(iso, { weekday: false });
// After "We looked hard on Oct 29." the same day once is enough.
const when = (c: Cov): string => (c.checked && c.checked !== c.searched?.on ? ` Last checked ${day(c.checked)}.` : '');
const withWord = (c: Cov): string => (c.withPicks === 0 ? 'none with picks' : c.withPicks === c.sources ? 'all with picks' : `${c.withPicks} with picks`);
/* The ballot head's count opens "Every source on your ballot" right where it is (Kevin, Oct 25: "show a count
   and a way to expand to see all sources and then individually check and uncheck within that list"). It stays
   a quiet link in the count's own words ("24 sources"), so the line still carries no action button. In the
   sheet itself the count is just words. */
const count = (c: Cov, fk: string | null): string => (!c.sources ? '<span class="cov-n">No sources</span>' : fk
  ? `<button class="linkbtn cov-n" data-act="sheet" data-s="sources" aria-haspopup="dialog" data-fk="${fk}">${esc(plural(c.sources, 'source'))}</button>`
  : esc(plural(c.sources, 'source')));
const lookedTail = (c: Cov): string => (c.searched ? ` We looked hard on ${day(c.searched.on)}.` : '');
const askedTail = (c: Cov): string => (c.state === 'asked' ? ` You asked for ${c.kind === 'thin' ? 'local picks' : 'your city’s races'} ${askedWord(c.askedOn)}.` : '');

/* ---------- the card ---------- */
/* A statewide ballot always gets the card (missing races matter with endorsements on or off); a thin
   place only while endorsements show (it is only about picks). Covered places never do. */
export const cardShows = (c: Cov | null): c is Cov => !!c && (c.kind === 'statewide' || (c.kind === 'thin' && !noEndorsements()));
/* The card's button is the screen's dark one until the request is sent: the address box's buttons are
   outlines meanwhile (ledger.ts). A place we already looked hard for has nothing to ask. */
export const cardAsks = (c: Cov | null): boolean => cardShows(c) && c.state !== 'asked' && !c.searched;

/* The one-tap button, its "Sending..." while the post is out, and what a failed send offers. */
export function askBtn(label: string, cls: string): string {
  const busy = S.ui.covAsk === 'sending';
  return `<button class="${cls}" data-act="cov-ask" data-fk="cov-ask"${busy ? ' aria-disabled="true"' : ''}>${esc(busy ? 'Sending...' : label)}</button>`;
}
export function askFailHTML(c: Cov): string {
  const f = S.ui.covAsk;
  if (!c.ask || (f !== 'failed' && f !== 'unsure')) return '';
  return `<p class="rp-fail" role="alert">${f === 'unsure' ? 'Couldn’t confirm it sent.' : 'That didn’t send.'} <a href="${esc(askFallbackURL(c.ask))}" target="_blank" rel="noopener" data-rp-alt>Open the form in a new tab instead</a>.</p>`;
}
/* "Tell me when it's in" (a statewide ballot) or "Tell me what he finds" (a thin place): the shelf's
   follow-up form, the request shown as text, an email or phone the one thing to type (shelf.ts). */
export const hearLabel = (c: Cov): string => (c.kind === 'thin' ? 'Tell me what he finds' : 'Tell me when it’s in');
export const hearBtn = (c: Cov, cls = 'mini', fk = 'cov-hear'): string =>
  `<button class="${cls}" ${shelfAttrs({ kind: 'city', hint: 'follow', fk })}>${esc(hearLabel(c))}</button>`;

const TICK = '<svg class="cov-tick" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M2 6.3l2.6 2.6L10 3.3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
const lead = (text: string, tick = false): string => `<p class="cov-lead" id="cov-h" tabindex="-1" data-fk="cov-lead">${tick ? TICK : ''}<b>${esc(text)}</b></p>`;
const line = (cls: string, html: string): string => `<p class="${cls}">${html}</p>`;
const row = (html: string): string => `<div class="row-btns">${html}</div>`;
const gapLine = (c: Cov): string => {
  const gap = c.localRaces - c.localRacesWithPicks;
  return `${gap} of your ${c.localRaces} local races ${gap === 1 ? 'has' : 'have'} no picks from anyone.`;
};

/* `where`: the first page's step 1, or the ballot page under the masthead. There a shared link's
   question or "Welcome back" may sit above it; its dark button goes first, and the card's is an
   outline until that is answered, so the slot never holds two dark buttons. */
export function covCardHTML(where: 'door' | 'ballot'): string {
  const c = covOf();
  if (!cardShows(c)) return '';
  const statewide = c.kind === 'statewide';
  const dark = where === 'ballot' && (!!S.pending || S.ui.resume) ? 'mini' : 'mini dark';
  const sb = sampleBallot();
  const sbLine = sb ? line('cov-sb', `Voting before then? Your <a href="${esc(sb.url)}" target="_blank" rel="noopener">official sample ballot</a> lists every race.`) : '';
  const name = esc(c.name);
  let body: string;
  if (c.state === 'landed') {
    body = lead('Your city is in the guide now.') + line('cov-here', `This page still shows ${name}’s statewide races only.`)
      + row(`<button class="${dark}" data-act="change-place" data-fk="cov-open">Open my city’s ballot</button>`);
  } else if (c.state === 'asked') {
    const on = askedWord(c.askedOn);
    body = statewide
      ? lead('Request sent. Kevin is adding your city.', true)
        + line('cov-here', esc(c.late ? `You asked ${on}. It may not be in before you vote.` : `You asked ${on}. It usually takes about a day${on === 'today' ? ', so check back tomorrow' : ''}.`))
        + line('cov-miss', 'Until then, you can pick your statewide races below.') + sbLine + row(hearBtn(c))
      : lead(`Request sent. Kevin is looking for ${c.name}’s local picks.`, true)
        + line('cov-here', esc(c.late ? `You asked ${on}. He may not finish before you vote.` : `You asked ${on}. It usually takes about a day. He may not find any, since some groups don’t endorse.`))
        + line('cov-miss', 'Your ballot works now. Any local picks he finds will show up here.') + row(hearBtn(c));
  } else if (statewide && c.shared) {
    // A ZIP split with a town the guide doesn't cover, the voter not sure which side: the statewide races fit
    // both, and the address settles it (app.ts useMatch moves a City address to the City's ballot).
    body = lead(`${c.zip} is split between ${c.shared.place} and ${c.shared.outside}.`)
      + line('cov-here', `Here now: ${name}’s statewide races, the same for both${noEndorsements() ? '' : `, with picks from ${c.withPicks} of ${c.sources} sources`}.`)
      + line('cov-miss', `Live in ${esc(c.shared.place)}? Use your address and we’ll open its ballot.`)
      + row(`<button class="${dark}" data-act="addr-open" data-fk="cov-addr">Use my address</button>`) + sbLine;
  } else if (statewide) {
    const action = c.ask
      ? row(askBtn('Ask Kevin to add my city', dark)) + askFailHTML(c)
        + line('fine cov-fine', c.late ? 'One tap. It sends Kevin your ZIP and nothing about you. Kevin may not get to it before Election Day.' : 'One tap. It sends Kevin your ZIP and nothing about you. It usually takes about a day.')
      // Picked from the list, so no ZIP is known: the city is typed in Request a city.
      : row(`<button class="${dark}" ${reportAttrs({ city: true, fk: 'cov-city' })}>Ask for my city</button>`) + line('fine cov-fine', 'Tell Kevin your city and he’ll add it, usually within a day.');
    body = lead('Your city’s races aren’t in the guide yet.')
      + line('cov-here', `Here now: ${name}’s statewide races${noEndorsements() ? '' : `, with picks from ${c.withPicks} of ${c.sources} sources`}.`)
      + line('cov-miss', 'Not here yet: races for your city, county and districts.') + action + sbLine;
  } else if (c.searched) {
    // We already looked hard (model/coverage.ts): say when and where, with nothing to ask for. Someone who
    // knows a local group's picks can still send them.
    const w = c.searched.where.map(esc);
    const checked = w.length > 4 ? `${w.slice(0, 3).join(', ')} and ${w.length - 3} more` : andList(w);
    body = lead(`We looked hard for ${c.name}’s local picks.`)
      + line('cov-here', `On ${esc(day(c.searched.on))} we checked ${checked}. None of them had picks we could find.`)
      + line('cov-miss', `The picks here come from newspapers and groups across ${esc(c.stateName)}. ${gapLine(c)}`)
      + line('fine cov-fine', `Know a local paper or group with picks? <button class="linkbtn" ${shelfAttrs({ kind: 'source', fk: 'cov-add' })}>Add a source</button>`);
  } else {
    body = lead(`${c.name}’s local picks aren’t in yet.`)
      + line('cov-here', `Here now: every race on your ballot, with picks from newspapers and groups across ${esc(c.stateName)}.`)
      + line('cov-miss', `Not here yet: picks from ${name}’s own paper and groups. ${gapLine(c)}`)
      + row(askBtn('Ask Kevin to look for local picks', dark)) + askFailHTML(c)
      + line('fine cov-fine', c.late ? 'One tap. It sends Kevin the place and nothing about you. He may not finish before Election Day.' : 'One tap. It sends Kevin the place and nothing about you. He’ll look within about a day.');
  }
  // After the tap the card says so to a screen reader too (focus goes to its lead: actions.ts A['cov-ask']).
  return `<div class="notice strong cov-card${statewide ? ' statewide-note' : ''}${where === 'ballot' ? ' wrap' : ''}" role="${c.state === 'asked' ? 'status' : 'region'}" aria-labelledby="cov-h">${body}</div>`;
}

/* ---------- the quiet lines ---------- */
/* The top of the sources sheet (Kevin, Oct 28: "we can put last checked inside the shelf"): how many sources
   the ballot has and how many picked, scoped ("on Chicago's ballot", "statewide races"), a thin place's
   missing picks, the date, and a request sent from here. */
export function sheetCovHTML(): string {
  const c = covOf();
  if (!c) return '';
  const name = esc(c.name);
  const n = count(c, null);
  const t = c.kind === 'statewide' ? `${n} for ${name}’s statewide races, ${esc(withWord(c))}.`
    : c.kind === 'thin' ? `${n}, ${esc(withWord(c))}, none from ${name}’s own paper and groups.${esc(lookedTail(c))}`
      : `${n} on ${c.single ? `${name}’s ballot` : 'your ballot'}, ${esc(withWord(c))}.`;
  return `<p class="s-cov">${t}${esc(when(c))}${esc(askedTail(c))}</p>`;
}
/* Under the ballot's picks line: the same, for the ballot you're looking at. */
export function headCovHTML(): string {
  const c = covOf();
  if (!c) return '';
  const n = count(c, 'hd-src');
  const t = c.kind === 'statewide' ? `Statewide races only: ${n}, ${esc(withWord(c))}.`
    : c.kind === 'thin' ? `${n}, ${esc(withWord(c))}, none from ${esc(c.name)}’s own paper and groups.${esc(lookedTail(c))}`
      : `${n} on your ballot, ${esc(withWord(c))}.`;
  return `<p class="picks-cov">${t}${esc(when(c) + askedTail(c))}</p>`;
}
