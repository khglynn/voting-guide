#!/usr/bin/env node
/* Step one of making a map (PLAN-PHASE-1 section 3.3): the feed's contest list beside the guide's items for the map's
   places, so a model can draft the pairs. Writes .local/map-inputs/{id}.json and prints its path.
   Usage: node bin/map-inputs.mjs <map id> [--bundles ../public/data] [--raw <dir>]
   `--raw <dir>` replays a feed read already saved by hand (each file named by the last part of its address, e.g.
   current_ver.txt, summary.json, electionsettings.json) instead of reading the feed again: under a pace rule
   (Clarity after the Nov 3 CAPTCHA, at most 5 requests a source, 30 s apart) the read that made the fixture is the one
   the map is drafted from.
   Guide items are each place bundle's `local` items (statewide items come from a state source, so they're left out),
   with what the map needs to agree with: kind, seats (vote_for), retention, thresholds, candidate names, the places
   that carry the item and those places' counties, and the guide's own words on who votes (`scope_plain`).
   `--statewide` (Nov 4): for a county map, the guide side is instead the state bundle's items, so the county's share of
   each statewide race can be paired as that county's slice (reaches [county, "other counties"], statewide: true; the
   state source keeps the whole race). Writes .local/map-inputs/{id}.statewide.json; assemble with `map-assemble <id> --statewide`. */
import fs from 'node:fs';
import path from 'node:path';
import { loadMaps, loadBundle, flags, ROOT } from './lib.mjs';
import { ADAPTERS } from '../src/adapters/index.js';

const f = flags(process.argv.slice(2), ['bundles', 'raw', 'statewide']);
const [id] = f._;
const map = loadMaps([id])[0];
if (!map) { console.error(`no map ${id}`); process.exit(1); }
const bundleDir = typeof f.bundles === 'string' ? f.bundles : null;

const rawDir = typeof f.raw === 'string' ? f.raw : null;
const replay = async (url) => {
  const file = path.join(rawDir, decodeURIComponent(new URL(url).pathname.split('/').pop()));
  return fs.existsSync(file) ? new Response(fs.readFileSync(file), { status: 200 }) : new Response('not saved', { status: 404 });
};
const r = await ADAPTERS[map.feed.adapter].read({ fetch: rawDir ? replay : fetch, map });
if (r.verdict !== 'ok') { console.error(`feed read: ${r.verdict} ${r.error}`); process.exit(1); }

const statewide = !!f.statewide;
if (statewide && map.scope === 'state') { console.error('--statewide is for a county map; a state map already takes the state bundle'); process.exit(1); }
const items = new Map();
for (const p of statewide ? [`state-${map.state}`] : map.guide.places) {
  const b = await loadBundle(p.startsWith('state-') ? `${p}.json` : `place-${p}.json`, bundleDir);
  if (!b) { console.error(`no bundle for ${p}`); process.exit(1); }
  const local = new Set(b.local || []);
  const isState = p.startsWith('state-');
  for (const it of b.items) {
    // A state source (map.scope "state") takes the state bundle's items, and from place bundles only the district
    // races it counts whole (U.S. House); a county source takes each place's local items, or with --statewide the
    // state bundle's items.
    if (!statewide && (map.scope === 'state' ? !(isState || /us-house/.test(it.id) || (map.guide.locals && local.has(it.id))) : !local.has(it.id))) continue;
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
  ...(statewide ? { purpose: `statewide races only, each paired as ${map.county}'s own slice of the race (reaches ["${map.county}", "other counties"]); the state source counts the whole race` } : {}),
  election: r.election, read_at: new Date().toISOString(),
  feed: r.contests.map((c) => ({ feed_id: c.feed_id, feed_name: c.feed_name, category: c.category, vote_for: c.vote_for, choices: c.choices.map((x) => x.name) })),
  guide: [...items.values()],
};
const dir = path.join(ROOT, '.local', 'map-inputs');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${map.id}${statewide ? '.statewide' : ''}.json`);
fs.writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
console.log(`${file}: ${out.feed.length} feed contests, ${out.guide.length} guide items`);
