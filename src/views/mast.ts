/* The front door (ZIP, the place question, browse, not covered) and the ballot masthead:
   a forwarded friend must know in five seconds whose ballot this is and how to change it. */
import type { Index } from '../types';
import { S } from '../state';
import { esc, fmtDate, todayISO } from '../util';
import { ext, isOpen, askCityURL, formURL, kevinLink, coffeeLink } from './common';
import { countyName } from './ledger';
import { doorPicksHTML, placeLine } from './setup';
import { stateName, tidyAddress } from '../geo';
import { pageWalk, decisionItems } from '../ballot';

function electionDate(): string {
  if (S.ballot) return S.ballot.howto.election_date;
  const counts: Record<string, number> = {};
  Object.values(S.index?.states || {}).forEach((s) => { counts[s.election_date] = (counts[s.election_date] || 0) + 1; });
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}
const dateline = (): string => { const d = electionDate(); return d ? `General election, ${fmtDate(d)}` : 'General election'; };
/* The first page's opening line: about voting right now, not about the guide. Its source is in
   "How this guide works". Once Election Day has passed, the plain dateline again. */
function kicker(): string {
  const d = electionDate();
  return d && todayISO() <= d ? `Voting is underway in every state. Election Day is ${fmtDate(d)}.` : dateline();
}

/* How many cities the guide covers, for the first page: each place counts once, except that DC's
   wards are one city and New York City's boroughs are one. */
export function cityCount(idx: Pick<Index, 'places'>): number {
  return new Set(Object.entries(idx.places).map(([id, p]) => (p.state === 'DC' ? 'DC' : /^nyc-/.test(id) ? 'NYC' : id))).size;
}

function tryBanner(): string {
  return S.tryMode ? `<p class="trybar" role="status">Demo: “${esc(S.tryMode)}”. Nothing here is saved. <a href="${esc(location.pathname)}">Exit demo</a></p>` : '';
}

/* The address form. When the Census matched more than one address, "Which one is yours?" takes its
   place: each match is a button, and "None of these" brings the form back with what you typed. */
export function addrHTML(forPlaces = false): string {
  if (!S.ui.addrOpen) return '';
  const which = S.ui.addrWhich;
  if (which && which.length) {
    return `<div class="addr addr-which" role="group" aria-labelledby="aw-h">
    <p id="aw-h"><b>Which one is yours?</b></p>
    <div class="opts">${which.map((r, i) => `<button class="opt" type="button" data-act="addr-which" data-i="${i}" data-fk="aw-${i}"><b>${esc(tidyAddress(r.matched))}</b></button>`).join('')}</div>
    <div class="row-btns"><button class="mini quiet" type="button" data-act="addr-again" data-fk="aw-none">None of these</button></div>
  </div>`;
  }
  return `<form class="addr" data-form="addr" novalidate>
    <label for="addr-in"><b>Street address</b></label>
    <input id="addr-in" name="addr" data-fk="addr" autocomplete="street-address" placeholder="Street, city and ZIP" ${S.ui.addrBusy ? 'disabled' : ''}>
    <div class="row-btns"><button class="mini dark" type="submit" ${S.ui.addrBusy ? 'disabled' : ''}>${S.ui.addrBusy ? 'Looking up...' : forPlaces ? 'Find my ballot' : 'Find my districts'}</button>
      <button class="mini quiet" type="button" data-act="addr-close">Cancel</button></div>
    <p class="fine">We send your address only to the U.S. Census Bureau’s free lookup to find your districts, and we never store it. Double-check with your official sample ballot.</p>
    ${S.ui.addrMsg ? `<p class="small" role="status">${esc(S.ui.addrMsg)}</p>${addrNextHTML()}` : ''}
  </form>`;
}
/* After a lookup that went wrong: "Try again" when the Census didn't answer, and on a ballot with a
   district question left, "Pick them myself" (it opens the first one). */
function addrNextHTML(): string {
  const f = S.ui.addrFail;
  if (!f || S.ui.addrBusy) return '';
  const pick = S.view === 'ballot' && S.ballot && pageWalk().some((x) => x.question);
  const btns = [
    f === 'down' ? '<button class="mini dark" type="button" data-act="addr-retry" data-fk="addr-retry">Try again</button>' : '',
    pick ? '<button class="mini" type="button" data-act="addr-pick" data-fk="addr-pick">Pick them myself</button>' : '',
  ].join('');
  return btns ? `<div class="row-btns addr-next">${btns}</div>` : '';
}
/* "Try again" under a load error: the same ZIP, ballot or first visit again. */
const retryHTML = (): string => (S.retry ? '<p class="row-btns"><button class="mini dark" data-act="retry" data-fk="retry">Try again</button></p>' : '');

export function mastHTML(): string {
  if (S.view === 'ballot' && S.ballot) {
    const b = S.ballot;
    // "Brooklyn (Kings County)": the name up top, the note in parentheses on the line below.
    const bare = (l: string) => l.replace(/\s*\(.*\)$/, '');
    // DC "not sure": the city as the headline and the wards under it, not four ward names.
    const wards = b.places.length > 1 && b.places.every((p) => /^DC Ward \d+$/.test(p.label)) ? b.places.map((p) => p.label.replace('DC Ward ', '')) : null;
    const name = wards ? 'Washington, DC' : b.places.length ? b.places.map((p) => bare(p.label)).join(' or ') : b.stateName;
    const note = wards ? `Ward ${wards.slice(0, -1).join(', ')} or ${wards[wards.length - 1]}` : b.places.length === 1 ? (b.places[0].label.match(/\((.*)\)$/) || [])[1] : '';
    // A city in several counties (Austin) shows just the state: three county names wrap to two lines.
    const county = b.places.length === 1 && b.st !== 'DC' && b.places[0].counties.length === 1 ? countyName(b.places[0]) : '';
    // "Travis County, Texas · 78704 · Change". The election office is in the plan's details.
    const where = [b.places.length ? (county && county !== b.stateName ? `${county}, ${b.stateName}` : b.stateName) : 'Statewide races', S.b.zip].filter(Boolean).join(' · ');
    return `<header class="mast wrap">${tryBanner()}
      <h1 class="place">${esc(name)}</h1>
      ${note && !/county\)?$/i.test(note) ? `<p class="where-note">${esc(note.charAt(0).toUpperCase() + note.slice(1))}</p>` : ''}
      <p class="where"><span>${esc(where)} ·</span> <button class="linkbtn chg" data-act="change-place" data-fk="change-place">Change</button></p>
    </header>`;
  }
  return doorHTML();
}

/* The first page: Kevin's line and the three ticks, then steps 1 and 2 on one sheet torn off the
   pad My plan is written on, so the plan you start here is the sheet you finish with; "Show my
   ballot" at its foot. The parts marked data-part repaint on their own (render.ts), so the ZIP box
   keeps its caret while the place line and the counts change under it. */
function doorHTML(): string {
  const ticks = ['Plain English', 'Full local details', 'Pick by endorsements or party'];
  return `<header class="mast front wrap">${tryBanner()}
    <div class="mast-top" data-part="kicker"><p class="dateline">${esc(kicker())}</p></div>
    <h1 class="place">Quickly make your voting plan.</h1>
    <ul class="ticks">${ticks.map((t) => `<li><i aria-hidden="true"></i>${esc(t)}</li>`).join('')}</ul>
    <div class="pad door" id="door">
      <span class="sheet-top" aria-hidden="true"></span><span class="sheet-fill" aria-hidden="true"></span>
      <form class="zipform" data-form="zip" novalidate>
        <label for="zip" class="step su-h zip-h"><span class="step-n" aria-hidden="true">1</span>Where do you vote?</label>
        <div class="zip-row"><input class="zip-input" id="zip" name="zip" data-fk="zip" inputmode="numeric" autocomplete="postal-code" maxlength="5" placeholder="ZIP code" value="${esc(S.zip)}" ${S.zipErr ? 'aria-describedby="zip-err" aria-invalid="true"' : ''}></div>
      </form>
      <div class="door-where" data-part="where">${whereHTML()}</div>
      <div class="door-picks" id="setup" data-part="picks">${S.tryMode ? '' : doorPicksHTML()}</div>
      <button class="bigbtn" data-act="setup-done" data-fk="setup-done">Show my ballot</button>
    </div>
    <div class="door-foot" data-part="fine">${creditsHTML()}</div>
    ${PILE}
  </header>`;
}

/* The states the guide covers, cut from paper and piled up at the foot of the first page (scripts/paper
   renders it). Outside the repainted parts, so it never reloads while you type. Decoration: empty alt,
   lazy, and the band's size is set in CSS, so nothing shifts when it loads. Dark mode gets its own render. */
const PILE = '<picture class="pile"><source srcset="/paper/dark/pile.webp" media="(prefers-color-scheme: dark)"><img src="/paper/pile.webp" alt="" width="640" height="150" loading="lazy" decoding="async"></picture>';

/* Under the ZIP box: what the ZIP found (the place, the place question, a state we don't cover),
   or what's wrong with it, and the address lookup. */
function whereHTML(): string {
  const idx = S.index;
  const b = S.view === 'setup' ? S.ballot : null;
  const err = S.zipErr ? `<p class="zip-err" role="alert" id="zip-err">${esc(S.zipErr)}</p>` : '';
  let after = '';
  if (b) {
    // "Austin, Texas · 78704". After the place question, Change asks it again.
    const zip = S.b.zip ? ` · ${esc(S.b.zip)}` : '';
    after = `<p class="door-place" role="status"><span><b>${esc(placeLine(b))}</b>${zip}</span>${S.picked ? '<button class="linkbtn" data-act="rechoose" data-fk="rechoose">Change</button>' : ''}</p>`;
  } else if (S.zipChoice && idx) {
    after = `<div class="choose" role="group" aria-labelledby="which-h">
      ${(() => { const dc = S.zipChoice.placeIds.every((id) => idx.places[id].state === 'DC'); const n = S.zipChoice.placeIds.length;
        return dc ? `<h2 id="which-h">${esc(S.zipChoice.zip)} covers ${n} wards. Pick yours.</h2><p class="small">It’s on your voter registration card.</p>`
          : `<h2 id="which-h">${esc(S.zipChoice.zip)} covers more than one city. Pick yours.</h2><p class="small">It’s on your voter registration or your ballot envelope.</p>`; })()}
      <div class="opts">${S.zipChoice.placeIds.map((id) => { const p = idx.places[id]; return `<button class="opt" data-act="choose-place" data-ids="${esc(id)}" data-fk="cp-${esc(id)}"><b>${esc(p.label)}</b><small>${esc(p.counties.join(', '))}</small></button>`; }).join('')}
        <button class="opt opt-unsure" data-act="choose-place" data-ids="${esc(S.zipChoice.placeIds.join('+'))}" data-fk="cp-unsure"><b>I’m not sure</b><small>Show everything that might be on my ballot</small></button></div>
      ${S.ui.addrOpen ? addrHTML(true) : '<p class="addr-cta"><button class="linkbtn" data-act="addr-open" data-fk="addr-open">Use my address instead</button></p>'}</div>`;
  } else if (S.coverage && S.coverage.kind === 'not_covered') {
    const name = S.coverage.state ? (S.coverage.state in (idx?.states || {}) ? idx!.states[S.coverage.state].name : stateName(S.coverage.state)) : null;
    // Vote.gov for now, and the report form (prefilled with the state and ZIP) to ask for the city.
    const ask = formURL('Please add my city', [name, S.coverage.zip].filter(Boolean).join(', '));
    after = `<div class="notice" role="status"><p><b>We don’t cover ${name ? esc(name) : 'that area'} yet.</b> ${ext('https://vote.gov/', 'Vote.gov')} has official info for every state.</p>
      <p>Want this for your city? <a href="${esc(ask)}" target="_blank" rel="noopener" data-ask-kevin>Ask Kevin</a>.</p></div>`;
  }
  // "Use my address for a more exact ballot" (Kevin, Oct 21: shorter than "for the most accurate
  // local results", and still true, since the Census settles Congress and the legislature, not every
  // local race) opens the address form right here. The place
  // question has its own link, so this one steps aside while it shows. After a lookup, what the
  // Census found takes its place, for this visit only, with "Not it? Try again" (the form again,
  // with what you typed).
  const found = b && S.ui.addrFound
    ? `<p class="door-found" role="status"><span><b>Found:</b> ${esc(S.ui.addrFound)}</span> <button class="linkbtn" data-act="addr-again" data-fk="addr-again">Not it? Try again</button></p>` : '';
  const addr = S.zipChoice ? '' : S.ui.addrOpen ? addrHTML(true) : found || '<p class="addr-cta"><button class="linkbtn" data-act="addr-open" data-fk="addr-open">Use my address for a more exact ballot</button></p>';
  return `${err}
    ${S.view === 'loading' ? '<p class="small" role="status">Loading your ballot...</p>' : ''}
    ${S.loadErr ? `<p class="zip-err" role="alert">${esc(S.loadErr)}</p>${retryHTML()}` : ''}
    ${after}
    ${addr}`;
}

/* The small print, one paragraph: how many cities, each one a tap away (the list opens below), whose
   friends they are (his name links to his site; Kevin, Oct 21: name him once), a way to ask for yours
   through the report form (prefilled with the ZIP in the box), and the coffee link. */
function creditsHTML(): string {
  const idx = S.index;
  const ask = `<a href="${esc(askCityURL(S.zip))}" target="_blank" rel="noopener" data-ask>Ask for yours</a>`;
  const k = 'browse';
  const n = idx ? cityCount(idx) : 0;
  const cover = idx ? `Covers <button class="linkbtn" data-act="open" data-k="${k}" aria-expanded="${isOpen(k)}" data-fk="browse">${n} ${n === 1 ? 'city' : 'cities'}</button> where ${kevinLink()}’s friends live. ` : '';
  return `<p class="fine credits">${cover}${[ask, coffeeLink()].filter(Boolean).join(' · ')}</p>
    ${idx && isOpen(k) ? browseHTML() : ''}`;
}

function browseHTML(): string {
  const idx = S.index!;
  const states = Object.entries(idx.states).sort((a, b) => a[1].name.localeCompare(b[1].name));
  return `<ul class="browse-list">${states.map(([st, s]) => `<li><b>${esc(s.name)}</b>
      ${s.places.map((id) => `<button class="linkbtn" data-act="choose-place" data-from="browse" data-ids="${esc(id)}">${esc(idx.places[id].label)}</button>`).join('')}
      <button class="linkbtn" data-act="choose-state" data-from="browse" data-st="${esc(st)}">${s.places.length ? 'Elsewhere in the state: statewide races only' : 'Statewide races'}</button></li>`).join('')}</ul>`;
}

/* "Welcome back", above the plan on a returning visitor's started ballot (app.ts offerResume):
   where you are, a way to pick up where you left off (the menu's "Next up"), and a small close. */
const CLOSE = '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false"><path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></svg>';
function resumeHTML(): string {
  const items = decisionItems();
  const done = items.filter((i) => i.done).length;
  return `<div class="notice resume wrap" role="region" aria-labelledby="rs-h">
    <p id="rs-h"><b>Welcome back.</b> You’ve decided ${done} of ${items.length}.</p>
    <div class="row-btns"><button class="mini dark" data-act="next" data-fk="resume-go">Pick up where I left off</button></div>
    <button class="ibtn resume-x" data-act="resume-x" data-fk="resume-x" aria-label="Close">${CLOSE}</button></div>`;
}
export function restoreHTML(): string {
  if (!S.pending) return S.ui.resume && S.view === 'ballot' && S.ballot && S.ui.view === 'ballot' ? resumeHTML() : '';
  if (S.pending.kind === 'shared') {
    const where = S.ballot ? (S.ballot.places.length ? S.ballot.places.map((p) => p.label.replace(/\s*\(.*\)$/, '')).join(' or ') : S.ballot.stateName) : '';
    return `<div class="notice strong wrap" role="region" aria-labelledby="rs-h">
    <p id="rs-h"><b>${esc(S.pending.summary)}</b></p>
    <div class="row-btns"><button class="mini dark" data-act="shared-keep" data-fk="restore-yes">Use the link’s picks</button>
      <button class="mini" data-act="shared-fresh">Start fresh</button></div>
    <p class="small">Not in ${esc(where)}? <button class="linkbtn" data-act="change-place">Find your ballot</button></p></div>`;
  }
  return `<div class="notice strong wrap" role="alertdialog" aria-labelledby="rs-h">
    <p id="rs-h"><b>${esc(S.pending.summary)}</b></p>
    <div class="row-btns"><button class="mini dark" data-act="restore-yes" data-fk="restore-yes">Use the link’s picks</button>
      <button class="mini" data-act="restore-no">Keep what I have</button></div></div>`;
}
