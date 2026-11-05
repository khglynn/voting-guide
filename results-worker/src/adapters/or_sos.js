/* The Oregon Secretary of State's results site (results.oregonvotes.gov): server-rendered ASP.NET pages, one per
   kind of race, read by plain GET. Checked Nov 3, 10:20 PM CT with our named User-Agent (200 on every page):
     /                                      the header only: "Unofficial" / "General Election November 3, 2026",
                                            "Ballots Counted 1,210,606", "Results last updated: 11/3/2026 | 8:15 PM PT"
     /resultsSW.aspx?type=FED|SWPAR|SENATE|HOUSE|SWNON|LMEA|MCR&map=CTY
                                            federal, statewide partisan, state senate, state house, nonpartisan
                                            (circuit judges), local measures, shared county/city/district races
     /ResultsSW.aspx?type=CTYALL&cty=26&map=CTY   one county's own races (Multnomah is 26); read by the multco adapter
   Each race is a `wrapper-inside wrapper-border` block: its title in `display-results-box-a` <h1>, the progress line
   "0 out of 218 Precincts Reported", one row per choice (<h1> name, <h2> party, votes in `display-results-box-f`, a
   "Write-in" row on candidate races) and the race's own total in `id="{raceid}totals"`. The race id (the export
   button's `raceid`) is the feed id. The statewide pages count each race whole across counties.
   The site's own words: "Write-in results are not reported on this site" (the Write-in line is the counties' total of
   unnamed write-ins). Oregon votes by mail, so "0 out of N Precincts Reported" sits beside a million counted ballots;
   like Clarity's, that line is left out while it says zero with votes in (no progress words rather than wrong ones).
   A block with no total, or whose rows don't add to the site's own total, is dropped and counted, never read as
   finished (a page served cut off, as the Texas SOS was on Nov 3). Races the site sends elsewhere ("- view results at
   rcvresults.multco.us", ranked choice) have no rows here and are left out. Times are Pacific; the whole count window
   (Nov 3 to certification) is standard time, PST (UTC-8). An unchanged poll is the 37 KB header page only. */
import { get } from '../fetch.js';
import { parseUsTime, isoDate } from '../util.js';

const text = (h) => String(h || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const count = (s) => (/^[\d,]+$/.test(String(s).trim()) ? Number(String(s).replace(/,/g, '')) : NaN);

/* The header every page carries. */
export function header(html) {
  const h = String(html || '');
  const label = text((h.match(/<div class="col header-box1">\s*<h3>([\s\S]*?)<\/h3>/) || [])[1]) || null;
  const name = text((h.match(/<div class="col header-box1">[\s\S]*?<h2>([\s\S]*?)<\/h2>/) || [])[1]) || '';
  const type = (h.match(/id="hidElectionType" value="([^"]*)"/) || [])[1] || '';
  const date = (h.match(/id="hidElectionDate" value="([^"]*)"/) || [])[1] || '';
  const stamp = (h.match(/Results last updated:\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*\|\s*(\d{1,2}:\d{2}\s*[AP]M)\s*PT/i) || []);
  const ballots = (h.match(/<span class="vt-text">Ballots Counted<\/span><span class="vt-number">([\d,]+)<\/span>/) || [])[1] || null;
  return {
    label,
    name,
    id: type && date ? `${type} ${date}` : null,
    date: isoDate(date),
    stamp: stamp[1] ? `${stamp[1]} ${stamp[2]}` : null,
    updated: stamp[1] ? parseUsTime(`${stamp[1]} ${stamp[2]}`, -8) : null,
    ballots,
  };
}

/* Every finished race block on one page. */
export function parsePage(html) {
  const h = String(html || '');
  const head = header(h);
  const contests = [];
  let dropped = 0, elsewhere = 0;
  for (const b of h.split('<div class="wrapper-inside wrapper-border">').slice(1)) {
    const title = text((b.match(/display-results-box-a">\s*<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1]).replace(/\s*All Results$/, '');
    if (!title) { dropped++; continue; }
    const totalM = b.match(/id="(\d+)totals">\s*([\d,]+)\s*</);
    const rows = [...b.matchAll(/display-results-box-d">\s*<h1>([\s\S]*?)<\/h1>\s*<h2[^>]*>([\s\S]*?)<\/h2>[\s\S]*?display-results-box-f">\s*<div>\s*([^<]*?)\s*<\/div>/g)];
    // Ranked-choice races the site points elsewhere carry placeholder zero rows here: never read them as counts.
    if (/view results at|rcvresults/i.test(title)) { elsewhere++; continue; }
    if (!totalM || !rows.length) { dropped++; continue; }
    const choices = rows.map((r) => ({ name: text(r[1]), party: text(r[2]) || null, votes: count(r[3]) }));
    const sum = choices.reduce((a, c) => a + c.votes, 0);
    if (!Number.isFinite(sum) || sum !== count(totalM[2])) { dropped++; continue; }
    const words = text((b.match(/<div class="precinct-fully">([\s\S]*?)<\/div>/) || [])[1]) || null;
    const zeroWithVotes = /^0 out of/i.test(words || '') && sum > 0;
    contests.push({
      feed_id: totalM[1],
      feed_name: title,
      category: null,
      vote_for: Number((title.match(/\(Vote For (\d+)\)/i) || [])[1] || 1),
      choices,
      total: sum,
      reporting: zeroWithVotes ? null : words,
      updated: head.updated,
      declared: null,
    });
  }
  return { ...head, contests, dropped, elsewhere };
}

export async function read({ fetch, map, prevToken = null }) {
  const identity = map.feed.identity || 'named';
  const top = await get(fetch, `${map.feed.base}/`, { identity, expect: 'html' });
  if (top.verdict !== 'ok') return { verdict: top.verdict, error: top.error, status: top.status, url: top.url };
  const hd = header(top.body);
  if (!hd.stamp) return { verdict: /<form|Results last updated/i.test(top.body || '') ? 'error' : 'refused', error: 'the results page has no "Results last updated" line', url: top.url };
  const token = `${hd.stamp}|${hd.ballots || ''}|${hd.label || ''}`;
  if (prevToken && token === prevToken) return { verdict: 'ok', unchanged: true, changed_token: token };

  const raw = { 'index.html': top.body };
  const seen = new Set();
  const contests = [];
  let dropped = 0;
  for (const entry of map.feed.pages || []) {
    // A page is a path, or { page, post: { name, value } }: the same page's own form button (House 31 to 60).
    const page = typeof entry === 'string' ? entry : entry.page;
    const key = typeof entry === 'string' ? page : `${page}#${entry.post.name}`;
    let r;
    if (typeof entry === 'string') r = await get(fetch, `${map.feed.base}/${page}`, { identity, expect: 'html' });
    else {
      if (!raw[page]) return { verdict: 'error', error: `${key}: its page must be read first`, url: top.url };
      r = await get(fetch, `${map.feed.base}/${page}`, { identity, expect: 'html', method: 'POST', body: formBody(raw[page], entry.post), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    }
    if (r.verdict !== 'ok') return { verdict: r.verdict, error: r.error, status: r.status, url: r.url };
    raw[key] = r.body;
    const p = parsePage(r.body);
    if (p.id !== hd.id) return { verdict: 'ok', ...shell(map, hd, token, raw), election: { id: p.id, name: p.name, date: p.date }, contests: [] };
    // Each page is cached apart (the home page for 29 s, a results page for 60 s, Nov 3), so a page can still serve the
    // update before the one the home page names. Its numbers would be kept under the new token until the next update
    // (about once a day after tonight), and an Official label could stand over unofficial counts: try again instead
    // (pre-deploy review, Nov 3).
    if (p.stamp !== hd.stamp || p.label !== hd.label) return { verdict: 'error', error: `${key}: the page says ${p.stamp || 'no time'} (${p.label || 'no label'}), the home page ${hd.stamp} (${hd.label || 'no label'}): a cached copy`, url: r.url };
    dropped += p.dropped;
    for (const c of p.contests) if (!seen.has(c.feed_id)) { seen.add(c.feed_id); contests.push(c); }
  }
  if (!contests.length) return { verdict: 'error', error: 'no finished race on any results page', url: top.url };
  return { verdict: 'ok', ...shell(map, hd, token, raw), dropped, contests };
}

/* The page's own hidden form fields plus the one button, as the browser would send them. */
const unent = (v) => String(v || '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
export function formBody(html, button) {
  const pairs = [];
  for (const m of String(html || '').matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
    const name = (m[0].match(/name="([^"]*)"/) || [])[1];
    if (name) pairs.push([unent(name), unent((m[0].match(/value="([^"]*)"/) || [])[1] || '')]);
  }
  pairs.push([button.name, button.value]);
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

function shell(map, hd, token, raw) {
  return {
    changed_token: token,
    raw,
    election: { id: hd.id, name: hd.name, date: hd.date },
    source_status: null,
    official: /^official$/i.test(hd.label || ''),
    source_updated: hd.updated,
    reporting: hd.ballots ? `Ballots Counted ${hd.ballots}` : null,
    labels: [hd.label].filter(Boolean),
  };
}
