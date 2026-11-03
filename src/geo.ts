/* ZIP prefix to state, and the optional Census address lookup. */

/* First three ZIP digits to state (USPS prefix ranges). Used only to say "we only have
   statewide races for your area" or "we don't cover your state yet". */
const RANGES: [number, number, string][] = [
  [5, 5, 'NY'], [6, 9, 'PR'], [10, 27, 'MA'], [28, 29, 'RI'], [30, 38, 'NH'], [39, 49, 'ME'], [50, 59, 'VT'],
  [60, 69, 'CT'], [70, 89, 'NJ'], [100, 149, 'NY'], [150, 196, 'PA'], [197, 199, 'DE'], [200, 200, 'DC'],
  [201, 201, 'VA'], [202, 205, 'DC'], [206, 219, 'MD'], [220, 246, 'VA'], [247, 268, 'WV'], [270, 289, 'NC'],
  [290, 299, 'SC'], [300, 319, 'GA'], [320, 339, 'FL'], [341, 342, 'FL'], [344, 344, 'FL'], [346, 347, 'FL'],
  [349, 349, 'FL'], [350, 369, 'AL'], [370, 385, 'TN'], [386, 397, 'MS'], [398, 399, 'GA'], [400, 427, 'KY'],
  [430, 459, 'OH'], [460, 479, 'IN'], [480, 499, 'MI'], [500, 528, 'IA'], [530, 549, 'WI'], [550, 567, 'MN'],
  [569, 569, 'DC'], [570, 577, 'SD'], [580, 588, 'ND'], [590, 599, 'MT'], [600, 629, 'IL'], [630, 658, 'MO'],
  [660, 679, 'KS'], [680, 693, 'NE'], [700, 714, 'LA'], [716, 729, 'AR'], [730, 732, 'OK'], [733, 733, 'TX'],
  [734, 749, 'OK'], [750, 799, 'TX'], [800, 816, 'CO'], [820, 831, 'WY'], [832, 838, 'ID'], [840, 847, 'UT'],
  [850, 865, 'AZ'], [870, 884, 'NM'], [885, 885, 'TX'], [889, 898, 'NV'], [900, 961, 'CA'], [967, 968, 'HI'],
  [969, 969, 'GU'], [970, 979, 'OR'], [980, 994, 'WA'], [995, 999, 'AK'],
];
export function zipState(zip: string): string | null {
  if (!/^\d{5}$/.test(zip)) return null;
  const p = Number(zip.slice(0, 3));
  const r = RANGES.find(([a, b]) => p >= a && p <= b);
  return r ? r[2] : null;
}

/* Full names for every postal code the ZIP lookup can return, so "We don't cover Montana yet"
   never prints "MT". */
const NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'Washington, DC', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico', GU: 'Guam',
};
export const stateName = (code: string): string => NAMES[code] || code;

export interface GeoResult {
  matched: string;           // the address as Census matched it (shown back, never stored)
  state: string | null;      // two-letter
  county: string | null;     // "Travis"
  /* The county's Census code, state then county ("29510"), and its full name ("St. Louis County", "the City of
     St. Louis"). The Census gives the City of St. Louis and the county beside it one short name, "St. Louis"
     (Baltimore too), so only the code tells them apart (Oct 29, outsideOf). */
  countyId?: string | null;
  countyName?: string | null;
  place: string | null;      // "Austin"
  cd: number | null;         // congressional district
  upper: number | null;      // state senate
  lower: number | null;      // state house
  zip?: string | null;       // the ZIP Census matched (its ZCTA layer, else the end of the matched address)
  schools?: string[];        // its school districts, as the Census names them ("Austin Independent School District")
  /* Where the Census put the address, and its 2020 block's interior point: the two witnesses the
     district maps are checked at (model/maps.ts). Kept in memory for this lookup only, never stored,
     never sent anywhere. */
  point?: { lon: number; lat: number } | null;
  block?: { lon: number; lat: number } | null;
}

const STATE_FIPS: Record<string, string> = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL',
  '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME',
  '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH',
  '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI',
  '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI',
  '56': 'WY', '72': 'PR',
};

/* A place's own: what the index (and a place bundle) says about where its voters live. */
type PlaceLike = { label: string; state: string; county_fips?: string[]; zip_outside?: Record<string, string> };

/* An address the Census puts outside this place: the place names its Census county codes and the address's
   county isn't one of them (Oct 29: a Pine Lawn address in 63120 is St. Louis County's, 29189, never the
   City's, 29510). With no code on either side, nothing is ruled out. */
export const outsideOf = (p: PlaceLike | undefined, r: GeoResult): boolean =>
  !!p && !!p.county_fips && p.county_fips.length > 0 && !!r.countyId && !p.county_fips.includes(r.countyId);

/* A place as a sentence names it: "Brooklyn", "Baltimore City", and "the City of St. Louis" where the label
   alone would read like the county beside it. */
export function placeName(p: { label: string; counties?: string[] }): string {
  const name = p.label.replace(/\s*\(.*\)$/, '');
  const city = p.counties && p.counties.length === 1 ? /^(.+) City$/.exec(p.counties[0]) : null;
  return city && city[1] === name ? `the City of ${name}` : name;
}

/* Which of these places a Census result points to. The state has to match first: Aurora,
   Illinois is not Aurora, Colorado, and applying one state's district numbers to the other's
   races would hide the right ones. In DC the Census "upper" layer is the ward. */
export function placeFromGeo(places: Record<string, { label: string; state: string }>, ids: string[], r: GeoResult): string | null {
  if (!r.state) return null;
  const inState = ids.filter((id) => places[id] && places[id].state === r.state);
  if (r.state === 'DC' && r.upper != null) return inState.find((id) => places[id].label === `DC Ward ${r.upper}`) || null;
  if (!r.place) return null;
  return inState.find((id) => places[id].label.toLowerCase() === r.place!.toLowerCase()) || null;
}

/* An address typed on the first page, before any ZIP: which ballot it opens. The place Census
   names wins when it is one we cover in that state (matched as placeFromGeo does, then without the
   label's note, "Los Angeles (city)", and for New York City by borough county). Otherwise the ZIP
   Census matched goes through the same index the ZIP box uses: one place opens, several ask. A
   covered state with no matching place gets its statewide ballot, as a ZIP there would. "none"
   means we couldn't tell, and the page says so. */
export type AddressHit =
  | { kind: 'open'; st: string; ids: string[]; zip: string }
  | { kind: 'choose'; zip: string; ids: string[] }
  | { kind: 'out'; st: string; zip: string }
  | { kind: 'none' };
interface IndexLike { places: Record<string, PlaceLike>; zips: Record<string, string[]>; states: Record<string, unknown> }
/* Which of these places the Census names the address's own, by name: as placeFromGeo matches, then the label
   without its note ("Los Angeles (city)", "St. Louis (the City of St. Louis, ...)"), and New York City by
   borough county. A place the address's county rules out never answers (outsideOf). */
export function whichPlace(places: Record<string, PlaceLike>, ids: string[], r: GeoResult): string | null {
  if (!r.state) return null;
  const ok = ids.filter((id) => places[id] && places[id].state === r.state && !outsideOf(places[id], r));
  const hit = placeFromGeo(places, ok, r);
  if (hit || !r.place) return hit;
  const name = r.place.toLowerCase();
  if (name === 'new york' && r.county) {
    const nyc = ok.find((id) => (places[id].label.match(/\(([^)]*) County\)$/) || [])[1] === r.county);
    if (nyc) return nyc;
  }
  const bare = (l: string) => l.replace(/\s*\(.*\)$/, '').toLowerCase();
  return ok.find((id) => bare(places[id].label) === name) || null;
}
/* The places a ZIP opens by itself, less any the address's county rules out, and whether they're sure: a ZIP
   one of them marks as also reaching a town the guide doesn't cover (zip_outside: 63120 is the City and Pine
   Lawn) is never sure, so the first page asks rather than opening a place the voter may not be in. */
export function zipPlaces(idx: IndexLike, zip: string, r?: GeoResult): { ids: string[]; sure: boolean } {
  const ids = (idx.zips[zip] || []).filter((id) => idx.places[id] && (!r || (idx.places[id].state === r.state && !outsideOf(idx.places[id], r))));
  return { ids, sure: ids.length === 1 && !(idx.places[ids[0]].zip_outside || {})[zip] };
}
export function settleAddress(idx: IndexLike, r: GeoResult): AddressHit {
  const st = r.state;
  if (!st) return { kind: 'none' };
  const zip = r.zip && /^\d{5}$/.test(r.zip) ? r.zip : '';
  const inState = Object.keys(idx.places).filter((id) => idx.places[id].state === st);
  const hit = whichPlace(idx.places, inState, r);
  if (hit) return { kind: 'open', st, ids: [hit], zip };
  const { ids, sure } = zip ? zipPlaces(idx, zip, r) : { ids: [], sure: false };
  if (sure) return { kind: 'open', st, ids, zip };
  if (ids.length) return { kind: 'choose', zip, ids };
  if (!(st in idx.states)) return { kind: 'out', st, zip };
  return zip ? { kind: 'open', st, ids: [], zip } : { kind: 'none' };
}
/* Which ballot an address belongs on, from the one open (`here`, its places; none for the state's races):
   null keeps it, `to` [] is the state's races, [id] a place, and `out` says the address's county ruled out
   every place open. Ruled out, the place the Census names, as the first page would open it, else the
   state's races (Denver's ballot, an Aurora address in Arapahoe County: Aurora's, which lists each of its
   three counties' races with who votes in them). Several places narrow to the one the address is in. The
   state's races take the place the Census names only where its county codes can rule out the wrong county:
   a place without them stays the state's races, as before Oct 29, rather than open with county races that
   may not be the voter's (the review of #46: Portland reaches into Washington County, its ballot is
   Multnomah's). */
export function ballotFor(idx: IndexLike, here: string[], r: GeoResult): { to: string[]; out: boolean } | null {
  const all = Object.keys(idx.places);
  const out = here.length > 0 && here.every((id) => outsideOf(idx.places[id], r));
  if (out) { const n = whichPlace(idx.places, all, r); return { to: n ? [n] : [], out }; }
  const n = !here.length ? whichPlace(idx.places, all, r) : here.length > 1 ? whichPlace(idx.places, here, r) : null;
  if (!n || (!here.length && !idx.places[n].county_fips?.length)) return null;
  return { to: [n], out };
}

/* Most people type just the street ("2 Main St"), and the Census geocoder can't place a street
   without a city or ZIP. The guide already knows both the state and the ZIP they typed, so add
   them unless the address already ends in a ZIP; a state already at the end gets only the ZIP. */
export function withPlace(addr: string, st: string | null, zip: string | null): string {
  const a = addr.trim().replace(/[\s,]+$/, '');
  if (!st || /\b\d{5}(?:-\d{4})?$/.test(a)) return a;
  const name = NAMES[st];
  const endsInState = new RegExp(`(?:^|[\\s,])(?:${st}${name ? `|${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` : ''})$`, 'i').test(a);
  if (endsInState) return zip ? `${a} ${zip}` : a;
  return `${a}, ${st}${zip ? ` ${zip}` : ''}`;
}

/* The Census writes addresses in capitals ("100 N TEST ST, AUSTIN, TX, 78704"). Shown back the
   way people write them: "100 N Test St, Austin, TX 78704". Directions, the state and a few road
   prefixes stay capitals, ordinals go lower (1st), a word with a digit in it stays as it is, and
   the comma before the ZIP goes. */
const KEEP = /^(N|S|E|W|NE|NW|SE|SW|US|FM|RM|RR|SH|IH|CR|PO)$/;
const tidyWord = (w: string): string => {
  if (KEEP.test(w)) return w;
  if (/^\d+(ST|ND|RD|TH)$/i.test(w)) return w.toLowerCase();
  if (/\d/.test(w)) return w;
  return w.toLowerCase().replace(/(^|[-'’.])([a-z])/g, (_, a: string, c: string) => a + c.toUpperCase());
};
export function tidyAddress(s: string): string {
  const parts = s.trim().split(/\s*,\s*/).filter(Boolean);
  return parts.map((p, i) => (i > 0 && /^[A-Z]{2}$/.test(p) ? p : p.split(/\s+/).map(tidyWord).join(' ')))
    .join(', ').replace(/,\s*(\d{5}(?:-\d{4})?)$/, ' $1');
}

/* The Census answer as results: every match it found, in its order, the same address once. Most
   addresses match once; one typed without a city can match several ("Which one is yours?"). */
export function parseCensus(data: any): GeoResult[] {
  const list: any[] = (data && data.result && Array.isArray(data.result.addressMatches)) ? data.result.addressMatches : [];
  const out: GeoResult[] = [];
  for (const m of list) {
    const g = (m && m.geographies) || {};
    const layer = (re: RegExp) => { const k = Object.keys(g).find((x) => re.test(x)); return k && g[k] && g[k][0] ? g[k][0] : null; };
    // Every layer the Census has (layers=all) can carry more than one map of a kind: the newest is the
    // one this election uses (the 120th Congress, the 2026 legislature), whatever order they come in.
    const newest = (re: RegExp) => { const k = Object.keys(g).map((x) => ({ x, m: x.match(re) })).filter((o) => o.m).sort((a, b) => Number(b.m![1]) - Number(a.m![1]))[0]; return k && g[k.x] && g[k.x][0] ? g[k.x][0] : null; };
    const num = (x: any) => { const n = x ? parseInt(String(x.BASENAME || '').replace(/\D/g, ''), 10) : NaN; return Number.isFinite(n) ? n : null; };
    const st = layer(/^States$/);
    const county = layer(/^Counties$/);
    const place = layer(/Incorporated Places/);
    const zcta = layer(/ZIP Code Tabulation/);
    const matched = String((m && m.matchedAddress) || '');
    // A lon/lat pair the maps can use: finite, and on the planet.
    const ll = (x: unknown, y: unknown) => { const lon = Number(x), lat = Number(y); return Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90 && (lon !== 0 || lat !== 0) ? { lon, lat } : null; };
    const blk = layer(/^2020 Census Blocks$/) || layer(/Census Blocks/);
    const zipAt = matched.match(/(\d{5})(?:-\d{4})?\s*$/);
    // The county's code from GEOID, else STATE and COUNTY; an independent city's name ("St. Louis city") reads
    // the way people say it ("the City of St. Louis").
    const fips = county ? (/^\d{5}$/.test(String(county.GEOID || '')) ? String(county.GEOID)
      : /^\d{2}$/.test(String(county.STATE || '')) && /^\d{3}$/.test(String(county.COUNTY || '')) ? `${county.STATE}${county.COUNTY}` : null) : null;
    const cname = county ? String(county.NAME || '').trim() : '';
    const r: GeoResult = {
      matched,
      state: st ? STATE_FIPS[String(st.STATE)] || null : null,
      county: county ? String(county.BASENAME || '').trim() || null : null, // a blank name is no county
      countyId: fips,
      countyName: cname ? cname.replace(/^(.+) city$/, 'the City of $1') : null,
      place: place ? String(place.BASENAME || '') : null,
      cd: num(newest(/^(\d+)\w* Congressional Districts/) || layer(/Congressional Districts/)),
      upper: num(newest(/^(\d{4}) State Legislative Districts - Upper/) || layer(/State Legislative Districts - Upper/)),
      lower: num(newest(/^(\d{4}) State Legislative Districts - Lower/) || layer(/State Legislative Districts - Lower/)),
      // Unified, or elementary and secondary where a state splits them.
      schools: Object.keys(g).filter((k) => /School Districts/.test(k)).flatMap((k) => (g[k] || []).map((x: any) => String(x.NAME || x.BASENAME || ''))).filter(Boolean),
      zip: zcta && /^\d{5}$/.test(String(zcta.ZCTA5 || zcta.BASENAME || '')) ? String(zcta.ZCTA5 || zcta.BASENAME) : zipAt ? zipAt[1] : null,
      point: m && m.coordinates ? ll(m.coordinates.x, m.coordinates.y) : null,
      block: blk ? ll(blk.INTPTLON, blk.INTPTLAT) : null,
    };
    if (!out.some((x) => tidyAddress(x.matched) === tidyAddress(r.matched))) out.push(r);
  }
  return out;
}

/* US Census Geocoder, JSONP (no key, no CORS). The address goes only to the Census
   Bureau. We keep it in memory for this one request and never store it. Resolves with every
   match, none when it found nothing. */
let seq = 0;
export function censusLookup(address: string, timeoutMs = 15000): Promise<GeoResult[]> {
  return new Promise((resolve, reject) => {
    const cb = `__vgGeo${Date.now()}${seq++}`;
    const script = document.createElement('script');
    let done = false;
    const w = window as unknown as Record<string, unknown>;
    const cleanup = () => { done = true; delete w[cb]; script.remove(); window.clearTimeout(timer); };
    const timer = window.setTimeout(() => { if (!done) { cleanup(); reject(new Error('timeout')); } }, timeoutMs);
    w[cb] = (data: any) => {
      cleanup();
      try { resolve(parseCensus(data)); } catch (e) { reject(e); }
    };
    const q = new URLSearchParams({
      // Every layer: the defaults leave out school districts.
      address, benchmark: 'Public_AR_Current', vintage: 'Current_Current', layers: 'all', format: 'jsonp', callback: cb,
    });
    script.src = `https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?${q.toString()}`;
    script.onerror = () => { if (!done) { cleanup(); reject(new Error('network')); } };
    document.head.appendChild(script);
  });
}
