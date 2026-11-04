/* Los Angeles County's own results app (results.lavote.gov, the Registrar-Recorder/County Clerk). The page is a
   jQuery app behind Imperva that reads two JSON files (both answered our named User-Agent on Nov 3, 8:19 PM PT):
   - `ElectionResults/GetCounterData?electionID={id}`: every count as a flat list of
     {ReferenceType, ReferenceID, Value}, plus `TimeStamp` ("11/3/2026 8:17:00 PM", Pacific, no zone named), the
     county's own "Results as of" time. CAND = one candidate's (or YES/NO's) votes, by candidate ID; CFV = the
     contest's votes for anyone, write-ins included; WRTN-01..04 = write-in votes per seat, by contest ID; PRPT =
     precincts reporting (by contest ID, and "" for the county); EBLT and MBLT = ballots counted and vote-by-mail
     ballots, by election ID. CUV, COV and NSEL are under and over votes: votes for no one, never read.
   - `ElectionResults/GetElectionData?electionID={id}`: the election (ID, Date, Title, PrecinctCount, Locked) and its
     ContestGroups, each contest with ID, Title, Type, VoteFor words and Candidates [{ID, Name}]. Its own Votes and
     Winner fields are the October test load (all zero, all false); counts come only from the counter file.
   An unchanged poll is the counter file alone (its TimeStamp and ballot count are the token). The county's text page
   (/text-results/{id}) still showed the Oct 14 zero load at 8:18 PM while the counter file held the 8:17 PM bulletin,
   so it is not a source. California counts for weeks and certifies in December: the county's Winner flags are never
   taken as an outcome, and its maps set no complete marker. While the election isn't Locked the page shows
   "Election night tally in progress"; that is carried as the source's label. LA's own percentages divide by the
   named candidates only; ours divide by every vote in the contest (write-ins mapped `__other`), so a candidate's
   share here can sit a few hundredths below the county's. */
import { get } from '../fetch.js';
import { parseUsTime, isoDate } from '../util.js';

const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
export function voteFor(words) {
  const m = String(words || '').toLowerCase().match(/vote for (?:no more than )?(\w+)/);
  if (!m) return 1;
  return WORDS[m[1]] || Number(m[1]) || 1;
}

/* The counter file's flat list, grouped: candidate votes by candidate ID, everything else by type then reference. */
export function counters(list) {
  const cand = new Map();
  const other = new Map();
  for (const x of list || []) {
    const t = String(x.ReferenceType || '');
    const ref = x.ReferenceID === null || x.ReferenceID === undefined ? '' : String(x.ReferenceID);
    if (t === 'CAND') { cand.set(ref, Number(x.Value)); continue; }
    if (!other.has(t)) other.set(t, new Map());
    other.get(t).set(ref, Number(x.Value));
  }
  return { cand, other, of: (t, ref) => other.get(t)?.get(String(ref)) };
}

export function parse(election, counterFile) {
  const k = counters(counterFile?.Data);
  const anyVotes = [...k.cand.values()].some((v) => v > 0);
  const precinctWords = (n, total) => (Number(total) > 0 && Number.isFinite(n) && !(n === 0 && anyVotes) ? `${n} of ${Number(total)} precincts reporting` : null);
  const writeInTypes = [...k.other.keys()].filter((t) => /^WRTN-\d+$/.test(t));
  const contests = [];
  for (const g of election.ContestGroups || []) {
    for (const c of g.Contests || []) {
      const choices = (c.Candidates || []).map((x) => ({ name: String(x.Name || '').replace(/\s+/g, ' ').trim(), votes: k.cand.has(String(x.ID)) ? k.cand.get(String(x.ID)) : 0 }));
      // One aggregate line for write-ins, present whenever the county keeps a write-in counter for the contest.
      const wi = writeInTypes.map((t) => k.of(t, c.ID)).filter((v) => v !== undefined);
      if (wi.length) choices.push({ name: 'Write-in', votes: wi.reduce((a, b) => a + b, 0) });
      contests.push({
        feed_id: String(c.ID),
        feed_name: String(c.Title || '').replace(/\s+/g, ' ').trim(),
        category: g.Name || null,
        vote_for: voteFor(c.VoteFor),
        choices,
        total: choices.reduce((a, b) => a + (Number(b.votes) || 0), 0),
        reporting: precinctWords(k.of('PRPT', c.ID), c.PrecinctCount),
        updated: null,
        declared: null,
      });
    }
  }
  return {
    contests,
    ballots: k.of('EBLT', election.ID) ?? null,
    mail_ballots: k.of('MBLT', election.ID) ?? null,
    reporting: precinctWords(k.of('PRPT', ''), election.PrecinctCount),
  };
}

export async function read({ fetch, map, prevToken = null }) {
  const identity = map.feed.identity || 'named';
  const id = map.election.feed_election_id;
  const cu = await get(fetch, `${map.feed.base}/ElectionResults/GetCounterData?electionID=${id}`, { identity });
  if (cu.verdict !== 'ok') return { verdict: cu.verdict, error: cu.error, status: cu.status, url: cu.url };
  if (!Array.isArray(cu.json?.Data)) return { verdict: 'error', error: 'GetCounterData has no Data list', url: cu.url };
  const stamp = String(cu.json.TimeStamp || '').trim();
  const eblt = cu.json.Data.find((x) => x.ReferenceType === 'EBLT' && String(x.ReferenceID) === String(id));
  const token = `${stamp}|${eblt ? eblt.Value : ''}|${cu.json.Data.length}`;
  if (prevToken && token === prevToken) return { verdict: 'ok', unchanged: true, changed_token: token };
  const el = await get(fetch, `${map.feed.base}/ElectionResults/GetElectionData?electionID=${id}`, { identity });
  if (el.verdict !== 'ok') return { verdict: el.verdict, error: el.error, status: el.status, url: el.url };
  const e = el.json?.Data;
  if (!e || !Array.isArray(e.ContestGroups)) return { verdict: 'error', error: 'GetElectionData has no ContestGroups', url: el.url };
  const p = parse(e, cu.json);
  return {
    verdict: 'ok',
    changed_token: token,
    raw: { 'GetCounterData.json': cu.body, 'GetElectionData.json': el.body },
    election: { id: e.ID === undefined || e.ID === null ? null : String(e.ID), name: String(e.Title || '').trim(), date: isoDate(e.Date) },
    source_status: e.Locked === true ? 'locked' : null,
    official: false,
    // "11/3/2026 8:17:00 PM" carries no zone; Los Angeles is on Pacific Standard Time from Nov 1, 2026.
    source_updated: parseUsTime(stamp, -8),
    reporting: p.reporting,
    labels: e.Locked === true ? [] : ['Election night tally in progress'],
    ballots_counted: p.ballots,
    contests: p.contests,
  };
}
