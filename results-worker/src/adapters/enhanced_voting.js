/* Enhanced Voting's public results app (an Angular page over an open JSON API). Five of the guide's sources use it on
   Nov 3, 2026: the Georgia SOS (results.sos.ga.gov), DeKalb GA and Sullivan NY (app.enhancedvoting.com), the Washington
   SOS and King County (results.votewa.gov). One shape everywhere, under `{base}` = `.../results/public/api/elections/{jurisdiction}`:
   - `{base}/{election}`: the election record (4 to 7 KB): its name and date, `asOf` (the time the page prints as
     "Last Updated"), `publishVersionId` (moves with each publish), `isOfficialResults`, `isProduction`,
     `precinctReportingStatus` (Fully Reported / Election Night Complete / Partially Reported / Not Reported counts),
     `groupReportingStatus` (per vote group: Election Day, Advance Voting, mail, provisional), `nextUpdateAt`.
   - `{base}/{election}/ballot-items`: every contest (`data`, with `totalRecordCount`), each with its options'
     `voteCount`, `reportingStatus` {reportingUnits, totalUnits, asOf, reportingStatusDetails} and `contestGroupId`.
   One poll reads the election record; only a new `publishVersionId` (or a new `asOf`) fetches the contests, so an
   unchanged poll costs one small request. Times come from the API as UTC ISO; the page itself prints them in the
   viewer's own zone (Sullivan, Nov 3), so the page's clock is never what we read.
   Progress is per contest: Georgia's election record says nothing has reported (`precinctsReporting` null, every vote
   group "not reported") while its contests say 130 of 159 counties (capture, Nov 3, 7:47 PM CT), so the record's own
   progress is only the source-level line and each row quotes its contest's units. What a unit is (counties for the
   state sites, precincts for DeKalb, election districts for Sullivan) comes from the map's `feed.units`.
   `voteFor` is free text: "Vote for 2", but also "Legislative" or "Judicial" (Washington), so only "Vote for N" counts. */
import { get } from '../fetch.js';
import { isoDate } from '../util.js';

const en = (list) => {
  if (!Array.isArray(list) || !list.length) return '';
  const t = list.find((x) => !x.languageId || /^en/i.test(x.languageId)) || list[0];
  return String(t?.text || '').replace(/\s+/g, ' ').trim();
};
const plain = (h) => String(h || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const iso = (s) => (s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null);

/* "Partially Reported 191 of 191 precincts" from the source's own groups (Fully Reported, Election Night Complete,
   Partially Reported), or "130 of 159 counties reporting" where a contest gives only the two counts. No words when the
   contest counts no units, or when votes are in and no unit has reported (the Clarity rule: "0 of 1" beside counted mail
   ballots reads as wrong). "Not Reported" is left out: it is the remainder. */
export function progressWords(rs, units, hasVotes) {
  if (!rs) return null;
  const total = Number(rs.totalUnits || 0);
  const details = (rs.reportingStatusDetails || rs.details || []).filter((g) => !/not-reported/.test(g.reportingStatusClientTextKey || '') && Number(g.value) > 0);
  if (total > 0 && details.length) {
    return details.map((g, i) => `${en(g.groupName)} ${g.value}${i === 0 ? ` of ${total} ${units}` : ''}`).join(', ');
  }
  const n = Number(rs.reportingUnits || 0);
  if (total <= 0) return null;
  if (n === 0 && hasVotes) return null;
  return `${n} of ${total} ${units} reporting`;
}

/* New York's fusion voting (Sullivan, Nov 3): one candidate runs on several party lines and the feed lists each line
   as its own option with the same name ("Bruce A. Blakeman and Todd Hood" on REP, CON and VAF). A candidate's vote is
   every line added together (that is how New York counts and certifies it), so lines with the exact same name become
   one choice whose `lines` keep each party's count. This adds one person's own lines, never two counties' slices. A
   line whose count isn't a whole number is passed through as is, so the read's number check refuses it. */
export const FUSION_NOTE = 'This race lists each candidate once per party line; the number here adds a candidate\'s lines together, as New York counts them.';
export function combineLines(opts) {
  const byName = new Map();
  for (const o of opts) {
    const name = en(o.name);
    const line = { party: o.party?.abbreviation || null, votes: o.voteCount };
    const had = byName.get(name);
    if (!had) { byName.set(name, { name, votes: o.voteCount, _lines: [line] }); continue; }
    had._lines.push(line);
    const ok = had._lines.every((l) => Number.isInteger(l.votes) && l.votes >= 0);
    had.votes = ok ? had._lines.reduce((a, l) => a + l.votes, 0) : had._lines.find((l) => !(Number.isInteger(l.votes) && l.votes >= 0)).votes;
  }
  return [...byName.values()].map(({ _lines, ...c }) => (_lines.length > 1 ? { ...c, lines: _lines } : c));
}

export function parseContests(items, { units = 'reporting units', groups = {} } = {}) {
  return items.map((c) => {
    const opts = c.summaryResults?.ballotOptions || [];
    const choices = combineLines(opts);
    const fused = choices.some((x) => x.lines);
    const hasVotes = choices.some((x) => Number(x.votes) > 0);
    const vf = en(c.voteFor).match(/vote for (\d+)/i);
    const winners = opts.filter((o) => o.isWinner === true).map((o) => en(o.name));
    return {
      feed_id: String(c.id),
      feed_name: en(c.name),
      category: groups[c.contestGroupId] || c.parentJurisdictionName || null,
      vote_for: vf ? Number(vf[1]) : 1,
      choices,
      total: choices.reduce((a, b) => a + (Number(b.votes) || 0), 0),
      reporting: progressWords(c.reportingStatus, units, hasVotes),
      precincts: c.reportingStatus ? { reported: Number(c.reportingStatus.reportingUnits || 0), total: Number(c.reportingStatus.totalUnits || 0) } : null,
      is_rcv: !!c.rankedChoiceSummaryResults,
      is_measure: c.contestType === 'BallotMeasure',
      updated: iso(c.reportingStatus?.asOf),
      declared: winners.length ? [...new Set(winners)] : null,
      ...(fused ? { note: FUSION_NOTE } : {}),
    };
  });
}

/* The source's own words for the whole election: "Unofficial Results" while `isOfficialResults` is false (the app
   prints it in capitals from that flag; DeKalb and Sullivan pages, Nov 3), "Election Night Complete" once every vote
   group says so, and a short public message when the office posts one. */
function labels(e) {
  const out = [];
  if (e.isOfficialResults === false) out.push('Unofficial Results');
  const groups = e.groupReportingStatus || [];
  if (groups.length && groups.every((g) => /election-night-complete/.test(g.reportingStatusClientTextKey || ''))) out.push('Election Night Complete');
  for (const m of e.customPublicMessages || []) { const t = plain(en(m.text)); if (t && t.length <= 200 && !out.includes(t)) out.push(t); }
  return out;
}

export async function read({ fetch, map, prevToken = null }) {
  const identity = map.feed.identity || 'named';
  const root = `${map.feed.base}/${map.election.feed_election_id}`;
  const s = await get(fetch, root, { identity });
  if (s.verdict !== 'ok') return { verdict: s.verdict, error: s.error, status: s.status, url: s.url };
  const e = s.json || {};
  if (!e.publishVersionId && !e.asOf) return { verdict: 'error', error: 'the election record has no publishVersionId or asOf', url: s.url };
  if (e.isProduction === false) return { verdict: 'error', error: 'the election record says isProduction false (test data)', url: s.url };
  const token = `${e.publishVersionId || ''}|${e.asOf || ''}`;
  if (prevToken && token === prevToken) return { verdict: 'ok', unchanged: true, changed_token: token };

  const b = await get(fetch, `${root}/ballot-items`, { identity });
  if (b.verdict !== 'ok') return { verdict: b.verdict, error: b.error, status: b.status, url: b.url };
  const data = b.json?.data;
  if (!Array.isArray(data)) return { verdict: 'error', error: 'ballot-items had no list of contests', url: b.url };
  // A paged or short answer would drop contests silently; read nothing rather than part of the ballot.
  if (Number.isInteger(b.json.totalRecordCount) && data.length < b.json.totalRecordCount) return { verdict: 'error', error: `ballot-items held ${data.length} of ${b.json.totalRecordCount} contests`, url: b.url };
  const ids = [...new Set(data.map((c) => c.publishPublicElectionId).filter(Boolean))];

  // The record and ballot-items are cached apart (max-age 60 each, King and GA, Nov 3), so for up to a minute after a
  // publish the record can name it while ballot-items still serves the one before. Contests older than the record are
  // read but their token isn't kept, so the next poll reads again in full, and the source's time is the contests' own
  // (pre-deploy review, Nov 3; King publishes once a day after tonight, so a kept token could freeze it a day).
  const newest = data.map((c) => iso(c.reportingStatus?.asOf)).filter(Boolean).sort().pop() || null;
  const behind = !!(newest && iso(e.asOf) && newest < iso(e.asOf));
  const groups = Object.fromEntries((e.contestGroups || []).map((g) => [g.id, en(g.groupHeading)]));
  const units = map.feed.units || 'reporting units';
  const top = { totalUnits: (e.precinctReportingStatus || []).reduce((a, g) => a + (Number(g.value) || 0), 0), reportingStatusDetails: e.precinctReportingStatus || [] };
  return {
    verdict: 'ok',
    changed_token: behind ? null : token,
    raw: { 'election.json': s.body, 'ballot-items.json': b.body },
    // The public election id is the one in the address; every contest names it too, and they must agree.
    election: { id: ids.length === 1 ? ids[0] : ids.length ? ids.join(',') : String(map.election.feed_election_id), name: en(e.name), date: isoDate(e.electionDate) },
    source_status: null,
    // Never official from a record newer than the contests read under it: official stops the source for good, and
    // the counts would be the cached copy's (Codex, Nov 3). The next poll reads in full; once both agree it stands.
    official: e.isOfficialResults === true && !behind,
    source_updated: behind ? newest : (iso(e.asOf) || iso(e.lastUpdated)),
    reporting: progressWords(top, units, Number(e.ballotsCast) > 0),
    labels: labels(e),
    feed_version: e.publishVersionId || null,
    next_update: iso(e.nextUpdateAt?.time ?? e.nextUpdateAt),
    contests: parseContests(data, { units, groups }),
  };
}
