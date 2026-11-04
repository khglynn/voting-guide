/* Live Voter Turnout ENR (www.livevoterturnout.com/ENR/{county}enr/{n}/), used by San Diego County (folder 25) and
   Orange County, CA (folder 24) on Nov 3, 2026. Each county's results page is built from one public XML file,
   `{base}/summary_{n}.xml`: one <Table> per choice, carrying RaceID, RaceName, VoteFor, GroupName (Orange only),
   ContestantName, TotalVotes (every ballot type together; `Votes` stays 0) and ContestantWriteIn, plus a header with
   GeneratedDate (the county's own time, with its offset), TotalBallotsCast and RegisteredVoters.
   What the file does not say, and how we handle it:
   1. No election name or date. The folder number and its ElectionID are the identity: a new election gets a new
      folder, the map names the folder its office's own page links (`election_id_from`), and a read whose ElectionID
      differs reads as an election mismatch (no date), so its rows link out.
   2. No per-race progress line (vote centers and mail make precinct counts meaningless at night). The source's progress
      words are its page's "Ballots Counted" figure, from TotalBallotsCast; races carry none.
   3. No status words. The page's banner ("Unofficial Election Results" on both counties at 8:05 PM PT) sits in the
      HTML, not the XML, so the map records it as `feed.labels` with when it was read.
   4. ContestantWinner is never taken as an outcome (the honesty rules decide that, not the feed).
   The file sends Last-Modified, so an unchanged poll is one conditional request answered 304. */
import { get } from '../fetch.js';

const decode = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const tag = (block, t) => { const m = block.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)); return m ? decode(m[1]) : null; };
// A count is whole digits; anything else stays NaN so checkRead refuses the read rather than guess.
const count = (s) => (/^\d+$/.test(String(s ?? '').trim()) ? Number(s) : NaN);

export function parse(xml) {
  const body = String(xml || '').replace(/^﻿/, '');
  const head = body.split('<Table>')[0];
  const races = new Map();
  const electionIds = new Set();
  for (const m of body.matchAll(/<Table>([\s\S]*?)<\/Table>/g)) {
    const b = m[1];
    const id = tag(b, 'RaceID');
    if (id === null) continue;
    electionIds.add(tag(b, 'ElectionID'));
    let r = races.get(id);
    if (!r) {
      r = { feed_id: id, feed_name: tag(b, 'RaceName') || '', category: tag(b, 'GroupName'), vote_for: Number(tag(b, 'VoteFor')) || 1, choices: [], total: 0, reporting: null, updated: null, declared: null };
      races.set(id, r);
    }
    r.choices.push({ name: tag(b, 'ContestantName') || '', votes: count(tag(b, 'TotalVotes')) });
  }
  for (const r of races.values()) r.total = r.choices.reduce((a, c) => a + (Number.isFinite(c.votes) ? c.votes : 0), 0);
  return {
    generated: tag(head, 'GeneratedDate'),
    ballots: count(tag(head, 'TotalBallotsCast')),
    registered: count(tag(head, 'RegisteredVoters')),
    electionIds: [...electionIds],
    contests: [...races.values()],
  };
}

export async function read({ fetch, map, prevToken = null }) {
  const identity = map.feed.identity || 'named';
  const n = map.election.feed_election_id;
  const url = `${map.feed.base}/summary_${n}.xml`;
  const lastMod = prevToken ? prevToken.split('|')[0] : null;
  const r = await get(fetch, url, { identity, expect: 'xml', headers: lastMod ? { 'If-Modified-Since': lastMod } : {} });
  if (r.verdict === 'not_modified') return { verdict: 'ok', unchanged: true, changed_token: prevToken };
  if (r.verdict !== 'ok') return { verdict: r.verdict, error: r.error, status: r.status, url };
  if (!/<NewDataSet>/.test(r.body || '')) return { verdict: /<html/i.test(r.body || '') ? 'refused' : 'error', error: /<html/i.test(r.body || '') ? 'an HTML page came back where the XML summary was expected (a bot check?)' : 'the summary file had no <NewDataSet>', url };
  const p = parse(r.body);
  if (!p.contests.length) return { verdict: 'error', error: 'the summary file listed no races', url };
  if (p.electionIds.length !== 1) return { verdict: 'error', error: `the summary file mixes election ids ${p.electionIds.join(', ')}`, url };
  const generatedMs = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$/.test(p.generated || '') ? Date.parse(p.generated) : NaN;
  const token = `${r.lastModified || ''}|${p.generated || ''}`;
  if (prevToken && token === prevToken) return { verdict: 'ok', unchanged: true, changed_token: token };
  const id = p.electionIds[0];
  return {
    verdict: 'ok',
    changed_token: token,
    raw: { [`summary_${n}.xml`]: r.body },
    election: { id, name: null, date: String(id) === String(n) ? map.election.date : null },
    source_status: null,
    official: false,
    source_updated: Number.isFinite(generatedMs) ? new Date(generatedMs).toISOString() : null,
    reporting: Number.isFinite(p.ballots) ? `${p.ballots.toLocaleString('en-US')} ballots counted` : null,
    labels: Array.isArray(map.feed.labels) ? map.feed.labels : [],
    contests: p.contests,
  };
}
