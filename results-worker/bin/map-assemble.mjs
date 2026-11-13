#!/usr/bin/env node
/* Step three of making a map (PLAN-PHASE-1 section 3.3): fold the drafter's pairs and the blind judge's verdicts into
   maps/{id}.json. A pair goes in only when the judge agreed on all three counts (same race, same people, kind); any
   disagreement sends the item to `unmatched_guide` (it shows as a link) and the feed contest to `unmatched_feed`.
   `reaches` takes the union of both lists, so a race either one thought spans counties is treated as spanning.
   A drafter's `note` (say, "write-ins are one total in this feed") rides along to the item.
   `--statewide` (Nov 4): the pairs are this county's slices of statewide races (drafted from map-inputs --statewide).
   They are added beside the map's own pairs, which stay exactly as they were (a re-run replaces only the earlier
   statewide slices), each marked `statewide: true` and reaching exactly this county and "other counties", so it is
   never the whole race. Statewide items with no confident pair go to `statewide_unmatched`, a record the Worker never reads:
   the state source keeps those races' links.
   Without `--statewide` it assembles the map's own pairs, and the map's statewide slices stay exactly as they were. A map
   that already has its own pairs is refused unless `--replace` says to rebuild them from this draft (the review of
   Nov 13: an old draft left in .local/map-drafts would otherwise quietly undo hand edits made since, such as the
   rule_unknown and checked_kind marks on the Texas and Georgia runoffs). Unknown options stop the run.
   Usage: node bin/map-assemble.mjs <id> [--statewide | --replace] [--draft f] [--judge f]
          then run bin/map-check.mjs --write <id> */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadMaps, writeMap, flags, ROOT } from './lib.mjs';

/* The map with the draft and the judge's verdicts folded in, as a new object; throws a plain sentence when it can't. */
export function assemble(map0, draft, judge, { statewide: sw = false, replace = false } = {}) {
  if (sw && replace) throw new Error('--statewide already replaces only the earlier statewide slices; --replace is for the map\'s own pairs');
  const map = structuredClone(map0);
  const id = map.id;
  const keptSw = (map.contests || []).filter((c) => c.statewide);
  const own = (map.contests || []).filter((c) => !c.statewide);
  if (!sw && own.length && !replace) throw new Error(`${id} already has ${own.length} pairs of its own; --replace rebuilds them from this draft (hand edits since its first assembly are lost), --statewide adds statewide slices`);
  const verdicts = new Map(judge.verdicts.map((v) => [`${v.feed_id}|${v.item}`, v]));
  const contests = [];
  const unmatchedGuide = new Set(draft.unmatched_guide || []);
  const unmatchedFeed = [...(draft.unmatched_feed || [])];
  const disagreements = [];
  for (const c of draft.contests) {
    const v = verdicts.get(`${c.feed_id}|${c.item}`);
    if (!v || !v.agree) {
      unmatchedGuide.add(c.item);
      unmatchedFeed.push({ feed_id: c.feed_id, feed_name: c.feed_name, why: v ? `judge disagreed: ${v.problem}` : 'judge gave no verdict' });
      disagreements.push(`${c.item} <- ${c.feed_name}: ${v ? v.problem : 'no verdict'}`);
      continue;
    }
    // A county's slice of a statewide race reaches exactly this county and "other counties": never the whole race, and
    // no list of the state's other counties for the open row to name one by one.
    const reaches = sw ? [map.county, 'other counties'] : [...new Set([...(c.reaches || []), ...(v.reaches || [])])];
    const out = { feed_id: c.feed_id, feed_name: c.feed_name, item: c.item, kind: c.kind, seats: c.seats ?? 1, choices: c.choices, reaches, item_url: null };
    if (sw) out.statewide = true;
    if (c.note) out.note = c.note;
    if (c.whole && !sw) out.whole = true;
    // A measure rule the guide's words don't carry exactly (Colorado's "at least 55%": inclusive), { pct, inclusive }.
    if (c.threshold) out.threshold = c.threshold;
    contests.push(out);
  }
  // The pairs being added never take an item or a feed contest the other half of the map already holds.
  const other = sw ? own : keptSw;
  const clash = contests.filter((c) => other.some((o) => o.item === c.item || String(o.feed_id) === String(c.feed_id)));
  if (clash.length) throw new Error(`${id}: already mapped: ${clash.map((c) => `${c.item} <- ${c.feed_id}`).join('; ')}`);
  map.contests = [...other, ...contests].sort((a, b) => a.item.localeCompare(b.item));
  if (sw) {
    map.statewide_unmatched = [...unmatchedGuide].sort();
    if (!map.statewide_unmatched.length) delete map.statewide_unmatched;
    // A feed contest a slice now holds isn't unmatched any more, whichever assembly listed it.
    const held = new Set(contests.map((c) => String(c.feed_id)));
    const feedSeen = new Set((map.unmatched_feed || []).map((u) => String(u.feed_id)));
    map.unmatched_feed = [...(map.unmatched_feed || []), ...unmatchedFeed.filter((u) => !feedSeen.has(String(u.feed_id)))].filter((u) => !held.has(String(u.feed_id)));
    // The state's bundle joins the map's places, so the statewide fingerprint (and the Worker's hourly check) covers
    // these items. It is kept apart from the map's own fingerprint (src/fingerprint.js), so a statewide edit drops only
    // these slices, never the county's own races.
    if (!map.guide.places.includes(`state-${map.state}`)) map.guide.places = [...map.guide.places, `state-${map.state}`];
  } else {
    map.unmatched_guide = [...unmatchedGuide].sort();
    // This draft never saw the statewide items, so it lists their feed contests as unmatched: the kept slices hold them.
    const held = new Set(keptSw.map((c) => String(c.feed_id)));
    map.unmatched_feed = unmatchedFeed.filter((u) => !held.has(String(u.feed_id)));
    map.not_here = (draft.not_this_county || []).sort();
  }
  return { map, contests, disagreements };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const f = flags(process.argv.slice(2), ['statewide', 'replace', 'draft', 'judge']);
  const [id] = f._;
  const map0 = loadMaps([id])[0];
  if (!map0) { console.error(`no map ${id}`); process.exit(1); }
  const dir = path.join(ROOT, '.local', 'map-drafts');
  const sw = !!f.statewide;
  const stem = sw ? `${id}.statewide` : id;
  const draft = JSON.parse(fs.readFileSync(f.draft || path.join(dir, `${stem}.draft.json`), 'utf8'));
  const judge = JSON.parse(fs.readFileSync(f.judge || path.join(dir, `${stem}.judge.json`), 'utf8'));
  let out;
  try { out = assemble(map0, draft, judge, { statewide: sw, replace: !!f.replace }); } catch (e) { console.error(e.message); process.exit(1); }
  const { map, contests, disagreements } = out;
  writeMap(map);
  console.log(sw
    ? `${id}: ${contests.length} statewide slices kept, ${disagreements.length} left to the state source, ${(map.statewide_unmatched || []).length} statewide items unmatched`
    : `${id}: ${contests.length} pairs kept, ${disagreements.length} sent to links, ${map.unmatched_guide.length} unmatched guide items${map.contests.length > contests.length ? `, ${map.contests.length - contests.length} statewide slices kept as they were` : ''}`);
  for (const d of disagreements) console.log(`  link: ${d}`);
}
