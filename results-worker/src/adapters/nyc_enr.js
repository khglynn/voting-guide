/* The New York City Board of Elections' election night site (enr.boenyc.gov): static, server-rendered HTML pages,
   one per office, regenerated together every few minutes (all share one Last-Modified). No JSON or CSV exists on
   election night (capture round 1, Nov 3). Read on Nov 3, 10:20 PM CT with our named User-Agent: 200s from
   Cloudflare, no challenge.

   The map lists the pages to read (`feed.pages`): an office's "Expand List" page (OFA3CY0PY3.html, every
   congressional district on one page) or a single contest's page (OF18CY0PY1.html). Each contest is
     <th>Representative in Congress 3rd Congressional District*<div ...>(Vote for one)</div></th>
     ... <tr><td >1</td><td>&nbsp;</td><td >Thomas R. Suozzi&nbsp;</td><td >Democratic&nbsp;</td>
         <td align="right" >&nbsp;30732</td><td align="right" >&nbsp;60.02%</td> ...
     <th colspan = "7">Totals by Candidate</th> ... (one row per person, the board's own sum of party lines)
   Leading rows are drawn bold (`<td style="font-weight: bold">`); that is styling, never read as a winner.
     Percentage of Scanners Reported: <label ...>96.38 %</label> ... Information As Of: 2026-11-03 23:15:02 EST
   New York lets one candidate run on several party lines. Where a contest has a "Totals by Candidate" block, the
   board's own per-person totals are the choices; where it has none, every person has one line and the rows are the
   choices. A contest with a repeated name and no board total is dropped, never summed by us, and so is one whose
   rows don't add up to the total the board prints under them (a row the parse missed).
   The heading's asterisk is the board's mark for "the City of New York portion of the contests only"; it rides on
   the contest as `category` so a map can't mistake that count for the whole race.
   index.html is the change token: an unchanged poll is one conditional request (If-Modified-Since, 304). */
import { get } from '../fetch.js';
import { isoDate } from '../util.js';

const text = (h) => String(h || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
export const PORTION = 'City of New York portion only';

function voteFor(s) {
  const m = String(s || '').match(/Vote for (?:any |up to )?(\w+)/i);
  if (!m) return 1;
  const n = Number(m[1]) || WORDS[m[1].toLowerCase()];
  return n || 1;
}

/* "2026-11-03 23:15:02 EST" to ISO UTC; null when unreadable. */
const ZONES = { EST: -5, EDT: -4 };
export function parseAsOf(s) {
  const m = String(s || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(EST|EDT)$/i);
  if (!m) return null;
  const off = ZONES[m[7].toUpperCase()];
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - off, +m[5], +(m[6] || 0))).toISOString();
}

function rows(html) {
  return [...String(html).matchAll(/<tr[^>]*>\s*<td[^>]*>(\d+)<\/td>\s*<td[^>]*>&nbsp;<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td align="right"[^>]*>([\s\S]*?)<\/td>\s*<td align="right"[^>]*>([\s\S]*?)<\/td>/g)]
    .map((r) => ({ name: text(r[2]), party: text(r[3]) || null, votes: Number(text(r[4]).replace(/,/g, '')) }));
}

/* One page's contests. */
export function parsePage(html) {
  const contests = [];
  let dropped = 0;
  const heads = [...String(html).matchAll(/<th>([^<]*?)(\*)?<div[^>]*>\(([^)]*)\)<\/div><\/th>/g)];
  heads.forEach((h, i) => {
    const block = html.slice(h.index + h[0].length, i + 1 < heads.length ? heads[i + 1].index : html.length);
    const heading = text(h[1]);
    const [lines, totals] = block.split(/Totals by Candidate/);
    let choices = rows(totals ?? lines);
    if (totals === undefined) {
      const names = choices.map((c) => c.name);
      if (new Set(names).size !== names.length) { dropped++; return; } // a person on two lines with no board total
    }
    // The board prints the contest's total under each block; our rows must add up to it, or the parse missed a row.
    const printed = (String(totals ?? lines).match(/border-top-color: #000000" align="right">\s*([\d,]+)\s*</) || [])[1];
    const sum = choices.reduce((a, c) => a + (Number.isFinite(c.votes) ? c.votes : 0), 0);
    if (!printed || Number(printed.replace(/,/g, '')) !== sum) { dropped++; return; }
    choices = choices.map(({ name, votes }) => ({ name, votes }));
    const pct = (block.match(/Percentage of Scanners Reported:\s*(?:<[^>]*>)?\s*([\d.]+)\s*%/) || [])[1];
    const asOf = (block.match(/Information As Of:\s*([^<]+)/) || [])[1];
    contests.push({
      feed_id: heading.replace(/, a Question:.*$/, ''),
      feed_name: heading,
      category: h[2] ? PORTION : null,
      vote_for: voteFor(h[3]),
      choices,
      total: choices.reduce((a, c) => a + (Number.isFinite(c.votes) ? c.votes : 0), 0),
      reporting: pct ? `Percentage of Scanners Reported: ${pct} %` : null,
      updated: parseAsOf(asOf),
      declared: null,
    });
  });
  return { contests, dropped };
}

/* index.html: the election's heading ("SPECIAL<BR>NOVEMBER 3, 2026"), the status line, the page's creation time. */
export function parseIndex(html) {
  const ths = [...String(html).matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1]);
  const heading = ths.find((t) => /\b(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+\d{1,2},\s+\d{4}/i.test(t)) || '';
  const name = text(heading);
  const dateWords = (name.match(/([A-Z]+ \d{1,2}, \d{4})/i) || [])[1] || null;
  const status = text(ths.find((t) => /RESULTS/i.test(t) && !/BOARD OF ELECTIONS/i.test(t)) || '') || null;
  const created = (String(html).match(/Page Creation:\s*([^<]+)/) || [])[1]?.trim() || null;
  return { name, date: isoDate(dateWords ? dateWords.toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : null), status, created };
}

const sentence = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);

export async function read({ fetch, map, prevToken = null }) {
  const identity = map.feed.identity || 'named';
  const base = map.feed.base;
  const indexUrl = `${base}/${map.feed.token_page || 'index.html'}`;
  const lastMod = prevToken ? prevToken.split('|')[0] : null;
  const idx = await get(fetch, indexUrl, { identity, expect: 'html', headers: lastMod ? { 'If-Modified-Since': lastMod } : {} });
  if (idx.verdict === 'not_modified') return { verdict: 'ok', unchanged: true, changed_token: prevToken };
  if (idx.verdict !== 'ok') return { verdict: idx.verdict, error: idx.error, status: idx.status, url: indexUrl };
  const ix = parseIndex(idx.body || '');
  if (!ix.name) return { verdict: 'error', error: 'index.html has no election heading', url: indexUrl };
  const token = `${idx.lastModified || ''}|${ix.created || ''}`;
  if (prevToken && token === prevToken) return { verdict: 'ok', unchanged: true, changed_token: token };

  const raw = { 'index.html': idx.body };
  const contests = [];
  let dropped = 0;
  for (const page of map.feed.pages || []) {
    const url = `${base}/${page}`;
    const r = await get(fetch, url, { identity, expect: 'html' });
    if (r.verdict !== 'ok') return { verdict: r.verdict, error: r.error, status: r.status, url };
    raw[page] = r.body;
    const p = parsePage(r.body || '');
    if (!p.contests.length && !p.dropped) return { verdict: 'error', error: `${page} has no contest on it`, url };
    contests.push(...p.contests);
    dropped += p.dropped;
  }
  const times = contests.map((c) => c.updated).filter(Boolean).sort();
  const rep = map.feed.reporting_contest ? contests.find((c) => c.feed_id === map.feed.reporting_contest)?.reporting ?? null : null;
  return {
    verdict: 'ok',
    changed_token: token,
    raw,
    election: { id: ix.name, name: ix.name, date: ix.date },
    source_status: null,
    official: /CERTIFIED|OFFICIAL RESULTS/i.test(ix.status || '') && !/UNOFFICIAL/i.test(ix.status || ''),
    source_updated: times.length ? times[times.length - 1] : null,
    reporting: rep,
    labels: ix.status ? [sentence(ix.status)] : [],
    dropped,
    contests,
  };
}
