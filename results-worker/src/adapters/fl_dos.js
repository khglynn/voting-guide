/* The Florida Division of Elections' election-night flat file (Florida Election Watch's Downloads page,
   https://floridaelectionwatch.gov/Downloads): `{base}/{yyyymmdd}_ElecResultsFL.txt`, tab-delimited, one row per
   race, county and candidate:
     ElectionDate PartyCode PartyName RaceCode RaceName CountyCode CountyName Juris1num Juris2num Precincts
     PrecinctsReporting CanNameLast CanNameFirst CanNameMiddle CanVotes
   It is the state's own statewide count: each race's numbers are the state's county rows added up, which is the total
   the state's own site shows (one source's rows, not our county slices). Each race's progress is the state's own
   Precincts and PrecinctsReporting columns over the counties that vote in it, quoted as "N of M precincts reporting".
   Things learned on Nov 3, 2026:
   - The file sits behind Azure Front Door, which served a Nov 2 copy (all zeros, x-cache TCP_HIT) to a plain read at
     10:18 PM CT. The office's own Downloads page links the file with a changing `?v=` key; the same read with a key
     came back fresh (TCP_MISS, Last-Modified 04:18:03 GMT, 117.6 million votes). So every read carries `?v=` set to
     the current minute, as the office's page does: at most one fresh read a minute, never a stale CDN copy.
   - The file has no time of its own. Its Last-Modified header is when the state last wrote it: that is the source's
     update time, and an unchanged poll is one conditional request answered 304.
   - Governor tickets carry surnames only: CanNameFirst "Donalds", CanNameMiddle "/", CanNameLast "Avila" reads as
     "Donalds / Avila". Measures and retentions are "Yes" and "No" in CanNameLast.
   - Race names are unique in the file (176 races, 176 names), so the name is the feed id, as on the Texas SOS page. */
import { get } from '../fetch.js';
import { isoDate } from '../util.js';

const COLS = ['ElectionDate', 'PartyCode', 'PartyName', 'RaceCode', 'RaceName', 'CountyCode', 'CountyName', 'Juris1num', 'Juris2num', 'Precincts', 'PrecinctsReporting', 'CanNameLast', 'CanNameFirst', 'CanNameMiddle', 'CanVotes'];
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/* A whole number or NaN: "1,234" and " 12 " read, "-" or "" never become zero (checkRead refuses a read with NaN). */
const count = (s) => { const t = clean(s).replace(/,/g, ''); return /^\d+$/.test(t) ? Number(t) : NaN; };

export function parse(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { error: 'the file was empty' };
  const head = lines[0].split('\t').map(clean);
  const at = Object.fromEntries(COLS.map((c) => [c, head.indexOf(c)]));
  const missing = COLS.filter((c) => at[c] < 0);
  if (missing.length) return { error: `the file's header lacks ${missing.join(', ')}` };
  const races = new Map();
  const dates = new Set();
  for (const line of lines.slice(1)) {
    const f = line.split('\t');
    const v = (c) => f[at[c]];
    dates.add(clean(v('ElectionDate')));
    const id = clean(v('RaceName'));
    if (!id) continue;
    let r = races.get(id);
    if (!r) { r = { feed_id: id, feed_name: id, category: clean(v('RaceCode')) || null, choices: new Map(), counties: new Map() }; races.set(id, r); }
    const name = clean([v('CanNameFirst'), v('CanNameMiddle'), v('CanNameLast')].map(clean).filter(Boolean).join(' '));
    const ch = r.choices.get(name) || { name, party: clean(v('PartyCode')) || null, votes: 0 };
    ch.votes += count(v('CanVotes'));
    r.choices.set(name, ch);
    const county = clean(v('CountyCode'));
    if (!r.counties.has(county)) r.counties.set(county, { name: clean(v('CountyName')), total: count(v('Precincts')), reported: count(v('PrecinctsReporting')) });
  }
  const contests = [...races.values()].map((r) => {
    const cs = [...r.counties.values()];
    const total = cs.reduce((a, c) => a + c.total, 0);
    const reported = cs.reduce((a, c) => a + c.reported, 0);
    const choices = [...r.choices.values()];
    return {
      feed_id: r.feed_id, feed_name: r.feed_name, category: r.category, vote_for: 1, choices,
      total: choices.reduce((a, c) => a + (Number.isFinite(c.votes) ? c.votes : 0), 0),
      reporting: total > 0 && Number.isFinite(reported) ? `${reported} of ${total} precincts reporting` : null,
      precincts: { reported, total },
      counties: cs.map((c) => c.name),
      updated: null, declared: null,
    };
  });
  return { dates: [...dates], contests };
}

export async function read({ fetch, map, prevToken = null, now = Date.now() }) {
  const identity = map.feed.identity || 'named';
  const url = `${map.feed.base}/${map.feed.file}?v=${Math.floor(now / 60000)}`;
  const r = await get(fetch, url, { identity, expect: 'text', headers: prevToken ? { 'If-Modified-Since': prevToken } : {} });
  if (r.verdict === 'not_modified') return { verdict: 'ok', unchanged: true, changed_token: prevToken };
  if (r.verdict !== 'ok') return { verdict: r.verdict, error: r.error, status: r.status, url };
  if (/^\s*</.test(r.body || '')) return { verdict: 'refused', error: 'an HTML page came back where the tab-delimited file was expected', url };
  const p = parse(r.body);
  if (p.error) return { verdict: 'error', error: p.error, url };
  if (!p.contests.length) return { verdict: 'error', error: 'no race in the file', url };
  if (p.dates.length !== 1) return { verdict: 'error', error: `the file names ${p.dates.length} election dates (${p.dates.slice(0, 3).join(', ')})`, url };
  const token = r.lastModified || null;
  if (prevToken && token && token === prevToken) return { verdict: 'ok', unchanged: true, changed_token: token };
  const lm = r.lastModified ? new Date(r.lastModified) : null;
  return {
    verdict: 'ok',
    changed_token: token,
    raw: { [map.feed.file]: r.body },
    election: { id: p.dates[0], name: null, date: isoDate(p.dates[0]) },
    source_status: null,
    official: false,
    source_updated: lm && !Number.isNaN(lm.getTime()) ? lm.toISOString() : null,
    reporting: null,
    contests: p.contests,
  };
}
