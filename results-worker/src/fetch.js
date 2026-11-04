/* One way to read a feed: a 15-second timeout, our own name in the User-Agent, and a verdict a person can act on.
   `ok`: the body came back as expected. `not_modified`: a conditional read said nothing changed (304).
   `refused`: 401, 403, 429, a bot check or CAPTCHA whatever its status (see challengeOf), or an HTML page where data
   was expected; the schedule stops a refused source until a person changes its map or runs it by hand.
   `error`: anything else (timeout, 404, a plain 5xx, bad JSON); the schedule backs off and retries.
   A map may set identity "browser" only with a note that the named request was refused (Kevin's call 6, Nov 3): never
   past a CAPTCHA or a login, and never faster than the schedule allows.
   Redirects are never followed (`redirect: 'manual'`): a feed that sends us elsewhere is `refused`, so a read can only
   ever come from the exact address its map names (security review, Nov 3). */

export const NAMED_UA = 'vote.kevinhg.com results fetcher (+https://vote.kevinhg.com)';
export const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/* Every source in a tick shares one Worker run's 128 MB, and a read's raw copy is turned into a string again for its
   hash and its archive copy, so one oversized body (a mis-posted export, a small gzip that unpacks to hundreds of MB)
   could end the run before any state publishes, and again every minute (pre-deploy review, Nov 3). The largest real
   feed tonight is St. Louis County's 6.6 MB CSV; past these caps a read is an error with a plain reason. */
export const MAX_BYTES = 16_000_000;
export const MAX_UNZIPPED = 32_000_000;
const mb = (n) => `${Math.round(n / 1e6)} MB`;

async function readCapped(stream, cap, what) {
  const reader = stream.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > cap) { try { await reader.cancel(); } catch { /* already closed */ } throw new Error(`${what} is larger than ${mb(cap)}`); }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/* Some Clarity hosts (Fulton GA, Nov 3) send summary.json gzipped with no Content-Encoding header, so the platform
   never unzips it. Read the bytes, and when they start with gzip's magic (1f 8b), unzip them by hand.
   DecompressionStream exists in both Workers and Node 18+. Both reads stop at their cap. */
export async function bodyText(res) {
  let bytes;
  if (res.body && typeof res.body.getReader === 'function') bytes = await readCapped(res.body, MAX_BYTES, 'the response');
  else if (typeof res.arrayBuffer === 'function') { bytes = new Uint8Array(await res.arrayBuffer()); if (bytes.length > MAX_BYTES) throw new Error(`the response is larger than ${mb(MAX_BYTES)}`); }
  else { const t = await res.text(); if (t.length > MAX_BYTES) throw new Error(`the response is larger than ${mb(MAX_BYTES)}`); return t; }
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    bytes = await readCapped(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')), MAX_UNZIPPED, 'the unzipped data');
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/* A bot check or CAPTCHA is a refusal whatever status it comes with: the source stops, its rows link out, and we never
   try to get past it (Kevin's call 6). Clarity's AWS WAF answered with a 405 "Human Verification" page on Nov 3 at
   9:09 PM, and marks its challenges with x-amzn-waf-action; Cloudflare marks its own with cf-mitigated and titles them
   "Just a moment..." or "Attention Required!"; a 200 page can be one (the Texas SOS sits behind Cloudflare). A plain
   500, 502, 503 or 504 is not one, so real blips still recover. A good page is judged by its <title> only: Cloudflare
   injects a "/cdn-cgi/challenge-platform/" script into ordinary pages, so words in the body would stop a real source. */
const CHALLENGE_TITLE = /just a moment|attention required|captcha|human verification|verify you are (?:a )?human|are you a robot/i;
const CHALLENGE_WORDS = /\bcaptcha\b|human verification|confirm you are (?:a )?human|verify you are (?:a )?human|are you a robot/i;
/* What a reader of an error page would see: no scripts, styles or tags. An ordinary 503 or 404 from a site whose
   template loads reCAPTCHA for a contact form (`google.com/recaptcha/api.js`, `class="g-recaptcha"`) is not a bot check
   and must stay an error that backs off, never a refusal that stops the source (pre-deploy review, Nov 3).
   Linear passes only, never a backtracking regex: a hostile or broken page (thousands of unclosed "<script" openers,
   or "<" with no ">") must not burn the tick's CPU (security review, Nov 3). */
export function visible(s) {
  const src = String(s).slice(0, 200_000);
  const low = src.toLowerCase();
  let kept = '';
  let i = 0;
  let nextScript = low.indexOf('<script'), nextStyle = low.indexOf('<style');
  for (;;) {
    if (nextScript >= 0 && nextScript < i) nextScript = low.indexOf('<script', i);
    if (nextStyle >= 0 && nextStyle < i) nextStyle = low.indexOf('<style', i);
    const at = nextScript < 0 ? nextStyle : nextStyle < 0 ? nextScript : Math.min(nextScript, nextStyle);
    if (at < 0) { kept += src.slice(i); break; }
    kept += `${src.slice(i, at)} `;
    const close = low.indexOf(at === nextScript ? '</script' : '</style', at);
    const end = close < 0 ? -1 : low.indexOf('>', close);
    if (end < 0) break; // never closed: the rest is script, dropped
    i = end + 1;
  }
  return stripTags(kept);
}

/* Tags out, text kept; a "<" with no ">" after it ends the text. */
function stripTags(s) {
  let out = '';
  let i = 0;
  for (;;) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { out += s.slice(i); break; }
    out += `${s.slice(i, lt)} `;
    const gt = s.indexOf('>', lt);
    if (gt < 0) break;
    i = gt + 1;
  }
  return out;
}

/* A page's <title> text, by indexOf, for the same reason. */
function titleOf(body) {
  const src = String(body).slice(0, 200_000);
  const low = src.toLowerCase();
  const open = low.indexOf('<title');
  if (open < 0) return '';
  const gt = low.indexOf('>', open);
  if (gt < 0) return '';
  const close = low.indexOf('</title', gt);
  if (close < 0 || close - gt - 1 > 200) return '';
  return src.slice(gt + 1, close);
}
export function challengeOf(res, body = '', { page = false, method = 'GET' } = {}) {
  // A bare 405 is a bot check on a GET (Clarity's WAF); on the Oregon form POST it can be a real "method not allowed".
  if (res.status === 405 && method === 'GET') return 'HTTP 405, a bot check';
  const waf = res.headers.get('x-amzn-waf-action');
  if (waf) return `HTTP ${res.status}, a bot check (x-amzn-waf-action: ${waf})`;
  if (/challenge/i.test(res.headers.get('cf-mitigated') || '')) return `HTTP ${res.status}, a bot check (cf-mitigated: challenge)`;
  const title = titleOf(body);
  if (CHALLENGE_TITLE.test(title)) return `HTTP ${res.status}, a bot check page came back ("${title.replace(/\s+/g, ' ').trim().slice(0, 60)}")`;
  if (!page && body && CHALLENGE_WORDS.test(visible(body).slice(0, 50_000))) return `HTTP ${res.status}, a bot check page came back`;
  return null;
}

/* `method` and `body` exist for one case: an ASP.NET page whose second half sits behind its own form button (the
   Oregon SOS House races 31 to 60, Nov 3). The post carries only what the page itself put in the form. */
export async function get(fetchFn, url, { identity = 'named', expect = 'json', headers = {}, timeoutMs = 15000, method = 'GET', body: postBody = undefined } = {}) {
  const h = { 'User-Agent': identity === 'browser' ? BROWSER_UA : NAMED_UA, Accept: expect === 'json' ? 'application/json, text/plain, */*' : '*/*', ...headers };
  let res;
  try {
    res = await fetchFn(url, { method, body: postBody, headers: h, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
  } catch (e) {
    return { verdict: 'error', status: 0, url, error: e?.name === 'TimeoutError' ? 'timed out after 15 s' : String(e?.message || e) };
  }
  const meta = { status: res.status, url, lastModified: res.headers.get('last-modified'), etag: res.headers.get('etag') };
  if (res.status >= 300 && res.status < 400 && res.status !== 304) return { verdict: 'refused', ...meta, error: `HTTP ${res.status}: redirected to ${res.headers.get('location') || 'somewhere else'}` };
  if (res.url && res.url !== url) return { verdict: 'refused', ...meta, error: `served from ${res.url}, not the address asked for` };
  if (res.status === 304) return { verdict: 'not_modified', ...meta };
  const marked = challengeOf(res, '', { method });
  if (marked) return { verdict: 'refused', challenge: true, ...meta, error: marked };
  if ([401, 403, 429].includes(res.status)) return { verdict: 'refused', ...meta, error: `HTTP ${res.status}` };
  if (!res.ok) {
    let page = '';
    try { page = await bodyText(res); } catch { /* an unreadable error body is just an error */ }
    const ch = challengeOf(res, page, { method });
    if (ch) return { verdict: 'refused', challenge: true, ...meta, error: ch };
    const via = [res.headers.get('server'), res.headers.get('x-cache'), res.headers.get('cf-ray') ? 'cf' : null].filter(Boolean).join(', '); return { verdict: 'error', ...meta, error: `HTTP ${res.status} on ${url.split('/').slice(-3).join('/')}${via ? ` (${via})` : ''}` };
  }
  if (Number(res.headers.get('content-length')) > MAX_BYTES) return { verdict: 'error', ...meta, error: `the response is larger than ${mb(MAX_BYTES)} (Content-Length ${res.headers.get('content-length')})` };
  let body;
  try { body = await bodyText(res); } catch (e) { return { verdict: 'error', ...meta, error: String(e?.message || e) }; }
  if (expect === 'json') {
    if (/^\s*</.test(body)) return { verdict: 'refused', ...meta, error: 'an HTML page came back where data was expected (a bot check?)' };
    try { return { verdict: 'ok', ...meta, body, json: JSON.parse(body) }; } catch { return { verdict: 'error', ...meta, error: 'the data was not valid JSON' }; }
  }
  if (expect === 'text' && /^\s*<(!doctype|html)/i.test(body)) return { verdict: 'refused', ...meta, error: 'an HTML page came back where a short text file was expected' };
  if (expect === 'html') { const ch = challengeOf(res, body, { page: true, method }); if (ch) return { verdict: 'refused', challenge: true, ...meta, error: ch }; }
  return { verdict: 'ok', ...meta, body };
}
