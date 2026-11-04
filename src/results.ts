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

let inflight: Promise<boolean> | null = null;
/* Read the file once. Resolves true when what the page shows changed. `bust`: Refresh, past any cache. */
export function loadResults(bust = false): Promise<boolean> {
  const st = wanted();
  if (!st) return Promise.resolve(false);
  if (R.st !== st) resetResults(st);
  if (inflight && !bust) return inflight;
  const run = async (): Promise<boolean> => {
    const before = R.file ? R.file.generated : '';
    const wasFailed = R.failed, wasNone = R.none;
    try {
      const res = await fetch(`/results/${ELECTION}/${st}.json${bust ? `?t=${Date.now()}` : ''}`, { cache: bust ? 'no-store' : 'default' });
      if (R.st !== st) return false; // the voter opened another state's ballot meanwhile
      if (res.status === 404) { R.none = true; R.failed = false; return !wasNone; }
      if (!res.ok) throw new Error(`results ${res.status}`);
      const f: unknown = await res.json();
      if (R.st !== st) return false;
      if (!readable(f, st)) throw new Error('results file unreadable');
      if (f.test && !testOK()) { R.none = !R.file; R.failed = false; return wasNone !== R.none; }
      R.none = false;
      R.failed = false;
      R.file = f;
      return f.generated !== before || wasFailed;
    } catch (e) {
      if (R.st !== st) return false;
      // A network blip is normal on a phone: say so on the page, keep the last numbers. An unreadable file is ours to fix.
      if (e instanceof Error && /unreadable/.test(e.message)) reportError(e);
      R.failed = true;
      return !wasFailed;
    }
  };
  const p = run().finally(() => { if (inflight === p) inflight = null; });
  inflight = p;
  return p;
}

/* Repaint what results touch: the strip, the ballot (its head holds the figure), and the bar's menu stays. While the
   address form is open in the ballot head, the rows repaint one by one instead, so nothing typed is lost. */
export function repaintResults(): void {
  if (!S.ballot || S.view !== 'ballot' || S.ui.view !== 'ballot') return;
  anchored(() => {
    render(['plan']);
    if (!S.ui.addrOpen) { render(['ballot']); return; }
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
  render(['plan']);
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
export function tickResults(): void {
  const st = wanted();
  if (!st) { if (R.st && (!S.ballot || S.ballot.st !== R.st)) resetResults(); return; }
  if (typeof document !== 'undefined' && document.hidden) return;
  // A screen change calls this too: no second read within 20 seconds of the last, unless it's another state's ballot.
  if (R.st === st && Date.now() - lastAt < 20_000) return;
  lastAt = Date.now();
  void loadResults().then((changed) => { if (changed) { R.nochange = null; repaintResults(); } });
}
let started = false;
export function startResults(): void {
  if (started) return;
  started = true;
  window.setInterval(tickResults, EVERY);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tickResults(); });
}
