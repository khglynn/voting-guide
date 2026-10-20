/* Every control is a data-act attribute dispatched through this table. Model mutations keep
   v2's pick vocabulary byte for byte (YES/NO/SKIP/DONE/PICK, candidate names, "id|name" keys),
   because the save link and saved picks depend on it. */
import type { Contest, Item } from './types';
import { S, persist, emptyBallotState, type View } from './state';
import { status, sectionOf, rankMax, ordinal, chosenIds, entriesBySection, pageWalk, OTH_KEY, type SectionKey } from './ballot';
import { toast, hideToast, copyText, announce, hash, plural } from './util';
import { render, renderRow, renderSection, renderSummaries, renderLens, flushLens, markBehind, renderBallot, renderAddr, rowEl, scrollRowIntoView, rowTop, holdRow, anchored, $ } from './render';
import { growOpen, inkRow, followFold, glideTo, land, stopGlide } from './motion';
import { openBallot, openChosen, go, openReader, runAddress, toDoor, showBallot, rechoose } from './app';
import { judgeBatch } from './model/judges';
import { planAgree, planParty, planJudges, planSetup, applyFills, undoFills, emptyPlan, touchUndo, type Plan } from './model/bulk';
import { toggleChip, setParty, setSources, chipState, type ChipKey } from './model/lens';
import { courtGroup } from './model/labels';
import { basisWords, LEANS } from './views/common';
import { cheatText, shareURL } from './views/cheat';
import { messages, shareData } from './views/pass';
import { nextUp, sectionTally, qId } from './views/ledger';

export type Act = (d: DOMStringMap, el: HTMLElement) => void | Promise<void>;
export const A: Record<string, Act> = {};
const B = () => S.ballot!;

/* ---------- after a decision ---------- */
/* A pick that closes its row: the panel folds up into the header, which stays where it is (or,
   when it had scrolled off the top, comes down into view as the panel folds, motion.followFold),
   and the tick draws itself in the box. */
function afterPick(id: string, close = true): void {
  touchUndo(id);
  const shut = close && S.ui.row === id;
  if (shut) { S.ui.row = null; S.ui.keep = id; }
  const box = shut ? rowEl(id)?.getBoundingClientRect() : undefined;
  const fold = renderRow(id, true, shut);
  const it = B().byId.get(id);
  if (it && it.kind === 'measure') it.links.forEach((l) => renderRow(l));
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
   frame) and this one's panel grows open beneath it. A header out of view (a keyboard, a script)
   comes to the top first, as before. */
A.row = (d) => {
  const key = d.id!;
  const prev = S.ui.row;
  const prevKeep = S.ui.keep;
  S.ui.keep = null;
  stopGlide();
  if (prev === key) { S.ui.row = null; renderRow(key, false, true); return; }
  S.ui.row = key;
  const top = rowTop(key);
  if (prev) renderRow(prev, false);
  if (prevKeep && prevKeep !== key && S.ui.onlyUndecided) renderRow(prevKeep);
  renderRow(key, false);
  if (top === null) { const el = rowEl(key); if (el) window.scrollBy(0, el.getBoundingClientRect().top - 4); }
  else holdRow(key, top);
  growOpen(rowEl(key));
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
   Under "Hide races I've decided" a finished section isn't on the page, so the filter turns off. */
A.jump = (d) => {
  closeMenu();
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
  const unfilter = S.ui.onlyUndecided && t.total > 0 && t.done === t.total;
  S.ui.folded.delete(sec);
  S.ui.unfolded.add(sec);
  if (unfilter) { S.ui.onlyUndecided = false; S.ui.keep = null; renderBallot(); render(['bar']); }
  else if (wasFolded || !$(`#sec-${sec}`)) renderSection(sec);
  glideTo($(`#sec-${sec}`), 0, () => land($(`#sec-${sec}`)));
  focusFk(`sec-${sec}`);
};
A.page = (d) => { S.ui.page[d.id!] = Number(d.v); renderRow(d.id!); $(`[data-fk="pg-${CSS.escape(d.id!)}"]`)?.focus({ preventScroll: true }); };
A.others = (d) => { const k = d.id!; S.ui.others.has(k) ? S.ui.others.delete(k) : S.ui.others.add(k); renderRow(k); };
A.sec = (d) => {
  const s = d.sec as SectionKey;
  const el = $(`#sec-${s}`);
  const folded = !!el && el.classList.contains('folded');
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
  anchored(() => renderSection(s), `sec-${s}`);
};
A.grp = (d) => {
  const k = d.g!;
  const el = document.querySelector<HTMLElement>(`[data-act="grp"][data-g="${CSS.escape(k)}"]`);
  const open = el?.getAttribute('aria-expanded') === 'true';
  if (open) S.ui.unfolded.delete(k); else S.ui.unfolded.add(k);
  renderSection(k.split('|')[0] as SectionKey);
  // Opening the other school districts' fold claims its races, so the count changes.
  if (k === OTH_KEY) renderSummaries();
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
  S.b.districts[g.key] = d.v!;
  // Answering swaps the question for that district's race, opened, in the same place. "Not sure"
  // shows them all; "Not in any of these" leaves one line saying so, with Change.
  const one = d.v !== '*' && d.v !== 'none';
  S.ui.row = one ? d.v! : null;
  const sec = sectionOf(B().byId.get(g.members[0])!);
  anchored(() => renderSection(sec));
  renderSummaries();
  persist();
  if (one) scrollRowIntoView(d.v!);
  else if (d.v === 'none') focusFk(`dc-${qId(g)}`);
};
A['district-change'] = (d) => {
  const g = B().groups.find((x) => x.key === d.g)!;
  const ans = S.b.districts[g.key];
  delete S.b.districts[g.key];
  if (ans && ans !== '*' && ans !== 'none') { delete S.b.picks[ans]; delete S.b.ranks[ans]; delete S.b.auto[ans]; touchUndo(ans); }
  S.ui.row = `q:${g.key}`;
  renderSection(sectionOf(B().byId.get(g.members[0])!));
  renderSummaries();
  persist();
  scrollRowIntoView(`q:${g.key}`);
};
A.notmine = (d) => {
  const b = B();
  const it = b.byId.get(d.id!)!;
  // "Hide all like this": the same scope (a race) or the same district (a measure), same kind.
  const scope = (x: Item | undefined) => (!x ? null : x.kind === 'contest' ? `c|${x.scope_plain}` : `m|${x.jurisdiction}`);
  const ids = d.all ? [...b.mayApply].filter((id) => scope(b.byId.get(id)) === scope(it)) : [d.id!];
  ids.forEach((id) => { if (!S.b.notMine.includes(id)) S.b.notMine.push(id); });
  if (S.ui.row && ids.includes(S.ui.row)) S.ui.row = null;
  anchored(() => renderSection(sectionOf(it)));
  renderSummaries();
  persist();
  if (ids.length > 1) toast(`Took ${ids.length} ${it.kind === 'measure' ? 'measures' : 'races'} off your list.`);
};
/* "None of these are on my ballot" for the other school districts' races, all at once. */
A['notmine-oth'] = () => {
  const b = B();
  const ids = [...b.mayApply].filter((id) => { const it = b.byId.get(id); return !!it && it.kind === 'contest' && sectionOf(it) === 'school' && !b.groupOf[id]; });
  ids.forEach((id) => { if (!S.b.notMine.includes(id)) S.b.notMine.push(id); });
  if (S.ui.row && ids.includes(S.ui.row)) S.ui.row = null;
  S.ui.unfolded.delete('school|oth');
  anchored(() => renderSection('school'));
  renderSummaries();
  persist();
  toast(`Took ${plural(ids.length, 'race')} off your list. Open the line to bring one back.`);
};
A['notmine-undo'] = (d) => { S.b.notMine = S.b.notMine.filter((x) => x !== d.id); anchored(() => renderSection(sectionOf(B().byId.get(d.id!)!))); renderSummaries(); persist(); };

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
    render(['mast']);
    announce(on ? 'Turned on.' : 'Turned off.');
    return;
  }
  const on = toggleChip(B(), k);
  renderLens(); persist();
  announce(on ? 'Turned on.' : 'Turned off.');
};
A['party-off'] = () => {
  if (S.view !== 'ballot') { S.door.party = null; if (doorBallot()) setParty(B(), null); render(['mast']); return; }
  setParty(B(), null); renderLens(); persist();
};
A['party-set'] = (d) => {
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
A.src = (d) => {
  const cur = chosenIds();
  setSources(B(), cur.includes(d.id!) ? cur.filter((x) => x !== d.id) : [...cur, d.id!]);
  persist();
  renderLens();
};
A['src-default'] = () => { S.b.sources = null; S.b.party = null; persist(); renderLens(); };
/* "No sources on" in an open row: turn the newspapers and guides back on, and stay on that row. */
A['papers-on'] = (d) => {
  const b = B();
  if (chipState(b, 'papers') !== 'on') toggleChip(b, 'papers');
  persist();
  renderLens();
  if (d.id) focusFk(`row-${d.id}`);
};
A['src-none'] = () => { S.b.sources = []; S.b.party = null; persist(); renderLens(); };
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
  if (from) focusFk(from);
}
/* "Picks: ... · Edit" and the menu's "Quick picks": step 2's controls in a sheet. The fill switch
   starts off each time; "Hide races I've decided" shows where the ballot is now. */
A.picks = (_d, el) => {
  S.ui.sheetFrom = S.ui.sheet === 'toc' ? 'bar-menu' : el.dataset.fk || null;
  S.ui.sheetBack = null;
  S.ui.setupFill = false;
  S.ui.setupOnly = S.ui.onlyUndecided;
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
  if (n) { S.ui.bulk = String(n); S.ui.row = null; S.ui.keep = null; }
  const onlyChanged = only !== S.ui.onlyUndecided;
  if (onlyChanged) { S.ui.onlyUndecided = only; S.ui.keep = null; }
  flushLens(!!n || onlyChanged);
  persist();
  if (S.ui.sheetFrom) focusFk(S.ui.sheetFrom);
  if (n && plan) fillToast(fillHead(n, plan), setupPlan(plan));
}
A['sheet-close'] = () => {
  const was = S.ui.sheet;
  if (was === 'picks') { closePicks(); return; }
  if ((was === 'sources' || was === 'party') && S.ui.sheetBack !== null) { backToPicks(); return; }
  S.ui.sheet = null;
  render(['sheet']);
  flushLens();
  if (S.ui.sheetFrom) focusFk(S.ui.sheetFrom);
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
   sheet it repaints when the sheet closes, so the switch answers at once on a 200-row ballot. */
A.only = (_d, el) => {
  S.ui.onlyUndecided = !S.ui.onlyUndecided;
  S.ui.keep = null;
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
A.open = (d, el) => {
  const k = d.k!;
  S.ui.open.has(k) ? S.ui.open.delete(k) : S.ui.open.add(k);
  const row = el.closest<HTMLElement>('.row[data-item]');
  if (row && S.ui.view === 'ballot') { renderRow(row.dataset.item!); return; }
  const region = el.closest<HTMLElement>('[id^="r-"]');
  if (region && region.id === 'r-ballot') { const sec = el.closest<HTMLElement>('.sec'); if (sec) { renderSection(sec.dataset.sec as SectionKey); return; } }
  if (region) render([region.id.slice(2) as never]);
};

/* ---------- places, address, restore ---------- */
/* A place from the place question (its ZIP comes along), or from the list of cities (no ZIP: the
   box empties, and the list closes so the place line above is what changed). */
A['choose-place'] = (d) => {
  const browse = d.from === 'browse';
  if (browse) S.ui.open.delete('browse');
  void openChosen(d.ids!.split('+'), !browse && S.zipChoice ? S.zipChoice.zip : '');
};
A['choose-state'] = (d) => {
  S.ui.open.delete('browse');
  void openBallot(d.st!, [], '', { door: true }).then((ok) => { if (ok) { const l = $('.door-place'); if (l) l.scrollIntoView({ block: 'start' }); focusFk('su-h'); } });
};
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
  S.door.fill = !S.door.fill; render(['mast']);
};
A['setup-only'] = () => {
  if (S.ui.sheet === 'picks') { S.ui.setupOnly = !S.ui.setupOnly; render(['sheet']); return; }
  S.door.only = !S.door.only; render(['mast']);
};
/* "Show my ballot" (and Enter in the ZIP box): app.ts showBallot, then the fill's toast with Undo. */
A['setup-done'] = async () => {
  const r = await showBallot();
  if (r) fillToast(fillHead(r.n, r.plan), setupPlan(r.plan));
};
/* "Change" on the place line, after the place question: ask it again. */
A.rechoose = () => { rechoose(); };
A['addr-open'] = () => { S.ui.addrOpen = true; S.ui.addrMsg = null; S.ui.addrFail = ''; renderAddr(); const i = $('#addr-in'); if (i) { i.scrollIntoView({ block: 'center' }); i.focus({ preventScroll: true }); } };
A['addr-close'] = () => { S.ui.addrOpen = false; S.ui.addrMsg = null; S.ui.addrFail = ''; renderAddr(); focusFk('addr-open'); };
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
A['restore-yes'] = () => { if (S.pending) { S.b = S.pending.incoming; S.pending = null; render(); persist(true); toast('Using the picks from your link.'); } };
/* A grid's lean dots, tapped: how that lean was placed, in a few words. */
A.basis = (d) => {
  const e = B().eById.get(d.id!);
  if (!e) return;
  const how = basisWords(e);
  toast(e.lean ? `${e.short}: ${LEANS[e.lean][1]}, ${how || 'basis not recorded'}. Tap “See all sources” for details.` : `${e.short}: not rated for lean.`);
};
A['shared-keep'] = () => { S.pending = null; render(['restore']); toast('Using the picks from your link. Change any pick as you go.'); };
A['shared-fresh'] = () => { const zip = S.b.zip; S.b = emptyBallotState(zip); S.pending = null; render(); persist(true); toast('Started fresh. The shared picks are cleared on this device.'); };
A['restore-no'] = () => { S.pending = null; render(['restore']); toast('Kept the picks on this device.'); };

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
