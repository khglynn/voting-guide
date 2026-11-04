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

/* Some Clarity hosts (Fulton GA, Nov 3) send summary.json gzipped with no Content-Encoding header, so the platform
   never unzips it. Read the bytes, and when they start with gzip's magic (1f 8b), unzip them by hand.
   DecompressionStream exists in both Workers and Node 18+. */
export async function bodyText(res) {
  if (typeof res.arrayBuffer !== 'function') return res.text();
  let bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const out = new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')));
    bytes = new Uint8Array(await out.arrayBuffer());
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
const CHALLENGE_WORDS = /captcha|human verification|confirm you are (?:a )?human|verify you are (?:a )?human|are you a robot/i;
export function challengeOf(res, body = '', { page = false } = {}) {
  if (res.status === 405) return 'HTTP 405, a bot check';
  const waf = res.headers.get('x-amzn-waf-action');
  if (waf) return `HTTP ${res.status}, a bot check (x-amzn-waf-action: ${waf})`;
  if (/challenge/i.test(res.headers.get('cf-mitigated') || '')) return `HTTP ${res.status}, a bot check (cf-mitigated: challenge)`;
  const title = (String(body).match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i) || [])[1] || '';
  if (CHALLENGE_TITLE.test(title)) return `HTTP ${res.status}, a bot check page came back ("${title.replace(/\s+/g, ' ').trim().slice(0, 60)}")`;
  if (!page && body && CHALLENGE_WORDS.test(String(body).slice(0, 50000))) return `HTTP ${res.status}, a bot check page came back`;
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
  const marked = challengeOf(res);
  if (marked) return { verdict: 'refused', challenge: true, ...meta, error: marked };
  if ([401, 403, 429].includes(res.status)) return { verdict: 'refused', ...meta, error: `HTTP ${res.status}` };
  if (!res.ok) {
    let page = '';
    try { page = await bodyText(res); } catch { /* an unreadable error body is just an error */ }
    const ch = challengeOf(res, page);
    if (ch) return { verdict: 'refused', challenge: true, ...meta, error: ch };
    const via = [res.headers.get('server'), res.headers.get('x-cache'), res.headers.get('cf-ray') ? 'cf' : null].filter(Boolean).join(', '); return { verdict: 'error', ...meta, error: `HTTP ${res.status} on ${url.split('/').slice(-3).join('/')}${via ? ` (${via})` : ''}` };
  }
  const body = await bodyText(res);
  if (expect === 'json') {
    if (/^\s*</.test(body)) return { verdict: 'refused', ...meta, error: 'an HTML page came back where data was expected (a bot check?)' };
    try { return { verdict: 'ok', ...meta, body, json: JSON.parse(body) }; } catch { return { verdict: 'error', ...meta, error: 'the data was not valid JSON' }; }
  }
  if (expect === 'text' && /^\s*<(!doctype|html)/i.test(body)) return { verdict: 'refused', ...meta, error: 'an HTML page came back where a short text file was expected' };
  if (expect === 'html') { const ch = challengeOf(res, body, { page: true }); if (ch) return { verdict: 'refused', challenge: true, ...meta, error: ch }; }
  return { verdict: 'ok', ...meta, body };
}
