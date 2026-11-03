#!/usr/bin/env node
/* Step three of making a map (PLAN-PHASE-1 section 3.3): fold the drafter's pairs and the blind judge's verdicts into
   maps/{id}.json. A pair goes in only when the judge agreed on all three counts (same race, same people, kind); any
   disagreement sends the item to `unmatched_guide` (it shows as a link) and the feed contest to `unmatched_feed`.
   `reaches` takes the union of both lists, so a race either one thought spans counties is treated as spanning.
   A drafter's `note` (say, "write-ins are one total in this feed") rides along to the item.
   Usage: node bin/map-assemble.mjs <id> [--draft f] [--judge f]   then run bin/map-check.mjs --write <id> */
import fs from 'node:fs';
import path from 'node:path';
import { loadMaps, writeMap, flags, ROOT } from './lib.mjs';

const f = flags(process.argv.slice(2));
const [id] = f._;
const map = loadMaps([id])[0];
const dir = path.join(ROOT, '.local', 'map-drafts');
const draft = JSON.parse(fs.readFileSync(f.draft || path.join(dir, `${id}.draft.json`), 'utf8'));
const judge = JSON.parse(fs.readFileSync(f.judge || path.join(dir, `${id}.judge.json`), 'utf8'));
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
  const reaches = [...new Set([...(c.reaches || []), ...(v.reaches || [])])];
  const out = { feed_id: c.feed_id, feed_name: c.feed_name, item: c.item, kind: c.kind, seats: c.seats ?? 1, choices: c.choices, reaches, item_url: null };
  if (c.note) out.note = c.note;
  contests.push(out);
}
map.contests = contests.sort((a, b) => a.item.localeCompare(b.item));
map.unmatched_guide = [...unmatchedGuide].sort();
map.unmatched_feed = unmatchedFeed;
map.not_here = (draft.not_this_county || []).sort();
writeMap(map);
console.log(`${id}: ${contests.length} pairs kept, ${disagreements.length} sent to links, ${map.unmatched_guide.length} unmatched guide items`);
for (const d of disagreements) console.log(`  link: ${d}`);
