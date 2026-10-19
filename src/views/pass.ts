/* Pass it on: after your own plan, help your people make theirs. Two messages to copy (one for
   friends and family that can include the guide; one for work, school and public channels with
   official links only, never the guide), a who-and-where checklist, and, when the data track
   supplies it, the texting study and ways to get involved (data/get-involved.json). Every fact
   in the public message comes from the state file, so it is right for every state. */
import { S } from '../state';
import { esc, fmtDate } from '../util';
import { nextStep, registrationAlert } from '../model/plan';
import { ext } from './common';

/* Optional data from data/get-involved.json. Read defensively: any field may be missing. */
export interface GetInvolved {
  study?: { text?: string; cite?: string; url?: string };
  ways?: { title?: string; items?: { label?: string; url?: string; note?: string }[] }[];
}
let involved: GetInvolved | null = null;
export const setInvolved = (g: GetInvolved | null): void => { involved = g; };

const WHO = [
  ['family', 'Family group chat'], ['friends', 'Friends group chat'], ['school', 'School or parent groups'],
  ['work', 'Work Slack or Teams'], ['hood', 'Neighborhood or building group'], ['post', 'A social post'],
];
const COPY = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="5" y="5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 11V3h8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';

export function messages(): { fam: string; pub: string } {
  const b = S.ballot!;
  const h = b.howto;
  const step = nextStep(h, undefined, true);
  const stepLine = step.head.map((p) => p[0]).join('');
  const site = `${location.origin}${location.pathname}`;
  const ed = fmtDate(h.election_date);
  const fam = `I just made my plan to vote. Election Day is ${ed}. This guide shows what’s on your ballot in plain words and who endorsed whom: ${site}\n\nDo you have a plan? Text three people and ask them too.`;
  const reg = registrationAlert(h, undefined, true);
  const look = h.early_in_person.lookup_url || h.election_day.lookup_url || h.mail_ballot.drop_box_lookup_url;
  const pub = [
    `Reminder for ${b.stateName} voters: Election Day is ${ed}.`,
    stepLine,
    reg || '',
    h.registration.check_url ? `Check your registration: ${h.registration.check_url}` : '',
    look ? `Find where to vote: ${look}` : '',
    `Official info: ${h.official_site.url}`,
    'Message me if you have questions.',
  ].filter(Boolean).join('\n');
  return { fam, pub };
}

function involvedHTML(): string {
  if (!involved) return '';
  const st = involved.study;
  const study = st && st.text ? `<p class="study">${esc(st.text)}${st.url ? ` ${ext(st.url, st.cite || 'The study')}` : st.cite ? ` (${esc(st.cite)})` : ''}</p>` : '';
  const ways = (involved.ways || []).filter((g) => g.items && g.items.length).map((g) => `<div class="grp">${g.title ? `<h4>${esc(g.title)}</h4>` : ''}<ul>${g.items!.filter((x) => x.label).map((x) => `<li>${x.url ? ext(x.url, x.label!) : esc(x.label!)}${x.note ? ` <span>${esc(x.note)}</span>` : ''}</li>`).join('')}</ul></div>`).join('');
  return `${study}${ways ? `<h3>Beyond texting</h3><div class="ways">${ways}</div>` : ''}`;
}

export function passHTML(): string {
  const m = messages();
  const voted = S.ui.open.has('voted');
  return `<section class="pass" id="pass" aria-labelledby="pass-h"><div class="wrap">
    <button class="back" data-act="view" data-v="ballot" data-fk="pass-back">Back to the ballot</button>
    ${voted ? '<div class="voted-head"><p class="kick">You voted. Thank you.</p></div>' : ''}
    <h2 id="pass-h">Pass it on</h2>
    <p class="lede">Make sure everyone you know has a plan. If they do, ask them to text three people.</p>
    <p class="compound">You text 3. They each text 3. That’s 12 people with a plan.</p>
    ${involvedHTML()}
    <h3>Who to text</h3><p class="sub">Tick them off as you go. This stays on your phone.</p>
    <ul class="checks">${WHO.map(([k, l]) => { const on = S.b.ticks.includes(k); return `<li><button data-act="tick" data-k="${k}" aria-pressed="${on}" data-fk="tick-${k}"><span class="bx" aria-hidden="true"></span><span class="lb">${esc(l)}</span></button></li>`; }).join('')}</ul>
    <div class="msgs fam"><h4>For friends and family</h4><p class="rule">Your people. It’s fine to share this guide.</p>
      <div class="msg"><p id="msg-fam">${esc(m.fam)}</p><button class="copy" data-act="copy-msg" data-k="fam" data-fk="copy-fam">${COPY}Copy this</button></div></div>
    <div class="msgs pub"><h4>For work, school and public groups</h4><p class="rule">Nonpartisan: official links only, never this guide.</p>
      <div class="msg"><p id="msg-pub">${esc(m.pub)}</p><button class="copy" data-act="copy-msg" data-k="pub" data-fk="copy-pub">${COPY}Copy this</button></div></div>
  </div></section>`;
}
