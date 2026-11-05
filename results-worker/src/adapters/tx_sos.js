/* The Texas Secretary of State's own results page (electionresults.sos.state.tx.us/results.html): the official
   statewide count, server-rendered HTML with no contest ids. Each race is
     <div class="election">U. S. SENATOR</div><div class="polling">Polling Locations Reporting: 11%</div>
     <table class="election"> ... <td class="party">..</td><td class="candidate">..</td><td class="ballot">2,553,979</td>
   The heading is the feed id; the polling line is quoted as the race's progress words. The page's own time is
   "(Updated 11/03/2026 08:56 PM)", Central. A race counts only when its table closes: on Nov 3 at 8:58 PM the SOS
   served a file cut off mid-row in U.S. House District 9 (8,478 bytes, every fetch), so a cut-off race is dropped,
   never read as finished, and the read says how many races it dropped. Last-Modified makes an unchanged poll one
   conditional request. */
import { get } from '../fetch.js';
import { parseUsTime, isoDate } from '../util.js';

const text = (h) => String(h || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();

export function parse(html) {
  const updated = (html.match(/\(Updated\s+(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s*[AP]M)\)/i) || [])[1] || null;
  const dateWords = (html.match(/Election Results\s*-\s*\w+,\s*([A-Za-z]+ \d{1,2}, \d{4})/) || [])[1] || null;
  const name = ((text(html).match(/\b(\d{4}(?: [A-Z]+)+ ELECTION)\b/) || [])[1]) || '';
  const contests = [];
  let dropped = 0;
  const re = /<div class="election">([\s\S]*?)<\/div>\s*<div class="polling">([\s\S]*?)<\/div>\s*<div>\s*<table class="election">([\s\S]*?)(<\/table>|$)/g;
  for (const m of html.matchAll(re)) {
    if (m[4] !== '</table>') { dropped++; continue; }
    const rows = [...m[3].matchAll(/<tr>\s*<td class="party">([\s\S]*?)<\/td>\s*<td class="candidate">([\s\S]*?)<\/td>\s*<td class="ballot">([\s\S]*?)<\/td>\s*<\/tr>/g)];
    const choices = rows.map((r) => ({ name: text(r[2]), party: text(r[1]), votes: Number(text(r[3]).replace(/,/g, '')) }));
    const heading = text(m[1]);
    contests.push({ feed_id: heading, feed_name: heading, category: null, vote_for: 1, choices, total: choices.reduce((a, c) => a + (Number.isFinite(c.votes) ? c.votes : 0), 0), reporting: text(m[2]) || null, updated: null, declared: null });
  }
  // A heading with no table after it at all is a cut-off race too.
  const headings = (html.match(/<div class="election">/g) || []).length;
  dropped = Math.max(dropped, headings - contests.length);
  return { updated, date: isoDate(dateWords), name, contests, dropped };
}

export async function read({ fetch, map, prevToken = null }) {
  const identity = map.feed.identity || 'named';
  const url = `${map.feed.base}/results.html`;
  const lastMod = prevToken ? prevToken.split('|')[0] : null;
  const r = await get(fetch, url, { identity, expect: 'html', headers: lastMod ? { 'If-Modified-Since': lastMod } : {} });
  if (r.verdict === 'not_modified') return { verdict: 'ok', unchanged: true, changed_token: prevToken };
  if (r.verdict !== 'ok') return { verdict: r.verdict, error: r.error, status: r.status, url };
  const p = parse(r.body || '');
  if (!p.contests.length) return { verdict: 'error', error: 'no complete race on the page', url };
  const token = `${r.lastModified || ''}|${p.updated || ''}|${p.contests.length}`;
  if (prevToken && token === prevToken) return { verdict: 'ok', unchanged: true, changed_token: token };
  return {
    verdict: 'ok',
    changed_token: token,
    raw: { 'results.html': r.body },
    election: { id: p.name, name: p.name, date: p.date },
    source_status: null,
    official: false,
    source_updated: parseUsTime(p.updated, -6),
    reporting: null,
    dropped: p.dropped,
    contests: p.contests,
  };
}
