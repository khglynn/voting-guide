#!/usr/bin/env node
/* Step three of making a map (PLAN-PHASE-1 section 3.3): fold the drafter's pairs and the blind judge's verdicts into
   maps/{id}.json. A pair goes in only when the judge agreed on all three counts (same race, same people, kind); any
   disagreement sends the item to `unmatched_guide` (it shows as a link) and the feed contest to `unmatched_feed`.
   `reaches` takes the union of both lists, so a race either one thought spans counties is treated as spanning.
   A drafter's `note` (say, "write-ins are one total in this feed") rides along to the item.
   `--statewide` (Nov 4): the pairs are this county's slices of statewide races (drafted from map-inputs --statewide).
   They are added beside the map's own pairs, which stay exactly as they were (a re-run replaces only the earlier
   statewide slices), each marked `statewide: true` and reaching this county and "other counties", so it is never the
   whole race. Statewide items with no confident pair go to `statewide_unmatched`, a record the Worker never reads:
   the state source keeps those races' links.
   Usage: node bin/map-assemble.mjs <id> [--statewide] [--draft f] [--judge f]   then run bin/map-check.mjs --write <id> */
import fs from 'node:fs';
import path from 'node:path';
import { loadMaps, writeMap, flags, ROOT } from './lib.mjs';

const f = flags(process.argv.slice(2));
const [id] = f._;
const map = loadMaps([id])[0];
const dir = path.join(ROOT, '.local', 'map-drafts');
const sw = !!f.statewide;
const stem = sw ? `${id}.statewide` : id;
const draft = JSON.parse(fs.readFileSync(f.draft || path.join(dir, `${stem}.draft.json`), 'utf8'));
const judge = JSON.parse(fs.readFileSync(f.judge || path.join(dir, `${stem}.judge.json`), 'utf8'));
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
  let reaches = [...new Set([...(c.reaches || []), ...(v.reaches || [])])];
  // A county's slice of a statewide race always names this county and "other counties" (never the whole race).
  if (sw) reaches = [...new Set([map.county, ...reaches.filter((r) => r !== 'other counties'), 'other counties'])];
  const out = { feed_id: c.feed_id, feed_name: c.feed_name, item: c.item, kind: c.kind, seats: c.seats ?? 1, choices: c.choices, reaches, item_url: null };
  if (sw) out.statewide = true;
  if (c.note) out.note = c.note;
  if (c.whole && !sw) out.whole = true;
  // A measure rule the guide's words don't carry exactly (Colorado's "at least 55%": inclusive), { pct, inclusive }.
  if (c.threshold) out.threshold = c.threshold;
  contests.push(out);
}
if (sw) {
  const own = (map.contests || []).filter((c) => !c.statewide);
  const clash = contests.filter((c) => own.some((o) => o.item === c.item || String(o.feed_id) === String(c.feed_id)));
  if (clash.length) { console.error(`${id}: already mapped: ${clash.map((c) => `${c.item} <- ${c.feed_id}`).join('; ')}`); process.exit(1); }
  map.contests = [...own, ...contests].sort((a, b) => a.item.localeCompare(b.item));
  map.statewide_unmatched = [...unmatchedGuide].sort();
  if (!map.statewide_unmatched.length) delete map.statewide_unmatched;
  const feedSeen = new Set((map.unmatched_feed || []).map((u) => String(u.feed_id)));
  map.unmatched_feed = [...(map.unmatched_feed || []), ...unmatchedFeed.filter((u) => !feedSeen.has(String(u.feed_id)))];
  // The state's bundle joins the map's places, so the fingerprint (and the Worker's hourly check) covers these items.
  if (!map.guide.places.includes(`state-${map.state}`)) map.guide.places = [...map.guide.places, `state-${map.state}`];
} else {
  map.contests = contests.sort((a, b) => a.item.localeCompare(b.item));
  map.unmatched_guide = [...unmatchedGuide].sort();
  map.unmatched_feed = unmatchedFeed;
  map.not_here = (draft.not_this_county || []).sort();
}
writeMap(map);
console.log(`${id}: ${contests.length} pairs kept, ${disagreements.length} sent to links, ${map.unmatched_guide.length} unmatched guide items`);
for (const d of disagreements) console.log(`  link: ${d}`);
