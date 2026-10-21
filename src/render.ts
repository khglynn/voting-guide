/* Rendering: fixed regions written from string templates, plus row-level updates so a tap on
   a 200-item ballot repaints one row, not the page. Focus survives every re-render through
   data-fk (keyboard and screen-reader flows depend on it); scroll survives through data-keep
   on scrolling boxes and an anchor row for anything that changes heights above you. */
import { S } from './state';
import { entriesBySection, sectionOf, type SectionKey } from './ballot';
import { mastHTML, restoreHTML } from './views/mast';
import { planHTML } from './views/planstrip';
import { ballotHTML, sectionHTML, rowHTML, barHTML, qId, ballotHeadHTML, sectionFolded, countHTML, groupCounts, hiddenByOnly, tocSheetHTML, offHTML } from './views/ledger';
import { sourcesSheetHTML, partySheetHTML } from './views/lens';
import { picksSheetHTML } from './views/setup';
import { cheatSectionHTML, cheatHTML } from './views/cheat';
import { passHTML } from './views/pass';
import { trustHTML } from './views/trust';
import { readerHTML } from './views/reader';
import { reportSheetHTML } from './views/report';
import { foldAway, glideTo, sheetIn, sheetOut, land, nudgeGlide } from './motion';

export type Region = 'mast' | 'restore' | 'plan' | 'ballot' | 'cheat' | 'pass' | 'trust' | 'bar' | 'sheet' | 'print';
export const ALL: Region[] = ['mast', 'restore', 'plan', 'ballot', 'cheat', 'pass', 'trust', 'bar', 'sheet'];
/* The ballot's regions paint only once the ballot is showing: on the first page (S.view 'setup')
   the ballot is loaded for its place line and counts, and only the first page shows. */
const shown = (): boolean => !!S.ballot && S.view === 'ballot';
const html: Record<Region, () => string> = {
  mast: mastHTML,
  restore: restoreHTML,
  plan: () => (shown() && S.ui.view === 'ballot' ? planHTML() : ''),
  ballot: () => (shown() && S.ui.view === 'ballot' ? ballotHTML() : ''),
  cheat: () => (shown() && S.ui.view === 'cheat' ? cheatSectionHTML() : ''),
  pass: () => (shown() && S.ui.view === 'pass' ? passHTML() : ''),
  // The foot of the ballot and of My plan; the share page draws it above its crowd (pass.ts).
  trust: () => (shown() && S.ui.view !== 'pass' ? trustHTML() : ''),
  bar: () => (shown() ? barHTML() : ''),
  sheet: () => {
    // Report a problem or Request a city: on the first page too, before there is a ballot, and over
    // Full details, which stays behind it (inert) and comes back when it closes.
    const report = S.ui.sheet === 'report' ? reportSheetHTML() : '';
    if (S.ui.reader && S.ballot) return readerHTML(S.ui.reader, !!report) + report;
    if (report || !S.ballot) return report;
    if (S.ui.sheet === 'sources') return sourcesSheetHTML();
    if (S.ui.sheet === 'party') return partySheetHTML();
    if (S.ui.sheet === 'picks') return picksSheetHTML();
    if (S.ui.sheet === 'toc') return tocSheetHTML();
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
      // A section's header has no id of its own: the anchor is its section, measured as itself
      // (the header sits a little below the section's top, and mixing the two moved the page).
      const id = r.id || (r.closest('.sec') as HTMLElement | null)?.id || '';
      const el = id ? document.getElementById(id) : null;
      return el ? { el: id, top: el.getBoundingClientRect().top } : null;
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
  if (Math.abs(d) > 1) { window.scrollBy(0, d); nudgeGlide(d); }
}

/* The first page, repainted in parts: everything marked data-part is replaced and the ZIP box is
   left alone, so typing never loses its caret or the phone's keyboard. False when the first page
   isn't up yet (or is leaving), and the region paints whole. */
function patchDoor(el: HTMLElement): boolean {
  if (S.view === 'ballot') return false;
  const zip = el.querySelector<HTMLInputElement>('.front #zip');
  if (!zip) return false;
  const t = document.createElement('template');
  t.innerHTML = mastHTML();
  const parts = t.content.querySelectorAll<HTMLElement>('[data-part]');
  if (!t.content.querySelector('#zip') || !parts.length) return false;
  const typed = (el.querySelector('#addr-in') as HTMLInputElement | null)?.value || '';
  // A part that hasn't changed stays as it is (the place line is a live region: no repeats).
  parts.forEach((p) => { const cur = el.querySelector(`[data-part="${p.dataset.part}"]`); if (cur && cur.outerHTML !== p.outerHTML) cur.replaceWith(p); });
  const addr = el.querySelector('#addr-in') as HTMLInputElement | null;
  if (addr && typed && !addr.value) addr.value = typed;
  if (zip.value !== S.zip) zip.value = S.zip;
  if (S.zipErr) { zip.setAttribute('aria-describedby', 'zip-err'); zip.setAttribute('aria-invalid', 'true'); }
  else { zip.removeAttribute('aria-describedby'); zip.removeAttribute('aria-invalid'); }
  return true;
}

/* Only a sheet coming up over the page, or going away, moves (motion.ts). A repaint of the open one,
   or one sheet swapped for another (the Edit sheet and all sources), stays still. The report sheet
   over Full details slides up and away on its own, the reader staying put behind it. */
function paintSheet(el: HTMLElement): void {
  const was = !!el.firstElementChild;
  const next = html.sheet();
  const overReader = !!S.ui.reader && was && !!next;
  const repWas = el.querySelector<HTMLElement>(':scope > .sheet-panel.report');
  const repNow = S.ui.sheet === 'report' && !!S.ui.report;
  if (was && !next) sheetOut(el);
  else if (overReader && repWas && !repNow) sheetOut(el, [...el.querySelectorAll<HTMLElement>(':scope > .report')]);
  el.innerHTML = next;
  if (next && !was) sheetIn(el);
  else if (overReader && !repWas && repNow) sheetIn(el, el.querySelector<HTMLElement>(':scope > .sheet-panel.report'));
}

export function render(regions: Region[] = ALL): void {
  withFocusKept(() => {
    for (const r of regions) {
      const el = $(`#r-${r}`);
      if (!el) continue;
      if (r === 'mast' && patchDoor(el)) continue;
      if (r === 'sheet') { paintSheet(el); continue; }
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

/* One row (an item or a district question), in place; its section's count follows. `shut`: the
   row was open and now closes, so its old panel folds away under the header (motion.ts), and the
   fold's animation comes back for whatever moves with it. */
export function renderRow(key: string | null, counts = true, shut = false): Animation | null {
  if (!key || S.ui.view !== 'ballot') return null;
  const b = S.ballot!;
  const old = shut ? rowEl(key)?.querySelector<HTMLElement>(':scope > .ob') || null : null;
  const h = old ? old.getBoundingClientRect().height : 0;
  const fold = (): Animation | null => { const el = rowEl(key); return old && el && !el.classList.contains('is-open') ? foldAway(el, old, h) : null; };
  if (key.startsWith('q:')) {
    const g = b.groups.find((x) => `q:${x.key}` === key);
    if (g) renderSection(sectionOf(b.byId.get(g.members[0])!));
    return fold();
  }
  const it = b.byId.get(key);
  if (!it) return null;
  // Under "Hide races I've decided", a row that is now decided (and past its beat) leaves: repaint its
  // section with the same filter the full render uses, held in place.
  if (hiddenByOnly({ t: 'item', id: key }, sectionOf(it))) { anchored(() => renderSection(sectionOf(it))); return null; }
  const el = $(`#i-${CSS.escape(key)}`);
  if (!el || !el.classList.contains('row') || el.classList.contains('is-off')) { renderSection(sectionOf(it)); return fold(); }
  withFocusKept(() => { el.outerHTML = rowHTML(it); });
  if (!counts) return fold();
  const sec = sectionOf(it);
  const entries = entriesBySection().get(sec) || [];
  // Fold state changed (the section is now complete, say): repaint the section. A section that
  // just finished folds to its band; a band that had scrolled off the top comes back to the top,
  // so you see the section done and what comes next, and the band is marked.
  const isFolded = !!document.querySelector(`#sec-${sec}.folded`);
  if (sectionFolded(sec, entries) !== isFolded) {
    const band = $(`#sec-${sec}`);
    const top = band ? band.getBoundingClientRect().top : 0;
    anchored(() => renderSection(sec), `sec-${sec}`);
    const now = $(`#sec-${sec}`);
    if (now && now.classList.contains('folded')) {
      if (top < 0) window.scrollBy(0, now.getBoundingClientRect().top);
      land(now);
    }
    return null;
  }
  // The band's count, and the word after it (Show or Hide): a first decided row under "Hide races I've
  // decided" turns the plain count into a button.
  const count = document.querySelector(`#sec-${sec} > .sec-h > .sec-r`);
  if (count) withFocusKept(() => { count.outerHTML = countHTML(sec, entries, isFolded); });
  for (const [k, c] of groupCounts(sec)) {
    const g = document.querySelector(`#sec-${sec} [data-act="grp"][data-g="${CSS.escape(k)}"] .grp-ct`);
    if (g) g.textContent = c;
  }
  return fold();
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
/* The "Not on your ballot" line at the bottom of the ballot. */
export function renderOff(): void {
  const el = $('#r-off');
  if (el && S.ui.view === 'ballot') withFocusKept(() => { el.innerHTML = offHTML(); });
}
export function renderSummaries(): void {
  if (S.view !== 'ballot') { render(['mast']); return; }
  render(['bar']);
  renderOff();
  if (S.ui.sheet === 'toc') render(['sheet']);
  window.clearTimeout(lazyTimer);
  lazyTimer = window.setTimeout(() => {
    if (S.ui.view !== 'ballot' || !S.ballot) return;
    // The head can change height (the "filled in" line or the address box going away): the rows
    // you're looking at stay where they are.
    anchored(() => withFocusKept(() => {
      // Leave the head alone while the address form is open: repainting it would clear what you typed.
      const wrap = $('.wrap-led');
      if (wrap && !S.ui.addrOpen) wrap.innerHTML = ballotHeadHTML();
    }));
  }, 60);
}
/* Whose picks you see changed. The first page's chips live in its masthead. While a sheet is
   open (the Edit sheet, all sources, a party) only the sheet repaints: the ballot behind it follows
   when the sheet closes (flushLens), so a chip tap stays quick on a 200-row ballot. */
let lensDirty = false;
export function renderLens(): void {
  if (S.view !== 'ballot') { render(['mast']); return; }
  if (S.ui.sheet) { render(['sheet']); lensDirty = true; return; }
  anchored(() => render(['ballot', 'bar']));
}
/* Something the ballot shows changed while a sheet covers it (the menu's switch): repaint on close. */
export function markBehind(): void { lensDirty = true; }
export function flushLens(force = false): void {
  if (!lensDirty && !force) return;
  lensDirty = false;
  if (S.ballot && S.view === 'ballot') anchored(() => render(['ballot', 'bar']));
}

/* Bring a row into view near the top, gliding there (motion.ts); `then` runs where it lands.
   Nothing sticks at the top of the page. */
export function scrollRowIntoView(key: string, force = false, then?: () => void): void {
  const el = rowEl(key);
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (force || r.top < 0 || r.top > window.innerHeight * 0.4) glideTo(el, 4, then);
  else then?.();
}
/* Where a row's header is on screen, while any of it is in view; null when it isn't. */
export function rowTop(key: string): number | null {
  const el = rowEl(key);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < window.innerHeight ? r.top : null;
}
/* An open row whose panel starts too low to read: below 60% of the screen, or just above the bar. */
export function opensLow(key: string): boolean {
  const hd = rowEl(key)?.querySelector<HTMLElement>(':scope > .row-hd');
  if (!hd) return false;
  const bar = $('.foot');
  const floor = bar ? bar.getBoundingClientRect().top : window.innerHeight;
  return hd.getBoundingClientRect().bottom > Math.min(window.innerHeight * 0.6, floor - 80);
}
/* Put a row's header back at `top` on screen, in the same frame, after content above it changed. */
export function holdRow(key: string, top: number): void {
  const el = rowEl(key);
  if (!el) return;
  const d = el.getBoundingClientRect().top - top;
  if (Math.abs(d) >= 0.5) window.scrollBy(0, d);
}
