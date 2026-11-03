/* One way to read a feed: a 15-second timeout, our own name in the User-Agent, and a verdict a person can act on.
   `ok`: the body came back as expected. `not_modified`: a conditional read said nothing changed (304).
   `refused`: 401, 403, 429, or an HTML page where data was expected (a bot check); the schedule stops a refused source
   until a person changes its map. `error`: anything else (timeout, 404, 5xx, bad JSON); the schedule backs off and retries.
   A map may set identity "browser" only with a note that the named request was refused (Kevin's call 6, Nov 3): never
   past a CAPTCHA or a login, and never faster than the schedule allows.
   Redirects are never followed (`redirect: 'manual'`): a feed that sends us elsewhere is `refused`, so a read can only
   ever come from the exact address its map names (security review, Nov 3). */

export const NAMED_UA = 'vote.kevinhg.com results fetcher (+https://vote.kevinhg.com)';
export const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export async function get(fetchFn, url, { identity = 'named', expect = 'json', headers = {}, timeoutMs = 15000 } = {}) {
  const h = { 'User-Agent': identity === 'browser' ? BROWSER_UA : NAMED_UA, Accept: expect === 'json' ? 'application/json, text/plain, */*' : '*/*', ...headers };
  let res;
  try {
    res = await fetchFn(url, { headers: h, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
  } catch (e) {
    return { verdict: 'error', status: 0, url, error: e?.name === 'TimeoutError' ? 'timed out after 15 s' : String(e?.message || e) };
  }
  const meta = { status: res.status, url, lastModified: res.headers.get('last-modified'), etag: res.headers.get('etag') };
  if (res.status >= 300 && res.status < 400 && res.status !== 304) return { verdict: 'refused', ...meta, error: `HTTP ${res.status}: redirected to ${res.headers.get('location') || 'somewhere else'}` };
  if (res.url && res.url !== url) return { verdict: 'refused', ...meta, error: `served from ${res.url}, not the address asked for` };
  if (res.status === 304) return { verdict: 'not_modified', ...meta };
  if ([401, 403, 429].includes(res.status)) return { verdict: 'refused', ...meta, error: `HTTP ${res.status}` };
  if (!res.ok) return { verdict: 'error', ...meta, error: `HTTP ${res.status}` };
  const body = await res.text();
  if (expect === 'json') {
    if (/^\s*</.test(body)) return { verdict: 'refused', ...meta, error: 'an HTML page came back where data was expected (a bot check?)' };
    try { return { verdict: 'ok', ...meta, body, json: JSON.parse(body) }; } catch { return { verdict: 'error', ...meta, error: 'the data was not valid JSON' }; }
  }
  if (expect === 'text' && /^\s*<(!doctype|html)/i.test(body)) return { verdict: 'refused', ...meta, error: 'an HTML page came back where a short text file was expected' };
  return { verdict: 'ok', ...meta, body };
}
