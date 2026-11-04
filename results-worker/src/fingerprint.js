/* What a map was made against, as one hash: for each item it binds, the item's id, kind, seats and candidate names
   (or a measure's threshold) as the guide's live bundles hold them. A data change that renames a candidate or drops
   an item changes the hash, and the Worker's hourly check turns that map's items back into links (plan call 3).
   Two hashes, so a statewide edit never reaches a county's own races (Nov 4): `guide.fingerprint` covers the map's own
   races, and `guide.statewide_fingerprint` covers its county slices of statewide races (`statewide: true`), present only
   on a map that carries some. A changed state item then drops only those slices; the state source's own count or link
   stands, and the county's local races stay live. */
import { sha256, stable } from './util.js';

/* `which`: 'own' (every race but the statewide slices) or 'statewide' (only those). */
export function guideLines(map, bundles, which = 'own') {
  const byId = new Map();
  for (const b of Object.values(bundles)) for (const it of b?.items || []) byId.set(it.id, it);
  const keep = which === 'statewide' ? (mc) => !!mc.statewide : (mc) => !mc.statewide;
  return (map.contests || []).filter(keep).map((mc) => {
    const it = byId.get(mc.item);
    if (!it) return `${mc.item}|missing`;
    if (it.kind === 'measure') return `${mc.item}|measure|${it.pass_threshold || ''}`;
    const names = (it.candidates || []).map((c) => c.name).sort();
    return `${mc.item}|${it.is_retention ? 'retention' : 'contest'}|${it.vote_for || 1}|${names.join(';')}`;
  }).sort();
}

/* The map's own races. On a map with no statewide slices this is the same hash it always was. */
export async function fingerprint(map, bundles) {
  return (await sha256(guideLines(map, bundles, 'own').join('\n'))).slice(0, 16);
}

/* The map's county slices of statewide races, or null when it carries none. */
export async function statewideFingerprint(map, bundles) {
  if (!(map.contests || []).some((mc) => mc.statewide)) return null;
  return (await sha256(guideLines(map, bundles, 'statewide').join('\n'))).slice(0, 16);
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
