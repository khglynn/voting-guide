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
/* What is in the address box right now: typed, maybe never looked up. */
const inBox = (): string => {
  const box = typeof document === 'undefined' ? null : document.getElementById('addr-in') as HTMLInputElement | null;
  return box ? box.value : '';
};
/* Something typed in the box that could be an address: six characters or more with a number in it. A
   half-typed word ("Trace") is not kept: every report has a "trace" field, and keeping it would silence
   every report after it (Codex, Oct 25). */
const addressish = (s: string): boolean => s.length >= 6 && /\d/.test(s);
/* Whatever is in the box when an error is caught is kept too, so an error that waits for the client
   (or a report written later) is still checked against it after the box has been cleared or has gone
   (Codex, Oct 25). */
const keepBox = (): void => { const v = squash(inBox()); if (addressish(v)) keepPrivate(v); };
/* Every private string, with whatever is in the address box right now when it could be an address. */
export function privateWords(): string[] {
  const live = squash(inBox());
  return addressish(live) ? [...new Set([...secrets, live])] : [...secrets];
}
/* The text with JSON's escapes undone (\t, \n, \", \u00e9). */
const unJSON = (s: string): string => s.replace(/\\u([0-9a-f]{4})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\[nrtbf]/g, ' ').replace(/\\(["\\/])/g, '$1');
/* The text with URL encoding undone: "+" as a space, and every run of %XX escapes read as UTF-8 bytes
   (a bad byte becomes a replacement character rather than an error). Never throws. */
function unURL(s: string): string {
  return s.replace(/\+/g, ' ').replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
    return new TextDecoder().decode(bytes);
  });
}
/* Holds %XX escapes the browser itself wouldn't decode (bad UTF-8, a Latin-1 "%F1", a stray "%" beside
   real escapes): we can't be sure what it says. */
function undecodable(s: string): boolean {
  if (!/%[0-9a-f]{2}/i.test(s)) return false;
  try { decodeURIComponent(s.replace(/\+/g, ' ')); return false; } catch { return true; }
}
/* A private string as a URL may carry it: all escaped, or only its non-ASCII letters escaped. A string
   that can't be encoded (a lone surrogate) is compared as it is (Codex, Oct 25: it used to throw and
   silence every report after it). */
function encodings(w: string): string[] {
  const out = [w];
  try { out.push(squash(encodeURIComponent(w))); } catch { /* compared as it is */ }
  try { out.push(squash(w.replace(/[^\x00-\x7f]/g, (c) => encodeURIComponent(c)))); } catch { /* compared as it is */ }
  return out;
}
/* Every way to read a text: as it is, then with JSON's escapes and URL encoding undone in turn, round
   after round (at most four), so an escape inside an encoding ("%5Ct", "%5Cu0020") unwinds too (Codex,
   Oct 25). The address check and the save-link check both read text this way (scrub.ts). */
export function readings(text: string): string[] {
  const out = [text];
  let cur = text;
  for (let i = 0; i < 4; i++) {
    const next = unURL(unJSON(cur));
    if (next === cur) break;
    out.push(next);
    cur = next;
  }
  return out;
}
/* Does this text hold a private string, however it is written: in any case, with any run of spaces,
   tabs or line breaks between the words, JSON-escaped, URL-encoded (all of it or only its accented
   letters), or escapes inside encodings? Decoding goes run by run and never gives up, so one bad escape
   can't hide the address elsewhere in the text. When there is something private to protect and any
   line of any reading holds escapes the browser itself wouldn't decode, the answer is yes: when in
   doubt, send nothing (security review, Oct 25: an accented street, encoded, beside a stray "%", got
   past an earlier version). Lines are judged one at a time for that, so an ordinary "100%" on one line
   doesn't condemn good escapes on another; the match itself runs across lines, so an address broken
   over two still counts. */
export function mentionsPrivate(text: string, words: string[] = privateWords()): boolean {
  if (!words.length || !text) return false;
  const rs = readings(text);
  if (rs.some((r) => r.split(/[\r\n]+/).some(undecodable))) return true;
  const hay = rs.map(squash);
  return words.some((w) => encodings(w).some((x) => !!x && hay.some((h) => h.includes(x))));
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
  keepBox();
  note(e);
  if (send) send(e); else hold(e);
}
/* The id of the last crash report Sentry took in, for the problem report's list (views/shelf.ts). */
export const lastErrorId = (): string | undefined => lastId();

/* The chunk imports nothing from the page's own bundle: everything it needs from here is handed to it.
   So a crash while the page's bundle itself starts up (which leaves that bundle unusable to any other
   module) still gets reported (Codex, Oct 25). */
function startCrashReports(): void {
  import('./sentry')
    .then((m) => {
      // Sentry's own window handlers go on inside start(), in the same task that turns ours off for
      // it, so no error falls between them.
      send = m.start(early.splice(0), { words: privateWords, hashes: seenHashes, mentions: mentionsPrivate, bare: bareURLs, readings });
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
    keepBox();
    note(e.error instanceof Error ? e.error : e.message, e.filename, e.lineno, e.colno);
    if (!send) hold(e.error ?? e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    keepBox();
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
