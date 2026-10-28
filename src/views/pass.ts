/* Help your friends vote (was "Pass it on"): after your own plan, help your people make theirs.
   "Share the guide" (the phone's share sheet, or a copy), two messages to copy (one for friends,
   family and public posts that links the guide, since public sharing is fine (Kevin, Oct 20); one
   for work, school and neighborhood groups with official links only, never the guide), a
   list of good spots to post (ticks stay on this device), and, from data/get-involved.json, the message templates, the
   ways to get involved, and last the texting study with its caveats (the reasons come after the
   things to do). Every link in the official-links message is a statewide one from the state file,
   or this place's own where-to-vote page. */
import { S } from '../state';
import { esc, fmtDate, todayISO } from '../util';
import { clock, isMailState, nextStep } from '../model/plan';
import { ext, isOpen } from './common';
import { trustHTML } from './trust';

/* Optional data from data/get-involved.json. Read defensively: any field may be missing. */
interface GiItem { id?: string; label?: string; action?: string; url?: string; mission_quote?: { text?: string; source?: string } | null }
interface Template { template?: string }
export interface GetInvolved {
  study?: { text?: string; cite?: string; url?: string; caveats?: string[] };
  get_involved?: {
    title?: string; intro?: string; selection_note?: string;
    groups?: { id?: string; label?: string; items?: GiItem[] }[];
    link_bindings?: Record<string, { preferred_field?: string; fallback_field?: string; fallback_url?: string; url?: string }>;
  };
  messages?: { friends_family?: Template; public?: Template };
  who_to_text?: string[];
}
let involved: GetInvolved | null = null;
export const setInvolved = (g: GetInvolved | null): void => { involved = g; };

const WHO = [
  ['family', 'Family chat'], ['friends', 'Friends chat'], ['school', 'School or parent groups'],
  ['work', 'Work channels'], ['hood', 'Neighborhood groups'], ['post', 'A public post'],
];
/* "Good spots to post", in the order of the two messages: a public post goes with the friends message. */
const WHO_ORDER = [0, 1, 5, 2, 3, 4];
const COPY = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="5" y="5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 11V3h8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';

/* The default templates match data/get-involved.json, so the page reads the same with or
   without it. The public one carries only statewide official links: never this guide, a
   local office's page, a saved ballot or a partisan group, and never
   election_day.lookup_url (in IL, MO, OR, PA and WA that one is a local office's page). */
const FAM = 'Got a plan to vote? Here’s a guide to help you sort through your ballot: {guide_url}\n\nIf you’ve already voted, text three people and ask if they have a plan too. Message me if you have questions.';
const PUB = 'Here are the official voting links for {state_name}:\nCheck your registration: {registration_check_url}\nOfficial election info: {official_voting_url}\n\nAlready voted? Text three people and ask if they have a plan too. Message me if you have questions.';

/* Fill a template line by line: a line whose slot is empty is left out, a line that repeats a
   URL already given is left out, extra blank lines are trimmed. Null when a required slot is
   missing or a token is left over, so the copy button never offers a broken message. */
export function fillTemplate(tpl: string, slots: Record<string, string>, required: string[]): string | null {
  if (required.some((k) => !slots[k])) return null;
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of tpl.split('\n')) {
    const keys = [...raw.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    if (keys.some((k) => !slots[k])) continue;
    const line = raw.replace(/\{(\w+)\}/g, (_, k) => slots[k]);
    const urls = line.match(/https?:\/\/\S+/g) || [];
    if (urls.length && urls.every((u) => seen.has(u.replace(/[.,;]$/, '')))) continue;
    urls.forEach((u) => seen.add(u.replace(/[.,;]$/, '')));
    lines.push(line);
  }
  const out = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return /\{\w+\}/.test(out) ? null : out;
}

/* The guide's public address since Oct 19, 2026. The friends message shares this one whatever
   host the page is on (the old vercel.app address and Vercel previews still work, but a friend
   should get the short, lasting one). */
export const GUIDE_URL = 'https://vote.kevinhg.com/';
export const SHARE_TITLE = 'Quickly make your voting plan.';
/* What "Share the guide" hands the phone's share sheet: the friends message, with the guide's
   address as the link. The message ends its first line with the address; the link carries it
   instead, so a text never shows it twice. A message worded some other way goes as written. */
export function shareData(fam: string): { title: string; text: string; url?: string } {
  const at = new RegExp(`:\\s*${GUIDE_URL.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?=\\n|$)`);
  return at.test(fam) ? { title: SHARE_TITLE, text: fam.replace(at, '.'), url: GUIDE_URL } : { title: SHARE_TITLE, text: fam };
}

export function messages(): { fam: string | null; pub: string | null } {
  const b = S.ballot!;
  const h = b.howto;
  const voted = S.ui.open.has('voted');
  const famBody = fillTemplate(involved?.messages?.friends_family?.template || FAM, { guide_url: GUIDE_URL }, ['guide_url']);
  const fam = famBody && voted ? `I just voted! ${famBody}` : famBody;
  // Statewide official links only: a public group reaches people in other counties, so a local
  // office's page never goes in (a template that still asks for one gets an empty line).
  const links = fillTemplate(involved?.messages?.public?.template || PUB, {
    state_name: b.stateName,
    registration_check_url: h.registration.check_url || '',
    official_voting_url: h.official_site.url || '',
    local_election_office_line: '',
  }, ['state_name', 'official_voting_url']);
  // The reminder people send it for: Election Day and the state's early-voting or mail line, from
  // the state file (not one county's window), then the links, then where to vote here when the
  // place has its own tool.
  const sh = b.stateHowto;
  const dates = [`Election Day in ${b.stateName} is ${fmtDate(sh.election_date)}.`];
  if (isMailState(sh)) {
    const r = sh.mail_ballot.return_deadline;
    const time = clock(r.time);
    dates.push(r.rule === 'postmarked_by'
      ? `Drop off your ballot by ${time ? `${time} ` : ''}${fmtDate(r.date)}, or mail it with a postmark dated ${fmtDate(r.date, { weekday: false })} or earlier.`
      : `Ballots must be in by ${time ? `${time} ` : ''}${fmtDate(r.date)}. Postmarks don’t count.`);
  }
  const place = b.places.length === 1 ? b.places[0] : null;
  if (!isMailState(sh)) {
    // A county's own window when this ballot's place has one; otherwise the state's, and where
    // counties set their own days (Florida, Illinois) the state's dates are a minimum, so say so.
    const own = place && place.early_in_person;
    const ep = own || sh.early_in_person;
    // "minimum": the state's window is a floor every county offers (Florida); "varies": there is no
    // statewide window, only a common last day (Illinois).
    const vary = (sh.early_in_person as { counties_vary?: 'minimum' | 'varies' }).counties_vary;
    if (sh.early_in_person.available && ep.start && ep.end && ep.end >= todayISO()) {
      const span = `${fmtDate(ep.start)} through ${fmtDate(ep.end)}`;
      const county = own && place!.counties && place!.counties.length === 1 ? `${place!.counties[0]} County` : place ? place.label.replace(/\s*\(.*\)$/, '') : '';
      dates.push(own ? `Early voting in ${county} runs ${span}.`
        : vary === 'minimum' ? `Every ${b.stateName} county offers early voting ${span}. Some counties start earlier or finish later; check yours.`
        : vary === 'varies' ? `Early voting dates vary by county and run through ${fmtDate(ep.end)}; check yours.`
        : `Early voting runs ${span}.`);
    }
  }
  // Where to vote: during early voting, the early voting sites (the plan's own "Find early voting
  // places" page: this place's, or the state's); otherwise this place's own where-to-vote page.
  const name = place ? place.label.replace(/\s*\(.*\)$/, '') : '';
  let where = '';
  let whereLine = '';
  if (nextStep(b.howto).phase === 'early_open') {
    where = b.howto.early_in_person.lookup_url || sh.early_in_person.lookup_url || '';
    const own = !!name && where !== sh.early_in_person.lookup_url;
    whereLine = `Find early voting places${own ? ` in ${name}` : ''}: ${where}`;
  } else {
    where = place && place.lookups ? place.lookups.election_day || place.lookups.early_in_person || '' : '';
    whereLine = `Find where to vote in ${name}: ${where}`;
  }
  let pub: string | null = null;
  if (links) {
    const ls = links.split('\n');
    if (where && !links.includes(where)) {
      const at = ls.map((l) => /^(Official election info|Check your registration):/.test(l)).lastIndexOf(true);
      ls.splice(at + 1, 0, whereLine);
    }
    pub = [dates.join(' '), '', ...ls].join('\n');
  }
  return { fam, pub };
}

/* A way to help whose link depends on where you vote (your state's registration lookup, your
   county's office), from the data's link_bindings; otherwise its own link. */
function wayUrl(it: GiItem): string | null {
  const b = S.ballot!;
  const bind = it.id ? involved?.get_involved?.link_bindings?.[it.id] : undefined;
  const field = (f?: string): string | null => {
    if (f === 'state.registration.check_url') return b.howto.registration.check_url || null;
    if (f === 'state.official_site.url') return b.howto.official_site.url || null;
    if (f === 'confirmed_place.county_election_office.url') return b.places.length === 1 ? b.places[0].county_election_office?.url || null : null;
    return null;
  };
  if (bind) return bind.url || field(bind.preferred_field) || field(bind.fallback_field) || bind.fallback_url || it.url || null;
  return it.url || null;
}

function studyHTML(): string {
  const st = involved?.study;
  if (!st || !st.text) return '';
  const k = 'study-more';
  const cav = (st.caveats || []).filter(Boolean);
  return `<h3>The research on texting friends</h3><p class="study">${esc(st.text)}${st.url ? ` ${ext(st.url, st.cite || 'The study')}` : st.cite ? ` (${esc(st.cite)})` : ''}</p>
    ${cav.length ? `<button class="linkbtn study-tog" data-act="open" data-k="${k}" aria-expanded="${isOpen(k)}" data-fk="${k}">What this study does and doesn’t show</button>${isOpen(k) ? `<ul class="bul study-cav">${cav.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}` : ''}`;
}

function waysHTML(): string {
  const gi = involved?.get_involved;
  const groups = (gi?.groups || []).filter((g) => g.items && g.items.some((x) => x.label));
  if (!groups.length) return '';
  const item = (x: GiItem) => {
    const url = wayUrl(x);
    const mq = x.mission_quote && x.mission_quote.text ? ` Its stated mission: “${esc(x.mission_quote.text)}”${x.mission_quote.source ? ` ${ext(x.mission_quote.source, 'source')}` : ''}` : '';
    return `<li><b>${url ? ext(url, x.label!) : esc(x.label!)}</b>${x.action || mq ? `<span class="w-act">${esc(x.action || '')}${mq}</span>` : ''}</li>`;
  };
  let notePlaced = false;
  const body = groups.map((g) => {
    const partisan = g.id !== 'nonpartisan';
    const note = partisan && !notePlaced && gi?.selection_note ? (notePlaced = true, `<p class="w-note">${esc(gi.selection_note)}</p>`) : '';
    return `${note}<div class="grp">${g.label ? `<h4>${esc(g.label)}</h4>` : ''}<ul>${g.items!.filter((x) => x.label).map(item).join('')}</ul></div>`;
  }).join('');
  return `<h3>${esc(gi?.title || 'Other ways to help')}</h3>${gi?.intro ? `<p class="sub">${esc(gi.intro)}</p>` : ''}<div class="ways">${body}</div>`;
}

export function passHTML(): string {
  const m = messages();
  const voted = S.ui.open.has('voted');
  const data = involved?.who_to_text;
  const who = WHO.map(([k, l], i) => [k, data && data.length === WHO.length && data[i] ? data[i] : l]);
  const msg = (k: 'fam' | 'pub', text: string | null) => (text
    ? `<div class="msg"><p id="msg-${k}">${esc(text)}</p><button class="copy" data-act="copy-msg" data-k="${k}" data-fk="copy-${k}">${COPY}Copy message</button></div>`
    : '<p class="small">This message isn’t ready for your state yet.</p>');
  return `<section class="pass" id="pass" aria-labelledby="pass-h"><div class="wrap">
    <button class="back" data-act="view" data-v="cheat" data-fk="pass-back">Back to my plan</button>
    ${voted ? '<div class="voted-head"><p class="kick">You voted. Thank you.</p></div>' : ''}
    <div class="step pass-step"><span class="step-n" aria-hidden="true">5</span><h2 id="pass-h">Help your friends vote</h2></div>
    <p class="lede">Copy a message, make it your own, and send it. Ask each person to text three more.</p>
    <div class="msgs fam"><h4>For friends, family and public posts</h4><p class="rule">Includes a link to this guide.</p>${msg('fam', m.fam)}</div>
    <div class="msgs pub"><h4>For work, school and neighborhood groups</h4><p class="rule">Official links only. No link to this guide, so it stays nonpartisan.</p>${msg('pub', m.pub)}</div>
    <h3>Good spots to post</h3>
    <ul class="checks">${WHO_ORDER.map((i) => who[i]).map(([k, l]) => { const on = S.b.ticks.includes(k); return `<li><button data-act="tick" data-k="${k}" aria-pressed="${on}" data-fk="tick-${k}"><span class="bx" aria-hidden="true"></span><span class="lb">${esc(l)}</span></button></li>`; }).join('')}</ul>
    ${waysHTML()}
    ${studyHTML()}
  </div>${trustHTML()}<div class="crowd" aria-hidden="true"></div></section>`;
}
