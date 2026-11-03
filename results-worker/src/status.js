/* GET /results/status: one line per source for Kevin's phone. Plain HTML, no script, times in Central. */
import { loadSched } from './tick.js';
import { mapHash } from './fingerprint.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const ct = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

export async function statusPage({ store, maps, now = new Date().toISOString() }) {
  const sched = await loadSched(store);
  const stop = await store.get('stop');
  const rows = [];
  for (const m of maps) {
    const s = sched.sources[m.id] || {};
    const rec = await store.get(`src:${m.id}`).then((v) => (v ? JSON.parse(v) : null));
    const checked = (await store.get(`checked:${m.id}`)) === (await mapHash(m));
    const fp = sched.meta?.fp?.[m.id];
    const blockedRec = await store.get(`blocked:${m.id}`).then((v) => (v ? JSON.parse(v) : null));
    const read = rec?.read || blockedRec?.read;
    const contests = read?.contests?.length ?? 0;
    const votes = read ? read.contests.reduce((a, c) => a + c.choices.reduce((x, ch) => x + (Number(ch.votes) || 0), 0), 0) : 0;
    const state = s.stopped ? `stopped: ${s.stopped}` : s.failing_since ? `failing since ${ct(s.failing_since)}` : (s.status || 'not read yet');
    const problems = [...(rec?.problems || []), ...(rec?.blocked ? blockedRec?.problems || [] : [])].map((p) => p.detail || p.reason);
    rows.push(`<li><b>${esc(m.name)}</b> <span class="id">${esc(m.id)} · ${esc(m.feed.adapter)}${m.feed.identity === 'browser' ? ' · browser identity' : ''}</span><br>
      ${esc(state)}${rec?.blocked ? ' · <b>election mismatch: links only</b>' : ''} · ${checked ? '<b>checked</b>' : 'not checked yet (preview only)'}${fp === 'mismatch' ? ' · <b>map out of date</b>' : ''}<br>
      read ${esc(ct(s.last_ok) || 'never')} · source updated ${esc(ct(read?.source_updated) || 'n/a')} · next ${esc(s.next_due ? ct(s.next_due) : s.stopped ? 'none' : 'now')}<br>
      ${esc(read?.election?.name || '')} ${read ? `· ${contests} contests · ${votes.toLocaleString('en-US')} votes` : ''} ${read?.reporting ? `· ${esc(read.reporting)}` : ''}<br>
      mapped ${m.contests?.length ?? 0} · not matched ${m.unmatched_guide?.length ?? 0}${s.unchanged_polls ? ` · unchanged ${s.unchanged_polls}x` : ''}${s.last_error ? ` · last error: ${esc(s.last_error)}` : ''}${problems.length ? ` · ${esc([...new Set(problems)].join(', '))}` : ''}</li>`);
  }
  const states = [...new Set(maps.map((m) => m.state))];
  const files = [];
  for (const st of states) {
    const pub = await store.get(`file:${st}`).then((v) => (v ? JSON.parse(v) : null));
    const pv = await store.get(`preview:${st}`).then((v) => (v ? JSON.parse(v) : null));
    files.push(`<li>${st}: public ${pub ? esc(ct(pub.generated)) : 'test file only'} · preview ${pv ? esc(ct(pv.generated)) : 'none yet'}</li>`);
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Results fetcher</title><style>
:root{--bg:#f7f4ec;--ink:#1d1d1b;--mute:#6b675e;--rule:#d9d3c4}
@media (prefers-color-scheme:dark){:root{--bg:#1b1a17;--ink:#ece8de;--mute:#a19c90;--rule:#3a3832}}
body{background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,sans-serif;margin:0;padding:16px;max-width:720px}
h1{font-size:18px;margin:0 0 4px} p{margin:4px 0 12px;color:var(--mute)} ul{list-style:none;padding:0;margin:0}
li{border-top:1px solid var(--rule);padding:10px 0} .id{color:var(--mute);font-size:13px}
</style></head><body><h1>Results fetcher, Nov 3, 2026</h1>
<p>As of ${esc(ct(now))} CT. ${stop ? '<b>Stopped by the stop flag.</b>' : 'Running every minute.'} Last tick ${esc(ct(sched.meta?.last_tick) || 'none yet')}.</p>
<ul>${rows.join('\n')}</ul><h1 style="margin-top:16px">Files</h1><ul>${files.join('')}</ul></body></html>`;
}
