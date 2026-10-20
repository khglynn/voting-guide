/* Boot and input wiring. Flows live in app.ts, controls in actions.ts, drawing in render.ts. */
import './styles.css';
import { S, readSaved, persist, parseShareHead } from './state';
import { stepKey, planKey } from './views/planstrip';
import { render } from './render';
import { ensureIndex, openBallot, submitZip } from './app';
import { A, runAddress } from './actions';
import { askCityURL } from './views/common';

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
  try { void fn(el.dataset, el); } catch (e) { console.error(e); }
  // Count the click-dedupe window from when the action finished painting, not when it started:
  // on a slow phone a long repaint could otherwise outlast it and let the follow-up click fire twice.
  lastTap = Date.now();
}
/* After a tap has fired, cancel the touch's follow-up mouse events: the page may have
   re-rendered under the finger, and a stray mousedown there would pull focus away. */
const cancelFollowUp = (e: Event): void => {
  if (Date.now() - lastTap < 80 && (e.target as HTMLElement).closest('[data-act]')) e.preventDefault();
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
  if (f.dataset.form === 'zip') void submitZip((f.querySelector('input') as HTMLInputElement).value);
  if (f.dataset.form === 'addr') { const i = f.querySelector('input') as HTMLInputElement; void runAddress(i.value); }
});
document.addEventListener('input', (e) => {
  const t = e.target as HTMLElement;
  if (t.matches('.zip-input')) {
    const i = t as HTMLInputElement; i.value = i.value.replace(/\D/g, '').slice(0, 5); S.zip = i.value;
    // "Ask for yours" carries whatever ZIP is in the box.
    const ask = document.querySelector<HTMLAnchorElement>('a[data-ask]');
    if (ask) ask.href = askCityURL(S.zip);
  }
  if (t.matches('textarea[data-note]')) { const ta = t as HTMLTextAreaElement; S.b.notes[ta.dataset.note!] = ta.value; persist(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && (S.ui.reader || S.ui.sheet)) {
    // Keep Tab inside the open dialog: from the last control back to the first, and back.
    const dlg = document.querySelector<HTMLElement>('#r-sheet [role="dialog"]');
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
  if (S.ui.reader) A['reader-close']({}, document.body);
  else if (S.ui.sheet) A['sheet-close']({}, document.body);
});
window.addEventListener('beforeprint', () => render(['print']));
/* The next step can change while the page sits open: the polls close at 7, or midnight passes.
   Check once a minute and whenever the tab comes back; repaint the strip only when it changed. */
function refreshPlan(): void {
  if (!S.ballot || S.view !== 'ballot') return;
  if (stepKey(S.ballot.howto) !== planKey) render(['plan']);
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
  render();
  const head = parseShareHead(location.hash);
  try { await ensureIndex(); } catch { S.loadErr = 'We couldn’t reach the guide’s data. Check your connection and reload.'; render(); return; }
  if (head && S.index!.states[head.st]) {
    const places = head.places.filter((p) => S.index!.places[p]);
    await openBallot(head.st, places, head.zip, { share: head });
    return;
  }
  const last = S.tryMode ? null : readSaved().last;
  if (last) {
    const [st, placesStr] = last.key.split('|');
    const places = placesStr === '-' ? [] : placesStr.split('+').filter((p) => S.index!.places[p]);
    if (S.index!.states[st]) { await openBallot(st, places, last.zip); return; }
  }
  render();
}
void boot();
