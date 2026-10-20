/* The front door (ZIP, the place question, browse, not covered) and the ballot masthead:
   a forwarded friend must know in five seconds whose ballot this is and how to change it. */
import type { Index } from '../types';
import { S } from '../state';
import { esc, fmtDate, todayISO } from '../util';
import { ext, isOpen, askCityURL, BUY_ME_A_COFFEE_URL, KEVIN_URL } from './common';
import { countyName } from './ledger';
import { setupHTML } from './setup';
import { stateName } from '../geo';

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

export function addrHTML(forPlaces = false): string {
  if (!S.ui.addrOpen) return '';
  return `<form class="addr" data-form="addr" novalidate>
    <label for="addr-in"><b>Street address</b></label>
    <input id="addr-in" name="addr" data-fk="addr" autocomplete="street-address" placeholder="Street, city and ZIP" ${S.ui.addrBusy ? 'disabled' : ''}>
    <div class="row-btns"><button class="mini dark" type="submit" ${S.ui.addrBusy ? 'disabled' : ''}>${S.ui.addrBusy ? 'Looking up...' : forPlaces ? 'Find my ballot' : 'Find my districts'}</button>
      <button class="mini quiet" type="button" data-act="addr-close">Cancel</button></div>
    <p class="fine">We send your address only to the U.S. Census Bureau’s free lookup to find your districts, and we never store it. Double-check with your official sample ballot.</p>
    ${S.ui.addrMsg ? `<p class="small" role="status">${esc(S.ui.addrMsg)}</p>` : ''}
  </form>`;
}

export function mastHTML(): string {
  const idx = S.index;
  if (S.view === 'ballot' && S.ballot) {
    const b = S.ballot;
    // "Brooklyn (Kings County)": the name up top, the note in parentheses on the line below.
    const bare = (l: string) => l.replace(/\s*\(.*\)$/, '');
    // DC "not sure": the city as the headline and the wards under it, not four ward names.
    const wards = b.places.length > 1 && b.places.every((p) => /^DC Ward \d+$/.test(p.label)) ? b.places.map((p) => p.label.replace('DC Ward ', '')) : null;
    const name = wards ? 'Washington, DC' : b.places.length ? b.places.map((p) => bare(p.label)).join(' or ') : b.stateName;
    const note = wards ? `Ward ${wards.slice(0, -1).join(', ')} or ${wards[wards.length - 1]}` : b.places.length === 1 ? (b.places[0].label.match(/\((.*)\)$/) || [])[1] : '';
    const county = b.places.length === 1 && b.st !== 'DC' ? countyName(b.places[0]) : '';
    // "Travis County, Texas · 78704 · Change". The election office is in the plan's details.
    const where = [b.places.length ? (county && county !== b.stateName ? `${county}, ${b.stateName}` : b.stateName) : 'Statewide races', S.b.zip].filter(Boolean).join(' · ');
    return `<header class="mast wrap">${tryBanner()}
      <h1 class="place">${esc(name)}</h1>
      ${note && !/county\)?$/i.test(note) ? `<p class="where-note">${esc(note.charAt(0).toUpperCase() + note.slice(1))}</p>` : ''}
      <p class="where"><span>${esc(where)} ·</span> <button class="linkbtn chg" data-act="change-place" data-fk="change-place">Change</button></p>
      ${S.b.addrNote ? `<p class="fine">${esc(S.b.addrNote)}</p>` : ''}
    </header>`;
  }
  if (S.view === 'setup' && S.ballot) return setupHTML();
  const err = S.zipErr ? `<p class="zip-err" role="alert" id="zip-err">${esc(S.zipErr)}</p>` : '';
  let after = '';
  if (S.zipChoice && idx) {
    after = `<div class="choose" role="group" aria-labelledby="which-h">
      ${(() => { const dc = S.zipChoice.placeIds.every((id) => idx.places[id].state === 'DC'); const n = S.zipChoice.placeIds.length;
        return dc ? `<h2 id="which-h">${esc(S.zipChoice.zip)} covers ${n} wards. Pick yours.</h2><p class="small">It’s on your voter registration card.</p>`
          : `<h2 id="which-h">${esc(S.zipChoice.zip)} covers more than one city. Pick yours.</h2><p class="small">It’s on your voter registration or your ballot envelope.</p>`; })()}
      <div class="opts">${S.zipChoice.placeIds.map((id) => { const p = idx.places[id]; return `<button class="opt" data-act="choose-place" data-ids="${esc(id)}" data-fk="cp-${esc(id)}"><b>${esc(p.label)}</b><small>${esc(p.counties.join(', '))}</small></button>`; }).join('')}
        <button class="opt opt-unsure" data-act="choose-place" data-ids="${esc(S.zipChoice.placeIds.join('+'))}" data-fk="cp-unsure"><b>I’m not sure</b><small>Show everything that might be on my ballot</small></button></div>
      ${S.ui.addrOpen ? addrHTML(true) : '<p class="addr-cta"><button class="linkbtn" data-act="addr-open" data-fk="addr-open">Use my address instead</button></p>'}</div>`;
  } else if (S.coverage && S.coverage.kind === 'not_covered') {
    const name = S.coverage.state ? (S.coverage.state in (idx?.states || {}) ? idx!.states[S.coverage.state].name : stateName(S.coverage.state)) : null;
    after = `<div class="notice" role="status"><p><b>We don’t cover ${name ? esc(name) : 'that area'} yet.</b> This guide covers where Kevin’s friends and family vote. ${ext('https://vote.gov/', 'Vote.gov')} has official info for every state.</p></div>`;
  }
  // "Use my street address instead" opens the address form right here, before any ZIP. The place
  // question has its own link, so this one steps aside while it shows.
  const addr = S.zipChoice ? '' : S.ui.addrOpen ? addrHTML(true) : '<p class="addr-cta"><button class="linkbtn" data-act="addr-open" data-fk="addr-open">Use my street address instead</button></p>';
  const ticks = ['Plain English', 'Full local details', 'Pick by endorsements or party'];
  const coffee = BUY_ME_A_COFFEE_URL ? ` · ${ext(BUY_ME_A_COFFEE_URL, 'Buy me a coffee')}` : '';
  return `<header class="mast front wrap">${tryBanner()}
    <div class="mast-top"><p class="dateline">${esc(kicker())}</p></div>
    <h1 class="place">Quickly make your voting plan.</h1>
    <ul class="ticks">${ticks.map((t) => `<li><i aria-hidden="true"></i>${esc(t)}</li>`).join('')}</ul>
    <form class="zipform" data-form="zip" novalidate>
      <label for="zip" class="step"><span class="step-n" aria-hidden="true">1</span>Where do you vote?</label>
      <div class="zip-row"><input class="zip-input" id="zip" name="zip" data-fk="zip" inputmode="numeric" autocomplete="postal-code" maxlength="5" placeholder="ZIP code" value="${esc(S.zip)}" ${S.zipErr ? 'aria-describedby="zip-err" aria-invalid="true"' : ''}>
      <button class="mini dark" type="submit">Next</button></div>
      ${err}
    </form>
    ${S.view === 'loading' ? '<p class="small" role="status">Loading your ballot...</p>' : ''}
    ${S.loadErr ? `<p class="zip-err" role="alert">${esc(S.loadErr)}</p>` : ''}
    ${after}
    ${addr}
    <hr class="door-rule">
    ${coverHTML()}
    <p class="fine">Made by Kevin · ${ext(KEVIN_URL, 'kevinhg.com')}${coffee}</p>
  </header>`;
}

/* The small print: how many cities, each one a tap away (the list opens below), and a way to ask
   for yours through the report form, prefilled with the ZIP in the box. */
function coverHTML(): string {
  const idx = S.index;
  const ask = `<a href="${esc(askCityURL(S.zip))}" target="_blank" rel="noopener" data-ask>Ask for yours</a>`;
  if (!idx) return `<p class="fine">${ask}</p>`;
  const k = 'browse';
  const n = cityCount(idx);
  return `<p class="fine">Covers <button class="linkbtn" data-act="open" data-k="${k}" aria-expanded="${isOpen(k)}" data-fk="browse">${n} ${n === 1 ? 'city' : 'cities'}</button> where Kevin’s friends live. ${ask}</p>
    ${isOpen(k) ? browseHTML() : ''}`;
}

function browseHTML(): string {
  const idx = S.index!;
  const states = Object.entries(idx.states).sort((a, b) => a[1].name.localeCompare(b[1].name));
  return `<ul class="browse-list">${states.map(([st, s]) => `<li><b>${esc(s.name)}</b>
      ${s.places.map((id) => `<button class="linkbtn" data-act="choose-place" data-ids="${esc(id)}">${esc(idx.places[id].label)}</button>`).join('')}
      <button class="linkbtn" data-act="choose-state" data-st="${esc(st)}">${s.places.length ? 'Elsewhere in the state: statewide races only' : 'Statewide races'}</button></li>`).join('')}</ul>`;
}

export function restoreHTML(): string {
  if (!S.pending) return '';
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
