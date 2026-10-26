/*
 * Coverage numbers for the index (Oct 25, Kevin: a friend asked "does it cover the source I use?",
 * and a city with few sources shouldn't look as covered as one with many). For one ballot, built the
 * way the app builds it (src/ballot.ts buildBallot), from the bundles build-data writes:
 *
 *   sources                endorsers with any row on the ballot (the list "Every source on your ballot" shows)
 *   with_picks             of those, the ones with at least one endorsement
 *   local_sources          for a place, the ones whose home_places names it; for a state, the statewide
 *                          ones (no home_places)
 *   local_with_picks       of those, the ones with at least one endorsement
 *   checked                the newest row date on the ballot (YYYY-MM-DD), or null
 *   local_races            for a place, its own items (not the statewide file's) a voter decides: every
 *                          measure, a judge to keep or remove, a race with two or more candidates
 *   local_races_with_picks of those, the ones with at least one endorsement from anyone
 *
 * Pure functions over plain objects, so tests/model.mjs runs them on a fixture and checks them
 * against the app's own ballot for every place.
 */

/* What's on the ballot: with places, every statewide measure and every-voter race plus everything
   the places list; without, the whole statewide file. */
export function ballotIds(sb, pbs) {
  if (!pbs.length) return [...sb.order];
  const byId = new Map(sb.items.map((i) => [i.id, i]));
  for (const p of pbs) for (const i of p.items) if (!byId.has(i.id)) byId.set(i.id, i);
  const ids = new Set();
  for (const id of sb.order) { const it = byId.get(id); if (it && (it.kind === 'measure' || it.every)) ids.add(id); }
  for (const p of pbs) for (const id of p.order) if (byId.has(id)) ids.add(id);
  return [...ids];
}

/* Rows by item, a place's row over the state's for the same source (as buildBallot merges them). */
function mergedEnds(sb, pbs) {
  const ends = {};
  for (const b of [sb, ...pbs]) for (const [t, row] of Object.entries(b.endorsements || {})) ends[t] = { ...(ends[t] || {}), ...row };
  return ends;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const decides = (it) => it.kind === 'measure' || (it.is_retention ? it.candidates.length > 0 : it.candidates.length > 1);

/* The numbers for one place's ballot (placeId set, pbs its one bundle) or a statewide-only one. */
export function coverageOf(sb, pbs, placeId = null) {
  const ids = ballotIds(sb, pbs);
  const ends = mergedEnds(sb, pbs);
  const eById = new Map();
  for (const b of [sb, ...pbs]) for (const e of b.endorsers || []) if (!eById.has(e.id)) eById.set(e.id, e);
  const rows = new Set();
  const picks = new Set();
  let checked = null;
  for (const id of ids) {
    for (const [eid, r] of Object.entries(ends[id] || {})) {
      rows.add(eid);
      if (r.s === 'endorsed') picks.add(eid);
      if (r.date && ISO.test(r.date) && (!checked || r.date > checked)) checked = r.date;
    }
  }
  const isLocal = (eid) => {
    const home = (eById.get(eid) || {}).home_places || [];
    return placeId ? home.includes(placeId) : !home.length;
  };
  const local = [...rows].filter(isLocal);
  const out = {
    sources: rows.size,
    with_picks: picks.size,
    local_sources: local.length,
    local_with_picks: local.filter((eid) => picks.has(eid)).length,
    checked,
  };
  if (!placeId) return out;
  const items = new Map(pbs.flatMap((p) => p.items).map((i) => [i.id, i]));
  const own = pbs.flatMap((p) => p.local || []).map((id) => items.get(id)).filter((it) => it && decides(it));
  const picked = own.filter((it) => Object.values(ends[it.id] || {}).some((r) => r.s === 'endorsed'));
  return { ...out, local_races: own.length, local_races_with_picks: picked.length };
}

/* Thin: none of the place's own sources has a pick, and some race of its own has no pick from
   anyone. Both halves matter: DC's wards and Callicoon have no place-local sources, yet DC-wide groups
   and New York's parties picked in every ward and village race, so saying "we don't have its local
   endorsements" there would be untrue. The app reads the same rule (src/model/coverage.ts isThin). */
export const isThin = (p) => p.local_with_picks === 0 && p.local_races_with_picks < p.local_races;
