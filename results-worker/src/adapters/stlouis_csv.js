/* St. Louis County Board of Elections: one flat CSV for the whole county, `{base}/media.csv`
   (https://extcontent.stlouisco.com/BOE/eResults/media/media.csv, no login, served through Cloudflare). One row per
   precinct, contest and choice: Precinct, Precinct ID, Precinct Reporting, Registered Voters, Ballots Cast, Turnout
   Percentage, Contest Title, Contest ID, Contest Party, Choice Name, Choice ID, Choice Party, Total Votes.
   A contest's count is the sum of its precinct rows: every row is a precinct of this one county, so this is the
   county's own total, not a sum of county slices. There are no write-in, over or under lines.
   What the file does not carry, and how we stand in for it (capture round 1 and the builder, Nov 3, 10:20 PM CT):
   - no election name, id or date. The file's Last-Modified (the server's own write time) dates it, and the map names
     contests that only this election has (`feed.identity_contests`, id and title); a file missing any of them is
     another election and reads as a mismatch, so the whole source turns into links.
   - no update time inside: Last-Modified is the source's own time (7:35 PM CT on the first post, 9:58 PM at 10:19).
   - progress: the "Precinct Reporting" column holds one value on every row ("Absentee Reporting" at 7:54 PM,
     "Polls Reporting: 200/200" at 10:19 PM). It is quoted as given, and only when every row agrees.
   - no Unofficial or Official label.
   The file is 6.6 MB; the server answers If-Modified-Since with a 304 (checked 10:20 PM), so an unchanged poll is one
   empty conditional request. Titles carry double spaces ("U.S. REPRESENTATIVE -  DISTRICT 1"): kept exactly, since
   the map copies feed names as the feed spells them. */
import { get } from '../fetch.js';
import { isoDate } from '../util.js';

/* One CSV line to fields. The file has no quotes tonight; a quoted field (with commas or "" inside) still parses. */
function fields(line) {
  if (line.indexOf('"') < 0) return line.split(',');
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

const COLS = { title: 'Contest Title', cid: 'Contest ID', party: 'Contest Party', choice: 'Choice Name', chid: 'Choice ID', chparty: 'Choice Party', votes: 'Total Votes', rep: 'Precinct Reporting' };

/* The CSV text to contests in file order, with each contest's choices in file order and their summed votes. */
export function parse(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  const head = fields(lines[0] || '').map((h) => h.replace(/^#/, '').trim());
  const at = {};
  for (const [k, name] of Object.entries(COLS)) at[k] = head.indexOf(name);
  const missing = Object.entries(at).filter(([k, i]) => i < 0 && k !== 'party' && k !== 'chparty').map(([k]) => COLS[k]);
  if (missing.length) return { error: `the file has no ${missing.join(', ')} column` };
  const contests = new Map();
  const reportingWords = new Set();
  let bad = null;
  for (let n = 1; n < lines.length; n++) {
    const line = lines[n];
    if (!line) continue;
    const f = fields(line);
    if (f.length < head.length) { bad = `line ${n + 1} has ${f.length} fields, the header ${head.length}`; break; }
    const id = f[at.cid].trim();
    let c = contests.get(id);
    if (!c) { c = { feed_id: id, feed_name: f[at.title], party: at.party >= 0 ? f[at.party].trim() : '', choices: new Map() }; contests.set(id, c); }
    const chKey = f[at.chid].trim();
    let ch = c.choices.get(chKey);
    if (!ch) { ch = { name: f[at.choice].trim(), party: at.chparty >= 0 ? f[at.chparty].trim() : '', votes: 0 }; c.choices.set(chKey, ch); }
    const v = f[at.votes].trim();
    // A count that isn't a whole number poisons the contest's sum; checkRead then refuses the read.
    ch.votes = /^\d+$/.test(v) && Number.isFinite(ch.votes) ? ch.votes + Number(v) : NaN;
    reportingWords.add(f[at.rep].trim());
  }
  if (bad) return { error: bad };
  const reporting = reportingWords.size === 1 ? [...reportingWords][0] || null : null;
  return {
    reporting,
    reporting_values: [...reportingWords],
    contests: [...contests.values()].map((c) => {
      const choices = [...c.choices.values()].map(({ name, party, votes }) => ({ name, party, votes }));
      return { feed_id: c.feed_id, feed_name: c.feed_name, category: c.party || null, vote_for: null, choices, total: choices.reduce((a, b) => a + (Number.isFinite(b.votes) ? b.votes : 0), 0), reporting, updated: null, declared: null };
    }),
  };
}

/* The file's Last-Modified as a Central date: the map's own date while it falls inside the count window
   (election day through certification), else the date it really carries, which the identity check then refuses. */
function electionDate(lastModified, map) {
  const t = Date.parse(lastModified || '');
  if (!Number.isFinite(t)) return null;
  const central = new Date(t - 6 * 3600 * 1000).toISOString().slice(0, 10);
  const from = map.election.date;
  const to = map.certify_by || from;
  return central >= from && central <= to ? from : isoDate(central);
}

export async function read({ fetch, map, prevToken = null }) {
  const identity = map.feed.identity || 'named';
  const url = `${map.feed.base}/media.csv`;
  const lastMod = prevToken ? prevToken.split('|')[0] : null;
  const r = await get(fetch, url, { identity, expect: 'text', headers: lastMod ? { 'If-Modified-Since': lastMod } : {} });
  if (r.verdict === 'not_modified') return { verdict: 'ok', unchanged: true, changed_token: prevToken };
  if (r.verdict !== 'ok') return { verdict: r.verdict, error: r.error, status: r.status, url };
  if (!/^﻿?#?Precinct,/.test(r.body || '')) return { verdict: /^\s*</.test(r.body || '') ? 'refused' : 'error', error: 'media.csv did not start with its header row', url };
  const p = parse(r.body);
  if (p.error) return { verdict: 'error', error: `media.csv: ${p.error}`, url };
  if (!p.contests.length) return { verdict: 'error', error: 'media.csv held no contests', url };
  const token = `${r.lastModified || ''}|${r.etag || ''}`;
  if (prevToken && token === prevToken) return { verdict: 'ok', unchanged: true, changed_token: token };
  const byId = new Map(p.contests.map((c) => [c.feed_id, c]));
  const want = map.feed.identity_contests || [];
  const known = want.length > 0 && want.every((w) => byId.get(String(w.id))?.feed_name === w.name);
  return {
    verdict: 'ok',
    changed_token: token,
    raw: { 'media.csv': r.body },
    election: { id: known ? map.election.feed_election_id : 'not this election (identity contests missing)', name: '', date: electionDate(r.lastModified, map) },
    source_status: null,
    official: false,
    source_updated: r.lastModified ? new Date(r.lastModified).toISOString() : null,
    reporting: p.reporting,
    labels: [],
    contests: p.contests,
  };
}
