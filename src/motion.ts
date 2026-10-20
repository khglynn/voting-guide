/* Motion, small and calm ("subtle, delightful"; the paper skin's rule: real but not loud).
   - A row opens downward from its header and folds back up into it. The header never moves.
   - A pick draws its tick in the box and settles its verdict in gold.
   - A jump (the menu, Next up, My plan's lines, a section band) glides to where it goes and marks
     where it landed, so the eye finds it.
   - Sheets slide up over a fading scrim and slide back down.
   Only transform, opacity and one container's height (with its padding) animate, through the Web
   Animations API: a repaint that replaces an element drops its animation, and the new element is
   already in its end state, so nothing restarts. With prefers-reduced-motion everything lands at
   once, in the same end state. */

/* Ease-out, the same curve in CSS terms and in the scroll tween, so a fold and the scroll that
   follows it move as one. */
const OUT = 'cubic-bezier(.33, 1, .68, 1)';
const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);
export const OPEN_MS = 200;
export const SHUT_MS = 160;
export const SHEET_MS = 200;

export function still(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return true; }
}
const canAnimate = (el: Element | null | undefined): el is HTMLElement => !!el && typeof (el as HTMLElement).animate === 'function' && !still();

/* What's left of something on its way out: no ids, no controls, nothing a script or a test can
   find by name, and nothing a screen reader or a tap can reach. data-husk tells main.ts that a tap
   which began on a control now in here still was a tap on a control. */
function husk(el: HTMLElement): void {
  el.setAttribute('data-husk', '');
  el.setAttribute('aria-hidden', 'true');
  el.inert = true;
  el.removeAttribute('id');
  el.querySelectorAll('[id],[data-act],[data-fk],[data-keep],[data-note]').forEach((x) => {
    ['id', 'data-act', 'data-fk', 'data-keep', 'data-note'].forEach((a) => x.removeAttribute(a));
  });
}

/* ---------- a row ---------- */
/* The open row's panel grows from nothing to its height under the header, with a light fade. */
export function growOpen(row: HTMLElement | null): void {
  const ob = row?.querySelector<HTMLElement>(':scope > .ob');
  if (!canAnimate(ob)) return;
  const h = ob.offsetHeight;
  if (h < 2) return;
  const cs = getComputedStyle(ob);
  ob.classList.add('moving');
  const a = ob.animate([
    { height: '0px', paddingTop: '0px', paddingBottom: '0px' },
    { height: `${h}px`, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom },
  ], { duration: OPEN_MS, easing: OUT });
  ob.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_MS * 0.7, easing: 'linear' });
  const done = (): void => ob.classList.remove('moving');
  a.onfinish = done;
  a.oncancel = done;
}

/* A row that just closed: its old panel, at the height it had (`h`, measured before the repaint,
   mid-animation or not), folds up under the new header and is gone. Returns its animation. */
export function foldAway(row: HTMLElement | null, old: HTMLElement | null, h: number): Animation | null {
  const hd = row?.querySelector<HTMLElement>(':scope > .row-hd');
  if (!hd || !canAnimate(old) || h < 2) return null;
  old.getAnimations?.().forEach((x) => x.cancel());
  husk(old);
  old.classList.remove('ob', 'moving');
  old.classList.add('ob-gone');
  hd.after(old);
  const cs = getComputedStyle(old);
  // The panel closes like a blind from the bottom up, its words fading as it goes.
  const a = old.animate([
    { height: `${h}px`, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom },
    { height: '0px', paddingTop: '0px', paddingBottom: '0px' },
  ], { duration: SHUT_MS, easing: OUT, fill: 'forwards' });
  old.animate([{ opacity: 1 }, { opacity: 0 }], { duration: SHUT_MS, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' });
  const end = (): void => old.remove();
  a.onfinish = end;
  a.oncancel = end;
  return a;
}

/* A pick that closed its row: the pen tick draws itself in the box and the verdict settles in gold. */
const INK = '<svg class="ink" viewBox="0 0 26 24" aria-hidden="true" focusable="false"><path d="M4 13.6c1.6 1.1 3 2.8 4.1 5C11 12 15.4 6.6 22.4 2.6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
export function inkRow(row: HTMLElement | null): void {
  if (!row || still()) return;
  const box = row.classList.contains('is-done') ? row.querySelector<HTMLElement>('.mk i') : null;
  if (box) box.insertAdjacentHTML('beforeend', INK);
  row.classList.add('flash');
  window.setTimeout(() => { row.classList.remove('flash'); box?.querySelector('.ink')?.remove(); }, 700);
}

/* ---------- a disclosure off the ballot ("How this guide works") ----------
   The same open and fold as a row's panel: its body grows down from its button, and a body that
   just closed folds back up into it. */
export function grow(el: HTMLElement | null): void {
  if (!canAnimate(el)) return;
  const h = el.offsetHeight;
  if (h < 2) return;
  el.classList.add('moving');
  const a = el.animate([{ height: '0px' }, { height: `${h}px` }], { duration: OPEN_MS, easing: OUT });
  el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_MS * 0.7, easing: 'linear' });
  const done = (): void => el.classList.remove('moving');
  a.onfinish = done;
  a.oncancel = done;
}
/* `old` (the body as it was, `h` tall) goes back in after `at` as a husk and folds away. */
export function shrinkAway(at: HTMLElement | null, old: HTMLElement | null, h: number): void {
  if (!at || !canAnimate(old) || h < 2) return;
  old.getAnimations?.().forEach((x) => x.cancel());
  husk(old);
  old.classList.remove('moving');
  old.classList.add('gone');
  at.after(old);
  const a = old.animate([{ height: `${h}px` }, { height: '0px' }], { duration: SHUT_MS, easing: OUT, fill: 'forwards' });
  old.animate([{ opacity: 1 }, { opacity: 0 }], { duration: SHUT_MS, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' });
  const end = (): void => old.remove();
  a.onfinish = end;
  a.oncancel = end;
}

/* ---------- scrolling ---------- */
let tween = 0;
let unhook: (() => void) | null = null;
let span = { from: 0, to: 0 };
export function stopGlide(): void {
  if (tween) cancelAnimationFrame(tween);
  tween = 0;
  if (unhook) { const u = unhook; unhook = null; u(); }
}
/* The page's scroll from `from` to `to` over `ms`, eased out. A finger, a click, a wheel or a key
   takes over. */
function tweenScroll(from: number, to: number, ms: number, done?: () => void): void {
  stopGlide();
  span = { from, to };
  let t0 = 0;
  const step = (now: number): void => {
    if (!t0) t0 = now;
    const t = Math.min(1, (now - t0) / ms);
    window.scrollTo(0, span.from + (span.to - span.from) * easeOut(t));
    if (t < 1) { tween = requestAnimationFrame(step); return; }
    tween = 0;
    if (unhook) { const u = unhook; unhook = null; u(); }
    done?.();
  };
  tween = requestAnimationFrame(step);
  const opts: AddEventListenerOptions = { passive: true, capture: true };
  const evs = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
  const stop = (): void => stopGlide();
  evs.forEach((ev) => window.addEventListener(ev, stop, opts));
  unhook = () => evs.forEach((ev) => window.removeEventListener(ev, stop, opts));
}

/* Content above changed height by `d` while a glide runs (render.ts anchored kept the view still):
   the glide's path moves with it, so it doesn't undo that. */
export function nudgeGlide(d: number): void {
  if (tween) { span.from += d; span.to += d; }
}

/* Glide the page so `el` sits `offset` px below the top. A long way skips most of it and glides
   the last screenful, so every jump takes about the same short time. */
export function glideTo(el: HTMLElement | null, offset = 0, done?: () => void): void {
  if (!el) { done?.(); return; }
  const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const to = Math.max(0, Math.min(max, window.scrollY + el.getBoundingClientRect().top - offset));
  let from = window.scrollY;
  if (still() || Math.abs(to - from) < 2) { stopGlide(); window.scrollTo(0, to); done?.(); return; }
  const vh = window.innerHeight;
  if (Math.abs(to - from) > vh * 1.5) { from = to - Math.sign(to - from) * vh; window.scrollTo(0, from); }
  const ms = Math.round(Math.min(340, 200 + Math.abs(to - from) * 0.15));
  tweenScroll(from, to, ms, () => {
    // Something above may have changed height meanwhile (the ballot head's lazy repaint): settle.
    if (el.isConnected) { const off = el.getBoundingClientRect().top - offset; if (Math.abs(off) > 2) window.scrollBy(0, off); }
    done?.();
  });
}

/* A pick made below a header that has scrolled off the top: as the panel folds away, the page
   follows it, so the rows under it stay still and the decided row comes down into view, where the
   panel ended (never lower than 40% of the screen, never above its top). */
export function followFold(row: HTMLElement | null, before: { top: number; bottom: number }, fold: Animation | null): void {
  const hd = row?.querySelector<HTMLElement>(':scope > .row-hd');
  if (!hd || before.top >= 0) return;
  const land = Math.max(8, Math.min(window.innerHeight * 0.4, before.bottom - hd.offsetHeight));
  const from = window.scrollY;
  const to = Math.max(0, from + before.top - land);
  if (!fold) { stopGlide(); window.scrollTo(0, to); return; }
  tweenScroll(from, to, SHUT_MS);
}

/* Mark where a jump landed: a short, quiet wash that fades (a row's header, a section's band). */
export function land(el: HTMLElement | null): void {
  if (!el || still()) return;
  el.classList.remove('land');
  requestAnimationFrame(() => {
    el.classList.add('land');
    window.setTimeout(() => el.classList.remove('land'), 1100);
  });
}

/* ---------- sheets ---------- */
/* A sheet (or Full details) that just came up over the page slides up as its scrim fades in. */
export function sheetIn(region: HTMLElement): void {
  const panel = region.querySelector<HTMLElement>('.sheet-panel, .reader');
  if (!canAnimate(panel)) return;
  panel.animate([{ transform: 'translateY(100%)' }, { transform: 'none' }], { duration: SHEET_MS, easing: OUT });
  region.querySelector<HTMLElement>('.scrim')?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: SHEET_MS, easing: 'linear' });
}
/* The sheet that is closing: its nodes move out of the region (which then repaints empty, as the
   state says) into a husk that slides down, the scrim fading, and is removed. */
export function sheetOut(region: HTMLElement): void {
  const panel = region.querySelector<HTMLElement>('.sheet-panel, .reader');
  if (!canAnimate(panel)) return;
  const scrolled = [...region.querySelectorAll<HTMLElement>('.sheet-bd, .reader')].map((x) => [x, x.scrollTop] as const);
  const g = document.createElement('div');
  g.className = 'sheet-ghost screen-only';
  while (region.firstChild) g.appendChild(region.firstChild);
  husk(g);
  panel.classList.replace('sheet-panel', 'sheet-gone');
  panel.classList.replace('reader', 'reader-gone');
  const scrim = g.querySelector<HTMLElement>('.scrim');
  scrim?.classList.replace('scrim', 'scrim-gone');
  region.before(g);
  scrolled.forEach(([x, t]) => { if (t) x.scrollTop = t; });
  const end = (): void => g.remove();
  const a = panel.animate([{ transform: 'none' }, { transform: 'translateY(100%)' }], { duration: SHEET_MS, easing: 'cubic-bezier(.32, 0, .67, 0)', fill: 'forwards' });
  scrim?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: SHEET_MS, easing: 'linear', fill: 'forwards' });
  a.onfinish = end;
  a.oncancel = end;
  window.setTimeout(end, SHEET_MS + 250);
}
