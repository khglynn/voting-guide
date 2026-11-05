/* Each source's own pace (PLAN-PHASE-1 section 4). Pure: give it the source's schedule entry, what this poll found and
   the time, and it returns the new entry. The ladder after a good read:
     changed: next in 1 minute; three unchanged polls: 5; 30 minutes unchanged: 15; two hours unchanged: 60;
     complete: every 6 hours; official: stopped; never earlier than the source's own next-update time.
   Quiet hours from Nov 4, 6 AM in the source's zone: no polls 11 PM to 6 AM local unless it changed in the last hour.
   A source whose items are all complete with its count window closed polls daily.
   Failures back off 1, 2, 5, 15, then 60 minutes (the plan said 2, 5, 15, 60; election night showed Clarity's blips
   come in runs, and a 15-minute wait cost Bexar's first post), after one retry inside the tick; `refused` stops the source until a person changes its map.
   A source stops for good once official, or once `certify_by` plus three days passes with no change.
   Added Nov 3 (builder): before the map's `polls_close` the next poll never lands later than the close, and after it a
   source with nothing posted yet is polled every minute, so the first numbers are read within a minute of posting. */
import { localHour } from './util.js';

const MIN = 60_000;
const addMin = (iso, m) => new Date(Date.parse(iso) + m * MIN).toISOString();
const QUIET_FROM = Date.parse('2026-11-04T12:00:00Z'); // 6 AM Central; per-zone start is computed below

function quietStart(tz) {
  // Nov 4, 6 AM in the source's zone, as UTC. US zones are UTC-4 to UTC-10 on Nov 4 (after DST ends Nov 1).
  const off = { 'America/New_York': 5, 'America/Chicago': 6, 'America/Denver': 7, 'America/Phoenix': 7, 'America/Los_Angeles': 8, 'Pacific/Honolulu': 10, 'America/Anchorage': 9 }[tz];
  return off ? Date.UTC(2026, 10, 4, 6 + off) : QUIET_FROM;
}

/* The next allowed time at or after `iso` outside 11 PM to 6 AM local, unless the source changed in the last hour. */
export function afterQuiet(iso, entry, tz) {
  if (!tz || Date.parse(iso) < quietStart(tz)) return iso;
  if (entry.last_change && Date.parse(iso) - Date.parse(entry.last_change) < 60 * MIN) return iso;
  let t = iso;
  for (let i = 0; i < 8; i++) {
    const h = localHour(t, tz);
    if (h >= 6 && h < 23) return t;
    t = addMin(t, 60 - new Date(t).getUTCMinutes()); // to the top of the next hour, then look again
  }
  return t;
}

export function nextEntry(entry = {}, result, now, map = {}) {
  const e = { ...entry, last_run: now };
  const tz = map.feed?.tz;
  if (result.kind === 'refused') {
    e.status = 'refused'; e.stopped = 'refused'; e.next_due = null; e.failing_since ??= now; e.last_error = result.error || 'refused';
    // The map it was refused under: a changed map (a deploy) clears the stop on the next tick (runTick).
    e.refused_hash = result.mapHash ?? e.map_hash ?? null;
    return e;
  }
  if (result.kind === 'error') {
    e.fail_count = (e.fail_count || 0) + 1;
    e.failing_since ??= now;
    e.last_error = result.error || 'error';
    let back = [1, 2, 5, 15, 60][Math.min(e.fail_count, 5) - 1];
    // While the count is still running (before the count window closes), never wait more than 5 minutes after a
    // failure: a CDN that answers 502 under election-night load comes back, and a long wait costs a fresh post.
    if (map.count_closes && Date.parse(now) < Date.parse(map.count_closes)) back = Math.min(back, 5);
    e.next_due = afterQuiet(addMin(now, back), e, tz);
    return e;
  }
  // a good read (changed or not). A good read of a refused source (a run by hand) lifts the refusal.
  if (e.stopped === 'refused') { delete e.stopped; delete e.refused_hash; }
  if (e.status === 'refused') delete e.status;
  e.fail_count = 0; delete e.failing_since; delete e.last_error;
  e.last_ok = now;
  if (result.status) e.status = result.status;
  if (result.changed) { e.last_change = now; e.unchanged_polls = 0; } else e.unchanged_polls = (e.unchanged_polls || 0) + 1;
  if (e.status === 'official') { e.stopped = 'official'; e.next_due = null; return e; }
  if (map.certify_by && !result.changed) {
    const stopAt = Date.parse(`${map.certify_by}T23:59:59Z`) + 3 * 24 * 60 * MIN;
    if (Date.parse(now) > stopAt) { e.stopped = 'past certification'; e.next_due = null; return e; }
  }
  let wait;
  const quietFor = e.last_change ? (Date.parse(now) - Date.parse(e.last_change)) / MIN : Infinity;
  if (e.status === 'complete') {
    const closed = map.count_closes && Date.parse(now) >= Date.parse(map.count_closes);
    wait = closed && result.allComplete ? 24 * 60 : 6 * 60;
  } else if (result.changed) wait = 1;
  else if (e.status === 'pending' && map.polls_close && Date.parse(now) >= Date.parse(map.polls_close)) wait = 1;
  else if (quietFor >= 120) wait = 60;
  else if (quietFor >= 30) wait = 15;
  else if (e.unchanged_polls >= 3) wait = 5;
  else wait = 1;
  // Election night itself (until 6 AM local on Nov 4, when quiet hours begin): never more than 5 minutes between
  // polls. Counties post early votes at 7 PM and then go quiet for hours before Election Day batches (Williamson,
  // Nov 3: nothing between 7:04 PM and at least 9:50 PM), and an unchanged poll costs one tiny request.
  if (tz && Date.parse(now) < quietStart(tz)) wait = Math.min(wait, 5);
  let next = addMin(now, wait);
  if (result.sourceNext && Date.parse(result.sourceNext) > Date.parse(next)) next = result.sourceNext;
  if (map.polls_close && Date.parse(now) < Date.parse(map.polls_close) && Date.parse(next) > Date.parse(map.polls_close)) next = new Date(Date.parse(map.polls_close)).toISOString();
  e.next_due = afterQuiet(next, e, tz);
  return e;
}

/* Sources due now, at most `limit`: those in `first` (sources whose numbers are public) before the rest, then earliest
   first. A stopped source is never due. Pre-deploy review, Nov 3: with 36 sources and six a tick, earliest-first left
   the live Texas, Colorado and DC sources up to 9 minutes between reads, and 24 new preview-only sources (no schedule
   entry yet, so due "first") would have taken the first ticks after the deploy. Simulated over 90 ticks with every
   source changing on 70% of reads: 14 a tick, public sources first and preview-only sources at most every
   PREVIEW_MINUTES, keeps every public source within 5 minutes and every preview within 10. */
export const TICK_LIMIT = 14;
export const PREVIEW_MINUTES = 3;
export function dueSources(sched, ids, now, limit = TICK_LIMIT, first = null) {
  const rank = (id) => (first && first.has(id) ? 0 : 1);
  return ids
    .filter((id) => { const s = sched[id]; return !s || (!s.stopped && (!s.next_due || Date.parse(s.next_due) <= Date.parse(now))); })
    .sort((a, b) => rank(a) - rank(b) || Date.parse(sched[a]?.next_due || 0) - Date.parse(sched[b]?.next_due || 0))
    .slice(0, limit);
}

/* A preview-only source (its numbers aren't public yet) is read at most every PREVIEW_MINUTES. */
export function previewFloor(entry, now) {
  if (!entry || entry.stopped || !entry.next_due) return entry;
  const floor = Date.parse(now) + PREVIEW_MINUTES * MIN;
  if (Date.parse(entry.next_due) < floor) entry.next_due = new Date(floor).toISOString();
  return entry;
}

/* The election-night cap applied to schedules written before it existed: on each tick, any source whose stored
   next_due is more than 5 minutes out is pulled in to 5 minutes, until quiet hours start in its zone. Returns
   whether anything moved. (Coordinator, Nov 3: Williamson sat parked until 10:11 PM after the cap shipped.) */
export function clampElectionNight(sched, maps, now) {
  let moved = false;
  for (const m of maps) {
    const e = sched[m.id];
    const tz = m.feed?.tz;
    if (!e || e.stopped || !e.next_due || !tz || Date.parse(now) >= quietStart(tz)) continue;
    const cap = Date.parse(now) + 5 * MIN;
    if (Date.parse(e.next_due) > cap) { e.next_due = new Date(cap).toISOString(); moved = true; }
  }
  return moved;
}
