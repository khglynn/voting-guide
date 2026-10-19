/* Small helpers with no app state. */

export const esc = (s: unknown): string =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

export const host = (u: string | null | undefined): string => {
  if (!u) return '';
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; }
};

export const plural = (n: number, w: string, ws = `${w}s`): string => `${n} ${n === 1 ? w : ws}`;

/* Dates. Every date shown comes from the data as YYYY-MM-DD. We only format it. */
const parse = (iso: string): Date => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
export function fmtDate(iso: string | null | undefined, opts: { weekday?: boolean } = {}): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  return parse(iso).toLocaleDateString('en-US', { weekday: opts.weekday === false ? undefined : 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
/* Today's date on this device, as YYYY-MM-DD. A ?today=2026-10-30 query overrides it for testing. */
export function todayISO(): string {
  try {
    const q = new URLSearchParams(location.search).get('today');
    if (q && /^\d{4}-\d{2}-\d{2}$/.test(q)) return q;
  } catch { /* ignore */ }
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/* `?now=HH:MM` (local time where the polls are) for testing; null when absent. */
export function nowOverride(): number | null {
  try {
    const q = new URLSearchParams(location.search).get('now');
    const m = q && q.match(/^(\d{1,2}):(\d{2})$/);
    if (m) return +m[1] * 60 + +m[2];
  } catch { /* ignore */ }
  return null;
}
/* The date and the minutes after midnight at this instant in a time zone (the device's own when
   the zone is unknown). Comparing both, never the minutes alone, keeps "after midnight" from
   reading as "before 7 PM". */
export function zonedNow(zone: string | null, at: Date): { date: string; min: number } {
  const local = () => ({ date: `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`, min: at.getHours() * 60 + at.getMinutes() });
  if (!zone) return local();
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
    const v = (t: string) => parts.find((p) => p.type === t)?.value || '0';
    return { date: `${v('year')}-${v('month')}-${v('day')}`, min: (+v('hour') % 24) * 60 + +v('minute') };
  } catch { return local(); }
}
export const daysBetween = (a: string, b: string): number => Math.round((parse(b).getTime() - parse(a).getTime()) / 864e5);

/* Short stable hashes for the save link. FNV-1a 32-bit, base36. */
export function hash(s: string, len = 5): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36).padStart(7, '0').slice(-len);
}

export function b64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlDecode(s: string): string {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(pad);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/* localStorage, always wrapped: private windows and blocked storage must not break the page. */
export function load<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch { return fallback; }
}
export function save(key: string, value: unknown): boolean {
  try { window.localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

let toastTimer: number | undefined;
/* A status message at the bottom; with an action (Undo), it stays long enough to use it. */
export function toast(msg: string, action?: { label: string; act: string }): void {
  let t = document.querySelector<HTMLDivElement>('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast screen-only';
    t.setAttribute('role', 'status');
    document.body.appendChild(t);
  }
  t.innerHTML = `<span class="toast-t">${esc(msg)}</span>${action ? `<button data-act="${esc(action.act)}" data-fk="toast-act">${esc(action.label)}</button>` : ''}`;
  t.hidden = false;
  t.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { if (t) { t.classList.remove('show'); t.hidden = true; } }, action ? 8000 : 2800);
}
export function hideToast(): void {
  const t = document.querySelector<HTMLDivElement>('.toast');
  if (t) { t.classList.remove('show'); t.hidden = true; }
  window.clearTimeout(toastTimer);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/* A quiet screen-reader announcement (a persistent, visually hidden live region), for
   changes that don't move focus, like a ranking renumbering. */
export function announce(msg: string): void {
  let el = document.getElementById('sr-live');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sr-live';
    el.className = 'vh screen-only';
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
    document.body.appendChild(el);
  }
  el.textContent = '';
  const target = el;
  window.setTimeout(() => { target.textContent = msg; }, 30);
}
