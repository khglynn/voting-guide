/* The next step and its date, computed from the state file for every voting model.
   Never a countdown. Dates come only from data/states/{ST}.json; `?today=` overrides the
   clock for testing (util.todayISO). */
import type { Dated, HelpAction, HowTo, Lookups, PlaceBundle } from '../types';
import { fmtDate, todayISO, daysBetween, nowOverride, zonedNow } from '../util';

export type Part = [string, boolean]; // text, emphasized (a date or time)
export interface Step {
  head: Part[];
  sub: string[];
  /* `look`: which kind of where-to-vote tool the button opens, so a ballot across county lines can offer
     each county's (planstrip.ts) */
  primary: { label: string; url: string; look?: keyof Lookups } | null;
  phase: 'closed' | 'polls_closed' | 'election_day' | 'mail' | 'early_before' | 'early_open' | 'election_day_next';
}

export const isMailState = (h: HowTo): boolean => h.voting_model === 'all_mail' || h.voting_model === 'mail_to_all_plus_in_person';

/* "7:00 PM MT" -> "7 PM"; "8:00 PM PT (drop box, ...)" -> "8 PM"; null when there is no time. */
export function clock(s: string | null | undefined): string | null {
  const m = (s || '').match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b/i);
  if (m) return `${m[1]}${m[2] && m[2] !== '00' ? `:${m[2]}` : ''} ${m[3].toUpperCase()}M`;
  if (/\bnoon\b/i.test(s || '')) return 'noon';
  return null;
}
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
   the early voting page while early voting is open, then the Election Day one (Codex on part B). */
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
    return k && now[k] && now[k] !== a.url ? { ...a, url: now[k]! } : a;
  };
  return { ...h, situations: h.situations!.map((x) => (x.actions && x.actions.length ? { ...x, actions: x.actions.map(swap) } : x)) };
}

function placeHowto(h0: HowTo, places: PlaceBundle[], county: string | null): HowTo {
  let h = places.length ? { ...h0, zones: zonesFor(h0.state, places) } : h0;
  // The county's own where-to-vote tools win over the state's statewide lookups, when every
  // place on the ballot points to the same one.
  const looks = places.map((p) => lookupsFor(p, county));
  const one = (k: keyof Lookups): string | null => {
    const urls = [...new Set(looks.map((l) => l?.[k] || null))];
    return places.length && urls.length === 1 && urls[0] ? urls[0] : null;
  };
  // Unknown county on a ballot whose every place spans counties: each county's tools, labeled, in the
  // order the first place lists them. (A county the Census names that no place lists keeps the state's.)
  if (!county && places.length && places.every((p) => p.by_county && p.by_county.length > 1)) {
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
  const eps = places.map((p) => p.early_in_person);
  if (!eps.length || eps.some((e) => !e)) return h;
  const first = eps[0]!;
  if (eps.some((e) => e!.start !== first.start || e!.end !== first.end)) return h;
  const notes = [...new Set(eps.map((e) => e!.hours_note).filter((n): n is string => !!n))];
  const pages = [...new Set(eps.map((e) => e!.lookup_url))];
  return {
    ...h,
    early_in_person: {
      ...h.early_in_person, available: true, start: first.start, end: first.end,
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
  // Polls that close at one moment in two zones ("7:00 PM Central (8:00 PM Eastern)", Tennessee) keep
  // both times on a ballot that spans the zones, where "7 PM" would be an hour early for half of it.
  const both = zones.length > 1 && /\b(Eastern|Central|Mountain|Pacific)\b/.test(ed.polls_close);
  const close = both ? ed.polls_close : clock(ed.polls_close) || ed.polls_close;
  if (t > h.election_date) {
    return { phase: 'closed', head: [['Voting has closed. Thank you for taking part.', false]], sub: mb.tracking_url ? ['Mailed a ballot? You can check that it was counted.'] : [], primary: mb.tracking_url ? { label: 'Track your ballot', url: mb.tracking_url } : null };
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
      return {
        phase: 'polls_closed',
        head: [[isMailState(h) ? 'Voting closed at ' : 'Polls closed at ', false], [close, true], ['. Already in line? Stay in line.', false]],
        sub: ed.in_line_rule ? [ed.in_line_rule] : [],
        primary: mb.tracking_url ? { label: 'Track your ballot', url: mb.tracking_url } : null,
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
  if (ep.available && ep.start && ep.end && t <= ep.end) {
    const head: Part[] = absolute ? [['Early voting is open through ', false], [fmtDate(ep.end), true], ['.', false]]
      : t === ep.start ? [['Early voting starts today, ', false], [dayNoWeek(ep.start), true], ['.', false]]
        : t === ep.end ? [['Today is the last day of early voting.', false]]
          : [['Early voting is open through ', false], [fmtDate(ep.end), true], ['.', false]];
    return { phase: 'early_open', head, sub: [...sub, `Or vote on Election Day, ${fmtDate(h.election_date)}, until ${close}.`], primary: look ? { label: 'Find early voting places', url: look, look: lookKind } : null };
  }
  return {
    phase: 'election_day_next',
    head: [['Vote on Election Day, ', false], [fmtDate(h.election_date), true], ['.', false]],
    sub: [`Polls are open ${clock(ed.polls_open) || ed.polls_open} to ${close}.`], primary: ed.lookup_url ? { label: 'Find your polling place', url: ed.lookup_url, look: 'election_day' } : null,
  };
}
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
   "Register for next time". Null when the state file has no register page. */
export function registerAction(h: HowTo, t = todayISO()): { label: string; url: string } | null {
  const url = h.registration.register_url;
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
