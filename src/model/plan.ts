/* The next step and its date, computed from the state file for every voting model.
   Never a countdown. Dates come only from data/states/{ST}.json; `?today=` overrides the
   clock for testing (util.todayISO). */
import type { Dated, HelpAction, HowTo, Index, Lookups, NextDate, PlaceBundle, ResultsData, ResultsSource } from '../types';
import { fmtDate, todayISO, daysBetween, nowOverride, zonedNow } from '../util';

export type Part = [string, boolean]; // text, emphasized (a date or time)
export interface Step {
  head: Part[];
  sub: string[];
  /* `look`: which kind of where-to-vote tool the button opens, so a ballot across county lines can offer
     each county's (planstrip.ts) */
  primary: { label: string; url: string; look?: keyof Lookups } | null;
  /* a second, quieter button (once the polls close: "Track your ballot" beside "Official results") */
  secondary?: { label: string; url: string } | null;
  /* Once the polls close (Nov 3): each results source's own line about when it posts (county first, then the state;
     Election Day only, since they speak of "tonight"), then when the count becomes official, from
     data/results-sources.json, shown as the data says them. */
  notes?: string[];
  /* `results_counting` from the moment the ballot's polls have closed in every zone it spans until every results
     source on it has passed its sure official-by date; then `results_official`. */
  phase: 'results_counting' | 'results_official' | 'election_day' | 'mail' | 'early_before' | 'early_open' | 'election_day_next';
}

export const isMailState = (h: HowTo): boolean => h.voting_model === 'all_mail' || h.voting_model === 'mail_to_all_plus_in_person';

/* "7:00 PM MT" -> "7 PM"; "8:00 PM PT (drop box, ...)" -> "8 PM"; null when there is no time. */
export function clock(s: string | null | undefined): string | null {
  const m = (s || '').match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b/i);
  if (m) return `${m[1]}${m[2] && m[2] !== '00' ? `:${m[2]}` : ''} ${m[3].toUpperCase()}M`;
  if (/\bnoon\b/i.test(s || '')) return 'noon';
  return null;
}
/* "7:00 AM", "8 PM PT": a time and nothing else. A qualified one ("8:30 AM at the six King County vote centers",
   "7:00 AM in Davidson County; each county sets its own") isn't a statewide opening time, so it never
   becomes "Polls are open 7 AM to ..." or "You can vote from ...". */
export const PLAIN_TIME = /^\s*\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?(?:\s+[A-Z]{2,3})?\s*$/i;
/* Poll times are local. Each state's zones, the zone most of it uses first; a place in a
   state's other zone is pinned here. A statewide-only ballot in a two-zone state says "your
   local polls close at" and says they have closed only once they have closed in every zone,
   so nobody is told the polls are closed while theirs are still open. */
const STATE_ZONES: Record<string, string[]> = {
  AL: ['America/Chicago'], CA: ['America/Los_Angeles'], CO: ['America/Denver'], DC: ['America/New_York'],
  FL: ['America/New_York', 'America/Chicago'], GA: ['America/New_York'], IL: ['America/Chicago'],
  MD: ['America/New_York'], MO: ['America/Chicago'], NY: ['America/New_York'], OR: ['America/Los_Angeles', 'America/Boise'],
  PA: ['America/New_York'], TN: ['America/Chicago', 'America/New_York'], TX: ['America/Chicago', 'America/Denver'],
  WA: ['America/Los_Angeles'],
};
const PLACE_ZONE: Record<string, string> = { 'pensacola-fl': 'America/Chicago' };
export function zonesFor(st: string, places: { id: string }[]): string[] {
  const all = STATE_ZONES[st] || [];
  if (!places.length) return all;
  return [...new Set(places.map((p) => PLACE_ZONE[p.id] || all[0]).filter(Boolean))];
}
/* The close a ballot names, for the plan and the place pages alike. Polls that close at one moment in two zones
   ("7:00 PM Central (8:00 PM Eastern)", Tennessee) keep both times on a ballot that spans the zones, where
   "7 PM" would be an hour early for half of it; a ballot in the first zone gets its own "7 PM". A place in the
   second zone (Knoxville, Eastern) would get "7 PM" too, as would the closing check: give it that zone's time first. */
export function closeOf(pollsClose: string, zones: string[]): { close: string; both: boolean } {
  const both = zones.length > 1 && /\b(Eastern|Central|Mountain|Pacific)\b/.test(pollsClose);
  return { close: both ? pollsClose : clock(pollsClose) || pollsClose, both };
}

/* "7:00 PM" -> 1140 (minutes after midnight); null when there is no time. */
export function clockMinutes(s: string | null | undefined): number | null {
  const m = (s || '').match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b/i);
  if (m) return ((+m[1] % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0)) * 60 + (m[2] ? +m[2] : 0);
  if (/\bnoon\b/i.test(s || '')) return 720;
  return null;
}

/* "Travis County" and "travis" name the same county. */
export const countyKey = (c: string): string => c.replace(/\s+county$/i, '').trim().toLowerCase();
/* The voter's county, when the guide knows it (Oct 28): the address lookup's (the Census's county), else a
   ZIP that every place with per-county links puts wholly in one county. Null when no place on the ballot
   spans counties, or when it can't tell. */
export function voterCounty(places: PlaceBundle[], zip: string | null | undefined, addrCounty: string | null | undefined): string | null {
  const split = places.filter((p) => p.by_county && p.by_county.length);
  if (!split.length) return null;
  if (addrCounty && addrCounty.trim()) return addrCounty.trim();
  if (!zip) return null;
  const hits = new Set(split.map((p) => p.by_county!.find((c) => c.zips.includes(zip))?.county || ''));
  const [only] = [...hits];
  return hits.size === 1 && only ? only : null;
}
/* A place's where-to-vote tools for this voter: its county's, when the place spans counties and the county is
   known, over the place's own. A county the place doesn't list (the address lookup puts you in Caldwell County,
   and San Marcos lists only Hays) gets none of the place's: the state's links are right for every county. */
const lookupsFor = (p: PlaceBundle, county: string | null): Lookups | undefined => {
  if (!county || !p.by_county || !p.by_county.length) return p.lookups;
  const c = p.by_county.find((x) => countyKey(x.county) === countyKey(county));
  return c ? { ...(p.lookups || {}), ...c.lookups } : undefined;
};

/* A county that runs its own early-voting days (Florida counties choose theirs inside the
   state's range) carries them in its place file. When every place on this ballot agrees,
   the plan uses the county's window, hours and lookup page; otherwise the state's stands.
   `county` (voterCounty) picks a county's tools on a ballot that spans counties; when it's null there, the
   plan lists each county's (`county_links`). A county's own answer to a common question (a place's
   `situations`) replaces the state's when every place on the ballot gives the same one. */
export function localHowto(h0: HowTo, places: PlaceBundle[], county: string | null = null, today = todayISO()): HowTo {
  const base = applyDated(h0, h0.dated, today);
  const ps = places.map((p) => (p.dated ? applyDated(p, p.dated, today) : p));
  return { ...localActions(base, placeHowto(base, ps, county), today), day: today };
}

/* Text that changes on its own date (Oct 28): the latest `dated` entry for each slot whose day has come
   replaces that slot's text. Only the parts a path touches are copied, never a place's ballot. Paths are the
   bundle's ("situations.<id>.short", "gotchas.4", "gotcha_shorts.4", "notes", "county_election_office.hours"). */
export function applyDated<T extends object>(o: T, dated: Dated[] | undefined, today: string): T {
  if (!dated || !dated.length) return o;
  const pick = new Map<string, Dated>();
  for (const d of dated) if (d.from <= today && (!pick.has(d.path) || pick.get(d.path)!.from <= d.from)) pick.set(d.path, d);
  if (!pick.size) return o;
  const out: Record<string, unknown> = { ...(o as Record<string, unknown>) };
  const copied = new Set<string>();
  for (const d of pick.values()) {
    const seg = d.path.split('.');
    if (!copied.has(seg[0])) { copied.add(seg[0]); if (out[seg[0]] != null && typeof out[seg[0]] === 'object') out[seg[0]] = JSON.parse(JSON.stringify(out[seg[0]])); }
    if (seg.length === 1) { if (typeof out[seg[0]] === 'string') out[seg[0]] = d.text; continue; }
    let cur: any = out[seg[0]]; // eslint-disable-line @typescript-eslint/no-explicit-any
    let i = 1;
    if (seg[0] === 'situations' && Array.isArray(cur)) { cur = cur.find((x: { id?: string }) => x && x.id === seg[1]); i = 2; }
    for (; cur != null && i < seg.length - 1; i++) cur = cur[Array.isArray(cur) ? +seg[i] : seg[i]];
    const last = seg[seg.length - 1];
    if (cur != null && i === seg.length - 1) {
      const k = Array.isArray(cur) ? +last : last;
      if (typeof cur[k] === 'string') cur[k] = d.text;
    }
  }
  return out as T;
}

/* The "If something goes wrong" buttons and links point at the state's where-to-vote and tracking pages;
   on a ballot with the county's own (Oct 28: the checker found this gap eight times), each such button opens
   the county's. A button changes only when its label says what kind of page it is, since a state can use one
   page for several jobs (Illinois's election-office directory is also its tracking fallback; New York uses one
   lookup for all four). A general one ("Find voting places", "Find a vote center") that could be either opens
   the early voting page while early voting is open, then the Election Day one (Codex on part B). One that names
   early voting follows the county's own window (Oct 30: Escambia's ends Oct 31, Orange's and Leon's Nov 1, while
   Florida's state buttons switch by date on Nov 2): once it has ended, it is "Find my polling place" and opens the
   county's Election Day page, so it never opens a closed county's early voting list. */
const KINDS = ['early_in_person', 'election_day', 'drop_box', 'tracking'] as const;
type Kind = (typeof KINDS)[number];
const urlsOf = (x: HowTo): Record<Kind, string | null> => ({
  early_in_person: x.early_in_person.lookup_url, election_day: x.election_day.lookup_url,
  drop_box: x.mail_ballot.drop_box_lookup_url, tracking: x.mail_ballot.tracking_url,
});
const GENERAL = /where|vote center|voting (place|location|center|site)s?|polling|poll site/i;
const FITS: Record<Kind, RegExp> = { early_in_person: new RegExp(`early|${GENERAL.source}`, 'i'), election_day: GENERAL, drop_box: /drop/i, tracking: /track|status|counted/i };
const NAMES: Partial<Record<Kind, RegExp>> = { early_in_person: /early/i, election_day: /poll(ing)? (place|site)|election day|precinct/i };
function localActions(base: HowTo, h: HowTo, today: string): HowTo {
  const was = urlsOf(base), now = urlsOf(h);
  if (KINDS.every((k) => was[k] === now[k]) || !(h.situations || []).some((x) => x.actions && x.actions.length)) return h;
  const ep = h.early_in_person;
  const earlyOpen = ep.available && (!ep.end || today <= ep.end);
  const swap = (a: HelpAction): HelpAction => {
    const fits = KINDS.filter((k) => was[k] && was[k] === a.url && FITS[k].test(a.label));
    let k: Kind | undefined = fits.length === 1 ? fits[0] : fits.find((x) => NAMES[x]?.test(a.label));
    if (!k && fits.length > 1) k = earlyOpen && fits.includes('early_in_person') ? 'early_in_person' : fits.includes('election_day') ? 'election_day' : fits[0];
    // Only a label that says early voting: "Find a vote center" (California, Colorado) stays right on Election Day.
    if (k === 'early_in_person' && !earlyOpen && NAMES.early_in_person!.test(a.label) && now.election_day) return { label: 'Find my polling place', url: now.election_day };
    return k && now[k] && now[k] !== a.url ? { ...a, url: now[k]! } : a;
  };
  return { ...h, situations: h.situations!.map((x) => (x.actions && x.actions.length ? { ...x, actions: x.actions.map(swap) } : x)) };
}

/* "Fulton (most of the city)" -> "Fulton": a place's county as the results data spells it. */
const bareCounty = (c: string): string => c.replace(/\s*\(.*?\)\s*/g, ' ').trim();
/* The ballot's results sources and dates (Nov 3): the county rows of its places, for the voter's county when the guide
   knows it (an address in Caldwell on San Marcos's ballot gets none, and the state's stand), else for every county the
   places name, main county first; then the state's row. Dates likewise, a county's own only for that county's voters,
   in date order, each line once. */
export function resultsFor(st: ResultsData | undefined, places: PlaceBundle[], county: string | null): ResultsData | undefined {
  if (!places.length) return st;
  const k = county ? countyKey(bareCounty(county)) : null;
  const hit = (cs: string[] | undefined): boolean => !k || !cs || cs.some((c) => countyKey(bareCounty(c)) === k);
  const order = places.flatMap((p) => (p.counties || []).map((c) => countyKey(bareCounty(c))));
  const rank = (r: ResultsSource): number => { const i = order.findIndex((c) => (r.counties || []).some((x) => countyKey(x) === c)); return i < 0 ? order.length : i; };
  const seen = new Set<string>();
  const sources: ResultsSource[] = [];
  for (const p of places) for (const r of p.results?.sources || []) if (!seen.has(r.id) && r.counties && r.counties.some((c) => hit([c]))) { seen.add(r.id); sources.push(r); }
  sources.sort((a, b) => rank(a) - rank(b));
  const lines = new Set<string>();
  const next: NextDate[] = [...(st?.next || []), ...places.flatMap((p) => (p.results?.next || []).filter((r) => hit(r.counties)))]
    .filter((r) => (lines.has(r.line) ? false : (lines.add(r.line), true)))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { sources: [...sources, ...(st?.sources || [])], next };
}

function placeHowto(h0: HowTo, places: PlaceBundle[], county: string | null): HowTo {
  let h = places.length ? { ...h0, zones: zonesFor(h0.state, places) } : h0;
  const res = resultsFor(h0.results, places, county);
  if (res) h = { ...h, results: res };
  // The county's own where-to-vote tools win over the state's statewide lookups, when every
  // place on the ballot points to the same one.
  const looks = places.map((p) => lookupsFor(p, county));
  const spans = !county && places.length > 0 && places.every((p) => p.by_county && p.by_county.length > 1);
  // Unknown county on a ballot whose every place spans counties: a tool every county shares is the ballot's own
  // (Nov 3: Travis, Williamson and Hays all send Election Day voters to Vote.org's address lookup), so the plan
  // shows one button for it, not one per county that all open the same page.
  const shared = (k: keyof Lookups): string | null => {
    const urls = spans ? [...new Set(places.flatMap((p) => p.by_county!.map((c) => c.lookups[k] || null)))] : [];
    return urls.length === 1 && urls[0] ? urls[0] : null;
  };
  const one = (k: keyof Lookups): string | null => {
    const urls = [...new Set(looks.map((l) => l?.[k] || null))];
    return (places.length && urls.length === 1 && urls[0] ? urls[0] : null) || shared(k);
  };
  // Unknown county on a ballot whose every place spans counties: each county's tools, labeled, in the
  // order the first place lists them. (A county the Census names that no place lists keeps the state's.)
  if (spans) {
    const seen = new Map<string, { county: string; lookups: Lookups }>();
    for (const p of places) for (const c of p.by_county!) if (!seen.has(countyKey(c.county))) seen.set(countyKey(c.county), { county: c.county, lookups: c.lookups });
    h = { ...h, county_links: [...seen.values()] };
  }
  // A county's own answer to a common question, when every place on the ballot gives the same one.
  if (places.length && (h.situations || []).length && places.some((p) => p.situations && p.situations.length)) {
    h = {
      ...h,
      situations: h.situations!.map((x) => {
        const own = places.map((p) => p.situations?.find((o) => o.id === x.id));
        if (own.some((o) => !o) || new Set(own.map((o) => JSON.stringify(o))).size !== 1) return x;
        const { id: _id, ...o } = own[0]!;
        return { ...x, ...o };
      }),
    };
  }
  const le = one('early_in_person'), ld = one('election_day'), lb = one('drop_box'), lt = one('tracking');
  if (le || ld || lb || lt) {
    h = {
      ...h,
      early_in_person: le ? { ...h.early_in_person, lookup_url: le } : h.early_in_person,
      election_day: ld ? { ...h.election_day, lookup_url: ld } : h.election_day,
      mail_ballot: lb || lt ? { ...h.mail_ballot, ...(lb ? { drop_box_lookup_url: lb } : {}), ...(lt ? { tracking_url: lt } : {}) } : h.mail_ballot,
    };
  }
  // The county's live Election Day wait times (Nov 3), the same rule: only when every place on the ballot gives the same page.
  const lw = one('election_day_waits');
  if (lw) h = { ...h, election_day: { ...h.election_day, waits_url: lw } };
  // The county's official results page (Nov 3), the same rule: the voter's county's, or a one-county place's, when
  // every place on the ballot gives the same one. Otherwise the state's stands, and a ballot across county lines
  // whose county isn't known lists each county's beside it (planstrip.ts countyActs).
  const lr = one('results');
  if (lr) {
    const by = (u: string | undefined, n: string | undefined): string | null => (u === lr && n ? n : null);
    const src = places.map((p) => by(p.lookups?.results, p.results_source) || (p.by_county || []).map((c) => by(c.lookups.results, c.results_source)).find(Boolean) || null).find(Boolean) || null;
    h = { ...h, results_url: lr, results_source: src };
  }
  // The county's own mail-ballot facts and opening time (Oct 29), when every place on the ballot gives the same ones:
  // the City of St. Louis's ballots go back only to its own Board, Nashville's polls open at 7.
  const same = <T>(xs: (T | undefined)[]): T | null => (xs.length && xs.every((x) => x != null) && new Set(xs.map((x) => JSON.stringify(x))).size === 1 ? xs[0]! : null);
  const mail = same(places.map((p) => p.mail_ballot));
  if (mail) h = { ...h, mail_ballot: { ...h.mail_ballot, ...(mail.request_deadline ? { request_deadline: mail.request_deadline } : {}), ...(mail.return_options ? { return_options: mail.return_options } : {}) } };
  const opening = same(places.map((p) => p.election_day));
  if (opening) h = { ...h, election_day: { ...h.election_day, polls_open: opening.polls_open } };
  const eps = places.map((p) => p.early_in_person);
  if (!eps.length || eps.some((e) => !e)) return h;
  const first = eps[0]!;
  if (eps.some((e) => e!.start !== first.start || e!.end !== first.end)) return h;
  const notes = [...new Set(eps.map((e) => e!.hours_note).filter((n): n is string => !!n))];
  const pages = [...new Set(eps.map((e) => e!.lookup_url))];
  // The place's own window is its county's real dates, so the state's latest possible county day goes with the state's window.
  return {
    ...h,
    early_in_person: {
      ...h.early_in_person, available: true, start: first.start, end: first.end, latest_end: null,
      hours_note: notes.length ? notes.join(' ') : h.early_in_person.hours_note,
      lookup_url: le || (pages.length === 1 && pages[0] ? pages[0] : h.early_in_person.lookup_url),
    },
  };
}

const day = (iso: string, t: string, absolute = false): string => (absolute ? fmtDate(iso) : iso === t ? 'today' : daysBetween(t, iso) === 1 ? 'tomorrow' : fmtDate(iso));
const dayNoWeek = (iso: string): string => fmtDate(iso, { weekday: false });

/* `absolute` writes dates, never "today", for text someone may read days later. `now` only
   matters on Election Day, to say the polls have closed: minutes after midnight where the polls
   are (a test, or `?now=HH:MM`), or an instant compared in each of the ballot's zones. */
export function nextStep(h: HowTo, t = todayISO(), absolute = false, now: number | Date | null = nowOverride()): Step {
  const ed = h.election_day;
  const mb = h.mail_ballot;
  const ep = h.early_in_person;
  const zones = h.zones || STATE_ZONES[h.state] || [];
  const { close, both } = closeOf(ed.polls_close, zones);
  // Once the polls close (Kevin, Nov 3): results, not "voting has ended". The most local official results page the
  // ballot has (localHowto), with "Track your ballot" beside it.
  const results = h.results_url ? { label: 'Official results', url: h.results_url, look: 'results' as const } : null;
  const track = mb.tracking_url ? { label: 'Track your mail ballot', url: mb.tracking_url } : null;
  if (t > h.election_date) {
    return { phase: 'results_counting', head: [['Results are still coming in.', false]], sub: ['Counting can take days, especially for mail ballots.'], notes: resultsNotes(h, t), primary: results || track, secondary: results ? track : null };
  }
  if (t === h.election_date) {
    const closesAt = clockMinutes(ed.polls_close);
    const at = now instanceof Date ? now : new Date();
    // Closed in a zone once that zone's own date and time are past Election Day's close there.
    const past = (z: string | null): boolean => {
      const { date, min } = typeof now === 'number' ? { date: h.election_date, min: now } : zonedNow(z, at);
      return date > h.election_date || (date === h.election_date && min >= closesAt!);
    };
    const shut = closesAt != null && (zones.length ? zones.every(past) : past(null));
    if (!absolute && shut) {
      // "Already in line?" only in the first hour after the close (GPT copy pass, Nov 3): the zone that closed last.
      const since = (z: string | null): number => { const { date, min } = typeof now === 'number' ? { date: h.election_date, min: now } : zonedNow(z, at); return date === h.election_date ? min - closesAt! : Infinity; };
      const fresh = (zones.length ? Math.min(...zones.map(since)) : since(null)) <= 60;
      return {
        phase: 'results_counting',
        head: [['Results are rolling in.', false]],
        sub: fresh ? ['Already in line? Stay in line. You still get to vote.'] : [],
        notes: resultsNotes(h, t),
        primary: results || track, secondary: results ? track : null,
      };
    }
    const sub: string[] = [];
    if (ed.in_line_rule) sub.push(ed.in_line_rule);
    const url = isMailState(h) ? mb.drop_box_lookup_url || ed.lookup_url : ed.lookup_url;
    return {
      phase: 'election_day',
      head: absolute ? [[`Election Day is ${fmtDate(h.election_date)}. ${zones.length > 1 && !both ? 'Your local polls' : 'Polls'} close at `, false], [close, true], ['.', false]]
        : [[`Today is Election Day. ${zones.length > 1 && !both ? 'Your local polls' : 'Polls'} close at `, false], [close, true], ['.', false]],
      sub, primary: url ? { label: isMailState(h) && mb.drop_box_lookup_url ? 'Find a drop box or vote center' : 'Find where to vote', url, look: isMailState(h) && mb.drop_box_lookup_url ? 'drop_box' : 'election_day' } : null,
    };
  }
  if (isMailState(h)) {
    const r = mb.return_deadline;
    const time = clock(r.time);
    const when = `${time ? `${time} ` : ''}${fmtDate(r.date)}`;
    // The headline is this week's action: mail it by the state's suggested day, then (after
    // that day) drop it off by the deadline. A postmark deadline and a drop-off time are
    // different rules: the time is for drop boxes and vote centers, and a ballot mailed before
    // it may not get that day's postmark.
    const postmark = r.rule === 'postmarked_by';
    const by = mailBy(h);
    const sub: string[] = [];
    let head: Part[];
    if (by && t <= by.date) {
      head = [[`Mail your ballot by ${by.about ? 'about ' : ''}`, false], [day(by.date, t, absolute), true], ['.', false]];
      sub.push(`After that, use a drop box${time ? ` by ${time}` : ''} ${fmtDate(r.date)}.`);
    } else {
      head = [['Drop off your ballot by ', false], [when, true], ['.', false]];
      if (postmark) sub.push(`Mailing it? It needs a postmark dated ${fmtDate(r.date, { weekday: false })} or earlier.`);
      else if (by) sub.push('Mail may not arrive in time now. Use a drop box or a vote center.');
      else if (mb.mail_cutoff_advice) sub.push(firstSentence(mb.mail_cutoff_advice));
    }
    if (ep.available && ep.start) {
      const late = !ep.end || ep.end >= h.election_date;
      if (t < ep.start || (absolute && t === ep.start)) sub.push(`In-person voting opens ${day(ep.start, t, absolute)}.`);
      else if (t === ep.start) sub.push('Or vote in person, starting today.');
      else if (!ep.end || t <= ep.end) sub.push(late ? 'Or vote in person through Election Day.' : `Or vote early in person through ${fmtDate(ep.end)}, or on Election Day.`);
    }
    return { phase: 'mail', head, sub, primary: mb.drop_box_lookup_url ? { label: 'Find a drop box', url: mb.drop_box_lookup_url, look: 'drop_box' } : ed.lookup_url ? { label: 'Find where to vote', url: ed.lookup_url, look: 'election_day' } : null };
  }
  const look = ep.lookup_url || ed.lookup_url;
  const lookKind: keyof Lookups = ep.lookup_url ? 'early_in_person' : 'election_day';
  const sub: string[] = [];
  if (ep.vote_centers) sub.push('You can vote at any early voting location in your county.');
  if (ep.available && ep.start && t < ep.start) {
    const d = daysBetween(t, ep.start);
    return {
      phase: 'early_before',
      head: d === 1 && !absolute ? [['Early voting starts tomorrow, ', false], [dayNoWeek(ep.start), true], ['.', false]] : [['Early voting starts ', false], [fmtDate(ep.start), true], ['.', false]],
      // A statewide window whose own note says counties may add days (Florida) says so, since
      // some voters can start sooner.
      sub: [ep.end ? `It runs through ${fmtDate(ep.end)}.` : '', /counties may add days|some counties open earlier/i.test(ep.hours_note || '') ? 'Some counties open sooner. Check yours.' : '', ...sub].filter(Boolean), primary: look ? { label: 'Find early voting places', url: look, look: lookKind } : null,
    };
  }
  // A window that is only a minimum (statewide Florida's ends Oct 31) runs on in some counties to its last possible
  // county day (Nov 1, when Orange and Leon still vote early): the other end of "Some counties open sooner". Until
  // that day the step stays early voting, its button the state's early voting page, as the state's dated notes do.
  const later = ep.available && ep.end && ep.latest_end && ep.latest_end > ep.end ? ep.latest_end : null;
  if (ep.available && ep.start && ep.end && t <= (later || ep.end)) {
    const head: Part[] = t > ep.end ? (absolute ? [['Some counties offer early voting through ', false], [fmtDate(later || ep.end), true], ['.', false]] : [['Some counties still offer early voting today.', false]])
      : absolute ? [['Early voting is open through ', false], [fmtDate(ep.end), true], ['.', false]]
        : t === ep.start ? [['Early voting starts today, ', false], [dayNoWeek(ep.start), true], ['.', false]]
          : t === ep.end ? [[later ? 'Early voting ends today in some counties.' : 'Today is the last day of early voting.', false]]
            : [['Early voting is open through ', false], [fmtDate(ep.end), true], ['.', false]];
    const more = !later ? [] : t > ep.end ? ['Check whether yours does.'] : [`${t === ep.end && !absolute ? 'Others stay' : 'Some counties stay'} open through ${fmtDate(later)}. Check yours.`];
    return { phase: 'early_open', head, sub: [...more, ...sub, `Or vote on Election Day, ${fmtDate(h.election_date)}, until ${close}.`], primary: look ? { label: 'Find early voting places', url: look, look: lookKind } : null };
  }
  return {
    phase: 'election_day_next',
    head: [['Vote on Election Day, ', false], [fmtDate(h.election_date), true], ['.', false]],
    sub: [PLAIN_TIME.test(ed.polls_open || '') ? `Polls are open ${clock(ed.polls_open)} to ${close}.` : `Polls close at ${close}.`], primary: ed.lookup_url ? { label: 'Find your polling place', url: ed.lookup_url, look: 'election_day' } : null,
  };
}
/* Whether a ballot's polls have closed and the page is about results now (Nov 3): the strip's phase, which the bar,
   the endcap, My plan (retitled What's next) and step 5 (Share the guide) all follow. */
export const afterPolls = (h: HowTo | null | undefined): boolean => { if (!h) return false; const p = nextStep(h).phase; return p === 'results_counting' || p === 'results_official'; };
/* Results are never called official in Phase 0 (GPT copy pass, Nov 3): a deadline passing proves nothing, so the strip
   keeps counting and the dates read as deadlines (officialLines). `results_official` waits for a source's own word. */
export function officialNow(_h: HowTo, _t = todayISO()): boolean {
  return false;
}
/* The one line under the strip's head on Election Day (Nov 3): the county's own line about when it posts, or on a
   statewide-only ballot the state's. A ballot across counties whose county isn't known shows none (each county's
   button names its office). After Election Day, none: most say "tonight". */
export function resultsNotes(h: HowTo, t: string): string[] {
  if (t !== h.election_date) return [];
  const rs = h.results?.sources || [];
  const county = rs.filter((r) => r.kind === 'county');
  if (county.length === 1) return [county[0].wait_line];
  if (!county.length) return rs.filter((r) => r.kind === 'state').map((r) => r.wait_line).slice(0, 1);
  return [];
}
/* When the counts become official (Nov 3), as deadlines, never as done: "Travis County makes its results official by
   Nov 17." and "Texas makes statewide results official by Dec 7." Only the data's sure dates; once one has passed,
   "Official results: check your election office." in its place, since a passed deadline proves nothing. With no sure
   date, the plain rule. Shown in the strip's fold and on What's next. */
export function officialLines(h: HowTo, t = todayISO()): string[] {
  const rs = h.results?.sources || [];
  const county = rs.filter((r) => r.kind === 'county');
  const state = rs.find((r) => r.kind === 'state');
  const d = (x: string): string => fmtDate(x, { weekday: false });
  const sure = (r: ResultsSource): boolean => !!r.official_by && r.official_by_sure;
  const out: string[] = [];
  let passed = false;
  if (county.length && county.every(sure)) {
    const last = county.map((r) => r.official_by!).sort().pop()!;
    if (t > last) passed = true;
    else out.push(county.length === 1 ? `${county[0].label || county[0].name} makes its results official by ${d(last)}.` : `Each county makes its results official by ${d(last)} at the latest.`);
  }
  if (state && sure(state)) {
    if (t > state.official_by!) passed = true;
    else out.push(`${state.label || 'The state'} makes ${county.length ? 'statewide ' : ''}results official by ${d(state.official_by!)}.`);
  }
  if (passed) out.push('Official results: check your election office.');
  if (!out.length) out.push('Counts can change until the election office makes results official.');
  return out;
}
/* AP's results page for a state (Nov 3; Kevin chose AP only for race calls): the outlet's own state page, from the
   URL pattern in the workbench's registry/news-links.json, checked for all 15 covered states Nov 3. AP calls races;
   the guide doesn't, so this is a link out, labeled as theirs. */
const AP_NAME: Record<string, string> = { DC: 'District of Columbia' }; // AP's own name where ours differs ("Washington, DC")
export const apStateURL = (st: string, stateName: string): string => `https://apnews.com/projects/elections-2026/${(AP_NAME[st] || stateName).toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '')}-results/`;

/* The first page once polls start closing (Kevin, Nov 3: lead with "results are rolling in", not "voting has
   ended"). A state counts as closed by nextStep's own rule: past Election Day, or past its close in every zone it
   spans, so a California voter at 4 PM Pacific is never told it's over. Null until the first state closes, and the
   first page is then exactly as before. `now` as in nextStep. */
export function pollsShut(electionDate: string, pollsClose: string, zones: string[], t = todayISO(), now: number | Date | null = nowOverride()): boolean {
  if (t !== electionDate) return t > electionDate;
  const closesAt = clockMinutes(pollsClose);
  if (closesAt == null) return false;
  const at = now instanceof Date ? now : new Date();
  const past = (z: string | null): boolean => {
    const { date, min } = typeof now === 'number' ? { date: electionDate, min: now } : zonedNow(z, at);
    return date > electionDate || (date === electionDate && min >= closesAt);
  };
  return zones.length ? zones.every(past) : past(null);
}
const ZONE_WORD: Record<string, string> = { 'America/New_York': 'Eastern', 'America/Chicago': 'Central', 'America/Denver': 'Mountain', 'America/Boise': 'Mountain', 'America/Los_Angeles': 'Pacific' };
/* "8 PM Pacific", "7 PM Central (8 PM Eastern)", "7 PM local time": a still-voting state's close on the first page. */
function openUntil(pollsClose: string, zones: string[]): string {
  const at = clock(pollsClose);
  if (!at) return pollsClose;
  if (/\b(Eastern|Central|Mountain|Pacific)\b/.test(pollsClose)) return pollsClose.replace(/\b\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?(?=\s|$|\))/gi, (m) => clock(m) || m);
  if (zones.length > 1) return `${at} local time`;
  return zones.length && ZONE_WORD[zones[0]] ? `${at} ${ZONE_WORD[zones[0]]}` : at;
}
/* One covered state on the first page: its official results page once its polls close (the state's own site when
   we have no results page), or when voting there ends while it's still open; and, once every covered state has
   closed, its mail-ballot tracker. */
export interface ResultsRow { st: string; name: string; url: string | null; source: string | null; open: string | null; info: string | null; track: string | null }
/* `after`: every covered state has closed, so the page is results, tracking and your saved ballot, not a plan. */
export interface ResultsLead { after: boolean; head: string; sub: string[]; rows: ResultsRow[] }
export function resultsLead(states: Index['states'] | null | undefined, t = todayISO(), now: number | Date | null = nowOverride()): ResultsLead | null {
  const sts = Object.entries(states || {}).filter(([, s]) => s && s.polls_close && s.election_date);
  if (!sts.length) return null;
  const rows = sts.map(([st, s]) => {
    const zones = STATE_ZONES[st] || [];
    const shut = pollsShut(s.election_date, s.polls_close!, zones, t, now);
    // Still voting: when it ends. One zone: in that zone ("8 PM Pacific"). A state across zones whose close names
    // them (Tennessee's "7:00 PM Central (8:00 PM Eastern)") keeps both. One across zones whose close is one local
    // time (Texas, Florida, Oregon) says "local time": naming the zone that closes last told Austin "7 PM Mountain",
    // which reads as 8 PM Central (review, Nov 3).
    const open = shut ? null : `Polls close at ${openUntil(s.polls_close!, zones)}.`;
    const url = shut ? s.results_url || s.official_site?.url || null : null;
    const source = shut ? (s.results_url ? s.results_source || null : s.official_site?.name || null) : null;
    return { row: { st, name: s.name, url, source, open, info: shut ? null : s.official_site?.url || null, track: s.mail_tracking_url || null }, shut, voting: t <= s.election_date };
  });
  if (!rows.some((r) => r.shut)) return null;
  const after = rows.every((r) => r.shut);
  const today = rows.some((r) => r.voting);
  return {
    after,
    head: today ? 'Results are rolling in.' : 'Results are still coming in.',
    // While a covered state is still voting, its voters read this too, so nothing here says their polls are past
    // (review, Nov 3: a California voter at 4:05 PM Pacific read "Already in line?").
    sub: ['Official results for each state are below.', !today ? 'Counting can take days, especially for mail ballots.' : after ? 'Already in line? Stay in line. You still get to vote.' : 'Polls are still open in some states. In line when yours close? Stay in line. You still get to vote.'],
    rows: rows.map(({ row }) => ({ ...row, track: after ? row.track : null })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}
/* Who calls races (Nov 3, Kevin: "links to the sites that do predictions", then AP only, on the design review): AP's
   national page for this election, on the first page, which lists every state. A ballot's strip links AP's page for
   its own state (apStateURL). Under the official results only, labeled plainly. Checked Nov 3, 2026. */
export const RACE_CALLS: { name: string; url: string }[] = [
  { name: 'AP', url: 'https://apnews.com/projects/elections-2026/' },
];

/* The state's suggested last day to mail a ballot, read from its own advice ("Monday, October
   26 is the last suggested day", "so by about Tuesday, October 27"). A weekday that doesn't
   match the date, or a date on or after Election Day, means the sentence isn't the one we
   want, so nothing is read. */
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export function mailBy(h: HowTo): { date: string; about: boolean } | null {
  const a = h.mail_ballot.mail_cutoff_advice || '';
  const m = a.match(/\b(about\s+)?(?:(sunday|monday|tuesday|wednesday|thursday|friday|saturday),?\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})\b/i);
  if (!m) return null;
  const y = +h.election_date.slice(0, 4);
  const mo = MONTHS.indexOf(m[3].toLowerCase());
  const d = new Date(Date.UTC(y, mo, +m[4]));
  if (d.getUTCMonth() !== mo) return null;
  if (m[2] && WEEKDAYS[d.getUTCDay()] !== m[2].toLowerCase()) return null;
  const iso = d.toISOString().slice(0, 10);
  if (iso >= h.election_date) return null;
  return { date: iso, about: !!m[1] };
}
const firstSentence = (s: string): string => { const m = s.match(/^(.+?[.!?])(\s|$)/); return (m ? m[1] : s).trim(); };

/* The button beside "Not registered?": the state's register page (registration.register_url, from
   the data track). "Register now" while any deadline is still ahead; once they have all passed,
   "Register for next time". When the only way left is in person (California after its online deadline:
   same-day registration at a vote center; audit, Oct 29), it opens where you can do that: the early
   voting page while early voting is open, then the Election Day one. Null when the state file has no
   register page and nothing else fits. */
const inPersonOnly = (h: HowTo, t: string): boolean => {
  const open = h.registration.deadlines.filter((d) => !!d.date && d.date >= t);
  return open.length > 0 && open.every((d) => d.method === 'in_person');
};
export function registerAction(h: HowTo, t = todayISO()): { label: string; url: string } | null {
  const url = h.registration.register_url;
  if (inPersonOnly(h, t)) {
    const ep = h.early_in_person;
    const where = (ep.available && ep.lookup_url && (!ep.end || t <= ep.end) ? ep.lookup_url : null) || h.election_day.lookup_url;
    if (where) return { label: 'Find where to register and vote', url: where };
  }
  if (!url) return null;
  const open = h.registration.deadlines.some((d) => !!d.date && d.date >= t);
  return { label: open ? 'Register now' : 'Register for next time', url };
}
/* "Not registered?" when a registration deadline is within a week, from the state file. */
export function registrationAlert(h: HowTo, t = todayISO(), absolute = false): string | null {
  const open = h.registration.deadlines.filter((d) => d.date && d.date >= t).sort((a, b) => (a.date! < b.date! ? -1 : 1));
  if (!open.length) return null;
  const first = open[0];
  if (daysBetween(t, first.date!) > 7) return null;
  if (inPersonOnly(h, t)) {
    const last = open[open.length - 1];
    const same = h.registration.same_day_registration ? ' and vote' : '';
    return last.date === t && !absolute ? `Not registered? You can still register in person${same} today.` : `Not registered? You can still register in person${same} through ${day(last.date!, t, absolute)}.`;
  }
  const how = (m: string) => (m === 'online' ? 'online' : m === 'mail' ? 'by mail' : 'in person');
  const allSame = open.every((d) => d.date === first.date);
  const today = first.date === t && !absolute;
  const firstLine = allSame
    ? `${today ? 'Today is the last day to register' : `The last day to register is ${fmtDate(first.date)}`}.`
    : today ? `Today is the last day to register ${how(first.method)}.` : `Register ${how(first.method)} by ${day(first.date!, t, absolute)}.`;
  const later = open.filter((d) => d.date !== first.date).pop();
  const laterLine = later && later.method === 'in_person' && later.date === h.election_date && h.registration.same_day_registration
    ? (today ? ' After that, you can still register and vote in person.' : ' Or in person through Election Day.')
    : later ? ` ${how(later.method).charAt(0).toUpperCase()}${how(later.method).slice(1)}: by ${fmtDate(later.date)}.` : '';
  return `Not registered? ${firstLine}${laterLine}`;
}
