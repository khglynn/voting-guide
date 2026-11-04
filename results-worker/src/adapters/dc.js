/* The DC Board of Elections' own results app (electionresults.dcboe.org), which reads an open JSON API.
   `electionResults/getElectionInfo/{url}`: the election's name and date, LastUpdated (the board's own time),
   PrecinctsCounted and TotalPrecincts, ElectionResultsTypeName ("Election Night Unofficial Results"), IsRCV and the
   date ranked-choice rounds post. `cityWide/getCityWide/{url}`: every contest with each contestant's Votes.
   Unchanged polls cost one request (LastUpdated is the token). Two things the feed says that we never take as an
   outcome: `IsWinner` is set on election night even for ranked-choice races whose rounds post Nov 4, and DC
   counts mail ballots that arrive through Nov 13. OVER VOTES and UNDER VOTES lines are listed by the feed but are
   not votes for anyone; maps send them to `__skip` (DC's own percentages leave them out). */
import { get } from '../fetch.js';
import { isoDate } from '../util.js';

export async function read({ fetch, map, prevToken = null }) {
  const identity = map.feed.identity || 'named';
  const key = map.election.feed_election_id;
  const info = await get(fetch, `${map.feed.base}/electionResults/getElectionInfo/${key}`, { identity });
  if (info.verdict !== 'ok') return { verdict: info.verdict, error: info.error, status: info.status, url: info.url };
  const j = info.json || {};
  const token = String(j.LastUpdated || '');
  if (!token) return { verdict: 'error', error: 'getElectionInfo has no LastUpdated', url: info.url };
  if (prevToken && token === prevToken) return { verdict: 'ok', unchanged: true, changed_token: token };
  const cw = await get(fetch, `${map.feed.base}/cityWide/getCityWide/${key}`, { identity });
  if (cw.verdict !== 'ok') return { verdict: cw.verdict, error: cw.error, status: cw.status, url: cw.url };
  if (!Array.isArray(cw.json)) return { verdict: 'error', error: 'getCityWide was not a list of contests', url: cw.url };
  const reporting = Number(j.TotalPrecincts) > 0 ? `${j.PrecinctsCounted} of ${j.TotalPrecincts} precincts counted` : null;
  const contests = cw.json.map((c) => {
    const choices = (c.ElectionData || []).map((x) => ({ name: String(x.Contestant || '').trim(), votes: x.Votes }));
    return { feed_id: String(c.ContestNumber), feed_name: String(c.OfficeName || '').trim(), category: null, vote_for: 1, choices, total: choices.reduce((a, b) => a + (Number(b.votes) || 0), 0), reporting, updated: null, declared: null, is_rcv: !!c.IsRCV };
  });
  return {
    verdict: 'ok',
    changed_token: token,
    raw: { 'getElectionInfo.json': info.body, 'getCityWide.json': cw.body },
    election: { id: key, name: String(j.ElectionNameDisplay || j.ElectionName || '').trim(), date: isoDate(j.ElectionDate) },
    source_status: null,
    official: /certified|official results/i.test(String(j.ElectionResultsTypeName || '')) && !/unofficial/i.test(String(j.ElectionResultsTypeName || '')),
    source_updated: j.LastUpdated ? new Date(j.LastUpdated).toISOString() : null,
    reporting,
    labels: [j.ElectionResultsTypeName, j.IsRCV && j.RCVAvailableDate ? `Ranked-choice rounds available ${j.RCVAvailableDate}` : null].filter(Boolean),
    contests,
  };
}
