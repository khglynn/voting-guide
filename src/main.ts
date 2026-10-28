/* Boot and input wiring. Flows live in app.ts, controls in actions.ts, drawing in render.ts. */
import { reportError } from './errors'; // first, so it hears errors from everything after it
import './styles.css';
import { S, readSaved, persist, parseShareHead, leftBallot } from './state';
import { stepKey, planKey } from './views/planstrip';
import { render, anchored } from './render';
import { RAIL_AT } from './views/ledger';
import { ensureIndex, openBallot, zipTyped, offerResume, dismissResume, lookZip, viewed } from './app';
import { A, runAddress, sendReport, reportInput, srcSearch, clearSearch } from './actions';
import { startStats } from './stats';

/* ---------- taps: pointerdown for mouse and pen; touch fires on a still pointerup so a
   scroll never counts as a tap; click covers the keyboard. Tuned on phones in v2.1; the e2e
   keyboard check depends on the 650ms click window. ---------- */
let lastTap = 0;
let touch: { el: HTMLElement; x: number; y: number; t: number; id: number } | null = null;
function fire(el: HTMLElement): void {
  const fn = A[el.dataset.act || ''];
  if (!fn || (el as HTMLButtonElement).disabled) return;
  lastTap = Date.now();
  el.classList.add('is-pressed');
  window.setTimeout(() => el.classList.remove('is-pressed'), 120);
  dismissResume(); // "Welcome back" lasts until the first tap, whatever it is
  try { void fn(el.dataset, el); } catch (e) { console.error(e); reportError(e); } // a control's own crash: for a problem report, and a crash report (errors.ts)
  // Count the click-dedupe window from when the action finished painting, not when it started:
  // on a slow phone a long repaint could otherwise outlast it and let the follow-up click fire twice.
  lastTap = Date.now();
}
/* After a tap has fired, cancel the touch's follow-up mouse events: the page may have
   re-rendered under the finger, and a stray mousedown there would pull focus away. A control the
   tap moved into a closing sheet or panel (motion.ts, [data-husk]) counts as the control it was. */
const cancelFollowUp = (e: Event): void => {
  if (Date.now() - lastTap < 80 && (e.target as HTMLElement).closest('[data-act], [data-husk]')) e.preventDefault();
};
document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el) return;
  if (e.pointerType === 'touch') {
    touch = { el, x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId };
    // Also on the touched element itself: when the tap replaced it (a form opening where its
    // button was, one sheet swapped for another), its touchend never reaches the document.
    e.target!.addEventListener('touchend', cancelFollowUp, { once: true, passive: false });
    return;
  }
  fire(el);
});
document.addEventListener('pointerup', (e) => {
  if (!touch || e.pointerId !== touch.id) return;
  const t = touch; touch = null;
  if (Math.hypot(e.clientX - t.x, e.clientY - t.y) > 10 || Date.now() - t.t > 700) return;
  if ((e.target as HTMLElement).closest('[data-act]') === t.el) fire(t.el);
});
document.addEventListener('pointercancel', () => { touch = null; });
document.addEventListener('touchend', cancelFollowUp, { passive: false });
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
  // Enter in the ZIP box does what "Show my ballot" does.
  if (f.dataset.form === 'zip') { S.zip = (f.querySelector('input') as HTMLInputElement).value.replace(/\D/g, '').slice(0, 5); void A['setup-done']({}, f); }
  if (f.dataset.form === 'addr') { const i = f.querySelector('input') as HTMLInputElement; void runAddress(i.value); }
  if (f.dataset.form === 'report') void sendReport();
  // Enter (the phone's Search key) in the sources sheet's search: the keyboard goes, the matches stay.
  if (f.dataset.form === 'src-q') (f.querySelector('input') as HTMLInputElement).blur();
});
document.addEventListener('input', (e) => {
  const t = e.target as HTMLElement;
  if (t.matches('.zip-input')) {
    const i = t as HTMLInputElement; i.value = i.value.replace(/\D/g, '').slice(0, 5); S.zip = i.value;
    zipTyped(S.zip);
  }
  if (t.matches('textarea[data-note]')) { const ta = t as HTMLTextAreaElement; S.b.notes[ta.dataset.note!] = ta.value; persist(); }
  if (t.matches('[data-rf]')) reportInput(t as HTMLInputElement);
  if (t.matches('[data-src-q]')) srcSearch(t as HTMLInputElement);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && (S.ui.reader || S.ui.sheet)) {
    // Keep Tab inside the open dialog: from the last control back to the first, and back. (Full details
    // behind the shelf is inert, so the shelf is the one.)
    const dlg = document.querySelector<HTMLElement>('#r-sheet [role="dialog"]:not([inert])');
    if (!dlg) return;
    const all = [...dlg.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])')].filter((x) => x.offsetParent !== null || x === document.activeElement);
    if (!all.length) return;
    const first = all[0], last = all[all.length - 1];
    const inside = dlg.contains(document.activeElement);
    if (e.shiftKey && (!inside || document.activeElement === first)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (!inside || document.activeElement === last)) { e.preventDefault(); first.focus(); }
    return;
  }
  if (e.key !== 'Escape') return;
  // Escape in the sources sheet's search clears what's typed first; with nothing typed it closes the sheet.
  const t = e.target as HTMLElement;
  if (t.matches?.('[data-src-q]') && (t as HTMLInputElement).value) { e.preventDefault(); clearSearch(); return; }
  if (S.ui.sheet === 'shelf') A['sheet-close']({}, document.body);
  else if (S.ui.reader) A['reader-close']({}, document.body);
  else if (S.ui.sheet) A['sheet-close']({}, document.body);
});
window.addEventListener('beforeprint', () => render(['print']));
/* From 1180px the menu stands as a rail in the margin (drawn with the bar): crossing that width
   redraws the bar, and a menu sheet left open closes, since the rail now shows it. */
try {
  window.matchMedia(RAIL_AT).addEventListener('change', (e) => {
    if (!S.ballot || S.view !== 'ballot') return;
    if (e.matches && S.ui.sheet === 'toc') S.ui.sheet = null;
    render(['bar', 'sheet']);
  });
} catch { /* an old browser: the bar redraws on the next tap */ }
/* The next step can change while the page sits open: the polls close at 7, or midnight passes.
   Check once a minute and whenever the tab comes back; repaint the strip only when it changed. */
function refreshPlan(): void {
  if (!S.ballot || S.view !== 'ballot') return;
  if (stepKey(S.ballot.howto) !== planKey) anchored(() => render(['plan']));
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshPlan(); });
window.addEventListener('focus', refreshPlan);
window.setInterval(refreshPlan, 60_000);
/* A save link pasted into a tab that already has the guide open changes only the hash. */
window.addEventListener('hashchange', () => {
  const head = parseShareHead(location.hash);
  if (!head || !S.index || !S.index.states[head.st]) return;
  void openBallot(head.st, head.places.filter((p) => S.index!.places[p]), head.zip, { share: head });
});

/* ---------- boot ---------- */
async function boot(): Promise<void> {
  try { const saved = readSaved(); S.prefs = { ...S.prefs, ...saved.prefs }; } catch { /* defaults */ }
  try {
    const t = new URLSearchParams(location.search).get('try');
    if (t && /^(fresh|aunt|straight|sources)$/.test(t)) S.tryMode = t;
  } catch { /* ignore */ }
  try {
    // ?on=<source id>: a "Your source is in" reply's link (the workbench's vg source, Oct 28). Read once, then
    // out of the address bar, so a reload or a shared link doesn't do it again.
    const q = new URLSearchParams(location.search);
    const on = q.get('on');
    if (on && /^[a-z0-9][a-z0-9-]{1,79}$/.test(on) && !S.tryMode) S.switchOn = on;
    if (q.has('on')) { q.delete('on'); const rest = q.toString(); history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`); }
  } catch { /* ignore */ }
  render();
  const head = parseShareHead(location.hash);
  try { await ensureIndex(); } catch {
    S.loadErr = 'We couldn’t reach the guide’s data. Check your connection.';
    S.retry = () => { S.loadErr = null; void boot(); };
    render(); return;
  }
  if (head && S.index!.states[head.st]) {
    const places = head.places.filter((p) => S.index!.places[p]);
    await openBallot(head.st, places, head.zip, { share: head });
    return;
  }
  const last = S.tryMode ? null : readSaved().last;
  if (last && !last.left) {
    const [st, placesStr] = last.key.split('|');
    const places = placesStr === '-' ? [] : placesStr.split('+').filter((p) => S.index!.places[p]);
    if (S.index!.states[st]) { if (await openBallot(st, places, last.zip, { how: 'returning' })) offerResume(); return; }
  }
  // You went back to the first page from a ballot: the first page again, its ZIP in the box and the
  // saved ballot a tap away.
  if (last && last.left) { S.zip = last.zip; S.doorSaved = leftBallot(); }
  render();
  viewed();
  if (/^\d{5}$/.test(S.zip)) void lookZip(S.zip);
}
/* Focus rings are for keyboards. After a touch, the focus a repaint puts back (a band, the "Found:" line,
   a picked row) would show as a box around it until the next tap (UX walk, Oct 20), so a touch hides
   them and any key brings them back. */
document.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') document.documentElement.classList.add('touch'); }, { capture: true, passive: true });
document.addEventListener('keydown', () => { document.documentElement.classList.remove('touch'); }, { capture: true });
void boot();
/* Visit counts (stats.ts): on the guide's Vercel hosts only, once the page has loaded and gone idle. */
startStats();
