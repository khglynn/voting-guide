/* Whose picks you see: the chips (step 2 and the ballot's Edit sheet), the one-line summary at the
   top of the ballot, the "See all sources" sheet and the party chooser. Lean labels show with their
   basis; parties are text; no red or blue. */
import type { Contest, Endorser } from '../types';
import { S } from '../state';
import { chosenIds, decisionItems } from '../ballot';
import { esc, plural } from '../util';
import { CHIPS, chipState, partiesOnBallot, picksOnBallot, picksShown, explainsOnly, noEndorsements, cantRead } from '../model/lens';
import { leanHTML, sourceLean, ext, isOpen, paywallSourceHTML, hasPaywallNote, blockedSourceHTML, unreadWhy, unreadLinkHTML, shelfAttrs } from './common';

export const TICK = '<svg class="tick" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M2 6.3l2.6 2.6L10 3.3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
const TYPE_WORD: Record<string, string> = {
  publication: 'Newspaper or newsroom', civic_nonpartisan: 'Nonpartisan civic group', party: 'Political party', advocacy: 'Issue group',
  labor: 'Union', business: 'Business group', elected_official: 'Officeholder', other: 'Other',
};

/* The three preset chips. A group chip with no picks on this ballot stays out of the way. */
export function chipsHTML(): string {
  const b = S.ballot!;
  return CHIPS.map((c) => {
    const st = chipState(b, c.key);
    if (st === 'empty' && c.key !== 'papers') return '';
    const on = st === 'on' || st === 'some';
    return `<button class="chip${st === 'some' ? ' some' : ''}" data-act="chip" data-k="${c.key}" aria-pressed="${on}" data-fk="chip-${c.key}">${TICK}${esc(c.label)}</button>`;
  }).join('');
}
/* "Endorsements: Newspapers and guides" at the top of the ballot: whose endorsements show, in a few words ("Off" when none; Kevin's "Picks:" read like your own picks, UX walk, Oct 20). */
export function lensSummary(): string {
  const b = S.ballot!;
  if (noEndorsements()) return 'Off';
  const on = CHIPS.filter((c) => ['on', 'some'].includes(chipState(b, c.key))).map((c) => `${chipState(b, c.key) === 'some' ? 'some ' : ''}${c.label.toLowerCase()}`);
  if (S.b.party) on.push(`the ${S.b.party} Party`);
  const n = chosenIds().length;
  const list = on.length ? on.join(', ') : n ? plural(n, 'source') : 'none';
  return list.charAt(0).toUpperCase() + list.slice(1);
}

/* ---------- the "See all sources" sheet ---------- */
const GROUPS: [string, string][] = [['left', 'Left'], ['lean_left', 'Leans left'], ['neutral', 'Center'], ['lean_right', 'Leans right'], ['right', 'Right'], ['none', 'Not rated']];
const BASIS_KIND: Record<string, string> = { outside_rating: 'Rated by an outside group', party: 'A party', mission: 'From its mission statement' };
function srcRow(e: Endorser, shown: ReturnType<typeof picksShown>): string {
  const b = S.ballot!;
  const on = chosenIds().includes(e.id);
  const k = `basis-${e.id}`;
  const n = shown.decisions.get(e.id) || 0;
  // A paywalled paper with no readable pick here is named once, by its paywall note below.
  // A source whose picks are all in unopposed races, or in races your ballot doesn't show yet (a
  // district you haven't picked, a race you hid), says so, never "No endorsements found".
  const what = explainsOnly(e) ? 'Explains, doesn’t endorse' : n ? `Endorsed in ${n} of your races and measures` : hasPaywallNote(e) || e.blocked ? ''
    : shown.unopposed.get(e.id) ? 'Endorsed only in unopposed races' : picksOnBallot(b, e.id) ? 'Endorsed only in races that depend on your address' : 'No endorsements found';
  return `<li class="srow">
    <div class="s-main"><span class="s-n" id="sn-${esc(e.id)}">${esc(e.name)}</span><span class="s-d">${esc(TYPE_WORD[e.type] || e.type)}.${what ? ` ${esc(what)}.` : ''}</span>
      <span class="s-l">${sourceLean(e)}<button class="linkbtn" data-act="open" data-k="${esc(k)}" aria-expanded="${isOpen(k)}">Why this lean</button></span>
      ${isOpen(k) ? `<p class="s-b">${e.lean_basis_kind ? `<b>${esc(BASIS_KIND[e.lean_basis_kind])}.</b> ` : ''}${esc(e.lean_basis || 'No basis recorded, so we show it as not rated.')}${e.lean_note ? ` ${esc(e.lean_note)}` : ''}${e.guide_url ? ` ${ext(e.guide_url, 'Their guide')}` : ''}</p>` : ''}
      ${paywallSourceHTML(e)}${blockedSourceHTML(e)}</div>
    <button class="tg" role="switch" aria-checked="${on}" aria-labelledby="sn-${esc(e.id)}" data-act="src" data-id="${esc(e.id)}" data-fk="tg-${esc(e.id)}"><span></span></button></li>`;
}
/* "Couldn't read" (Kevin, Oct 25: "show what sources we tried but couldn't access (paywalls and stuff)"):
   a source behind a paywall or a bot check with no pick on this ballot, so there is nothing of its to
   turn on. Its reason in one line and "Send it to us", no switch. One with picks from a free page or an
   earlier read stays in its lean group, its note under its name. */
const unreadHere = (b: NonNullable<typeof S.ballot>, e: Endorser): boolean => cantRead(e) && !picksOnBallot(b, e.id);
function unreadHTML(list: Endorser[]): string {
  if (!list.length) return '';
  return `<section class="sgrp unread"><h3>Couldn’t read (${list.length})</h3><ul>${list.map((e) => `<li class="srow" data-unread="${esc(e.id)}">
    <div class="s-main"><span class="s-n">${esc(e.name)}</span><span class="s-d">${esc(TYPE_WORD[e.type] || e.type)}.</span>
      <p class="pw-note">${esc(unreadWhy(e))} ${unreadLinkHTML(e)}.</p></div></li>`).join('')}</ul></section>`;
}
export function sourcesSheetHTML(): string {
  const b = S.ballot!;
  const shown = picksShown(b);
  const byCount = (a: Endorser, c: Endorser) => (shown.decisions.get(c.id) || 0) - (shown.decisions.get(a.id) || 0) || a.name.localeCompare(c.name);
  const empties = CHIPS.filter((c) => c.key !== 'papers' && chipState(b, c.key) === 'empty').map((c) => c.empty);
  const unread = b.endorsers.filter((e) => unreadHere(b, e)).sort((a, c) => a.name.localeCompare(c.name));
  const groups = GROUPS.map(([lean, word]) => {
    const list = b.endorsers.filter((e) => (e.lean || 'none') === lean && !unreadHere(b, e)).sort(byCount);
    if (!list.length) return '';
    const on = list.filter((e) => chosenIds().includes(e.id)).length;
    return `<section class="sgrp"><h3>${lean === 'none' ? '' : leanHTML(lean as Endorser['lean'], false)} ${esc(word)} <span class="s-ct">${plural(list.length, 'source')}${on ? `, ${on} on` : ''}</span></h3><ul>${list.map((e) => srcRow(e, shown)).join('')}</ul></section>`;
  }).join('');
  return `<div class="scrim screen-only" data-act="sheet-close"></div>
  <div class="sheet-panel screen-only" role="dialog" aria-modal="true" aria-labelledby="sh-h">
    <div class="sheet-hd"><h2 id="sh-h">Every source on your ballot</h2><button class="closebtn" data-act="sheet-close" data-fk="sheet-x">Done</button></div>
    <div class="sheet-bd" data-keep="sheet">
      <p class="s-legend">On by default: newspapers and nonpartisan guides. Tap a switch to add or drop one.</p>
      <p class="small">Grouped by lean, which comes from outside ratings, the source’s party or the source’s own stated mission, never from whom it endorses.</p>
      ${empties.length ? `<p class="small muted">${esc(empties.join(' '))}</p>` : ''}
      <p class="row-btns"><button class="mini" data-act="src-default" data-fk="src-default">Reset to newspapers and guides</button><button class="mini quiet" data-act="src-none" data-fk="src-none">Turn all off</button></p>
      ${groups}
      ${unreadHTML(unread)}
      <div class="s-add"><p>Use a source we don’t have?</p><button class="mini" ${shelfAttrs({ kind: 'source', fk: 'src-add' })}>Add a source</button></div>
    </div></div>`;
}

/* ---------- the party chooser ---------- */
export function partySheetHTML(): string {
  const b = S.ballot!;
  const parties = partiesOnBallot(b);
  // Count races on this voter's ballot as it stands (no unopposed, no hidden districts), the
  // same choices the header counts.
  const mine = decisionItems().filter((i) => !i.question).map((i) => b.byId.get(i.id)).filter((x): x is Contest => !!x && x.kind === 'contest');
  const rows = parties.map((p) => {
    const n = mine.filter((c) => c.candidates.some((k) => k.parties.includes(p.party))).length;
    return `<li><button class="opt" data-act="party-set" data-p="${esc(p.party)}" data-fk="pty-${esc(p.party)}"><b>${esc(p.party)}</b>
      <small>${[p.sources.length ? `${plural(p.sources.length, 'party source')} with endorsements here` : 'No party endorsements found here', n ? `Has a candidate in ${n} of your ${plural(mine.length, 'race')}` : ''].filter(Boolean).join('. ')}</small></button></li>`;
  }).join('');
  return `<div class="scrim screen-only" data-act="sheet-close"></div>
  <div class="sheet-panel screen-only short" role="dialog" aria-modal="true" aria-labelledby="sh-h">
    <div class="sheet-hd"><h2 id="sh-h">Show a party’s endorsements</h2><button class="closebtn" data-act="sheet-close" data-fk="sheet-x">Cancel</button></div>
    <div class="sheet-bd">
      <p class="small">Not every party published endorsements here. Choosing one also lets you fill in its candidates in one tap, and you can undo it. Listed A to Z.</p>
      <ul class="opts">${rows}</ul>
    </div></div>`;
}
