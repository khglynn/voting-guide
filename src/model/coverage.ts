/* How covered your ballot is, said plainly (Kevin, Oct 25: "St. Louis doesn't have very many sources and
   I don't think the site should pretend we can show picks if we haven't fully scraped for that one
   yet"). The counts are the ballot's own, so they match the list "Every source on your ballot" shows;
   the date and the thin rule come from build-data (index.json, scripts/coverage.mjs). Three kinds:
   - full: "24 sources for Chicago, 12 with picks. Last checked Oct 19."
   - thin: a place none of whose own sources has a pick, with some of its own races unpicked: say so,
     and offer to gather its endorsements in one tap.
   - statewide: no place (a ZIP in a covered state the guide has no city for, like St. Louis City, or a
     state picked from the list): say we only have the statewide races, and with a ZIP offer to add the
     city in one tap.
   A one-tap request is remembered on this device (localStorage `vg-asked`, never the save link or
   `vg2`) until its data lands: a place's once its data was checked after the request day, a ZIP's once
   the ZIP has a place. Three days with nothing landed (the day sent and the two after) and the offer
   comes back, so a request the pipeline turned down never reads "about a day" forever. */
import type { Ballot } from '../ballot';
import type { Index, PlaceCoverage } from '../types';
import { daysBetween, load, save, todayISO } from '../util';
import { withPicks } from './lens';

/* The same rule as scripts/coverage.mjs isThin (tests/model.mjs checks they agree on every place). */
export const isThin = (p: PlaceCoverage): boolean => p.local_with_picks === 0 && p.local_races_with_picks < p.local_races;

/* What one tap sends (actions.ts A['cov-ask'], through the shelf's form): its own words for "Which race
   or measure?" and "What's wrong?", nothing typed. A thin place asks to gather its endorsements; a ZIP
   with no city asks for the city the way Request a city does, so the pipeline reads both the same. */
export interface Ask { key: string; what: string; wrong: string; name: string }
export type AskState = 'none' | 'asked' | 'landed';
export interface Cov {
  kind: 'full' | 'thin' | 'statewide';
  sources: number;
  withPicks: number;
  checked: string | null;
  name: string;        // "Chicago", "Aurora or Denver", "Missouri"
  zip: string;
  ask: Ask | null;     // what one tap would ask for, when it can
  state: AskState;     // landed: a statewide ballot whose ZIP has a place now
}

/* ---------- requests remembered on this device ---------- */
const KEY = 'vg-asked';
const KEEP_DAYS = 3;
type Asked = Record<string, string>; // ask key -> the day it was sent, YYYY-MM-DD
/* Anything but a plain object (a list or text left by something else) reads as empty: an array would
   take the new key as a property and drop it when written back (Codex, Oct 26). */
const readAsked = (): Asked => { const a: unknown = load<unknown>(KEY, {}); return Object.prototype.toString.call(a) === '[object Object]' ? (a as Asked) : {}; };
/* The day this request went from this device, while it still counts. */
export function askedOn(key: string, today = todayISO()): string | null {
  const on = readAsked()[key];
  if (typeof on !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(on)) return null;
  const d = daysBetween(on, today);
  return d >= 0 && d < KEEP_DAYS ? on : null;
}
/* Sent: remember it, and let go of any older than the window. */
export function rememberAsk(key: string, today = todayISO()): void {
  const a = readAsked();
  for (const [k, on] of Object.entries(a)) if (typeof on !== 'string' || daysBetween(on, today) >= KEEP_DAYS) delete a[k];
  a[key] = today;
  save(KEY, a);
}

const bare = (l: string): string => l.replace(/\s*\(.*\)$/, '');

export function ballotCoverage(b: Ballot, idx: Index, zip: string, today = todayISO()): Cov {
  const sources = b.endorsers.length;
  const picks = withPicks(b, b.endorsers).length;
  if (!b.places.length) {
    const st = idx.states[b.st];
    const ask: Ask | null = zip ? {
      key: `z:${zip}`, name: 'your city', what: 'Please add my city',
      wrong: `Please add the city for ZIP ${zip} in ${b.stateName} (one-tap from the page)`,
    } : null;
    const landed = !!zip && (idx.zips[zip] || []).length > 0;
    return { kind: 'statewide', sources, withPicks: picks, checked: st ? st.checked : null, name: b.stateName, zip, ask,
      state: landed ? 'landed' : ask && askedOn(ask.key, today) ? 'asked' : 'none' };
  }
  const ps = b.places.map((p) => idx.places[p.id]).filter(Boolean);
  const checked = ps.map((p) => p.checked).filter((d): d is string => !!d).sort().pop() || null;
  const name = b.places.map((p) => bare(p.label)).join(' or ');
  const one = b.places.length === 1 && ps.length === 1 ? ps[0] : null;
  if (!one || !isThin(one)) return { kind: 'full', sources, withPicks: picks, checked, name, zip, ask: null, state: 'none' };
  const ask: Ask = {
    key: `p:${b.places[0].id}`, name, what: `Gather endorsements: ${name}`,
    wrong: `Please gather local endorsements for ${name} (one-tap from the page)`,
  };
  const on = askedOn(ask.key, today);
  // Asked, until data checked after the request day comes in: then the place reads as it is.
  return { kind: 'thin', sources, withPicks: picks, checked, name, zip, ask, state: on && !(checked && checked > on) ? 'asked' : 'none' };
}
