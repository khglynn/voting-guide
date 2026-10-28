/* Visit counts (Kevin, Oct 28: "I would like the telemetry ... Let's turn it on."), through Vercel Web
   Analytics: no cookies, nothing written to the browser's storage, and a visitor is a hash Vercel builds
   from the request and drops after 24 hours. A page view or an event carries the page's address, the
   referring site when it's another one, and what Vercel adds at its edge (rough location, browser, OS,
   device type; the IP itself isn't kept with it).

   What this file adds on top, and the rules that keep it impersonal:
   - The script loads only on the guide's own Vercel hosts (vote.kevinhg.com and *.vercel.app), once the
     page has loaded and gone idle, from a chunk of its own, the way the crash reports do (errors.ts).
     Local dev, vite preview and every test run never load it.
   - Every address it sends is cut to its origin and path (cleanUrl): no hash, where a save link's picks
     ride, and no query (?try=). One whose path still holds five digits in a row (a ZIP) or an at sign
     isn't sent at all.
   - The referring site goes as its origin only (referrerOrigin). beforeSend can't trim it: Vercel's script
     reads document.referrer after beforeSend runs and sends it whole whenever it's another host, and the
     site that linked here sets how much of its own address that holds (our Referrer-Policy header only
     governs links out of the guide). So startStats() shadows document.referrer on this page, before the
     script loads, with just its origin.
   - A few events (track), each a fixed name with coarse, finite values: the state, how a ballot opened,
     which form posted, which screen showed, a save link made or opened. Never a ZIP, an address, a Census
     answer, a pick, a contact or anything typed. A value that isn't a short plain token, or that holds
     five digits in a row, drops the whole event.
   - Only va('event') goes out, through track(). Never call identify, group or enableCookie: they write
     the browser's storage or a cookie. The script itself is Vercel's, served from /_vercel/insights and
     not pinned (only the loader package is); beforeSend is the guard.
   The How text's "Your privacy" item (views/shelf.ts) promises this: read it before changing anything here.
   Off switch: turn Web Analytics off for the project in Vercel, or take startStats() out of main.ts. */
import type { BeforeSendEvent } from '@vercel/analytics';

/* The dashboard's vocabulary. Keep names, keys and values stable. */
export interface Events {
  /* A ballot shown: its state code, never its place; and how it opened (the ZIP box, an address, a save
     link, this device's saved ballot, or the list of cities). Every ballot counts by its state: some
     places, and every set of several places (DC's wards, Aurora and Denver), come from exactly one ZIP
     in the index, so a place would name the ZIP someone typed. Any ZIP in a state opens at least its
     statewide ballot, so a state never does. */
  ballot: { state: string; how: 'zip' | 'address' | 'shared' | 'returning' | 'list' };
  /* A form or one-tap request that went out (actions.ts). */
  request: { kind: 'city' | 'picks' | 'source' | 'report' | 'follow_up' };
  /* A screen shown: the first page, the ballot, My plan, Help friends vote, Full details. */
  view: { name: 'start' | 'ballot' | 'plan' | 'share' | 'reader' };
  /* made: the "Save a link to my picks" panel opened, showing the link (each time it opens); opened: a
     save link opened a ballot. */
  share: { act: 'made' | 'opened' };
}
export type EventName = keyof Events;

/* The guide's own hosts on Vercel: production (vote.kevinhg.com) and every *.vercel.app deployment. */
export const onVercel = (host: string): boolean =>
  host === 'kevinhg.com' || host.endsWith('.kevinhg.com') || host.endsWith('.vercel.app');

const ZIPLIKE = /\d{5}/;
/* An event's address, cut to its origin and path: the hash, the query and any user name go. Null (don't
   send it) when the path, as written or decoded, holds five digits in a row or an at sign, or the address
   won't parse or decode. Only the path is checked: a preview's host can hold five digits in a row
   (voting-guide-a12345bcd-kevinhg.vercel.app), and a host is the same for every visitor. */
export function cleanUrl(url: string): string | null {
  let u: URL;
  let read: string;
  try { u = new URL(String(url)); read = decodeURIComponent(u.pathname); } catch { return null; }
  return [u.pathname, read].some((s) => ZIPLIKE.test(s) || s.includes('@')) ? null : u.origin + u.pathname;
}
/* What Vercel's script runs on every page view and event before sending it: the address cut down, or
   nothing sent. Everything else on the event passes through as it came. */
export function beforeSend(e: BeforeSendEvent): BeforeSendEvent | null {
  const url = cleanUrl(e.url);
  return url === null ? null : { ...e, url };
}
/* The referring site, as Vercel may see it: the origin of an http(s) address ("https://example.org"),
   never its path or query, which can hold whatever the linking site put there (a search, a ZIP).
   Nothing for no referrer, or one that isn't a web address. */
export function referrerOrigin(ref: string): string {
  try {
    const u = new URL(String(ref));
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : '';
  } catch { return ''; }
}

/* A value an event may carry: a short plain token (a state code, one of the words above), never five
   digits in a row. */
const TOKEN = /^[A-Za-z0-9+_-]{1,120}$/;
export const plainData = (data: Record<string, unknown>): boolean =>
  Object.values(data).every((v) => typeof v === 'string' && TOKEN.test(v) && !ZIPLIKE.test(v));

/* On a Vercel host, events from before the script has loaded wait here (a save link and a returning
   visitor's ballot both open during boot, before the page goes idle), a few at most, and go once it
   has. Without this nearly every ballot would count as "zip". */
const wanted = typeof location !== 'undefined' && onVercel(location.hostname);
const EARLY = 20;
const early: [EventName, Record<string, string>][] = [];
let settled = false; // the chunk has loaded, or failed to

/* Count one event. Off Vercel it does nothing, unless window.va is already there: that is the package's
   own queue on Vercel, and the e2e's stub everywhere else. Never throws. */
export function track<K extends EventName>(name: K, data: Events[K]): void {
  try {
    if (!plainData(data)) return;
    const va = typeof window === 'undefined' ? undefined : window.va;
    if (typeof va === 'function') va('event', { name, data });
    else if (wanted && !settled && early.length < EARLY) early.push([name, { ...data }]);
  } catch { /* counting must never break the page */ }
}

/* Once the page has loaded and gone idle, on a Vercel host only: the package's chunk, which adds Vercel's
   script (/_vercel/insights/script.js) with our beforeSend, then the events that waited. An ad blocker or
   a dropped connection just means nothing is counted. */
export function startStats(): void {
  if (!wanted || typeof window === 'undefined') return;
  // Vercel's script reads document.referrer after beforeSend and sends another site's whole, so it may
  // only ever see the origin. An own property on this page's document shadows the browser's getter. If
  // that doesn't take, the script doesn't load at all.
  let shadowed = false;
  try {
    const ref = referrerOrigin(document.referrer);
    Object.defineProperty(document, 'referrer', { get: () => ref, configurable: true });
    shadowed = document.referrer === ref;
  } catch { /* shadowed stays false */ }
  if (!shadowed) { settled = true; early.length = 0; return; }
  const load = (): void => {
    import('@vercel/analytics')
      .then(({ inject }) => {
        inject({ mode: 'production', beforeSend });
        settled = true;
        for (const [name, data] of early.splice(0)) window.va?.('event', { name, data });
      })
      .catch(() => { settled = true; early.length = 0; });
  };
  const later = (): void => {
    if ('requestIdleCallback' in window) requestIdleCallback(load, { timeout: 4000 });
    else setTimeout(load, 2000);
  };
  if (document.readyState === 'complete') later();
  else window.addEventListener('load', later, { once: true });
}
