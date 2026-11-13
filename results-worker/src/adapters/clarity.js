/* Clarity Election Night Reporting (Scytl). Ten of the guide's jurisdictions use it.
   One poll: `{base}/{id}/current_ver.txt` (six bytes). When the version hasn't moved, that is the whole poll. When it has:
   `{id}/{ver}/json/en/summary.json` (every contest, choices and votes) and `{id}/{ver}/json/en/electionsettings.json`
   (the election's name and date, the site's own "updated" time, precinct totals, the final-upload flag).
   The election id comes from the map, which takes it from the office's own link or Clarity's list page
   (`{base}/elections.json`); `listElections` reads that list for the map-making step. */
import { get } from '../fetch.js';
import { parseUsTime, isoDate, hasProgressCount, wholeProgress } from '../util.js';

/* The source's own banner words, as plain text: "Early Voting Totals Only" (Dallas, 7 PM), "Unofficial Results".
   A banner holding a progress count is left out (see hasProgressCount).
   Colorado's state header (Nov 3) is "Unofficial Results" followed by a whole pasted HTML page (a 7A table), so a
   header is cut where a pasted document starts. Its other header still reads "UNOFFICIAL RESULTS June 28, 2016 Primary
   Election": a label that names a year other than the election's is a leftover and is dropped. Repeats that differ only
   in capitals (Fulton's "Unofficial Results" and "UNOFFICIAL RESULTS") show once. */
const plain = (h) => String(h || '').split(/<!doctype|<html/i)[0].replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
export function labels(ps = {}, year = null) {
  const out = [];
  for (const v of [ps.web?.header, ps['global settings']?.header, ps['global settings']?.['mobile header']]) {
    const t = plain(v);
    if (!t || t.length > 160 || hasProgressCount(t) || out.some((o) => o.toLowerCase() === t.toLowerCase())) continue;
    if (year && (t.match(/\b(19|20)\d\d\b/g) || []).some((y) => y !== String(year))) continue;
    out.push(t);
  }
  return out;
}

const num = (v) => (Array.isArray(v) ? Number(v[0] ?? 0) : Number(v ?? 0));

/* Progress words are quoted only where summary.json's PR is the number the office's own page shows. The first-run
   checks (Nov 3 to 4) found it is on the county sites read against their page or report (Bexar, Dallas, Williamson,
   Adams, Arapahoe, Jefferson, Fulton), and isn't on three, which say nothing instead:
   - a state site, whose contests count counties: Colorado's PR says 21 of 64 for the Senate where its page says
     "Election Night Reporting Complete 2/64", and its electionsettings line (1,107 of 4,297 precincts) is nowhere on
     the page either;
   - a site that hides small precincts' data (`precinctdatahidden` "1"): Orange FL's PR says 261 of 263 and 21 of 22
     where its page and report say 263/263 and 22/22, fully reported;
   - Allegheny, with no flag to tell: 1,321 of 1,327 where the page's own sum.json and report say 1,322, at the same
     version. Listed here by map id, so its map and check hash stay as they are. */
const PR_NOT_ON_PAGE = new Set(['allegheny-pa']);

export async function listElections({ fetch, base, identity }) {
  const r = await get(fetch, `${base}/elections.json`, { identity });
  if (r.verdict !== 'ok') return r;
  return { verdict: 'ok', elections: (r.json || []).map((e) => ({ id: String(e.EID), name: e.ElectionName, date: isoDate(e.Date) })) };
}

export async function read({ fetch, map, prevToken = null }) {
  const identity = map.feed.identity || 'named';
  const root = `${map.feed.base}/${map.election.feed_election_id}`;
  const v = await get(fetch, `${root}/current_ver.txt`, { identity, expect: 'text' });
  if (v.verdict !== 'ok') return { verdict: v.verdict, error: v.error, status: v.status, url: v.url };
  const ver = String(v.body || '').trim();
  if (!/^\d{3,12}$/.test(ver)) return { verdict: 'error', error: `current_ver.txt held "${ver.slice(0, 20)}", not a version number`, url: v.url };
  if (prevToken && ver === prevToken) return { verdict: 'ok', unchanged: true, changed_token: ver };

  const [s, e] = await Promise.all([
    get(fetch, `${root}/${ver}/json/en/summary.json`, { identity }),
    get(fetch, `${root}/${ver}/json/en/electionsettings.json`, { identity }),
  ]);
  // A refusal on either file wins over an ordinary error on the other, so a CAPTCHA is never retried (Codex, Nov 3).
  const bad = [s, e].find((r) => r.verdict === 'refused') || [s, e].find((r) => r.verdict !== 'ok');
  if (bad) return { verdict: bad.verdict, error: bad.error, status: bad.status, url: bad.url };
  if (!Array.isArray(s.json)) return { verdict: 'error', error: 'summary.json was not a list of contests', url: s.url };

  // A state's Clarity site counts counties, not precincts, in each contest's PR and TP (Colorado, Nov 3: the Senate's TP
  // is 64, the number of counties; HD-23's is 1), while its electionsettings totals are still precincts (4,297).
  // Its map says so with `feed.contest_unit: "counties"`.
  const unit = map.feed.contest_unit || 'precincts';
  const settings = e.json?.settings || {};
  const details = settings.electiondetails || {};
  const totalPr = Number(settings.totalprecinctsreporting || e.json?.stateprecinctsparticipating || 0);
  const quotable = unit === 'precincts' && String(details.precinctdatahidden ?? '0') !== '1' && !PR_NOT_ON_PAGE.has(map.id);
  const contests = s.json.map((c) => {
    const names = c.CH || [];
    const votes = c.V || [];
    const winners = (c.W || []).map((w, i) => (Number(w) > 0 ? names[i] : null)).filter(Boolean);
    return {
      feed_id: String(c.K),
      feed_name: String(c.C || '').trim(),
      category: c.CAT || null,
      vote_for: Number(c.VF || 1),
      choices: names.map((n, i) => ({ name: String(n).trim(), votes: votes[i] })),
      total: num(c.T),
      source_pct: c.PCT || null,
      // "0 of 210 precincts reporting" beside 160,000 counted votes (Douglas CO, Williamson TX early on Nov 3) reads as
      // wrong: mail and early votes post before any precinct reports. With votes in and no precinct reported, there are
      // no progress words to quote, so none are shown (coordinator and the Douglas check, Nov 3).
      reporting: quotable && Number(c.TP) > 0 && !(Number(c.PR) === 0 && votes.some((x) => Number(x) > 0)) ? `${c.PR} of ${c.TP} ${unit} reporting` : null,
      precincts: { reported: Number(c.PR || 0), total: Number(c.TP || 0) },
      is_rcv: !!c.IsRCV,
      updated: null,
      declared: winners.length ? winners : null,
    };
  });
  // The source's line is its whole-county races' own (src/util.js wholeProgress): electionsettings gives no whole-election
  // count on the county sites (0 in Bexar, Dallas, Travis, Fulton, Orange and Allegheny, Nov 3) and one the page doesn't
  // show on the state site. The race has the largest TP, matching the settings' precinct total where one is given,
  // shared by at least two races, since Clarity names no county total to prove a lone race's reach.
  const whole = quotable ? wholeProgress(contests, { total: totalPr, shared: 2 }) : null;
  return {
    verdict: 'ok',
    changed_token: ver,
    raw: { 'current_ver.txt': ver, 'summary.json': s.body, 'electionsettings.json': e.body },
    election: { id: details.electionid === undefined || details.electionid === null ? null : String(details.electionid), name: String(details.internalname || '').trim(), date: isoDate(details.electiondate) },
    source_status: details.chkisfinalupload === true || details.chkisfinalupload === 'true' ? 'final_flag' : null,
    official: false,
    source_updated: parseUsTime(e.json?.websiteupdatedat),
    labels: labels(e.json?.pagesettings, isoDate(details.electiondate)?.slice(0, 4) || null),
    feed_version: ver,
    reporting: whole?.reporting ?? null,
    ...(whole ? { reporting_from: whole.from } : {}),
    contests,
  };
}
