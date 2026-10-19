/* "Who do you trust?": the lens head, the sticky chip bar, the "More sources" sheet and the
   party chooser. Lean labels show with their basis; parties are text; no red or blue. */
import type { Contest, Endorser } from '../types';
import { S } from '../state';
import { chosenIds, decisionItems } from '../ballot';
import { esc, plural } from '../util';
import { CHIPS, chipState, chipMembers, withPicks, partiesOnBallot, picksOnBallot, explainsOnly } from '../model/lens';
import { coverage } from '../model/tally';
import { leanHTML, sourceLean, ext, isOpen, paywallSourceHTML } from './common';

const TICK = '<svg class="tick" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M2 6.3l2.6 2.6L10 3.3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
const TYPE_WORD: Record<string, string> = {
  publication: 'Newspaper or newsroom', civic_nonpartisan: 'Nonpartisan civic group', party: 'Political party', advocacy: 'Issue group',
  labor: 'Union', business: 'Business group', elected_official: 'Officeholder', other: 'Other',
};

export function lensBarHTML(): string {
  const b = S.ballot!;
  const chips = CHIPS.map((c) => {
    const st = chipState(b, c.key);
    if (st === 'empty' && c.key !== 'papers') return '';
    const on = st === 'on' || st === 'some';
    return `<button class="chip${st === 'some' ? ' some' : ''}" data-act="chip" data-k="${c.key}" aria-pressed="${on}" data-fk="chip-${c.key}">${TICK}${esc(c.label)}</button>`;
  }).join('');
  const party = S.b.party;
  const parties = partiesOnBallot(b);
  const partyChip = parties.length ? `<button class="chip" data-act="${party ? 'party-off' : 'sheet'}" data-s="party" aria-pressed="${!!party}" data-fk="chip-party">${TICK}${party ? `${esc(party)} Party` : 'A party'}</button>` : '';
  const more = `<button class="chip more" data-act="sheet" data-s="sources" aria-haspopup="dialog" data-fk="chip-more">More sources</button>`;
  return `<div class="lensbar" id="lensbar" role="toolbar" aria-label="Whose picks to show"><div class="chipwrap"><div class="chips" data-keep="chips">${chips}${partyChip}${more}</div></div></div>`;
}
export function lensHeadHTML(): string {
  const b = S.ballot!;
  const cov = coverage();
  const notes: string[] = [];
  const papers = chipMembers(b, 'papers');
  const ids = new Set(chosenIds());
  if (papers.some((e) => ids.has(e.id)) && !withPicks(b, papers).length) notes.push(CHIPS[0].empty);
  // The chip row scrolls sideways on a phone, so say in words whose picks are showing.
  const showing = [
    ...CHIPS.filter((c) => ['on', 'some'].includes(chipState(b, c.key))).map((c) => `${chipState(b, c.key) === 'some' ? 'some ' : ''}${c.label.toLowerCase()}`),
    ...(S.b.party ? [`the ${S.b.party} Party`] : []),
  ];
  const list = showing.length > 1 ? `${showing.slice(0, -1).join(', ')} and ${showing[showing.length - 1]}` : showing[0] || '';
  const line = cov.sources
    ? `${list ? `Showing ${list}. ` : ''}Your ${plural(cov.sources, 'source')} made picks on ${cov.picked} of your ${plural(cov.total, 'choice')}.`
    : 'You haven’t chosen any sources. Pick some below to see their picks on every row.';
  return `<section class="lens-head wrap" id="lens" aria-labelledby="lens-h"><h2 id="lens-h">Who do you trust?</h2>
    <p>Their picks show on every row. The choice is always yours.</p>
    <p class="cov">${esc(line)}${notes.length ? ` ${esc(notes.join(' '))}` : ''}</p></section>`;
}
export const lensHTML = (): string => `${lensHeadHTML()}${lensBarHTML()}`;

/* ---------- the "More sources" sheet ---------- */
const GROUPS: [string, string][] = [['left', 'Left'], ['lean_left', 'Leans left'], ['neutral', 'Center'], ['lean_right', 'Leans right'], ['right', 'Right'], ['none', 'Not rated']];
const BASIS_KIND: Record<string, string> = { outside_rating: 'Rated by an outside group', party: 'A party', mission: 'From its mission statement' };
function srcRow(e: Endorser): string {
  const b = S.ballot!;
  const on = chosenIds().includes(e.id);
  const k = `basis-${e.id}`;
  const n = picksOnBallot(b, e.id);
  const what = explainsOnly(e) ? 'Explains, doesn’t pick' : n ? `Picks on ${plural(n, 'item')} here` : 'No picks found';
  return `<li class="srow">
    <div class="s-main"><span class="s-n" id="sn-${esc(e.id)}">${esc(e.name)}</span><span class="s-d">${esc(TYPE_WORD[e.type] || e.type)}. ${esc(what)}.</span>
      <span class="s-l">${sourceLean(e)}<button class="linkbtn" data-act="open" data-k="${esc(k)}" aria-expanded="${isOpen(k)}">How we know</button></span>
      ${isOpen(k) ? `<p class="s-b">${e.lean_basis_kind ? `<b>${esc(BASIS_KIND[e.lean_basis_kind])}.</b> ` : ''}${esc(e.lean_basis || 'No basis recorded, so we show it as not rated.')}${e.lean_note ? ` ${esc(e.lean_note)}` : ''}${e.guide_url ? ` ${ext(e.guide_url, 'Their guide')}` : ''}</p>` : ''}
      ${paywallSourceHTML(e)}</div>
    <button class="tg" role="switch" aria-checked="${on}" aria-labelledby="sn-${esc(e.id)}" data-act="src" data-id="${esc(e.id)}" data-fk="tg-${esc(e.id)}"><span></span></button></li>`;
}
export function sourcesSheetHTML(): string {
  const b = S.ballot!;
  const byCount = (a: Endorser, c: Endorser) => picksOnBallot(b, c.id) - picksOnBallot(b, a.id) || a.name.localeCompare(c.name);
  const empties = CHIPS.filter((c) => c.key !== 'papers' && chipState(b, c.key) === 'empty').map((c) => c.empty);
  const groups = GROUPS.map(([lean, word]) => {
    const list = b.endorsers.filter((e) => (e.lean || 'none') === lean).sort(byCount);
    if (!list.length) return '';
    const on = list.filter((e) => chosenIds().includes(e.id)).length;
    return `<section class="sgrp"><h3>${lean === 'none' ? '' : leanHTML(lean as Endorser['lean'], false)} ${esc(word)} <span class="s-ct">${plural(list.length, 'source')}${on ? `, ${on} on` : ''}</span></h3><ul>${list.map(srcRow).join('')}</ul></section>`;
  }).join('');
  return `<div class="scrim screen-only" data-act="sheet-close"></div>
  <div class="sheet-panel screen-only" role="dialog" aria-modal="true" aria-labelledby="sh-h">
    <div class="sheet-hd"><h2 id="sh-h">Every source on your ballot</h2><button class="closebtn" data-act="sheet-close" data-fk="sheet-x">Done</button></div>
    <div class="sheet-bd" data-keep="sheet">
      <p class="small">Grouped by lean, from outside ratings, official party status or a group’s own stated mission. Never from whom they endorse. Turn on anyone; their picks show on every row.</p>
      ${empties.length ? `<p class="small muted">${esc(empties.join(' '))}</p>` : ''}
      <p class="row-btns"><button class="mini" data-act="src-default">Back to papers and guides</button><button class="mini quiet" data-act="src-none">Turn all off</button></p>
      ${groups}
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
      <small>${[p.sources.length ? `${plural(p.sources.length, 'party source')} with picks here` : 'No party picks found here', n ? `Has a candidate in ${n} of your ${plural(mine.length, 'race')}` : ''].filter(Boolean).join('. ')}</small></button></li>`;
  }).join('');
  return `<div class="scrim screen-only" data-act="sheet-close"></div>
  <div class="sheet-panel screen-only short" role="dialog" aria-modal="true" aria-labelledby="sh-h">
    <div class="sheet-hd"><h2 id="sh-h">Which party?</h2><button class="closebtn" data-act="sheet-close" data-fk="sheet-x">Cancel</button></div>
    <div class="sheet-bd">
      <p class="small">Choosing one turns on that party’s own picks, where it published any, and lets you fill in its candidates in one tap. You can undo it. Listed A to Z.</p>
      <ul class="opts">${rows}</ul>
    </div></div>`;
}
