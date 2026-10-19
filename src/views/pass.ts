/* Pass it on: after your own plan, help your people make theirs. Two messages to copy (one for
   friends and family that can include the guide; one for work, school and public channels with
   official links only, never the guide), a who-to-send-it-to checklist, and, from
   data/get-involved.json, the message templates, the texting study with its caveats and ways
   to get involved. Every link in the public message is a statewide one from the state file, so
   it is right for anyone in the state. */
import { S } from '../state';
import { esc } from '../util';
import { ext, isOpen } from './common';

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
  ['family', 'Family group chat'], ['friends', 'Friends group chat'], ['school', 'School or parent groups'],
  ['work', 'Work Slack or Teams'], ['hood', 'Neighborhood or building group'], ['post', 'A social post'],
];
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

export function messages(): { fam: string | null; pub: string | null } {
  const b = S.ballot!;
  const h = b.howto;
  const site = `${location.origin}${location.pathname}`;
  const voted = S.ui.open.has('voted');
  const famBody = fillTemplate(involved?.messages?.friends_family?.template || FAM, { guide_url: site }, ['guide_url']);
  const fam = famBody && voted ? `I just voted! ${famBody}` : famBody;
  // Statewide official links only: a public group reaches people in other counties, so a local
  // office's page never goes in (a template that still asks for one gets an empty line).
  const pub = fillTemplate(involved?.messages?.public?.template || PUB, {
    state_name: b.stateName,
    registration_check_url: h.registration.check_url || '',
    official_voting_url: h.official_site.url || '',
    local_election_office_line: '',
  }, ['state_name', 'official_voting_url']);
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
  return `<h3>Why text a friend?</h3><p class="study">${esc(st.text)}${st.url ? ` ${ext(st.url, st.cite || 'The study')}` : st.cite ? ` (${esc(st.cite)})` : ''}</p>
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
  return `<h3>${esc(gi?.title || 'Beyond texting')}</h3>${gi?.intro ? `<p class="sub">${esc(gi.intro)}</p>` : ''}<div class="ways">${body}</div>`;
}

export function passHTML(): string {
  const m = messages();
  const voted = S.ui.open.has('voted');
  const data = involved?.who_to_text;
  const who = WHO.map(([k, l], i) => [k, data && data.length === WHO.length && data[i] ? data[i] : l]);
  const msg = (k: 'fam' | 'pub', text: string | null) => (text
    ? `<div class="msg"><p id="msg-${k}">${esc(text)}</p><button class="copy" data-act="copy-msg" data-k="${k}" data-fk="copy-${k}">${COPY}Copy this</button></div>`
    : '<p class="small">This message isn’t ready for your state yet.</p>');
  return `<section class="pass" id="pass" aria-labelledby="pass-h"><div class="wrap">
    <button class="back" data-act="view" data-v="ballot" data-fk="pass-back">Back to the ballot</button>
    ${voted ? '<div class="voted-head"><p class="kick">You voted. Thank you.</p></div>' : ''}
    <h2 id="pass-h">Pass it on</h2>
    <p class="lede">Make sure your people have a plan. Copy a message, send it, and ask them to text three people too.</p>
    <div class="msgs fam"><h4>For friends and family</h4><p class="rule">Your people. It’s fine to share this guide.</p>${msg('fam', m.fam)}</div>
    <div class="msgs pub"><h4>For work, school and public groups</h4><p class="rule">Nonpartisan: official links only, never this guide.</p>${msg('pub', m.pub)}</div>
    <h3>Who to send it to</h3><p class="sub">Tick them off as you go. This stays on your phone.</p>
    <ul class="checks">${who.map(([k, l]) => { const on = S.b.ticks.includes(k); return `<li><button data-act="tick" data-k="${k}" aria-pressed="${on}" data-fk="tick-${k}"><span class="bx" aria-hidden="true"></span><span class="lb">${esc(l)}</span></button></li>`; }).join('')}</ul>
    ${studyHTML()}
    ${waysHTML()}
  </div></section>`;
}
