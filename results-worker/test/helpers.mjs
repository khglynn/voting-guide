/* A fake fetch over the saved feed snapshots in test/fixtures (real reads from Nov 3, 2026, zeros and all). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const fixture = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');

/* routes: { 'url substring': fileName | { status, body, headers } | (req) => Response-like }. Records every request. */
export function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, headers: opts.headers || {} });
    for (const [k, v] of Object.entries(routes)) {
      if (!url.includes(k)) continue;
      const spec = typeof v === 'function' ? v(url, opts) : typeof v === 'string' ? { status: 200, body: fixture(v) } : v;
      const headers = new Map(Object.entries(spec.headers || {}).map(([a, b]) => [a.toLowerCase(), b]));
      return { status: spec.status, ok: spec.status >= 200 && spec.status < 300, headers: { get: (h) => headers.get(h.toLowerCase()) ?? null }, text: async () => spec.body ?? '' };
    }
    return { status: 404, ok: false, headers: { get: () => null }, text: async () => 'not found' };
  };
  fn.calls = calls;
  return fn;
}

export function memStore(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); } };
}

export const mapFor = (id) => JSON.parse(fs.readFileSync(path.join(FIX, '..', '..', 'maps', `${id}.json`), 'utf8'));
