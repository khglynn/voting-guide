/* Reads made on the Air for sources that refuse the Worker (Nov 13, 2026; Kevin: "Build it", ledger
   2026-11-13-voting-guide-air). California's, Oregon's, Denver's and Pennsylvania's offices answer the Worker with a 403
   or a bot check but answer the same named request from Kevin's Mac. So the Air does only the fetching: it runs the
   source's own adapter through `recordingFetch`, and when the read is good it posts what each office sent (status, a
   few headers, the body) to POST /results/feed. The Worker runs the same adapter again through `replayFetch` over
   those answers, so the checks, the falling-total guard, the archive and the published file are exactly a Worker read's.
   Nothing on the Air touches the store, so there is still one writer.
   Both sides run the adapter with no change token (a full read), so the second run asks for the same addresses in the
   same order. Portable: no Buffer, so it runs under node and in the Worker alike. */

/* The sources the Air reads (bin/feed.mjs), and the only ones POST /results/feed takes, so a mistaken list on the Air
   can never take a source the Worker reads fine off its schedule. */
export const AIR_SOURCES = ['results-CA', 'los-angeles-county-ca', 'orange-county-ca', 'san-diego-county-ca', 'results-OR', 'results-OR-multnomah', 'denver-co', 'results-PA'];

/* What `get` (fetch.js) reads from a response's headers, and nothing else. */
const KEEP = ['last-modified', 'etag', 'location', 'content-type', 'x-amzn-waf-action', 'cf-mitigated', 'server', 'x-cache'];
const NO_BODY = new Set([101, 204, 205, 304]);
/* The whole post, at most: California's statewide read is the largest, about 2 MB as text. */
export const MAX_POST = 40_000_000;

function toB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b) {
  const s = atob(b);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}
const utf8 = new TextDecoder('utf-8', { fatal: true });
const key = (method, url) => `${(method || 'GET').toUpperCase()} ${url}`;

/* A fetch that passes every request through and keeps a copy of each answer in `fn.answers`. The body travels as text
   when it is plain UTF-8, and as base64 otherwise (a gzip with no Content-Encoding header, Fulton GA's kind). */
export function recordingFetch(fetchFn) {
  const answers = [];
  const fn = async (url, opts = {}) => {
    const res = await fetchFn(url, opts);
    const bytes = NO_BODY.has(res.status) ? new Uint8Array(0) : new Uint8Array(await res.arrayBuffer());
    const headers = {};
    for (const h of KEEP) { const v = res.headers.get(h); if (v != null) headers[h] = v; }
    const a = { method: (opts.method || 'GET').toUpperCase(), url, status: res.status, headers };
    let text = null;
    if (!(bytes[0] === 0x1f && bytes[1] === 0x8b)) { try { text = utf8.decode(bytes); } catch { text = null; } }
    if (text !== null) a.text = text; else a.b64 = toB64(bytes);
    answers.push(a);
    return new Response(NO_BODY.has(res.status) ? null : bytes, { status: res.status, headers });
  };
  fn.answers = answers;
  return fn;
}

/* The answers checked for shape before anything reads them: a list of {method, url, status, headers, text|b64}. */
export function answersProblem(answers) {
  if (!Array.isArray(answers) || !answers.length) return 'no answers';
  if (answers.length > 200) return 'more than 200 answers';
  for (const a of answers) {
    if (!a || typeof a.url !== 'string' || !/^https:\/\//.test(a.url)) return 'an answer without an https address';
    if (!Number.isInteger(a.status) || a.status < 200 || a.status > 599) return `an answer with status ${a?.status}`;
    if (typeof a.text !== 'string' && typeof a.b64 !== 'string') return 'an answer without a body';
    if (a.headers && (typeof a.headers !== 'object' || Object.values(a.headers).some((v) => typeof v !== 'string'))) return 'an answer with odd headers';
  }
  return null;
}

/* A fetch that answers each request from the Air's answers, in order, matched on method and address. A request the Air
   never made is an error, so the read fails and nothing is published from it. */
export function replayFetch(answers) {
  const queues = new Map();
  for (const a of answers) {
    const k = key(a.method, a.url);
    if (!queues.has(k)) queues.set(k, []);
    queues.get(k).push(a);
  }
  return async (url, opts = {}) => {
    const a = queues.get(key(opts.method, url))?.shift();
    if (!a) throw new Error(`the Air's read has no answer for ${key(opts.method, url)}`);
    const headers = {};
    for (const h of KEEP) if (a.headers?.[h] != null) headers[h] = a.headers[h];
    const body = NO_BODY.has(a.status) ? null : typeof a.text === 'string' ? a.text : fromB64(a.b64);
    return new Response(body, { status: a.status, headers });
  };
}
