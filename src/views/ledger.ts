/* The ledger: your ballot as a calm list of rows in printed-ballot order, a verdict column down
   the right edge, section bands that fold when you're done, and the bottom bar.
   Test hooks (a contract with tests/e2e.mjs and tests/sweep.mjs; keep them):
     id="i-<item id>" + data-item on every item, data-undecided on undecided rows,
     data-q="<group key>" on district questions, data-act on every control,
     .sec[data-sec] with .sec-count, .unopp .disc for unopposed races, .bar-txt in the bar. */
import type { Contest, Item, PlaceBundle } from '../types';
import { S } from '../state';
import {
  SECTIONS, type SectionKey, type Entry, type Group, entriesBySection, status, isDecision, sectionOf, decisionItems, isMultiJudge,
} from '../ballot';
import { esc, hash, plural } from '../util';
import { rowTitle, measureTag, courtGroup, cleanOffice, optionLabel } from '../model/labels';
import { verdict, type Verdict } from '../model/tally';
import { planAgree, planParty } from '../model/bulk';
import { judgeBatch, judicialReview } from '../model/judges';
import { ext, sampleBallot, isOpen, escP, leadRest } from './common';
import { lensHTML } from './lens';
import { addrHTML } from './mast';
import { openHTML } from './open';

/* ---------- names ---------- */
export function countyName(p: PlaceBundle): string {
  if (p.county_label) return p.county_label;
  if (p.counties.length !== 1) return 'County';
  const c = p.counties[0].replace(/\s*\([^)]*\)/g, '').trim();
  if (/district of columbia/i.test(c)) return 'District of Columbia';
  return /\b(county|city|parish|borough)$/i.test(c) ? c : `${c} County`;
}
export function sectionTitle(sec: SectionKey): string {
  const b = S.ballot!;
  const one = b.places.length === 1 ? b.places[0] : null;
  switch (sec) {
    case 'federal': return 'Federal offices';
    case 'state': return b.st === 'DC' ? 'District offices' : `${b.stateName} offices`;
    case 'judicial': return 'Judges';
    case 'county': return one ? countyName(one) : 'County';
    case 'city': return b.st === 'DC' ? 'Local offices' : one ? one.label.replace(/\s*\(.*\)$/, '') : 'City';
    case 'school': return 'Schools';
    case 'special_district': return 'Special districts';
    default: return 'Measures';
  }
}
function sectionSub(sec: SectionKey): string {
  const b = S.ballot!;
  if (sec === 'measures') return 'Each one says what a yes and a no vote mean.';
  if (sec === 'judicial') {
    const jr = judicialReview();
    return jr && jr.to_keep_a_judge ? `To keep a judge: ${jr.to_keep_a_judge}.`.replace(/\.\.$/, '.') : '';
  }
  if ((sec === 'city' || sec === 'county' || sec === 'school' || sec === 'special_district') && b.places.length > 1) return `Some only in ${b.places.map((p) => p.label).join(' or ')}`;
  return '';
}

/* ---------- heads-up notes, each shown once where it applies ---------- */
export function headsUp(applies: string): string[] {
  const b = S.ballot!;
  const all = [...(b.howto.heads_up || []), ...b.places.flatMap((p) => p.heads_up || [])];
  const seen = new Set<string>();
  return all.filter((h) => h.applies_to === applies && !seen.has(h.text) && seen.add(h.text)).map((h) => h.text);
}
export const headsHTML = (list: string[]): string => list.map((t) => `<p class="heads"><b>Heads up:</b> ${escP(t)}</p>`).join('');

/* ---------- the verdict column ---------- */
export function verdictHTML(v: Verdict): string {
  const cls = v.kind === 'mine' ? 'done' : v.kind === 'review' ? `review ${v.tone || ''}` : v.kind;
  const sub = v.kind === 'mine' && v.filled ? `${v.sub ? `${v.sub}. ` : ''}filled for you` : v.sub;
  const label = v.kind === 'mine' ? 'Your pick: ' : v.kind === 'review' ? 'Official review: ' : v.kind === 'agree' ? 'Your sources agree: ' : v.kind === 'split' ? 'Your sources disagree: ' : '';
  return `<span class="vd ${cls}"><span class="m"><span class="vh">${label}</span>${esc(v.main)}</span>${sub ? `<span class="s">${esc(sub)}</span>` : ''}</span>`;
}
const qVerdict = (main: string, sub = ''): string => `<span class="vd q"><span class="m">${esc(main)}</span>${sub ? `<span class="s">${esc(sub)}</span>` : ''}</span>`;

/* ---------- rows ---------- */
function titleHTML(it: Item): string {
  const r = rowTitle(it);
  if (it.kind === 'measure') {
    const tag = measureTag(it);
    if (tag && tag.length <= 4) return `<span class="ttl is-m"><span class="num">${esc(tag)}</span><span class="t"><span class="t-sum">${esc(leadRest(r.sub || r.title, 40)[0])}</span></span></span>`;
    return `<span class="ttl is-m-long"><span class="t"><b>${esc(r.title)}</b>${r.sub ? `<small class="t-sum">${esc(leadRest(r.sub, 40)[0])}</small>` : ''}</span></span>`;
  }
  return `<span class="ttl"><span class="t"><b>${esc(r.title)}</b>${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span></span>`;
}
export function rowHTML(it: Item): string {
  const s = status(it);
  const b = S.ballot!;
  const open = S.ui.row === it.id;
  const decided = s === 'decided' || s === 'auto' || s === 'skipped';
  let vd: string;
  if (s === 'info') vd = '<span class="vd none"><span class="m">Depends on your address</span></span>';
  else vd = verdictHTML(verdict(it));
  const tags: string[] = [];
  if (b.onlyIn[it.id]) tags.push(`Only in ${b.onlyIn[it.id].join(', ')}`);
  else if (b.mayApply.has(it.id) || (b.groupOf[it.id] && S.b.districts[b.groupOf[it.id]] === '*')) tags.push('May apply');
  const cls = ['row', decided ? 'is-done' : '', open ? 'is-open' : '', s === 'info' ? 'is-info' : '', S.ui.keep === it.id ? 'just' : ''].filter(Boolean).join(' ');
  return `<li class="${cls}" id="i-${esc(it.id)}" data-item="${esc(it.id)}"${s === 'open' ? ' data-undecided' : ''}>
    <button class="row-hd" data-act="row" data-id="${esc(it.id)}" aria-expanded="${open}" data-fk="row-${esc(it.id)}">
      <span class="mk" aria-hidden="true"><i></i></span>${titleHTML(it)}${vd}</button>
    ${tags.length ? `<span class="tag-line">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</span>` : ''}
    ${open ? openHTML(it) : ''}
  </li>`;
}
export const qId = (g: Group): string => `q-${hash(g.key)}`;
function questionHTML(g: Group): string {
  const open = S.ui.row === `q:${g.key}`;
  return `<li class="row is-q${open ? ' is-open' : ''}" id="${qId(g)}" data-q="${esc(g.key)}" data-undecided>
    <button class="row-hd" data-act="row" data-id="${esc(`q:${g.key}`)}" aria-expanded="${open}" data-fk="row-${qId(g)}">
      <span class="mk" aria-hidden="true"><i></i></span><span class="ttl"><span class="t"><b>${esc(cleanOffice(g.office))}</b><small>${plural(g.members.length, 'district')} touch your area</small></span></span>
      ${qVerdict('Which one is yours?')}</button>
    ${open ? questionBodyHTML(g) : ''}
  </li>`;
}
function finderFor(g: Group): { label: string; url: string } | null {
  const b = S.ballot!;
  for (const p of b.places) for (const f of p.district_finders || []) if (g.office.toLowerCase().includes(f.office_match.toLowerCase())) return f;
  return null;
}
function questionBodyHTML(g: Group): string {
  const b = S.ballot!;
  const members = g.members.map((id) => b.byId.get(id) as Contest);
  const finder = finderFor(g);
  const sb = sampleBallot();
  return `<div class="ob dq">
    <h3 class="dq-h">Which ${esc(cleanOffice(g.office))} district is yours?</h3>
    <p class="ob-lede">Your ZIP touches ${members.length} of them. Your sample ballot or voter registration says which.</p>
    <div class="opts">${members.map((c) => { const [l, sub] = optionLabel(c); return `<button class="opt" data-act="district" data-g="${esc(g.key)}" data-v="${esc(c.id)}" data-fk="d-${esc(c.id)}"><b>${esc(l)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</button>`; }).join('')}
      <button class="opt opt-unsure" data-act="district" data-g="${esc(g.key)}" data-v="*" data-fk="d-${hash(g.key)}-x"><b>Not sure? Skip for now</b><small>Show all ${members.length}, each marked “May apply”</small></button></div>
    <p class="dq-help">${[finder ? ext(finder.url, finder.label) : '', g.kind ? '<button class="linkbtn" data-act="addr-open">Answer from my address</button>' : '', sb ? ext(sb.url, sb.label) : ''].filter(Boolean).join('<span class="dot" aria-hidden="true"> · </span>')}</p>
  </div>`;
}
function glineHTML(g: Group): string {
  const b = S.ballot!;
  const ans = S.b.districts[g.key];
  const v = ans === '*' ? `Showing all ${g.members.length}` : ans === 'none' ? 'None on your ballot (from your address)' : (() => { const c = b.byId.get(ans) as Contest | undefined; return c ? optionLabel(c)[0] : ''; })();
  return `<li class="row gline" id="${qId(g)}"><div class="gl-in"><span class="gl-t">${esc(cleanOffice(g.office))}: <b>${esc(v)}</b></span>
    <button class="linkbtn" data-act="district-change" data-g="${esc(g.key)}" data-fk="dc-${qId(g)}">Change</button></div></li>`;
}
function notMineHTML(it: Item): string {
  const r = rowTitle(it);
  return `<li class="row is-off" id="i-${esc(it.id)}" data-item="${esc(it.id)}"><div class="row-hd as-div">
      <span class="mk" aria-hidden="true"><i></i></span><span class="ttl"><span class="t"><b>${esc(r.title)}</b>${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span></span>
      <span class="vd off"><span class="m">Not on your ballot</span><button class="linkbtn" data-act="notmine-undo" data-id="${esc(it.id)}">Undo</button></span></div></li>`;
}
function unoppHTML(sec: SectionKey, list: Contest[]): string {
  if (!list.length) return '';
  const k = `unopp-${sec}`;
  const b = S.ballot!;
  return `<li class="row unopp"><button class="disc" data-act="open" data-k="${k}" aria-expanded="${isOpen(k)}" data-fk="${k}">${plural(list.length, 'unopposed race')}. Nothing to decide.</button>
    ${isOpen(k) ? `<ul class="unopp-list">${list.map((c) => {
      const k1 = c.candidates[0];
      const r = rowTitle(c);
      return `<li id="i-${esc(c.id)}" data-item="${esc(c.id)}"><span class="u-t">${esc(r.title)}${r.sub ? `, ${esc(r.sub)}` : ''}</span> <b>${esc(k1.name)}</b>${k1.party ? ` <span class="py">${esc(k1.party)}</span>` : ''}${b.mayApply.has(c.id) ? ' <span class="tag">May apply</span>' : ''}</li>`;
    }).join('')}</ul>` : ''}</li>`;
}

/* ---------- sections ---------- */
export function sectionCount(entries: Entry[]): string {
  const b = S.ballot!;
  let decided = 0, total = 0, unopp = 0;
  for (const e of entries) {
    if (e.t === 'question') { total++; continue; }
    if (e.t !== 'item') continue;
    const s = status(b.byId.get(e.id)!);
    if (s === 'unopposed') { unopp++; continue; }
    if (isDecision(s)) { total++; if (s !== 'open') decided++; }
  }
  return total ? `${decided} of ${total} decided` : unopp ? 'Nothing to decide' : '';
}
function sectionDone(entries: Entry[]): boolean {
  const b = S.ballot!;
  let any = false;
  for (const e of entries) {
    if (e.t === 'question') return false;
    if (e.t !== 'item') continue;
    const s = status(b.byId.get(e.id)!);
    if (s === 'open') return false;
    if (isDecision(s)) any = true;
  }
  return any;
}
export const sectionFolded = (sec: SectionKey, entries: Entry[]): boolean =>
  (S.ui.folded.has(sec) || (sectionDone(entries) && !S.ui.unfolded.has(sec))) && !entries.some((e) => e.t === 'item' && e.id === S.ui.row);
function foldSummary(entries: Entry[]): string {
  const b = S.ballot!;
  const bits: string[] = [];
  let keep = 0, remove = 0;
  for (const e of entries) {
    if (e.t !== 'item') continue;
    const it = b.byId.get(e.id)!;
    if (!isDecision(status(it))) continue;
    if (it.kind === 'contest' && it.is_retention) {
      const ks = isMultiJudge(it) ? it.candidates.map((c) => S.b.picks[`${it.id}|${c.name}`]) : [S.b.picks[it.id]];
      ks.forEach((v) => { if (v === 'YES') keep++; else if (v === 'NO') remove++; });
      continue;
    }
    const v = verdict(it);
    if (v.kind === 'mine') bits.push(v.main);
  }
  if (keep || remove) bits.unshift([keep ? `Keep ${keep}` : '', remove ? `remove ${remove}` : ''].filter(Boolean).join(', '));
  return bits.join(', ');
}

/* Long judge sections fold by court: one heading per court, opened on demand. */
const GROUP_AT = 24;
interface Block { key: string; label: string; entries: Entry[] }
function blocks(sec: SectionKey, entries: Entry[]): Block[] | null {
  if (sec !== 'judicial') return null;
  const b = S.ballot!;
  const rows = entries.filter((e) => e.t !== 'item' || status(b.byId.get(e.id)!) !== 'unopposed');
  if (rows.length <= GROUP_AT) return null;
  const out: Block[] = [];
  for (const e of rows) {
    const id = e.t === 'question' || e.t === 'groupline' ? e.group.members[0] : e.id;
    const it = b.byId.get(id) as Contest;
    const label = courtGroup(it);
    const last = out[out.length - 1];
    if (last && last.label === label) last.entries.push(e);
    else out.push({ key: `${sec}|${label}`, label, entries: [e] });
  }
  return out;
}
/* Court group counts, for updating the headings after one pick without repainting the section. */
export function groupCounts(sec: SectionKey): [string, string][] {
  const bl = blocks(sec, entriesBySection().get(sec) || []);
  return bl ? bl.map((g) => [g.key, sectionCount(g.entries)]) : [];
}
function entryHTML(e: Entry): string {
  const b = S.ballot!;
  if (e.t === 'question') return questionHTML(e.group);
  if (e.t === 'groupline') return glineHTML(e.group);
  if (e.t === 'notmine') return notMineHTML(b.byId.get(e.id)!);
  return rowHTML(b.byId.get(e.id)!);
}
/* "Only undecided" hides a row once it is decided, except the one you just decided (kept
   until your next move) and the open one. render.ts uses the same rule for one-row repaints. */
export const hiddenByOnly = (e: Entry): boolean => {
  if (!S.ui.onlyUndecided) return false;
  if (e.t === 'question') return false;
  if (e.t !== 'item') return true;
  if (e.id === S.ui.keep || e.id === S.ui.row) return false;
  return status(S.ballot!.byId.get(e.id)!) !== 'open';
};
function rowsHTML(sec: SectionKey, entries: Entry[]): string {
  const b = S.ballot!;
  const out: string[] = [];
  let lastJur = '';
  const unopp: Contest[] = [];
  const one = (e: Entry) => {
    if (e.t === 'item') {
      const it = b.byId.get(e.id)!;
      if (status(it) === 'unopposed') { unopp.push(it as Contest); return; }
      if (sec === 'measures' && it.kind === 'measure' && it.jurisdiction !== lastJur) {
        lastJur = it.jurisdiction;
        out.push(`<li class="subhd">${esc(it.jurisdiction.replace(/\s*\([^)]*\)/g, ''))}</li>`);
      }
    }
    if (hiddenByOnly(e)) return;
    out.push(entryHTML(e));
  };
  const bl = blocks(sec, entries);
  if (bl) {
    for (const g of bl) {
      // Only a long run of one court earns a heading that folds; short runs just list their rows.
      if (g.entries.length < 5) { g.entries.forEach(one); continue; }
      const open = S.ui.unfolded.has(g.key) || g.entries.some((e) => e.t === 'item' && e.id === S.ui.row);
      const cnt = sectionCount(g.entries);
      out.push(`<li class="grp"><button class="grp-hd" data-act="grp" data-g="${esc(g.key)}" aria-expanded="${open}" data-fk="g-${hash(g.key)}"><span class="grp-t">${esc(g.label)}</span><span class="grp-ct">${esc(cnt)}</span></button></li>`);
      if (open) g.entries.forEach(one);
    }
    entries.filter((e) => e.t === 'item' && status(b.byId.get(e.id)!) === 'unopposed').forEach(one);
  } else entries.forEach(one);
  return `<ol class="rows">${out.join('')}${unoppHTML(sec, unopp)}</ol>`;
}
function judgeToolsHTML(): string {
  const jr = judicialReview();
  const batch = judgeBatch();
  const k = 'jr-more';
  const parts: string[] = [];
  parts.push(headsHTML(headsUp('section:judicial')));
  if (jr && (jr.what_the_rating_means || jr.who_reviews)) {
    const more = [
      jr.how_judges_get_here ? `<p><b>How judges get on your ballot.</b> ${escP(jr.how_judges_get_here)}</p>` : '',
      jr.who_reviews && jr.what_the_rating_means ? `<p><b>Who reviews them.</b> ${escP(jr.who_reviews)}</p>` : '',
      jr.what_it_doesnt_mean ? `<p><b>What it doesn’t mean.</b> ${escP(jr.what_it_doesnt_mean)}</p>` : '',
      jr.to_keep_a_judge ? `<p><b>To keep a judge.</b> ${escP(jr.to_keep_a_judge)}</p>` : '',
      jr.history ? `<p><b>How often judges lose.</b> ${escP(jr.history)}</p>` : '',
      jr.read_one ? `<p>${ext(jr.read_one.url, jr.read_one.label)}</p>` : '',
      jr.sources.length ? `<p class="fine-src">Sources: ${jr.sources.map((x) => ext(x.url, x.name)).join(', ')}</p>` : '',
    ].join('');
    parts.push(`<div class="jr"><p>${escP(jr.what_the_rating_means || jr.who_reviews)} <button class="linkbtn" data-act="open" data-k="${k}" aria-expanded="${isOpen(k)}">${isOpen(k) ? 'Less' : 'More'}</button></p>${isOpen(k) ? `<div class="jr-more">${more}</div>` : ''}</div>`);
  }
  if (batch) {
    const n = batch.targets.length;
    parts.push(`<button class="retain-all" data-act="bulk" data-k="judges" data-fk="bulk-judges"><span>${esc(batch.label)} (${n})</span><small>Worded as the review’s rating, not ours. Undo is one tap.</small></button>`);
    if (batch.readFirst.length) {
      const list = batch.readFirst.slice(0, 6).map((x) => `<button class="linkbtn" data-act="goto" data-id="${esc(x.id)}">${esc(x.name)}</button> (${esc(x.why)})`).join(', ');
      parts.push(`<p class="readfirst">Read these first: ${list}${batch.readFirst.length > 6 ? `, and ${batch.readFirst.length - 6} more` : ''}.</p>`);
    }
  }
  const html = parts.join('');
  return html ? `<div class="sec-tools">${html}</div>` : '';
}
export function sectionHTML(sec: SectionKey, entries: Entry[]): string {
  const b = S.ballot!;
  const has = entries.some((e) => e.t !== 'item' || isDecision(status(b.byId.get(e.id)!)) || status(b.byId.get(e.id)!) === 'unopposed' || status(b.byId.get(e.id)!) === 'info');
  if (!entries.length || !has) return '';
  const folded = sectionFolded(sec, entries);
  const count = sectionCount(entries);
  const done = sectionDone(entries);
  if (folded && S.ui.onlyUndecided) return '';
  const title = sectionTitle(sec);
  const sub = folded ? foldSummary(entries) : sectionSub(sec);
  const tools = !folded && sec === 'judicial' ? judgeToolsHTML() : !folded ? `${headsUp(`section:${sec}`).length ? `<div class="sec-tools">${headsHTML(headsUp(`section:${sec}`))}</div>` : ''}` : '';
  return `<section class="sec${done ? ' done' : ''}${folded ? ' folded' : ''}" id="sec-${sec}" data-sec="${sec}" aria-labelledby="sh-${sec}">
    <h2 class="sec-h" id="sh-${sec}"><button class="sec-hd" data-act="sec" data-sec="${sec}" aria-expanded="${!folded}" data-fk="sec-${sec}">
      <span class="sec-l"><span class="sec-t">${esc(title)}</span>${sub ? `<span class="sec-sub">${esc(sub)}</span>` : ''}</span>
      <span class="sec-r"><span class="sec-count">${esc(count)}</span>${folded ? '<span class="sec-edit">Edit</span>' : ''}</span></button></h2>
    ${folded ? '' : `${tools}${rowsHTML(sec, entries)}`}
  </section>`;
}

/* ---------- the ballot head and its bulk actions ---------- */
function bulkHTML(): string {
  const agree = planAgree();
  const pf = S.b.party ? planParty(S.b.party) : null;
  const n = agree.fills.length;
  const agreeBtn = `<button class="act" data-act="bulk" data-k="agree" data-fk="bulk-agree" ${n ? '' : 'disabled'}><span>Use their picks where they agree</span><span class="n">${n}</span></button>`;
  const partyBtn = S.b.party
    ? `<button class="act" data-act="bulk" data-k="party" data-fk="bulk-party" ${pf && pf.fills.length ? '' : 'disabled'}><span>Fill in the ${esc(S.b.party)} candidates</span><span class="n">${pf ? pf.fills.length : 0}</span></button>`
    : `<button class="act" data-act="sheet" data-s="party" data-fk="bulk-party"><span>Fill in my party</span></button>`;
  return `<div class="pfm">${agreeBtn}${partyBtn}</div>`;
}
export function ballotHeadHTML(): string {
  const b = S.ballot!;
  const items = decisionItems();
  const qs = items.filter((i) => i.question).length;
  const may = [...b.mayApply].filter((id) => !S.b.notMine.includes(id)).length;
  const sb = sampleBallot();
  const statewideOnly = !b.places.length;
  const parts = [`${plural(items.length - qs, 'decision')}, in ballot order.`];
  if (qs) parts.push(`${plural(qs, 'question')} about where you live.`);
  if (may) parts.push(`${may} marked “may apply”.`);
  return `<div class="bhead"><h2 id="ballot-h">Your ballot</h2>
      <p>${esc(parts.join(' '))}</p>
      ${(b.groups.length || b.mayApply.size) ? (S.ui.addrOpen ? addrHTML() : '<p class="addr-cta"><button class="linkbtn" data-act="addr-open" data-fk="addr-open">Answer the “where do you live” questions from your address</button></p>') : ''}
      ${statewideOnly ? `<p class="statewide-note">We only have statewide races for your area so far. ${sb ? ext(sb.url, sb.label) : ''}</p>` : sb ? `<p class="sb">Double-check with ${ext(sb.url, 'your official sample ballot')}.</p>` : ''}
    </div>
    ${headsHTML(headsUp('ballot'))}
    ${bulkHTML()}`;
}
export function ballotHTML(): string {
  const by = entriesBySection();
  const secs = SECTIONS.map(([k]) => sectionHTML(k, by.get(k) || [])).join('');
  const empty = S.ui.onlyUndecided && !decisionItems().some((i) => !i.done)
    ? '<p class="empty"><b>Nothing left to decide here.</b> Turn off “Only undecided” to see everything, or open your cheat sheet.</p>' : '';
  return `${lensHTML()}<div class="wrap-led">${ballotHeadHTML()}</div><div class="ledger" aria-labelledby="ballot-h">${secs}${empty}</div>
    <div class="endcap wrap"><h3>That’s your whole ballot.</h3><p>Your picks save on this device as you go.</p>
      <button class="bigbtn" data-act="cheat" data-fk="endcap-cheat">Open your cheat sheet</button></div>`;
}

/* ---------- the bottom bar ---------- */
export function barHTML(): string {
  if (!S.ballot) return '';
  if (S.ui.view !== 'ballot') {
    return `<div class="foot screen-only" role="region" aria-label="Navigation"><div class="foot-in two">
      <button class="ftog" data-act="view" data-v="ballot" data-fk="bar-back">Back to ballot</button>
      ${S.ui.view === 'cheat' ? '<button class="fcta" data-act="view" data-v="pass" data-fk="bar-pass">Pass it on</button>' : '<button class="fcta" data-act="view" data-v="cheat" data-fk="bar-cheat">Cheat sheet</button>'}</div></div>`;
  }
  const items = decisionItems();
  const done = items.filter((i) => i.done).length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;
  const allDone = done === items.length;
  return `<div class="foot screen-only" role="region" aria-label="Your progress">
    <div class="bar" aria-hidden="true"><i style="width:${pct}%"></i></div>
    <div class="foot-in">
      <button class="prog" data-act="next" ${allDone ? 'disabled' : ''} data-fk="bar-next" aria-label="${allDone ? `All ${items.length} decided` : `${done} of ${items.length} decided. Go to the next undecided`}"><span class="bar-txt"><b>${done}</b> of ${items.length} <span class="dl">decided</span></span></button>
      <button class="ftog" data-act="only" aria-pressed="${S.ui.onlyUndecided}" data-fk="bar-only"><span class="box" aria-hidden="true"></span>Only undecided</button>
      <button class="fcta" data-act="cheat" data-fk="bar-cheat">Cheat sheet</button>
    </div></div>`;
}
export { sectionOf };
