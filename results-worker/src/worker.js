/* The Worker: routes plus the one-minute cron (PLAN-PHASE-1 section 1).
   GET  /results/2026-11-03/{ST}.json          the published file (30 s cache, open to any site, noindex)
   GET  /results/preview/2026-11-03/{ST}.json  every source, checked or not (for the first-run checker)
   GET  /results/status                        one line per source
   POST /results/run?source={id}               run one source now (Authorization: Bearer RUN_TOKEN)
   POST /results/feed?source={id}[&end=1]      a read made on the Air, replayed and published here (Bearer FEED_TOKEN;
                                               src/relay.js, bin/feed.mjs); only AIR_SOURCES; 409 while the stop flag
                                               is set; 412 when the Air's map isn't the deployed one */
import { runTick } from './tick.js';
import { replayFetch, answersProblem, MAX_POST, AIR_SOURCES } from './relay.js';
import { mapHash } from './fingerprint.js';
import { statusPage } from './status.js';
import { makePinger } from './ping.js';
import { MAPS } from './maps.gen.js';
import { TEST_FILES } from '../static/test-files.js';

const FILE_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=30, s-maxage=30', 'Access-Control-Allow-Origin': '*', 'X-Robots-Tag': 'noindex' };
const json = (obj, status = 200, extra = {}) => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status, headers: { ...FILE_HEADERS, ...extra } });

const pinger = (env) => makePinger({ fetch: (...a) => fetch(...a), store: env.RESULTS, token: env.SLACK_BOT_TOKEN, channel: env.SLACK_LOG_CHANNEL });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' } });

    let m = p.match(/^\/results\/2026-11-03\/([A-Z]{2})\.json$/);
    if (m && (request.method === 'GET' || request.method === 'HEAD')) {
      const body = await env.RESULTS.get(`file:${m[1]}`);
      if (body) return json(body);
      if (TEST_FILES[m[1]]) return json(TEST_FILES[m[1]]);
      return json({ error: `no results file for ${m[1]}` }, 404);
    }
    m = p.match(/^\/results\/preview\/2026-11-03\/([A-Z]{2})\.json$/);
    if (m && request.method === 'GET') {
      const body = await env.RESULTS.get(`preview:${m[1]}`);
      return body ? json(body, 200, { 'Cache-Control': 'no-store' }) : json({ error: `no preview file for ${m[1]} yet` }, 404, { 'Cache-Control': 'no-store' });
    }
    if ((p === '/results/status' || p === '/results/status/') && request.method === 'GET') {
      return new Response(await statusPage({ store: env.RESULTS, maps: MAPS }), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
    }
    if (p === '/results/run' && request.method === 'POST') {
      const auth = request.headers.get('authorization') || '';
      if (!env.RUN_TOKEN || auth !== `Bearer ${env.RUN_TOKEN}`) return json({ error: 'not allowed' }, 401, { 'Cache-Control': 'no-store' });
      const source = url.searchParams.get('source');
      if (!MAPS.some((x) => x.id === source)) return json({ error: `no map for ${source}` }, 404, { 'Cache-Control': 'no-store' });
      const out = await runTick({ fetch: (...a) => fetch(...a), store: env.RESULTS, archive: env.ARCHIVE, maps: MAPS, only: source, ping: pinger(env) });
      return json(out, 200, { 'Cache-Control': 'no-store' });
    }
    if (p === '/results/feed' && request.method === 'POST') {
      const no = { 'Cache-Control': 'no-store' };
      const auth = request.headers.get('authorization') || '';
      if (!env.FEED_TOKEN || auth !== `Bearer ${env.FEED_TOKEN}`) return json({ error: 'not allowed' }, 401, no);
      const source = url.searchParams.get('source');
      const map = MAPS.find((x) => x.id === source);
      if (!map || !AIR_SOURCES.includes(source)) return json({ error: `${source} isn't one the Air reads` }, 403, no);
      if (url.searchParams.get('end') === '1') {
        const out = await runTick({ fetch: () => { throw new Error('no reads when ending'); }, store: env.RESULTS, archive: env.ARCHIVE, maps: MAPS, only: source, fed: true, end: true, ping: pinger(env) });
        return json(out, out.stopped ? 409 : 200, no);
      }
      if (Number(request.headers.get('content-length')) > MAX_POST) return json({ error: 'too large' }, 413, no);
      let body;
      try { body = JSON.parse(await request.text()); } catch { return json({ error: 'not JSON' }, 400, no); }
      const bad = answersProblem(body?.answers);
      if (bad) return json({ error: bad }, 400, no);
      // The Air reads with its checkout's map, the Worker replays with the deployed one: a map merged but not deployed
      // (or the other way round) would fail every replay with a puzzling "no answer for ...", so say it plainly.
      const mine = await mapHash(map);
      if (body.map_hash && body.map_hash !== mine) return json({ error: `the Air's map for ${source} (${body.map_hash}) isn't the deployed one (${mine}): deploy, or wait for the Air's hourly code refresh` }, 412, no);
      const out = await runTick({ fetch: replayFetch(body.answers), store: env.RESULTS, archive: env.ARCHIVE, maps: MAPS, only: source, fed: true, ping: pinger(env) });
      return json(out, out.stopped ? 409 : 200, no);
    }
    if (p === '/' || p === '/results' || p === '/results/') return Response.redirect(`${url.origin}/results/status`, 302);
    return json({ error: 'not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runTick({ fetch: (...a) => fetch(...a), store: env.RESULTS, archive: env.ARCHIVE, maps: MAPS, now: new Date(event.scheduledTime).toISOString(), ping: pinger(env) }).then((r) => console.log(JSON.stringify({ tick: r.stopped ? 'stopped' : r.ran?.map((x) => `${x.id}:${x.outcome}${x.error ? `:${x.error}` : ''}`), ...(r.published?.some((p) => p.error) ? { publish_errors: r.published.filter((p) => p.error) } : {}) })))
      // What still escapes (the schedule's own KV read or write) is logged, never a silent stop.
      .catch((e) => console.log(JSON.stringify({ tick: 'crashed', error: String(e?.message || e) }))));
  },
};
