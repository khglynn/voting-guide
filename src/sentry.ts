/* The crash-report client: a chunk of its own, fetched by errors.ts once the page has loaded and gone
   idle, and only in a production build with VITE_SENTRY_DSN set. About 24 KB gzipped (the real number
   for each build is in the pull request that changed it); first paint never waits for it.

   Sentry's trimmed browser client, not Sentry.init(): only the three integrations below, so nothing
   records clicks, console lines, fetches or the page's address (Sentry's HttpContext integration would
   copy location.href, hash and all), and no replay, tracing, feedback widget or session tracking.
   Every event passes scrub.ts on its way out, and a page load sends at most five, so one bad loop
   can't use up the month's shared quota.

   Off switch: remove VITE_SENTRY_DSN from the Vercel project (production and preview) and redeploy.
   The client never loads without it. */
import {
  BrowserClient, defaultStackParser, makeFetchTransport, setCurrentClient, captureException,
  globalHandlersIntegration, dedupeIntegration, linkedErrorsIntegration,
} from '@sentry/browser';
import { scrubEvent, envelopeAllowed, type ScrubContext } from './scrub';

/* What errors.ts hands over, so this chunk never imports from the page's own bundle (a crash while that
   bundle starts up leaves it unusable to any module that imports it, and that crash is the one we most
   want to hear about). */
export interface Deps {
  words: () => string[];                                   // the address, typed or matched (privateWords)
  hashes: () => string[];                                  // every hash the page has had (seenHashes)
  mentions: (text: string, words: string[]) => boolean;    // mentionsPrivate
  bare: (s: string) => string;                             // bareURLs
}

const PER_LOAD = 5;
let sent = 0;
let lastSent: string | undefined;

/* Starts the client, sends the errors that waited for it, and hands back the way to send the next one. */
export function start(early: unknown[], deps: Deps): (e: unknown) => void {
  const ctx = (): ScrubContext => {
    const words = deps.words();
    return { origin: location.origin, path: location.pathname, hashes: deps.hashes(), mentions: (t) => deps.mentions(t, words), bare: deps.bare, ua: navigator.userAgent };
  };
  // The last look, at the very bytes about to leave: anything that still names the Census lookup, holds
  // the address or a save link never goes, whichever way the SDK built it.
  const guarded = (url: string, init?: RequestInit): Promise<Response> => {
    const body = init && init.body;
    const text = typeof body === 'string' ? body : body instanceof Uint8Array ? new TextDecoder().decode(body) : '';
    let ok = false;
    try { ok = envelopeAllowed(text, ctx()); } catch { /* a check that failed sends nothing */ }
    if (!ok) return Promise.reject(new Error('Crash report held back by the privacy check'));
    return fetch(url, init);
  };
  const client = new BrowserClient({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    release: import.meta.env.VITE_BUILD || undefined,
    environment: import.meta.env.VITE_VERCEL_ENV || 'local',
    transport: (options) => makeFetchTransport(options, guarded),
    stackParser: defaultStackParser,
    // Uncaught errors and rejections; the same error twice in a row once; an error's `cause` chain.
    integrations: [globalHandlersIntegration(), dedupeIntegration(), linkedErrorsIntegration()],
    maxBreadcrumbs: 0,
    beforeBreadcrumb: () => null,
    sendClientReports: false,
    enhanceFetchErrorMessages: false, // "Failed to fetch" stays as the browser said it, without a host added
    // userInfo off also tells Sentry's servers never to fill in the IP from the connection
    // (BrowserClient sets sdk.settings.infer_ip to "never").
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, urlQueryParams: false, httpBodies: [] },
    beforeSend(event) {
      try {
        if (sent >= PER_LOAD) return null;
        const out = scrubEvent(event, ctx());
        if (out) sent++;
        return out;
      } catch {
        return null; // a scrub that failed sends nothing
      }
    },
  });
  // The id the problem report shows is one Sentry actually took in, not one an ad blocker stopped.
  client.on('afterSendEvent', (event, res) => {
    const code = res && typeof res === 'object' ? res.statusCode : undefined;
    if (event.event_id && code !== undefined && code >= 200 && code < 300) lastSent = event.event_id;
  });
  setCurrentClient(client);
  client.init();
  for (const e of early) captureException(e);
  return (e) => { captureException(e); };
}
export const lastSentId = (): string | undefined => lastSent;
