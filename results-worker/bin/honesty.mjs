#!/usr/bin/env node
/* Honesty checks on a live published file (coordinator's list, Nov 3): the schema and percentages; no outcome on a
   count that isn't complete; spanning races carry slices, the top numbers equal one slice (never a sum) and no final;
   write-in notes on the races that need them; link_only items have a reason and no numbers; no falling-total note
   unless one was pinged; and the file served by workers.dev equals what KV holds (with --kv, via wrangler).
   Usage: node bin/honesty.mjs [ST] [--kv] [--preview] */
import { execFileSync } from 'node:child_process';
import { checkFile } from '../src/checks.js';
import { flags, ROOT, loadMaps } from './lib.mjs';
import { sha256 } from '../src/util.js';

const f = flags(process.argv.slice(2));
const st = f._[0] || 'TX';
const url = `https://vg-results.kevinhg.workers.dev/results/${f.preview ? 'preview/' : ''}2026-11-03/${st}.json`;
const body = await (await fetch(`${url}?honesty=${Date.now()}`, { signal: AbortSignal.timeout(60_000) })).text();
const file = JSON.parse(body);
const out = [];
const bad = (s) => out.push(s);
if (file.test) bad('this is still the hand-written test file');
for (const p of checkFile(file)) bad(`schema: ${p}`);
const noted = new Set(loadMaps().flatMap((m) => m.contests.filter((c) => c.note).map((c) => `${m.id}|${c.item}`)));
const counts = { counting: 0, pending: 0, complete: 0, official: 0, link_only: 0, spanning: 0 };
for (const [id, x] of Object.entries(file.items)) {
  counts[x.status]++;
  if (x.final && !['complete', 'official'].includes(x.status)) bad(`${id}: final on a ${x.status} count`);
  if (x.slices) {
    counts.spanning++;
    if (x.final) bad(`${id}: spanning race with a final`);
    const top = x.slices.find((s) => s.source === x.source);
    if (!top || top.total_votes !== x.total_votes) bad(`${id}: top-level numbers aren't the named slice's`);
    const sum = x.slices.reduce((a, s) => a + s.total_votes, 0);
    if (x.slices.filter((sl) => sl.total_votes > 0).length > 1 && x.total_votes === sum) bad(`${id}: top total equals the sum of slices`);
  }
  const from = x.slices ? x.slices.map((sl) => sl.source) : [x.source];
  if (x.status !== 'link_only' && from.some((src) => noted.has(`${src}|${id}`)) && !x.note) bad(`${id}: a map note is missing`);
  if (x.status === 'link_only' && (!x.reason || x.candidates || x.measure)) bad(`${id}: link_only without a reason, or with numbers`);
  if (/fell from/.test(x.note || '')) bad(`${id}: falling-total note: ${x.note}`);
}
if (f.kv) {
  const kv = execFileSync('npx', ['wrangler', 'kv', 'key', 'get', `${f.preview ? 'preview' : 'file'}:${st}`, '--namespace-id', '5e0114f76ee44cfeaeba98ff932bc288', '--remote'], { cwd: ROOT, encoding: 'utf8' }).replace(/\n$/, '');
  if ((await sha256(kv)) !== (await sha256(body))) bad(`workers.dev served a different body than KV holds (generated ${file.generated} vs ${JSON.parse(kv).generated}; a 30 s cache can explain a newer KV)`);
  else console.log('read-back: workers.dev body equals KV');
}
console.log(`${url}: generated ${file.generated}; sources ${file.sources.map((s) => `${s.id}=${s.status}${s.note ? `(${s.note})` : ''}`).join(', ')}`);
console.log(`items ${Object.keys(file.items).length}: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(out.length ? `PROBLEMS (${out.length}):\n  ${out.join('\n  ')}` : 'honesty checks: clean');
process.exit(out.length ? 1 : 0);
