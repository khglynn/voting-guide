/* Philadelphia's City Commissioners results app (philadelphiaresults.azurewebsites.us, on Azure Government; vote.phila.gov
   embeds it in a frame). Server-rendered ASP.NET pages with no JSON feed and no contest ids in a data file, one page per
   tab: `ResultsSW.aspx?type={tab}&map=CTY` with tab STW (statewide), CON (Congress), STS (State Senate), STR (State
   House), QUE (ballot questions). Each race is a block:
     <div class="display-results-box-a"><h1>REPRESENTATIVE IN CONGRESS 2ND DISTRICT<BR/>(VOTE FOR 1)</h1></div>
     ... id="chk-401362" ... <div class="precinct-fully">Divisions Reported: 998 / 1703</div>
     ... <div class="col display-results-box-d"><h1>JOSH SHAPIRO & AUSTIN DAVIS DEM</h1> ... box-f"><h1>253,121</h1>
   The contest id is the page's own (`chk-{id}`, the same id its share links use); the progress words are the race's
   own "Divisions Reported: N / 1703". Every tab prints the same "Results Last Updated 11/3/2026 9:45:58 PM", which
   is Eastern (seen at 8:44 PM CT on Nov 3), so the first tab's stamp is the change token: an unchanged poll is one
   request. A tab that pages (State House, Nov 3: "Next Page" to a page 2 reached only by a form post) is read at its
   first page only; races past it are simply not in this feed, and the state's own feed counts them.
   The "*** Testing in Progress ***" banner is in the page as a hidden div (display:none) on Nov 3 over real counts.
   Served visible on any tab, it means test counts: the read is an error, so the last good numbers stay up and nothing
   from a test page is ever published (pre-deploy review, Nov 3; it used to ride only as a label). Nothing here is an
   outcome. */
import { get } from '../fetch.js';
import { parseUsTime, isoDate } from '../util.js';

const text = (h) => String(h || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&#241;/g, 'ñ').replace(/\s+/g, ' ').trim();

export function parse(html) {
  const updated = (html.match(/turnout-last-updated-time">\s*([^<]+?)\s*</) || [])[1] || null;
  const head = html.match(/id="lnkElectionInfo"[^>]*>\s*<h1>([\s\S]*?)<\/h1>\s*<h2>([\s\S]*?)<\/h2>/);
  const status = head ? text((head[1].match(/<span>([\s\S]*?)<\/span>/) || [])[1]) : '';
  const name = head ? text(head[1].replace(/<span>[\s\S]*?<\/span>/, '')) : '';
  const date = head ? isoDate(text(head[2])) : null;
  const banner = html.match(/<div id="pnlTestBanner"([^>]*)>([\s\S]*?)<\/div>/);
  const bannerShown = banner && !/display\s*:\s*none/i.test(banner[1]) ? text(banner[2]) : null;
  const divisions = (html.match(/Divisions Reported<span>\s*([\d,]+)\s*<\/span>[\s\S]*?Total Divisions<span>\s*([\d,]+)\s*</) || []);
  const contests = [];
  const blocks = html.split('<div class="wrapper-inside wrapper-border">').slice(1);
  for (const b of blocks) {
    const title = b.match(/display-results-box-a">\s*<h1>([\s\S]*?)<\/h1>/);
    const id = (b.match(/id="chk-(\d+)"/) || [])[1];
    if (!title || !id) continue;
    const [nameLine, ...rest] = title[1].split(/<br\s*\/?>/i);
    const voteFor = Number((text(rest.join(' ')).match(/VOTE FOR (\d+)/i) || [])[1] || 1);
    const prog = (b.match(/class="precinct-fully">\s*([^<]+?)\s*</) || [])[1] || null;
    const rows = [...b.matchAll(/display-results-box-d">\s*<h1>([\s\S]*?)<\/h1>[\s\S]*?display-results-box-f">\s*<h1>([\s\S]*?)<\/h1>/g)];
    const choices = rows.map((r) => ({ name: text(r[1]), votes: Number(text(r[2]).replace(/,/g, '')) }));
    const total = (b.match(/display-results-box-total">\s*<h2>\s*([\d,]+)\s*<\/h2>/) || [])[1];
    contests.push({ feed_id: id, feed_name: text(nameLine), category: null, vote_for: voteFor, choices, total: choices.reduce((a, c) => a + (Number.isFinite(c.votes) ? c.votes : 0), 0), source_total: total ? Number(total.replace(/,/g, '')) : null, reporting: prog, updated: null, declared: null });
  }
  return { updated, status, name, date, banner: bannerShown, divisions: divisions.length ? `${divisions[1]} of ${divisions[2]} divisions reported` : null, contests };
}

export async function read({ fetch, map, prevToken = null }) {
  const identity = map.feed.identity || 'named';
  const tabs = map.feed.tabs || ['QUE', 'CON', 'STS', 'STR'];
  const url = (t) => `${map.feed.base}/ResultsSW.aspx?type=${encodeURIComponent(t)}&map=CTY`;
  const first = await get(fetch, url(tabs[0]), { identity, expect: 'html' });
  if (first.verdict !== 'ok') return { verdict: first.verdict, error: first.error, status: first.status, url: first.url };
  const p0 = parse(first.body || '');
  if (!p0.updated) return { verdict: 'error', error: 'no "Results Last Updated" stamp on the page (not the results page?)', url: first.url };
  // Before the unchanged check, so a saved token can never hide it.
  if (p0.banner) return { verdict: 'error', error: `the ${tabs[0]} tab shows its "${p0.banner}" banner (test counts)`, url: first.url };
  if (prevToken && p0.updated === prevToken) return { verdict: 'ok', unchanged: true, changed_token: p0.updated };
  const pages = [{ tab: tabs[0], body: first.body, p: p0 }];
  for (const t of tabs.slice(1)) {
    const r = await get(fetch, url(t), { identity, expect: 'html' });
    if (r.verdict !== 'ok') return { verdict: r.verdict, error: r.error, status: r.status, url: r.url };
    const p = parse(r.body || '');
    if (p.banner) return { verdict: 'error', error: `the ${t} tab shows its "${p.banner}" banner (test counts)`, url: r.url };
    // The tabs are separate requests; a tab read across an update would mix two counts, so try again next poll.
    if (p.updated !== p0.updated) return { verdict: 'error', error: `the ${t} tab says ${p.updated}, the ${tabs[0]} tab ${p0.updated} (read across an update)`, url: r.url };
    pages.push({ tab: t, body: r.body, p });
  }
  const contests = pages.flatMap((x) => x.p.contests);
  if (!contests.length) return { verdict: 'error', error: 'no races on any tab', url: first.url };
  const raw = {};
  for (const x of pages) raw[`${x.tab}.html`] = x.body;
  return {
    verdict: 'ok',
    changed_token: p0.updated,
    raw,
    election: { id: p0.name, name: p0.name, date: p0.date },
    source_status: null,
    official: false,
    source_updated: parseUsTime(p0.updated, -5),
    reporting: p0.divisions,
    labels: [p0.status ? `${p0.status} ${p0.name}`.trim() : null].filter(Boolean),
    contests,
  };
}
