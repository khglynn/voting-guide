/* The California Secretary of State's election-night JSON feed (api.sos.ca.gov), the documented developer feed behind
   electionresults.sos.ca.gov ("Election Night Data-Feed Guide" v19, https://cms.cdn.sos.ca.gov/media/3-api-documentation-v19.pdf;
   endpoint list for this election at https://media.sos.ca.gov/media/api-endpoints.csv). The results site itself sits
   behind an Incapsula bot check that our named fetcher doesn't pass (Nov 3, 8:18 PM PT), so we never read it; the
   feed answered the same named fetcher with plain JSON.
   A map lists `feed.paths` under `{base}/returns/`. The first is the change token: a `query?r=[...]` of up to ten
   contest ids (the SOS's maximum). Every race object has `raceTitle`, `Reporting` ("23.8% (5,688 of 23,860) precincts
   reporting", the race's own progress words) and `ReportingTime` ("November 3, 2026, 8:15 p.m.", Pacific), then either
   `candidates` [{Name, Votes}] or a list of yes/no entries (`ballot-measures` [{Number, Name, yesVotes, noVotes}],
   `supreme-court` [{Name, yesVotes, noVotes}]). Votes come as strings, some with commas.
   Feed ids are built from the feed's own words, never from response order: a candidate race's raceTitle, a measure's
   "Proposition {Number}", a retention's "{raceTitle}: {Name}".
   The feed names no election. Its identity is the ballot itself: a read confirms the Nov 3, 2026 election only when
   its ballot measures carry exactly the numbers the map expects (`feed.expect_props`); otherwise the date reads as
   missing and the source turns into links. An unchanged poll costs one request (the token query's ReportingTime and
   Reporting line). */
import { get } from '../fetch.js';
import { parseUsTime } from '../util.js';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const count = (s) => { const t = String(s ?? '').replace(/,/g, '').trim(); return /^\d+$/.test(t) ? Number(t) : NaN; };
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/* "November 3, 2026, 8:15 p.m." (also "noon" and "midnight") to ISO UTC. California is on PST for the whole count
   (DST ended Nov 1, 2026), so the fallback offset is -8. Unreadable gives null, never a guess. */
export function parseSosTime(s) {
  const t = clean(s).toLowerCase();
  const m = t.match(/^([a-z]+)\.? (\d{1,2}), (\d{4}),? (?:(\d{1,2}):(\d{2}) ?([ap])\.?m\.?|(noon|midnight))$/);
  if (!m) return null;
  const mo = MONTHS.findIndex((x) => x.startsWith(m[1]) && m[1].length >= 3) + 1;
  if (!mo) return null;
  let hh, mm, ap;
  if (m[7]) { hh = 12; mm = '00'; ap = m[7] === 'noon' ? 'PM' : 'AM'; } else { hh = Number(m[4]); mm = m[5]; ap = m[6] === 'p' ? 'PM' : 'AM'; }
  return parseUsTime(`${mo}/${m[2]}/${m[3]} ${hh}:${mm} ${ap}`, -8);
}

/* One race object to one or more contests. */
export function contestsOf(race) {
  const title = clean(race.raceTitle);
  const reporting = clean(race.Reporting) || null;
  const base = { category: null, vote_for: 1, reporting, updated: null, declared: null };
  if (Array.isArray(race.candidates)) {
    const choices = race.candidates.map((c) => ({ name: clean(c.Name), votes: count(c.Votes) }));
    return [{ feed_id: title, feed_name: title, ...base, choices, total: choices.reduce((a, c) => a + (Number.isFinite(c.votes) ? c.votes : 0), 0) }];
  }
  const out = [];
  for (const [k, v] of Object.entries(race)) {
    if (!Array.isArray(v)) continue;
    for (const e of v) {
      if (!('yesVotes' in e)) continue;
      const name = e.Number ? `Proposition ${clean(e.Number)}` : `${title}: ${clean(e.Name)}`;
      const choices = [{ name: 'Yes', votes: count(e.yesVotes) }, { name: 'No', votes: count(e.noVotes) }];
      out.push({ feed_id: name, feed_name: e.Number ? `${name}: ${clean(e.Name)}` : name, ...base, kind_hint: k, number: e.Number ? clean(e.Number) : null, choices, total: choices.reduce((a, c) => a + (Number.isFinite(c.votes) ? c.votes : 0), 0) });
    }
  }
  return out;
}

export async function read({ fetch, map, prevToken = null }) {
  const identity = map.feed.identity || 'named';
  const paths = map.feed.paths || [];
  if (!paths.length) return { verdict: 'error', error: 'the map lists no feed paths' };
  // A path's query values are written readably in the map (query?r=["02000000000059",...]) and encoded here.
  const url = (p) => {
    const [path, q] = String(p).split('?');
    if (!q) return `${map.feed.base}/returns/${path}`;
    const qs = q.split('&').map((kv) => { const i = kv.indexOf('='); return i < 0 ? kv : `${kv.slice(0, i)}=${encodeURIComponent(kv.slice(i + 1))}`; }).join('&');
    return `${map.feed.base}/returns/${path}?${qs}`;
  };
  const first = await get(fetch, url(paths[0]), { identity });
  if (first.verdict !== 'ok') return { verdict: first.verdict, error: first.error, status: first.status, url: first.url };
  const firstRaces = Array.isArray(first.json) ? first.json : [first.json];
  const lead = firstRaces[0] || {};
  if (!lead.raceTitle || !lead.ReportingTime) return { verdict: 'error', error: 'the first feed answer had no raceTitle or ReportingTime', url: first.url };
  const token = `${clean(lead.ReportingTime)}|${clean(lead.Reporting)}`;
  if (prevToken && token === prevToken) return { verdict: 'ok', unchanged: true, changed_token: token };
  const raw = { [`${paths[0]}.json`]: first.body };
  const races = [...firstRaces];
  for (const p of paths.slice(1)) {
    const r = await get(fetch, url(p), { identity });
    if (r.verdict !== 'ok') return { verdict: r.verdict, error: r.error, status: r.status, url: r.url };
    raw[`${p}.json`] = r.body;
    races.push(...(Array.isArray(r.json) ? r.json : [r.json]));
  }
  if (races.some((x) => !x || typeof x !== 'object' || !x.raceTitle)) return { verdict: 'error', error: 'a feed answer held something other than races', url: map.feed.base };
  const contests = races.flatMap(contestsOf);
  const seen = new Set();
  for (const c of contests) { if (seen.has(c.feed_id)) return { verdict: 'error', error: `the feed lists "${c.feed_id}" twice`, url: map.feed.base }; seen.add(c.feed_id); }
  const props = contests.filter((c) => c.number).map((c) => c.number).sort();
  const want = [...(map.feed.expect_props || [])].sort();
  const confirmed = want.length > 0 && props.length === want.length && props.every((n, i) => n === want[i]);
  return {
    verdict: 'ok',
    changed_token: token,
    raw,
    election: { id: map.election.feed_election_id ?? null, name: null, date: confirmed ? map.election.date : null },
    source_status: null,
    official: false,
    source_updated: parseSosTime(lead.ReportingTime),
    reporting: clean(lead.Reporting) || null,
    labels: Array.isArray(map.feed.labels) ? map.feed.labels : [],
    contests: contests.map(({ number, kind_hint, ...c }) => c),
  };
}
