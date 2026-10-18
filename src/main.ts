/* Boot, data loading, rendering and actions. One page, one flow. */
import './styles.css';
import type { Index, PlaceBundle, StateBundle, Contest } from './types';
import { S, emptyBallotState, persist, readSaved, savedBallot, forgetLast, parseShareHead, decodeShare, normalizeRanks, type BallotState } from './state';
import {
  buildBallot, autoCandidates, chosenIds, decisionItems, filterSig, sectionOf, contestDistrict,
  type SectionKey, SECTIONS, entriesBySection, status, rankMax, ordinal,
} from './ballot';
import { zipState, censusLookup } from './geo';
import { toast, copyText, scrollToEl, announce, hash } from './util';
import { mastHTML, restoreHTML, offerHTML, barHTML, sheetHTML, trustHTML } from './views/chrome';
import { planHTML } from './views/plan';
import { sourcesHTML } from './views/sources';
import { ballotHTML, sectionHTML, sectionCount, itemHTML, groupId } from './views/items';
import { cheatSectionHTML, cheatHTML, cheatText, shareURL } from './views/cheat';

/* ---------- data ---------- */
const BASE = import.meta.env.BASE_URL || '/';
const cache = new Map<string, Promise<unknown>>();
function getJSON<T>(path: string): Promise<T> {
  if (!cache.has(path)) {
    const p = fetch(`${BASE}data/${path}`, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${path}`);
      return r.json();
    });
    p.catch(() => cache.delete(path));
    cache.set(path, p);
  }
  return cache.get(path) as Promise<T>;
}
async function ensureIndex(): Promise<Index> {
  if (!S.index) S.index = await getJSON<Index>('index.json');
  return S.index;
}

/* ---------- rendering ---------- */
type Region = 'mast' | 'restore' | 'plan' | 'sources' | 'offer' | 'ballot' | 'cheat' | 'trust' | 'bar' | 'sheet' | 'print';
const ALL: Region[] = ['mast', 'restore', 'plan', 'sources', 'offer', 'ballot', 'cheat', 'trust', 'bar', 'sheet'];
const BALLOT_ONLY: Region[] = ['restore', 'plan', 'sources', 'offer', 'ballot', 'cheat', 'bar', 'sheet', 'print'];
const html: Record<Region, () => string> = {
  mast: mastHTML,
  restore: restoreHTML,
  plan: () => (S.ballot ? planHTML() : ''),
  sources: () => (S.ballot ? sourcesHTML() : ''),
  offer: offerHTML,
  ballot: () => (S.ballot ? ballotHTML() : ''),
  cheat: () => (S.ballot ? cheatSectionHTML() : ''),
  trust: trustHTML,
  bar: barHTML,
  sheet: sheetHTML,
  print: () => (S.ballot ? cheatHTML(true) : ''),
};
const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;

function withFocusKept(fn: () => void): void {
  const a = document.activeElement as HTMLElement | null;
  const fk = a && a.dataset ? a.dataset.fk : undefined;
  const keep: Record<string, [number, number]> = {};
  document.querySelectorAll<HTMLElement>('[data-keep]').forEach((el) => { keep[el.dataset.keep!] = [el.scrollLeft, el.scrollTop]; });
  fn();
  document.querySelectorAll<HTMLElement>('[data-keep]').forEach((el) => { const k = keep[el.dataset.keep!]; if (k) { el.scrollLeft = k[0]; el.scrollTop = k[1]; } });
  if (fk && (!document.activeElement || document.activeElement === document.body)) {
    const f = document.querySelector<HTMLElement>(`[data-fk="${CSS.escape(fk)}"]`);
    if (f) f.focus({ preventScroll: true });
  }
}
function render(regions: Region[] = ALL): void {
  if (S.ballot && S.prefs.autoPick) applyAuto();
  withFocusKept(() => {
    for (const r of regions) {
      const el = $(`#r-${r}`);
      if (!el) continue;
      if (BALLOT_ONLY.includes(r) && !S.ballot && r !== 'restore') { el.innerHTML = ''; continue; }
      el.innerHTML = html[r]();
    }
    document.body.classList.toggle('has-bar', !!S.ballot);
    document.body.classList.toggle('sheet-open', S.ui.filterOpen);
  });
}
function renderSection(sec: SectionKey): void {
  const label = SECTIONS.find(([k]) => k === sec)![1];
  const entries = entriesBySection().get(sec) || [];
  withFocusKept(() => {
    const el = $(`#sec-${sec}`);
    const next = sectionHTML(sec, label, entries);
    if (!el) { const b = $('#r-ballot'); if (b) b.innerHTML = ballotHTML(); return; }
    if (!next) { el.remove(); return; }
    el.outerHTML = next;
  });
}
/* Replace one card in place and refresh its section's count. */
function renderItem(id: string): void {
  const it = S.ballot!.byId.get(id);
  if (!it) return;
  const el = $(`#i-${CSS.escape(id)}`);
  if (!el || el.closest('.unopp')) return renderSection(sectionOf(it));
  withFocusKept(() => { el.outerHTML = itemHTML(it); });
  const sec = sectionOf(it);
  const count = document.querySelector(`#sec-${sec} .sec-count`);
  if (count) count.textContent = sectionCount(entriesBySection().get(sec) || []);
}
/* The cheat sheet and the grid sit below or off to the side: render them after the tap paints. */
let lazyTimer: number | undefined;
function renderLazy(): void {
  window.clearTimeout(lazyTimer);
  lazyTimer = window.setTimeout(() => render(['cheat', 'print', ...(S.ui.filterOpen && S.ui.gridOpen ? ['sheet' as Region] : [])]), 60);
}
/* After a pick: the card (and any linked measure cards), the counters, then the rest lazily. */
function afterPick(id: string): void {
  const it = S.ballot!.byId.get(id);
  const autoBefore = S.prefs.autoPick ? applyAuto() : 0;
  if (autoBefore) { render(['ballot', 'bar', 'offer']); renderLazy(); persist(); return; }
  renderItem(id);
  if (it && it.kind === 'measure') it.links.forEach(renderItem);
  render(['bar', 'offer']);
  renderLazy();
  if (!S.b.planSeen) { S.b.planSeen = true; }
  if (Object.keys(S.b.picks).length) $('#r-ballot > .tip')?.remove();
  persist();
  keepInView(`#i-${CSS.escape(id)}`);
}
function keepInView(sel: string): void {
  const el = $(sel);
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (r.top < 0 || r.top > window.innerHeight - 80) scrollToEl(el);
}

/* ---------- auto-pick ---------- */
function applyAuto(): number {
  const list = autoCandidates();
  list.forEach(({ c, name, why }) => { S.b.picks[c.id] = name; S.b.auto[c.id] = why; });
  if (list.length) persist();
  return list.length;
}

/* ---------- opening a ballot ---------- */
/* Picks plus rankings, counting a ranked race once. */
const countPicks = (b: BallotState): number => Object.keys(b.picks).length + Object.keys(b.ranks || {}).filter((k) => !(k in b.picks)).length;
async function openBallot(st: string, placeIds: string[], zip: string, opts: { share?: ReturnType<typeof parseShareHead> } = {}): Promise<void> {
  S.view = 'loading';
  S.loadErr = null;
  render(['mast']);
  try {
    await ensureIndex();
    const [sb, ...pbs] = await Promise.all([getJSON<StateBundle>(`state-${st}.json`), ...placeIds.map((id) => getJSON<PlaceBundle>(`place-${id}.json`))]);
    const ballot = buildBallot(sb, pbs);
    S.ballot = ballot;
    const existing = savedBallot(ballot.key);
    const reopened = existing ? normalizeRanks(ballot, existing) : 0;
    S.b = existing || emptyBallotState(zip);
    if (zip) S.b.zip = zip;
    S.pending = null;
    if (reopened && !opts.share) toast(`${reopened === 1 ? 'A race you marked is' : `${reopened} races you marked are`} ranked choice now. Rank your picks there again.`);
    if (opts.share) {
      const { state, dropped } = decodeShare(ballot, opts.share);
      normalizeRanks(ballot, state);
      const n = countPicks(state);
      const m = existing ? countPicks(existing) : 0;
      const same = existing && JSON.stringify(existing.picks) === JSON.stringify(state.picks) && JSON.stringify(existing.notes) === JSON.stringify(state.notes)
        && JSON.stringify(existing.ranks) === JSON.stringify(state.ranks);
      if (existing && m > 0 && !same) {
        S.pending = { kind: 'restore', key: ballot.key, incoming: state, summary: `This link has ${n} ${n === 1 ? 'pick' : 'picks'}. This device already has ${m} saved for this ballot. Which do you want to keep?` };
      } else {
        S.b = state;
        toast(`Restored ${n} ${n === 1 ? 'pick' : 'picks'} from your link.${dropped ? ` ${dropped} couldn’t be matched to today’s data.` : ''}`);
      }
      try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ }
    }
    S.view = 'ballot';
    S.zipChoice = null;
    S.coverage = null;
    S.ui.expanded.clear(); S.ui.showAll.clear(); S.ui.noteOpen.clear(); S.ui.why = {};
    S.ui.gridOpen = false; S.ui.filterOpen = false; S.ui.shelfFrom = null; S.ui.addrOpen = false; S.ui.addrMsg = null; S.ui.saveOpen = false; S.ui.copyFallback = null;
    render();
    renderLazy();
    persist(true);
    window.scrollTo(0, 0);
    if (S.pending) $('[data-fk="restore-yes"]')?.focus();
  } catch (e) {
    console.warn('Could not load ballot', e);
    S.view = 'start';
    S.ballot = null;
    S.loadErr = 'We couldn’t load that ballot. Check your connection and try again.';
    render();
  }
}

async function submitZip(raw: string): Promise<void> {
  const v = String(raw || '').replace(/\D/g, '');
  S.zip = v; S.zipErr = ''; S.zipChoice = null; S.coverage = null; S.loadErr = null;
  if (v.length !== 5) { S.zipErr = 'Enter all 5 digits, like 80205.'; render(['mast']); $('#zip')?.focus(); return; }
  let idx: Index;
  try { idx = await ensureIndex(); } catch { S.loadErr = 'We couldn’t reach the guide’s data. Check your connection and try again.'; render(['mast']); return; }
  const places = idx.zips[v] || [];
  if (places.length === 1) return openBallot(idx.places[places[0]].state, places, v);
  if (places.length > 1) { S.zipChoice = { zip: v, placeIds: places }; render(['mast']); $(`[data-fk="cp-${CSS.escape(places[0])}"]`)?.focus(); return; }
  const st = zipState(v);
  if (st && idx.states[st]) return openBallot(st, [], v);
  if (!st) { S.zipErr = 'We couldn’t find that ZIP. Check the digits and try again.'; render(['mast']); $('#zip')?.focus(); return; }
  S.coverage = { kind: 'not_covered', state: st, zip: v };
  render(['mast']);
}

/* ---------- address lookup ---------- */
async function runAddress(addr: string): Promise<void> {
  const b = S.ballot;
  if (!b) return;
  if (addr.trim().length < 6) { S.ui.addrMsg = 'Enter a street address with the city or ZIP.'; render(['mast']); return; }
  S.ui.addrBusy = true; S.ui.addrMsg = null; render(['mast']);
  let r;
  try { r = await censusLookup(addr.trim()); }
  catch { S.ui.addrBusy = false; S.ui.addrMsg = 'The Census lookup didn’t answer. Try again, or answer the district questions yourself.'; render(['mast']); return; }
  S.ui.addrBusy = false;
  if (!r) { S.ui.addrMsg = 'The Census lookup couldn’t find that address. Try adding the city and ZIP.'; render(['mast']); return; }
  if (r.state && r.state !== b.st) { S.ui.addrMsg = `That address is outside ${b.stateName}. Change your ZIP first.`; render(['mast']); return; }
  // A ZIP that crosses city lines: let the address pick the city.
  if (b.places.length > 1 && r.place) {
    const hit = b.places.find((p) => p.label.toLowerCase() === r!.place!.toLowerCase());
    if (hit) { await openBallot(b.st, [hit.id], S.b.zip); return applyGeo(r); }
  }
  applyGeo(r);
}
function applyGeo(r: { cd: number | null; upper: number | null; lower: number | null; county: string | null; place: string | null }): void {
  const b = S.ballot!;
  const num = (k: 'cd' | 'upper' | 'lower') => r[k];
  let answered = 0;
  for (const g of b.groups) {
    if (!g.kind || num(g.kind) == null) continue;
    const hit = g.members.find((id) => contestDistrict(b.byId.get(id) as Contest).n === num(g.kind!));
    S.b.districts[g.key] = hit || 'none';
    answered++;
  }
  for (const id of b.mayApply) {
    const c = b.byId.get(id);
    if (!c || c.kind !== 'contest') continue;
    const d = contestDistrict(c);
    if (!d.kind || num(d.kind) == null) continue;
    S.b.notMine = S.b.notMine.filter((x) => x !== id);
    if (d.n !== num(d.kind)) S.b.notMine.push(id);
    answered++;
  }
  const parts = [r.cd != null ? `Congressional District ${r.cd}` : '', r.upper != null ? `State Senate ${r.upper}` : '', r.lower != null ? `State House ${r.lower}` : ''].filter(Boolean);
  S.b.addrNote = parts.length ? `From the address you entered: ${parts.join(', ')}. We didn’t keep the address. Double-check with your sample ballot.` : null;
  S.ui.addrOpen = false;
  S.ui.addrMsg = null;
  render();
  persist();
  toast(answered ? `Matched ${answered} district ${answered === 1 ? 'question' : 'questions'} from your address.` : 'Found your address, but none of the district questions here depend on it.');
}

/* ---------- actions ---------- */
type Act = (d: DOMStringMap, el: HTMLElement) => void | Promise<void>;
const A: Record<string, Act> = {};
const ballotWide = () => render(['sources', 'offer', 'ballot', 'cheat', 'bar']);

A.open = (d, el) => {
  const k = d.k!;
  S.ui.open.has(k) ? S.ui.open.delete(k) : S.ui.open.add(k);
  rerenderAround(el);
};
function rerenderAround(el: HTMLElement): void {
  const sec = el.closest<HTMLElement>('.sec');
  if (sec && sec.dataset.sec) return renderSection(sec.dataset.sec as SectionKey);
  const reg = el.closest<HTMLElement>('[id^="r-"]');
  if (reg) render([reg.id.slice(2) as Region]);
}
A['choose-place'] = (d) => { const ids = d.ids!.split('+'); const idx = S.index!; void openBallot(idx.places[ids[0]].state, ids, S.zipChoice ? S.zipChoice.zip : ''); };
A['choose-state'] = (d) => { void openBallot(d.st!, [], ''); };
A['change-place'] = () => {
  S.view = 'start'; S.ballot = null; S.zipChoice = null; S.coverage = null; S.pending = null;
  forgetLast();
  render();
  window.scrollTo(0, 0);
  $('#zip')?.focus();
};

A.pick = (d) => {
  const id = d.id!; const v = d.v!;
  S.b.picks[id] = v;
  delete S.b.auto[id];
  S.ui.expanded.delete(id);
  afterPick(id);
};
A.skip = (d) => {
  const id = d.id!;
  if (S.b.picks[id] === 'SKIP') delete S.b.picks[id]; else S.b.picks[id] = 'SKIP';
  delete S.b.auto[id];
  S.ui.expanded.delete(id);
  afterPick(id);
};
A.clear = (d) => {
  const id = d.id!;
  const it = S.ballot!.byId.get(id);
  delete S.b.picks[id]; delete S.b.auto[id]; delete S.b.ranks[id];
  if (it && it.kind === 'contest') it.candidates.forEach((c) => { delete S.b.picks[`${id}|${c.name}`]; });
  if (!S.b.noAuto.includes(id)) S.b.noAuto.push(id);
  S.ui.expanded.delete(id);
  afterPick(id);
  if (d.fk === `rc-${id}`) document.querySelector<HTMLElement>(`#i-${CSS.escape(id)} [data-act="rank"]`)?.focus({ preventScroll: true });
};
A.change = (d) => { S.ui.expanded.add(d.id!); afterPick(d.id!); };
A.fold = (d) => { S.ui.expanded.delete(d.id!); afterPick(d.id!); };
A['undo-auto'] = (d) => {
  const id = d.id!;
  delete S.b.picks[id]; delete S.b.auto[id];
  if (!S.b.noAuto.includes(id)) S.b.noAuto.push(id);
  afterPick(id);
  toast('Undone. That race is open again.');
};
A.jpick = (d) => {
  const k = d.k!; const id = k.split('|')[0];
  if (S.b.picks[k] === d.v) delete S.b.picks[k]; else S.b.picks[k] = d.v!;
  if (S.b.picks[id] === 'SKIP') delete S.b.picks[id];
  afterPick(id);
};
A.mpick = (d) => {
  const id = d.id!; const k = `${id}|${d.v}`;
  const c = S.ballot!.byId.get(id) as Contest;
  if (S.b.picks[k] === 'PICK') delete S.b.picks[k];
  else {
    const n = c.candidates.filter((x) => S.b.picks[`${id}|${x.name}`] === 'PICK').length;
    if (n >= c.vote_for) { toast(`You can pick up to ${c.vote_for}. Unpick one first.`); return; }
    S.b.picks[k] = 'PICK';
  }
  if (S.b.picks[id] === 'SKIP' || S.b.picks[id] === 'DONE') delete S.b.picks[id];
  S.ui.expanded.delete(id);
  afterPick(id);
};
A.mdone = (d) => { S.b.picks[d.id!] = 'DONE'; afterPick(d.id!); };

/* ---------- ranked choice ----------
   Tap a candidate to give them the next rank; tap again (or Remove) to take them out, and
   the ranks below move up. Move up swaps a row with the one above it. While the voter is
   working, the card stays open even once every rank is used; "Done ranking" folds it. */
const shortOf = (c: Contest, name: string): string => (c.candidates.find((k) => k.name === name) || { short: name }).short;
function setRanks(id: string, list: string[]): void {
  const c = S.ballot!.byId.get(id) as Contest;
  const showing = status(c) === 'open' || S.ui.expanded.has(id);
  if (list.length) S.b.ranks[id] = list;
  else { delete S.b.ranks[id]; if (S.b.picks[id] === 'DONE') delete S.b.picks[id]; }
  if (S.b.picks[id] === 'SKIP') delete S.b.picks[id];
  delete S.b.auto[id];
  if (showing && status(c) !== 'open') S.ui.expanded.add(id);
  afterPick(id);
}
const rkFk = (id: string, name: string, kind: 'rx' | 'ru'): string => `${kind}-${id}-${hash(name, 4)}`;
const focusFk = (fk: string): void => { document.querySelector<HTMLElement>(`[data-fk="${CSS.escape(fk)}"]`)?.focus({ preventScroll: true }); };
A.rank = (d) => {
  const id = d.id!; const name = d.v!;
  const c = S.ballot!.byId.get(id) as Contest;
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
  const c = S.ballot!.byId.get(id) as Contest;
  const list = [...(S.b.ranks[id] || [])];
  const at = list.indexOf(name);
  if (at < 0) return;
  list.splice(at, 1);
  setRanks(id, list);
  announce(`Removed ${shortOf(c, name)}.${list[at] ? ` ${shortOf(c, list[at])} is now ${ordinal(at + 1)}.` : ''}`);
  // Focus the row that took its place, else the one above, else the first Rank button.
  const next = list[at] || list[at - 1];
  if (next) focusFk(rkFk(id, next, 'rx'));
  else document.querySelector<HTMLElement>(`#i-${CSS.escape(id)} [data-act="rank"]`)?.focus({ preventScroll: true });
};
A.rup = (d) => {
  const id = d.id!; const name = d.v!;
  const c = S.ballot!.byId.get(id) as Contest;
  const list = [...(S.b.ranks[id] || [])];
  const at = list.indexOf(name);
  if (at <= 0) return;
  [list[at - 1], list[at]] = [list[at], list[at - 1]];
  setRanks(id, list);
  announce(`${shortOf(c, name)} moved up to ${ordinal(at)}.`);
  if (at - 1 === 0) focusFk(rkFk(id, name, 'rx'));
};
A.rdone = (d) => {
  const id = d.id!;
  if (!(S.b.ranks[id] || []).length) return;
  S.b.picks[id] = 'DONE';
  S.ui.expanded.delete(id);
  afterPick(id);
  focusFk(`chg-${id}`);
};
A.note = (d) => { S.ui.noteOpen.add(d.id!); const it = S.ballot!.byId.get(d.id!); if (it) renderSection(sectionOf(it)); $(`[data-note="${CSS.escape(d.id!)}"]`)?.focus(); };
A.why = (d) => { S.ui.why[d.k!] = S.ui.why[d.k!] === d.e ? null : d.e!; const it = S.ballot!.byId.get(d.k!); if (it) renderSection(sectionOf(it)); };
A.showall = (d) => { const id = d.id!; S.ui.showAll.has(id) ? S.ui.showAll.delete(id) : S.ui.showAll.add(id); afterPick(id); };
const sectionChanged = (id: string) => { const it = S.ballot!.byId.get(id); if (it) renderSection(sectionOf(it)); render(['bar', 'offer']); renderLazy(); persist(); };
A.notmine = (d) => { if (!S.b.notMine.includes(d.id!)) S.b.notMine.push(d.id!); sectionChanged(d.id!); };
A['notmine-undo'] = (d) => { S.b.notMine = S.b.notMine.filter((x) => x !== d.id); sectionChanged(d.id!); };
A.district = (d) => {
  const g = S.ballot!.groups.find((x) => x.key === d.g)!;
  S.b.districts[g.key] = d.v!;
  const sec = sectionOf(S.ballot!.byId.get(g.members[0])!);
  if (S.prefs.autoPick) applyAuto();
  renderSection(sec);
  render(['bar', 'offer']);
  renderLazy();
  persist();
  keepInView(`#${groupId(g)}`);
};
A['district-change'] = (d) => {
  const g = S.ballot!.groups.find((x) => x.key === d.g)!;
  delete S.b.districts[g.key];
  renderSection(sectionOf(S.ballot!.byId.get(g.members[0])!));
  render(['bar']);
  renderLazy();
  persist();
  $(`#${groupId(g)} .choice`)?.focus();
};
A.sec = (d) => { const s = d.sec as SectionKey; S.ui.collapsed.has(s) ? S.ui.collapsed.delete(s) : S.ui.collapsed.add(s); renderSection(s); };
A.jump = (d) => {
  if (S.ui.filterOpen) { S.ui.shelfFrom = null; A['filter-close']({}, document.body); }
  const it = S.ballot!.byId.get(d.id!);
  if (!it) return;
  const sec = sectionOf(it);
  if (S.ui.collapsed.has(sec)) { S.ui.collapsed.delete(sec); renderSection(sec); }
  scrollToEl($(`#i-${CSS.escape(d.id!)}`));
};
A.next = () => {
  const items = decisionItems().filter((i) => !i.done);
  if (!items.length) return;
  const b = S.ballot!;
  const elFor = (i: { id: string; question?: boolean }) => {
    if (i.question) { const g = b.groups.find((x) => `q:${x.key}` === i.id); return g ? $(`#${groupId(g)}`) : null; }
    return $(`#i-${CSS.escape(i.id)}`);
  };
  // Open any collapsed section that holds undecided items.
  const secs = new Set<SectionKey>();
  items.forEach((i) => { if (!elFor(i)) { const id = i.question ? b.groups.find((x) => `q:${x.key}` === i.id)!.members[0] : i.id; secs.add(sectionOf(b.byId.get(id)!)); } });
  secs.forEach((s) => { S.ui.collapsed.delete(s); renderSection(s); });
  const els = items.map(elFor).filter((x): x is HTMLElement => !!x);
  const target = els.find((el) => el.getBoundingClientRect().top > 12) || els[0];
  if (!target) return;
  scrollToEl(target);
  const h = target.querySelector<HTMLElement>('h3') || target;
  h.setAttribute('tabindex', '-1');
  h.focus({ preventScroll: true });
};
/* The Filter shelf. Opened from the sources line, it scrolls to the sources section and
   moves focus to its heading. */
function openShelf(at: 'top' | 'sources', from: string): void {
  S.ui.filterOpen = true; S.ui.gridOpen = false; S.ui.shelfFrom = from;
  render(['sheet']);
  if (at === 'sources') {
    const bd = $('.sheet-bd'); const sec = $('#flt-src');
    if (bd && sec) bd.scrollTop += sec.getBoundingClientRect().top - bd.getBoundingClientRect().top - 4;
    $('#flt-src-h')?.focus({ preventScroll: true });
  } else $('[data-fk="flt-x"]')?.focus();
}
A.filter = () => openShelf('top', 'bar-filter');
A.sources = () => openShelf('sources', 'sources-btn');
A['go-sources'] = () => openShelf('sources', 'bar-filter');
A['grid-open'] = () => { S.ui.gridOpen = true; render(['sheet']); $('[data-fk="grid-back"]')?.focus(); };
A['grid-close'] = () => {
  S.ui.gridOpen = false; render(['sheet']);
  const bd = $('.sheet-bd'); const btn = $('[data-fk="grid-open"]');
  if (bd && btn) bd.scrollTop += btn.getBoundingClientRect().top - bd.getBoundingClientRect().top - 80;
  btn?.focus({ preventScroll: true });
};
A['filter-close'] = () => {
  S.ui.filterOpen = false; S.ui.gridOpen = false;
  if (filterDirty) { filterDirty = false; render(['sheet', 'sources', 'offer', 'ballot', 'bar']); renderLazy(); } else render(['sheet']);
  $(`[data-fk="${S.ui.shelfFrom || 'bar-filter'}"]`)?.focus();
};
/* Inside the sheet, only the sheet re-renders; the ballot catches up when it closes. */
let filterDirty = false;
const filterChanged = () => {
  persist();
  if (S.ui.filterOpen) { filterDirty = true; render(['sheet']); return; }
  render(['sources', 'offer', 'ballot', 'bar']); renderLazy();
};
A.party = (d) => {
  const p = d.p!;
  const all = ['D', 'R', 'O', 'I'];
  let sel = S.prefs.parties ? [...S.prefs.parties] : [...all];
  sel = sel.includes(p) ? sel.filter((x) => x !== p) : [...sel, p];
  S.prefs.parties = all.every((x) => sel.includes(x)) ? null : sel;
  filterChanged();
};
A['party-all'] = () => { S.prefs.parties = null; filterChanged(); };
A['f-endorsed'] = () => { S.prefs.endorsedOnly = !S.prefs.endorsedOnly; filterChanged(); };
A['f-fold'] = () => { S.prefs.foldDecided = !S.prefs.foldDecided; S.ui.expanded.clear(); filterChanged(); };
A['f-auto'] = () => {
  S.prefs.autoPick = !S.prefs.autoPick;
  const n = S.prefs.autoPick ? applyAuto() : 0;
  filterChanged();
  if (n) toast(`Picked ${n} ${n === 1 ? 'race' : 'races'} for you. Each one says why.`);
};
A['offer-yes'] = () => { const n = applyAuto(); ballotWide(); persist(); toast(`Picked ${n} ${n === 1 ? 'race' : 'races'}. Each says why, with an Undo.`); };
A['offer-no'] = () => { S.b.offerDismissed = filterSig(); render(['offer']); persist(); };
A.src = (d) => {
  const cur = chosenIds();
  S.b.sources = cur.includes(d.id!) ? cur.filter((x) => x !== d.id) : [...cur, d.id!];
  filterChanged();
};
A['src-default'] = () => { S.b.sources = null; filterChanged(); };
A['src-none'] = () => { S.b.sources = []; filterChanged(); };
A['plan-fold'] = () => { S.b.planSeen = true; S.ui.open.delete('plan'); render(['plan']); persist(); keepInView('#plan'); };
A['plan-open'] = () => { S.ui.open.add('plan'); render(['plan']); };
A['addr-open'] = () => { S.ui.addrOpen = true; S.ui.addrMsg = null; render(['mast']); scrollToEl($('.mast')); $('#addr-in')?.focus(); };
A['addr-close'] = () => { S.ui.addrOpen = false; render(['mast']); };
A['restore-yes'] = () => { if (S.pending) { S.b = S.pending.incoming; S.pending = null; render(); persist(true); toast('Using the picks from your link.'); } };
A['restore-no'] = () => { S.pending = null; render(['restore']); toast('Kept the picks on this device.'); };
A.print = () => { render(['print']); window.print(); };
A.copy = async () => {
  const text = cheatText();
  if (await copyText(text)) { S.ui.copyFallback = null; toast('Copied. Paste it into a note or a text.'); render(['cheat']); }
  else { S.ui.copyFallback = text; render(['cheat']); $('.copy-fallback')?.focus(); ($('.copy-fallback') as HTMLTextAreaElement | null)?.select(); }
};
A['save-open'] = () => { S.ui.saveOpen = !S.ui.saveOpen; render(['cheat']); };
A['copy-link'] = async () => {
  const url = shareURL();
  if (await copyText(url)) toast('Link copied. Text or email it to yourself.');
  else { const i = $('.save-url') as HTMLInputElement | null; if (i) { i.focus(); i.select(); } toast('Select the link and copy it.'); }
};

/* ---------- taps: pointerdown for mouse and pen; touch fires on a still pointerup so a
   scroll never counts as a tap; click covers the keyboard. ---------- */
let lastTap = 0;
let touch: { el: HTMLElement; x: number; y: number; t: number; id: number } | null = null;
function fire(el: HTMLElement): void {
  const fn = A[el.dataset.act || ''];
  if (!fn || (el as HTMLButtonElement).disabled) return;
  lastTap = Date.now();
  el.classList.add('is-pressed');
  window.setTimeout(() => el.classList.remove('is-pressed'), 120);
  try { void fn(el.dataset, el); } catch (e) { console.error(e); }
}
document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el) return;
  if (e.pointerType === 'touch') { touch = { el, x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId }; return; }
  fire(el);
});
document.addEventListener('pointerup', (e) => {
  if (!touch || e.pointerId !== touch.id) return;
  const t = touch; touch = null;
  if (Math.hypot(e.clientX - t.x, e.clientY - t.y) > 10 || Date.now() - t.t > 700) return;
  if ((e.target as HTMLElement).closest('[data-act]') === t.el) fire(t.el);
});
document.addEventListener('pointercancel', () => { touch = null; });
/* After a tap has fired, cancel the touch's follow-up mouse events: the page may have
   re-rendered under the finger (the Filter shelf opening, say), and a stray mousedown
   there would pull focus away from where the action put it. */
document.addEventListener('touchend', (e) => {
  if (Date.now() - lastTap < 80 && (e.target as HTMLElement).closest('[data-act]')) e.preventDefault();
}, { passive: false });
document.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el) return;
  e.preventDefault();
  if (Date.now() - lastTap < 650) return;
  fire(el);
});
document.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target as HTMLFormElement;
  if (f.dataset.form === 'zip') void submitZip((f.querySelector('input') as HTMLInputElement).value);
  if (f.dataset.form === 'addr') { const i = f.querySelector('input') as HTMLInputElement; const v = i.value; void runAddress(v); }
});
document.addEventListener('input', (e) => {
  const t = e.target as HTMLElement;
  if (t.matches('.zip-input')) { const i = t as HTMLInputElement; i.value = i.value.replace(/\D/g, '').slice(0, 5); S.zip = i.value; }
  if (t.matches('textarea[data-note]')) { const ta = t as HTMLTextAreaElement; S.b.notes[ta.dataset.note!] = ta.value; persist(); }
});
document.addEventListener('change', (e) => {
  const t = e.target as HTMLElement;
  if (t.matches('textarea[data-note]')) { renderLazy(); persist(); }
  const sel = t.closest<HTMLSelectElement>('select[data-pick-item]');
  if (sel) {
    const id = sel.dataset.pickItem!;
    if (sel.value) S.b.picks[id] = sel.value; else delete S.b.picks[id];
    delete S.b.auto[id];
    afterPick(id);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.ui.filterOpen) A[S.ui.gridOpen ? 'grid-close' : 'filter-close']({}, document.body);
});
window.addEventListener('beforeprint', () => render(['print']));

/* ---------- boot ---------- */
async function boot(): Promise<void> {
  try { const saved = readSaved(); S.prefs = { ...S.prefs, ...saved.prefs }; } catch { /* defaults */ }
  render();
  const head = parseShareHead(location.hash);
  try { await ensureIndex(); } catch { S.loadErr = 'We couldn’t reach the guide’s data. Check your connection and reload.'; render(); return; }
  if (head && S.index!.states[head.st]) {
    const places = head.places.filter((p) => S.index!.places[p]);
    return openBallot(head.st, places, head.zip, { share: head });
  }
  const last = readSaved().last;
  if (last) {
    const [st, placesStr] = last.key.split('|');
    const places = placesStr === '-' ? [] : placesStr.split('+').filter((p) => S.index!.places[p]);
    if (S.index!.states[st]) return openBallot(st, places, last.zip);
  }
  render();
}
void boot();

