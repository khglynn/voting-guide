#!/usr/bin/env node
/* Step one of making a map (PLAN-PHASE-1 section 3.3): the feed's contest list beside the guide's items for the map's
   places, so a model can draft the pairs. Writes .local/map-inputs/{id}.json and prints its path.
   Usage: node bin/map-inputs.mjs <map id> [--bundles ../public/data]
   Guide items are each place bundle's `local` items (statewide items come only from a state source, so they're left
   out), with what the map needs to agree with: kind, seats (vote_for), retention, thresholds, candidate names, the
   places that carry the item and those places' counties, and the guide's own words on who votes (`scope_plain`). */
import fs from 'node:fs';
import path from 'node:path';
import { loadMaps, loadBundle, flags, ROOT } from './lib.mjs';
import { ADAPTERS } from '../src/adapters/index.js';

const f = flags(process.argv.slice(2));
const [id] = f._;
const map = loadMaps([id])[0];
if (!map) { console.error(`no map ${id}`); process.exit(1); }
const bundleDir = typeof f.bundles === 'string' ? f.bundles : null;

const r = await ADAPTERS[map.feed.adapter].read({ fetch, map });
if (r.verdict !== 'ok') { console.error(`feed read: ${r.verdict} ${r.error}`); process.exit(1); }

const items = new Map();
for (const p of map.guide.places) {
  const b = await loadBundle(`place-${p}.json`, bundleDir);
  if (!b) { console.error(`no bundle for ${p}`); process.exit(1); }
  const local = new Set(b.local || []);
  for (const it of b.items) {
    if (!local.has(it.id)) continue;
    const e = items.get(it.id) || {
      item: it.id,
      kind: it.kind === 'measure' ? 'measure' : it.is_retention ? 'retention' : it.ranked_choice ? 'rcv' : (it.vote_for || 1) > 1 ? 'multi' : 'plurality',
      seats: it.kind === 'measure' ? null : it.vote_for || 1,
      title: it.kind === 'measure' ? `${it.jurisdiction || ''} ${it.number || ''}: ${it.short_title || ''}`.trim() : [it.office, it.district, it.seat_label].filter(Boolean).join(', '),
      scope_plain: it.scope_plain || null,
      candidates: (it.candidates || []).map((c) => c.name),
      pass_threshold: it.pass_threshold || null,
      places: [],
      place_counties: [],
    };
    e.places.push(p);
    for (const c of b.counties || []) if (!e.place_counties.includes(c)) e.place_counties.push(c);
    items.set(it.id, e);
  }
}
const out = {
  map: map.id, county: map.county, state: map.state,
  election: r.election, read_at: new Date().toISOString(),
  feed: r.contests.map((c) => ({ feed_id: c.feed_id, feed_name: c.feed_name, category: c.category, vote_for: c.vote_for, choices: c.choices.map((x) => x.name) })),
  guide: [...items.values()],
};
const dir = path.join(ROOT, '.local', 'map-inputs');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${map.id}.json`);
fs.writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
console.log(`${file}: ${out.feed.length} feed contests, ${out.guide.length} guide items`);
