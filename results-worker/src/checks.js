/* Checks on every read, before anything it holds can reach a file (PLAN-PHASE-1 section 6, DESIGN.md section 8).
   `checkRead` judges one adapter read against its map and the last good read:
   - the election is the one the map was made for (date, id, name): otherwise the whole source turns into links;
   - every count is a whole, non-negative number: otherwise the read is refused and the last good one stays;
   - a contest whose total fell keeps its previous numbers with their own time (`updated`, `carried_from`) and a note
     (and a ping from the tick); after FALLS_TO_ACCEPT changed reads in a row below the kept total, the source's lower
     count is taken as a correction.
   Problems carry a `reason` the status page and the ping use. */
import { isWhole, norm, ELECTION } from './util.js';

/* Changed reads in a row whose total stays below the kept one before the source's own lower count stands. A real
   correction (a county removing duplicate ballots) then lands; a one-read dip never shows (overnight review, Nov 3). */
export const FALLS_TO_ACCEPT = 3;
const votesIn = (c) => (c ? c.choices.reduce((a, b) => a + (Number(b.votes) || 0), 0) : 0);
const clock = (iso, tz) => (iso ? new Date(iso).toLocaleTimeString('en-US', { timeZone: tz || 'America/Chicago', hour: 'numeric', minute: '2-digit' }) : null);

export function checkRead(read, map, prev = null) {
  const problems = [];
  const e = read.election || {};
  const want = map.election || {};
  if (e.date !== (want.date || ELECTION)) problems.push({ reason: 'election mismatch', block: 'source', detail: `the feed's election date is ${e.date || 'missing'}, not ${want.date || ELECTION}` });
  if (want.feed_election_id && String(e.id) !== String(want.feed_election_id)) problems.push({ reason: 'election mismatch', block: 'source', detail: `the feed's election id is ${e.id}, the map's ${want.feed_election_id}` });
  if (want.feed_name && norm(e.name) !== norm(want.feed_name)) problems.push({ reason: 'election mismatch', block: 'source', detail: `the feed calls the election "${e.name}", the map "${want.feed_name}"` });

  for (const c of read.contests || []) {
    for (const ch of c.choices) if (!isWhole(ch.votes)) problems.push({ reason: 'bad numbers', block: 'read', detail: `${c.feed_name}: ${ch.name} has ${ch.votes} votes` });
  }

  // A falling total keeps the previous numbers for that contest, stamped with the time they are from, never the newer
  // read's (honest freshness); after FALLS_TO_ACCEPT reads in a row below, the source's lower count stands.
  const kept = [];
  if (prev?.contests) {
    const before = new Map(prev.contests.map((c) => [c.feed_id, c]));
    const tz = map.feed?.tz;
    read.contests = (read.contests || []).map((c) => {
      const p = before.get(c.feed_id);
      const now = votesIn(c);
      const was = votesIn(p);
      if (!p || now >= was) return c;
      // A contest kept by the code before this fix has no time of its own (TX-10 on the Texas SOS, Nov 3: 124,544 kept,
      // stamped with the 10:34 PM read that fell). Its real time can't be named, so the source's own count stands.
      const untimed = !p.falls && /fell from/.test(p.note || '');
      const falls = untimed ? FALLS_TO_ACCEPT : (p.falls || 0) + 1;
      if (falls >= FALLS_TO_ACCEPT) {
        problems.push({ reason: 'falling total accepted', block: null, detail: `${c.feed_name}: total stayed below ${was} for ${falls} reads in a row; took the source's ${now} as a correction` });
        return c;
      }
      kept.push(c.feed_id);
      const when = p.carried_from || p.updated || prev.source_updated || null;
      problems.push({ reason: 'falling total', block: null, detail: `${c.feed_name}: total fell from ${was} to ${now}; kept the earlier numbers` });
      const n = (x) => x.toLocaleString('en-US');
      return { ...p, updated: when, carried_from: when, falls, note: `The source's total fell from ${n(was)} to ${n(now)} at its ${clock(read.source_updated, tz) || 'latest'} update, so these are its numbers from ${clock(when, tz) || 'before that'}.` };
    });
  }
  return { ok: !problems.some((p) => p.block), sourceBlocked: problems.some((p) => p.block === 'source'), readBlocked: problems.some((p) => p.block === 'read'), problems, kept };
}

/* Checks on a built file: the schema, plus every percentage recomputed from the counts it sits beside. */
import { validateResultsFile } from './schema.js';

function pctProblems(where, x, out) {
  if (x.measure) {
    const t = x.measure.yes + x.measure.no;
    const p = t > 0 ? Math.round((x.measure.yes / t) * 10000) / 100 : 0;
    if (Math.abs(p - x.measure.yes_pct) > 0.01) out.push(`${where}: yes_pct ${x.measure.yes_pct} doesn't match its counts (${p})`);
  }
  if (x.candidates && Number.isInteger(x.total_votes)) {
    const named = x.candidates.reduce((a, c) => a + c.votes, 0);
    if (named > x.total_votes) out.push(`${where}: candidates' votes add to more than total_votes`);
    for (const c of x.candidates) {
      const p = x.total_votes > 0 ? Math.round((c.votes / x.total_votes) * 10000) / 100 : 0;
      if (Math.abs(p - c.pct) > 0.01) out.push(`${where}: ${c.name} pct ${c.pct} doesn't match its counts (${p})`);
    }
  }
}

export function checkFile(f) {
  const out = validateResultsFile(f);
  for (const [id, x] of Object.entries(f.items || {})) {
    pctProblems(`item ${id}`, x, out);
    for (const sl of x.slices || []) pctProblems(`item ${id} slice ${sl.source}`, sl, out);
  }
  return out;
}
