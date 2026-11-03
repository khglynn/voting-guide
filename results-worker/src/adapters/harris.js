/* Harris County's own results app (app.harrisvotes.com), which reads static JSON from appfiles.harrisvotes.com.
   One file holds everything: `{base}/{code}/resultsbyballot.json`, with `dt` (the county's own update time), `o`
   (1 once official), `vc`/`vt` (vote centers reported and total) and `contests` (`i` id, `t` title, `ca` choice names,
   `tv` total votes, `pr`/`tp` precincts). The plan guessed `pr.json` held `dt` and `o`; it doesn't (checked Nov 3, 3:10 PM
   CT: pr.json is per-precinct turnout). The file is cached 60 s and sends Last-Modified, so an unchanged poll is one
   conditional request answered 304. */
import { get } from '../fetch.js';
import { isoDate } from '../util.js';

export async function read({ fetch, map, prevToken = null }) {
  const identity = map.feed.identity || 'named';
  const url = `${map.feed.base}/${map.election.feed_election_id}/resultsbyballot.json`;
  const lastMod = prevToken ? prevToken.split('|')[0] : null;
  const r = await get(fetch, url, { identity, headers: lastMod ? { 'If-Modified-Since': lastMod } : {} });
  if (r.verdict === 'not_modified') return { verdict: 'ok', unchanged: true, changed_token: prevToken };
  if (r.verdict !== 'ok') return { verdict: r.verdict, error: r.error, status: r.status, url: r.url };
  const j = r.json || {};
  if (!Array.isArray(j.contests)) return { verdict: 'error', error: 'resultsbyballot.json had no contests list', url };
  const token = `${r.lastModified || ''}|${j.dt || ''}`;
  if (prevToken && token === prevToken) return { verdict: 'ok', unchanged: true, changed_token: token };
  const contests = j.contests.map((c) => ({
    feed_id: String(c.i),
    feed_name: String(c.t || '').trim(),
    category: null,
    vote_for: Number(c.vf) > 0 ? Number(c.vf) : null,
    choices: (c.ca || []).map((n, k) => ({ name: String(n).trim(), votes: (c.tv || [])[k] })),
    total: (c.tv || []).reduce((a, b) => a + (Number(b) || 0), 0),
    source_pct: (c.pct || []).map((p) => Number(String(p).replace('%', ''))),
    reporting: Number(c.tp) > 0 ? `${c.pr} of ${c.tp} precincts reporting` : null,
    precincts: { reported: Number(c.pr || 0), total: Number(c.tp || 0) },
    is_rcv: false,
    updated: null,
    declared: null,
  }));
  return {
    verdict: 'ok',
    changed_token: token,
    raw: { 'resultsbyballot.json': r.body },
    election: { id: String(j.ec ?? ''), name: String(j.et || '').trim(), date: isoDate(j.edt) },
    source_status: null,
    official: Number(j.o) === 1,
    source_updated: j.dt ? new Date(j.dt).toISOString() : null,
    reporting: Number(j.vt) > 0 ? `${j.vc} of ${j.vt} vote centers reporting` : null,
    contests,
  };
}
