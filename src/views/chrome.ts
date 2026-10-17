/* Page chrome: masthead and ZIP flow, address lookup, restore prompt, auto-pick offer,
   sticky bar, filter sheet, and "How this guide works". */
import { S } from '../state';
import { autoCandidates, decisionItems, filterSig, isPartisan, partyCats, PARTY_LABEL, type PartyCat } from '../ballot';
import type { Contest } from '../types';
import { esc, plural, fmtLong } from '../util';
import { ext, isOpen, discBtn } from './common';
import { sourcesShelfHTML, gridShelfHTML } from './sources';

/* The election date shown up top comes from the data: this ballot's state file, or the
   date most covered states share. */
function electionLine(): string {
  const d = S.ballot ? S.ballot.howto.election_date : (() => {
    const counts: Record<string, number> = {};
    Object.values(S.index?.states || {}).forEach((s) => { counts[s.election_date] = (counts[s.election_date] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  })();
  return d ? `General election, ${fmtLong(d)}` : 'General election';
}
export function mastHTML(): string {
  const idx = S.index;
  if (S.view === 'ballot' && S.ballot) {
    const b = S.ballot;
    const where = b.places.length ? b.places.map((p) => p.label).join(' or ') : `${b.stateName}, statewide`;
    return `<header class="mast mast-sm">
      <span class="kicker">${esc(electionLine())}</span>
      <h1 class="h1">Your ballot, explained</h1>
      <p class="place-line"><strong>${esc(where)}</strong>${S.b.zip ? ` <span class="lim">${esc(S.b.zip)}</span>` : ''}
        <button class="btn-text btn btn-sm" data-act="change-place" data-fk="change-place">Change</button></p>
      ${S.b.addrNote ? `<p class="lim">${esc(S.b.addrNote)}</p>` : ''}
      ${addrHTML()}
    </header>`;
  }
  const err = S.zipErr ? `<p class="zip-err" role="alert" id="zip-err">${esc(S.zipErr)}</p>` : '';
  let after = '';
  if (S.zipChoice && idx) {
    after = `<div class="stack-sm" role="group" aria-labelledby="which-h">
      <h2 class="h3" id="which-h">${esc(S.zipChoice.zip)} crosses city lines. Which of these is you?</h2>
      <p class="small muted">Check the city on your voter registration or your ballot envelope.</p>
      <div class="choices">${S.zipChoice.placeIds.map((id) => { const p = idx.places[id]; return `<button class="choice" data-act="choose-place" data-ids="${esc(id)}" data-fk="cp-${esc(id)}"><strong>${esc(p.label)}</strong><span>${esc(p.counties.join(', '))}</span></button>`; }).join('')}
        <button class="choice choice-unsure" data-act="choose-place" data-ids="${esc(S.zipChoice.placeIds.join('+'))}"><strong>I’m not sure</strong><span>Show everything that might be on my ballot</span></button></div></div>`;
  } else if (S.coverage && S.coverage.kind === 'not_covered') {
    const name = S.coverage.state ? (S.coverage.state in (idx?.states || {}) ? idx!.states[S.coverage.state].name : S.coverage.state) : null;
    after = `<div class="notice" role="status"><p><strong>We don’t cover ${name ? esc(name) : 'that area'} yet.</strong> This guide covers the places Kevin’s friends and family vote. ${ext('https://vote.gov/', 'Vote.gov')} has official info for every state.</p></div>`;
  }
  return `<header class="mast">
    <span class="kicker">${esc(electionLine())}</span>
    <h1 class="h1">Your ballot, explained</h1>
    <p class="lede">Enter your ZIP. You’ll see how to vote in your state, what’s on your ballot in plain words, and who endorsed whom.</p>
    <form class="zip-form" data-form="zip" novalidate>
      <label for="zip">Your ZIP code</label>
      <input class="zip-input" id="zip" name="zip" data-fk="zip" inputmode="numeric" autocomplete="postal-code" maxlength="5" placeholder="80205" value="${esc(S.zip)}" ${S.zipErr ? 'aria-describedby="zip-err" aria-invalid="true"' : ''}>
      <button class="btn btn-primary" type="submit">Show my ballot</button>
      ${err}
    </form>
    ${S.view === 'loading' ? '<p class="small muted" role="status">Loading your ballot...</p>' : ''}
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
  return `<div class="browse">${discBtn(k, 'Or pick a place from the list', 'btn-text btn btn-sm')}
    ${isOpen(k) ? `<ul class="browse-list">${states.map(([st, s]) => `<li><strong>${esc(s.name)}</strong>
      ${s.places.map((id) => `<button class="btn-text btn btn-sm" data-act="choose-place" data-ids="${esc(id)}">${esc(idx.places[id].label)}</button>`).join('')}
      <button class="btn-text btn btn-sm" data-act="choose-state" data-st="${esc(st)}">${s.places.length ? 'Elsewhere in the state' : 'Statewide races'}</button></li>`).join('')}</ul>` : ''}</div>`;
}

export function addrHTML(): string {
  const b = S.ballot;
  if (!b) return '';
  const hasDistrictQs = b.groups.length > 0 || b.mayApply.size > 0;
  if (!S.ui.addrOpen) {
    return hasDistrictQs ? `<button class="btn-text btn btn-sm" data-act="addr-open" data-fk="addr-open">Use my address for an exact match</button>` : '';
  }
  return `<form class="addr" data-form="addr" novalidate>
    <label for="addr-in" class="small"><strong>Street address</strong></label>
    <input id="addr-in" name="addr" data-fk="addr" autocomplete="street-address" placeholder="123 Main St, Denver, CO 80205" ${S.ui.addrBusy ? 'disabled' : ''}>
    <div class="row"><button class="btn btn-sm btn-primary" type="submit" ${S.ui.addrBusy ? 'disabled' : ''}>${S.ui.addrBusy ? 'Looking up...' : 'Match my districts'}</button>
      <button class="btn-text btn btn-sm" type="button" data-act="addr-close">Cancel</button></div>
    <p class="lim">Your address goes only to the U.S. Census Bureau’s free lookup to find your districts. We never store it or send it anywhere else. Double-check with your official sample ballot.</p>
    ${S.ui.addrMsg ? `<p class="small" role="status">${esc(S.ui.addrMsg)}</p>` : ''}
  </form>`;
}

export function restoreHTML(): string {
  if (!S.pending) return '';
  return `<div class="notice notice-strong" role="alertdialog" aria-labelledby="rs-h">
    <p id="rs-h"><strong>${esc(S.pending.summary)}</strong></p>
    <div class="row"><button class="btn btn-sm btn-primary" data-act="restore-yes" data-fk="restore-yes">Use the link’s picks</button>
      <button class="btn btn-sm" data-act="restore-no">Keep what I have</button></div></div>`;
}

export function offerHTML(): string {
  if (!S.ballot || S.prefs.autoPick) return '';
  const list = autoCandidates();
  if (!list.length || S.b.offerDismissed === filterSig()) return '';
  return `<div class="offer" role="status">
    <p><strong>Only one candidate left in ${plural(list.length, 'race')}.</strong> Pick ${list.length === 1 ? 'it' : 'them'} for you? Each one will say why, and you can undo any of them.</p>
    <div class="row"><button class="btn btn-sm btn-primary" data-act="offer-yes" data-fk="offer-yes">Pick ${list.length === 1 ? 'it' : 'them'}</button>
      <button class="btn btn-sm" data-act="offer-no">No thanks</button></div></div>`;
}

export function barHTML(): string {
  if (!S.ballot) return '';
  const items = decisionItems();
  const done = items.filter((i) => i.done).length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;
  const active = (S.prefs.parties ? 1 : 0) + (S.prefs.endorsedOnly ? 1 : 0);
  return `<div class="bar screen-only" role="region" aria-label="Your progress">
    <div class="bar-prog"><span class="bar-txt"><strong>${done} of ${items.length}</strong> decided</span>
      <span class="bar-track" aria-hidden="true"><i style="width:${pct}%"></i></span></div>
    <button class="btn btn-sm" data-act="next" ${done === items.length ? 'disabled' : ''} data-fk="bar-next">${done === items.length ? 'All decided' : 'Next undecided'}</button>
    <button class="btn btn-sm ${active ? 'btn-primary' : ''}" data-act="filter" aria-haspopup="dialog" data-fk="bar-filter">Filter${active ? ` (${active})` : ''}</button>
  </div>`;
}

function partiesOnBallot(): PartyCat[] {
  const b = S.ballot!;
  const set = new Set<PartyCat>();
  b.items.forEach((it) => { if (it.kind === 'contest' && isPartisan(it as Contest)) (it as Contest).candidates.forEach((c) => partyCats(c).forEach((p) => set.add(p))); });
  return (['D', 'R', 'O', 'I'] as PartyCat[]).filter((p) => set.has(p));
}

export function sheetHTML(): string {
  if (!S.ui.filterOpen || !S.ballot) return '';
  if (S.ui.gridOpen) {
    return `<div class="scrim screen-only" data-act="filter-close"></div>
    <div class="sheet-panel sheet-grid screen-only" role="dialog" aria-modal="true" aria-labelledby="flt-h">
      <div class="sheet-hd"><button class="btn btn-sm" data-act="grid-close" data-fk="grid-back"><span aria-hidden="true">&larr;</span> Sources</button>
        <h2 class="h3" id="flt-h">Side by side</h2><button class="drawer-x" data-act="filter-close" aria-label="Close" data-fk="flt-x">&times;</button></div>
      <div class="sheet-bd">${gridShelfHTML()}</div>
    </div>`;
  }
  const cats = partiesOnBallot();
  const sel = S.prefs.parties;
  const tgl = (act: string, on: boolean, label: string, sub: string, fk: string) => `<div class="src-row">
      <div class="stack-xs"><span class="src-name" id="lb-${fk}">${esc(label)}</span><span class="src-desc">${esc(sub)}</span></div>
      <button class="tg" role="switch" aria-checked="${on}" aria-labelledby="lb-${fk}" data-act="${act}" data-fk="${fk}"><span></span></button></div>`;
  return `<div class="scrim screen-only" data-act="filter-close"></div>
  <div class="sheet-panel screen-only" role="dialog" aria-modal="true" aria-labelledby="flt-h">
    <div class="sheet-hd"><h2 class="h3" id="flt-h">Filter your ballot</h2><button class="drawer-x" data-act="filter-close" aria-label="Close" data-fk="flt-x">&times;</button></div>
    <div class="sheet-bd" data-keep="sheet">
      ${cats.length ? `<div class="stack-sm"><span class="kicker">Parties</span>
        <p class="small muted">Hides candidates in partisan races. Measures and nonpartisan races always show.</p>
        <div class="chips">${cats.map((p) => `<button class="fchip" data-act="party" data-p="${p}" aria-pressed="${!sel || sel.includes(p)}" data-fk="pty-${p}">${esc(PARTY_LABEL[p])}</button>`).join('')}</div>
        ${sel ? '<button class="btn-text btn btn-sm" data-act="party-all">Show every party</button>' : ''}
      </div>` : ''}
      <div class="flt-group">
      ${tgl('f-fold', S.prefs.foldDecided, 'Fold races I’ve decided', 'Each decided race shrinks to one line. Tap Change to reopen it.', 'f-fold')}
      ${tgl('f-auto', S.prefs.autoPick, 'Pick for me when one candidate is left', 'When your filters leave one candidate, we pick them and say why. You can undo any of them.', 'f-auto')}
      </div>
      ${sourcesShelfHTML(tgl)}
    </div>
    <div class="sheet-ft"><button class="btn btn-primary btn-block" data-act="filter-close" data-fk="flt-done">Done</button></div>
  </div>`;
}

export function trustHTML(): string {
  const b = S.ballot;
  const idx = S.index;
  const asOf = idx ? Object.entries(idx.states).sort((x, y) => x[1].name.localeCompare(y[1].name)) : [];
  return `<section class="trust" id="how" aria-labelledby="how-h">
    <h2 class="h3" id="how-h">How this guide works</h2>
    <p>Kevin built this for friends and family. It doesn’t tell you how to vote. It shows what’s on your ballot in plain words, what candidates say in their own words, and who endorsed whom, with a link for every claim.</p>
    <ul class="trust-list">
      <li><strong>Nonpartisan by default.</strong> Every candidate gets the same fields. We quote rather than describe. Office and measure explainers say what something does, not whether it’s good.</li>
      <li><strong>Sources.</strong> Publications and nonpartisan groups like the League of Women Voters start on. Parties and advocacy groups are off until you turn them on. Each source is labeled with a lean on a five-step scale, with the basis for that rating one tap away.</li>
      <li><strong>Honest counts.</strong> “No stand” means a source doesn’t weigh in on that race. “None found” means we looked and found nothing. “Not checked” means we haven’t looked yet. We never fill gaps to look balanced.</li>
      <li><strong>Confidence.</strong> Facts from official sources are checked against them. Anything marked “Not yet confirmed” is our best lead.</li>
      <li><strong>Your privacy.</strong> No accounts, no ads, no analytics. Your picks stay on your device unless you share your save link. An address you type goes only to the Census Bureau’s lookup, and we never keep it.</li>
      <li><strong>Mistakes.</strong> Every race has a “Report a problem” link.</li>
    </ul>
    ${b ? `<p class="small">Official info for ${esc(b.stateName)}: ${ext(b.howto.official_site.url, b.howto.official_site.name)}${b.howto.registration.check_url ? `. Check your registration: ${ext(b.howto.registration.check_url, 'official lookup')}` : ''}.</p>` : ''}
    ${asOf.length ? `${discBtn('asof', 'When each state was last checked', 'btn-text btn btn-sm')}${isOpen('asof') ? `<ul class="asof">${asOf.map(([, s]) => `<li>${esc(s.name)}: ${esc(s.as_of || 'unknown')}. ${ext(s.official_site.url, 'Official site')}</li>`).join('')}</ul>` : ''}` : ''}
    <p class="lim">Data built ${esc(idx ? idx.generated.slice(0, 10) : '')}. Not affiliated with any campaign, party or government office.</p>
  </section>`;
}
