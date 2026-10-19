/* Every control is a data-act attribute dispatched through this table. Model mutations keep
   v2's pick vocabulary byte for byte (YES/NO/SKIP/DONE/PICK, candidate names, "id|name" keys),
   because the save link and saved picks depend on it. */
import type { Contest } from './types';
import { S, persist, forgetLast, type View } from './state';
import { status, sectionOf, decisionItems, rankMax, ordinal, chosenIds, type SectionKey } from './ballot';
import { toast, hideToast, copyText, announce, hash, plural } from './util';
import { render, renderRow, renderSection, renderSummaries, renderLens, renderBallot, renderAddr, rowEl, scrollRowIntoView, anchored, $ } from './render';
import { openBallot, go, openReader, runAddress } from './app';
import { planAgree, planParty, planJudges, applyFills, undoFills, emptyPlan, type Plan } from './model/bulk';
import { toggleChip, setParty, setSources, type ChipKey } from './model/lens';
import { courtGroup } from './model/labels';
import { cheatText, shareURL } from './views/cheat';
import { messages } from './views/pass';

export type Act = (d: DOMStringMap, el: HTMLElement) => void | Promise<void>;
export const A: Record<string, Act> = {};
const B = () => S.ballot!;

/* ---------- after a decision ---------- */
function afterPick(id: string, close = true): void {
  const was = S.ui.row;
  if (close && S.ui.row === id) { S.ui.row = null; S.ui.keep = id; }
  renderRow(id);
  const it = B().byId.get(id);
  if (it && it.kind === 'measure') it.links.forEach((l) => renderRow(l));
  renderSummaries();
  persist();
  if (close && was === id) {
    const el = rowEl(id);
    if (el) { el.classList.add('flash'); window.setTimeout(() => el.classList.remove('flash'), 900); }
    $(`[data-fk="row-${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  }
}

/* ---------- rows ---------- */
A.row = (d) => {
  const key = d.id!;
  const prev = S.ui.row;
  const prevKeep = S.ui.keep;
  S.ui.keep = null;
  if (prev === key) { S.ui.row = null; renderRow(key, false); return; }
  S.ui.row = key;
  if (prev) renderRow(prev, false);
  if (prevKeep && prevKeep !== key && S.ui.onlyUndecided) renderRow(prevKeep);
  renderRow(key, false);
  scrollRowIntoView(key);
};
A.goto = (d) => {
  const id = d.id!;
  const it = B().byId.get(id);
  if (!it) return;
  if (S.ui.view !== 'ballot') go('ballot');
  const sec = sectionOf(it);
  S.ui.folded.delete(sec);
  S.ui.unfolded.add(sec);
  if (it.kind === 'contest') S.ui.unfolded.add(`${sec}|${courtGroup(it)}`); // its court group, if the section folds into groups
  S.ui.row = id;
  renderSection(sec);
  scrollRowIntoView(id, true);
  $(`[data-fk="row-${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
};
A.next = () => {
  const items = decisionItems().filter((i) => !i.done);
  if (!items.length) return;
  const b = B();
  // The first undecided below the current scroll position, else the first one.
  const pick = items.find((i) => { const el = rowEl(i.id); return el && el.getBoundingClientRect().top > 80; }) || items[0];
  const id = pick.question ? b.groups.find((g) => `q:${g.key}` === pick.id)!.members[0] : pick.id;
  const sec = sectionOf(b.byId.get(id)!);
  S.ui.folded.delete(sec);
  if (!pick.question) { A.goto({ id } as DOMStringMap, document.body); return; }
  S.ui.row = pick.id;
  renderSection(sec);
  scrollRowIntoView(pick.id, true);
  $(`[data-fk="row-${CSS.escape(rowEl(pick.id)?.id || '')}"]`)?.focus({ preventScroll: true });
};
A.page = (d) => { S.ui.page[d.id!] = Number(d.v); renderRow(d.id!); $(`[data-fk="pg-${CSS.escape(d.id!)}"]`)?.focus({ preventScroll: true }); };
A.others = (d) => { const k = d.id!; S.ui.others.has(k) ? S.ui.others.delete(k) : S.ui.others.add(k); renderRow(k); };
A.sec = (d) => {
  const s = d.sec as SectionKey;
  const el = $(`#sec-${s}`);
  const folded = !!el && el.classList.contains('folded');
  if (folded) { S.ui.folded.delete(s); S.ui.unfolded.add(s); } else { S.ui.unfolded.delete(s); S.ui.folded.add(s); if (S.ui.row && B().byId.get(S.ui.row) && sectionOf(B().byId.get(S.ui.row)!) === s) S.ui.row = null; }
  anchored(() => renderSection(s), `sec-${s}`);
};
A.grp = (d) => {
  const k = d.g!;
  const el = document.querySelector<HTMLElement>(`[data-act="grp"][data-g="${CSS.escape(k)}"]`);
  const open = el?.getAttribute('aria-expanded') === 'true';
  if (open) S.ui.unfolded.delete(k); else S.ui.unfolded.add(k);
  renderSection(k.split('|')[0] as SectionKey);
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
    if (n >= c.vote_for) { toast(`You can mark up to ${c.vote_for}. Unmark one first.`); return; }
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
  // Answering swaps the question for that district's race, opened, in the same place.
  S.ui.row = d.v === '*' ? null : d.v!;
  const sec = sectionOf(B().byId.get(g.members[0])!);
  anchored(() => renderSection(sec), d.v === '*' ? undefined : undefined);
  renderSummaries();
  persist();
  if (d.v !== '*') scrollRowIntoView(d.v!);
};
A['district-change'] = (d) => {
  const g = B().groups.find((x) => x.key === d.g)!;
  const ans = S.b.districts[g.key];
  delete S.b.districts[g.key];
  if (ans && ans !== '*' && ans !== 'none') { delete S.b.picks[ans]; delete S.b.ranks[ans]; delete S.b.auto[ans]; }
  S.ui.row = `q:${g.key}`;
  renderSection(sectionOf(B().byId.get(g.members[0])!));
  renderSummaries();
  persist();
  scrollRowIntoView(`q:${g.key}`);
};
A.notmine = (d) => {
  const b = B();
  const it = b.byId.get(d.id!) as Contest;
  const ids = d.all ? [...b.mayApply].filter((id) => (b.byId.get(id) as Contest | undefined)?.scope_plain === it.scope_plain) : [d.id!];
  ids.forEach((id) => { if (!S.b.notMine.includes(id)) S.b.notMine.push(id); });
  if (S.ui.row && ids.includes(S.ui.row)) S.ui.row = null;
  anchored(() => renderSection(sectionOf(it)));
  renderSummaries();
  persist();
  if (ids.length > 1) toast(`Took ${ids.length} races off your list.`);
};
A['notmine-undo'] = (d) => { S.b.notMine = S.b.notMine.filter((x) => x !== d.id); anchored(() => renderSection(sectionOf(B().byId.get(d.id!)!))); renderSummaries(); persist(); };

/* ---------- the lens ---------- */
A.chip = (d) => {
  const on = toggleChip(B(), d.k as ChipKey);
  renderLens(); persist();
  announce(on ? 'Turned on.' : 'Turned off.');
};
A['party-off'] = () => { setParty(B(), null); renderLens(); persist(); };
A['party-set'] = (d) => {
  setParty(B(), d.p!);
  S.ui.sheet = null;
  render(['sheet']); renderLens(); persist();
  const n = planParty(d.p!).fills.length;
  toast(`Showing the ${d.p} Party’s picks where it made any.${n ? ` “Fill in the ${d.p} candidates” can fill ${plural(n, 'race')}.` : ''}`);
  focusFk('bulk-party');
};
A.src = (d) => {
  const cur = chosenIds();
  setSources(B(), cur.includes(d.id!) ? cur.filter((x) => x !== d.id) : [...cur, d.id!]);
  persist();
  if (S.ui.sheet) { render(['sheet']); sheetDirty = true; } else renderLens();
};
A['src-default'] = () => { S.b.sources = null; S.b.party = null; persist(); render(['sheet']); sheetDirty = true; };
A['src-none'] = () => { S.b.sources = []; S.b.party = null; persist(); render(['sheet']); sheetDirty = true; };
let sheetDirty = false;
A.sheet = (d, el) => {
  S.ui.sheet = d.s as 'sources' | 'party';
  S.ui.sheetFrom = el.dataset.fk || null;
  render(['sheet']);
  focusFk('sheet-x');
};
A['sheet-close'] = () => {
  S.ui.sheet = null;
  render(['sheet']);
  if (sheetDirty) { sheetDirty = false; renderLens(); }
  if (S.ui.sheetFrom) focusFk(S.ui.sheetFrom);
};

/* ---------- bulk fills, each undone as a batch ---------- */
A.bulk = (d) => {
  const k = d.k!;
  let plan: Plan;
  if (k === 'agree') plan = planAgree();
  else if (k === 'party') plan = S.b.party ? planParty(S.b.party) : emptyPlan();
  else plan = planJudges();
  const n = plan.fills.length ? applyFills(plan.fills) : 0;
  if (!n) { toast(plan.skippedPartial ? `Nothing to fill. ${plural(plan.skippedPartial, 'race')} you started picking ${plan.skippedPartial === 1 ? 'was' : 'were'} left for you to finish.` : 'Nothing to fill right now.'); return; }
  S.ui.row = null;
  renderBallot();
  render(['bar']);
  persist();
  const what = k === 'judges' ? plural(plan.fills.reduce((x, f) => x + Object.keys(f.set).length, 0), 'judge') : plural(n, 'pick');
  const extra = [
    plan.single ? `${plan.single} rest on one source.` : '',
    plan.skippedTwo ? `Skipped ${plural(plan.skippedTwo, 'race')} where the party has more than one candidate.` : '',
    plan.skippedRanked ? `Skipped ${plural(plan.skippedRanked, 'ranked-choice race')}; rank those yourself.` : '',
    plan.skippedPartial ? `Left ${plural(plan.skippedPartial, 'race')} you started picking for you to finish.` : '',
  ].filter(Boolean).join(' ');
  toast(`${k === 'judges' ? `Marked ${what} keep` : `Filled ${what}`}${k === 'agree' ? ' where your sources agree' : k === 'party' ? ` with ${S.b.party} candidates` : ''}. ${extra}`.trim(), { label: 'Undo', act: 'undo-bulk' });
};
A['undo-bulk'] = () => {
  if (!undoFills()) return;
  hideToast();
  renderBallot();
  render(['bar']);
  persist();
  toast('Undone. Those picks are cleared.');
};

/* ---------- views ---------- */
A.view = (d) => {
  if (d.voted) S.ui.open.add('voted'); else if (d.v === 'ballot') S.ui.open.delete('voted');
  go(d.v as View);
};
A.cheat = () => go('cheat');
A.only = () => {
  S.ui.onlyUndecided = !S.ui.onlyUndecided;
  S.ui.keep = null;
  renderBallot();
  render(['bar']);
  focusFk('bar-only');
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
A['choose-place'] = (d) => { const ids = d.ids!.split('+'); const idx = S.index!; void openBallot(idx.places[ids[0]].state, ids, S.zipChoice ? S.zipChoice.zip : ''); };
A['choose-state'] = (d) => { void openBallot(d.st!, [], ''); };
A['change-place'] = () => {
  S.view = 'start'; S.ballot = null; S.zipChoice = null; S.coverage = null; S.pending = null;
  S.ui.view = 'ballot'; S.ui.reader = null; S.ui.sheet = null;
  forgetLast();
  render();
  window.scrollTo(0, 0);
  $('#zip')?.focus();
};
A['addr-open'] = () => { S.ui.addrOpen = true; S.ui.addrMsg = null; renderAddr(); const i = $('#addr-in'); if (i) { i.scrollIntoView({ block: 'center' }); i.focus({ preventScroll: true }); } };
A['addr-close'] = () => { S.ui.addrOpen = false; renderAddr(); focusFk('addr-open'); };
A['restore-yes'] = () => { if (S.pending) { S.b = S.pending.incoming; S.pending = null; render(); persist(true); toast('Using the picks from your link.'); } };
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
  if (await copyText(text)) toast('Copied. Paste it into your group chat.');
  else toast('Copy didn’t work here. Press and hold the message to copy it.');
};
A.tick = (d) => {
  const k = d.k!;
  S.b.ticks = S.b.ticks.includes(k) ? S.b.ticks.filter((x) => x !== k) : [...S.b.ticks, k];
  persist();
  render(['pass']);
};
export { runAddress, status };
