/* The Pennsylvania Department of State's results app (www.electionreturns.pa.gov; the bare host redirects to www, and
   redirects are never followed, so maps name www). An AngularJS page over an open JSON API under /api/, found in its
   Scripts/AppScripts/Service.js on Nov 3 (capture round 1). Every body is a JSON string that holds JSON, so it is parsed
   twice. The method names matter: a wrong `methodName` answers an empty string, which reads as an error here.
     /api/Reports/GetElectionList: the election list (`Electionid` 117 is both the May primary, type P, and the
       Nov 3 general, type G, so the map names both), with its name, date and `ElectionStatus` ("U" on Nov 3).
     /api/ElectionReturn/GetDashboardMessage: the statewide progress words, "3,733 Out of 9,065 Districts (41.18%)
       - IN PERSON BALLOT REPORTING ONLY" at 10:20 PM CT (mail votes were already in; the words are quoted as given).
     /api/ElectionReturn/GET?methodName=GetSummaryData: the statewide races (Governor only in 2026).
     /api/ElectionReturn/GetOfficeData?officeId=N&methodName=GetOfficeDetails: one call per office id the map lists
       (11 U.S. House, 12 State Senate, 13 State House), every district with its candidates.
   The feed has no clock time (GetUpdatedTimeStamp answered an empty string on Nov 3), so `source_updated` stays null and
   the file's freshness is our own fetch time. The statewide progress line rides only on the source and on statewide
   races: a district race never carries the state's district count as its own. `ElectionStatus` "U" is shown as the
   page's own "Unofficial Results"; no other status letter is taken as official, since nothing on the page says which
   letter means certified. Nothing here is an outcome. */
import { get } from '../fetch.js';
import { isoDate, sha256 } from '../util.js';

/* The body is JSON text whose value is itself JSON text (or, sometimes, already an object). */
export function unwrap(r) {
  let v = r.json;
  if (typeof v === 'string') {
    if (!v.trim()) return { error: 'the feed answered an empty string (a wrong method name, or no data yet)' };
    try { v = JSON.parse(v); } catch { return { error: 'the feed held a string that was not JSON' }; }
  }
  return { value: v };
}

const n = (x) => Number(String(x ?? '').replace(/,/g, '').trim());
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function choicesOf(cands) {
  const list = cands || [];
  // A retention race lists one person with YesVotes and NoVotes; anything else lists people with Votes.
  if (list.length && list.every((c) => String(c.IsRetention) === '1')) {
    const c = list[0];
    return [{ name: 'Yes', votes: n(c.YesVotes) }, { name: 'No', votes: n(c.NoVotes) }];
  }
  return list.map((c) => ({ name: clean(c.CandidateName), party: clean(c.PartyName) || null, votes: n(c.Votes) }));
}

/* Every race in a GetSummaryData or GetOfficeDetails body: { Election: { "<office>": [ { "<district>$$id$$": [ {
   DistrictId, District, Candidates } ] } ] } }, except the summary's statewide races, which put the candidates in
   `Statewide` on the office's own entry. */
export function contestsOf(body, officeKey, statewideReporting) {
  const out = [];
  for (const [office, arr] of Object.entries(body?.Election || {})) {
    for (const blk of arr || []) {
      if (Array.isArray(blk.Statewide)) {
        const choices = choicesOf(blk.Statewide);
        out.push({ feed_id: `${blk.OfficeId || officeKey}:${blk.DistrictId || '1'}`, feed_name: clean(office), category: 'statewide', vote_for: 1, choices, total: choices.reduce((a, c) => a + (Number.isFinite(c.votes) ? c.votes : 0), 0), reporting: statewideReporting, updated: null, declared: null });
        continue;
      }
      for (const [, districts] of Object.entries(blk)) {
        if (!Array.isArray(districts)) continue;
        for (const d of districts) {
          const choices = choicesOf(d.Candidates);
          out.push({ feed_id: `${officeKey}:${d.DistrictId}`, feed_name: `${clean(office)}, ${clean(d.District)}`, category: clean(office), vote_for: 1, choices, total: choices.reduce((a, c) => a + (Number.isFinite(c.votes) ? c.votes : 0), 0), reporting: null, updated: null, declared: null });
        }
      }
    }
  }
  return out;
}

export async function read({ fetch, map, prevToken = null }) {
  const identity = map.feed.identity || 'named';
  const api = `${map.feed.base}/api`;
  const eid = map.election.feed_election_id;
  const type = map.feed.election_type || 'G';
  const q = `electionid=${encodeURIComponent(eid)}&electiontype=${encodeURIComponent(type)}&isactive=1`;
  const urls = {
    list: `${api}/Reports/GetElectionList`,
    dash: `${api}/ElectionReturn/GetDashboardMessage?countyName=&methodName=GetDashboardMessage&${q}`,
    summary: `${api}/ElectionReturn/GET?methodName=GetSummaryData&${q}`,
  };
  for (const o of map.feed.offices || []) urls[`office${o}`] = `${api}/ElectionReturn/GetOfficeData?officeId=${encodeURIComponent(o)}&methodName=GetOfficeDetails&${q}`;
  const keys = Object.keys(urls);
  const got = await Promise.all(keys.map((k) => get(fetch, urls[k], { identity })));
  const res = {};
  for (let i = 0; i < keys.length; i++) {
    const r = got[i];
    if (r.verdict !== 'ok') return { verdict: r.verdict, error: r.error, status: r.status, url: r.url };
    const u = unwrap(r);
    if (u.error) return { verdict: 'error', error: `${keys[i]}: ${u.error}`, url: r.url };
    res[keys[i]] = { body: r.body, value: u.value };
  }

  const el = (res.list.value?.Table || []).find((e) => String(e.Electionid) === String(eid) && String(e.ElectionType) === type);
  if (!el) return { verdict: 'error', error: `the election list has no election ${eid}, type ${type}`, url: urls.list };
  const dashWords = clean(res.dash.value?.DistrictMessage) || null;

  const contests = contestsOf(res.summary.value, 'summary', dashWords);
  for (const o of map.feed.offices || []) contests.push(...contestsOf(res[`office${o}`].value, String(o), null));
  if (!contests.length) return { verdict: 'error', error: 'no races in the summary or office data', url: urls.summary };

  // No clock time to compare, so the token is the content itself: a read whose bytes match the last one is unchanged.
  const token = (await sha256(keys.filter((k) => k !== 'list').map((k) => res[k].body).join('\n'))).slice(0, 16) + `|${el.BallotsCounted ?? ''}`;
  if (prevToken && token === prevToken) return { verdict: 'ok', unchanged: true, changed_token: token };
  const raw = {};
  for (const k of keys) raw[`${k}.json`] = res[k].body;
  return {
    verdict: 'ok',
    changed_token: token,
    raw,
    election: { id: String(el.Electionid), name: clean(el.ElectionName), date: isoDate(el.ElectionDate) },
    source_status: null,
    official: false,
    source_updated: null,
    reporting: dashWords,
    labels: String(el.ElectionStatus) === 'U' ? ['Unofficial Results'] : [],
    contests,
  };
}
