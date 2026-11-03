/* A Slack DM to Kevin from Gabby's bot, the way the source watcher sends one (workbench scripts-local/vg-source.mjs).
   Stuck only (refused, failing 30 minutes, an election mismatch, a falling total, a stale read-back, a map out of
   date), deduped on `alert:{source}:{reason}` for 6 hours; one done line when every source has stopped. Without the
   secrets it only logs. */
export function makePinger({ fetch, store, token, user, log = console.log }) {
  return async function ping(source, reason, text) {
    const key = `alert:${source}:${reason}`;
    if (await store.get(key)) return false;
    await store.put(key, new Date().toISOString(), { expirationTtl: 6 * 3600 });
    const line = `Results fetcher: ${text}`;
    log(`ping ${key}: ${line}`);
    if (!token || !user) return false;
    try {
      const open = await fetch('https://slack.com/api/conversations.open', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ users: user }) }).then((r) => r.json());
      if (!open.ok) { log(`slack open: ${open.error}`); return false; }
      const sent = await fetch('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ channel: open.channel.id, text: line, unfurl_links: false, unfurl_media: false }) }).then((r) => r.json());
      if (!sent.ok) log(`slack post: ${sent.error}`);
      return !!sent.ok;
    } catch (e) { log(`slack: ${e.message}`); return false; }
  };
}
