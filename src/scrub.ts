/* What a crash report may carry, decided in one place the tests reach without a browser
   (tests/model-ledger.mjs). sentry.ts runs every event through scrubEvent in beforeSend, and every
   envelope's bytes through envelopeAllowed just before they would leave (that second check also covers
   anything the SDK sends without passing beforeSend, such as its own internal errors).

   The site's How text (views/shelf.ts) promises: "If the page breaks, it sends us a crash report with no
   address, no picks and no IP." This is where that holds:
   - Dropped whole: anything that mentions the Census lookup (its script's address carries what the
     person typed, geo.ts censusLookup), anything that mentions the address typed or the one the Census
     matched, however it is written (errors.ts keepPrivate, mentionsPrivate), an error thrown by a script
     that isn't ours (an extension, an injected ad), and a browser's empty "Script error.".
   - Only known fields go (KEEP below): the error's type, message and stack, which SDK sent it, the
     release, the environment, the trace ids and the source map ids. Nothing the SDK adds about a thrown
     value that isn't an Error goes: its contents (an object could hold a ballot's picks) are never sent,
     only that one was thrown (Codex, Oct 25).
   - Replaced: every hash the page has had (a save link carries picks there) becomes "[save link]",
     wherever it shows up; so do a save link's own words ("v1~TX~...").
   - Cut: every URL loses its query and hash, to the end of the string (errors.ts bareURLs).
   - Set: the request is the page's origin and path, plus the browser's user agent, which every request
     sends anyway. No user (no IP, no id), no breadcrumbs.
   Sentry 11.8.0's own allowUrls option only works with its event filters integration, which this
   client doesn't load, so the "not our script" check lives here too.

   This file imports nothing: the string helpers come in through the context from errors.ts, so the
   crash-report chunk never depends on the page's own bundle (see errors.ts startCrashReports). */

export interface ScrubContext {
  origin: string;                       // location.origin
  path: string;                         // location.pathname
  hashes: string[];                     // every hash the page has had, without "#" (errors.ts seenHashes)
  mentions: (text: string) => boolean;  // does it hold the address, typed or matched (errors.ts mentionsPrivate)
  bare: (s: string) => string;          // every URL without its query and hash (errors.ts bareURLs)
  ua?: string;                          // navigator.userAgent
}
type Obj = Record<string, unknown>;
interface Frame { filename?: string; abs_path?: string }
interface Exc { type?: string; value?: string; stacktrace?: { frames?: Frame[] }; mechanism?: { synthetic?: boolean } }
interface Ev { exception?: { values?: Exc[] }; message?: unknown }

const CENSUS = /census\.gov/i;
const SCRIPT_ERROR = /^Script error\.?$/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/* The fields that may leave, by level. Anything else on the event is left behind. */
const KEEP_EVENT = ['event_id', 'timestamp', 'platform', 'level', 'environment', 'release', 'dist', 'type', 'exception', 'sdk', 'contexts', 'debug_meta'];
const KEEP_EXC = ['type', 'value', 'module', 'stacktrace', 'mechanism'];
const KEEP_FRAME = ['filename', 'abs_path', 'function', 'module', 'lineno', 'colno', 'in_app'];
const KEEP_MECHANISM = ['type', 'handled', 'synthetic', 'source', 'exception_id', 'parent_id', 'is_exception_group'];
const KEEP_SDK = ['name', 'version', 'integrations', 'packages', 'settings'];
const pick = (o: unknown, keys: string[]): Obj => {
  const src = o && typeof o === 'object' ? o as Obj : {};
  return Object.fromEntries(keys.filter((k) => src[k] !== undefined).map((k) => [k, src[k]]));
};
function allowed(ev: Obj): Obj {
  const out = pick(ev, KEEP_EVENT);
  const values = ((ev.exception as Obj | undefined)?.values as unknown[] | undefined) || [];
  if (out.exception) {
    out.exception = {
      values: values.map((x) => {
        const e = pick(x, KEEP_EXC);
        const st = e.stacktrace as Obj | undefined;
        if (st) e.stacktrace = { frames: ((st.frames as unknown[]) || []).map((f) => pick(f, KEEP_FRAME)) };
        if (e.mechanism) e.mechanism = pick(e.mechanism, KEEP_MECHANISM);
        // A thrown value that isn't an Error (an object, a string): the SDK's own words for it stay, never
        // what it held. "Object captured as promise rejection with keys: picks, notes" -> "...keys: [not sent]".
        if ((e.mechanism as Exc['mechanism'])?.synthetic || e.type === 'UnhandledRejection') {
          const v = typeof e.value === 'string' ? e.value : '';
          const lead = v.match(/^.*? with (?:keys|value):/);
          e.value = lead ? `${lead[0]} [not sent]` : 'A thrown value that isn’t an Error: [not sent]';
        }
        return e;
      }),
    };
  }
  if (out.sdk) out.sdk = pick(out.sdk, KEEP_SDK);
  if (out.contexts) out.contexts = pick(out.contexts, ['trace']);
  return out;
}

/* Every key and string in it, as text, decoded (so JSON's escapes are already undone). */
function texts(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) texts(x, out);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); texts(x, out); }
  return out;
}
/* Must this never leave: does it name the Census lookup, or hold the address? */
const forbidden = (all: string[], ctx: ScrubContext): boolean => {
  const joined = all.join('\n');
  return CENSUS.test(joined) || ctx.mentions(joined);
};

/* Thrown by someone else's script: in any of the event's exceptions, the newest frame that names a
   script names one that isn't on our origin. Frames that name no script (eval, native code) don't
   count either way. */
export function fromElsewhere(ev: Ev, origin: string): boolean {
  for (const x of ev.exception?.values || []) {
    const frames = x.stacktrace?.frames || [];
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i].filename || frames[i].abs_path || '';
      if (!SCHEME.test(f)) continue;
      if (f !== origin && !f.startsWith(`${origin}/`)) return true;
      break;
    }
  }
  return false;
}

/* A hash as it may show up: as the address bar has it, decoded, and encoded once more. Longest first,
   so a longer form is replaced before a shorter one inside it. Short ones can't be save links. */
function hashForms(hashes: string[]): string[] {
  const out = new Set<string>();
  for (const h of hashes) {
    out.add(h); out.add(encodeURIComponent(h));
    try { out.add(decodeURIComponent(h)); } catch { /* not valid percent-encoding: the raw form is enough */ }
  }
  return [...out].filter((f) => f.length >= 6).sort((a, b) => b.length - a.length);
}

/* Every string in it (keys too), fixed. */
function walk(v: unknown, fix: (s: string) => string): unknown {
  if (typeof v === 'string') return fix(v);
  if (Array.isArray(v)) return v.map((x) => walk(x, fix));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [fix(k), walk(x, fix)]));
  return v;
}

/* The event as it may leave, or null when it may not leave at all. Never changes the event it's given. */
export function scrubEvent<T extends object>(event: T, ctx: ScrubContext): T | null {
  let ev: Obj;
  try {
    // The SDK's own bookkeeping never leaves (the envelope drops it) and may hold scopes; leave it out.
    const { sdkProcessingMetadata: _skip, ...rest } = event as Obj;
    ev = JSON.parse(JSON.stringify(rest)) as Obj;
  } catch { return null; }
  // Judged on everything the event holds, even the parts that wouldn't leave: an event that touched the
  // address or the Census lookup anywhere is not one to send.
  if (forbidden(texts(ev), ctx)) return null;
  if (fromElsewhere(ev as Ev, ctx.origin)) return null;
  const e = ev as Ev;
  if ((e.exception?.values || []).some((x) => SCRIPT_ERROR.test((x.value || '').trim())) || SCRIPT_ERROR.test(String(e.message ?? '').trim())) return null;
  if (!e.exception?.values?.length) return null; // only errors are sent, never a bare message
  const forms = hashForms(ctx.hashes);
  const fix = (s: string): string => {
    let out = s;
    for (const f of forms) if (out.includes(f)) out = out.split(f).join('[save link]');
    return ctx.bare(out);
  };
  const out = walk(allowed(ev), fix) as Obj;
  out.request = { url: ctx.bare(ctx.origin + ctx.path), ...(ctx.ua ? { headers: { 'User-Agent': ctx.ua } } : {}) };
  return out as T;
}

/* The last check, on the bytes about to leave (an envelope: lines of JSON). False when any line names the
   Census lookup, holds the address, or still holds a save link's hash. */
export function envelopeAllowed(body: string, ctx: ScrubContext): boolean {
  const all: string[] = [];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try { texts(JSON.parse(line), all); } catch { all.push(line); }
  }
  if (forbidden(all, ctx)) return false;
  const forms = hashForms(ctx.hashes);
  return !all.some((s) => forms.some((f) => s.includes(f)) || /\bv[12]~/i.test(s));
}
