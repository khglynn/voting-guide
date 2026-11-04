/* Boulder County's results page (electionresults.bouldercounty.gov): a static copy, served from S3, of the county's
   ASP.NET/Kendo app at election.boco.solutions/ElectionResults2026G/ ("Mirrored from election.boco.solutions ... by
   HTTrack", Nov 3). It is the address the county sends voters to, and S3 answers If-Modified-Since, so an unchanged
   poll is one request answered 304. The copy can lag the app by a few minutes; its printed "Last Updated" is the
   county's own time (Mountain), so the time we show is the time of the numbers we show.
   Each race is <div id="contest{N}"> with its title in the grid's EnrContestTitleHeader cell (a second line after
   <br /> is a subtitle: "(Vote for no more than Five)", a tax question's caption) and its rows as JSON inside the
   grid's kendoGrid({... "data":{"Data":[{ContestID, CandidateNameResults, TotalVotes}, ...]} ...}) call. Choice names
   carry the party as the county prints it ("John Hickenlooper - Democratic"). The ranked-choice mayor's race has no
   rows here, only a link to its own page, so it reads as a race with no choices. The page prints "Total Ballots
   Counted: 113,748" and no precinct line; that count is the source's progress words. Nothing here is an outcome. */
import { get } from '../fetch.js';
import { parseUsTime, isoDate } from '../util.js';

const text = (h) => String(h || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();

/* The JSON object that starts at `start` (an opening brace), by counting braces outside strings. */
function objectAt(s, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

export function parse(html) {
  const updated = (html.match(/EnrHeaderLastUpdatedDateTime">\s*([^<]+?)\s*</) || [])[1] || null;
  const name = text((html.match(/class="EnrHeaderTitle">([\s\S]*?)<\/span>/) || [])[1]);
  const date = isoDate(text((html.match(/class="EnrHeaderDate">([\s\S]*?)<\/span>/) || [])[1]));
  const subtitle = text((html.match(/class="EnrHeaderSubtitle">([\s\S]*?)<\/span>/) || [])[1]);
  const ballots = (html.match(/Total Ballots Counted:\s*<\/td>\s*<td[^>]*>\s*([\d,]+)\s*</) || [])[1] || null;
  const contests = [];
  let bad = 0;
  const parts = html.split(/<div id="contest(\d+)">/);
  for (let i = 1; i < parts.length; i += 2) {
    const id = parts[i];
    const b = parts[i + 1];
    const th = b.match(/EnrContestTitleHeader[^>]*>([\s\S]*?)<\/th>/);
    if (!th) { bad++; continue; }
    const [line1, ...rest] = th[1].split(/<br\s*\/?>/i);
    const sub = text(rest.join(' '));
    const at = b.indexOf('"data":{"Data":');
    let choices = [];
    if (at >= 0) {
      const obj = objectAt(b, at + 7);
      let d = null;
      try { d = obj ? JSON.parse(obj) : null; } catch { d = null; }
      if (!d || !Array.isArray(d.Data)) { bad++; continue; }
      choices = d.Data.filter((x) => String(x.ContestID) === id).map((x) => ({ name: text(x.CandidateNameResults), votes: x.TotalVotes }));
    }
    const voteFor = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 }[(sub.match(/vote for (?:no|not) more than (\w+)/i) || [])[1]?.toLowerCase()] || 1;
    contests.push({ feed_id: id, feed_name: text(line1), category: sub || null, vote_for: voteFor, choices, total: choices.reduce((a, c) => a + (Number(c.votes) || 0), 0), reporting: null, updated: null, declared: null, is_rcv: at < 0 && /Ranked Choice/i.test(b.slice(0, 3000)) });
  }
  return { updated, name, date, subtitle, ballots, contests, bad };
}

export async function read({ fetch, map, prevToken = null }) {
  const identity = map.feed.identity || 'named';
  const url = map.feed.page || `${map.feed.base}/`;
  const lastMod = prevToken ? prevToken.split('|')[0] : null;
  const r = await get(fetch, url, { identity, expect: 'html', headers: lastMod ? { 'If-Modified-Since': lastMod } : {} });
  if (r.verdict === 'not_modified') return { verdict: 'ok', unchanged: true, changed_token: prevToken };
  if (r.verdict !== 'ok') return { verdict: r.verdict, error: r.error, status: r.status, url };
  const p = parse(r.body || '');
  if (!p.updated || !p.contests.length) return { verdict: 'error', error: 'no "Last Updated" time or no races on the page (not the results page?)', url };
  if (p.bad) return { verdict: 'error', error: `${p.bad} race block(s) on the page could not be read`, url };
  const token = `${r.lastModified || ''}|${p.updated}`;
  if (prevToken && token === prevToken) return { verdict: 'ok', unchanged: true, changed_token: token };
  return {
    verdict: 'ok',
    changed_token: token,
    raw: { 'index.html': r.body },
    election: { id: p.name, name: p.name, date: p.date },
    source_status: null,
    official: false,
    source_updated: parseUsTime(p.updated, -7),
    reporting: p.ballots ? `Total Ballots Counted: ${p.ballots}` : null,
    labels: [p.subtitle].filter(Boolean),
    contests: p.contests,
  };
}
