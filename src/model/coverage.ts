/* How covered your ballot is, said plainly (Kevin, Oct 25: "St. Louis doesn't have very many sources and
   I don't think the site should pretend we can show picks if we haven't fully scraped for that one
   yet"). The counts are the ballot's own, so they match the list "Every source on your ballot" shows;
   the date and the thin rule come from build-data (index.json, scripts/coverage.mjs). Three kinds:
   - full: "24 sources for Chicago, 12 with picks. Last checked Oct 19."
   - thin: a place none of whose own sources has a pick, with some of its own races unpicked: say so,
     and offer to gather its endorsements in one tap. Once a hard look for them came up empty (the place's
     local_picks_checked, Oct 29; Kevin: "request city is based on whether we've done a robust run for that
     spot not the number of sources we've found"), say we looked, when and where, and offer nothing.
   - statewide: no place (a ZIP in a covered state the guide has no city for, like Springfield, Missouri, or a
     state picked from the list): say we only have the statewide races, and with a ZIP offer to add the
     city in one tap.
   A one-tap request is remembered on this device (localStorage `vg-asked`, never the save link or
   `vg2`) until its data lands: a place's once its data was checked after the request day, a ZIP's once
   the ZIP has a place. Three days with nothing landed (the day sent and the two after) and the offer
   comes back, so a request the pipeline turned down never reads "about a day" forever. */
import type { Ballot } from '../ballot';
import type { Index, LocalPicksChecked, PlaceCoverage } from '../types';
import { daysBetween, fmtDate, load, save, todayISO } from '../util';
import { withPicks } from './lens';
import { placeName } from '../geo';

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
  stateName: string;   // "Florida": the thin card's "picks from newspapers and groups across Florida"
  single: boolean;     // one place on the ballot ("24 sources on Chicago's ballot")
  zip: string;
  ask: Ask | null;     // what one tap would ask for, when it can
  state: AskState;     // landed: a statewide ballot whose ZIP has a place now
  askedOn: string | null; // the day this device sent the request, while it counts
  localRaces: number;  // a thin place's own races a voter decides, and how many have a pick from anyone
  localRacesWithPicks: number;
  searched: LocalPicksChecked | null; // a thin place's hard look that came up empty: no ask, the card says so
  late: boolean;      // Election Day is two days away or less: say it may not land before you vote
  /* A statewide ballot from a ZIP split between a place and a town the guide doesn't cover (zip_outside), when
     the voter didn't say which they live in ("I'm not sure"): the card says so and offers the address. */
  shared: { place: string; outside: string } | null;
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

/* "today" on the day a request was sent, then its date ("Oct 25"), in the card, the quiet lines and the
   follow-up sheet alike. */
export const askedWord = (on: string | null, today = todayISO()): string => (!on || on === today ? 'today' : fmtDate(on, { weekday: false }));

const bare = (l: string): string => l.replace(/\s*\(.*\)$/, '');

/* `away`: the places the voter isn't in, kept with the ballot (BallotState.away): a statewide ballot never
   reads them as the voter's city landing. */
export function ballotCoverage(b: Ballot, idx: Index, zip: string, today = todayISO(), away: string[] = []): Cov {
  const sources = b.endorsers.length;
  const picks = withPicks(b, b.endorsers).length;
  const e = b.howto.election_date;
  const late = !!e && /^\d{4}-\d{2}-\d{2}$/.test(e) && daysBetween(today, e) <= 2;
  const base = { sources, withPicks: picks, stateName: b.stateName, zip, late, localRaces: 0, localRacesWithPicks: 0, searched: null, shared: null };
  if (!b.places.length) {
    const st = idx.states[b.st];
    const ask: Ask | null = zip ? {
      key: `z:${zip}`, name: 'your city', what: 'Please add my city',
      wrong: `Please add the city for ZIP ${zip} in ${b.stateName} (one-tap from the page)`,
    } : null;
    // The ZIP has a place now, unless the voter isn't in it (away) or it only shares the ZIP with a town the
    // guide doesn't cover (zip_outside: 63120 is the City of St. Louis and Pine Lawn), where the place may not be
    // theirs: "Your city is in the guide now" would send a Pine Lawn voter to the City's ballot (Oct 29).
    const inZip = zip ? (idx.zips[zip] || []).filter((id) => idx.places[id] && !away.includes(id)) : [];
    const outside = (id: string): string | undefined => (idx.places[id].zip_outside || {})[zip];
    const landed = inZip.some((id) => !outside(id));
    const split = landed ? undefined : inZip.find(outside);
    const shared = split ? { place: placeName(idx.places[split]), outside: outside(split)! } : null;
    const on = ask ? askedOn(ask.key, today) : null;
    return { ...base, kind: 'statewide', checked: st ? st.checked : null, name: b.stateName, single: false, ask,
      state: landed ? 'landed' : on ? 'asked' : 'none', askedOn: landed ? null : on, shared };
  }
  const ps = b.places.map((p) => idx.places[p.id]).filter(Boolean);
  const checked = ps.map((p) => p.checked).filter((d): d is string => !!d).sort().pop() || null;
  const name = b.places.map((p) => bare(p.label)).join(' or ');
  const one = b.places.length === 1 && ps.length === 1 ? ps[0] : null;
  if (!one || !isThin(one)) return { ...base, kind: 'full', checked, name, single: b.places.length === 1, ask: null, state: 'none', askedOn: null };
  // After a hard look that came up empty there is nothing to ask for. A local pick found later makes the
  // place full by itself, so the date never hides one.
  const searched = one.local_picks_checked || null;
  const key = `p:${b.places[0].id}`;
  const ask: Ask | null = searched ? null : {
    key, name, what: `Gather endorsements: ${name}`,
    wrong: `Please gather local endorsements for ${name} (one-tap from the page)`,
  };
  const on = askedOn(key, today);
  // Asked, until data checked after the request day comes in, or a hard look on or after it: then the place
  // reads as it is.
  const asked = !!on && !(checked && checked > on) && !(searched && searched.on >= on);
  return { ...base, kind: 'thin', checked, name, single: true, ask, state: asked ? 'asked' : 'none', askedOn: asked ? on : null,
    localRaces: one.local_races, localRacesWithPicks: one.local_races_with_picks, searched };
}
