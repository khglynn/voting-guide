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
     only that one was thrown, in fixed words (Codex, Oct 25).
   - Shaped: an error's message keeps only words of known shapes (plain words, names from the code, URLs
     already cut); a number (a house number, a ZIP), a JSON snippet or a selector a browser quoted back
     becomes "…". This layer doesn't depend on recognizing anything, so it holds where a new way of writing
     an address would slip past the checks above (three review rounds found three such ways).
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
  readings: (s: string) => string[];    // the text with JSON and URL escapes undone, round by round (errors.ts readings)
  ua?: string;                          // navigator.userAgent
}
type Obj = Record<string, unknown>;
interface Frame { filename?: string; abs_path?: string }
interface Exc { type?: string; value?: string; stacktrace?: { frames?: Frame[] }; mechanism?: { synthetic?: boolean } }
interface Ev { exception?: { values?: Exc[] }; message?: unknown }

const CENSUS = /census\.gov/i;
const TYPE = /^[A-Za-z_$][\w$.]{0,60}$/;                    // an error's type is a name from code
const FN = /^[\w$.<>[\] /-]{0,120}$/;                     // a frame's function: "HTMLDocument.<anonymous>", "Object.f [as g]"
const SAVE_LINK = /v[12]~/i;                               // a save link's own words, however they were encoded
/* The SDK's words for a thrown value that isn't an Error, as fixed text: only its known openings are
   recognized, so nothing the page wrote can ride along in front of "[not sent]" (Codex, Oct 25). */
function nonError(v: string): string {
  const obj = v.match(/^Object captured as (exception|promise rejection) with keys:/);
  if (obj) return `Object captured as ${obj[1]} with keys: [not sent]`;
  if (v.startsWith('Non-Error promise rejection captured with value:')) return 'Non-Error promise rejection captured with value: [not sent]';
  const ev = v.match(/^Event `\w+`.* captured as (exception|promise rejection)/);
  if (ev) return `An event object captured as ${ev[1]}: [not sent]`;
  return 'A thrown value that isn’t an Error: [not sent]';
}
/* A message shaped so it can't carry what a person typed or chose, by keeping only words of known shapes:
   a plain word ("Cannot", "isn’t", "Non-Error"), a name from the code, bare, dotted or in quotes ("x.map",
   "'dataset'"), and a URL already cut to its path. Anything else, a number (a house number, a ZIP), a JSON
   snippet or a selector a browser quoted back, becomes "…". So "Unexpected token 'x', "{"picks":...}" is
   not valid JSON" goes as "Unexpected token 'x', … is not valid JSON". Long ones are cut. */
const WORD = /^\p{L}+(?:['’-]\p{L}+)*$/u;
const NAME = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/;
const URLISH = /^[a-z][a-z0-9+.-]*:\/\/[\w.:-]+(?:\/[\w.\-/]*)?$/i;
const EDGE_IN = /^[(\[{]+/;
const EDGE_OUT = /[)\]},.:;!?]+$/;
function plainToken(t: string): boolean {
  const core = t.replace(EDGE_IN, '').replace(EDGE_OUT, '');
  if (!core) return true;
  const q = core.match(/^(['"`‘“])(.*)(['"`’”])$/);
  const inner = q ? q[2] : core;
  return q ? NAME.test(inner) : WORD.test(inner) || NAME.test(inner) || URLISH.test(inner);
}
const shape = (msg: string): string => msg.split(/\s+/).filter(Boolean)
  .map((t) => (plainToken(t) ? t : '…'))
  .join(' ').replace(/…(?: …)+/g, '…').slice(0, 300);
const SCRIPT_ERROR = /^Script error\.?$/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/* The fields that may leave, by level. Anything else on the event is left behind. */
const KEEP_EVENT = ['event_id', 'timestamp', 'platform', 'level', 'environment', 'release', 'dist', 'type', 'exception', 'sdk', 'contexts', 'debug_meta'];
const KEEP_EXC = ['type', 'value', 'stacktrace', 'mechanism'];
const KEEP_FRAME = ['filename', 'abs_path', 'function', 'lineno', 'colno', 'in_app'];
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
        if (st) {
          e.stacktrace = { frames: ((st.frames as unknown[]) || []).map((f) => {
            const fr = pick(f, KEEP_FRAME);
            if (typeof fr.function === 'string' && !FN.test(fr.function)) fr.function = '?';
            return fr;
          }) };
        }
        if (e.mechanism) e.mechanism = pick(e.mechanism, KEEP_MECHANISM);
        if (typeof e.type !== 'string' || !TYPE.test(e.type)) e.type = 'Error';
        // A thrown value that isn't an Error (an object, a string): only the SDK's own words for it, as fixed
        // text, never what it held: "Object captured as promise rejection with keys: [not sent]".
        if ((e.mechanism as Exc['mechanism'])?.synthetic || e.type === 'UnhandledRejection') e.value = nonError(typeof e.value === 'string' ? e.value : '');
        return e;
      }),
    };
  }
  if (out.sdk) out.sdk = pick(out.sdk, KEEP_SDK);
  if (out.contexts) out.contexts = pick(out.contexts, ['trace']);
  return out;
}

/* Every string in it, in order, as text, decoded (so JSON's escapes are already undone); with its keys too
   unless `values` is set. */
function texts(v: unknown, out: string[] = [], values = false): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) texts(x, out, values);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (!values) out.push(k); texts(x, out, values); }
  return out;
}
/* Must this never leave: does any of its values, read every way, name the Census lookup, or hold the
   address? Each value is judged on its own, so a bad escape in one can't hide the address in another; and
   the values together, in order, so an address split between two neighbouring fields still counts
   (security review, Oct 25). Keys aren't judged: those that leave are fixed field names (KEEP below), and
   a field name like "trace" must not match a half-typed word from the box. */
const forbidden = (vals: string[], ctx: ScrubContext): boolean =>
  vals.some((s) => ctx.readings(s).some((r) => CENSUS.test(r)) || ctx.mentions(s)) || ctx.mentions(vals.join('\n'));
/* Does it still hold a save link: a saved hash, or a save link's own words, in any reading? */
const linked = (s: string, forms: string[], ctx: ScrubContext): boolean => ctx.readings(s).some((r) => SAVE_LINK.test(r) || forms.some((f) => r.includes(f)));

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
  if (forbidden(texts(ev, [], true), ctx)) return null;
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
  // A save link written some way the replacement above didn't know (its "~" encoded, say): the report
  // doesn't go at all. Judged before the messages are shaped, which could hide the encoding from the check.
  if (texts(out).some((s) => linked(s, forms, ctx))) return null;
  for (const x of ((out.exception as Obj).values as Obj[])) if (typeof x.value === 'string') x.value = shape(x.value);
  out.request = { url: ctx.bare(ctx.origin + ctx.path), ...(ctx.ua ? { headers: { 'User-Agent': ctx.ua } } : {}) };
  return out as T;
}

/* The last check, on the bytes about to leave (an envelope: lines of JSON). False when any line names the
   Census lookup, holds the address, or still holds a save link's hash. */
export function envelopeAllowed(body: string, ctx: ScrubContext): boolean {
  const all: string[] = [];
  const vals: string[] = [];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); texts(o, all); texts(o, vals, true); } catch { all.push(line); vals.push(line); }
  }
  if (forbidden(vals, ctx)) return false;
  const forms = hashForms(ctx.hashes);
  return !all.some((s) => linked(s, forms, ctx));
}
