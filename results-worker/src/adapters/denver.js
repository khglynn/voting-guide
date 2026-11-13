/* Denver's own results app (denvergov.org/electionresults): the page is an empty Durandal/Knockout shell, and its
   JavaScript reads two open JSON endpoints on the same host (capture round 1, Nov 3):
     Home/GetElectionHeaderinfo: a list of {Key, Value} pairs, with ElectionTitle ("2026 General Election"),
       ElectionDate ("November 03 2026"), ElectionId ("20261103") and LastUpdate ("Results as of 8:30 PM on
       11/03/2026", Denver's own time, Mountain). LastUpdate is the change token, so an unchanged poll is one request.
     api/Election?ElectionId={id}: Races and Results (RaceID, RaceTitle, CandidateVotes [{CandidateName, Votes}],
       TotalVotes, UnderVotes, OverVotes). Under and over votes are listed apart from the candidates and are not votes
       for anyone, so they are left out, as Denver's own percentages leave them out.
   The feed gives no precinct or ballot progress line and no "unofficial" label (Nov 3), so none is shown. A
   CandidateVotes `ClassName` of "Winning" marks the current leader on Denver's page and is never taken as an outcome. */
import { get } from '../fetch.js';
import { parseUsTime, isoDate } from '../util.js';

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export function header(list) {
  const h = {};
  for (const kv of Array.isArray(list) ? list : []) if (kv && typeof kv.Key === 'string') h[kv.Key] = kv.Value;
  return h;
}

/* "Results as of 8:30 PM on 11/03/2026" to ISO UTC, Mountain (MST on Nov 3, -7) unless a zone is named. */
export function lastUpdate(s, offset = -7) {
  const m = String(s || '').match(/(\d{1,2}:\d{2}(?::\d{2})?\s*[AP]M)\s+on\s+(\d{1,2}\/\d{1,2}\/\d{4})/i);
  return m ? parseUsTime(`${m[2]} ${m[1]}`, offset) : null;
}

export async function read({ fetch, map, prevToken = null }) {
  const identity = map.feed.identity || 'named';
  const hdr = await get(fetch, `${map.feed.base}/Home/GetElectionHeaderinfo`, { identity });
  if (hdr.verdict !== 'ok') return { verdict: hdr.verdict, error: hdr.error, status: hdr.status, url: hdr.url };
  const h = header(hdr.json);
  const token = clean(h.LastUpdate);
  if (!token) return { verdict: 'error', error: 'GetElectionHeaderinfo has no LastUpdate', url: hdr.url };
  if (String(h.ElectionId) !== String(map.election.feed_election_id)) return { verdict: 'error', error: `the header is for election ${h.ElectionId}, the map's is ${map.election.feed_election_id}`, url: hdr.url };
  if (prevToken && token === prevToken) return { verdict: 'ok', unchanged: true, changed_token: token };
  const el = await get(fetch, `${map.feed.base}/api/Election?ElectionId=${encodeURIComponent(map.election.feed_election_id)}`, { identity });
  if (el.verdict !== 'ok') return { verdict: el.verdict, error: el.error, status: el.status, url: el.url };
  if (!Array.isArray(el.json?.Results)) return { verdict: 'error', error: 'api/Election had no Results list', url: el.url };
  const contests = el.json.Results.map((r) => {
    const choices = (r.CandidateVotes || []).map((c) => ({ name: clean(c.CandidateName), votes: c.Votes }));
    return { feed_id: String(r.RaceID), feed_name: clean(r.RaceTitle), category: null, vote_for: 1, choices, total: choices.reduce((a, c) => a + (Number(c.votes) || 0), 0), source_total: r.TotalVotes ?? null, reporting: null, updated: null, declared: null };
  });
  return {
    verdict: 'ok',
    changed_token: token,
    raw: { 'GetElectionHeaderinfo.json': hdr.body, 'Election.json': el.body },
    election: { id: String(h.ElectionId), name: clean(h.ElectionTitle), date: isoDate(clean(h.ElectionDate)) },
    source_status: null,
    official: false,
    source_updated: lastUpdate(token),
    reporting: null,
    labels: [],
    contests,
  };
}
