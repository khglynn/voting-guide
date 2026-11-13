#!/usr/bin/env node
/* The laptop runner (PLAN-PHASE-1 section 2.5): the same module the Worker runs, under node.
   node bin/run.mjs --source travis-tx            read one source, print the read's summary and the items it would publish
   node bin/run.mjs --tick                        one whole tick against a local store (.local/store), like the cron
   node bin/run.mjs --source travis-tx --write    write to the real KV: only while the KV `stop` flag is set, so there
                                                  is one writer at a time (needs CLOUDFLARE_API_TOKEN for the personal
                                                  account; uses wrangler) */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { loadMaps, fileStore, folderArchive, flags, ROOT } from './lib.mjs';
import { ADAPTERS } from '../src/adapters/index.js';
import { checkRead } from '../src/checks.js';
import { sourceSlices } from '../src/merge.js';
import { runTick } from '../src/tick.js';

const f = flags(process.argv.slice(2));
const maps = loadMaps();
const now = new Date().toISOString();

function kvStore() {
  const ns = '5e0114f76ee44cfeaeba98ff932bc288';
  const w = (args, input) => execFileSync('npx', ['wrangler', 'kv', 'key', ...args, '--namespace-id', ns, '--remote'], { cwd: ROOT, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return {
    async get(k) { try { return w(['get', k]).replace(/\n$/, '') || null; } catch { return null; } },
    async put(k, v, o = {}) { w(['put', k, String(v), ...(o.expirationTtl ? ['--ttl', String(o.expirationTtl)] : [])]); },
    async delete(k) { w(['delete', k]); },
  };
}

if (f.write) {
  const kv = kvStore();
  if (!(await kv.get('stop'))) { console.error('run: --write works only while the KV stop flag is set (npx wrangler kv key put stop 1 --namespace-id ... --remote).'); process.exit(1); }
  const out = await runTick({ fetch, store: kv, archive: null, maps, now, only: f.source || null });
  console.log(JSON.stringify(out, null, 2));
} else if (f.tick || !f.source) {
  const store = fileStore(path.join(ROOT, '.local', 'store'));
  const out = await runTick({ fetch, store, archive: folderArchive(path.join(ROOT, '.local', 'archive')), maps, now, only: f.source || null, ping: async (s, r, t) => { console.log(`(ping) ${s} ${r}: ${t}`); return false; } });
  console.log(JSON.stringify(out, null, 2));
} else {
  const map = maps.find((m) => m.id === f.source);
  if (!map) { console.error(`no map ${f.source}`); process.exit(1); }
  const r = await ADAPTERS[map.feed.adapter].read({ fetch, map });
  if (r.verdict !== 'ok') { console.log(r); process.exit(1); }
  const { raw, ...read } = r;
  const c = checkRead(read, map, null);
  console.log(`${map.name}: ${read.election.name} (${read.election.id}, ${read.election.date}); updated ${read.source_updated}; ${read.contests.length} contests; ${read.reporting || 'no reporting line'}`);
  console.log(`checks: ${c.ok ? 'ok' : 'BLOCKED'} ${c.problems.map((p) => `${p.reason}: ${p.detail}`).join('; ')}`);
  const { status, slices, problems } = sourceSlices(read, map, now);
  console.log(`status ${status}; ${Object.keys(slices).length} items; ${problems.length} problems`);
  for (const [id, s] of Object.entries(slices)) console.log(`  ${id}: ${s.status} ${s.reporting || ''} ${(s.candidates || []).map((x) => `${x.name} ${x.votes}`).join(', ')}${s.measure ? `yes ${s.measure.yes} no ${s.measure.no}` : ''}`);
  for (const p of problems) console.log(`  problem: ${p.reason}: ${p.detail}`);
}
