/* The front door (ZIP, the place question, browse, not covered) and the ballot masthead:
   a forwarded friend must know in five seconds whose ballot this is and how to change it. */
import { S } from '../state';
import { esc, fmtDate } from '../util';
import { ext, isOpen, telHTML } from './common';
import { countyName } from './ledger';
import { stateName } from '../geo';

function electionDate(): string {
  if (S.ballot) return S.ballot.howto.election_date;
  const counts: Record<string, number> = {};
  Object.values(S.index?.states || {}).forEach((s) => { counts[s.election_date] = (counts[s.election_date] || 0) + 1; });
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}
const dateline = (): string => { const d = electionDate(); return d ? `General election, ${fmtDate(d)}` : 'General election'; };

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
    const where = [b.places.length ? (county && county !== b.stateName ? `${county}, ${b.stateName}` : b.stateName) : 'Statewide races', S.b.zip ? `ZIP ${S.b.zip}` : ''].filter(Boolean).join('. ');
    const office = b.places.map((p) => p.county_election_office).find(Boolean);
    const officeName = office ? office.name.split(/[,:]\s*\d/)[0].trim() : '';
    return `<header class="mast wrap">${tryBanner()}
      <div class="mast-top"><span class="dateline">${esc(dateline())}</span></div>
      <h1 class="place">${esc(name)}</h1>
      ${note && !/county\)?$/i.test(note) ? `<p class="where-note">${esc(note.charAt(0).toUpperCase() + note.slice(1))}</p>` : ''}
      <p class="where"><span>${esc(where)}.</span> <button class="linkbtn" data-act="change-place" data-fk="change-place">Not your ballot? Change</button></p>
      ${office ? `<p class="office">${office.url ? ext(office.url, officeName) : esc(officeName)}${office.phone ? `, ${telHTML(office.phone)}` : ''}</p>` : ''}
      ${S.b.addrNote ? `<p class="fine">${esc(S.b.addrNote)}</p>` : ''}
    </header>`;
  }
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
  return `<header class="mast front wrap">${tryBanner()}
    <div class="mast-top"><span class="dateline">${esc(dateline())}</span></div>
    <h1 class="place">Your ballot, explained</h1>
    <p class="lede">Enter your ZIP to see how and by when to vote, every race and measure in plain words, and who endorsed whom.</p>
    <form class="zipform" data-form="zip" novalidate>
      <label for="zip">Your ZIP code</label>
      <div class="zip-row"><input class="zip-input" id="zip" name="zip" data-fk="zip" inputmode="numeric" autocomplete="postal-code" maxlength="5" placeholder="80205" value="${esc(S.zip)}" ${S.zipErr ? 'aria-describedby="zip-err" aria-invalid="true"' : ''}>
      <button class="mini dark" type="submit">Show my ballot</button></div>
      ${err}
    </form>
    ${S.view === 'loading' ? '<p class="small" role="status">Loading your ballot...</p>' : ''}
    ${S.loadErr ? `<p class="zip-err" role="alert">${esc(S.loadErr)}</p>` : ''}
    ${after}
    ${browseHTML()}
  </header>`;
}

function browseHTML(): string {
  const idx = S.index;
  if (!idx) return '';
  const k = 'browse';
  const states = Object.entries(idx.states).sort((a, b) => a[1].name.localeCompare(b[1].name));
  return `<div class="browse"><button class="linkbtn" data-act="open" data-k="${k}" aria-expanded="${isOpen(k)}" data-fk="browse">Or browse the places we cover</button>
    ${isOpen(k) ? `<ul class="browse-list">${states.map(([st, s]) => `<li><b>${esc(s.name)}</b>
      ${s.places.map((id) => `<button class="linkbtn" data-act="choose-place" data-ids="${esc(id)}">${esc(idx.places[id].label)}</button>`).join('')}
      <button class="linkbtn" data-act="choose-state" data-st="${esc(st)}">${s.places.length ? 'Elsewhere in the state: statewide races only' : 'Statewide races'}</button></li>`).join('')}</ul>` : ''}</div>`;
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
