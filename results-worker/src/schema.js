/* The results file's shape (DIRECTION.md, "The results file"), checked before anything is published. Shared with the
   site's tests: no imports, plain JavaScript. Returns a list of problems; an empty list means the file may go out. */

const STATUS = ['pending', 'counting', 'complete', 'official', 'link_only'];
const SRC_STATUS = ['pending', 'counting', 'complete', 'official', 'failing', 'refused', 'link_only'];
const isWhole = (n) => Number.isInteger(n) && n >= 0;
const isStr = (s) => typeof s === 'string' && s.length > 0;
const isIsoOrNull = (s) => s === null || s === undefined || (typeof s === 'string' && !Number.isNaN(Date.parse(s)));

function checkNumbers(where, x, out) {
  if (x.candidates !== undefined) {
    if (!Array.isArray(x.candidates)) out.push(`${where}: candidates is not a list`);
    else for (const c of x.candidates) {
      if (!isStr(c.name)) out.push(`${where}: a candidate has no name`);
      if (!isWhole(c.votes)) out.push(`${where}: ${c.name} votes ${c.votes} is not a whole number`);
      if (typeof c.pct !== 'number' || c.pct < 0 || c.pct > 100) out.push(`${where}: ${c.name} pct ${c.pct} is out of range`);
    }
  }
  if (x.measure !== undefined && x.measure !== null) {
    const m = x.measure;
    if (!isWhole(m.yes) || !isWhole(m.no)) out.push(`${where}: measure counts are not whole numbers`);
    if (typeof m.yes_pct !== 'number' || m.yes_pct < 0 || m.yes_pct > 100) out.push(`${where}: yes_pct out of range`);
  }
}

export function validateResultsFile(f) {
  const out = [];
  if (!f || typeof f !== 'object') return ['not an object'];
  if (f.election !== '2026-11-03') out.push(`election is ${f.election}, not 2026-11-03`);
  if (!/^[A-Z]{2}$/.test(f.state || '')) out.push('state is not a two-letter code');
  if (!isStr(f.generated) || Number.isNaN(Date.parse(f.generated))) out.push('generated is not a time');
  if (!Array.isArray(f.sources)) out.push('sources is not a list');
  else for (const s of f.sources) {
    if (!isStr(s.id) || !isStr(s.name) || !isStr(s.url)) out.push(`source ${s.id}: id, name or url missing`);
    if (!SRC_STATUS.includes(s.status)) out.push(`source ${s.id}: status ${s.status}`);
    if (!isIsoOrNull(s.updated) || !isIsoOrNull(s.fetched)) out.push(`source ${s.id}: a time is unreadable`);
  }
  if (!f.items || typeof f.items !== 'object' || Array.isArray(f.items)) out.push('items is not an object');
  else for (const [id, x] of Object.entries(f.items)) {
    const w = `item ${id}`;
    if (!isStr(x.source)) out.push(`${w}: no source`);
    if (!STATUS.includes(x.status)) out.push(`${w}: status ${x.status}`);
    if (!isStr(x.url) || !/^https:\/\//.test(x.url)) out.push(`${w}: url is not https`);
    if (!isIsoOrNull(x.updated)) out.push(`${w}: updated unreadable`);
    if (x.final && x.status !== 'complete' && x.status !== 'official') out.push(`${w}: a final result on a count that isn't complete`);
    if (x.status === 'link_only' && (x.candidates || x.measure)) out.push(`${w}: link_only with numbers`);
    checkNumbers(w, x, out);
    for (const sl of x.slices || []) {
      if (!isStr(sl.source) || !isStr(sl.county)) out.push(`${w}: a slice has no source or county`);
      if (!STATUS.includes(sl.status)) out.push(`${w}: slice status ${sl.status}`);
      checkNumbers(`${w} slice ${sl.source}`, sl, out);
    }
    if (x.slices && x.final) out.push(`${w}: a race spanning sources has a final result`);
  }
  return out;
}
