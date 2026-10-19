#!/usr/bin/env node
/*
 * check-addresses: fail when anything that looks like a street address appears in the
 * files we ship or keep. Rule from FOUNDATION: no real person's address anywhere.
 *
 * Official public buildings (an election office, a city hall, a vote center the state
 * itself lists) are legitimate and the guide shows several. They are allowed only by an
 * explicit entry in scripts/address-allowlist.json, each with a source URL and a reason,
 * so a new address can never slip in without a person deciding it is a public office.
 * An entry must be the whole address as the checker reads it ("118-35 Queens Boulevard",
 * "1015 Half Street SE"): a longer address that merely ends the same way is not allowed.
 *
 * Usage:
 *   node scripts/check-addresses.mjs                      # data/ (the site repo)
 *   node scripts/check-addresses.mjs PATH [PATH...]       # other folders or files, e.g. the workbench research/
 *   node scripts/check-addresses.mjs --write-baseline     # list every current hit as a draft allowlist
 *   node scripts/check-addresses.mjs --warn-only DIR      # report, exit 0 (for research/raw/)
 *   node scripts/check-addresses.mjs --self-test          # run the built-in cases; exit 1 if any is wrong
 *
 * No dependencies. Node 18+.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.VG_ROOT || path.resolve(path.dirname(SELF), '..');
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const roots = args.filter((a) => !a.startsWith('--'));
const defaultRoot = !roots.length;
if (defaultRoot) roots.push(path.join(ROOT, 'data'));
const ALLOW_FILE = path.join(ROOT, 'scripts', 'address-allowlist.json');
const allowText = fs.existsSync(ALLOW_FILE) ? fs.readFileSync(ALLOW_FILE, 'utf8').trim() : ''; // empty is fine: `--write-baseline > file` empties it before we read
const allow = allowText ? JSON.parse(allowText).allowed || [] : [];
const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const allowed = new Set(allow.map((a) => norm(a.address)));

/* ---------- the matcher ----------
   Any capitalization: "123 main street" and "123 MAIN STREET" are addresses too. What keeps
   prose from matching is the shape, not the capitals: a whole house number, one to four
   street-name words that are not everyday words, then a street word. The regexes have no `i`
   flag because one rule is about case: a LOWERCASE word ending in -ed or -ing ("39 listed road",
   "21201 polling place") is prose, while "Twisted Oak Dr" and "Rolling Hills Dr" are streets. */
const anyCase = (words) => words.slice().sort((a, b) => b.length - a.length)
  .map((w) => w.replace(/[A-Za-z]/g, (c) => `[${c.toUpperCase()}${c.toLowerCase()}]`).replace(/\./g, '\\.')).join('|');
const DESIG = `(?:${anyCase(['Street', 'St', 'Avenue', 'Ave', 'Boulevard', 'Blvd', 'Road', 'Rd', 'Drive', 'Dr', 'Lane', 'Ln', 'Court', 'Ct', 'Place', 'Pl', 'Parkway', 'Pkwy', 'Way', 'Highway', 'Hwy', 'Circle', 'Cir', 'Terrace', 'Ter', 'Trail', 'Trl', 'Square', 'Sq', 'Plaza', 'Pike'])})`;
// Longest first, and never followed by another letter: "SW" is SW, not S plus a stray W.
const DIR = `(?:${anyCase(['N.E.', 'N.W.', 'S.E.', 'S.W.', 'Northeast', 'Northwest', 'Southeast', 'Southwest', 'North', 'South', 'East', 'West', 'NE', 'NW', 'SE', 'SW', 'N', 'S', 'E', 'W'])})\\.?(?![A-Za-z])`;
// A whole house number, halves included ("2425-1/2", "10918 1/2"): never the tail of a longer number
// ("118-35", "I-55", "15212-9998"), a price, a decimal, a fraction or a clock time.
const HOUSE = '(?<![\\w$.,/:-])\\d{1,6}(?:-\\d{1,5})?(?:[- ]\\d\\/\\d)?[A-Za-z]?(?![\\w/-])';
// Everyday words a street name never contains, in any case. They stop "adds 2 new lanes to the highway",
// "40 either way", "6 PM CT" (Central Time, not Court), "20008 near Connecticut Avenue", "5 until Orangethorpe Avenue".
const STOP = `(?:${anyCase(['a', 'an', 'and', 'or', 'nor', 'but', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'from', 'with', 'per', 'as', 'is', 'are', 'was', 'were', 'be', 'been',
  'take', 'takes', 'took', 'its', 'it', 'their', 'his', 'her', 'our', 'your', 'my', 'this', 'that', 'these', 'those', 'than', 'then', 'into', 'onto', 'about', 'after',
  'before', 'between', 'through', 'against', 'until', 'where', 'when', 'which', 'who', 'near', 'either', 'neither', 'any', 'other', 'no', 'not', 'each', 'every', 'more', 'less',
  'most', 'percent', 'ago', 'am', 'pm', 'a.m.', 'p.m.'])})(?![A-Za-z])`;
// Words that are prose in lowercase but real street names when capitalized ("1016 The Meadows Pkwy",
// "3955 W. D. Judge Dr.", "12500 Will Clayton Pkwy", "Thousand Oaks Blvd"), plus lowercase -ed and -ing words ("39 listed road",
// "21201 polling place", while "Twisted Oak Dr" and "Rolling Hills Dr" still count).
const PROSE_LOWER = `(?:the|will|over|under|million|billion|thousand|hundred|years?|months?|weeks?|days?|hours?|minutes?|times|seats?|votes?|members?|judges?|people|voters|cents|dollars|elections?|candidates?|office|[a-z]{3,}ed|[a-z]{4,}ing)(?![A-Za-z])`;
// A street-name word: an initial ("F."), a short capitalized abbreviation ("So.", "Ft.", "Jr."), an ordinal,
// or a word (inner hyphens and periods allowed, "BRd.way"; a period at the end is a sentence ending, not a word).
const WORD = `(?!${STOP})(?!${PROSE_LOWER})(?:[A-Za-z]\\.|[A-Z][a-z]{1,2}\\.|\\d{1,3}(?:st|nd|rd|th)|[A-Za-z][A-Za-z'’]*(?:[-.][A-Za-z]+)*)`;
// number + (direction) + 1-4 street-name words + street word + (direction)
const STREET = new RegExp(`${HOUSE}\\s+(?:${DIR}\\s+)?${WORD}(?:\\s+${WORD}){0,3}\\s+${DESIG}(?![A-Za-z])\\.?(?:\\s+${DIR})?`, 'g');
// PO boxes, and apartment or unit numbers with a number (a bare "Suite" in prose is not a hit)
const BOX = /\b(?:P\.?\s?O\.?\s+Box\s+\d+|(?:Apt|Apartment|Unit)\.?\s+#?\d[\w-]{0,5}\b)/gi;
// "City, ST 12345" tails, with a house number in front
const TAIL = new RegExp(`${HOUSE}\\s+[A-Za-z0-9. ']{3,40},\\s*[A-Z]{2}\\s+\\d{5}(?:-\\d{4})?\\b`, 'g');
// A judicial body is a false alarm only when the match itself ends in it ("2024 Texas Supreme Court",
// or "Court" followed straight away by "of"). Nothing around the match can excuse it.
const JUDICIAL_TAIL = /\b(?:Supreme|Circuit|District|State|Commissioners|Superior|Appeals?|Appellate|Municipal|Criminal|Civil|Family|Probate|Juvenile|County|Traffic|Housing|Justice|Federal|Claims|Tax|Drug|Business)\s+(?:Court|Ct)\.?$/i;
// A hit near these words is about a person's home. Never allowlistable, never excused.
const PERSONAL = /\b(?:home|residence|resides?|lives?\s+(?:at|on|in)|domicile|mailing address of|her address|his address|their address)\b/i;

function scan(text) {
  const out = [];
  const seen = new Set();
  for (const re of [STREET, BOX, TAIL]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const s = m[0].replace(/\s+/g, ' ').trim();
      const end = m.index + m[0].length;
      const ctx = text.slice(Math.max(0, m.index - 80), end + 80);
      const personal = PERSONAL.test(ctx);
      const excused = re === STREET && (JUDICIAL_TAIL.test(s) || (/\b(?:Court|Ct)\.?$/i.test(s) && /^\s+of\b/i.test(text.slice(end, end + 5))));
      if (excused && !personal) continue;
      const key = norm(s);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ address: s, personal, ctx: ctx.replace(/\s+/g, ' ') });
    }
  }
  return out;
}
const verdict = (h) => (h.personal ? 'personal' : allowed.has(norm(h.address)) ? 'allowed' : 'blocked');

/* ---------- self-test: the failing cases from the Codex review (2026-10-19), and the false alarms we must not raise ---------- */
if (flag('--self-test')) {
  const CASES = [
    // [text, expected worst verdict: clean | allowed | blocked | personal]
    ['NYC Board of Elections, Queens borough office: 118-35 Queens Boulevard, 11th Floor', 'allowed'],
    ['999-35 Queens Boulevard', 'blocked'], // Codex: matched the allowlisted tail "35 Queens Boulevard"
    ['DC Board of Elections (DCBOE), 1015 Half Street SE', 'allowed'],
    ['1015 Half Street SW', 'blocked'], // Codex: matched the allowlisted "1015 Half Street S"
    ['Lives at 123 Main Street, District Court', 'personal'], // Codex: nearby court wording hid it
    ['123 Main Street, District Court', 'blocked'],
    ['123 main street', 'blocked'], // Codex: lowercase slipped through
    ['123 MAIN STREET', 'blocked'],
    ['she moved to 4521 oak hollow dr. last year', 'blocked'],
    ['Mail it to P.O. Box 1234.', 'blocked'],
    ['Apt 4B', 'blocked'],
    ['4946 S. Drexel Blvd.', 'allowed'],
    ['200 W. 14th Ave.', 'allowed'],
    ['1400 John F. Kennedy Blvd.', 'allowed'],
    ['725 Northwest Plaza Dr.', 'allowed'],
    ['The 2024 Texas Supreme Court ruling stands.', 'clean'],
    ['Justice, 3rd Court of Appeals, Place 2', 'clean'],
    ['The plan adds 2 new lanes to the highway.', 'clean'],
    ['It fills 3 seats on the court.', 'clean'],
    ['Terms last 6 years. Court rules apply.', 'clean'],
    ['Costs $400 Main Street merchants nothing.', 'clean'],
    // false alarms found when the check went case-blind, in the real data on 2026-10-19
    ['Polls close at 7:00 PM CT.', 'clean'],
    ['Early voting runs 8 AM to 6 PM CT.', 'clean'],
    ['If you care about Prop 40 either way, vote on 41 too.', 'clean'],
    ['spend up to $82 million on 39 listed road, bridge and drainage projects', 'clean'],
    ['in 2024 backed expanded street outreach', 'clean'],
    ['every 21201 polling place is in District 7', 'clean'],
    ['A sliver of 20008 near Connecticut Avenue is Ward 1.', 'clean'],
    // ...while capitalized streets with those word shapes still count
    ['1500 Twisted Oak Dr', 'blocked'],
    ['88 Rolling Hills Drive', 'blocked'],
    ['2100 Martin Luther King Jr. Blvd', 'blocked'],
    // from the research/ comparison, old checker vs this one (2026-10-19): real addresses...
    ['Engine House 2425-1/2 Annapolis Road Baltimore', 'blocked'],
    ['Community Center | 10918 1/2 Bentley St. | Houston', 'blocked'],
    ['Gym 1016 The Meadows Pkwy DESOTO 75115', 'blocked'],
    ['Neighborhood Center, 3955 W. D. Judge Dr. |', 'blocked'],
    ['Activity Center 506 So. Frederick Avenue, Gaithersburg', 'blocked'],
    ['8301 SCOTTS LEVEL RD', 'blocked'],
    ['1300 Yards Pl. SE', 'blocked'],
    ['Library, 6115 Will Clayton Pkwy. Humble', 'blocked'],
    ['Precinct 2950 BRd.way Blvd. Garland', 'blocked'],
    // ...and number tails and prose that are not
    ['killed in a crash on I-55 Second St. Charles official', 'clean'],
    ['Position M-40 Tiffany Koyama Lane M-54', 'clean'],
    ['95.6 Meadows Place (4%) Total: 205', 'clean'],
    ['The 2026 general election takes place Nov 3.', 'clean'],
    ['lost in 2018 against Republican Milton Street', 'clean'],
  ];
  const rank = { clean: 0, allowed: 1, blocked: 2, personal: 3 };
  let bad = 0;
  for (const [text, want] of CASES) {
    const hits = scan(text);
    const got = hits.reduce((w, h) => (rank[verdict(h)] > rank[w] ? verdict(h) : w), 'clean');
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  want ${want.padEnd(8)} got ${got.padEnd(8)} ${JSON.stringify(text)}${hits.length ? `  [${hits.map((h) => h.address).join(' | ')}]` : ''}`);
  }
  console.log(`check-addresses self-test: ${CASES.length - bad} of ${CASES.length} cases right.`);
  process.exit(bad ? 1 : 0);
}

/* ---------- scan the files ---------- */
const TEXT_EXT = new Set(['.json', '.md', '.txt', '.csv', '.html', '.ts', '.mjs', '.css', '.yml', '.yaml', '.sh']);
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (TEXT_EXT.has(path.extname(e.name))) yield p;
  }
}

const hits = [];
for (const root of roots) {
  if (!fs.existsSync(root)) { console.error(`check-addresses: ${root} does not exist`); process.exit(2); }
  const isDir = fs.statSync(root).isDirectory();
  const files = isDir ? [...walk(root)] : TEXT_EXT.has(path.extname(root)) ? [root] : [];
  for (const f of files) {
    if (path.resolve(f) === SELF) continue; // this file's own test cases are fake addresses on purpose
    for (const h of scan(fs.readFileSync(f, 'utf8'))) hits.push({ ...h, file: isDir ? path.relative(root, f) : f });
  }
}

if (flag('--write-baseline')) {
  const uniq = new Map();
  for (const h of hits) uniq.set(norm(h.address), { address: h.address, reason: 'REVIEW: official public building? add the source URL or delete the line from the data', source: '' });
  console.log(JSON.stringify({ allowed: [...uniq.values()] }, null, 2));
  process.exit(0);
}

const bad = hits.filter((h) => verdict(h) !== 'allowed');
for (const h of bad) console.log(`${h.personal ? 'PERSONAL' : 'ADDRESS '}  ${h.file}: "${h.address}"\n          ...${h.ctx}...`);
console.log(`check-addresses: ${hits.length} address-like strings, ${hits.length - bad.length} allowlisted, ${bad.length} not allowed.`);
if (defaultRoot) {
  const used = new Set(hits.map((h) => norm(h.address)));
  const stale = allow.filter((a) => !used.has(norm(a.address)));
  if (stale.length) console.log(`note: ${stale.length} allowlist entries match nothing in data/ any more (remove them when convenient): ${stale.map((a) => a.address).join(' | ')}`);
}
if (bad.length && !flag('--warn-only')) {
  console.log('To allow an official public building, add it to scripts/address-allowlist.json with its source URL. A person\'s address is never allowed: delete it from the data.');
  process.exit(1);
}
