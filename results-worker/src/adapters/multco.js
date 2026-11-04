/* Multnomah County Elections (Portland), from two places the county publishes to, both read by plain GET with our
   named User-Agent (checked Nov 3, 10:20 PM CT):
   1. Its ranked-choice results site, https://rcvresults.multco.us: county chair, commissioner 2, auditor and sheriff,
      and Portland's auditor and council districts 3 and 4. The home page lists each election and, per office, its
      reports newest first ("Preliminary Results 1" on Nov 3; 2024's run "Final Results", "Preliminary Results 8" ...).
      An office's report page (/Reports/{publication}/{Office_Slug}) shows the tabulation time ("November 03, 2026
      06:56:19 PM"), "Published: November 3, 2026 8:00 PM" and a link to the RCTab summary JSON (a signed Azure blob
      link that expires in about half a day, so it is read fresh from the page on every change). We take round 1 of
      that JSON only: first choices, never the later rounds, and never its "elected" line (DESIGN.md rule 7; the items
      carry ranked_choice and never get an outcome). "Uncertified Write In" is an aggregate line.
      The county's schedule: Nov 3 at 8 PM and 10 PM (10 PM skips ranked choice), Nov 4 at midnight and 6 PM, then
      6 PM on Nov 5, 6, 12, 25 and 30.
   2. Its own races as uploaded to the Oregon SOS site (`feed.county_page`, ResultsSW.aspx?type=CTYALL&cty=26): every
      Multnomah race that isn't ranked choice (soil and water districts, water districts, city races, local measures).
      For a race that crosses county lines (Portland's measure 26-267, West Multnomah SWCD) this page holds
      Multnomah's share only; the state source (or_sos) carries the whole count.
   An unchanged poll is two requests: the ranked-choice home page and the SOS header page. */
import { get } from '../fetch.js';
import { isoDate } from '../util.js';
import { header, parsePage } from './or_sos.js';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const unescape = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
const text = (h) => unescape(String(h || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ')).replace(/\s+/g, ' ').trim();

/* "November 3, 2026 8:00 PM" or "November 03, 2026 06:56:19 PM", Pacific (standard time all count window), to ISO. */
export function pacific(s) {
  const m = String(s || '').trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)$/i);
  if (!m) return null;
  const mo = MONTHS.indexOf(m[1].toLowerCase());
  if (mo < 0) return null;
  let h = Number(m[4]) % 12;
  if (m[7].toUpperCase() === 'PM') h += 12;
  return new Date(Date.UTC(Number(m[3]), mo, Number(m[2]), h + 8, Number(m[5]), Number(m[6] || 0))).toISOString();
}

/* The home page: the named election's offices, each with its newest report. */
export function parseIndex(html, electionName) {
  const h = String(html || '');
  const parts = h.split(/<button class="btn btn-toggle align-items-center rounded h5[^"]*"/).slice(1);
  for (const p of parts) {
    const name = text((p.match(/aria-expanded="[^"]*">([\s\S]*?)<\/button>/) || [])[1]);
    if (name !== electionName) continue;
    const offices = [];
    for (const m of p.matchAll(/aria-expanded="[^"]*">\s*([^<]+?)\s*<\/button>\s*<div id="election-\d+-jurisdiction-\d+-office-\d+"[^>]*>\s*<ul[^>]*>\s*<li[^>]*>\s*<a[^>]*href="(\/Reports\/([0-9a-f-]{36})\/([^"]+))"[^>]*>([^<]+)<\/a>/g)) {
      offices.push({ office: text(m[1]), href: unescape(m[2]), publication: m[3], slug: unescape(m[4]), label: text(m[5]) });
    }
    return { name, offices };
  }
  return { name: null, offices: [] };
}

/* An office's report page: the tabulation time, the publish time and the JSON link. */
export function parseReport(html) {
  const h = String(html || '');
  const head = (h.match(/<h1 id="report-title"[^>]*>[\s\S]*?<\/h1>([\s\S]*?)<\/div>/) || [])[1] || '';
  const ps = [...head.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => text(m[1]));
  // Only a paragraph that reads as a time: Portland's pages put a description first ("Consolidated Multnomah County,
  // Washington County, and Clackamas County Election Results"), which the note once quoted as the time (pre-deploy review).
  const tabulated = ps.find((p) => !/^Published/i.test(p) && pacific(p)) || null;
  const published = (ps.find((p) => /^Published:/i.test(p)) || '').replace(/^Published:\s*/i, '') || null;
  const json = (h.match(/href="(https:\/\/[^"]+\.blob\.core\.windows\.net\/[^"]+\.json\?[^"]+)"/) || [])[1] || null;
  return { tabulated, tabulated_at: pacific(tabulated), published, published_at: pacific(published), json: json ? new URL(unescape(json)).href : null };
}

/* Round 1 of an RCTab summary JSON: first choices, as the county counted them. */
export function firstChoices(j) {
  const r1 = (j?.results || []).find((r) => Number(r.round) === 1);
  if (!r1 || !r1.tally) return null;
  return Object.entries(r1.tally).map(([name, v]) => ({ name: String(name).trim(), votes: /^\d+$/.test(String(v).trim()) ? Number(v) : NaN }));
}

export async function read({ fetch, map, prevToken = null }) {
  const identity = map.feed.identity || 'named';
  const home = await get(fetch, `${map.feed.base}/`, { identity, expect: 'html' });
  if (home.verdict !== 'ok') return { verdict: home.verdict, error: home.error, status: home.status, url: home.url };
  const idx = parseIndex(home.body, map.election.feed_election_id);
  const top = map.feed.state_base ? await get(fetch, `${map.feed.state_base}/`, { identity, expect: 'html' }) : null;
  if (top && top.verdict !== 'ok') return { verdict: top.verdict, error: top.error, status: top.status, url: top.url };
  const hd = top ? header(top.body) : null;
  const token = `${idx.offices.map((o) => o.href).join(',')}|${hd ? `${hd.stamp}|${hd.ballots}` : ''}`;
  if (prevToken && token === prevToken) return { verdict: 'ok', unchanged: true, changed_token: token };
  if (!idx.name) return { verdict: 'ok', changed_token: token, raw: { 'index.html': home.body }, election: { id: null, name: '', date: null }, contests: [], official: false, source_status: null, source_updated: null, reporting: null };

  const raw = { 'index.html': home.body };
  const contests = [];
  let latest = null;
  const labels = new Set();
  const skipped = [];
  for (const o of idx.offices) {
    const page = await get(fetch, `${map.feed.base}${o.href}`, { identity, expect: 'html' });
    if (page.verdict !== 'ok') return { verdict: page.verdict, error: page.error, status: page.status, url: page.url };
    const rep = parseReport(page.body);
    // An office with one filed candidate isn't tabulated as ranked choice: its page shows a small table and no JSON,
    // and on Nov 3 that table's "Total votes" (205,507 for County Auditor) didn't equal its own rows (133,298 plus
    // 2,210 write-ins). We don't read a count that disagrees with itself: the office stays a link.
    if (!rep.json && /This is not an RCV contest/i.test(page.body)) { skipped.push(o.office); continue; }
    if (!rep.json) return { verdict: 'error', error: `${o.office}: the report page has no JSON link`, url: page.url };
    const j = await get(fetch, rep.json, { identity });
    if (j.verdict !== 'ok') return { verdict: j.verdict, error: `${o.office}: ${j.error}`, status: j.status, url: rep.json.split('?')[0] };
    raw[`${o.slug}.html`] = page.body;
    raw[`${o.slug}.json`] = j.body;
    // A report for another election (the JSON names its own date) never stands in for this one's.
    if (isoDate(j.json?.config?.date) !== map.election.date) return { verdict: 'error', error: `${o.office}: the report's JSON is dated ${j.json?.config?.date}`, url: rep.json.split('?')[0] };
    const choices = firstChoices(j.json);
    if (!choices) return { verdict: 'error', error: `${o.office}: the report's JSON has no round 1`, url: rep.json.split('?')[0] };
    labels.add(o.label.replace(/\s*\d+$/, ''));
    if (rep.published_at && (!latest || rep.published_at > latest)) latest = rep.published_at;
    contests.push({
      feed_id: `rcv:${o.slug}`,
      feed_name: o.office,
      category: 'ranked choice',
      vote_for: 1,
      choices,
      total: choices.reduce((a, c) => a + (Number.isFinite(c.votes) ? c.votes : 0), 0),
      reporting: null,
      updated: rep.published_at,
      note: `First choices only, from the county's ${o.label}${rep.tabulated_at ? ` (ballots counted to ${rep.tabulated.replace(/^\w+ \d+, \d{4}\s*/, '')})` : ''}.`,
      declared: null,
      is_rcv: true,
    });
  }

  let dropped = 0;
  if (map.feed.county_page && hd) {
    const cp = await get(fetch, `${map.feed.state_base}/${map.feed.county_page}`, { identity, expect: 'html' });
    if (cp.verdict !== 'ok') return { verdict: cp.verdict, error: cp.error, status: cp.status, url: cp.url };
    raw['county_page.html'] = cp.body;
    const p = parsePage(cp.body);
    // The same cached-copy check as or_sos: the county page must carry the update the SOS home page names.
    if (p.date === map.election.date && (p.stamp !== hd.stamp || p.label !== hd.label)) return { verdict: 'error', error: `the SOS county page says ${p.stamp || 'no time'} (${p.label || 'no label'}), the home page ${hd.stamp} (${hd.label || 'no label'}): a cached copy`, url: cp.url };
    // The county's upload counts only while the SOS page says it is this election.
    if (p.date === map.election.date) {
      dropped = p.dropped;
      contests.push(...p.contests);
      if (p.updated && (!latest || p.updated > latest)) latest = p.updated;
      if (p.label) labels.add(p.label);
    } else return { verdict: 'error', error: `the SOS county page is for ${p.name || 'another election'}`, url: cp.url };
  }

  return {
    verdict: 'ok',
    changed_token: token,
    raw,
    election: { id: idx.name, name: idx.name, date: isoDate(idx.name.replace(/\s+General Election$|\s+\w+ Election$/i, '')) },
    source_status: null,
    official: false,
    source_updated: latest,
    reporting: null,
    labels: [...labels],
    dropped,
    skipped,
    contests,
  };
}
