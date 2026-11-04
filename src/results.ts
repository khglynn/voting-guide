/* Reading the results file (Nov 3, results Phase 1). Once a ballot's polls have closed and its state has a results
   source, the page reads /results/2026-11-03/{ST}.json (the site's rewrite to the results Worker): when the ballot
   opens, every 60 seconds while the tab is visible, and on Refresh. A fetch that fails, or a file the page can't
   read, leaves the last good file in place and says so; nothing here ever throws into the page, and nothing from
   results is saved (the storage contract is unchanged). The rules for what the rows say are in model/results.ts. */
import { S } from './state';
import { afterPolls } from './model/plan';
import { R, resetResults, readable, fetchedSig, newestUpdate } from './model/results';
import { render, anchored, renderRow } from './render';
import { reportError } from './errors';
import { figureHTML } from './views/figure';
import { menuHTML } from './views/ledger';

const ELECTION = '2026-11-03';
const EVERY = 60_000;
/* ?results=test shows a hand-written file marked `test: true` (the Worker's plumbing check); otherwise it is ignored. */
const testOK = (): boolean => { try { return new URLSearchParams(location.search).get('results') === 'test'; } catch { return false; } };

/* The state whose results this ballot wants, or null: a ballot showing, its polls closed, a results source on it. */
export function wanted(): string | null {
  const b = S.ballot;
  if (!b || S.view !== 'ballot') return null;
  if (!afterPolls(b.howto) || !(b.howto.results?.sources || []).length) return null;
  return b.st;
}

/* The read in flight, for which state; and a sequence number, so a slower read that started earlier (an automatic one
   overtaken by Refresh) can never replace what a later one brought (Codex, Nov 3). */
let inflight: { st: string; p: Promise<boolean> } | null = null;
let seq = 0;
/* Read the file once. Resolves true when what the page shows changed. `bust`: Refresh, past any cache. */
export function loadResults(bust = false): Promise<boolean> {
  const st = wanted();
  if (!st) return Promise.resolve(false);
  if (R.st !== st) resetResults(st);
  if (inflight && inflight.st === st && !bust) return inflight.p;
  const mine = ++seq;
  const stale = (): boolean => R.st !== st || mine !== seq;
  const run = async (): Promise<boolean> => {
    const before = R.file ? R.file.generated : '';
    const wasFailed = R.failed, wasNone = R.none;
    try {
      // A read that hangs counts as failed after 15 seconds, so the rows never wait on "Checking…" for good (overnight).
      const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ac ? setTimeout(() => ac.abort(), 15_000) : null;
      const res = await fetch(`/results/${ELECTION}/${st}.json${bust ? `?t=${Date.now()}` : ''}`, { cache: bust ? 'no-store' : 'default', ...(ac ? { signal: ac.signal } : {}) })
        .finally(() => { if (timer) clearTimeout(timer); });
      if (stale()) return false; // another ballot, or a later read, owns the page now
      // No file for this state: nothing about results shows. After a good file, though, a 404 is a failed read: the
      // numbers already on the rows stay, and the strip says it couldn't check.
      if (res.status === 404 && !R.file) { R.none = true; R.failed = false; return !wasNone; }
      if (!res.ok) throw new Error(`results ${res.status}`);
      const f: unknown = await res.json();
      if (stale()) return false;
      if (!readable(f, st)) throw new Error('results file unreadable');
      if (f.test && !testOK()) { R.none = !R.file; R.failed = false; return wasNone !== R.none; }
      // A cached copy older than the file already shown never replaces it.
      if (R.file && Date.parse(f.generated) < Date.parse(R.file.generated)) { R.failed = false; return wasFailed; }
      R.none = false;
      R.failed = false;
      R.file = f;
      return f.generated !== before || wasFailed;
    } catch (e) {
      if (stale()) return false;
      // A network blip is normal on a phone: say so on the page, keep the last numbers. An unreadable file is ours to fix.
      if (e instanceof Error && /unreadable/.test(e.message)) reportError(e);
      R.failed = true;
      return !wasFailed;
    }
  };
  const p = run().finally(() => { if (inflight && inflight.p === p) inflight = null; });
  inflight = { st, p };
  return p;
}

/* Repaint what results touch: the strip, the ballot (its head holds the figure), and the bar's menu stays. While the
   address form is open in the ballot head, the rows repaint one by one instead, so nothing typed is lost. */
export function repaintResults(): void {
  if (!S.ballot || S.view !== 'ballot' || S.ui.view !== 'ballot') return;
  // The menu sheet, when open, is results-first too: its body repaints in place, scroll and focus kept where they can be.
  const toc = S.ui.sheet === 'toc' ? document.querySelector<HTMLElement>('.sheet-panel.toc .sheet-bd') : null;
  if (toc) {
    const fk = (document.activeElement as HTMLElement | null)?.dataset?.fk;
    toc.innerHTML = menuHTML('toc');
    if (fk) document.querySelector<HTMLElement>(`.sheet-panel.toc [data-fk="${CSS.escape(fk)}"]`)?.focus();
  }
  anchored(() => {
    render(['plan', 'bar']);
    if (!S.ui.addrOpen) { render(['ballot']); return; }
    // The head always carries #vz once the polls close (a hidden placeholder before the first file), so the figure
    // can arrive while the address form stays open.
    const fig = document.getElementById('vz');
    if (fig) fig.outerHTML = figureHTML();
    document.querySelectorAll<HTMLElement>('#r-ballot li.row[data-item]').forEach((el) => renderRow(el.dataset.item!, false));
  });
}

/* Refresh (the strip's button): read now, past the cache. When no source was read again since the last look, the strip
   says "No change since 9:35 PM CT" instead of a fresh time (DESIGN.md rule 4). */
export async function refreshResults(): Promise<void> {
  if (!wanted() || R.checking) return;
  const sig = fetchedSig(R.file);
  R.checking = true;
  R.nochange = null;
  render(['plan', 'bar']);
  const toc = S.ui.sheet === 'toc' ? document.querySelector<HTMLElement>('.sheet-panel.toc .sheet-bd') : null;
  if (toc) { const fk = (document.activeElement as HTMLElement | null)?.dataset?.fk; toc.innerHTML = menuHTML('toc'); if (fk) document.querySelector<HTMLElement>(`.sheet-panel.toc [data-fk="${CSS.escape(fk)}"]`)?.focus(); }
  try {
    await loadResults(true);
  } finally {
    R.checking = false;
    R.nochange = R.file && !R.failed && fetchedSig(R.file) === sig ? newestUpdate() || null : null;
    repaintResults();
  }
}

/* Called when a ballot opens, the polls close on an open page, the tab comes back, and once a minute. */
let lastAt = 0;
let owed = false;
const typing = (): boolean => { const a = typeof document !== 'undefined' ? document.activeElement : null; return !!a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && (a as HTMLInputElement).type !== 'checkbox')); };
export function tickResults(): void {
  const st = wanted();
  if (!st) { if (R.st && (!S.ballot || S.ballot.st !== R.st)) resetResults(); return; }
  if (typeof document !== 'undefined' && document.hidden) return;
  // A screen change calls this too: no second read within 20 seconds of the last, unless it's another state's ballot.
  if (R.st === st && Date.now() - lastAt < 20_000) { if (owed && !typing()) { owed = false; repaintResults(); } return; }
  lastAt = Date.now();
  void loadResults().then((changed) => {
    if (changed) { R.nochange = null; owed = true; }
    // Never under someone's typing (a note in an open row): the new numbers wait for the next minute.
    if (owed && !typing()) { owed = false; repaintResults(); }
  });
}
let started = false;
export function startResults(): void {
  if (started) return;
  started = true;
  window.setInterval(tickResults, EVERY);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tickResults(); });
}
