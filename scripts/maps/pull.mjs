#!/usr/bin/env node
/*
 * pull: an area's official district layers, fetched, simplified, checked, and written to
 * data/maps/{area}/{kind}.topojson with the record that makes each one honest, {kind}.json.
 *
 *   node scripts/maps/pull.mjs <area>               # every layer in scripts/maps/manifests/<area>.json
 *   node scripts/maps/pull.mjs <area> --kind council   # one layer
 *   node scripts/maps/pull.mjs <area> --cached      # reuse the raw downloads in .tmp/maps/<area>/
 *
 * The manifest is the only hand-written part. Per layer: the ArcGIS REST layer to read, which
 * property becomes the `label` (and any other properties a rule reads, each with a regex whose
 * first group is the value), which races it settles, and the places whose ballots read it. The
 * same script runs for every place after Austin: write a manifest, run it, read what it prints.
 *
 * What it checks, and fails on (nothing is written for a layer that fails):
 *   - every feature the server lists arrives (paging past maxRecordCount);
 *   - after simplifying (Douglas-Peucker, `simplify_m` metres, so no line moves more than that) the
 *     shipped map answers exactly like the full-precision one at sample points more than
 *     simplify_m + 2 m from any line, inside every feature;
 *   - `agree`: other official layers say the same thing at a deep point inside every feature (the
 *     Tax Office's copy of the precincts, the county's own commissioner and JP layers);
 *   - test points (scripts/maps/test-points.json: public buildings only): the two-witness answer the
 *     site gives matches what the layer's own server says there, and `expect` where the manifest
 *     pins one.
 * It reads src/model/maps.ts through Vite, so the checks run the same code the browser runs.
 *
 * mapshaper is pinned in scripts/maps/package.json with its own lockfile, not in the site's
 * dependencies: it brings about 230 packages (some native) that the site's install and CI never need.
 * This script installs it there on first run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const args = process.argv.slice(2);
const area = args.find((a) => !a.startsWith('--'));
const onlyKind = args.includes('--kind') ? args[args.indexOf('--kind') + 1] : null;
const CACHED = args.includes('--cached');
if (!area) { console.error('usage: node scripts/maps/pull.mjs <area> [--kind <kind>] [--cached]'); process.exit(2); }
const MANIFEST = path.join(HERE, 'manifests', `${area}.json`);
if (!fs.existsSync(MANIFEST)) { console.error(`No manifest at ${path.relative(ROOT, MANIFEST)}`); process.exit(2); }
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const TMP = path.join(ROOT, '.tmp', 'maps', area);
const OUT = path.join(ROOT, 'data', 'maps', area);
fs.mkdirSync(TMP, { recursive: true });
const TODAY = new Date().toISOString().slice(0, 10);
const SIMPLIFY = Number(manifest.simplify_m) || 10;
const QUANT = 100000;

/* ---------- mapshaper, in its own folder ---------- */
const MS = path.join(HERE, 'node_modules', '.bin', 'mapshaper');
if (!fs.existsSync(MS)) {
  console.log('Installing mapshaper into scripts/maps (once) ...');
  execFileSync('npm', ['ci', '--no-audit', '--no-fund', '--prefix', HERE], { stdio: 'inherit' });
}

/* ---------- the browser's own map code ---------- */
const vite = await createServer({ root: ROOT, configFile: false, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
const maps = await vite.ssrLoadModule('/src/model/maps.ts');

/* ---------- fetching ---------- */
async function getJSON(u, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(90000), headers: { 'user-agent': 'voting-guide maps pull (https://vote.kevinhg.com)' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j && j.error) throw new Error(`server error ${JSON.stringify(j.error).slice(0, 200)}`);
      return j;
    } catch (e) {
      if (i >= tries) throw new Error(`${u.slice(0, 160)}: ${e.message}`);
      await new Promise((res) => setTimeout(res, 1500 * i));
    }
  }
}
const slug = (u) => u.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').slice(-90);
/* Every feature of an ArcGIS REST layer as GeoJSON in lon/lat, with the layer's own record. */
async function fetchLayer(src) {
  const file = path.join(TMP, `${slug(src)}.raw.json`);
  if (CACHED && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const info = await getJSON(`${src}?f=json`);
  const { count } = await getJSON(`${src}/query?where=1%3D1&returnCountOnly=true&f=json`);
  const page = Math.min(info.maxRecordCount || 1000, 2000);
  const oid = info.objectIdField || (info.fields || []).find((f) => f.type === 'esriFieldTypeOID')?.name || 'OBJECTID';
  const features = [];
  for (let off = 0; off < count; off += page) {
    const q = new URLSearchParams({ where: '1=1', outFields: '*', returnGeometry: 'true', outSR: '4326', f: 'geojson' });
    if (count > page) { q.set('orderByFields', oid); q.set('resultOffset', String(off)); q.set('resultRecordCount', String(page)); }
    const fc = await getJSON(`${src}/query?${q}`);
    features.push(...(fc.features || []));
    if (count <= page) break;
  }
  if (features.length !== count) throw new Error(`${src}: the server lists ${count} features and sent ${features.length}`);
  const out = { info: { name: info.name, copyrightText: info.copyrightText || '', maxRecordCount: info.maxRecordCount }, fc: { type: 'FeatureCollection', features } };
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}
/* What a layer's own server says at a point: the attributes of every feature there. */
async function serverAt(src, [lon, lat]) {
  const q = new URLSearchParams({ geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: '*', returnGeometry: 'false', f: 'json' });
  const j = await getJSON(`${src}/query?${q}`);
  return (j.features || []).map((f) => f.attributes || {});
}

/* ---------- labels ---------- */
const pick = (props, spec) => {
  const v = props[spec.field];
  if (v == null || String(v).trim() === '') return null;
  const m = String(v).trim().match(new RegExp(spec.match || '^(.*)$'));
  return m ? (m[1] ?? m[0]) : null;
};
/* The feature as the site reads it: label plus the manifest's other properties, nothing else (no
   names of officeholders, no editors, no links). Null when the label doesn't match: left out. */
function shape(props, layer) {
  const label = pick(props, layer.label);
  if (label == null) return null;
  const out = { label };
  for (const [k, spec] of Object.entries(layer.props || {})) {
    const v = pick(props, spec);
    if (v == null) throw new Error(`${layer.kind}: feature ${label} has no ${k} (${spec.field} = ${JSON.stringify(props[spec.field])})`);
    out[k] = v;
  }
  return out;
}
const asDate = (v) => {
  if (v == null || v === '') return null;
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
};

/* ---------- geometry helpers for the checks (full precision) ---------- */
function rand(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const polys = (g) => (!g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);
function bbox(g) { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of polys(g)) for (const [x, y] of p[0] || []) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } return [x0, y0, x1, y1]; }
/* Metres to the nearest line of a collection, with each ring's box to skip far rings. */
function edgeIndex(fc) {
  const rings = [];
  for (const f of fc.features) for (const p of polys(f.geometry)) for (const r of p) { const b = bbox({ type: 'Polygon', coordinates: [r] }); rings.push({ r, b }); }
  return (lon, lat, cap = 200) => {
    const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110574;
    const dx0 = cap / kx, dy0 = cap / ky;
    let best = cap;
    for (const { r, b } of rings) {
      if (lon < b[0] - dx0 || lon > b[2] + dx0 || lat < b[1] - dy0 || lat > b[3] + dy0) continue;
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
  };
}

/* ---------- one layer ---------- */
const points = manifest.test_points ? JSON.parse(fs.readFileSync(path.join(HERE, manifest.test_points), 'utf8')).points : [];
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const summary = [];
let failed = 0;
for (const layer of manifest.layers) {
  if (onlyKind && layer.kind !== onlyKind) continue;
  const problems = [];
  const note = (s) => console.log(`  ${s}`);
  console.log(`\n== ${area}/${layer.kind}: ${layer.title}`);
  const raw = await fetchLayer(layer.source_url);
  const rawBytes = Buffer.byteLength(JSON.stringify(raw.fc));
  note(`fetched ${raw.fc.features.length} features (${kb(rawBytes)} as full-precision GeoJSON) from ${layer.source_url}`);

  // The features as the site reads them; the rest are named and left out.
  const kept = [], dropped = [];
  for (const f of raw.fc.features) {
    const p = shape(f.properties || {}, layer);
    if (!p) { dropped.push(String((f.properties || {})[layer.label.field])); continue; }
    if (!f.geometry) { problems.push(`feature ${p.label} has no geometry`); continue; }
    kept.push({ type: 'Feature', properties: p, geometry: f.geometry });
  }
  if (dropped.length) note(`left out (label doesn't match ${layer.label.match}): ${dropped.join(', ')}`);
  if (!kept.length) problems.push('no feature has a label');
  if (layer.unique) {
    const seen = new Map();
    for (const f of kept) seen.set(f.properties.label, (seen.get(f.properties.label) || 0) + 1);
    const dup = [...seen].filter(([, n]) => n > 1).map(([l]) => l);
    if (dup.length) problems.push(`labels appear more than once: ${dup.join(', ')}`);
  }
  const dated = layer.dated_field ? raw.fc.features.map((f) => asDate((f.properties || {})[layer.dated_field])).filter(Boolean).sort().pop() || null : null;
  const full = { type: 'FeatureCollection', features: kept };

  // Simplify with shared borders (TopoJSON), so neighbours keep meeting exactly.
  const inFile = path.join(TMP, `${layer.kind}.in.geojson`);
  const outFile = path.join(TMP, `${layer.kind}.topojson`);
  fs.writeFileSync(inFile, JSON.stringify(full));
  execFileSync(MS, ['-i', inFile, `name=${layer.kind}`, '-simplify', 'dp', `interval=${SIMPLIFY}`, 'keep-shapes', '-o', outFile, 'format=topojson', `quantization=${QUANT}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  const topoText = fs.readFileSync(outFile, 'utf8');
  const topo = JSON.parse(topoText);
  const shipped = maps.fromTopo(topo, layer.kind);
  if (shipped.features.length !== kept.length) problems.push(`simplified map has ${shipped.features.length} features, expected ${kept.length}`);
  if (shipped.features.some((f) => !f.geometry)) problems.push(`a feature vanished when simplified: ${shipped.features.filter((f) => !f.geometry).map((f) => f.properties.label).join(', ')}`);
  const gz = (await import('node:zlib')).gzipSync(topoText, { level: 9 }).length;
  note(`shipped: ${kb(topoText.length)} TopoJSON (${kb(gz)} gzipped), ${shipped.features.length} features, lines within ${SIMPLIFY} m of the original`);

  // 1. The shipped map answers like the full one, away from the lines.
  const edge = edgeIndex(full);
  const rnd = rand(20261103);
  const per = Math.max(8, Math.min(60, Math.round(3000 / kept.length)));
  let samples = 0, agree = 0, near = 0;
  const deep = new Map(); // label -> {pt, d}: the deepest sample inside each feature
  const wrong = [];
  for (const f of kept) {
    const [x0, y0, x1, y1] = bbox(f.geometry);
    let got = 0;
    for (let t = 0; got < per && t < per * 400; t++) {
      const lon = x0 + rnd() * (x1 - x0), lat = y0 + rnd() * (y1 - y0);
      if (!maps.inGeometry(f.geometry, lon, lat)) continue;
      got++;
      const d = edge(lon, lat);
      const best = deep.get(f.properties.label);
      if (!best || d > best.d) deep.set(f.properties.label, { pt: [lon, lat], d, props: f.properties });
      if (d < maps.NEAR_M) near++;
      if (d <= SIMPLIFY + 2) continue;
      samples++;
      const at = maps.pointIn(shipped, lon, lat);
      if (at === f.properties.label) agree++;
      else if (wrong.length < 8) wrong.push(`${f.properties.label} at ${lon.toFixed(5)},${lat.toFixed(5)} (${d.toFixed(0)} m from a line) reads ${at}`);
    }
    if (!got) problems.push(`no sample point landed inside ${f.properties.label}`);
  }
  if (agree !== samples) problems.push(`simplified map disagrees with the original at ${samples - agree} of ${samples} points: ${wrong.join('; ')}`);
  const nearShare = (near / (samples + near || 1));
  note(`simplified vs original: ${agree} of ${samples} sample points agree (points more than ${SIMPLIFY + 2} m from a line); ${(100 * near / Math.max(1, kept.length * per)).toFixed(1)}% of all samples sit within ${maps.NEAR_M} m of a line`);

  // 2. Other official layers agree, at the deepest sample inside each feature.
  const crossChecks = [];
  for (const a of layer.agree || []) {
    const other = await fetchLayer(a.source_url);
    const ofc = { type: 'FeatureCollection', features: other.fc.features.map((f) => ({ type: 'Feature', geometry: f.geometry, properties: (() => { const p = { label: pick(f.properties || {}, a.label) }; for (const [k, spec] of Object.entries(a.props || {})) p[k] = pick(f.properties || {}, spec); return p; })() })) };
    let n = 0, ok = 0;
    const bad = [];
    for (const [label, { pt, props }] of deep) {
      n++;
      const at = maps.featuresAt(ofc, pt[0], pt[1]);
      const o = at.length === 1 ? at[0].properties : null;
      const same = !!o && (a.compare ? o.label === props[a.compare] : o.label === props.label && Object.keys(a.props || {}).every((k) => o[k] === props[k]));
      if (same) ok++; else if (bad.length < 8) bad.push(`${label}: ${o ? JSON.stringify(o) : `${at.length} features`} vs ${JSON.stringify(props)}`);
    }
    note(`agrees with ${a.what}: ${ok} of ${n} features (${other.fc.features.length} features there)`);
    if (ok !== n) problems.push(`${a.what} disagrees inside ${n - ok} features: ${bad.join('; ')}`);
    crossChecks.push({ what: a.what, source_url: a.source_url, features_checked: n, agree: ok });
  }

  // 3. Public buildings: the site's two-witness answer, the server's own, and any pinned answer.
  const tested = [];
  for (const p of points) {
    const ans = maps.answerAt(shipped, { point: { lon: p.point[0], lat: p.point[1] }, block: p.block ? { lon: p.block[0], lat: p.block[1] } : null }, { edge: layer.county ? 'blocks' : 'cuts' });
    const [sp, sb] = await Promise.all([serverAt(layer.source_url, p.point), p.block ? serverAt(layer.source_url, p.block) : Promise.resolve(null)]);
    const lab = (list) => { const ls = (list || []).map((x) => pick(x, layer.label)).filter((x) => x != null); return ls.length === 1 ? ls[0] : ls.length ? `several (${ls.join(', ')})` : null; };
    const atPoint = lab(sp), atBlock = sb ? lab(sb) : null;
    const ours = ans.at === 'in' ? ans.props.label : ans.at;
    const truth = atBlock ?? atPoint;
    const line = ans.at === 'in' ? `${ours} (${ans.by})` : ours;
    const exp = layer.expect && layer.expect[p.name];
    let verdict = 'ok';
    if (ans.at === 'in' && ours !== truth) verdict = `WRONG: the server says ${truth}`;
    else if (ans.at === 'out' && truth != null) verdict = `MISSED: the server says ${truth}`;
    if (exp != null) {
      const want = typeof exp === 'string' ? { label: exp } : exp;
      const got = ans.at === 'in' ? ans.props : {};
      const off = Object.entries(want).filter(([k, v]) => got[k] !== v);
      if (off.length) verdict = `EXPECTED ${JSON.stringify(want)}, got ${ans.at === 'in' ? JSON.stringify(got) : ans.at}`;
    }
    if (verdict !== 'ok') problems.push(`${p.name}: ${verdict}`);
    if (ans.at !== 'out' || truth != null) note(`${p.name}: ${line}${atPoint !== atBlock ? ` [server: ${atPoint} at the building, ${atBlock} at its block]` : ''}${verdict === 'ok' ? '' : `  ${verdict}`}`);
    tested.push({ name: p.name, answer: ans.at === 'in' ? ans.props : ans.at, by: ans.at === 'in' ? ans.by : null, server: truth });
  }

  if (problems.length) {
    failed++;
    console.log(`  FAILED, nothing written for ${layer.kind}:`);
    problems.forEach((s) => console.log(`    - ${s}`));
    summary.push({ kind: layer.kind, ok: false });
    continue;
  }

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${layer.kind}.topojson`), topoText);
  const meta = {
    kind: layer.kind,
    name: layer.name,
    title: layer.title,
    places: layer.places,
    ...(layer.county ? { county: layer.county } : {}),
    source_url: layer.source_url,
    source_org: layer.source_org,
    ...(raw.info.copyrightText ? { credit: raw.info.copyrightText } : {}),
    plan: layer.plan || null,
    ...(layer.plan_source ? { plan_source: layer.plan_source } : {}),
    layer_dated: dated,
    ...(layer.dated_field ? { layer_dated_from: `newest ${layer.dated_field} in the layer` } : {}),
    ...(layer.redistricted ? { redistricted: layer.redistricted } : {}),
    fetched: TODAY,
    license: layer.license || 'none stated',
    label_property: layer.label.field,
    ...(layer.props ? { props: Object.fromEntries(Object.entries(layer.props).map(([k, s]) => [k, s.field])) } : {}),
    features: shipped.features.length,
    ...(dropped.length ? { left_out: dropped } : {}),
    simplified: `Douglas-Peucker to ${SIMPLIFY} m, TopoJSON quantized to ${QUANT} steps across the map`,
    bytes: topoText.length,
    checked: {
      on: TODAY,
      simplified_vs_original: { points: samples, agree, more_than_m_from_a_line: SIMPLIFY + 2 },
      ...(crossChecks.length ? { agrees_with: crossChecks } : {}),
      public_buildings: tested.filter((t) => t.answer !== 'out' || t.server != null).map((t) => ({ name: t.name, answer: typeof t.answer === 'string' ? t.answer : t.answer.label, by: t.by })),
    },
    settles: layer.settles,
    ...(layer.shows ? { shows: layer.shows } : {}),
  };
  fs.writeFileSync(path.join(OUT, `${layer.kind}.json`), `${JSON.stringify(meta, null, 2)}\n`);
  note(`wrote data/maps/${area}/${layer.kind}.topojson and .json`);
  summary.push({ kind: layer.kind, ok: true, bytes: topoText.length, gz, raw: rawBytes, features: shipped.features.length, dated });
}
await vite.close();

console.log(`\n${area}: ${summary.map((s) => (s.ok ? `${s.kind} ${kb(s.bytes)} (${kb(s.gz)} gz; was ${kb(s.raw)})` : `${s.kind} FAILED`)).join(', ')}`);
const total = summary.filter((s) => s.ok).reduce((a, s) => a + s.bytes, 0);
const totalGz = summary.filter((s) => s.ok).reduce((a, s) => a + s.gz, 0);
console.log(`total shipped: ${kb(total)} (${kb(totalGz)} gzipped)`);
process.exit(failed ? 1 : 0);
