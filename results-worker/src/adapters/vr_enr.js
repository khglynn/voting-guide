/* VR Systems election-night pages on enr.electionsfl.org (Escambia County, FL; other Florida counties use the same
   vendor). `{base}/Summary/` is a static page on S3 behind CloudFront, rebuilt by the county at each update, with
   Last-Modified, so an unchanged poll is one conditional request answered 304. Server-rendered, one block per race:
     <div id="61251" class="Race row"> ... <label>Pensacola City Council District 2</label>
       Participating Precincts Reporting: <span class="numPrecinctsReported">2</span> / <span ...Participating">2</span>
       <div class="ChoiceColumn col-xs-4"> Charles Bare (NON) </div> ... <div class="ResultsColumn ...">1,122</div>
   The div id is the feed id. The page's own words: "<h1>2026 General Election</h1>", "Election Date: 11/3/2026",
   "(Website last updated at: 11/03/2026 8:22:57 pm)" in the county's local time (the map's `utc_offset`),
   "Precincts Reporting: 80 / 80", each vote type's state ("Election Day: Completely Reported", "Vote By Mail:
   Partially Reported") and the banner "Unofficial Results". A race's progress words are its precinct counter plus any
   vote type the county hasn't finished, so "80 of 80" never reads as done while mail ballots are still coming in.
   A count shown as a dash (the registry's note: a count under 30) isn't a number; checkRead refuses such a read and
   the last good one stays. */
import { get } from '../fetch.js';
import { parseUsTime, isoDate } from '../util.js';

const text = (h) => String(h || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#37;/g, '%').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const count = (s) => { const t = text(s).replace(/,/g, ''); return /^\d+$/.test(t) ? Number(t) : NaN; };

export function parse(html, utcOffset = -5) {
  const h = String(html || '');
  const name = text((h.match(/id="ElectionName">\s*<h1>([\s\S]*?)<\/h1>/) || [])[1]) || null;
  const date = (h.match(/Election Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/) || [])[1] || null;
  const stamp = (h.match(/Website last updated at:\s*(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?\s*[ap]m)/i) || [])[1] || null;
  const s0 = h.indexOf('id="BottomStats"');
  const s1 = h.indexOf('id="BottomMessage"');
  const stats = s0 >= 0 ? text(h.slice(s0, s1 > s0 ? s1 : s0 + 6000)) : '';
  const top = stats.match(/Precincts Reporting:\s*(\d+)\s*\/\s*(\d+)/);
  // The election's own id, from the page's links to itself ("/ESC/3977/Precincts"), never from the map.
  const pageId = (h.match(/href="\/[A-Z]{3}\/(\d+)\/(?:Precincts|Summary)/) || [])[1] || null;
  const voteTypes = [...stats.matchAll(/(Election Day|Early Votes|Vote By Mail|Provisional[A-Za-z ]*):\s*(Completely Reported|Partially Reported|Not Reported)/g)].map((m) => ({ type: m[1], state: m[2] }));
  const unfinished = voteTypes.filter((v) => v.state !== 'Completely Reported').map((v) => `${v.type}: ${v.state}`);
  const banner = text((h.match(/id="BottomMessage">([\s\S]*?)<\/div>/) || [])[1]) || null;

  const contests = [];
  const parts = h.split(/<div id="(\d+)" class="Race row">/);
  for (let i = 1; i < parts.length; i += 2) {
    const id = parts[i];
    const body = parts[i + 1];
    const raceName = text((body.match(/<label>([\s\S]*?)<\/label>/) || [])[1]);
    const pr = body.match(/numPrecinctsReported">(\d+)<\/span>\s*\/\s*<span[^>]*numPrecinctsParticipating">(\d+)/);
    const choices = [...body.matchAll(/<div class="ChoiceColumn col-xs-4">([\s\S]*?)<\/div>[\s\S]*?<div class="ResultsColumn notranslate col-xs-2"[^>]*>[^<]*<\/div>\s*<div class="ResultsColumn notranslate col-xs-2"[^>]*>([^<]*)<\/div>/g)]
      .map((m) => ({ name: text(m[1]), votes: count(m[2]) }));
    const precincts = pr ? `${pr[1]} of ${pr[2]} precincts reporting` : null;
    contests.push({
      feed_id: id, feed_name: raceName, category: null, vote_for: 1, choices,
      total: choices.reduce((a, c) => a + (Number.isFinite(c.votes) ? c.votes : 0), 0),
      reporting: precincts ? [precincts, ...unfinished].join(' · ') : null,
      precincts: pr ? { reported: Number(pr[1]), total: Number(pr[2]) } : null,
      updated: null, declared: null,
    });
  }
  return {
    id: pageId, name, date: isoDate(date), updated: parseUsTime(stamp, utcOffset), stamp,
    reporting: top ? [`${top[1]} of ${top[2]} precincts reporting`, ...unfinished].join(' · ') : null,
    voteTypes, labels: banner ? [banner] : [], contests,
  };
}

export async function read({ fetch, map, prevToken = null }) {
  const identity = map.feed.identity || 'named';
  const url = `${map.feed.base}/Summary/`;
  const lastMod = prevToken ? prevToken.split('|')[0] : null;
  const r = await get(fetch, url, { identity, expect: 'html', headers: lastMod ? { 'If-Modified-Since': lastMod } : {} });
  if (r.verdict === 'not_modified') return { verdict: 'ok', unchanged: true, changed_token: prevToken };
  if (r.verdict !== 'ok') return { verdict: r.verdict, error: r.error, status: r.status, url };
  if (/404 Material Not Found/.test(r.body || '')) return { verdict: 'error', error: 'the county page says 404 Material Not Found', url };
  const p = parse(r.body, map.feed.utc_offset ?? -5);
  if (!p.contests.length) return { verdict: 'error', error: 'no race on the page', url };
  const token = `${r.lastModified || ''}|${p.stamp || ''}`;
  if (prevToken && token === prevToken) return { verdict: 'ok', unchanged: true, changed_token: token };
  return {
    verdict: 'ok',
    changed_token: token,
    raw: { 'Summary.html': r.body },
    election: { id: p.id, name: p.name, date: p.date },
    source_status: null,
    official: false,
    source_updated: p.updated,
    reporting: p.reporting,
    labels: p.labels,
    contests: p.contests,
  };
}
