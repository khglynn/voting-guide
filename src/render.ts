/* Rendering: fixed regions written from string templates, plus row-level updates so a tap on
   a 200-item ballot repaints one row, not the page. Focus survives every re-render through
   data-fk (keyboard and screen-reader flows depend on it); scroll survives through data-keep
   on scrolling boxes and an anchor row for anything that changes heights above you. */
import { S } from './state';
import { entriesBySection, sectionOf, type SectionKey } from './ballot';
import { mastHTML, restoreHTML } from './views/mast';
import { planHTML } from './views/planstrip';
import { ballotHTML, sectionHTML, rowHTML, barHTML, qId, ballotHeadHTML, sectionFolded, sectionCount, groupCounts, hiddenByOnly } from './views/ledger';
import { sourcesSheetHTML, partySheetHTML } from './views/lens';
import { picksSheetHTML } from './views/setup';
import { cheatSectionHTML, cheatHTML } from './views/cheat';
import { passHTML } from './views/pass';
import { trustHTML } from './views/trust';
import { readerHTML } from './views/reader';

export type Region = 'mast' | 'restore' | 'plan' | 'ballot' | 'cheat' | 'pass' | 'trust' | 'bar' | 'sheet' | 'print';
export const ALL: Region[] = ['mast', 'restore', 'plan', 'ballot', 'cheat', 'pass', 'trust', 'bar', 'sheet'];
/* The ballot's regions paint only once the ballot is showing: during step 2 (S.view 'setup') the
   ballot is loaded for its counts, and only the first page shows. */
const shown = (): boolean => !!S.ballot && S.view === 'ballot';
const html: Record<Region, () => string> = {
  mast: mastHTML,
  restore: restoreHTML,
  plan: () => (shown() && S.ui.view === 'ballot' ? planHTML() : ''),
  ballot: () => (shown() && S.ui.view === 'ballot' ? ballotHTML() : ''),
  cheat: () => (shown() && S.ui.view === 'cheat' ? cheatSectionHTML() : ''),
  pass: () => (shown() && S.ui.view === 'pass' ? passHTML() : ''),
  trust: () => (S.ui.view === 'ballot' ? trustHTML() : ''),
  bar: () => (shown() ? barHTML() : ''),
  sheet: () => {
    if (!S.ballot) return '';
    if (S.ui.reader) return readerHTML(S.ui.reader);
    if (S.ui.sheet === 'sources') return sourcesSheetHTML();
    if (S.ui.sheet === 'party') return partySheetHTML();
    if (S.ui.sheet === 'picks') return picksSheetHTML();
    return '';
  },
  print: () => (shown() ? cheatHTML(true) : ''),
};
export const $ = (sel: string): HTMLElement | null => document.querySelector(sel) as HTMLElement | null;

export function withFocusKept(fn: () => void): void {
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

/* Keep what you're looking at still while content above it changes height. */
function anchorRow(): { el: string; top: number } | null {
  const rows = document.querySelectorAll<HTMLElement>('.ledger .row, .ledger .sec-hd');
  for (const r of rows) {
    const rect = r.getBoundingClientRect();
    if (rect.bottom > 4) {
      const id = r.id || (r.closest('.sec') as HTMLElement | null)?.id || '';
      return id ? { el: id, top: rect.top } : null;
    }
  }
  return null;
}
export function anchored(fn: () => void, anchorId?: string): void {
  const a = anchorId ? (() => { const el = document.getElementById(anchorId); return el ? { el: anchorId, top: el.getBoundingClientRect().top } : null; })() : anchorRow();
  fn();
  if (!a) return;
  const el = document.getElementById(a.el);
  if (!el) return;
  const d = el.getBoundingClientRect().top - a.top;
  if (Math.abs(d) > 1) window.scrollBy(0, d);
}

export function render(regions: Region[] = ALL): void {
  withFocusKept(() => {
    for (const r of regions) {
      const el = $(`#r-${r}`);
      if (!el) continue;
      el.innerHTML = html[r]();
    }
    document.body.classList.toggle('has-bar', shown());
    document.body.classList.toggle('sheet-open', !!(S.ui.sheet || S.ui.reader));
    setModal(!!(S.ui.sheet || S.ui.reader));
    ['ballot', 'cheat', 'pass'].forEach((v) => document.body.classList.toggle(`v-${v}`, shown() && S.ui.view === v));
  });
}

/* While a sheet or Full details is open, everything behind it is inert: no Tab, no taps, no
   screen reader. main.ts also wraps Tab inside the open dialog, for browsers without inert. */
function setModal(on: boolean): void {
  for (const sel of ['#app', '#r-bar', '.skip', '.toast']) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) el.inert = on;
  }
}

/* One section, in place. */
export function renderSection(sec: SectionKey): void {
  if (S.ui.view !== 'ballot') return;
  const entries = entriesBySection().get(sec) || [];
  withFocusKept(() => {
    const el = $(`#sec-${sec}`);
    const next = sectionHTML(sec, entries);
    if (!el) { renderBallot(); return; }
    if (!next) { el.remove(); return; }
    el.outerHTML = next;
  });
}
export function renderBallot(): void { anchored(() => render(['ballot'])); }

/* One row (an item or a district question), in place; its section's count follows. */
export function renderRow(key: string | null, counts = true): void {
  if (!key || S.ui.view !== 'ballot') return;
  const b = S.ballot!;
  if (key.startsWith('q:')) {
    const g = b.groups.find((x) => `q:${x.key}` === key);
    if (g) renderSection(sectionOf(b.byId.get(g.members[0])!));
    return;
  }
  const it = b.byId.get(key);
  if (!it) return;
  // Under "Only undecided", a row that is now decided leaves: repaint its section with the
  // same filter the full render uses, held in place.
  if (hiddenByOnly({ t: 'item', id: key })) { anchored(() => renderSection(sectionOf(it))); return; }
  const el = $(`#i-${CSS.escape(key)}`);
  if (!el || !el.classList.contains('row') || el.classList.contains('is-off')) { renderSection(sectionOf(it)); return; }
  withFocusKept(() => { el.outerHTML = rowHTML(it); });
  if (!counts) return;
  const sec = sectionOf(it);
  const entries = entriesBySection().get(sec) || [];
  // Fold state changed (the section is now complete, say): repaint the section, held in place.
  const isFolded = !!document.querySelector(`#sec-${sec}.folded`);
  if (sectionFolded(sec, entries) !== isFolded) { anchored(() => renderSection(sec), `sec-${sec}`); return; }
  const count = document.querySelector(`#sec-${sec} .sec-count`);
  if (count) count.textContent = sectionCount(entries);
  for (const [k, c] of groupCounts(sec)) {
    const g = document.querySelector(`#sec-${sec} [data-act="grp"][data-g="${CSS.escape(k)}"] .grp-ct`);
    if (g) g.textContent = c;
  }
}
export const rowEl = (key: string): HTMLElement | null => {
  if (key.startsWith('q:')) { const g = S.ballot!.groups.find((x) => `q:${x.key}` === key); return g ? $(`#${qId(g)}`) : null; }
  return $(`#i-${CSS.escape(key)}`);
};

/* The address form lives in the ballot head on a ballot, in the masthead on the place question. */
export function renderAddr(): void {
  // What you typed stays in the box across "Looking up..." and any message, so a miss can be
  // fixed instead of retyped. It lives only in the page, never in saved state.
  const typed = ($('#addr-in') as HTMLInputElement | null)?.value || '';
  const wrap = $('.wrap-led');
  if (S.ballot && S.view === 'ballot' && S.ui.view === 'ballot' && wrap) withFocusKept(() => { wrap.innerHTML = ballotHeadHTML(); });
  else render(['mast']);
  const i = $('#addr-in') as HTMLInputElement | null;
  if (i && typed && !i.value) i.value = typed;
}

/* The parts that summarize the whole ballot: the bar (and its menu), then the ballot head. */
let lazyTimer: number | undefined;
export function renderSummaries(): void {
  if (S.view === 'setup') { render(['mast']); return; }
  render(['bar']);
  if (S.ui.sheet === 'toc') render(['sheet']);
  window.clearTimeout(lazyTimer);
  lazyTimer = window.setTimeout(() => {
    if (S.ui.view !== 'ballot' || !S.ballot) return;
    withFocusKept(() => {
      // Leave the head alone while the address form is open: repainting it would clear what you typed.
      const wrap = $('.wrap-led');
      if (wrap && !S.ui.addrOpen) wrap.innerHTML = ballotHeadHTML();
    });
  }, 60);
}
/* Whose picks you see changed. Step 2's chips live in the first page's masthead. While a sheet is
   open (the Edit sheet, all sources, a party) only the sheet repaints: the ballot behind it follows
   when the sheet closes (flushLens), so a chip tap stays quick on a 200-row ballot. */
let lensDirty = false;
export function renderLens(): void {
  if (S.view === 'setup') { render(['mast']); return; }
  if (S.ui.sheet) { render(['sheet']); lensDirty = true; return; }
  anchored(() => render(['ballot', 'bar']));
}
export function flushLens(force = false): void {
  if (!lensDirty && !force) return;
  lensDirty = false;
  if (S.ballot && S.view === 'ballot') anchored(() => render(['ballot', 'bar']));
}

/* Bring a row into view near the top. Nothing sticks at the top of the page. */
export function scrollRowIntoView(key: string, force = false): void {
  const el = rowEl(key);
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (force || r.top < 0 || r.top > window.innerHeight * 0.4) window.scrollBy(0, r.top - 4);
}
