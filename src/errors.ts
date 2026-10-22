/* The last few errors the page caught, so a "Report a problem" can say what went wrong under the
   hood (Kevin, Oct 21: collect what we can and show it, so a note can stay one sentence). Kept in
   memory only, read only by the shelf's "We'll send along" list (views/shelf.ts), and gone on a
   reload. Nothing leaves the page unless the person sends a report, and they see every line first.
   Three ways in: the window's error and unhandledrejection events, and main.ts's tap handler, which
   catches a control's own crash before the window would see it. A later pull request can point
   `note` at an error service; the callers stay the same.
   Each entry is the message, the file and line, and the time. Any URL in them loses its query and
   hash (the save link's hash carries picks), the file is cut to its name, and a long message is cut
   short. An error that mentions the Census lookup is dropped whole: that lookup is a script whose
   address carries what the person typed (geo.ts censusLookup). */
export interface Caught { msg: string; at: string; time: string }
const KEEP = 3;
const MAX = 160;
const caught: Caught[] = [];
const CENSUS = /geocoding\.geo\.census\.gov/i;

/* Every URL in a string, without its query or hash. */
export const bareURLs = (s: string): string => s.replace(/\b(?:https?|blob|file):\/\/[^\s"'<>)]+/g, (u) => u.replace(/[?#].*$/, ''));
/* A script's URL as its file name ("index-Bx9.js"). */
const fileOf = (u: string): string => bareURLs(u).split('/').pop() || '';
const clock = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
/* Where an Error was thrown, from its stack's first line that names a file. */
function whereFrom(e: Error): [string, number, number] {
  const m = (e.stack || '').match(/((?:https?|blob|file):\/\/[^\s)]+?):(\d+):(\d+)/);
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
    if (CENSUS.test(raw) || CENSUS.test(file) || CENSUS.test(stack)) return;
    const msg = bareURLs(raw.replace(/\s+/g, ' ').trim()).slice(0, MAX) || 'Unknown error';
    const at = file ? `${fileOf(file)}${line ? `:${line}${col ? `:${col}` : ''}` : ''}` : '';
    caught.push({ msg, at, time: clock(when) });
    if (caught.length > KEEP) caught.shift();
  } catch { /* keeping a note must never throw */ }
}
/* Newest first. A copy, so the list can't be changed from outside. */
export const lastErrors = (): Caught[] => caught.slice().reverse();

/* Listening starts as soon as main.ts imports this. Listeners only: whatever the browser does with an
   error (the console, a test's pageerror) still happens. */
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => {
    // A resource that failed to load (an image) is no script error.
    if (!(e instanceof ErrorEvent)) return;
    note(e.error instanceof Error ? e.error : e.message, e.filename, e.lineno, e.colno);
  });
  window.addEventListener('unhandledrejection', (e) => note(e.reason instanceof Error ? e.reason : `Unhandled: ${words(e.reason)}`));
}
