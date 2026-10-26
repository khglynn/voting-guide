/* Errors: what the page caught, kept for a problem report, and sent on as a crash report.

   The last few errors the page caught, so a "Report a problem" can say what went wrong under the
   hood (Kevin, Oct 21: collect what we can and show it, so a note can stay one sentence). Kept in
   memory only, read only by the shelf's "We'll send along" list (views/shelf.ts), and gone on a
   reload. Nothing leaves the page that way unless the person sends a report, and they see every line
   first. Three ways in: the window's error and unhandledrejection events, and main.ts's tap handler,
   which catches a control's own crash before the window would see it (reportError).
   Each entry is the message, the file and line, and the time. Any URL in them loses its query and
   hash (the save link's hash carries picks), the file is cut to its name, and a long message is cut
   short. An error that mentions the Census lookup is dropped whole: that lookup is a script whose
   address carries what the person typed (geo.ts censusLookup). So is one that mentions the address
   itself (keepPrivate, below).

   Crash reports (Kevin, Oct 21: "I don't want to weigh down our site with a bunch of bullshit, but I
   would love error logging"): the same errors also go to Sentry, through sentry.ts, a chunk of its own
   that this file fetches once the page has loaded and gone idle, so first paint pays nothing for it.
   Only in a production build with VITE_SENTRY_DSN set (Vercel's production and preview builds; CI and
   ship.sh build with a test one whose reports their checks catch). Until it loads, the first few errors
   wait here. Every report passes scrub.ts first: no address, no picks, no IP, nothing the person did. */
export interface Caught { msg: string; at: string; time: string }
const KEEP = 3;
const MAX = 160;
const caught: Caught[] = [];
const CENSUS = /geocoding\.geo\.census\.gov/i;

/* A string with every URL's query and hash gone, whole. Where a URL ends can't be told from its
   characters (an address in a query can hold an apostrophe, a paren or even a space: "12 O'Test Lane"
   kept its tail when the cut stopped at the apostrophe; Codex, Oct 21), so from the first URL on,
   everything after the first "?" or "#" goes, to the end of the string. A save link's own words
   ("v1~TX~...") go wherever they stand. Run before anything is cut short, so no part of a URL is
   ever left behind a cut. */
const URL_START = /\b[a-z][a-z0-9+.-]*:\/\//i;
export function bareURLs(s: string): string {
  let out = s;
  const at = out.search(URL_START);
  if (at >= 0) {
    const q = out.slice(at).search(/[?#]/);
    if (q >= 0) out = out.slice(0, at + q);
  }
  return out.replace(/\bv[12]~\S*/gi, '[save link]');
}
/* A script's URL as its file name ("index-Bx9.js"), from the path alone: never its query or hash. */
function fileOf(u: string): string {
  let path = '';
  try { path = new URL(u).pathname; } catch { path = u.split(/[?#]/)[0]; }
  return bareURLs(path.split('/').filter(Boolean).pop() || '');
}
const clock = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
/* Where an Error was thrown, from its stack's first line that names a file. */
function whereFrom(e: Error): [string, number, number] {
  const m = (e.stack || '').match(/((?:https?|blob|file):\/\/[^\s)]+?):(\d+):(\d+)/i);
  return m ? [m[1], Number(m[2]), Number(m[3])] : ['', 0, 0];
}
const words = (x: unknown): string => {
  if (x instanceof Error) return `${x.name}: ${x.message}`;
  if (typeof x === 'string') return x;
  try { return JSON.stringify(x) ?? String(x); } catch { return String(x); }
};

export function note(err: unknown, file = '', line = 0, col = 0, when = new Date()): void {
  try {
    if (err instanceof Error && !file) [file, line, col] = whereFrom(err);
    const stack = err instanceof Error ? err.stack || '' : '';
    const raw = words(err);
    if (CENSUS.test(raw) || CENSUS.test(file) || CENSUS.test(stack) || mentionsPrivate(`${raw}\n${file}\n${stack}`)) return;
    const msg = bareURLs(raw.replace(/\s+/g, ' ').trim()).slice(0, MAX) || 'Unknown error';
    const at = file ? `${fileOf(file)}${line ? `:${line}${col ? `:${col}` : ''}` : ''}` : '';
    caught.push({ msg, at, time: clock(when) });
    if (caught.length > KEEP) caught.shift();
  } catch { /* keeping a note must never throw */ }
}
/* Newest first. A copy, so the list can't be changed from outside. */
export const lastErrors = (): Caught[] => caught.slice().reverse();

/* ---------- what never leaves: the address and the save link ---------- */
/* What the person typed in the address box and what the Census matched, for this page load only
   (app.ts runAddress). Never shown or sent, only compared: a note here, or a crash report (scrub.ts),
   that mentions any of it is dropped whole. A full address's street line counts on its own too, when
   it has a number in it, since that is the part that says where someone lives. Lowercased, with runs
   of spaces as one. */
const secrets = new Set<string>();
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
export function keepPrivate(...xs: (string | null | undefined)[]): void {
  for (const x of xs) {
    const s = squash(x || '');
    if (s.length < 5) continue;
    secrets.add(s);
    const street = s.split(',')[0].trim();
    if (street !== s && street.length >= 5 && /\d/.test(street)) secrets.add(street);
  }
}
/* Every private string, with whatever is in the address box right now (typed, maybe never looked up). */
export function privateWords(): string[] {
  const box = typeof document === 'undefined' ? null : document.getElementById('addr-in') as HTMLInputElement | null;
  const live = squash(box ? box.value : '');
  return live.length >= 5 ? [...new Set([...secrets, live])] : [...secrets];
}
/* Does this text hold a private string: as typed, URL-encoded (a space as %20 or +), or escaped the
   way JSON writes it? Case and spacing don't matter. */
export function mentionsPrivate(text: string, words: string[] = privateWords()): boolean {
  if (!words.length) return false;
  const t = squash(text);
  return words.some((w) => {
    const enc = encodeURIComponent(w);
    return [w, enc, enc.replace(/%20/g, '+'), JSON.stringify(w).slice(1, -1)].some((f) => t.includes(f.toLowerCase()));
  });
}
/* Every hash this page has had. A save link carries picks in it, and the app clears it from the
   address bar once the link has opened (app.ts openBallot), so each one is kept from the first moment
   (this file loads before anything else) and on every hashchange: a crash report replaces it
   wherever it shows up (scrub.ts). */
const hashes = new Set<string>();
function seeHash(): void {
  const h = typeof location === 'undefined' ? '' : location.hash.replace(/^#/, '');
  if (h.length >= 6) hashes.add(h);
}
export function seenHashes(): string[] { seeHash(); return [...hashes]; }

/* ---------- crash reports ---------- */
const EARLY = 5;
const early: unknown[] = [];
let send: ((e: unknown) => void) | null = null; // sentry.ts, once it has started
let lastId: () => string | undefined = () => undefined;
const hold = (e: unknown): void => { if (early.length < EARLY) early.push(e); };

/* A crash the page caught itself (main.ts fire(): a control's own error): kept for a problem report,
   and sent as a crash report, now or once the client has loaded. */
export function reportError(e: unknown): void {
  note(e);
  if (send) send(e); else hold(e);
}
/* The id of the last crash report Sentry took in, for the problem report's list (views/shelf.ts). */
export const lastErrorId = (): string | undefined => lastId();

function startCrashReports(): void {
  import('./sentry')
    .then((m) => {
      // Sentry's own window handlers go on inside start(), in the same task that turns ours off for
      // it, so no error falls between them.
      send = m.start(early.splice(0));
      lastId = m.lastSentId;
    })
    .catch(() => { /* an ad blocker or a dropped connection ate the chunk: the guide works the same, we just hear nothing */ });
}

/* Listening starts as soon as main.ts imports this. Listeners only: whatever the browser does with an
   error (the console, a test's pageerror) still happens. Until the client has started, an error also
   waits for it; after that, Sentry's own handlers take the window's errors. */
if (typeof window !== 'undefined') {
  seeHash();
  window.addEventListener('hashchange', seeHash);
  window.addEventListener('error', (e) => {
    // A resource that failed to load (an image) is no script error.
    if (!(e instanceof ErrorEvent)) return;
    note(e.error instanceof Error ? e.error : e.message, e.filename, e.lineno, e.colno);
    if (!send) hold(e.error ?? e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    note(e.reason instanceof Error ? e.reason : `Unhandled: ${words(e.reason)}`);
    if (!send) hold(e.reason);
  });
  if (import.meta.env.PROD && import.meta.env.VITE_SENTRY_DSN) {
    const later = (): void => {
      if ('requestIdleCallback' in window) requestIdleCallback(startCrashReports, { timeout: 4000 });
      else setTimeout(startCrashReports, 2000);
    };
    if (document.readyState === 'complete') later();
    else window.addEventListener('load', later, { once: true });
  }
}
