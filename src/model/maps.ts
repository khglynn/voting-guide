/* District maps: the boundaries a county or city publishes, checked against the point the Census
   found for an address, in the visitor's browser. The address goes only to the Census; the point
   never leaves the page; the maps are static files beside the data bundles.

   A map ships as TopoJSON (data/maps/{place}/{kind}.topojson, its record in {kind}.json): shared
   borders are stored once and coordinates are quantized, which keeps a place's maps near the size
   budget (GeoJSON of the same simplified lines is three to five times bigger). fromTopo turns one
   back into GeoJSON features, and everything below works on those.

   Two witnesses, not one. The Census places an address about 6 m inside its block, so on a street
   that is also a district line the point sits inside the maps' own noise (simplification, and the
   county's lines never sit exactly on the Census's streets). The Census also returns that block's
   interior point, well inside it (Austin City Hall's is 53 m from every edge), and redistricting
   plans are drawn from whole blocks. So answerAt asks both: when they agree, that's the answer;
   when they don't and the address point is near a line, the block's answer stands; otherwise it
   doesn't guess, and the sample ballot settles that race. No library: ray casting over every ring. */
import type { Contest, Item, MapMeta, SettleRule } from '../types';
import type { Ballot } from '../ballot';

export type Ring = number[][];
export type Geometry = { type: 'Polygon'; coordinates: Ring[] } | { type: 'MultiPolygon'; coordinates: Ring[][] };
export interface Feature { type: 'Feature'; properties: Record<string, string>; geometry: Geometry | null }
export interface FeatureCollection { type: 'FeatureCollection'; features: Feature[] }

/* ---------- TopoJSON ---------- */
export interface Topology {
  type: 'Topology';
  transform?: { scale: [number, number]; translate: [number, number] };
  arcs: number[][][];
  objects: Record<string, { type: string; geometries: { type: string | null; arcs?: unknown; properties?: Record<string, unknown> }[] }>;
}
/* Every object's polygons as features (the first object unless one is named), with each property
   as a string. Arcs are delta-encoded when the topology is quantized; a negative index (~i) is
   arc i backwards. Each ring joins its arcs, dropping the point two arcs share. */
export function fromTopo(t: Topology, object?: string): FeatureCollection {
  const tf = t.transform;
  const arcs = t.arcs.map((arc) => {
    if (!tf) return arc.map((p) => [p[0], p[1]]);
    let x = 0, y = 0;
    return arc.map((p) => { x += p[0]; y += p[1]; return [x * tf.scale[0] + tf.translate[0], y * tf.scale[1] + tf.translate[1]]; });
  });
  const ring = (ids: number[]): Ring => {
    const out: Ring = [];
    ids.forEach((i, k) => {
      const a = i < 0 ? arcs[~i].slice().reverse() : arcs[i];
      out.push(...(k ? a.slice(1) : a));
    });
    return out;
  };
  const name = object || Object.keys(t.objects)[0];
  const obj = t.objects[name];
  const features: Feature[] = (obj ? obj.geometries : []).map((g) => {
    const props: Record<string, string> = {};
    for (const [k, v] of Object.entries(g.properties || {})) if (v != null) props[k] = String(v);
    let geometry: Geometry | null = null;
    if (g.type === 'Polygon') geometry = { type: 'Polygon', coordinates: (g.arcs as number[][]).map(ring) };
    else if (g.type === 'MultiPolygon') geometry = { type: 'MultiPolygon', coordinates: (g.arcs as number[][][]).map((p) => p.map(ring)) };
    return { type: 'Feature', properties: props, geometry };
  });
  return { type: 'FeatureCollection', features };
}

/* ---------- point in polygon ---------- */
const polysOf = (g: Geometry | null): Ring[][] => (!g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.coordinates);
export function inRing(x: number, y: number, r: Ring): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/* Inside a polygon's outer ring and none of its holes, for any polygon of the geometry. */
export function inGeometry(g: Geometry | null, x: number, y: number): boolean {
  return polysOf(g).some((p) => p.length > 0 && inRing(x, y, p[0]) && !p.slice(1).some((h) => inRing(x, y, h)));
}
/* Each feature's bounding box, once per collection, so a lookup skips most polygons at once. */
const boxes = new WeakMap<FeatureCollection, [number, number, number, number][]>();
function boxesOf(fc: FeatureCollection): [number, number, number, number][] {
  let b = boxes.get(fc);
  if (!b) {
    b = fc.features.map((f) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of polysOf(f.geometry)) for (const [x, y] of p[0] || []) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      return [x0, y0, x1, y1];
    });
    boxes.set(fc, b);
  }
  return b;
}
/* Every feature holding the point (more than one means the map overlaps itself there). */
export function featuresAt(fc: FeatureCollection, lon: number, lat: number): Feature[] {
  const b = boxesOf(fc);
  return fc.features.filter((f, i) => lon >= b[i][0] && lon <= b[i][2] && lat >= b[i][1] && lat <= b[i][3] && inGeometry(f.geometry, lon, lat));
}
/* The label of the one feature holding the point; null when none does, or more than one. */
export function pointIn(fc: FeatureCollection, lon: number, lat: number): string | null {
  const at = featuresAt(fc, lon, lat);
  return at.length === 1 ? at[0].properties.label ?? null : null;
}
/* Metres from the point to the nearest line on the map (any ring of any feature), on a flat
   projection around the point: right to well under a metre at a city's scale. */
export function edgeDistance(fc: FeatureCollection, lon: number, lat: number): number {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110574;
  let best = Infinity;
  for (const f of fc.features) for (const p of polysOf(f.geometry)) for (const r of p) {
    for (let i = 1; i < r.length; i++) {
      const ax = (r[i - 1][0] - lon) * kx, ay = (r[i - 1][1] - lat) * ky;
      const dx = (r[i][0] - lon) * kx - ax, dy = (r[i][1] - lat) * ky - ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < best) best = d;
    }
  }
  return best;
}

/* ---------- the two witnesses ---------- */
export interface LonLat { lon: number; lat: number }
export interface Witnesses { point?: LonLat | null; block?: LonLat | null }
/* in: the map answers (props of the feature, and which witness decided). near: the address is at a
   line and the witnesses disagree, so the map doesn't guess. out: the map doesn't cover the address. */
export type MapAnswer = { at: 'in'; props: Record<string, string>; by: 'both' | 'block' | 'point' } | { at: 'near' } | { at: 'out' };
export const NEAR_M = 30;
export function answerAt(fc: FeatureCollection, w: Witnesses, nearM = NEAR_M): MapAnswer {
  const A = w.point ? featuresAt(fc, w.point.lon, w.point.lat) : null;
  const B = w.block ? featuresAt(fc, w.block.lon, w.block.lat) : null;
  if ((A && A.length > 1) || (B && B.length > 1)) return { at: 'near' };
  const a = A ? A[0] || null : undefined, b = B ? B[0] || null : undefined;
  const near = (): boolean => !!w.point && edgeDistance(fc, w.point.lon, w.point.lat) < nearM;
  if (a !== undefined && b !== undefined) {
    if (a && a === b) return { at: 'in', props: a.properties, by: 'both' };
    if (!a && !b) return { at: 'out' };
    if (near()) return b ? { at: 'in', props: b.properties, by: 'block' } : { at: 'out' };
    return { at: 'near' };
  }
  if (a !== undefined) return a ? (near() ? { at: 'near' } : { at: 'in', props: a.properties, by: 'point' }) : (near() ? { at: 'near' } : { at: 'out' });
  if (b !== undefined) return b ? { at: 'in', props: b.properties, by: 'block' } : { at: 'out' };
  return { at: 'out' };
}

/* ---------- what a map settles ---------- */
/* "District {label}" with a feature's properties: "District 9". Null when a named property is
   missing or empty, so a half-filled template never matches a race. */
export function fillTemplate(tpl: string, props: Record<string, string>): string | null {
  let ok = true;
  const out = tpl.replace(/\{(\w+)\}/g, (_m, k: string) => { const v = props[k]; if (v == null || v === '') ok = false; return v ?? ''; });
  return ok ? out : null;
}
/* A district as a sample ballot names it, made comparable: "Precinct 4 (unexpired term)" is
   "precinct 4". */
export const normDistrict = (s: string): string => s.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const re = (src: string): RegExp | null => { try { return new RegExp(src, 'i'); } catch { return null; } };
/* Whether a rule is about this race: its office (and its scope, when the rule names one). */
export function ruleMatches(rule: SettleRule, c: Item): c is Contest {
  if (c.kind !== 'contest') return false;
  const o = re(rule.office);
  if (!o || !o.test(c.office)) return false;
  if (rule.scope) { const s = re(rule.scope); if (!s || !s.test(c.scope_plain || '')) return false; }
  return true;
}
/* Whether the race is the one this answer names. */
export function ruleIs(rule: SettleRule, c: Contest, props: Record<string, string>): boolean {
  const want = fillTemplate(rule.district, props);
  return want != null && normDistrict(c.district || '') === normDistrict(want);
}
/* The ballot's maps, across its places, each once. */
export function ballotMaps(b: Ballot): { place: string; meta: MapMeta }[] {
  const out: { place: string; meta: MapMeta }[] = [];
  for (const p of b.places) for (const m of p.maps || []) if (!out.some((x) => x.meta.file === m.file)) out.push({ place: p.id, meta: m });
  return out;
}
/* Whether one of this ballot's maps settles the race. */
export function mapSettles(b: Ballot, c: Item): boolean {
  return ballotMaps(b).some(({ meta }) => meta.settles.some((r) => ruleMatches(r, c)));
}
