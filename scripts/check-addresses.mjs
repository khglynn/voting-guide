#!/usr/bin/env node
/*
 * check-addresses: fail when anything that looks like a street address appears in the
 * files we ship or keep. Rule from FOUNDATION: no real person's address anywhere.
 *
 * Official public buildings (an election office, a city hall, a vote center the state
 * itself lists) are legitimate and the guide shows several. They are allowed only by an
 * explicit entry in scripts/address-allowlist.json, each with a source URL and a reason,
 * so a new address can never slip in without a person deciding it is a public office.
 *
 * Usage:
 *   node scripts/check-addresses.mjs                      # data/ (the site repo)
 *   node scripts/check-addresses.mjs DIR [DIR...]         # other roots, e.g. the workbench research/
 *   node scripts/check-addresses.mjs --write-baseline     # list every current hit as a draft allowlist
 *   node scripts/check-addresses.mjs --warn-only DIR      # report, exit 0 (for research/raw/)
 *
 * No dependencies. Node 18+.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.VG_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const roots = args.filter((a) => !a.startsWith('--'));
if (!roots.length) roots.push(path.join(ROOT, 'data'));
const ALLOW_FILE = path.join(ROOT, 'scripts', 'address-allowlist.json');
const allowText = fs.existsSync(ALLOW_FILE) ? fs.readFileSync(ALLOW_FILE, 'utf8').trim() : ''; // empty is fine: `--write-baseline > file` empties it before we read
const allow = allowText ? JSON.parse(allowText).allowed || [] : [];
const allowed = new Set(allow.map((a) => a.address.toLowerCase().replace(/\s+/g, ' ')));

const DESIG = '(?:St(?:reet)?|Ave(?:nue)?|Blvd|Boulevard|Rd|Road|Dr(?:ive)?|Ln|Lane|Ct|Court|Pl(?:ace)?|Pkwy|Parkway|Way|Hwy|Highway|Cir(?:cle)?|Ter(?:race)?|Trl|Trail|Sq(?:uare)?|Plaza|Pike)';
const DIR = '(?:[NSEW]|NE|NW|SE|SW|North|South|East|West)\\.?';
// 1) number + (direction) + 1-4 capitalised words / ordinals + street designator
const STREET = new RegExp(`\\b\\d{1,5}\\s+(?:${DIR}\\s+)?(?:[A-Z][A-Za-z.']+|\\d{1,3}(?:st|nd|rd|th))(?:\\s+(?:[A-Z][A-Za-z.']+|\\d{1,3}(?:st|nd|rd|th))){0,3}\\s+${DESIG}\\b\\.?(?:\\s+(?:${DIR}))?`, 'g');
// 2) PO boxes, and apartment or unit numbers with a number (a bare "Suite" in prose is not a hit)
const BOX = /\b(?:P\.?\s?O\.?\s+Box\s+\d+|(?:Apt|Apartment|Unit)\.?\s+#?\d[\w-]{0,5}\b)/gi;
// 3) "City, ST 12345" tails: only counts as an address if a number+word precedes within 40 chars
const TAIL = /\b\d{1,5}\s+[A-Za-z0-9. ']{3,40},\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/g;
// Words that make a "Court" or "Place" hit a false alarm (judicial bodies, years).
const NOT_ADDRESS = /\b(?:Supreme|Circuit|District|Superior|Appeals?|Appellate|Municipal|Criminal|Civil|Family|Probate|Juvenile|County|Traffic|Housing)\s+Court\b|\b(?:19|20)\d{2}\s+[A-Z][a-z]+\s+(?:Supreme|Circuit|Superior)\b|\bCourt of\b/;
// A hit near these words is about a person's home. Never allowlistable.
const PERSONAL = /\b(?:home|residence|resides?|lives?\s+(?:at|on|in)|domicile|mailing address of|her address|his address|their address)\b/i;

const TEXT_EXT = new Set(['.json', '.md', '.txt', '.csv', '.html', '.ts', '.mjs', '.css']);
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
  const files = fs.statSync(root).isDirectory() ? [...walk(root)] : [root];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const seen = new Set();
    for (const re of [STREET, BOX, TAIL]) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        const s = m[0].replace(/\s+/g, ' ').trim();
        if (NOT_ADDRESS.test(text.slice(Math.max(0, m.index - 20), m.index + s.length + 20))) continue;
        const key = `${f}::${s.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const ctx = text.slice(Math.max(0, m.index - 80), m.index + s.length + 80);
        hits.push({ file: path.relative(root, f) || path.basename(f), address: s, personal: PERSONAL.test(ctx), ctx: ctx.replace(/\s+/g, ' ') });
      }
    }
  }
}

if (flag('--write-baseline')) {
  const uniq = new Map();
  for (const h of hits) uniq.set(h.address.toLowerCase(), { address: h.address, reason: 'REVIEW: official public building? add the source URL or delete the line from the data', source: '' });
  console.log(JSON.stringify({ allowed: [...uniq.values()] }, null, 2));
  process.exit(0);
}

const bad = hits.filter((h) => h.personal || !allowed.has(h.address.toLowerCase()));
for (const h of bad) console.log(`${h.personal ? 'PERSONAL' : 'ADDRESS '}  ${h.file}: "${h.address}"\n          ...${h.ctx}...`);
console.log(`check-addresses: ${hits.length} address-like strings, ${hits.length - bad.length} allowlisted, ${bad.length} not allowed.`);
if (bad.length && !flag('--warn-only')) {
  console.log('To allow an official public building, add it to scripts/address-allowlist.json with its source URL. A person\'s address is never allowed: delete it from the data.');
  process.exit(1);
}
