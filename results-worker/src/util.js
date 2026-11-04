/* Small helpers shared by the Worker and the laptop runner. Plain JavaScript: crypto.subtle and TextEncoder exist in
   both Cloudflare Workers and Node 20+, and nothing here touches Node or Workers globals beyond those. */

export const ELECTION = '2026-11-03';

export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* JSON with keys sorted, so the same object always hashes the same. */
export function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

const ZONES = { EST: -5, EDT: -4, CST: -6, CDT: -5, MST: -7, MDT: -6, PST: -8, PDT: -7, AKST: -9, AKDT: -8, HST: -10, UTC: 0, GMT: 0 };

/* Clarity's "10/1/2026 4:06:32 PM CDT" (or without seconds or zone) to ISO UTC. A zone it doesn't name falls back to
   `fallbackOffset` hours; returns null for anything it can't read rather than guessing. */
export function parseUsTime(s, fallbackOffset = null) {
  const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?\s*([A-Z]{2,4})?$/i);
  if (!m) return null;
  let [, mo, d, y, h, mi, sec, ap, zone] = m;
  h = Number(h);
  if (ap) { ap = ap.toUpperCase(); if (ap === 'PM' && h < 12) h += 12; if (ap === 'AM' && h === 12) h = 0; }
  const off = zone ? ZONES[zone.toUpperCase()] : fallbackOffset;
  if (off === undefined || off === null) return null;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), h - off, Number(mi), Number(sec || 0));
  return new Date(ms).toISOString();
}

/* "11/3/2026" or "November 03, 2026" or "2026-11-03" to "2026-11-03"; null when unreadable. */
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
export function isoDate(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = t.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) { const i = MONTHS.indexOf(m[1].toLowerCase()); if (i >= 0) return `${m[3]}-${String(i + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
  return null;
}

/* A banner that carries a count of what has reported: Travis's "Unofficial Results 0/201 Vote Centers Reporting" beside
   254,511 counted votes, Williamson's unfilled template "X of X Vote Centers Completely Reported", "15%". Progress words
   come only from a source's own precinct fields, under the rule that hides "0 of N" once votes are in, so a banner like
   these is dropped whole (overnight review, Nov 3). A date such as "11/4/2026" is not a count. */
export const hasProgressCount = (t) => /(?<![\/\d])\b(?:\d[\d,]*|x)\s*(?:of|\/)\s*(?:\d[\d,]*|x)\b(?!\s*\/)/i.test(String(t || '')) || /\d\s*%/.test(String(t || ''));

export const isWhole = (n) => Number.isInteger(n) && n >= 0;

/* Percent of a total, two decimals, from unrounded counts. Zero total gives 0, never NaN. */
export const pctOf = (n, total) => (total > 0 ? Math.round((n / total) * 10000) / 100 : 0);

export const norm = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();

/* Hours and minutes in a time zone, for quiet hours. */
export function localHour(iso, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(iso));
  return Number(parts.find((p) => p.type === 'hour').value);
}
