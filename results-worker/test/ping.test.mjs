/* The alerts' Slack path (ping.js): replies under one #gabby-log post, the fallbacks, and never Kevin's DM. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makePinger, THREAD_KEY, PARENT_TEXT } from '../src/ping.js';
import { memStore } from './helpers.mjs';

const LOG = 'C0LOGCHANNEL';

/* A fake Slack: every call recorded; `answer(body, n)` can refuse one (n counts this fake's posts from 0). */
function fakeSlack(answer = () => null) {
  const calls = [];
  let n = 0;
  const fn = async (url, opts = {}) => {
    const body = JSON.parse(opts.body || '{}');
    calls.push({ method: url.replace('https://slack.com/api/', ''), ...body });
    const refused = answer(body, n);
    const ts = `1793900000.${String(++n).padStart(6, '0')}`;
    return { status: 200, json: async () => refused || { ok: true, channel: body.channel, ts } };
  };
  fn.calls = calls;
  return fn;
}
const pinger = (fetch, store, extra = {}) => makePinger({ fetch, store, token: 'xoxb-test', channel: LOG, log: () => {}, ...extra });

test('the first alert makes one parent post in #gabby-log, keeps it, and replies under it; nothing goes to a DM', async () => {
  const slack = fakeSlack();
  const store = memStore();
  assert.equal(await pinger(slack, store)('dallas', 'refused', 'Dallas County refused our request (HTTP 403).'), true);
  assert.deepEqual(slack.calls.map((c) => c.method), ['chat.postMessage', 'chat.postMessage']);
  const [parent, reply] = slack.calls;
  assert.equal(parent.channel, LOG);
  assert.equal(parent.text, PARENT_TEXT);
  assert.match(PARENT_TEXT, /^Results fetcher, Nov 3 election: /);
  assert.equal(parent.thread_ts, undefined);
  assert.equal(reply.channel, LOG);
  assert.equal(reply.thread_ts, '1793900000.000001');
  assert.equal(reply.text, 'Results fetcher: Dallas County refused our request (HTTP 403).');
  assert.deepEqual(JSON.parse(store.m.get(THREAD_KEY)).ts, '1793900000.000001');
  assert.ok(!slack.calls.some((c) => c.method === 'conversations.open' || c.users), 'no DM is opened');
});

test('a later tick (a fresh pinger, a new isolate) replies under the kept parent', async () => {
  const slack = fakeSlack();
  const store = memStore({ [THREAD_KEY]: JSON.stringify({ channel: LOG, ts: '1793800000.000100' }) });
  assert.equal(await pinger(slack, store)('tx-sos', 'falling total', 'Texas Secretary of State: a total fell.'), true);
  assert.equal(slack.calls.length, 1);
  assert.equal(slack.calls[0].thread_ts, '1793800000.000100');
  assert.equal(JSON.parse(store.m.get(THREAD_KEY)).ts, '1793800000.000100');
});

test('alerts raised at once in one tick share one parent', async () => {
  const slack = fakeSlack();
  const store = memStore();
  const ping = pinger(slack, store);
  const sent = await Promise.all(['la', 'sd', 'oc'].map((id) => ping(id, 'refused', `${id} refused our request.`)));
  assert.deepEqual(sent, [true, true, true]);
  const parents = slack.calls.filter((c) => !c.thread_ts);
  assert.equal(parents.length, 1);
  assert.equal(parents[0].text, PARENT_TEXT);
  assert.deepEqual(slack.calls.filter((c) => c.thread_ts).map((c) => c.thread_ts), Array(3).fill('1793900000.000001'));
});

test('a parent that cannot be made: the alert goes to #gabby-log as a plain post, and the next tick tries again', async () => {
  const store = memStore();
  const slack = fakeSlack((b) => (b.text === PARENT_TEXT ? { ok: false, error: 'internal_error' } : null));
  assert.equal(await pinger(slack, store)('denver', 'refused', 'Denver refused our request.'), true);
  assert.equal(slack.calls.length, 2);
  assert.equal(slack.calls[1].channel, LOG);
  assert.equal(slack.calls[1].thread_ts, undefined);
  assert.equal(slack.calls[1].text, 'Results fetcher: Denver refused our request.');
  assert.equal(store.m.has(THREAD_KEY), false);

  const later = fakeSlack();
  await pinger(later, store)('orange', 'refused', 'Orange County refused our request.');
  assert.deepEqual(later.calls.map((c) => c.thread_ts), [undefined, '1793900000.000001']);
  assert.equal(later.calls[0].text, PARENT_TEXT);
});

test('a reply refused because the thread is gone: a plain post now, and the next alert starts a new parent', async () => {
  const store = memStore({ [THREAD_KEY]: JSON.stringify({ channel: LOG, ts: '1793800000.000100' }) });
  const slack = fakeSlack((b) => (b.thread_ts === '1793800000.000100' ? { ok: false, error: 'thread_not_found' } : null));
  const ping = pinger(slack, store);
  assert.equal(await ping('philly', 'falling total', 'Philadelphia: a total fell.'), true);
  assert.deepEqual(slack.calls.map((c) => c.thread_ts), ['1793800000.000100', undefined]);
  assert.equal(store.m.has(THREAD_KEY), false);

  assert.equal(await ping('la', 'refused', 'Los Angeles County refused our request.'), true);
  const [parent, reply] = slack.calls.slice(2);
  assert.equal(parent.text, PARENT_TEXT);
  assert.equal(reply.thread_ts, '1793900000.000003');
  assert.equal(JSON.parse(store.m.get(THREAD_KEY)).ts, '1793900000.000003');
});

test('a thread gone under alerts in flight: the slower one keeps the parent another alert has just made', async () => {
  const OLD = '1793800000.000100';
  const store = memStore({ [THREAD_KEY]: JSON.stringify({ channel: LOG, ts: OLD }) });
  let release;
  const gate = new Promise((ok) => { release = ok; });
  const calls = [];
  let n = 0;
  const fetch = async (url, opts) => {
    const b = JSON.parse(opts.body);
    calls.push(b);
    if (b.thread_ts === OLD) {
      if (b.text.includes('slow')) await gate;
      return { status: 200, json: async () => ({ ok: false, error: 'thread_not_found' }) };
    }
    return { status: 200, json: async () => ({ ok: true, channel: b.channel, ts: `1793900000.00000${++n}` }) };
  };
  const ping = pinger(fetch, store);
  const fast = ping('a', 'refused', 'fast one');
  const slow = ping('b', 'refused', 'slow one');
  assert.equal(await fast, true);
  assert.equal(await ping('c', 'refused', 'third one'), true); // makes the new parent
  const made = JSON.parse(store.m.get(THREAD_KEY)).ts;
  release();
  assert.equal(await slow, true);
  assert.equal(await ping('d', 'refused', 'fourth one'), true);
  assert.equal(calls.filter((c) => c.text === PARENT_TEXT).length, 1, 'one new parent, not two');
  assert.equal(JSON.parse(store.m.get(THREAD_KEY)).ts, made, 'the slow failure left the new parent in KV');
  assert.equal(calls.find((c) => c.text === 'Results fetcher: fourth one').thread_ts, made);
});

test('a KV read of the parent that fails: a plain post, and no second parent', async () => {
  const store = memStore({ [THREAD_KEY]: JSON.stringify({ channel: LOG, ts: '1793800000.000100' }) });
  const get = store.get;
  store.get = async (k) => { if (k === THREAD_KEY) throw new Error('KV 429'); return get(k); };
  const slack = fakeSlack();
  assert.equal(await pinger(slack, store)('la', 'refused', 'Los Angeles County refused our request.'), true);
  assert.deepEqual(slack.calls.map((c) => [c.text, c.thread_ts]), [['Results fetcher: Los Angeles County refused our request.', undefined]]);
  assert.equal(JSON.parse(store.m.get(THREAD_KEY)).ts, '1793800000.000100');
});

test('a reply refused by a rate limit: a plain post, and the parent is kept', async () => {
  const kept = JSON.stringify({ channel: LOG, ts: '1793800000.000100' });
  const store = memStore({ [THREAD_KEY]: kept });
  const slack = fakeSlack((b) => (b.thread_ts ? { ok: false, error: 'ratelimited' } : null));
  assert.equal(await pinger(slack, store)('md', 'refused', 'Maryland refused our request.'), true);
  assert.deepEqual(slack.calls.map((c) => c.thread_ts), ['1793800000.000100', undefined]);
  assert.equal(store.m.get(THREAD_KEY), kept);
});

test('a parent kept for another channel is not used: a new one is made in the channel set now', async () => {
  const store = memStore({ [THREAD_KEY]: JSON.stringify({ channel: 'D0KEVINSDM', ts: '1793800000.000100' }) });
  const slack = fakeSlack();
  await pinger(slack, store)('or', 'failing', 'Oregon has failed since noon.');
  assert.deepEqual(slack.calls.map((c) => [c.channel, c.thread_ts]), [[LOG, undefined], [LOG, '1793900000.000001']]);
  assert.equal(JSON.parse(store.m.get(THREAD_KEY)).channel, LOG);
});

test('the same alert twice in six hours posts once', async () => {
  const slack = fakeSlack();
  const store = memStore();
  const ping = pinger(slack, store);
  assert.equal(await ping('la', 'refused', 'Los Angeles County refused our request.'), true);
  assert.equal(await pinger(slack, store)('la', 'refused', 'Los Angeles County refused our request.'), false);
  assert.equal(slack.calls.length, 2);
});

test('without the token or the channel it only logs', async () => {
  for (const missing of [{ token: undefined }, { channel: undefined }]) {
    const slack = fakeSlack();
    const lines = [];
    const sent = await pinger(slack, memStore(), { ...missing, log: (l) => lines.push(l) })('all', 'done', 'every source has stopped.');
    assert.equal(sent, false);
    assert.equal(slack.calls.length, 0);
    assert.deepEqual(lines, ['ping alert:all:done: Results fetcher: every source has stopped.']);
  }
});

test('Slack unreachable: the ping says false and never throws', async () => {
  const fetch = async () => { throw new Error('network down'); };
  const lines = [];
  assert.equal(await pinger(fetch, memStore(), { log: (l) => lines.push(l) })('all', 'done', 'every source has stopped.'), false);
  assert.ok(lines.includes('slack parent: network down'));
  assert.ok(lines.includes('slack post: network down'));
});
