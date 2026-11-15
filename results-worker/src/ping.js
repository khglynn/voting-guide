/* The fetcher's alerts, posted by Gabby's bot into #gabby-log, her muted log channel, as replies under one post per
   election. Kevin, Nov 4, of the alerts that had landed one by one at the top of his DM: "They can all sit under one
   post in gabby log". So they're on record without buzzing anyone, and nothing goes to the DM any more.
   Stuck only (refused, failing 30 minutes, an election mismatch, a falling total, a stale read-back, a map out of date),
   deduped on `alert:{source}:{reason}` for 6 hours once Slack has it (10 minutes when it didn't); one done line when every source has stopped.
   The parent's channel and ts are kept in KV (`slack:thread:{election}`), so a deploy or a fresh isolate keeps replying
   under the same post, and one pinger (one tick) makes it at most once, however many sources raise an alert at once.
   When the parent can't be made, or a reply under it is refused, the alert goes to the channel as a plain post; a reply
   refused because the thread is gone also forgets the parent, so the next alert starts a new one.
   Secrets: SLACK_BOT_TOKEN and SLACK_LOG_CHANNEL (#gabby-log's ID). Without them it only logs. */
import { ELECTION } from './util.js';

export const THREAD_KEY = `slack:thread:${ELECTION}`;
const STATUS = 'https://vg-results.kevinhg.workers.dev/results/status';
const DAY = new Date(`${ELECTION}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
export const PARENT_TEXT = `Results fetcher, ${DAY} election: its alerts, one reply each. Every source's state: ${STATUS}`;
// Slack's thread errors (cannot_reply_to_message, restricted_action_thread_locked, ...) and the ones it may give for a
// parent that was deleted. A rate limit or an outage keeps the parent.
const THREAD_GONE = /thread|reply|message_not_found/;
export const MUTE_S = 6 * 3600; // a sent alert stays quiet this long
export const RETRY_S = 600; // an alert Slack didn't take is tried again after this long

export function makePinger({ fetch, store, token, channel, log = console.log, timeoutMs = 10_000 }) {
  const post = async (text, thread_ts) => {
    try {
      const r = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel, text, unfurl_links: false, unfurl_media: false, ...(thread_ts ? { thread_ts } : {}) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  };
  const keptTs = async () => {
    const raw = await store.get(THREAD_KEY);
    try { const kept = JSON.parse(raw || 'null'); return kept?.channel === channel && kept.ts ? kept.ts : null; } catch { return null; }
  };
  const findParent = async () => {
    // A KV read that fails says nothing about the parent: post plain this tick rather than make a second one.
    let kept;
    try { kept = await keptTs(); } catch (e) { log(`slack thread key: ${e.message}`); return null; }
    if (kept) return kept;
    const made = await post(PARENT_TEXT);
    if (!made.ok) { log(`slack parent: ${made.error}`); return null; }
    // A failed write still threads this tick's alerts; the next tick would start a second parent, so say so.
    try { await store.put(THREAD_KEY, JSON.stringify({ channel, ts: made.ts, made: new Date().toISOString() })); } catch (e) { log(`slack thread key not kept: ${e.message}`); }
    return made.ts;
  };
  let parent = null; // this pinger's one find-or-make, shared by every alert it sends

  // The alert's slot is claimed for RETRY_S before it posts, so two alerts at once can't both post, and becomes the
  // 6-hour mute only once Slack has the post: a Slack outage then retries every 10 minutes instead of muting the alert
  // for six hours (fix of Nov 15, from voting-guide#146's review).
  const muteFor = async (key, at, ttl) => {
    try { await store.put(key, at, { expirationTtl: ttl }); } catch (e) { log(`alert key not kept: ${e.message}`); }
  };

  return async function ping(source, reason, text) {
    const key = `alert:${source}:${reason}`;
    if (await store.get(key)) return false;
    const at = new Date().toISOString();
    const line = `Results fetcher: ${text}`;
    if (!token || !channel) {
      await store.put(key, at, { expirationTtl: MUTE_S });
      log(`ping ${key}: ${line}`);
      return false;
    }
    await store.put(key, at, { expirationTtl: RETRY_S });
    log(`ping ${key}: ${line}`);
    const sent = await deliver(line);
    if (sent) await muteFor(key, at, MUTE_S);
    return sent;
  };

  async function deliver(line) {
    const asked = (parent ??= findParent());
    const ts = await asked;
    if (ts) {
      const reply = await post(line, ts);
      if (reply.ok) return true;
      log(`slack reply: ${reply.error}`);
      // Forget only the parent that failed: another alert may already have made the next one.
      if (THREAD_GONE.test(reply.error)) {
        if (parent === asked) parent = null;
        try { if ((await keptTs()) === ts) await store.delete(THREAD_KEY); } catch (e) { log(`slack thread key: ${e.message}`); }
      }
    }
    const sent = await post(line);
    if (!sent.ok) log(`slack post: ${sent.error}`);
    return !!sent.ok;
  }
}
