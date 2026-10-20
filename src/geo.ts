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
  place: string | null;      // "Austin"
  cd: number | null;         // congressional district
  upper: number | null;      // state senate
  lower: number | null;      // state house
}

const STATE_FIPS: Record<string, string> = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL',
  '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME',
  '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH',
  '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI',
  '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI',
  '56': 'WY', '72': 'PR',
};

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

/* US Census Geocoder, JSONP (no key, no CORS). The address goes only to the Census
   Bureau. We keep it in memory for this one request and never store it. */
let seq = 0;
export function censusLookup(address: string, timeoutMs = 15000): Promise<GeoResult | null> {
  return new Promise((resolve, reject) => {
    const cb = `__vgGeo${Date.now()}${seq++}`;
    const script = document.createElement('script');
    let done = false;
    const w = window as unknown as Record<string, unknown>;
    const cleanup = () => { done = true; delete w[cb]; script.remove(); window.clearTimeout(timer); };
    const timer = window.setTimeout(() => { if (!done) { cleanup(); reject(new Error('timeout')); } }, timeoutMs);
    w[cb] = (data: any) => {
      cleanup();
      try {
        const m = data && data.result && data.result.addressMatches && data.result.addressMatches[0];
        if (!m) return resolve(null);
        const g = m.geographies || {};
        const layer = (re: RegExp) => { const k = Object.keys(g).find((x) => re.test(x)); return k && g[k] && g[k][0] ? g[k][0] : null; };
        const num = (x: any) => { const n = x ? parseInt(String(x.BASENAME || '').replace(/\D/g, ''), 10) : NaN; return Number.isFinite(n) ? n : null; };
        const st = layer(/^States$/);
        const county = layer(/^Counties$/);
        const place = layer(/Incorporated Places/);
        resolve({
          matched: String(m.matchedAddress || ''),
          state: st ? STATE_FIPS[String(st.STATE)] || null : null,
          county: county ? String(county.BASENAME || '') : null,
          place: place ? String(place.BASENAME || '') : null,
          cd: num(layer(/Congressional Districts/)),
          upper: num(layer(/State Legislative Districts - Upper/)),
          lower: num(layer(/State Legislative Districts - Lower/)),
        });
      } catch (e) { reject(e); }
    };
    const q = new URLSearchParams({
      address, benchmark: 'Public_AR_Current', vintage: 'Current_Current', format: 'jsonp', callback: cb,
    });
    script.src = `https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?${q.toString()}`;
    script.onerror = () => { if (!done) { cleanup(); reject(new Error('network')); } };
    document.head.appendChild(script);
  });
}
