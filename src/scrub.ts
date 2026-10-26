/* What a crash report may carry, decided in one place the tests reach without a browser
   (tests/model-ledger.mjs). sentry.ts runs every event through scrubEvent just before it would leave.

   The site's How text (views/shelf.ts) promises: "If the page breaks, it sends us a crash report with no
   address, no picks and no IP." This is where that holds:
   - Dropped whole: anything that mentions the Census lookup (its script's address carries what the
     person typed, geo.ts censusLookup), anything that mentions the address typed or the one the Census
     matched (errors.ts keepPrivate), an error thrown by a script that isn't ours (an extension, an
     injected ad), and a browser's empty "Script error." (it says nothing we could use).
   - Replaced: every hash the page has had (a save link carries picks there) becomes "[save link]",
     wherever it shows up; so do a save link's own words ("v1~TX~...").
   - Cut: every URL loses its query and hash, to the end of the string (errors.ts bareURLs).
   - Removed or set: no user (no IP, no id) and no breadcrumbs; the request is the page's origin and
     path, plus the browser's user agent, which every request sends anyway.
   Sentry 11.8.0's own allowUrls option only works with its event filters integration, which this
   client doesn't load, so the "not our script" check lives here too. */
import { bareURLs, mentionsPrivate } from './errors';

export interface ScrubContext {
  origin: string;      // location.origin
  path: string;        // location.pathname
  hashes: string[];    // every hash the page has had, without "#" (errors.ts seenHashes)
  secrets: string[];   // the address typed and the one matched (errors.ts privateWords)
  ua?: string;         // navigator.userAgent
}
interface Frame { filename?: string; abs_path?: string }
interface Exc { value?: string; stacktrace?: { frames?: Frame[] } }
interface Ev { exception?: { values?: Exc[] }; message?: unknown; user?: unknown; breadcrumbs?: unknown; request?: unknown; sdkProcessingMetadata?: unknown }

const CENSUS = /census\.gov/i;
const SCRIPT_ERROR = /^Script error\.?$/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

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
   so a longer form is replaced before a shorter one inside it. */
function hashForms(h: string): string[] {
  const out = new Set([h, encodeURIComponent(h)]);
  try { out.add(decodeURIComponent(h)); } catch { /* not valid percent-encoding: the raw form is enough */ }
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
  // The SDK's own bookkeeping never leaves (the envelope drops it) and may hold scopes; leave it out.
  const { sdkProcessingMetadata: _skip, ...rest } = event as T & Ev;
  let raw: string;
  try { raw = JSON.stringify(rest); } catch { return null; }
  if (CENSUS.test(raw)) return null;
  if (mentionsPrivate(raw, ctx.secrets)) return null;
  const ev = rest as Ev;
  if (fromElsewhere(ev, ctx.origin)) return null;
  if ((ev.exception?.values || []).some((x) => SCRIPT_ERROR.test((x.value || '').trim())) || SCRIPT_ERROR.test(String(ev.message ?? '').trim())) return null;
  const forms = [...new Set(ctx.hashes.flatMap(hashForms))].sort((a, b) => b.length - a.length);
  const fix = (s: string): string => {
    let out = s;
    for (const f of forms) if (out.includes(f)) out = out.split(f).join('[save link]');
    return bareURLs(out);
  };
  const out = walk(JSON.parse(raw), fix) as T & Ev;
  delete out.user;
  delete out.breadcrumbs;
  out.request = { url: bareURLs(ctx.origin + ctx.path), ...(ctx.ua ? { headers: { 'User-Agent': ctx.ua } } : {}) };
  return out;
}
