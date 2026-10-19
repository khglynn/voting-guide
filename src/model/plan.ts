/* The next step and its date, computed from the state file for every voting model.
   Never a countdown. Dates come only from data/states/{ST}.json; `?today=` overrides the
   clock for testing (util.todayISO). */
import type { HowTo, PlaceBundle } from '../types';
import { fmtDate, todayISO, daysBetween, nowOverride, zonedNow } from '../util';

export type Part = [string, boolean]; // text, emphasized (a date or time)
export interface Step {
  head: Part[];
  sub: string[];
  primary: { label: string; url: string } | null;
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
  PA: ['America/New_York'], TX: ['America/Chicago', 'America/Denver'], WA: ['America/Los_Angeles'],
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

/* A county that runs its own early-voting days (Florida counties choose theirs inside the
   state's range) carries them in its place file. When every place on this ballot agrees,
   the plan uses the county's window, hours and lookup page; otherwise the state's stands. */
export function localHowto(h0: HowTo, places: PlaceBundle[]): HowTo {
  let h = places.length ? { ...h0, zones: zonesFor(h0.state, places) } : h0;
  // The county's own where-to-vote tools win over the state's statewide lookups, when every
  // place on the ballot points to the same one.
  const one = (k: 'early_in_person' | 'election_day' | 'drop_box'): string | null => {
    const urls = [...new Set(places.map((p) => p.lookups?.[k] || null))];
    return places.length && urls.length === 1 && urls[0] ? urls[0] : null;
  };
  const le = one('early_in_person'), ld = one('election_day'), lb = one('drop_box');
  if (le || ld || lb) {
    h = {
      ...h,
      early_in_person: le ? { ...h.early_in_person, lookup_url: le } : h.early_in_person,
      election_day: ld ? { ...h.election_day, lookup_url: ld } : h.election_day,
      mail_ballot: lb ? { ...h.mail_ballot, drop_box_lookup_url: lb } : h.mail_ballot,
    };
  }
  const eps = places.map((p) => p.early_in_person);
  if (!eps.length || eps.some((e) => !e)) return h;
  const first = eps[0]!;
  if (eps.some((e) => e!.start !== first.start || e!.end !== first.end)) return h;
  const notes = [...new Set(eps.map((e) => e!.hours_note).filter((n): n is string => !!n))];
  const looks = [...new Set(eps.map((e) => e!.lookup_url))];
  return {
    ...h,
    early_in_person: {
      ...h.early_in_person, available: true, start: first.start, end: first.end,
      hours_note: notes.length ? notes.join(' ') : h.early_in_person.hours_note,
      lookup_url: le || (looks.length === 1 && looks[0] ? looks[0] : h.early_in_person.lookup_url),
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
  const close = clock(ed.polls_close) || ed.polls_close;
  if (t > h.election_date) {
    return { phase: 'closed', head: [['Voting has closed. Thank you for taking part.', false]], sub: mb.tracking_url ? ['Mailed a ballot? You can check that it was counted.'] : [], primary: mb.tracking_url ? { label: 'Track your ballot', url: mb.tracking_url } : null };
  }
  if (t === h.election_date) {
    const closesAt = clockMinutes(ed.polls_close);
    const zones = h.zones || STATE_ZONES[h.state] || [];
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
      head: absolute ? [[`Election Day is ${fmtDate(h.election_date)}. ${zones.length > 1 ? 'Your local polls' : 'Polls'} close at `, false], [close, true], ['.', false]]
        : [[`Today is Election Day. ${zones.length > 1 ? 'Your local polls' : 'Polls'} close at `, false], [close, true], ['.', false]],
      sub, primary: url ? { label: isMailState(h) && mb.drop_box_lookup_url ? 'Find a drop box or vote center' : 'Find where to vote', url } : null,
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
    return { phase: 'mail', head, sub, primary: mb.drop_box_lookup_url ? { label: 'Find a drop box', url: mb.drop_box_lookup_url } : ed.lookup_url ? { label: 'Find where to vote', url: ed.lookup_url } : null };
  }
  const look = ep.lookup_url || ed.lookup_url;
  const sub: string[] = [];
  if (ep.vote_centers) sub.push('You can vote at any early voting location in your county.');
  if (ep.available && ep.start && t < ep.start) {
    const d = daysBetween(t, ep.start);
    return {
      phase: 'early_before',
      head: d === 1 && !absolute ? [['Early voting starts tomorrow, ', false], [dayNoWeek(ep.start), true], ['.', false]] : [['Early voting starts ', false], [fmtDate(ep.start), true], ['.', false]],
      // A statewide window whose own note says counties may add days (Florida) says so, since
      // some voters can start sooner.
      sub: [ep.end ? `It runs through ${fmtDate(ep.end)}.` : '', /counties may add days|some counties open earlier/i.test(ep.hours_note || '') ? 'Some counties open sooner. Check yours.' : '', ...sub].filter(Boolean), primary: look ? { label: 'Find early voting places', url: look } : null,
    };
  }
  if (ep.available && ep.start && ep.end && t <= ep.end) {
    const head: Part[] = absolute ? [['Early voting is open through ', false], [fmtDate(ep.end), true], ['.', false]]
      : t === ep.start ? [['Early voting starts today, ', false], [dayNoWeek(ep.start), true], ['.', false]]
        : t === ep.end ? [['Today is the last day of early voting.', false]]
          : [['Early voting is open through ', false], [fmtDate(ep.end), true], ['.', false]];
    return { phase: 'early_open', head, sub: [...sub, `Or vote on Election Day, ${fmtDate(h.election_date)}, until ${close}.`], primary: look ? { label: 'Find early voting places', url: look } : null };
  }
  return {
    phase: 'election_day_next',
    head: [['Vote on Election Day, ', false], [fmtDate(h.election_date), true], ['.', false]],
    sub: [`Polls are open ${clock(ed.polls_open) || ed.polls_open} to ${close}.`], primary: ed.lookup_url ? { label: 'Find your polling place', url: ed.lookup_url } : null,
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
