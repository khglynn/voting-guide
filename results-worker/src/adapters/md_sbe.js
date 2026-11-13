/* The Maryland State Board of Elections' results pages: static, server-rendered HTML, one page per office
   (gen_results_2026_4_P.html holds every congressional district) and one per county (by_county_3_P.html is
   Baltimore City, its questions included). The map reads the printer-friendly `_P` twins, which carry the same
   tables without the site's menus. On Nov 3 at 10:21 PM CT the pages moved from elections.maryland.gov to
   results.elections.maryland.gov (the old address answered 302), and by Nov 12 they had moved back (the new address
   answers 302 to the old), so the map names elections.maryland.gov again (Nov 13). Fetches never follow redirects, so
   a move reads as refused rather than as data from an address nobody checked, and the map is changed by hand.

   Each contest is a run of headings, the board's progress words, then a table:
     <h2>House of Delegates</h2> <h3>District 43A</h3> <h4>Vote for up to 2</h4>
     (272 of 295 election day precincts reported)
     <table class="table-banded"> ... <td><div>Regina T. Boyce</div></td><td>Democratic</td>
       <td class="alignRight"> 29,025</td> (early) ... (election day) (mail-in) (provisional)
       <td class="alignRight">98,064</td> (total) <td class="alignRight">83.40%</td>
   Retention: <h3>Dan Friedman<br>Vote Yes or No<br>For continuance in office</h3>, rows Yes and No. Questions:
   <h2>Question A: Bond Issue</h2> with the subject in the hgroup's <p> lines, rows For and Against. The total column
   (second to last) is the count; "NR" (not reported) reads 0. The Totals row is checked against the rows and
   never read as a choice: a contest whose rows don't add up to it is dropped.
   The page's own time is "Last refreshed: 11/03/2026 11:15:15 PM", Eastern. The pages carry no election date, so
   the map names the date that goes with the board's election name (`feed.election_dates`); any other name reads as
   a mismatch. A winner mark (check.gif in a row) is the board's own declaration and rides as `declared`.
   Change token: every page's Last-Modified (each asked If-Modified-Since; all 304 = unchanged). Pages refresh on
   their own clocks, so each contest carries its own page's "Last refreshed" time and the source's is the newest. */
import { get } from '../fetch.js';
import { parseUsTime } from '../util.js';

const text = (h) => String(h || '').replace(/<br\s*\/?>/gi, ' | ').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;|&#039;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const num = (s) => { const t = text(s).replace(/,/g, ''); return t === 'NR' || t === '' ? 0 : Number(t); };

function voteFor(s) {
  const m = String(s || '').match(/Vote for (?:up to )?(\d+)/i);
  return m ? Number(m[1]) : 1;
}

/* One page: its election words, refresh time and contests. */
export function parsePage(html) {
  const h = String(html || '');
  const h1 = text((h.match(/<h1>([\s\S]*?)<\/h1>/) || [])[1]);
  const name = (h1.match(/(\d{4} [A-Za-z ]*?Election)\b/) || [])[1] || null;
  const refreshed = (h.match(/Last refreshed:\s*([^<]+)</) || [])[1]?.trim() || null;
  const contests = [];
  let dropped = 0;
  let office = null, area = null, judge = null, vf = 1, progress = null, subject = null;
  const re = /<h2>([\s\S]*?)<\/h2>|<h3>([\s\S]*?)<\/h3>|<h4>([\s\S]*?)<\/h4>|<div class="bold">([\s\S]*?)<\/div>|\(([\d,]+ of [\d,]+ [a-z ]*?precincts reported)\)|<table class="table-banded">([\s\S]*?)<\/table>/g;
  for (const m of h.matchAll(re)) {
    if (m[1] !== undefined) { const t = text(m[1]); if (!t) continue; office = t; area = null; judge = null; vf = 1; progress = null; subject = null; continue; } // the questions page has empty <h2>s
    if (m[2] !== undefined || m[3] !== undefined) {
      const t = text(m[2] ?? m[3]);
      if (/^Vote for/i.test(t)) { vf = voteFor(t); continue; }
      if (/Vote Yes or No/i.test(t)) { judge = t.split('|')[0].trim(); vf = 1; continue; } // a judge's retention
      area = t; judge = null;
      continue;
    }
    if (m[4] !== undefined) { const t = [...m[4].matchAll(/<p>([\s\S]*?)<\/p>/g)].map((x) => text(x[1])).filter(Boolean).join(' '); if (t && !subject) subject = t; continue; }
    if (m[5] !== undefined) { progress = m[5]; continue; }
    const table = m[6];
    const body = table.slice(table.search(/<\/thead>/) + 8);
    const choices = [];
    const declared = [];
    let printed = null;
    for (const r of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...r[1].matchAll(/<(td|th)([^>]*)>([\s\S]*?)<\/\1>/g)];
      if (!cells.length) continue;
      const nm = text(cells[0][3]);
      const right = cells.filter((c) => /alignRight/.test(c[2]));
      if (right.length < 2) continue;
      const votes = num(right[right.length - 2][3]);
      if (/^Totals$/i.test(nm)) { printed = votes; continue; }
      choices.push({ name: nm, votes });
      if (/check\.gif/i.test(r[1])) declared.push(nm);
    }
    const feed_id = [office, area, judge].filter(Boolean).join(', ');
    const sum = choices.reduce((a, c) => a + (Number.isFinite(c.votes) ? c.votes : 0), 0);
    if (!office || !choices.length || printed === null || printed !== sum) { dropped++; continue; }
    contests.push({
      feed_id,
      feed_name: subject ? `${feed_id} (${subject})` : feed_id,
      category: null,
      vote_for: vf,
      choices,
      total: sum,
      reporting: progress,
      updated: null,
      declared: declared.length ? declared : null,
    });
  }
  return { h1, name, refreshed, contests, dropped };
}

export async function read({ fetch, map, prevToken = null }) {
  const identity = map.feed.identity || 'named';
  const pages = map.feed.pages || [];
  if (!pages.length) return { verdict: 'error', error: 'the map lists no pages' };
  // The token is every page's Last-Modified. A poll asks each page If-Modified-Since; when all answer 304 nothing
  // changed. Otherwise every page that answered 304 is read again in full, so the read holds every page's body.
  let prevMods = null;
  try { prevMods = prevToken ? JSON.parse(prevToken) : null; } catch { prevMods = null; }
  const bodies = {};
  const mods = {};
  for (const page of pages) {
    const url = `${map.feed.base}/${page}`;
    const since = prevMods?.[page];
    const r = await get(fetch, url, { identity, expect: 'html', headers: since ? { 'If-Modified-Since': since } : {} });
    if (r.verdict === 'not_modified') { mods[page] = since; continue; }
    if (r.verdict !== 'ok') return { verdict: r.verdict, error: r.error, status: r.status, url };
    bodies[page] = r.body;
    mods[page] = r.lastModified || '';
  }
  if (!Object.keys(bodies).length) return { verdict: 'ok', unchanged: true, changed_token: prevToken };
  for (const page of pages) {
    if (bodies[page] !== undefined) continue;
    const url = `${map.feed.base}/${page}`;
    const r = await get(fetch, url, { identity, expect: 'html' });
    if (r.verdict !== 'ok') return { verdict: r.verdict === 'not_modified' ? 'error' : r.verdict, error: r.error || 'a full read answered 304', status: r.status, url };
    bodies[page] = r.body;
    mods[page] = r.lastModified || '';
  }
  const contests = [];
  let dropped = 0, name = null, h1 = null;
  const stamps = [];
  for (const page of pages) {
    const p = parsePage(bodies[page]);
    const url = `${map.feed.base}/${page}`;
    if (!p.refreshed) return { verdict: 'error', error: `${page} has no "Last refreshed" time`, url };
    if (name === null) { name = p.name; h1 = p.h1; }
    else if (p.name !== name) return { verdict: 'error', error: `${page} names the election "${p.name}", ${pages[0]} "${name}"`, url };
    // Pages refresh on their own clocks (the questions page was 11:22:47 PM while the others said 11:15:15 PM on
    // Nov 3), so each contest carries its own page's time; the source's time is the newest.
    const at = parseUsTime(p.refreshed, -5);
    if (at) stamps.push(at);
    for (const c of p.contests) contests.push({ ...c, updated: at });
    dropped += p.dropped;
  }
  const token = JSON.stringify(mods);
  if (prevToken && token === prevToken) return { verdict: 'ok', unchanged: true, changed_token: token };
  const date = (map.feed.election_dates || {})[name] || null;
  stamps.sort();
  return {
    verdict: 'ok',
    changed_token: token,
    raw: bodies,
    election: { id: name, name, date },
    source_status: null,
    official: /\bofficial\b/i.test(h1 || '') && !/unofficial/i.test(h1 || ''),
    source_updated: stamps.length ? stamps[stamps.length - 1] : null,
    reporting: map.feed.reporting_contest ? contests.find((c) => c.feed_id === map.feed.reporting_contest)?.reporting ?? null : null,
    labels: /unofficial/i.test(h1 || '') ? ['Unofficial'] : [],
    dropped,
    contests,
  };
}
