/* Every control is a data-act attribute dispatched through this table. Model mutations keep
   v2's pick vocabulary byte for byte (YES/NO/SKIP/DONE/PICK, candidate names, "id|name" keys),
   because the save link and saved picks depend on it. */
import type { Contest, Item } from './types';
import { S, persist, emptyBallotState, type View, type Shelf, type ShelfKind } from './state';
import { status, sectionOf, rankMax, ordinal, chosenIds, entriesBySection, pageWalk, sameSeat, OTH_KEY, type SectionKey } from './ballot';
import { toast, hideToast, copyText, announce, hash, plural } from './util';
import { render, renderRow, renderSection, renderSummaries, renderOff, renderLens, flushLens, markBehind, renderBallot, renderAddr, rowEl, scrollRowIntoView, rowTop, holdRow, opensLow, anchored, $ } from './render';
import { growOpen, inkRow, followFold, glideTo, land, stopGlide, shrinkAway, collapseRow, finishCollapse, glide } from './motion';
import { openBallot, openChosen, go, openReader, runAddress, reopenAddr, useMatch, toDoor, showBallot, rechoose, openSaved, fillWhy, leaveBallot, switchOnNow } from './app';
import { judgeBatch } from './model/judges';
import { planAgree, planParty, planJudges, planSetup, applyFills, undoFills, emptyPlan, touchUndo, type Plan } from './model/bulk';
import { toggleChip, setParty, setSources, noEndorsements, doorNone, chipState, unreadHere, CHIPS, type ChipKey } from './model/lens';
import { courtGroup } from './model/labels';
import { claimAnswer, claimOn, claimOff } from './model/address';
import { basisWords, LEANS, FORM, reportWhere } from './views/common';
import { reportBody, reportFallbackURL, requiredOf, isForm, collectAlong, askBody, PICKS_FOLD } from './views/shelf';
import { covOf } from './views/coverage';
import { rememberAsk } from './model/coverage';
import { cheatText, shareURL } from './views/cheat';
import { messages, shareData, GUIDE_URL, SHARE_TITLE } from './views/pass';
import { nextUp, sectionTally, sectionFolded, hiddenByOnly, qId } from './views/ledger';

export type Act = (d: DOMStringMap, el: HTMLElement) => void | Promise<void>;
export const A: Record<string, Act> = {};
const B = () => S.ballot!;

/* ---------- after a decision ---------- */
/* Under "Hide races I've decided" (Kevin, Oct 20: "give it like a beat, and then they collapse"): a
   row that closes decided shows its pick in gold for a beat, then folds away, the rows under it
   sliding up (motion.collapseRow); when it was the section's last, the section folds to its band
   instead, "5 of 5 decided", and the band is marked. Under reduced motion it just goes after the
   beat. Opening another row, a jump, the count, or a repaint of the whole ballot ends the beat at
   once, so nothing moves under the next tap. */
export const BEAT_MS = 900;
let beatTimer = 0;
/* A row that closed: give it its beat when the filter would now hide it. */
function startBeat(id: string): void {
  const it = B().byId.get(id);
  if (!it || !hiddenByOnly({ t: 'item', id }, sectionOf(it))) return;
  if (S.ui.beat && S.ui.beat !== id) endBeat();
  window.clearTimeout(beatTimer);
  S.ui.beat = id;
  beatTimer = window.setTimeout(() => endBeat(true), BEAT_MS);
}
/* For a repaint of the whole ballot (it draws the row gone): forget the beat. */
function dropBeat(): void {
  window.clearTimeout(beatTimer);
  S.ui.beat = null;
  finishCollapse();
}
/* The beat is over and the row leaves: folding away (`fold`, when the beat ran its course), or at
   once with what's on screen held still. A row reopened meanwhile, or the filter turned off,
   stays. */
function endBeat(fold = false): void {
  window.clearTimeout(beatTimer);
  finishCollapse();
  const id = S.ui.beat;
  if (!id) return;
  S.ui.beat = null;
  if (S.view !== 'ballot' || S.ui.view !== 'ballot' || !S.ballot) return;
  const it = B().byId.get(id);
  if (!it) return;
  const sec = sectionOf(it);
  const el = rowEl(id);
  if (!hiddenByOnly({ t: 'item', id }, sec)) { el?.removeAttribute('data-beat'); return; }
  const band = $(`#sec-${sec}`);
  const top = el ? el.getBoundingClientRect().top : -1;
  const refocus = focusAfter(el, sec);
  // Out of sight above or below, or nothing to watch: it just goes, the view held still.
  if (!fold || !el || !band || top < 0 || top > window.innerHeight) { anchored(() => renderSection(sec)); refocus(); return; }
  if (sectionFolded(sec, entriesBySection().get(sec) || [])) { foldDone(sec); refocus(); return; }
  collapseRow(el, () => { anchored(() => renderSection(sec)); refocus(); });
}
/* Focus on a row that leaves after a keyboard pick goes on to the row that takes its place, or to
   its section's band. After a tap it just goes with the row, so no focus ring lands on a row you
   didn't touch. */
let keyed = false;
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', () => { keyed = true; }, true);
  document.addEventListener('pointerdown', () => { keyed = false; }, true);
}
function focusAfter(el: HTMLElement | null, sec: SectionKey): () => void {
  if (!keyed || !el || !el.contains(document.activeElement)) return () => {};
  let n = el.nextElementSibling;
  while (n && !n.querySelector(':scope > [data-fk]')) n = n.nextElementSibling;
  const fk = n?.querySelector<HTMLElement>(':scope > [data-fk]')?.dataset.fk || `sec-${sec}`;
  return () => { if (!document.activeElement || document.activeElement === document.body) focusFk(document.querySelector(`[data-fk="${CSS.escape(fk)}"]`) ? fk : `sec-${sec}`); };
}
/* The last row of a section left under the filter: the band stays where it is and everything under
   it folds away together, then the band is marked. A band that had scrolled off the top comes back
   to the top instead, as a finished section does without the filter. */
function foldDone(sec: SectionKey): void {
  const el = $(`#sec-${sec}`)!;
  const hd = el.querySelector<HTMLElement>(':scope > .sec-h');
  const was = hd ? hd.getBoundingClientRect() : null;
  const body = [...el.children].filter((x) => x !== hd) as HTMLElement[];
  const h = was ? el.getBoundingClientRect().bottom - was.bottom : 0;
  const ghost = document.createElement('div');
  body.forEach((x) => ghost.appendChild(x));
  anchored(() => renderSection(sec), `sec-${sec}`);
  const now = $(`#sec-${sec}`);
  if (!now) return;
  if (was && was.top < 0) window.scrollBy(0, now.getBoundingClientRect().top);
  else shrinkAway(now.querySelector<HTMLElement>(':scope > .sec-h'), ghost, h, 'sec-gone');
  land(now);
}
/* A pick that closes its row: the panel folds up into the header, which stays where it is (or,
   when it had scrolled off the top, comes down into view as the panel folds, motion.followFold),
   and the tick draws itself in the box. */
function afterPick(id: string, close = true): void {
  touchUndo(id);
  const shut = close && S.ui.row === id;
  if (shut) { S.ui.row = null; S.ui.keep = id; startBeat(id); }
  const box = shut ? rowEl(id)?.getBoundingClientRect() : undefined;
  const fold = renderRow(id, true, shut);
  const it = B().byId.get(id);
  // A linked measure's row may sit above this one: this row stays where it is.
  if (it && it.kind === 'measure' && it.links.length) anchored(() => it.links.forEach((l) => renderRow(l)), rowEl(id)?.id);
  renderSummaries();
  persist();
  if (shut) {
    const el = rowEl(id);
    if (el && box) followFold(el, box, fold);
    inkRow(el);
    $(`[data-fk="row-${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  }
}

/* ---------- rows ---------- */
/* A tapped header stays exactly where it is on screen: closing, its panel folds up into it; opening,
   the row that was open closes at once (above it, the page scrolls by what it lost, in the same
   frame) and this one's panel grows open beneath it. A header tapped low on the screen, whose panel
   would open mostly out of sight, glides up to the top as the panel grows. A header out of view (a
   keyboard, a script) comes to the top first, as before. */
A.row = (d) => {
  const key = d.id!;
  const prev = S.ui.row;
  S.ui.keep = null;
  stopGlide();
  if (prev === key) {
    // Closed decided under "Hide races I've decided": the same beat as a pick.
    if (S.ui.beat !== key) endBeat();
    S.ui.row = null;
    if (!key.startsWith('q:')) startBeat(key);
    renderRow(key, false, true);
    return;
  }
  // Reopened in its beat, a row stays; any other row in its beat goes now, before this one opens,
  // and the header you tapped stays where it is (holdRow).
  if (S.ui.beat === key) { window.clearTimeout(beatTimer); S.ui.beat = null; }
  const top = rowTop(key);
  S.ui.row = key;
  endBeat();
  if (prev) renderRow(prev, false);
  renderRow(key, false);
  const el = rowEl(key);
  if (top === null) { if (el) window.scrollBy(0, el.getBoundingClientRect().top - 4); }
  else {
    holdRow(key, top);
    if (opensLow(key)) glideTo(el, 4);
  }
  growOpen(el);
};
/* The item behind a row key: an item id, or "q:<group key>" (its first district's race). */
const itemOfKey = (key: string): Item | undefined => {
  const b = B();
  if (!key.startsWith('q:')) return b.byId.get(key);
  const g = b.groups.find((x) => `q:${x.key}` === key);
  return g ? b.byId.get(g.members[0]) : undefined;
};
/* Open one row on the ballot from anywhere (a cheat-sheet line, a judge's name, the bar): an item
   id, or "q:<group key>" for a district question. Its section and court group unfold, and the row
   that was open closes, so a jump never leaves a trail of open rows behind it. */
function openAt(key: string): void {
  const it = itemOfKey(key);
  if (!it) return;
  endBeat();
  if (S.ui.view !== 'ballot') go('ballot');
  const sec = sectionOf(it);
  S.ui.folded.delete(sec);
  S.ui.unfolded.add(sec);
  if (it.kind === 'contest') S.ui.unfolded.add(`${sec}|${courtGroup(it)}`); // its court group, if the section folds into groups
  const prev = S.ui.row;
  S.ui.row = key;
  const prevIt = prev && prev !== key ? itemOfKey(prev) : undefined;
  if (prevIt && sectionOf(prevIt) !== sec) renderSection(sectionOf(prevIt));
  renderSection(sec);
  render(['bar']); // a race opened inside the other school districts' fold claims it, so the count may change
  // Glide there and mark it, so the eye lands on it.
  scrollRowIntoView(key, true, () => land(rowEl(key)));
  $(`[data-fk="row-${CSS.escape(key.startsWith('q:') ? rowEl(key)?.id || '' : key)}"]`)?.focus({ preventScroll: true });
}
A.goto = (d) => { openAt(d.q ? `q:${d.q}` : d.id!); };
/* The menu's "Next up": the race or question it names (nextUp: the next undecided one after the
   row you're on, in page order). A menu painted a moment ago may name one you've since decided;
   then it's the next one now. */
A.next = (d) => {
  const live = d.k ? pageWalk().find((x) => x.key === d.k && !x.done && !x.folded) : null;
  const key = live ? live.key : nextUp()?.key;
  closeMenu();
  if (key) openAt(key);
};
/* The menu: a sheet ("☰ 20 of 43" in the bar), or the rail from 1180px. */
A.toc = (_d, el) => {
  S.ui.sheetFrom = el.dataset.fk || 'bar-menu';
  S.ui.sheetBack = null;
  S.ui.sheet = 'toc';
  render(['sheet']);
  focusFk('sheet-x');
};
/* A jump goes somewhere else on the page, so the menu sheet closes first, without handing focus
   back to the bar: the place you jump to takes it. */
function closeMenu(): void {
  if (S.ui.sheet !== 'toc') return;
  S.ui.sheet = null;
  render(['sheet']);
  flushLens();
}
/* A menu row: your next step, or a section. The section unfolds, comes to the top and takes focus.
   Under "Hide races I've decided" a finished section opens with its decided rows showing, as its
   count does; the filter stays on. */
A.jump = (d, el) => {
  // "How this guide works" opens the shelf (Kevin, Oct 21), in the menu's place when it came from there.
  if (d.to === 'how') { A.shelf({ kind: 'how' }, el); return; }
  closeMenu();
  endBeat();
  if (S.ui.view !== 'ballot') go('ballot');
  if (d.to === 'plan') {
    glideTo($('#plan'), 12);
    focusFk('plan-k');
    return;
  }
  const sec = d.to as SectionKey;
  const entries = entriesBySection().get(sec) || [];
  const t = sectionTally(entries);
  const wasFolded = !!$(`#sec-${sec}.folded`);
  S.ui.folded.delete(sec);
  S.ui.unfolded.add(sec);
  if (S.b.hideDecided && t.total > 0 && t.done === t.total) S.ui.reveal.add(sec);
  if (wasFolded || !$(`#sec-${sec}`)) renderSection(sec);
  glideTo($(`#sec-${sec}`), 0, () => land($(`#sec-${sec}`)));
  focusFk(`sec-${sec}`);
};
A.page = (d) => { S.ui.page[d.id!] = Number(d.v); renderRow(d.id!); $(`[data-fk="pg-${CSS.escape(d.id!)}"]`)?.focus({ preventScroll: true }); };
A.others = (d) => { const k = d.id!; S.ui.others.has(k) ? S.ui.others.delete(k) : S.ui.others.add(k); renderRow(k); };
A.sec = (d, btn) => {
  const s = d.sec as SectionKey;
  // A row in its beat goes first, with the band you tapped held where it is (it may sit under it).
  anchored(() => endBeat(), `sec-${s}`);
  const el = $(`#sec-${s}`);
  const folded = !!el && el.classList.contains('folded');
  // Under "Hide races I've decided" a folded band opens as its count does: with its decided rows.
  if (folded && S.b.hideDecided) { A['sec-count'](d, btn); focusFk(`sec-${s}`); return; }
  // A section still being decided doesn't fold on a stray tap; the band takes you to its next
  // undecided row instead.
  if (!folded && el && el.querySelector('.row[data-undecided], .row[data-q]')) {
    const next = el.querySelector<HTMLElement>('.row[data-undecided], .row[data-q]')!;
    if (next.dataset.item) { A.goto({ id: next.dataset.item }, next); return; }
    const key = `q:${next.dataset.q}`;
    S.ui.row = key;
    anchored(() => renderSection(s), `sec-${s}`);
    scrollRowIntoView(key, true, () => land(rowEl(key)));
    return;
  }
  if (folded) { S.ui.folded.delete(s); S.ui.unfolded.add(s); } else { S.ui.unfolded.delete(s); S.ui.folded.add(s); if (S.ui.row && B().byId.get(S.ui.row) && sectionOf(B().byId.get(S.ui.row)!) === s) S.ui.row = null; }
  glide([`#sec-${s}`, `#sec-${s} > .sec-h`], () => anchored(() => renderSection(s), `sec-${s}`));
  persist(); // the sections as you left them come back after a reload
};
/* A band's count ("2 of 5 decided", ledger countHTML): under "Hide races I've decided" it shows or
   hides the section's decided rows (a folded band opens with them); otherwise it folds or unfolds
   the section, even one still being decided. The band stays where it is. The choice is saved with
   the ballot (S.b.secs, by persist), so a reload shows the sections as you left them. */
A['sec-count'] = (d) => {
  const s = d.sec as SectionKey;
  anchored(() => endBeat(), `sec-${s}`);
  const el = $(`#sec-${s}`);
  const folded = !!el && el.classList.contains('folded');
  const entries = entriesBySection().get(s) || [];
  if (S.b.hideDecided && sectionTally(entries).total > 0) {
    if (folded) { S.ui.folded.delete(s); S.ui.reveal.add(s); }
    else if (S.ui.reveal.has(s)) S.ui.reveal.delete(s);
    else S.ui.reveal.add(s);
  } else if (folded) { S.ui.folded.delete(s); S.ui.unfolded.add(s); }
  else {
    S.ui.unfolded.delete(s); S.ui.folded.add(s);
    const open = S.ui.row ? itemOfKey(S.ui.row) : undefined;
    if (open && sectionOf(open) === s) S.ui.row = null;
  }
  glide([`#sec-${s}`, `#sec-${s} > .sec-h`], () => anchored(() => renderSection(s), `sec-${s}`));
  // The other school districts' fold may have opened or closed with it: the counts follow.
  renderSummaries();
  persist();
};
A.grp = (d) => {
  const k = d.g!;
  const el = document.querySelector<HTMLElement>(`[data-act="grp"][data-g="${CSS.escape(k)}"]`);
  const open = el?.getAttribute('aria-expanded') === 'true';
  if (open) S.ui.unfolded.delete(k); else S.ui.unfolded.add(k);
  const s = k.split('|')[0] as SectionKey;
  glide([`#sec-${s}`, `#sec-${s} > .sec-h`], () => anchored(() => renderSection(s), `sec-${s}`));
  // Opening the other school districts' fold claims its races, so the count changes.
  if (k === OTH_KEY) renderSummaries();
  persist();
};

/* ---------- picks ---------- */
A.pick = (d) => {
  const id = d.id!;
  S.b.picks[id] = d.v!;
  delete S.b.auto[id];
  afterPick(id);
};
A.skip = (d) => {
  const id = d.id!;
  const it = B().byId.get(id);
  if (S.b.picks[id] === 'SKIP') delete S.b.picks[id];
  else {
    S.b.picks[id] = 'SKIP';
    if (it && it.kind === 'contest') { delete S.b.ranks[id]; it.candidates.forEach((c) => { delete S.b.picks[`${id}|${c.name}`]; }); }
  }
  delete S.b.auto[id];
  afterPick(id, S.b.picks[id] === 'SKIP');
};
A.clear = (d) => {
  const id = d.id!;
  const it = B().byId.get(id);
  delete S.b.picks[id]; delete S.b.auto[id]; delete S.b.ranks[id];
  if (it && it.kind === 'contest') it.candidates.forEach((c) => { delete S.b.picks[`${id}|${c.name}`]; });
  afterPick(id, false);
  $(`#i-${CSS.escape(id)} .ob [data-act]`)?.focus({ preventScroll: true });
};
A.jpick = (d) => {
  const k = d.k!; const id = k.split('|')[0];
  if (S.b.picks[k] === d.v) delete S.b.picks[k]; else S.b.picks[k] = d.v!;
  if (S.b.picks[id] === 'SKIP') delete S.b.picks[id];
  delete S.b.auto[id];
  afterPick(id, false);
};
A.mpick = (d) => {
  const id = d.id!; const k = `${id}|${d.v}`;
  const c = B().byId.get(id) as Contest;
  if (S.b.picks[k] === 'PICK') delete S.b.picks[k];
  else {
    const n = c.candidates.filter((x) => S.b.picks[`${id}|${x.name}`] === 'PICK').length;
    if (n >= c.vote_for) { toast(`You can pick up to ${c.vote_for}. Remove one first.`); return; }
    S.b.picks[k] = 'PICK';
  }
  if (S.b.picks[id] === 'SKIP' || S.b.picks[id] === 'DONE') delete S.b.picks[id];
  delete S.b.auto[id];
  const full = c.candidates.filter((x) => S.b.picks[`${id}|${x.name}`] === 'PICK').length >= c.vote_for;
  afterPick(id, full);
};
A.mdone = (d) => { S.b.picks[d.id!] = 'DONE'; afterPick(d.id!); };

/* ---------- ranked choice ----------
   Tap a candidate to give them the next rank; tap again (or Remove) to take them out, and the
   ranks below move up. Move up swaps a row with the one above it. The row stays open while the
   voter works, even once every rank is used; "Done ranking" closes it. */
const shortOf = (c: Contest, name: string): string => (c.candidates.find((k) => k.name === name) || { short: name }).short;
function setRanks(id: string, list: string[]): void {
  if (list.length) S.b.ranks[id] = list;
  else { delete S.b.ranks[id]; if (S.b.picks[id] === 'DONE') delete S.b.picks[id]; }
  if (S.b.picks[id] === 'SKIP') delete S.b.picks[id];
  delete S.b.auto[id];
  afterPick(id, false);
}
const focusFk = (fk: string): void => { document.querySelector<HTMLElement>(`[data-fk="${CSS.escape(fk)}"]`)?.focus({ preventScroll: true }); };
/* Back to the control that opened a sheet, or, when the sheet took it away (the source count goes with the
   last source turned off, by "Turn all off" or one switch at a time; Codex, Oct 26), to "Show endorsements",
   which leads step 2 and the Edit sheet, then the ballot head's Edit, then step 2's heading. Never a control
   behind an open sheet. */
function focusBack(fk: string | null): void {
  for (const k of [fk, 'ends', 'picks-edit', 'su-h']) {
    if (!k) continue;
    const el = [...document.querySelectorAll<HTMLElement>(`[data-fk="${CSS.escape(k)}"]`)].find((x) => x.getClientRects().length && !x.closest('[inert]'));
    if (el) { el.focus({ preventScroll: true }); return; }
  }
}
A.rank = (d) => {
  const id = d.id!; const name = d.v!;
  const c = B().byId.get(id) as Contest;
  const list = [...(S.b.ranks[id] || [])];
  const at = list.indexOf(name);
  if (at >= 0) {
    list.splice(at, 1);
    setRanks(id, list);
    announce(`Removed ${shortOf(c, name)}.${list[at] ? ` ${shortOf(c, list[at])} is now ${ordinal(at + 1)}.` : ''}`);
    return;
  }
  const max = rankMax(c);
  if (list.length >= max) { toast(`You’ve ranked ${max}, the most ${max === c.rank_up_to ? 'this ballot allows' : 'there are'}. Remove one first.`); return; }
  list.push(name);
  setRanks(id, list);
  announce(`${shortOf(c, name)} ranked ${ordinal(list.length)}.`);
};
A.rx = (d) => {
  const id = d.id!; const name = d.v!;
  const c = B().byId.get(id) as Contest;
  const list = [...(S.b.ranks[id] || [])];
  const at = list.indexOf(name);
  if (at < 0) return;
  list.splice(at, 1);
  setRanks(id, list);
  announce(`Removed ${shortOf(c, name)}.${list[at] ? ` ${shortOf(c, list[at])} is now ${ordinal(at + 1)}.` : ''}`);
  const next = list[at] || list[at - 1];
  if (next) focusFk(`rx-${id}-${hash(next, 4)}`);
  else document.querySelector<HTMLElement>(`#i-${CSS.escape(id)} [data-act="rank"]`)?.focus({ preventScroll: true });
};
A.rup = (d) => {
  const id = d.id!; const name = d.v!;
  const c = B().byId.get(id) as Contest;
  const list = [...(S.b.ranks[id] || [])];
  const at = list.indexOf(name);
  if (at <= 0) return;
  [list[at - 1], list[at]] = [list[at], list[at - 1]];
  setRanks(id, list);
  announce(`${shortOf(c, name)} moved up to ${ordinal(at)}.`);
  if (at - 1 === 0) focusFk(`rx-${id}-${hash(name, 4)}`);
};
A.rdone = (d) => {
  const id = d.id!;
  if (!(S.b.ranks[id] || []).length) return;
  S.b.picks[id] = 'DONE';
  afterPick(id);
};

/* ---------- notes ---------- */
A.note = (d) => { S.ui.noteOpen.add(d.id!); renderRow(d.id!); $(`[data-note="${CSS.escape(d.id!)}"]`)?.focus(); };

/* ---------- districts and "May apply" ---------- */
A.district = (d) => {
  const g = B().groups.find((x) => x.key === d.g)!;
  claimAnswer(S.b, g.key, d.v!); // your answer now, not the address's (model/address.ts)
  // Answering swaps the question for that district's race, opened, in the same place. "Not sure"
  // shows them all; "Not in any of these" leaves one line saying so, with Change.
  const one = d.v !== '*' && d.v !== 'none';
  S.ui.row = one ? d.v! : null;
  const sec = sectionOf(B().byId.get(g.members[0])!);
  anchored(() => renderSection(sec));
  renderSummaries();
  persist();
  if (one) scrollRowIntoView(d.v!);
  else if (d.v === 'none') { toast('Moved to “Not on your ballot” at the bottom.'); focusFk('off'); }
};
A['district-change'] = (d) => {
  const g = B().groups.find((x) => x.key === d.g)!;
  const ans = S.b.districts[g.key];
  claimAnswer(S.b, g.key, null); // asked again, by you: a late map of this lookup won't answer it
  if (ans && ans !== '*' && ans !== 'none') {
    // Everything the answer showed: a Washington district's two House seats come from one answer.
    const a = B().byId.get(ans);
    for (const id of [ans, ...g.members.filter((m) => sameSeat(a, B().byId.get(m)))]) {
      for (const k of Object.keys(S.b.picks)) if (k === id || k.startsWith(`${id}|`)) delete S.b.picks[k];
      for (const k of Object.keys(S.b.auto)) if (k === id || k.startsWith(`${id}|`)) delete S.b.auto[k];
      delete S.b.ranks[id];
      touchUndo(id);
    }
  }
  S.ui.row = `q:${g.key}`;
  renderSection(sectionOf(B().byId.get(g.members[0])!));
  renderSummaries();
  persist();
  scrollRowIntoView(`q:${g.key}`);
  focusFk(`row-${qId(g)}`); // its Change, or the bottom list's button, is gone: the question it asks again
};
A.notmine = (d) => {
  const b = B();
  const it = b.byId.get(d.id!)!;
  // "Hide all like this": the same scope (a race) or the same district (a measure), same kind.
  const scope = (x: Item | undefined) => (!x ? null : x.kind === 'contest' ? `c|${x.scope_plain}` : `m|${x.jurisdiction}`);
  // A race your address put on your ballot stays (model/address.ts).
  const ids = d.all ? [...b.mayApply].filter((id) => scope(b.byId.get(id)) === scope(it) && !(S.b.mine || []).includes(id)) : [d.id!];
  claimOff(S.b, ids); // yours now, not the address's
  if (S.ui.row && ids.includes(S.ui.row)) S.ui.row = null;
  const sec = sectionOf(it);
  glide([`#sec-${sec}`, '#r-off'], () => anchored(() => renderSection(sec)));
  renderSummaries();
  persist();
  // It leaves its section for the list at the bottom: say where it went.
  toast(ids.length > 1 ? `Moved ${ids.length} ${it.kind === 'measure' ? 'measures' : 'races'} to “Not on your ballot” at the bottom.` : 'Moved to “Not on your ballot” at the bottom.');
};
/* "None of these are on my ballot" for the other school districts' races, all at once. */
A['notmine-oth'] = () => {
  const b = B();
  // The fold's races: a race on your ballot (`mine`) stands outside it (ballot.ts otherSchools).
  const ids = [...b.mayApply].filter((id) => { const it = b.byId.get(id); return !!it && it.kind === 'contest' && sectionOf(it) === 'school' && !b.groupOf[id] && !(S.b.mine || []).includes(id); });
  claimOff(S.b, ids);
  if (S.ui.row && ids.includes(S.ui.row)) S.ui.row = null;
  S.ui.unfolded.delete('school|oth');
  anchored(() => renderSection('school'));
  renderSummaries();
  persist();
  toast(`Moved ${plural(ids.length, 'race')} to “Not on your ballot” at the bottom.`);
};
/* "It's on my ballot", from the "Not on your ballot" list: back in its section, where the page goes,
   as a race on your ballot (`mine`), so no later pass of a lookup or corrected address takes it off
   again. It stands as its own row, outside the other school districts' fold, with "Not on my ballot"
   as the way back (views/open.ts). */
A['notmine-undo'] = (d) => {
  claimOn(S.b, d.id!);
  const sec = sectionOf(B().byId.get(d.id!)!);
  renderSection(sec);
  renderSummaries();
  persist();
  scrollRowIntoView(d.id!);
  focusFk(`row-${d.id}`);
};

/* ---------- the lens ----------
   Chips and sources apply as you tap. On the ballot they live in the Edit sheet, and the ballot
   behind it repaints when the sheet closes (render.ts flushLens). */
/* On the first page a chip is a choice kept in memory (S.door) and, once the ZIP has found a ballot,
   that ballot's sources too, so its counts follow. */
const doorBallot = (): boolean => S.view === 'setup' && !!S.ballot;
A.chip = (d) => {
  const k = d.k as ChipKey;
  if (S.view !== 'ballot') {
    const on = doorBallot() ? toggleChip(B(), k) : !S.door.chips[k];
    S.door.chips[k] = on;
    S.ui.lensEmptied = !on; // the chips stay on screen even when that was the last one
    render(['mast']);
    announce(on ? 'Turned on.' : 'Turned off.');
    return;
  }
  const on = toggleChip(B(), k);
  S.ui.lensEmptied = !on;
  renderLens(); persist();
  announce(on ? 'Turned on.' : 'Turned off.');
};
A['party-off'] = () => {
  S.ui.lensEmptied = true;
  if (S.view !== 'ballot') { S.door.party = null; if (doorBallot()) setParty(B(), null); render(['mast']); return; }
  setParty(B(), null); renderLens(); persist();
};
A['party-set'] = (d) => {
  S.ui.lensEmptied = false;
  if (S.view !== 'ballot') {
    S.door.party = d.p!;
    if (doorBallot()) setParty(B(), d.p!);
    S.ui.open.delete('su-party');
    render(['mast']);
    focusFk('chip-party');
    return;
  }
  setParty(B(), d.p!);
  persist();
  // Chosen from the Edit sheet: back to it, with the party on.
  if (S.ui.sheetBack !== null) { backToPicks(true); return; }
  S.ui.sheet = null;
  render(['sheet']);
  renderLens();
  toast(`Now showing the ${d.p} Party’s endorsements.`);
};
/* On the first page the sources sheet (its count opened it, Oct 25) changes the found ballot's list, and the
   choices kept for the next ZIP follow the chips that list now makes. */
function doorFollows(): void {
  if (!doorBallot()) return;
  for (const c of CHIPS) S.door.chips[c.key] = ['on', 'some'].includes(chipState(B(), c.key));
  S.door.party = S.b.party;
}
A.src = (d) => {
  const b = B();
  const cur = chosenIds();
  let next = cur.includes(d.id!) ? cur.filter((x) => x !== d.id) : [...cur, d.id!];
  // A source under "Couldn't read" has no switch, so once every switch is off it goes too: all off is off,
  // not a paywalled paper left on where nobody can see it (Codex, Oct 26).
  if (!next.some((id) => { const e = b.eById.get(id); return !!e && !unreadHere(b, e); })) next = [];
  setSources(b, next);
  // The last one off by hand is choosing again, not "Show endorsements" off: the chips stay.
  S.ui.lensEmptied = noEndorsements();
  doorFollows();
  persist();
  renderLens();
};
A['src-default'] = () => { S.b.sources = null; S.b.party = null; S.ui.lensEmptied = false; doorFollows(); persist(); renderLens(); };
/* "Show endorsements" (step 2 and the Edit sheet), on to start. Off: every source off and no party, so
   every row shows just the choices; the save link carries it as an empty source list. On again, the
   newspapers and guides come back. */
A.ends = () => {
  S.ui.lensEmptied = false;
  if (S.view !== 'ballot') {
    // With a ballot found, the switch shows that ballot's choice (it may have its own): turn that over.
    const off = doorBallot() ? !noEndorsements() : !doorNone();
    S.door.chips = { papers: !off, progressive: false, conservative: false };
    S.door.party = null;
    if (off) S.door.fill = false;
    else if (!S.door.fillSet) S.door.fill = !(doorBallot() && S.b.setupDone); // back to its default
    S.ui.open.delete('su-party');
    if (doorBallot()) { S.b.sources = off ? [] : null; S.b.party = null; }
    glide(['#setup'], () => render(['mast']));
    announce(off ? 'Turned off.' : 'Turned on.');
    return;
  }
  const off = !noEndorsements();
  S.b.sources = off ? [] : null;
  S.b.party = null;
  if (off) S.ui.setupFill = false;
  renderLens(); persist();
  announce(off ? 'Turned off.' : 'Turned on.');
};
A['src-none'] = () => { S.b.sources = []; S.b.party = null; S.ui.lensEmptied = false; doorFollows(); persist(); renderLens(); };
/* All sources or a party. Opened from the Edit sheet, it goes back there when it closes. */
A.sheet = (d, el) => {
  S.ui.sheetBack = S.ui.sheet === 'picks' ? S.ui.sheetFrom || '' : null;
  S.ui.sheet = d.s as 'sources' | 'party';
  S.ui.sheetFrom = el.dataset.fk || null;
  render(['sheet']);
  focusFk('sheet-x');
};
function backToPicks(lensChanged = false): void {
  const from = S.ui.sheetFrom;
  S.ui.sheet = 'picks';
  S.ui.sheetFrom = S.ui.sheetBack || null;
  S.ui.sheetBack = null;
  if (lensChanged) renderLens(); else render(['sheet']);
  if (from) focusBack(from);
}
/* "Endorsements: ... · Edit" and the menu's "Quick picks": step 2's controls in a sheet. The fill switch
   starts off each time; "Hide races I've decided" shows where the ballot is now. */
A.picks = (_d, el) => {
  S.ui.sheetFrom = S.ui.sheet === 'toc' ? 'bar-menu' : el.dataset.fk || null;
  S.ui.sheetBack = null;
  S.ui.setupFill = false;
  S.ui.setupOnly = S.b.hideDecided;
  S.ui.sheet = 'picks';
  render(['sheet']);
  focusFk('sheet-x');
};
/* The Edit sheet closes (Done, the scrim, Escape) and its switches take effect: one batch of fills
   (the party's candidates, then where your sources agree) for one Undo, and the filter. */
function closePicks(): void {
  const plan = S.ui.setupFill ? planSetup(S.b.party) : null;
  const only = S.ui.setupOnly;
  S.ui.sheet = null;
  S.ui.setupFill = false;
  render(['sheet']);
  const n = plan && plan.fills.length ? applyFills(plan.fills) : 0;
  if (n) { S.ui.bulk = String(n); S.ui.bulkWhy = plan ? fillWhy(plan) : null; S.ui.row = null; S.ui.keep = null; }
  if (n || only !== S.b.hideDecided) dropBeat();
  const onlyChanged = only !== S.b.hideDecided;
  if (onlyChanged) { S.b.hideDecided = only; S.ui.keep = null; }
  flushLens(!!n || onlyChanged);
  persist();
  if (S.ui.sheetFrom) focusFk(S.ui.sheetFrom);
  if (n && plan) fillToast(fillHead(n, plan), setupPlan(plan));
}
A['sheet-close'] = () => {
  const was = S.ui.sheet;
  if (was === 'shelf') { closeShelf(); return; }
  if (was === 'picks') { closePicks(); return; }
  if ((was === 'sources' || was === 'party') && S.ui.sheetBack !== null) { backToPicks(); return; }
  S.ui.sheet = null;
  render(['sheet']);
  flushLens();
  if (S.ui.sheetFrom) focusBack(S.ui.sheetFrom);
};

/* ---------- the shelf (views/shelf.ts): the list of cities, How this guide works, Report a problem,
   Request a city, Support ----------
   One sheet from every place that offers it: the foot, the menu, an open row and its Full details, a
   paywalled source's "Send it to us", the statewide-only note and the first page's "not covered". It
   opens over the sheet it came from (all sources) and goes back to it; from the menu it takes the
   menu's place, as Quick picks does; over Full details, which waits behind it. */
A.shelf = (d, el) => {
  const from = S.ui.sheet;
  openShelf((d.kind || 'report') as ShelfKind, d, from === 'toc' ? 'bar-menu' : el.dataset.fk || '',
    from && from !== 'toc' && from !== 'shelf' ? { sheet: from, from: S.ui.sheetFrom, back: S.ui.sheetBack } : null);
};
function openShelf(kind: ShelfKind, d: DOMStringMap, fk: string, back: Shelf['back']): void {
  const form = isForm(kind);
  const r: Shelf = {
    kind,
    f: kind === 'city' ? (d.hint === 'follow' ? { reach: '' } : { city: '', zip: S.ballot && S.view === 'ballot' ? S.b.zip : S.zip || S.coverage?.zip || '', reach: '' }) : kind === 'report' ? { wrong: '', reach: '' }
      : kind === 'source' ? { src: '', where: reportWhere(), picks: '', reach: '' } : {},
    what: d.what || '', tag: d.tag || '', hint: d.hint || '',
    // What a form sends along is read now, from the page it was opened on (never the address box or the hash).
    along: form ? collectAlong() : { page: '', where: '', url: '', data: '', build: '', device: '', errors: [] },
    state: 'edit', err: false, fk, back,
  };
  S.ui.report = r;
  S.ui.sheet = 'shelf';
  // Add a source opens with its paste box folded, every time.
  if (kind === 'source') S.ui.open.delete(PICKS_FOLD);
  render(['sheet']);
  // In a form, a keyboard or a mouse lands in the box to type in; a touch lands on the sheet's Cancel,
  // so the phone's keyboard doesn't jump up over the sheet as it slides in. Elsewhere, on Close.
  focusSoon(form && !document.documentElement.classList.contains('touch') ? `rf-${requiredOf(r)}` : 'sheet-x', '#r-sheet');
}
/* Focus a control now, and again just after this tap if it didn't hold: a mouse's pointerdown fires the
   action, and the mousedown after it moves focus to the control under the pointer, which the sheet
   has just made inert (or taken away), so focus would fall to the page. `inside`: it held if focus is
   anywhere in there. */
function focusSoon(fk: string, inside = ''): void {
  focusFk(fk);
  window.setTimeout(() => {
    const a = document.activeElement;
    const held = a && a !== document.body && (inside ? !!a.closest(inside) : (a as HTMLElement).dataset?.fk === fk);
    if (!held) focusFk(fk);
  }, 0);
}
/* Cancel, Close, Done, the scrim or Escape: what you typed goes with the sheet. */
function closeShelf(): void {
  const r = S.ui.report;
  S.ui.report = null;
  const back = r && r.back;
  S.ui.sheet = back ? back.sheet : null;
  if (back) { S.ui.sheetFrom = back.from; S.ui.sheetBack = back.back; }
  render(['sheet']);
  if (!S.ui.sheet && !S.ui.reader) flushLens();
  if (r && r.fk) focusSoon(r.fk);
}
/* Typing: kept with the open sheet (a repaint mustn't lose it), the fallback link follows it, and the
   "say what's wrong first" line goes once there is something. The ZIP takes digits only. */
export function reportInput(el: HTMLInputElement | HTMLTextAreaElement): void {
  const r = S.ui.report;
  const k = el.dataset.rf;
  if (!r || !k || !isForm(r.kind)) return;
  if (k === 'zip') el.value = el.value.replace(/\D/g, '').slice(0, 5);
  r.f[k] = el.value;
  const url = reportFallbackURL(r);
  document.querySelectorAll<HTMLAnchorElement>('#r-sheet a[data-rp-alt]').forEach((a) => { a.href = url; });
  if (r.err && k === requiredOf(r) && el.value.trim()) {
    r.err = false;
    document.getElementById('rf-err')?.remove();
    el.removeAttribute('aria-invalid');
    const desc = (el.getAttribute('aria-describedby') || '').replace('rf-err', '').trim();
    if (desc) el.setAttribute('aria-describedby', desc); else el.removeAttribute('aria-describedby');
  }
}
/* Send: the one required question first, then a POST to the form's own submit address. The answer is
   opaque (no-cors: Google doesn't let a page read it), so "sent" means the request went out, which
   is reliable in practice. A request refused outright says "That didn't send."; one with no answer in
   15 seconds says "Couldn't confirm it sent." (it may have arrived). Both offer the form in a new
   tab, prefilled with what you typed, and Send again. No cookies go with it. While it's out the
   button reads "Sending...", the fields are read-only and sending again does nothing. A sheet closed
   mid-send says how it went in a toast. */
const SEND_MS = 15_000;
async function postForm(body: Record<string, string>): Promise<'sent' | 'failed' | 'unsure'> {
  const ctl = new AbortController();
  let late = false;
  const timer = window.setTimeout(() => { late = true; ctl.abort(); }, SEND_MS);
  let ok = true;
  try {
    await fetch(FORM.post, { method: 'POST', mode: 'no-cors', credentials: 'omit', referrerPolicy: 'no-referrer', body: new URLSearchParams(body), signal: ctl.signal });
  } catch { ok = false; }
  window.clearTimeout(timer);
  return ok ? 'sent' : late ? 'unsure' : 'failed';
}
export async function sendReport(): Promise<void> {
  const r = S.ui.report;
  if (!r || !isForm(r.kind) || r.state === 'sending' || r.state === 'sent') return;
  const need = requiredOf(r);
  if (!(r.f[need] || '').trim()) {
    // Send sits at the bottom of a sheet you may have scrolled: bring the box and its line back into view.
    r.err = true;
    render(['sheet']);
    const box = document.getElementById(`rf-${need}`);
    box?.focus({ preventScroll: true });
    box?.closest('.rp-f')?.scrollIntoView({ block: 'nearest' });
    return;
  }
  r.err = false;
  r.state = 'sending';
  render(['sheet']);
  const state = await postForm(reportBody(r));
  const ok = state === 'sent';
  if (S.ui.report !== r || S.ui.sheet !== 'shelf') {
    toast(state === 'sent' ? 'Sent. Kevin reads every one.' : state === 'unsure' ? 'Couldn’t confirm your report sent.' : 'That didn’t send. Try again in a moment.');
    return;
  }
  r.state = state;
  render(['sheet']);
  focusFk(ok ? 'report-done' : 'report-send');
}

/* ---------- one tap: "Ask Kevin to add my city", "Ask Kevin to look for local picks" (views/coverage.ts) ----------
   The coverage card's button posts the form's five answers with nothing typed (shelf.askBody), the way a
   sent form does. Sent, it's remembered on this device (model/coverage.ts rememberAsk): the card keeps its
   slot, says "Request sent." with the day, and focus moves to its lead, so the change is heard as well as
   seen. Refused or unanswered, the button comes back with the form in a new tab under it. The card lives
   in step 1 on the first page and under the masthead on the ballot, where the quiet line in the head and
   the address box's weights follow it. */
function repaintCov(): void {
  if (S.view !== 'ballot') { render(['mast']); return; }
  anchored(() => render(['restore']));
  renderAddr();
}
A['cov-ask'] = async () => {
  const c = covOf();
  if (!c || !c.ask || c.state !== 'none' || S.ui.covAsk === 'sending') return;
  const ask = c.ask;
  S.ui.covAsk = 'sending';
  repaintCov();
  const state = await postForm(askBody(ask, collectAlong()));
  S.ui.covAsk = state === 'sent' ? '' : state;
  if (state === 'sent') rememberAsk(ask.key);
  repaintCov();
  focusFk(state === 'sent' ? 'cov-lead' : 'cov-ask');
};

/* Support's "send the guide to a friend": Help friends vote when a ballot is showing (the shelf gives
   way to it); elsewhere the guide's own link, through the phone's share sheet or copied. */
A['shelf-share'] = async () => {
  if (S.ballot && S.view === 'ballot') {
    S.ui.report = null;
    S.ui.sheet = null;
    if (S.ui.view !== 'pass') { go('pass'); return; }
    render(['sheet']);
    glideTo($('#pass'), 0);
    focusFk('share-guide');
    return;
  }
  const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
  if (typeof nav.share === 'function') {
    try { await nav.share({ title: SHARE_TITLE, url: GUIDE_URL }); return; } catch (e) { if (e && (e as Error).name === 'AbortError') return; }
  }
  if (await copyText(GUIDE_URL)) toast('Link copied. Send it to a friend.');
  else toast(`Copy didn’t work here. The guide’s link is ${GUIDE_URL}`);
};

/* ---------- bulk fills, each undone as a batch ---------- */
/* The toast after a fill: what landed, what was skipped and why, and Undo. Step 2's "Show my
   ballot", the Edit sheet and the judges' button share it. */
function fillToast(head: string, plan: Plan): void {
  const extra = [
    plan.single ? `${plan.single} of those come from just one source.` : '',
    plan.skippedTwo ? `Skipped ${plural(plan.skippedTwo, 'race')} where the party has more than one candidate.` : '',
    plan.skippedRanked ? `Skipped ${plural(plan.skippedRanked, 'ranked-choice race')}; rank those yourself.` : '',
    plan.skippedPartial ? `Left ${plural(plan.skippedPartial, 'race')} you started for you to finish.` : '',
  ].filter(Boolean).join(' ');
  toast(`${head} ${extra}`.trim(), { label: 'Undo', act: 'undo-bulk' });
}
type SetupPlan = ReturnType<typeof planSetup>;
const fillHead = (n: number, plan: SetupPlan): string => {
  const p = plan.party ? plan.party.fills.length : 0;
  const a = plan.agree.fills.length;
  return `Filled ${plural(n, 'pick')}${p ? ` with ${S.b.party} candidates` : ''}${p && a ? ' and' : ''}${a ? ' where your sources agree' : ''}.`;
};
const setupPlan = (plan: SetupPlan): Plan => {
  const pp = plan.party || emptyPlan();
  return { fills: plan.fills, single: plan.agree.single, skippedTwo: pp.skippedTwo, skippedRanked: pp.skippedRanked, skippedPartial: pp.skippedPartial + plan.agree.skippedPartial };
};
A.bulk = (d) => {
  const k = d.k!;
  let plan: Plan;
  if (k === 'agree') plan = planAgree();
  else if (k === 'party') plan = S.b.party ? planParty(S.b.party) : emptyPlan();
  else plan = planJudges();
  // For judges, how many in the batch the review flagged, counted before the batch lands.
  const jb = k === 'judges' ? judgeBatch() : null;
  const flagged = jb ? jb.readFirst.filter((x) => jb.targets.some((t) => t.id === x.id)).length : 0;
  const n = plan.fills.length ? applyFills(plan.fills) : 0;
  if (!n) { toast(plan.skippedPartial ? `Nothing new to fill. You started ${plural(plan.skippedPartial, 'race')} yourself, so we left ${plan.skippedPartial === 1 ? 'it' : 'those'} for you.` : 'Nothing to fill right now.'); return; }
  // This batch is now the one Undo takes back, so the head's "filled in" line steps aside.
  S.ui.bulk = null;
  S.ui.row = null;
  dropBeat();
  renderBallot();
  render(['bar']);
  persist();
  const what = k === 'judges' ? plural(plan.fills.reduce((x, f) => x + Object.keys(f.set).length, 0), 'judge') : plural(n, 'pick');
  const head = k === 'judges' ? `Marked ${jb && jb.left === 0 ? 'all ' : ''}${what} keep.${flagged ? ` The review flagged ${flagged}; see “Read these first.”` : ''}`
    : `Filled ${what}${k === 'agree' ? ' where your sources agree' : k === 'party' ? ` with ${S.b.party} candidates` : ''}.`;
  fillToast(head, plan);
};
A['undo-bulk'] = () => {
  if (!undoFills()) return;
  const fromLine = (document.activeElement as HTMLElement | null)?.dataset?.fk === 'filled-undo';
  S.ui.bulk = null;
  dropBeat();
  hideToast();
  renderBallot();
  render(['bar']);
  persist();
  if (fromLine) focusFk('picks-edit');
  toast('Undone. Those picks are cleared.');
};

/* ---------- views ---------- */
A.view = (d) => {
  if (d.voted) S.ui.open.add('voted'); else if (d.v === 'ballot') S.ui.open.delete('voted');
  go(d.v as View);
};
A.cheat = () => go('cheat');
/* "Hide races I've decided", in the menu. In the rail the ballot repaints right away; under the menu
   sheet it repaints when the sheet closes, so the switch answers at once on a 200-row ballot. It is
   saved with the ballot (S.b.hideDecided), so it is still on after a reload. */
A.only = (_d, el) => {
  S.b.hideDecided = !S.b.hideDecided;
  S.ui.keep = null;
  dropBeat();
  persist();
  if (S.ui.sheet === 'toc') { markBehind(); render(['sheet', 'bar']); }
  else { renderBallot(); render(['bar']); }
  focusFk(el.dataset.fk || '');
};
A.reader = (d) => openReader(d.id!);
A['reader-close'] = () => {
  const id = S.ui.reader;
  if (!id) return;
  if (history.state && history.state.reader) { history.back(); return; }
  S.ui.reader = null;
  render(['sheet']);
  document.body.classList.remove('sheet-open');
  focusFk(`rd-${id}`);
};
/* "Try your name these ways" under Check my registration: the plan's details, open at that question. */
A['whatif-sit'] = (d) => {
  const k = `wi-${d.k}`;
  S.ui.open.add('whatif'); S.ui.open.add(k);
  render(['plan']);
  // Opened at once, like the menu's jump to "How this guide works", so the glide knows how far the
  // page now goes; the glide and the mark are the motion.
  const el = $(`[data-fk="${CSS.escape(k)}"]`);
  if (el) { glideTo(el, 12, () => land(el.closest('li') || el)); el.focus({ preventScroll: true }); }
};
A.open = (d, el) => {
  const k = d.k!;
  S.ui.open.has(k) ? S.ui.open.delete(k) : S.ui.open.add(k);
  // Inside the shelf ("When each state was last checked"): the sheet repaints, its height gliding.
  if (el.closest('#r-sheet > .sheet-panel.shelf')) { glide(['#r-sheet > .sheet-panel.shelf'], () => render(['sheet'])); if (el.dataset.fk) focusFk(el.dataset.fk); return; }
  if (k === 'off') { glide(['#r-off'], () => renderOff()); return; }
  const row = el.closest<HTMLElement>('.row[data-item]');
  if (row && S.ui.view === 'ballot') { const id = row.dataset.item!; glide([`#i-${CSS.escape(id)}`], () => renderRow(id)); return; }
  const region = el.closest<HTMLElement>('[id^="r-"]');
  if (region && region.id === 'r-ballot') { const sec = el.closest<HTMLElement>('.sec'); if (sec) { const id = sec.id; glide([`#${id}`], () => anchored(() => renderSection(sec.dataset.sec as SectionKey), id)); return; } }
  if (region) { const id = region.id; glide([`#${id}`], () => render([id.slice(2) as never])); }
};

/* ---------- places, address, restore ---------- */
/* A place from the place question (its ZIP comes along), or from the list of cities (no ZIP: the
   box empties, and the list closes so the place line above is what changed). */
A['choose-place'] = (d) => {
  const browse = d.from === 'browse';
  if (browse) fromList();
  void openChosen(d.ids!.split('+'), !browse && S.zipChoice ? S.zipChoice.zip : '');
};
A['choose-state'] = (d) => {
  fromList();
  void openBallot(d.st!, [], '', { door: true }).then((ok) => { if (ok) { const l = $('.door-place'); if (l) l.scrollIntoView({ block: 'start' }); focusFk('su-h'); } });
};
/* A place from the shelf's list of cities: the shelf goes, and from a ballot the ballot is left the way
   Change leaves it (saved, and offered on the first page the place opens on). */
function fromList(): void {
  S.ui.report = null;
  if (S.ui.sheet === 'shelf') S.ui.sheet = null;
  leaveBallot();
}
/* "Change" (the ballot's masthead, step 2's place line): back to the first page. When the first
   page is the history entry just behind this one, go back to it, so the phone's Back button then
   leaves the site instead of landing on the first page twice. */
A['change-place'] = () => {
  if (history.state && history.state.door && S.view !== 'start') { history.back(); return; }
  toDoor();
};

/* ---------- step 2: pick by endorsements or party ---------- */
/* Step 2's two switches on the first page, and the Edit sheet's: each repaints where it lives. */
A['setup-fill'] = () => {
  if (S.ui.sheet === 'picks') { S.ui.setupFill = !S.ui.setupFill; render(['sheet']); return; }
  S.door.fill = !S.door.fill; S.door.fillSet = true; render(['mast']);
};
A['setup-only'] = () => {
  if (S.ui.sheet === 'picks') { S.ui.setupOnly = !S.ui.setupOnly; render(['sheet']); return; }
  S.door.only = !S.door.only; render(['mast']);
};
/* "Show my ballot" (and Enter in the ZIP box): app.ts showBallot, then the fill's toast with Undo. */
/* "Show my ballot". What a fill did is the ballot head's own line ("20 filled in from your sources.
   Undo"), not a toast over the next step (UX walk, Oct 20). */
A['setup-done'] = async () => { await showBallot(); };
/* "Change" on the place line, after the place question: ask it again. */
A.rechoose = () => { rechoose(); };
A['saved-open'] = () => { openSaved(); };
A['addr-open'] = () => { S.ui.addrOpen = true; S.ui.addrMsg = null; S.ui.addrFail = ''; S.ui.addrWhich = null; glide(['.addrbox', '.door-where'], () => renderAddr()); const i = $('#addr-in'); if (i) { i.scrollIntoView({ block: 'center' }); i.focus({ preventScroll: true }); } };
A['addr-close'] = () => { S.ui.addrOpen = false; S.ui.addrMsg = null; S.ui.addrFail = ''; S.ui.addrWhich = null; glide(['.addrbox', '.door-where'], () => renderAddr()); focusFk($('[data-fk="addr-again"]') ? 'addr-again' : 'addr-open'); };
/* "Not it? Try again" beside what the Census found, and "None of these" under several matches: the
   form again, with what you typed. */
A['addr-again'] = () => { reopenAddr(); };
/* One of several Census matches, tapped: it goes on as a single match would. */
A['addr-which'] = (d) => { const r = S.ui.addrWhich?.[Number(d.i)]; if (r) void useMatch(r); };
/* After a lookup went wrong: the same address again, or close the form and answer the first
   district question by hand. */
A['addr-retry'] = () => { void runAddress((($('#addr-in') as HTMLInputElement | null)?.value) || ''); };
A['addr-pick'] = () => {
  const q = pageWalk().find((x) => x.question);
  S.ui.addrOpen = false; S.ui.addrMsg = null; S.ui.addrFail = '';
  renderAddr();
  if (q) openAt(q.key);
};
/* "Welcome back"'s close: the tap itself took the line away (main.ts); focus goes on to the plan. */
A['resume-x'] = () => { focusFk('plan-k'); };
/* "Try again" under a load error. */
A.retry = () => { const f = S.retry; S.retry = null; if (f) f(); };
A['restore-yes'] = () => { if (S.pending) { S.b = S.pending.incoming; S.pending = null; render(); persist(true); if (!switchOnNow('Using the picks from your link.')) toast('Using the picks from your link.'); } };
/* A grid's lean dots, tapped: how that lean was placed, in a few words. */
A.basis = (d) => {
  const e = B().eById.get(d.id!);
  if (!e) return;
  const how = basisWords(e);
  toast(e.lean ? `${e.short}: ${LEANS[e.lean][1]}, ${how || 'basis not recorded'}. Tap “See all sources” for details.` : `${e.short}: not rated for lean.`);
};
A['shared-keep'] = () => { S.pending = null; render(['restore']); if (!switchOnNow('Using the picks from your link.')) toast('Using the picks from your link. Change any pick as you go.'); };
A['shared-fresh'] = () => { const zip = S.b.zip; const hide = S.b.hideDecided; const secs = S.b.secs; S.b = emptyBallotState(zip); S.b.hideDecided = hide; S.b.secs = secs; S.pending = null; render(); persist(true); if (!switchOnNow('Started fresh.')) toast('Started fresh. The shared picks are cleared on this device.'); };
A['restore-no'] = () => { S.pending = null; render(['restore']); if (!switchOnNow('Kept the picks on this device.')) toast('Kept the picks on this device.'); };

/* ---------- cheat sheet, save link, pass it on ---------- */
A.print = () => { render(['print']); window.print(); };
A.copy = async () => {
  const text = cheatText();
  if (await copyText(text)) { S.ui.copyFallback = null; toast('Copied. Paste it into a note or a text.'); render(['cheat']); }
  else { S.ui.copyFallback = text; render(['cheat']); $('.copy-fallback')?.focus(); ($('.copy-fallback') as HTMLTextAreaElement | null)?.select(); }
};
A['save-open'] = () => { S.ui.saveOpen = !S.ui.saveOpen; render(['cheat']); if (S.ui.saveOpen) focusFk('save-url'); };
A['copy-link'] = async () => {
  const url = shareURL();
  if (await copyText(url)) toast('Link copied. Text or email it to yourself.');
  else { const i = $('.save-url') as HTMLInputElement | null; if (i) { i.focus(); i.select(); } toast('Select the link and copy it.'); }
};
A['copy-msg'] = async (d) => {
  const m = messages();
  const text = d.k === 'pub' ? m.pub : m.fam;
  if (!text) return;
  if (await copyText(text)) toast('Copied. Paste it into your group chat.');
  else toast('Copy didn’t work here. Press and hold the message to copy it.');
};
/* "Share the guide": the phone's share sheet with the friends message and the guide's link; where
   there is none (most desktops), or it fails, the message is copied instead. Closing the sheet
   without sharing does nothing. */
A['share-guide'] = async () => {
  const fam = messages().fam;
  if (!fam) return;
  const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
  if (typeof nav.share === 'function') {
    try { await nav.share(shareData(fam)); return; } catch (e) { if (e && (e as Error).name === 'AbortError') return; }
  }
  if (await copyText(fam)) toast('Copied. Paste it into your group chat.');
  else toast('Copy didn’t work here. Press and hold the message to copy it.');
};
A.tick = (d) => {
  const k = d.k!;
  S.b.ticks = S.b.ticks.includes(k) ? S.b.ticks.filter((x) => x !== k) : [...S.b.ticks, k];
  persist();
  render(['pass']);
};
export { runAddress, status };
