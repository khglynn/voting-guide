/* From a source's checked read and its map to the guide's items, then from every source in a state to one file.
   The file's shape is DIRECTION.md's `ResultsFile`; three fields are added: `total_votes` on an item or slice (every
   vote in that contest, matched or not, so percentages can be rechecked), `reason` on a link_only item ("not matched",
   "not checked yet", "election mismatch", "source refused us", "map out of date"), and on each source `checked`,
   `next_due` and `failing_since`. Nothing here sums slices: a race whose voters span sources (its map entry's
   `reaches` names more than one county, or two sources carry it) keeps one slice per source, the largest on top. */
import { pctOf } from './util.js';
import { outcomeFor, parseThreshold, RETENTION } from './outcome.js';

/* A map choice's value: a guide candidate's exact name, "yes"/"no" for a measure, null for a named feed choice who
   isn't in the guide (counted, and listed in `unmatched`), or "__other" for an aggregate line such as "Write-in"
   (counted in the total, never named). */
const OTHER = '__other';
const SKIP = '__skip'; // over and under votes: listed by some feeds, votes for no one, never counted

export function sourceStatus(read, map, now) {
  if (read.official || map.official?.at) return 'official';
  const anyVotes = (read.contests || []).some((c) => c.choices.some((ch) => Number(ch.votes) > 0));
  if (!anyVotes) return 'pending';
  const closes = map.count_closes ? Date.parse(map.count_closes) : Infinity;
  if (map.complete_marker?.flag && read.source_status === map.complete_marker.flag && Date.parse(now) >= closes) return 'complete';
  return 'counting';
}

/* One source's slice for each mapped item, plus the contests the map expected and didn't find. */
export function sourceSlices(read, map, now) {
  const status = sourceStatus(read, map, now);
  const byId = new Map((read.contests || []).map((c) => [c.feed_id, c]));
  const slices = {};
  const problems = [];
  for (const mc of map.contests || []) {
    const fc = byId.get(String(mc.feed_id));
    if (!fc) { problems.push({ reason: 'contest missing', detail: `${mc.feed_name} (${mc.feed_id}) isn't in the feed` }); continue; }
    if (!fc.choices.length) { problems.push({ reason: 'contest empty', detail: `${mc.feed_name} lists no choices right now` }); continue; }
    if (mc.feed_name && fc.feed_name.replace(/\s+/g, ' ').toUpperCase() !== mc.feed_name.replace(/\s+/g, ' ').toUpperCase()) {
      problems.push({ reason: 'contest renamed', detail: `feed id ${mc.feed_id} is now "${fc.feed_name}", the map says "${mc.feed_name}"` });
      continue;
    }
    const total = fc.choices.reduce((a, ch) => a + (mc.choices?.[ch.name] === SKIP ? 0 : Number(ch.votes) || 0), 0);
    const st = status === 'pending' || total === 0 ? 'pending' : status;
    const slice = {
      source: map.id,
      county: map.county || map.name,
      status: st,
      reporting: fc.reporting ?? null,
      updated: fc.updated || read.source_updated || null,
      url: mc.item_url || map.feed.results_url,
      total_votes: total,
    };
    const unmatched = [];
    let unmatchedVotes = 0, otherVotes = 0;
    for (const ch of fc.choices) {
      const to = mc.choices?.[ch.name];
      if (to === SKIP) continue;
      if (to === OTHER) otherVotes += Number(ch.votes) || 0;
      else if (to === null || to === undefined || ((mc.kind === 'measure' || mc.kind === 'retention') && to !== 'yes' && to !== 'no')) unmatchedVotes += Number(ch.votes) || 0;
    }
    if (mc.kind === 'measure' || mc.kind === 'retention') {
      let yes = 0, no = 0;
      for (const ch of fc.choices) {
        const to = mc.choices?.[ch.name];
        if (to === SKIP) continue;
        if (to === 'yes') yes += ch.votes; else if (to === 'no') no += ch.votes; else if (to !== OTHER) unmatched.push(ch.name);
      }
      const th = mc.kind === 'retention' ? (RETENTION[map.state] || { pct: 50, inclusive: false }) : (mc.threshold || parseThreshold(mc.pass_threshold));
      slice.measure = { yes, no, yes_pct: pctOf(yes, yes + no), threshold: th ? th.pct : null };
      slice.total_votes = yes + no;
      slice._threshold = th;
    } else {
      const cands = [];
      for (const ch of fc.choices) {
        const to = mc.choices?.[ch.name];
        if (to === SKIP) continue;
        if (to && to !== OTHER) cands.push({ name: to, votes: ch.votes, pct: pctOf(ch.votes, total) });
        else if (to !== OTHER) unmatched.push(ch.name);
      }
      slice.candidates = cands.sort((a, b) => b.votes - a.votes);
      if (mc.kind === 'multi') slice.seats = mc.seats;
    }
    if (unmatched.length) slice.unmatched = unmatched;
    if (fc.note || mc.note) slice.note = [mc.note, fc.note].filter(Boolean).join(' ');
    slice._kind = mc.kind;
    slice._declared = fc.declared ? fc.declared.map((n) => mc.choices?.[n]).filter((n) => n && n !== OTHER) : null;
    // A race whose map gives no `reaches` is never taken as the whole race: one county's slice, "other counties"
    // missing (site builder's review, Nov 3). `reaches: [this county]` is the map saying it is wholly inside.
    slice._whole = !!mc.whole;
    slice._reaches = mc.reaches && mc.reaches.length ? mc.reaches : [map.county || map.name, 'other counties'];
    slice._unmatchedVotes = unmatchedVotes;
    slice._otherVotes = otherVotes;
    slices[mc.item] = slice;
  }
  return { status, slices, problems };
}

const strip = (s) => Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith('_')));
const RANK = { pending: 0, counting: 1, complete: 2, official: 3 };

function single(sl) {
  const out = strip(sl);
  delete out.county;
  // Ranked choice: tonight's numbers are first choices, never an outcome (DESIGN.md rule 7); the site labels them.
  if (sl._kind === 'rcv') out.ranked_choice = true;
  out.final = outcomeFor({ status: sl.status, kind: sl._kind, seats: sl.seats, candidates: sl.candidates, measure: sl.measure, declared: sl._declared, threshold: sl._threshold, spanning: false, unmatchedVotes: sl._unmatchedVotes, otherVotes: sl._otherVotes });
  return out;
}

function spanning(list, reaches) {
  const sorted = [...list].sort((a, b) => b.total_votes - a.total_votes);
  const have = new Set(sorted.map((s) => s.county));
  const missing = reaches.filter((c) => !have.has(c));
  const top = sorted[0];
  const allDone = missing.length === 0 && sorted.every((s) => RANK[s.status] >= 2);
  const status = allDone ? (sorted.every((s) => s.status === 'official') ? 'official' : 'complete') : (sorted.some((s) => s.status !== 'pending') ? 'counting' : 'pending');
  const out = { source: top.source, status, reporting: top.reporting, updated: top.updated, url: top.url, total_votes: top.total_votes };
  if (top._kind === 'rcv') out.ranked_choice = true;
  if (top.candidates) out.candidates = top.candidates;
  if (top.measure) out.measure = top.measure;
  if (top.seats) out.seats = top.seats;
  if (top.unmatched) out.unmatched = top.unmatched;
  const notes = [...new Set(sorted.map((s) => s.note).filter(Boolean))];
  if (notes.length) out.note = notes.join(' ');
  out.slices = sorted.map(strip);
  if (missing.length) out.missing = missing;
  out.final = null;
  return out;
}

/* One state's file. `srcs[id]` = { record: {read, fetched, problems}, sched, checked, fpOk }.
   mode "public": only checked sources' numbers; "preview": every source's, each marked checked or not. */
export function buildStateFile({ state, maps, srcs, mode, now }) {
  const sources = [];
  const contributions = {}; // item -> [slice]
  const links = {}; // item -> link_only result
  for (const map of maps) {
    const s = srcs[map.id] || {};
    const rec = s.record;
    const sched = s.sched || {};
    const entry = { id: map.id, name: map.name, url: map.feed.results_url, updated: rec?.read?.source_updated ?? null, status: 'pending', reporting: rec?.read?.reporting ?? null, fetched: rec?.fetched ?? null };
    if (rec?.read?.labels?.length) entry.labels = rec.read.labels;
    if (rec?.read?.feed_version) entry.feed_version = rec.read.feed_version; // which Clarity version the numbers are from
    if (sched.next_due) entry.next_due = sched.next_due;
    if (sched.failing_since) entry.failing_since = sched.failing_since;
    if (mode === 'preview') entry.checked = !!s.checked;
    let reason = null;
    if (map.feed.adapter === 'link_only') reason = 'link only';
    else if (sched.stopped === 'refused') reason = 'source refused us';
    else if (rec?.blocked) reason = 'election mismatch';
    else if (rec && !rec.read) reason = null;
    else if (s.fpOk === false) reason = 'map out of date';
    else if (mode === 'public' && !s.checked) reason = 'not checked yet';
    else if (!rec) reason = null; // nothing read yet: items read "Not posted yet" (pending, no numbers)
    if (reason) { entry.status = 'link_only'; entry.note = reason; }
    sources.push(entry);

    const linkAll = (r) => { for (const mc of map.contests || []) links[mc.item] ??= { source: map.id, status: 'link_only', reporting: null, updated: null, url: mc.item_url || map.feed.results_url, reason: r }; };
    for (const id of map.unmatched_guide || []) links[id] ??= { source: map.id, status: 'link_only', reporting: null, updated: null, url: map.feed.results_url, reason: 'not matched' };
    if (reason) { linkAll(reason); continue; }
    if (!rec) {
      for (const mc of map.contests || []) (contributions[mc.item] ??= []).push({ source: map.id, county: map.county || map.name, status: 'pending', reporting: null, updated: null, url: mc.item_url || map.feed.results_url, total_votes: 0, _kind: mc.kind, _reaches: mc.reaches && mc.reaches.length ? mc.reaches : [map.county || map.name, 'other counties'], _empty: true });
      continue;
    }
    const { status, slices } = sourceSlices(rec.read, map, now);
    entry.status = status;
    for (const [item, sl] of Object.entries(slices)) (contributions[item] ??= []).push(sl);
    for (const mc of map.contests || []) if (!slices[mc.item]) links[mc.item] ??= { source: map.id, status: 'link_only', reporting: null, updated: null, url: mc.item_url || map.feed.results_url, reason: 'not in the feed' };
  }

  const items = {};
  for (const [item, list] of Object.entries(contributions)) {
    const reaches = [...new Set(list.flatMap((s) => s._reaches))];
    const real = list.filter((s) => !s._empty);
    if (real.length === 0) { const e = list[0]; items[item] = { source: e.source, status: 'pending', reporting: null, updated: null, url: e.url, final: null }; continue; }
    // A source that counts the whole race (the state's own count) is the item; county counts for the same race ride
    // beneath it as `county_slices`, never summed with it and never deciding its outcome.
    // The whole-race count stands only once it has votes, or when no county count does: an SOS race posted as zeros
    // (or emptied) never hides counties' real numbers.
    const wholeCand = real.find((s) => s._whole);
    const whole = wholeCand && (wholeCand.total_votes > 0 || !real.some((s) => !s._whole && s.total_votes > 0)) ? wholeCand : null;
    if (whole) {
      const out = single(whole);
      const parts = real.filter((s) => s !== whole).map(strip);
      if (parts.length) out.county_slices = parts.sort((a, b) => b.total_votes - a.total_votes);
      items[item] = out;
      continue;
    }
    const counties = real.filter((s) => !s._whole);
    if (!counties.length) { items[item] = single(wholeCand); continue; }
    items[item] = reaches.length > 1 || counties.length > 1 ? spanning(counties, reaches.length ? reaches : counties.map((s) => s.county)) : single(counties[0]);
  }
  for (const [item, l] of Object.entries(links)) if (!items[item]) items[item] = l;
  return { election: '2026-11-03', state, generated: now, sources, items };
}
