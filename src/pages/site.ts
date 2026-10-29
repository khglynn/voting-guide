/* The guide's static pages, for search engines and AI assistants (Oct 28; Kevin: "I'd love to ensure that bots
   and search engines can find this site easily ... so we can help as many people as possible").

   The app is one page that builds a ballot from a ZIP, so a crawler sees one page with no city in it. These pages
   are plain HTML, one per place (/austin-tx) and one per state (/texas), written at build time from the same
   bundles the app reads (public/data/), through the app's own model: buildBallot decides what is on a ballot,
   localHowto whose dates and lookups win, labels.ts what each row is called. So a change to the data, or to
   those rules, flows into these pages with no edit here.

   What a page says, and what it never says:
   - Only facts the data has: the races and measures on that ballot (candidates by name and party, as the data
     lists them, in its order), the key dates, where to vote, the election office, ID rules. Every one of those
     carries its source in data/; the page names the official sites and links the app, where each fact shows
     its source.
   - Never a pick, an endorsement, a lean or a recommendation, and nothing that characterizes a candidate or a
     group: a count of sources with picks is the most it says about endorsements.
   - Never anything personal: no ZIP lists, no zip_caveats (it holds research notes), no address but an election
     office's.
   Copy rules (plain words, second person, no all caps, no em dashes) are checked in tests/pages.mjs; the copy
   went through the workbench's GPT pass (claude-plans/2026-10-21-third-pass/discovery-log.md).

   scripts/build-pages.mjs loads this module through Vite's SSR loader, as tests/model.mjs loads the model. */
import type { Contest, Dated, HowTo, Index, Lookups, PlaceBundle, StateBundle } from '../types';
import { buildBallot, sectionOf, SECTIONS, type Ballot, type SectionKey } from '../ballot';
import { S } from '../state';
import { cleanOffice, rowTitle } from '../model/labels';
import { applyDated, clock, closeOf, isMailState, localHowto, PLAIN_TIME, zonesFor } from '../model/plan';
import { esc, fmtDate } from '../util';
import { escP, telHTML } from '../views/common';

export const ORIGIN = 'https://vote.kevinhg.com';
export const SITE_NAME = 'Your ballot, explained';
const ELECTION = 'Nov 3, 2026';

export interface SiteData {
  index: Index;
  states: Record<string, StateBundle>;
  places: Record<string, PlaceBundle>;
}
/* The built files a page links: the app's own stylesheet (cached for the step into the app) and the small
   script that counts a visit (src/pages/visit.ts). Placeholders when fingerprinting (see pageFingerprint). */
export interface Assets { css: string; js: string | null }
export interface Page {
  path: string;      // "/austin-tx"
  file: string;      // "austin-tx.html", under dist/
  title: string;
  description: string;
  lastmod: string;   // YYYY-MM-DD: the newest date the page's own facts carry
  html: string;
  kind: 'home' | 'state' | 'place';
  name: string;      // "Austin, TX", "Texas"
  summary: string;   // llms.txt's line: "68 races, 11 measures, key dates and where to vote"
}

/* ---------- names and paths ---------- */
export const slug = (s: string): string => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const statePath = (d: SiteData, st: string): string => `/${slug(d.index.states[st].name)}`;
export const placePath = (id: string): string => `/${id}`;
/* "Austin", "Los Angeles", "Brooklyn", "Ballwin area": the label without its parenthetical. */
export const shortLabel = (label: string): string => label.replace(/\s*\(.*\)\s*$/, '').trim();
/* "Austin, TX"; a label that already names its state ("DC Ward 1") keeps it as it is. */
export function placeName(p: { label: string; state: string }): string {
  const s = shortLabel(p.label);
  return p.state === 'DC' ? s : `${s}, ${p.state}`;
}
const countyName = (c: string): string => c.replace(/\s*\([^)]*\)/g, '').replace(/\s+County$/i, '').trim();
const listWords = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
/* "Travis, Williamson and Hays counties"; "St. Louis County"; null for DC, which has no counties. */
function countiesLine(p: PlaceBundle): string | null {
  if (p.state === 'DC') return null;
  const names = [...new Set(p.counties.map(countyName).filter(Boolean))];
  if (!names.length) return null;
  if (names.length === 1) return /county|city$/i.test(p.counties[0]) ? p.counties[0].replace(/\s*\([^)]*\)/g, '').trim() : `${names[0]} County`;
  return `${listWords(names)} counties`;
}
const year = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};
const newest = (dates: (string | null | undefined)[], cap: string): string => {
  const ok = dates.filter((d): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= cap).sort();
  return ok.length ? ok[ok.length - 1] : cap;
};

/* ---------- the ballot, as a list ---------- */
const IDS: Record<string, string> = { // the same words as My plan's (views/planstrip.ts)
  photo: 'Photo ID required in person', non_photo_ok: 'ID required in person; non-photo ID is OK',
  first_time_only: 'ID needed only for some first-time voters', none: 'No ID needed for most voters',
};
const candLine = (c: Contest): string => {
  if (!c.candidates.length) return '';
  const names = c.candidates.map((k) => `${esc(k.name)}${k.party ? ` <span class="pg-pty">(${esc(k.party)})</span>` : ''}`);
  if (c.is_retention) return `<p class="pg-c">${c.candidates.length > 1 ? `Vote to keep or remove: ${names.join(', ')}` : 'You vote on whether this judge stays in office.'}</p>`;
  return `<p class="pg-c">${c.candidates.length === 1 ? 'Unopposed: ' : ''}${names.join(', ')}</p>`;
};
/* A district race's own line inside its group: its district (or court) and its candidates. */
function memberHTML(c: Contest): string {
  const { title, sub } = rowTitle(c);
  // A judges' list is named by its court (rowTitle's title); one judge by name, so the court is its sub.
  const label = c.is_retention ? (c.candidates.length > 1 ? title : sub || title) : sub || c.district || title;
  const names = c.candidates.map((k) => `${esc(k.name)}${k.party ? ` <span class="pg-pty">(${esc(k.party)})</span>` : ''}`);
  const line = !names.length ? '' : c.is_retention ? `Vote to keep or remove: ${names.join(', ')}` : `${c.candidates.length === 1 ? 'Unopposed: ' : ''}${names.join(', ')}`;
  return `<li><b>${escP(label)}</b>${line ? ` <span class="pg-c">${line}</span>` : ''}</li>`;
}
/* Past this many districts a statewide page says how many instead of listing them (Texas has 150 House seats). */
const LIST_UP_TO = 12;
interface Row { html: string; text: string }
function ballotRows(b: Ballot, where: string): Map<SectionKey, Row[]> {
  S.ballot = b; // labels.ts reads the ballot open now (seat labels name its places)
  const out = new Map<SectionKey, Row[]>();
  const seen = new Set<string>();
  const add = (sec: SectionKey, html: string, text: string) => out.set(sec, [...(out.get(sec) || []), { html, text }]);
  const maybe = `<span class="pg-may">Only in parts of ${esc(where)}</span>`;
  for (const it of b.items) {
    const sec = sectionOf(it);
    const g = b.groupOf[it.id];
    if (g) {
      if (seen.has(g)) continue;
      seen.add(g);
      const grp = b.groups.find((x) => x.key === g)!;
      const c = it as Contest; // a district group only ever holds races (ballot.ts)
      const t = cleanOffice(c.office);
      const list = b.places.length > 0 || grp.members.length <= LIST_UP_TO;
      add(sec, `<li><b>${escP(t)}</b> <span class="pg-sub">${list ? 'Your address determines your district.' : `${grp.members.length} districts. Your address determines yours.`}</span>${list ? `<ul class="pg-dist">${grp.members.map((m) => memberHTML(b.byId.get(m) as Contest)).join('')}</ul>` : ''}</li>`, t);
      continue;
    }
    const { title, sub } = rowTitle(it);
    const may = b.mayApply.has(it.id) ? ` ${maybe}` : '';
    if (it.kind === 'measure') {
      add(sec, `<li><b>${escP(title)}</b>${sub && sub !== title ? `<span class="pg-sub">: ${escP(sub)}</span>` : ''}${may}</li>`, `${title}${sub ? `: ${sub}` : ''}`);
    } else {
      add(sec, `<li><b>${escP(title)}</b>${sub ? ` <span class="pg-sub">${escP(sub)}</span>` : ''}${it.ranked_choice ? ' <span class="pg-sub">(ranked choice)</span>' : ''}${may}${candLine(it)}</li>`, `${title}${sub ? ` ${sub}` : ''}`);
    }
  }
  return out;
}
const countItems = (b: Ballot): { races: number; measures: number } => {
  const groups = new Set(Object.values(b.groupOf));
  const singles = b.items.filter((i) => !b.groupOf[i.id]);
  return { races: singles.filter((i) => i.kind === 'contest').length + groups.size, measures: singles.filter((i) => i.kind === 'measure').length };
};
const plural = (n: number, w: string): string => `${n} ${n === 1 ? w : `${w}s`}`;
function ballotHTML(b: Ballot, where: string): string {
  const rows = ballotRows(b, where);
  return SECTIONS.filter(([k]) => rows.get(k)?.length).map(([k, label]) => `<h3 class="pg-h3">${esc(label)}</h3><ul class="pg-list">${rows.get(k)!.map((r) => r.html).join('')}</ul>`).join('');
}

/* ---------- dates, places to vote, the office ---------- */
interface DateRow { date: string; lead: string; when: string; detail: string | null; list?: string[] }

/* Text the data dates to change (`dated`, plan.applyDated) never goes on a static page, whatever the build date
   (Codex, Oct 28): it can say "today" or "tomorrow", and a page keeps what it says until the next deploy. So before
   anything renders, every field any `dated` entry names, before or after its date, is emptied here, read through
   applyDated itself so the two can't disagree on a path; the app shows those fields as they read on the day. Every
   renderer below takes an emptied field as absent. A place whose name or counties are dated has no page at all
   (build-pages skips it and says so; tests/pages.mjs fails on a skip). */
const GONE = '\u0000dated';
export function undated<T extends { dated?: Dated[] }>(o: T): T {
  if (!o.dated || !o.dated.length) return o;
  const marked = applyDated(o, o.dated.map((x) => ({ ...x, from: '0000-01-01', text: GONE })), '9999-12-31');
  const clean = (v: unknown): unknown => (v === GONE ? null : Array.isArray(v) ? v.map(clean) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)])) : v);
  return { ...(clean(marked) as T), dated: [] };
}
/* Names the model keys on: a place's name, state and counties, and each county's name in its per-county links. */
const namedField = /^(id|label|state|counties)(\.|$)|^by_county\.\d+\.county$/;

/* The key dates, each with its own rule in the data's words underneath: a headline date alone can drop what the
   rule qualifies (Maryland's request deadline differs by how the ballot reaches you; Codex, Oct 28). */
function dateRows(h: HowTo, place: PlaceBundle | null): DateRow[] {
  const out: DateRow[] = [];
  const mail = isMailState(h);
  const reg: Record<string, string> = { online: 'Last day to register online', mail: 'Last day to register by mail', in_person: 'Last day to register in person' };
  h.registration.deadlines.forEach((d) => { if (d && d.date) out.push({ date: d.date, lead: `${reg[d.method] || 'Registration deadline'}: `, when: fmtDate(d.date), detail: d.rule || null }); });
  const rq = h.mail_ballot.request_deadline;
  // Where every voter gets a ballot in the mail, the "request" date is a replacement's, often one county's: its
  // rule says so, so it leads without a date of its own.
  if (rq && rq.date && rq.rule && mail) out.push({ date: rq.date, lead: 'Mail ballot request and replacement dates', when: '', detail: rq.rule });
  else if (rq && rq.date && !mail) out.push({ date: rq.date, lead: 'Last day to ask for a mail ballot: ', when: fmtDate(rq.date), detail: rq.rule || null });
  const ep = h.early_in_person;
  // The window with its note: Florida's is a state minimum, Colorado's counties may open sooner, Oregon has no early
  // voting as such. A place's own one-line hours stand in when it has them; where there's no window, the note alone.
  if (ep.available && ep.start && ep.end) {
    out.push({ date: ep.start, lead: `${mail ? 'In-person voting' : 'Early voting'}: `, when: `${fmtDate(ep.start)} to ${fmtDate(ep.end)}`, detail: place?.early_in_person?.hours_short || ep.hours_note || null });
  } else if (ep.hours_note) out.push({ date: ep.end || ep.start || h.election_date || '9999-12-31', lead: 'Can you vote before Election Day?', when: '', detail: ep.hours_note });
  const r = h.mail_ballot.return_deadline;
  // The ways to return it, in the data's words: each has its own rule (Texas takes a USPS ballot postmarked by 7 PM
  // that arrives the next day; Georgia doesn't count postmarks; Codex round 2), so the heading names none of them.
  if (r && r.date) out.push({ date: r.date, lead: 'Mail ballot deadline: ', when: fmtDate(r.date), detail: r.time || null, list: (h.mail_ballot.return_options || []).filter(Boolean) });
  const ed = h.election_day;
  const { close } = closeOf(ed.polls_close, zonesFor(h.state, place ? [place] : []));
  const hours = !close ? '' : !mail && PLAIN_TIME.test(ed.polls_open || '') && PLAIN_TIME.test(ed.polls_close || '') ? `You can vote from ${clock(ed.polls_open)} to ${close}.` : `Polls close at ${close}.`;
  if (h.election_date) out.push({ date: h.election_date, lead: 'Election Day: ', when: fmtDate(h.election_date), detail: [hours, ed.in_line_rule].filter(Boolean).join(' ') || null });
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
const datesHTML = (rows: DateRow[]): string => `<ul class="pg-dates">${rows.map((r) => `<li>${r.when ? `${esc(r.lead)}<b>${esc(r.when).replace(/ to /, ' to&nbsp;')}</b>` : `<b>${esc(r.lead)}</b>`}${r.detail ? `<span>${escP(r.detail)}</span>` : ''}${r.list && r.list.length ? `<ul class="pg-bul pg-ways">${r.list.map((x) => `<li>${escP(x)}</li>`).join('')}</ul>` : ''}</li>`).join('')}</ul>`;
const ext = (url: string, text: string): string => `<a href="${esc(url)}" rel="noopener">${esc(text)}</a>`;
const LOOK_LABEL: [keyof Lookups, string][] = [['early_in_person', 'Early voting locations'], ['election_day', 'Election Day locations'], ['drop_box', 'Ballot drop boxes'], ['tracking', 'Track your mail ballot']];
function whereHTML(h: HowTo, p: PlaceBundle | null): string {
  const links: string[] = [];
  const mail = isMailState(h);
  const early = h.early_in_person.available ? h.early_in_person.lookup_url : null;
  const day = h.election_day.lookup_url;
  // A place across county lines (Austin: Travis, Williamson, Hays): each county's own tools, labeled, as My plan
  // shows them before it knows your county; the state's statewide lookup stands in for none of them.
  const counties = h.county_links && h.county_links.length > 1 ? h.county_links.filter((c) => c && c.county) : [];
  const byCounty = counties.length ? `<p class="pg-cty"><b>Find your county’s voting places:</b></p><ul class="pg-ctys">${counties.map((c) => `<li><b>${esc(`${c.county} County`)}</b> ${LOOK_LABEL.filter(([k]) => c.lookups[k]).map(([k, l]) => ext(c.lookups[k]!, l)).join(' · ')}</li>`).join('')}</ul>` : '';
  // The state's lookup stays for any kind not every county has (Atlanta's counties list no Election Day page).
  const own = (k: keyof Lookups): boolean => counties.length > 0 && counties.every((c) => !!c.lookups[k]);
  const e = own('early_in_person') ? null : early, dd = own('election_day') ? null : day;
  if (e && e === dd) links.push(ext(e, 'Find where to vote'));
  else {
    if (e) links.push(ext(e, mail ? 'Find a vote center' : 'Find early voting locations'));
    if (dd) links.push(ext(dd, 'Find your Election Day polling place'));
  }
  if (h.mail_ballot.drop_box_lookup_url) links.push(ext(h.mail_ballot.drop_box_lookup_url, 'Find a ballot drop box'));
  if (h.mail_ballot.tracking_url) links.push(ext(h.mail_ballot.tracking_url, 'Track your mail ballot'));
  if (h.registration.check_url) links.push(ext(h.registration.check_url, 'Check your registration'));
  const sample = (p && p.sample_ballot_url) || h.sample_ballot_url;
  if (sample) links.push(ext(sample, p && p.sample_ballot_url ? 'See your official sample ballot' : 'See official sample ballots'));
  const office = p ? p.county_election_office : null;
  let officeHTML = '';
  if (office && office.name) {
    // "Travis County Clerk, Elections Division (VoteTravis), 5501 Airport Blvd., Austin 78751": the name, then its
    // address. Then its main phone (labeled when there are direct lines too), each direct line, its hours: My plan's card.
    const m = office.name.match(/^(.*?)[,:]\s*(\d[\s\S]*)$/);
    const [n, a] = m ? [m[1], m[2]] : [office.name, ''];
    const phone = office.phone ? `<br>${office.phone_label ? `${esc(office.phone_label)}: ` : ''}${telHTML(office.phone)}` : '';
    const lines = (office.lines || []).filter((l) => l && l.label && l.phone).map((l) => `<br>${esc(l.label)}: ${telHTML(l.phone)}${l.hours ? ` (${esc(l.hours)})` : ''}`).join('');
    officeHTML = `<p class="pg-office"><b>Your election office:</b> ${office.url ? ext(office.url, n) : esc(n)}${phone}${lines}${a ? `<br>${esc(a)}` : ''}${office.hours ? `<br>${esc(office.hours)}` : ''}</p>`;
  }
  // The place's note before the office: an address right before "If you live in ..." reads to the address guard
  // (scripts/check-addresses.mjs) as someone's home, and tests/pages.mjs runs it over every built page.
  const note = p && p.notes ? `<p class="pg-note">${escP(p.notes)}</p>` : '';
  return `${byCounty}<ul class="pg-links">${links.map((l) => `<li>${l}</li>`).join('')}</ul>${note}${officeHTML}`;
}
/* The rule, and always what to do without an ID (Texas's "Photo ID required" has a way to vote without one); a state
   page also lists what counts. */
function idHTML(h: HowTo, full: boolean): string {
  const idr = h.id_rules;
  const head = idr.required ? `<p><b>${esc(IDS[idr.required] || idr.required)}.</b></p>` : '';
  const none = idr.no_id_option ? `<p><b>No ID?</b> ${escP(idr.no_id_option)}</p>` : '';
  const ok = (idr.accepted || []).filter(Boolean);
  return `${head}${full && ok.length ? `<ul class="pg-bul">${ok.map((a) => `<li>${escP(a)}</li>`).join('')}</ul>` : ''}${none}`;
}

/* ---------- the page around it ---------- */
const PAGE_CSS = `
.pg .pg-top{padding-top:14px}
.pg-crumbs{font-size:14px;color:var(--muted)}.pg-crumbs a{color:inherit}
.pg .place{font-size:clamp(38px,12vw,56px);margin-top:10px}
.pg-lede{margin-top:12px;font-size:18px;color:var(--ink-2)}
.pg .pad{margin-top:20px}
.pg .bigbtn{text-decoration:none}
.pg-h2{font-family:var(--f-display);font-size:26px;font-weight:800;line-height:1.05;font-variation-settings:"wdth" 78;color:var(--print);margin-top:30px}
.pad .pg-h2{margin-top:22px}
.pg-h3{font-family:var(--f-display);font-size:19px;font-weight:800;font-variation-settings:"wdth" 84;color:var(--print);margin-top:20px;padding-bottom:4px;border-bottom:1px solid var(--rule-2)}
.pg-list li{padding:9px 0;border-bottom:1px solid var(--rule)}
.pg-sub,.pg-pty{color:var(--ink-2)}
.pg-c{font-size:15px;color:var(--ink-2);margin-top:2px}
.pg-dist{margin-top:4px;padding-left:14px;border-left:2px solid var(--rule)}.pg-dist li{padding:4px 0}.pg-dist .pg-c{display:block}
.pg-may{display:inline-block;font-size:13px;color:var(--muted);border:1px solid var(--rule-2);border-radius:2px;padding:0 5px;margin-left:4px}
.pg-dates{display:grid;gap:10px;margin-top:10px}.pg-dates b{white-space:nowrap}.pg-dates span{display:block;font-size:15px;color:var(--ink-2)}
.pg-links{display:grid;gap:4px;margin-top:10px}.pg-links a{display:inline-flex;min-height:40px;align-items:center}
.pg-office,.pg-note,.pg p{margin-top:10px}
.pg-ctys{display:grid;gap:6px;margin-top:6px}.pg-ctys a{display:inline-flex;min-height:40px;align-items:center}
.pg-bul{list-style:disc;padding-left:20px;margin-top:8px;display:grid;gap:4px}.pg-ways{font-size:15px;color:var(--ink-2);margin-top:4px}
.pg-places{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:10px}.pg-places a{display:inline-flex;min-height:40px;align-items:center}
.pg-foot{margin-top:36px;padding-top:14px;padding-bottom:40px;border-top:1px solid var(--rule-2)}
`.replace(/\n/g, '');
interface Shell {
  path: string; title: string; description: string; h1: string; kicker: string; crumbs: [string, string | null][];
  body: string; lastmod: string; about: Record<string, unknown> | null;
}
function jsonLd(s: Shell): string {
  const url = `${ORIGIN}${s.path}`;
  const graph = [
    { '@type': 'WebSite', '@id': `${ORIGIN}/#site`, url: `${ORIGIN}/`, name: SITE_NAME, inLanguage: 'en-US', publisher: { '@type': 'Person', name: 'Kevin HG', url: 'https://kevinhg.com' } },
    {
      '@type': 'WebPage', '@id': `${url}#page`, url, name: s.title, description: s.description, inLanguage: 'en-US',
      isPartOf: { '@id': `${ORIGIN}/#site` }, dateModified: s.lastmod, breadcrumb: { '@id': `${url}#crumbs` }, ...(s.about ? { about: s.about } : {}),
    },
    {
      '@type': 'BreadcrumbList', '@id': `${url}#crumbs`,
      itemListElement: s.crumbs.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, ...(path ? { item: `${ORIGIN}${path}` } : {}) })),
    },
  ];
  // "<" can't close the script element inside a JSON string once it's escaped.
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c');
}
function shell(s: Shell, a: Assets, footer: string): string {
  const url = `${ORIGIN}${s.path}`;
  const crumbs = s.crumbs.map(([n, p]) => (p ? `<a href="${esc(p)}">${esc(n)}</a>` : `<span aria-current="page">${esc(n)}</span>`)).join(' <span aria-hidden="true">›</span> ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(s.title)}</title>
<meta name="description" content="${esc(s.description)}">
<link rel="canonical" href="${esc(url)}">
<meta name="theme-color" content="#EFE9DA" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#161D1A" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(SITE_NAME)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:title" content="${esc(s.title)}">
<meta property="og:description" content="${esc(s.description)}">
<meta property="og:image" content="${ORIGIN}/og.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..100,600..800&amp;family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&display=swap">
<link rel="stylesheet" href="${esc(a.css)}">
<style>${PAGE_CSS}</style>
<script type="application/ld+json">${jsonLd(s)}</script>
${a.js ? `<script type="module" src="${esc(a.js)}"></script>\n` : ''}</head>
<body class="pg">
<header class="mast wrap pg-top">
<nav class="pg-crumbs" aria-label="Breadcrumb">${crumbs}</nav>
<p class="dateline" style="margin-top:12px">${esc(s.kicker)}</p>
<h1 class="place">${esc(s.h1)}</h1>
</header>
<main class="wrap">
${s.body}
</main>
<footer class="wrap pg-foot fine">${footer}</footer>
</body>
</html>
`;
}
/* `checked`: when the state's dates and rules were last verified (its last_verified), the facts most of a page is. */
function footerHTML(d: SiteData, checked: string | null): string {
  const states = Object.keys(d.index.states).sort((a, b) => d.index.states[a].name.localeCompare(d.index.states[b].name));
  return `${checked ? `<p>Your state's voting dates and rules last checked: ${esc(year(checked))}. Every fact in the guide links to its source.</p>` : '<p>Every fact in the guide links to its source.</p>'}
<p>Nonpartisan: the guide never tells you how to vote. Made by ${ext('https://kevinhg.com', 'Kevin HG')}.</p>
<p>No account needed. No ads or cookies. We count visits without identifying you.</p>
<p><b>All states in the guide:</b></p>
<ul class="pg-places">${states.map((st) => `<li><a href="${esc(statePath(d, st))}">${esc(d.index.states[st].name)}</a></li>`).join('')}</ul>`;
}

/* ---------- a place ---------- */
export function placePage(d: SiteData, id: string, a: Assets, today: string): Page {
  const p0 = d.places[id];
  if ((p0.dated || []).some((x) => namedField.test(x.path))) throw new Error(`${id}: a name the guide keys on (its own, its counties') is dated, so no page can say it`);
  // Dated text out first (undated), then the plan as of the build date, for the whole place (no voter's county).
  const sb0 = d.states[p0.state];
  const sh = undated(sb0.howto);
  const p = undated(p0);
  const sb = { ...sb0, howto: sh };
  const ix = d.index.places[id];
  const b = buildBallot(sb, [p]);
  b.howto = localHowto(sh, [p], null, today);
  const h = b.howto;
  const name = placeName(p);
  const short = shortLabel(p.label);
  const stName = d.index.states[p.state].name;
  const { races, measures } = countItems(b);
  const counties = countiesLine(p);
  const lastmod = newest([sb.howto.last_verified, ix.checked, d.index.states[p.state].checked], today);
  const title = `${name} voting guide: your ${ELECTION} ballot`;
  const summary = `${plural(races, 'race')}, ${plural(measures, 'measure')}, key dates and where to vote`;
  const description = `Your ${short} ballot for ${ELECTION}, in plain English: ${summary}.`;
  const others = d.index.states[p.state].places.filter((x) => x !== id);
  const body = `
<p class="pg-lede">See the races and measures on ${esc(short)} ballots, plus when and where to vote, in plain English.${counties ? ` Covers ${esc(counties)}.` : ''}</p>
<div class="pad">
<span class="sheet-top" aria-hidden="true"></span><span class="sheet-fill" aria-hidden="true"></span><span class="sheet-bot" aria-hidden="true"></span>
<a class="bigbtn" href="/?place=${esc(id)}">Open your ${esc(short)} ballot</a>
<p class="fine">Enter your address in the guide to see your races and make a voting plan you can print. Your picks stay on your device.${ix.with_picks ? ` Compare endorsements from ${ix.with_picks} sources side by side, or hide them.` : ''}</p>
<h2 class="pg-h2" id="dates">Key dates</h2>
${datesHTML(dateRows(h, p))}
<h2 class="pg-h2" id="where">Where to vote</h2>
${whereHTML(h, p)}
<h2 class="pg-h2" id="id">What to bring</h2>
${idHTML(h, false)}<p><a href="${esc(statePath(d, p.state))}#id">What counts as ID in ${esc(stName)}</a></p>
</div>
<h2 class="pg-h2" id="ballot">What's on the ballot in ${esc(short)}</h2>
<p>${plural(races, 'race')} and ${plural(measures, 'measure')} across ${esc(short)}.${b.groups.length || b.mayApply.size ? ' Your address decides which ones are on your ballot. Enter it in the guide to see yours.' : ''}</p>
${ballotHTML(b, short)}
<p style="margin-top:22px"><a class="bigbtn" href="/?place=${esc(id)}">Open your ${esc(short)} ballot</a></p>
${others.length ? `<h2 class="pg-h2">Other places in ${esc(stName)}</h2><ul class="pg-places">${others.map((x) => `<li><a href="${esc(placePath(x))}">${esc(shortLabel(d.index.places[x].label))}</a></li>`).join('')}</ul>` : ''}
<p><a href="${esc(statePath(d, p.state))}">See the statewide ballot for ${esc(stName)}</a></p>`;
  const path = placePath(id);
  const html = shell({
    path, title, description, h1: short, kicker: `${stName}: ${ELECTION} ballot`, lastmod, body,
    crumbs: [[SITE_NAME, '/'], [stName, statePath(d, p.state)], [short, null]],
    about: { '@type': 'Place', name, containedInPlace: { '@type': 'AdministrativeArea', name: stName } },
  }, a, footerHTML(d, sb.howto.last_verified));
  return { path, file: `${id}.html`, title, description, lastmod, html, kind: 'place', name, summary };
}

/* ---------- a state ---------- */
export function statePage(d: SiteData, st: string, a: Assets, today: string): Page {
  const sb0 = d.states[st];
  const sb = { ...sb0, howto: undated(sb0.howto) };
  const s = d.index.states[st];
  const b = buildBallot(sb, []);
  b.howto = localHowto(sb.howto, [], null, today); // as of the build date, dated text already out
  const h = b.howto;
  const { races, measures } = countItems(b);
  const lastmod = newest([sb.howto.last_verified, s.checked], today);
  const title = `${s.name} voting guide: your ${ELECTION} ballot`;
  const description = `Your ${s.name} ballot for ${ELECTION}, in plain English: statewide races and measures, key dates, ID rules, where to vote and local guides.`;
  const body = `
<p class="pg-lede">See the statewide races and measures on ${esc(s.name)} ballots, plus your voting dates and rules.</p>
<div class="pad">
<span class="sheet-top" aria-hidden="true"></span><span class="sheet-fill" aria-hidden="true"></span><span class="sheet-bot" aria-hidden="true"></span>
<a class="bigbtn" href="/?state=${esc(st)}">Open your ${esc(s.name)} ballot</a>
<p class="fine">Enter your ZIP code in the guide to add your local races. Your picks stay on your device.</p>
<h2 class="pg-h2">Local guides in ${esc(s.name)}</h2>
<ul class="pg-places">${s.places.map((id) => `<li><a href="${esc(placePath(id))}">${esc(shortLabel(d.index.places[id].label))}</a></li>`).join('')}</ul>
<h2 class="pg-h2" id="dates">Key dates</h2>
${datesHTML(dateRows(h, null))}
${h.model_plain ? `<h2 class="pg-h2">How voting works in ${esc(s.name)}</h2><p>${escP(h.model_plain)}</p>` : ''}
<h2 class="pg-h2" id="where">Where to vote</h2>
${whereHTML(h, null)}
<h2 class="pg-h2" id="id">What to bring</h2>
${idHTML(h, true)}
</div>
<h2 class="pg-h2" id="ballot">Statewide races and measures</h2>
<p>${plural(races, 'race')} and ${plural(measures, 'measure')} statewide. Your ballot also has races for where you live.</p>
${ballotHTML(b, s.name)}
<p style="margin-top:22px"><a class="bigbtn" href="/?state=${esc(st)}">Open your ${esc(s.name)} ballot</a></p>
${h.official_site && h.official_site.url && h.official_site.name ? `<p>Official voting info: ${ext(h.official_site.url, h.official_site.name)}.</p>` : ''}`;
  const path = statePath(d, st);
  const html = shell({
    path, title, description, h1: s.name, kicker: `${ELECTION} ballot`, lastmod, body,
    crumbs: [[SITE_NAME, '/'], [s.name, null]],
    about: { '@type': 'AdministrativeArea', name: s.name },
  }, a, footerHTML(d, sb.howto.last_verified));
  return { path, file: `${path.slice(1)}.html`, title, description, lastmod, html, kind: 'state', name: s.name, summary: 'statewide races and measures, key dates, ID rules and where to vote' };
}

/* ---------- the home page's additions, the 404, and the files for crawlers ---------- */
const byState = (d: SiteData): string[] => Object.keys(d.index.states).sort((a, b) => d.index.states[a].name.localeCompare(d.index.states[b].name));
/* For dist/index.html: the guide described for structured data, and, for anything that reads the page without
   running it, a list of every page. A browser with JavaScript never shows the noscript. */
export function homeExtras(d: SiteData): { jsonLd: string; noscript: string } {
  const ld = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [{
      '@type': 'WebSite', '@id': `${ORIGIN}/#site`, url: `${ORIGIN}/`, name: SITE_NAME, inLanguage: 'en-US',
      description: 'A nonpartisan guide to the Nov 3, 2026 general election ballot, in plain English: how to vote, what is on your ballot and who endorsed whom.',
      publisher: { '@type': 'Person', name: 'Kevin HG', url: 'https://kevinhg.com' },
    }],
  }).replace(/</g, '\\u003c');
  const list = byState(d).map((st) => `<li><a href="${esc(statePath(d, st))}">${esc(d.index.states[st].name)}</a>: ${d.index.states[st].places.map((id) => `<a href="${esc(placePath(id))}">${esc(shortLabel(d.index.places[id].label))}</a>`).join(', ')}</li>`).join('');
  const noscript = `<noscript><div style="padding:16px;font-family:Georgia,serif;max-width:640px"><p>Turn on JavaScript to build your ballot. Find official voting info for every state at <a href="https://vote.gov/">vote.gov</a>.</p><p>You can still read about the ballot where you live:</p><ul>${list}</ul></div></noscript>`;
  return { jsonLd: ld, noscript };
}
export function notFoundPage(d: SiteData, a: Assets, today: string): string {
  return shell({
    path: '/404', title: `Page not found: ${SITE_NAME}`, description: 'We could not find that page in the guide.', h1: 'Page not found', kicker: `${ELECTION} ballot`,
    lastmod: today, crumbs: [[SITE_NAME, '/'], ['Page not found', null]], about: null,
    body: `<p class="pg-lede">We couldn't find that page in the guide.</p><p style="margin-top:18px"><a class="bigbtn" href="/">Open the guide</a></p>`,
  }, { ...a, js: null }, footerHTML(d, null)).replace(/<link rel="canonical"[^>]*>\n/, '<meta name="robots" content="noindex">\n').replace(/<script type="application\/ld\+json">[^<]*<\/script>\n/, '');
}
export function sitemapXML(pages: Page[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map((p) => `<url><loc>${esc(`${ORIGIN}${p.path}`)}</loc><lastmod>${p.lastmod}</lastmod></url>`).join('\n')}
</urlset>
`;
}
/* Every crawler is welcome, search and AI assistants alike: the guide exists to be found. Checked Oct 28, 2026
   against each vendor's own page: Googlebot, Bingbot, OAI-SearchBot and ChatGPT-User (OpenAI), PerplexityBot and
   Perplexity-User, Claude-SearchBot and Claude-User (Anthropic), Applebot, DuckDuckBot. One group for all of them
   keeps it simple; a named group would make that crawler ignore this one. */
export function robotsTXT(): string {
  return `# ${SITE_NAME}: a nonpartisan guide to the ${ELECTION} ballot. Every crawler is welcome,
# search engines and AI assistants alike. A save link's picks live after a # and never reach this site.
User-agent: *
Allow: /

Sitemap: ${ORIGIN}/sitemap.xml
`;
}
/* llms.txt (https://llmstxt.org/): what the guide is, in plain words, and every page. */
export function llmsTXT(d: SiteData, pages: Page[]): string {
  const places = pages.filter((p) => p.kind === 'place');
  const states = pages.filter((p) => p.kind === 'state');
  const nStates = Object.keys(d.index.states).filter((s) => s !== 'DC').length;
  return `# ${SITE_NAME}

> A free, nonpartisan guide to the ${ELECTION} U.S. general election for ${places.length} places in ${nStates} states and Washington, DC: the races and measures in plain English, key dates, ID rules, where to vote, and endorsements from newspapers, groups and parties side by side.

- The guide never recommends a candidate or a side. It quotes candidates in their own words and treats every candidate the same way.
- Every fact links to an official election office or a named source.
- At ${ORIGIN}/ a voter enters a ZIP code or address to build their own ballot. Their picks stay on their device.
- The pages below have the same facts as plain HTML, one per state and one per place.

## States

${states.map((p) => `- [${p.name}](${ORIGIN}${p.path}): ${p.summary}`).join('\n')}

## Places

${places.map((p) => `- [${p.name}](${ORIGIN}${p.path}): ${p.summary}`).join('\n')}

## Optional

- [The guide](${ORIGIN}/): build your own ballot and voting plan
- [vote.gov](https://vote.gov/): official voting info for every state
`;
}

/* ---------- all of it ---------- */
export function allPages(d: SiteData, a: Assets, today: string): Page[] {
  const states = byState(d).map((st) => statePage(d, st, a, today));
  const places = byState(d).flatMap((st) => d.index.states[st].places.map((id) => placePage(d, id, a, today)));
  return [...states, ...places];
}
/* The newest date any page carries, for the home page's own lastmod. */
export const homeLastmod = (pages: Page[], today: string): string => newest(pages.map((p) => p.lastmod), today);
/* What a page says, apart from the build's asset names: a page whose fingerprint didn't change between two
   deployments needs no IndexNow ping. */
export const PLACEHOLDER: Assets = { css: '/assets/STYLE.css', js: '/assets/VISIT.js' };
