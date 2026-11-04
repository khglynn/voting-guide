/* What a map was made against, as one hash: for each item it binds, the item's id, kind, seats and candidate names
   (or a measure's threshold) as the guide's live bundles hold them. A data change that renames a candidate or drops
   an item changes the hash, and the Worker's hourly check turns that map's items back into links (plan call 3). */
import { sha256, stable } from './util.js';

export function guideLines(map, bundles) {
  const byId = new Map();
  for (const b of Object.values(bundles)) for (const it of b?.items || []) byId.set(it.id, it);
  return (map.contests || []).map((mc) => {
    const it = byId.get(mc.item);
    if (!it) return `${mc.item}|missing`;
    if (it.kind === 'measure') return `${mc.item}|measure|${it.pass_threshold || ''}`;
    const names = (it.candidates || []).map((c) => c.name).sort();
    return `${mc.item}|${it.is_retention ? 'retention' : 'contest'}|${it.vote_for || 1}|${names.join(';')}`;
  }).sort();
}

export async function fingerprint(map, bundles) {
  return (await sha256(guideLines(map, bundles).join('\n'))).slice(0, 16);
}

/* The whole map, keys sorted: a changed map is read in full again on its next poll. */
export async function mapHash(map) {
  return (await sha256(stable(map))).slice(0, 16);
}

/* The hash a `checked:{id}` key must hold. A changed map needs a new check, with one exception: a plurality race later
   marked `rule_unknown` (a runoff rule, Nov 3) carries `checked_kind: "plurality"` and a `rule_note`, and hashes as it
   was. For a plurality race that change only takes away the outcome word; every number is built the same way, so the
   first-run check of its numbers still stands. bin/map-check.mjs allows `checked_kind` only in that one shape. */
export async function checkHash(map) {
  const m = JSON.parse(JSON.stringify(map));
  for (const c of m.contests || []) {
    if (c.kind === 'rule_unknown' && c.checked_kind === 'plurality') { c.kind = 'plurality'; delete c.checked_kind; delete c.rule_note; }
  }
  return mapHash(m);
}
