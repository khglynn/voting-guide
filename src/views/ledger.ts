/* The ledger: your ballot as a calm list of rows in printed-ballot order, a verdict column down
   the right edge, section bands that fold when you're done, and the bottom bar.
   Test hooks (a contract with tests/e2e.mjs and tests/sweep.mjs; keep them):
     id="i-<item id>" + data-item on every item, data-undecided on undecided rows,
     data-q="<group key>" on district questions, data-act on every control,
     .sec[data-sec] with .sec-count, .unopp .disc for unopposed races, .bar-txt in the bar. */
import type { Contest, Item, PlaceBundle } from '../types';
import { S } from '../state';
import {
  SECTIONS, type SectionKey, type Entry, type Group, entriesBySection, status, isDecision, sectionOf, decisionItems, isMultiJudge, isMaybe,
  OTH_KEY, otherSchools, othOpen, unclaimed, pageWalk, contestDistrict,
} from '../ballot';
import { esc, hash, plural } from '../util';
import { rowTitle, measureTag, courtGroup, cleanOffice, optionLabel } from '../model/labels';
import { verdict, type Verdict } from '../model/tally';
import { canUndo } from '../model/bulk';
import { judgeBatch, judicialReview, judgesLead, judgesRule } from '../model/judges';
import { ext, sampleBallot, isOpen, escP, leadRest, reportURL, HIDE } from './common';
import { lensSummary } from './lens';
import { addrHTML } from './mast';
import { openHTML, censusSettles } from './open';

/* ---------- names ---------- */
export function countyName(p: PlaceBundle): string {
  if (p.county_label) return p.county_label;
  const names = p.counties.map((x) => x.replace(/\s*\([^)]*\)/g, '').replace(/\s+County$/i, '').trim()).filter(Boolean);
  if (!names.length) return 'County';
  // A city in more than one county names them all: "Travis, Williamson and Hays counties".
  if (names.length > 1) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} counties`;
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
    case 'special_district': return 'Other local districts';
    default: return 'Ballot measures';
  }
}
function sectionSub(sec: SectionKey): string {
  const b = S.ballot!;
  if (sec === 'judicial') {
    return judgesRule();
  }
  if ((sec === 'city' || sec === 'county' || sec === 'school' || sec === 'special_district') && b.places.length > 1) return `Some apply only in ${b.places.map((p) => p.label).join(' or ')}`;
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
  if (v.kind === 'none' && !v.main) return '<span class="vd none blank"></span>';
  const cls = `${v.kind === 'mine' ? 'done' : v.kind === 'review' ? `review ${v.tone || ''}` : v.kind}${v.shade ? ` ${v.shade}` : ''}`;
  const sub = v.sub;
  const label = v.kind === 'mine' ? 'Your pick: ' : v.kind === 'review' ? 'Official review: ' : v.kind === 'agree' ? (v.shade === 'one' ? 'Endorsed by one source: ' : 'Your sources agree: ') : v.kind === 'split' ? 'Your sources disagree: ' : '';
  // "Tucker 1" keeps its name and number together where it fits; the comma rides with the pair before it,
  // so a wrapped line never starts with one.
  const main = v.kind === 'split' ? v.main.split(', ').map((p, i, a) => `<span class="nw">${esc(p)}${i < a.length - 1 ? ',' : ''}</span>`).join(' ') : esc(v.main);
  return `<span class="vd ${cls}"><span class="m"><span class="vh">${label}</span>${main}</span>${sub ? `<span class="s">${esc(sub)}</span>` : ''}</span>`;
}
const qVerdict = (main: string, sub = ''): string => `<span class="vd q"><span class="m">${esc(main)}</span>${sub ? `<span class="s">${esc(sub)}</span>` : ''}</span>`;

/* ---------- rows ---------- */
function titleHTML(it: Item, tags = ''): string {
  const r = rowTitle(it);
  if (it.kind === 'measure') {
    // The number, then the measure's short name ("Park bonds"); a long summary is cut to a lead.
    const tag = measureTag(it);
    const name = it.short_title ? it.short_title : leadRest(r.sub || r.title, 40)[0];
    // A short title is a name, so it is never clipped; a summary lead still is.
    const named = it.short_title ? ' named' : '';
    if (tag && tag.length <= 4) return `<span class="ttl is-m"><span class="num">${esc(tag)}</span><span class="t"><span class="t-sum${named}">${esc(name)}</span>${tags}</span></span>`;
    const sub = it.short_title || (r.sub ? leadRest(r.sub, 40)[0] : '');
    return `<span class="ttl is-m-long"><span class="t"><b>${esc(r.title)}</b>${sub ? `<small class="t-sum${named}">${esc(sub)}</small>` : ''}${tags}</span></span>`;
  }
  return `<span class="ttl"><span class="t"><b>${esc(r.title)}</b>${r.sub ? `<small>${esc(r.sub)}</small>` : ''}${tags}</span></span>`;
}
/* The chevron column: a row opens and closes in place. */
const CHEV = '<span class="cv" aria-hidden="true"><svg class="chev" viewBox="0 0 14 14"><path d="M2 5l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></span>';
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
  else if (isMaybe(it.id)) tags.push('Maybe on your ballot');
  const cls = ['row', decided ? 'is-done' : '', open ? 'is-open' : '', s === 'info' ? 'is-info' : '', S.ui.keep === it.id ? 'just' : ''].filter(Boolean).join(' ');
  return `<li class="${cls}" id="i-${esc(it.id)}" data-item="${esc(it.id)}"${s === 'open' ? ' data-undecided' : ''}>
    <button class="row-hd" data-act="row" data-id="${esc(it.id)}" aria-expanded="${open}" data-fk="row-${esc(it.id)}">
      <span class="mk" aria-hidden="true"><i></i></span>${titleHTML(it, tags.length ? `<span class="tags">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</span>` : '')}${vd}${CHEV}</button>
    ${open ? openHTML(it) : ''}
  </li>`;
}
export const qId = (g: Group): string => `q-${hash(g.key)}`;
function questionHTML(g: Group): string {
  const open = S.ui.row === `q:${g.key}`;
  return `<li class="row is-q${open ? ' is-open' : ''}" id="${qId(g)}" data-q="${esc(g.key)}" data-undecided>
    <button class="row-hd" data-act="row" data-id="${esc(`q:${g.key}`)}" aria-expanded="${open}" data-fk="row-${qId(g)}">
      <span class="mk" aria-hidden="true"><i></i></span><span class="ttl"><span class="t"><b>${esc(cleanOffice(g.office))}</b><small>Depends on your address</small></span></span>
      ${qVerdict('Pick your district')}${CHEV}</button>
    ${open ? questionBodyHTML(g) : ''}
  </li>`;
}
/* Every district finder that matches this office, across the ballot's places, once per link:
   a place in three counties (Austin) needs each county's page. */
export function findersFor(g: Group): { label: string; url: string }[] {
  const b = S.ballot!;
  const out: { label: string; url: string }[] = [];
  const office = g.office.toLowerCase();
  for (const p of b.places) for (const f of p.district_finders || []) {
    if (office.includes(f.office_match.toLowerCase()) && !out.some((x) => x.url === f.url)) out.push(f);
  }
  return out;
}
/* The district a question's races all belong to, when its office names one a voter may live
   outside of entirely: a school district ("Del Valle ISD Trustee") or a utility district. Null for
   offices every voter here has one of (U.S. Representative, City Council). */
const ENTITY = /([A-Z][\w.'’-]*(?:\s+[A-Z][\w.'’-]*)*?\s+(?:C?ISD|Independent School District|Unified School District|Union High School District|School District|Community College District|People['’]s Utility District))\b/;
export function districtEntity(office: string): string | null {
  const m = office.match(ENTITY);
  return m ? m[1].trim() : null;
}
/* The question's last answer: none of its districts is yours. */
export const noneLabel = (g: Group): string => {
  const e = districtEntity(g.office);
  return e ? `I’m not in ${e}` : 'Not in any of these';
};
function questionBodyHTML(g: Group): string {
  const b = S.ballot!;
  // The count is the whole place's, not your ZIP's: say so ("Houston has 24 of these").
  const where = () => (b.places.length === 1 ? b.places[0].label.replace(/\s*\(.*\)$/, '') : b.places.length ? 'Your area' : b.stateName);
  // In number order, as a sample ballot lists them (the data keeps its own order: 10, 11, 27, 37, 31).
  const num = (c: Contest) => contestDistrict(c).n ?? Infinity;
  const members = g.members.map((id) => b.byId.get(id) as Contest).sort((x, y) => num(x) - num(y));
  const finders = findersFor(g);
  const sb = sampleBallot();
  return `<div class="ob dq">
    <h3 class="dq-h">Pick your ${esc(cleanOffice(g.office))} district</h3>
    <p class="ob-lede">${esc(where())} has ${members.length} of these districts. Your sample ballot lists yours.</p>
    <div class="opts">${censusSettles(members[0]) && !S.b.addrNote ? '<button class="opt opt-addr" data-act="addr-open" data-fk="dq-addr"><b>Use my address</b><small>The Census lookup finds it for you</small></button>' : ''}${members.map((c) => { const [l, sub] = optionLabel(c); return `<button class="opt" data-act="district" data-g="${esc(g.key)}" data-v="${esc(c.id)}" data-fk="d-${esc(c.id)}"><b>${esc(l)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</button>`; }).join('')}
      <button class="opt opt-unsure" data-act="district" data-g="${esc(g.key)}" data-v="*" data-fk="d-${hash(g.key)}-x"><b>Not sure? Skip for now</b><small>Show all ${members.length}, each marked “Maybe on your ballot”</small></button>
      <button class="opt opt-unsure" data-act="district" data-g="${esc(g.key)}" data-v="none" data-fk="d-${hash(g.key)}-n"><b>${esc(noneLabel(g))}</b></button></div>
    <p class="dq-help">${[...finders.map((f) => ext(f.url, f.label)), sb ? ext(sb.url, sb.label) : ''].filter(Boolean).join('<span class="dot" aria-hidden="true"> · </span>')}</p>
  </div>`;
}
function glineHTML(g: Group): string {
  const b = S.ballot!;
  const ans = S.b.districts[g.key];
  // "none": you said none of them is yours, or your address matched none of them.
  const v = ans === '*' ? `showing all ${g.members.length} districts` : ans === 'none' ? 'Not on your ballot' : (() => { const c = b.byId.get(ans) as Contest | undefined; return c ? optionLabel(c)[0] : ''; })();
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
      return `<li id="i-${esc(c.id)}" data-item="${esc(c.id)}"><span class="u-t">${esc(r.title)}${r.sub ? `, ${esc(r.sub)}` : ''}</span> <b>${esc(k1.name)}</b>${k1.party ? ` <span class="py">${esc(k1.party)}</span>` : ''}${b.mayApply.has(c.id) ? ' <span class="tag">Maybe on your ballot</span>' : ''}</li>`;
    }).join('')}</ul>` : ''}</li>`;
}

/* ---------- sections ---------- */
/* A band's "N of M decided", by the one counting rule (ballot.ts): a district question is one race
   until it's answered, and an unclaimed race in the closed "Other school districts" fold isn't one. */
export function sectionTally(entries: Entry[]): { done: number; total: number; unopp: number } {
  const b = S.ballot!;
  const shut = unclaimed();
  let done = 0, total = 0, unopp = 0;
  for (const e of entries) {
    if (e.t === 'question') { total++; continue; }
    if (e.t !== 'item') continue;
    const s = status(b.byId.get(e.id)!);
    if (s === 'unopposed') { unopp++; continue; }
    if (!isDecision(s) || shut.has(e.id)) continue;
    total++;
    if (s !== 'open') done++;
  }
  return { done, total, unopp };
}
export function sectionCount(entries: Entry[]): string {
  const { done, total, unopp } = sectionTally(entries);
  return total ? `${done} of ${total} decided` : unopp ? 'Nothing to decide' : '';
}
/* Done: something decided and nothing left by the count. */
function sectionDone(entries: Entry[]): boolean {
  const { done, total } = sectionTally(entries);
  return total > 0 && done === total;
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
  // The summary starts with a capital: "Keep 2, remove 1", or "Remove 1" when nothing is kept.
  if (keep || remove) bits.unshift([keep ? `Keep ${keep}` : '', remove ? `${keep ? 'remove' : 'Remove'} ${remove}` : ''].filter(Boolean).join(', '));
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
/* "Hide races I've decided" hides a row once it is decided, except the one you just decided (kept
   until your next move) and the open one. render.ts uses the same rule for one-row repaints. */
export const hiddenByOnly = (e: Entry): boolean => {
  if (!S.b.hideDecided) return false;
  if (e.t === 'question') return false;
  if (e.t !== 'item') return true;
  if (e.id === S.ui.keep || e.id === S.ui.row) return false;
  return status(S.ballot!.byId.get(e.id)!) !== 'open';
};
/* The fold helpers live with the counting rule in ballot.ts; the cheat sheet and tests read them here too. */
export { OTH_KEY, otherSchools, othOpen };
/* Every choice and district question in the order the page draws them, for "Next": see pageWalk. */
export function pageOrder(): { key: string; done: boolean; folded?: boolean }[] {
  return pageWalk().map((x) => ({ key: x.key, done: x.done, ...(x.folded ? { folded: true } : {}) }));
}
/* "Klein ISD" from "Klein ISD Trustee, Position 6": the district's own name, for the fold line. */
const districtName = (c: Contest): string => {
  const m = c.office.match(/^(.*?\b(?:ISD|CISD|School District|Unified|Public Schools|Schools))\b/i);
  return (m ? m[1] : c.office.replace(/\s+(Board of Trustees|Trustee|Board Member|School Board).*$/i, '')).trim();
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
        // The district's name, with its own scope note under it when it covers only part of the
        // place ("northwest Harris County, including part of northwest Houston").
        const note = b.mayApply.has(it.id) ? (it.jurisdiction.match(/\(([^)]*)\)/) || [])[1] : '';
        out.push(`<li class="subhd">${esc(it.jurisdiction.replace(/\s*\([^)]*\)/g, ''))}${note ? `<small>${esc(note.charAt(0).toUpperCase() + note.slice(1))}</small>` : ''}</li>`);
      }
    }
    if (hiddenByOnly(e)) return;
    out.push(entryHTML(e));
  };
  // Other school districts' races (Round Rock, Pflugerville and Leander ISD seats on an East
  // Austin ballot) fold into one row where the first of them would be; open, they list there.
  if (sec === 'school') {
    const oth = otherSchools(entries);
    if (oth.length) {
      const k = OTH_KEY;
      const open = othOpen(oth);
      const names = [...new Set(oth.map((e) => districtName(b.byId.get((e as { id: string }).id) as Contest)))];
      const live = oth.filter((e) => e.t === 'item');
      const city = b.places.length === 1 ? b.places[0].label.replace(/\s*\(.*\)$/, '') : 'your area';
      let placed = false;
      entries.forEach((e) => {
        if (!oth.includes(e)) { one(e); return; }
        if (!placed) {
          placed = true;
          const decided = live.filter((x) => x.t === 'item' && status(b.byId.get(x.id)!) !== 'open').length;
          const ct = !live.length ? 'none on your ballot' : decided ? `${decided} of ${live.length} decided` : plural(live.length, 'race');
          out.push(`<li class="grp oth"><button class="grp-hd" data-act="grp" data-g="${k}" aria-expanded="${open}" data-fk="g-oth"><span class="grp-t">Other school districts that touch ${esc(city)}<small>${esc(names.join(', '))}. Open only if one of them is yours.</small></span><span class="grp-ct">${esc(ct)}</span></button></li>`);
          if (open && live.length) out.push(`<li class="oth-none"><button class="mini quiet" data-act="notmine-oth" data-fk="oth-none">None of these are on my ballot</button></li>`);
        }
        if (open && !hiddenByOnly(e)) out.push(entryHTML(e).replace('<li class="row', '<li data-fold="oth" class="row'));
      });
      return `<ol class="rows">${out.join('')}${unoppHTML(sec, unopp)}</ol>`;
    }
  }
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
  // The plain answer first, the process and any section notes one tap away (the notes repeated
  // the rule on the band and the paragraph under it).
  const lead = judgesLead();
  if (jr && (lead || jr.what_the_rating_means || jr.who_reviews)) {
    const more = [
      headsHTML(headsUp('section:judicial')),
      jr.what_the_rating_means && lead ? `<p><b>What the rating means.</b> ${escP(jr.what_the_rating_means)}</p>` : '',
      jr.how_judges_get_here ? `<p><b>How judges get on your ballot.</b> ${escP(jr.how_judges_get_here)}</p>` : '',
      jr.who_reviews && jr.what_the_rating_means ? `<p><b>Who reviews them.</b> ${escP(jr.who_reviews)}</p>` : '',
      jr.what_it_doesnt_mean ? `<p><b>What it doesn’t mean.</b> ${escP(jr.what_it_doesnt_mean)}</p>` : '',
      jr.to_keep_a_judge ? `<p><b>To keep a judge.</b> ${escP(jr.to_keep_a_judge)}</p>` : '',
      jr.history ? `<p><b>How often judges lose.</b> ${escP(jr.history)}</p>` : '',
      jr.read_one ? `<p>${ext(jr.read_one.url, jr.read_one.label)}</p>` : '',
      jr.sources.length ? `<p class="fine-src">Sources: ${jr.sources.map((x) => ext(x.url, x.name)).join(', ')}</p>` : '',
    ].join('');
    parts.push(`<div class="jr"><p>${escP(lead || jr.what_the_rating_means || jr.who_reviews)} <button class="linkbtn" data-act="open" data-k="${k}" aria-expanded="${isOpen(k)}">${isOpen(k) ? 'Hide' : 'About judge reviews'}</button></p>${isOpen(k) ? `<div class="jr-more">${more}</div>` : ''}</div>`);
  } else if (headsUp('section:judicial').length) {
    parts.push(headsHTML(headsUp('section:judicial')));
  }
  if (batch) {
    const n = batch.targets.length;
    parts.push(`<button class="retain-all" data-act="bulk" data-k="judges" data-fk="bulk-judges" data-n="${n}"><span>${esc(batch.label)}</span><small>That’s the review’s call, not ours. You can undo it.</small></button>`);
    if (batch.readFirst.length) {
      // Grouped by reason, last names only: "The review noted a concern for Harris, Contiguglia
      // and 2 more." Each name jumps to the judge.
      const last = (name: string) => name.replace(/,?\s+(Jr\.|Sr\.|II|III|IV)$/, '').split(/\s+/).pop() || name;
      const by = new Map<string, { id: string; name: string }[]>();
      batch.readFirst.forEach((x) => { by.set(x.why, [...(by.get(x.why) || []), x]); });
      const lines = [...by].map(([why, list]) => {
        const shown = list.slice(0, 6).map((x) => `<button class="linkbtn" data-act="goto" data-id="${esc(x.id)}">${esc(last(x.name))}</button>`);
        // The last name and its period stay on one line, so a wrap never strands the period.
        const tail = `<span style="white-space:nowrap">${shown[shown.length - 1]}${list.length > 6 ? ` and ${list.length - 6} more` : ''}.</span>`;
        const names = shown.length > 1 ? `${shown.slice(0, -1).join(', ')}${list.length > 6 ? ', ' : ' and '}${tail}` : tail;
        return `${esc(why.charAt(0).toUpperCase() + why.slice(1))}: ${names}`;
      });
      parts.push(`<p class="readfirst"><b>Read these first.</b> ${lines.join(' ')}</p>`);
    }
  }
  const html = parts.join('');
  return html ? `<div class="sec-tools">${html}</div>` : '';
}
/* When none of your sources cover any open race in a section (three or more), say it once here
   instead of on every row. */
function quietNoteHTML(entries: Entry[]): string {
  const b = S.ballot!;
  const open = entries.filter((e) => e.t === 'item').map((e) => b.byId.get((e as { id: string }).id)!).filter((it) => status(it) === 'open' && !(it.kind === 'contest' && it.is_retention));
  if (open.length < 3 || !open.every((it) => { const v = verdict(it); return v.kind === 'none' && v.why === 'no_cover'; })) return '';
  const m = open.every((it) => it.kind === 'measure');
  return `<p class="sec-note">Your sources made no endorsements in these ${m ? 'measures' : 'races'}. Open one to ${m ? 'read both sides' : 'compare the candidates in their own words'}, or <button class="linkbtn" data-act="sheet" data-s="sources" data-fk="sec-more">add sources</button>.</p>`;
}
/* A section shows on the page when it has anything to show: a question, a choice, an unopposed
   race or an information row. (Under "Hide races I've decided" a finished one hides; the menu still
   lists it, as "Done".) */
export function sectionShows(entries: Entry[]): boolean {
  const b = S.ballot!;
  return entries.some((e) => { if (e.t !== 'item') return true; const s = status(b.byId.get(e.id)!); return isDecision(s) || s === 'unopposed' || s === 'info'; });
}
export function sectionHTML(sec: SectionKey, entries: Entry[]): string {
  if (!entries.length || !sectionShows(entries)) return '';
  const folded = sectionFolded(sec, entries);
  const count = sectionCount(entries);
  const done = sectionDone(entries);
  if (folded && S.b.hideDecided) return '';
  const title = sectionTitle(sec);
  const sub = folded ? foldSummary(entries) : sectionSub(sec);
  const tools = !folded && sec === 'judicial' ? judgeToolsHTML() : !folded ? `${headsUp(`section:${sec}`).length ? `<div class="sec-tools">${headsHTML(headsUp(`section:${sec}`))}</div>` : ''}${quietNoteHTML(entries)}` : '';
  return `<section class="sec${done ? ' done' : ''}${folded ? ' folded' : ''}" id="sec-${sec}" data-sec="${sec}" aria-labelledby="sh-${sec}">
    <h2 class="sec-h" id="sh-${sec}"><button class="sec-hd" data-act="sec" data-sec="${sec}" aria-expanded="${!folded}" data-fk="sec-${sec}">
      <span class="sec-l"><span class="sec-t">${esc(title)}</span>${sub ? `<span class="sec-sub">${esc(sub)}</span>` : ''}</span>
      <span class="sec-r"><span class="sec-count">${esc(count)}</span>${folded ? '<span class="sec-edit">Show</span>' : ''}</span></button></h2>
    ${folded ? '' : `${tools}${rowsHTML(sec, entries)}`}
  </section>`;
}

/* ---------- the ballot head ----------
   Whose picks you see, in one line with Edit (the sheet holds step 2's controls); after a fill
   from your sources, how many it filled and Undo, while that Undo lasts; then, while some races
   depend on your address, how many, with the address lookup and your sample ballot. */
/* Races that depend on your address: each district question still to answer, each one answered
   "Not sure", and each other row tagged "Maybe on your ballot" that the count includes. */
export function addressCount(): number {
  const b = S.ballot!;
  const groups = new Set<string>();
  let n = 0;
  for (const x of decisionItems()) {
    if (x.question) { n++; continue; }
    if (!isMaybe(x.id)) continue;
    const g = b.groupOf[x.id];
    if (!g) n++;
    else if (!groups.has(g)) { groups.add(g); n++; }
  }
  return n;
}
/* Whether "Use my address" can still settle one of them. The Census answers Congress and the
   state legislature only (open.censusSettles), so a question or "maybe" row for anything else
   (a council seat, a school district, a judge) is the sample ballot's to settle. And once a
   lookup has run on this ballot (its addrNote), it has answered all it can. */
export function addressHelps(): boolean {
  const b = S.ballot!;
  if (S.b.addrNote) return false;
  return decisionItems().some((x) => {
    if (x.question) {
      const g = b.groups.find((gr) => `q:${gr.key}` === x.id);
      return !!g && censusSettles(b.byId.get(g.members[0]) as Contest);
    }
    if (!isMaybe(x.id)) return false;
    const it = b.byId.get(x.id);
    return !!it && it.kind === 'contest' && censusSettles(it);
  });
}
export function ballotHeadHTML(): string {
  const b = S.ballot!;
  const sb = sampleBallot();
  const statewideOnly = !b.places.length;
  const n = addressCount();
  const filled = S.ui.bulk && canUndo()
    ? `<p class="filled">${esc(S.ui.bulk)} filled in. <button class="linkbtn" data-act="undo-bulk" data-fk="filled-undo">Undo</button></p>` : '';
  // "Use my address" leads while the lookup can settle something; after that, the sample ballot.
  const look = n > 0 && addressHelps();
  const addr = n ? `<div class="addrbox"><p><b>${n === 1 ? '1 race depends' : `${n} races depend`} on your address.</b></p>
      ${S.ui.addrOpen ? addrHTML() : `<div class="row-btns">${look ? '<button class="mini dark" data-act="addr-open" data-fk="addr-open">Use my address</button>' : ''}${sb ? `<a class="mini${look ? '' : ' dark'}" href="${esc(sb.url)}" target="_blank" rel="noopener">See my sample ballot</a>` : ''}</div>`}</div>` : '';
  return `<div class="bhead"><h2 class="step su-h bal-h" id="ballot-h"><span class="step-n" aria-hidden="true">3</span>Your ballot</h2>
      <p class="picks-line"><span>Picks: ${esc(lensSummary())}</span><button class="mini" data-act="picks" data-fk="picks-edit">Edit</button></p>
      ${filled}${addr}
      ${statewideOnly ? `<div class="statewide-note"><p>We only have statewide races for your area so far.</p>
        <p class="row-btns">${sb ? `<a class="mini dark" href="${esc(sb.url)}" target="_blank" rel="noopener">See my sample ballot</a>` : ''}<a class="mini" href="${esc(reportURL('Please add my city'))}" target="_blank" rel="noopener">Ask for your city</a></p></div>` : ''}
    </div>
    ${headsHTML(headsUp('ballot'))}`;
}
export function ballotHTML(): string {
  const by = entriesBySection();
  const secs = SECTIONS.map(([k]) => sectionHTML(k, by.get(k) || [])).join('');
  const empty = S.b.hideDecided && !decisionItems().some((i) => !i.done)
    ? `<p class="empty"><b>Nothing left to decide here.</b> Turn off “${HIDE}” to see everything.</p>` : '';
  return `<div class="wrap-led">${ballotHeadHTML()}</div><div class="ledger" aria-labelledby="ballot-h">${secs}${empty}</div>
    <div class="endcap wrap"><h3>That’s your whole ballot.</h3><p>Next, save your plan.</p>
      <button class="bigbtn" data-act="cheat" data-fk="endcap-cheat">Open my plan</button></div>`;
}

/* ---------- the bottom bar ----------
   On the ballot, two buttons: the menu ("☰ 20 of 43", whose .bar-txt reads "20 of 43 decided") and
   My plan (the cheat sheet). From 1180px the menu also stands as a rail in the left margin, drawn
   here so it repaints with the bar after every pick. */
const BURGER = '<svg class="burger" viewBox="0 0 18 14" aria-hidden="true" focusable="false"><path d="M1 1.5h16M1 7h16M1 12.5h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
export const RAIL_AT = '(min-width: 1180px)';
const wide = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(RAIL_AT).matches;
export function barHTML(): string {
  if (!S.ballot) return '';
  if (S.ui.view !== 'ballot') {
    return `<div class="foot screen-only" role="region" aria-label="Navigation"><div class="foot-in two">
      <button class="ftog" data-act="view" data-v="ballot" data-fk="bar-back">Back to the ballot</button>
      ${S.ui.view === 'cheat' ? '<button class="fcta" data-act="view" data-v="pass" data-fk="bar-pass">Help friends vote</button>' : '<button class="fcta" data-act="view" data-v="cheat" data-fk="bar-cheat">My plan</button>'}</div></div>`;
  }
  // The one counting rule (ballot.ts): a district question is one race until it's answered.
  const items = decisionItems();
  const done = items.filter((i) => i.done).length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;
  const rail = wide() ? `<nav class="rail screen-only" aria-label="Your ballot" data-keep="rail">${menuHTML('rail')}</nav>` : '';
  return `${rail}<div class="foot screen-only" role="region" aria-label="Your progress">
    <div class="bar" aria-hidden="true"><i style="width:${pct}%"></i></div>
    <div class="foot-in ends">
      <button class="menu-btn" data-act="toc" aria-haspopup="dialog" data-fk="bar-menu">${BURGER}<span class="bar-txt"><b>${done}</b> of ${items.length}<span class="vh"> decided</span></span></button>
      <button class="fcta" data-act="cheat" data-fk="bar-cheat">My plan</button>
    </div></div>`;
}

/* ---------- the menu: a sheet under 1180px, a rail from there ----------
   "Next up" first, then rows that go somewhere: your next step, Quick picks (the Edit sheet), the
   "Hide races I've decided" switch right above the sections it filters, each section on the page
   with what's left, My plan, and last, ruled off, "How this guide works". */
/* The next undecided race or question after the one you're on (open, or just decided), in page
   order, wrapping to the first; null when nothing the count includes is left. The menu names it
   and its button opens it, so the two never disagree. */
export function nextUp(): { key: string; title: string } | null {
  const b = S.ballot!;
  const order = pageWalk().filter((x) => !x.folded);
  const left = order.filter((x) => !x.done);
  if (!left.length) return null;
  const from = S.ui.row || S.ui.keep;
  const at = from ? order.findIndex((x) => x.key === from) : -1;
  const pick = order.find((x, i) => i > at && !x.done) || left.find((x) => x.key !== S.ui.row) || left[0];
  const g = pick.key.startsWith('q:') ? b.groups.find((x) => `q:${x.key}` === pick.key) : null;
  return { key: pick.key, title: g ? cleanOffice(g.office) : rowTitle(b.byId.get(pick.key)!).title };
}
const ARROW = '<i class="nv-a" aria-hidden="true">›</i>';
export function menuHTML(where: 'toc' | 'rail'): string {
  const by = entriesBySection();
  const up = nextUp();
  const next = up ? `<button class="nv-next" data-act="next" data-k="${esc(up.key)}" data-fk="${where}-next"><span>Next up: ${esc(up.title)}</span>${ARROW}</button>` : '';
  const only = `<button class="su-sw nv-sw" role="switch" aria-checked="${S.b.hideDecided}" data-act="only" data-fk="${where}-only"><span class="su-l"><b>${HIDE}</b></span><span class="tg" aria-hidden="true"><span></span></span></button>`;
  const row = (attrs: string, fk: string, label: string, right = '', cls = '') =>
    `<li><button class="nv${cls}" ${attrs} data-fk="${where}-${fk}"><span class="nv-t">${esc(label)}</span><span class="nv-n">${esc(right)}</span>${ARROW}</button></li>`;
  const secs = SECTIONS.map(([k]) => {
    const entries = by.get(k) || [];
    if (!entries.length || !sectionShows(entries)) return '';
    const t = sectionTally(entries);
    return row(`data-act="jump" data-to="${k}"`, k, sectionTitle(k), !t.total ? '' : t.done === t.total ? 'Done' : `${t.total - t.done} left`);
  }).join('');
  return `${next}<ul class="nv-list">
    ${row('data-act="jump" data-to="plan"', 'plan', 'Your next step')}
    ${row('data-act="picks"', 'picks', 'Quick picks')}</ul>
    ${only}<ul class="nv-list nv-secs">
    ${secs}
    ${row('data-act="cheat"', 'cheat', 'My plan', '', ' nv-plan')}</ul>
    <ul class="nv-list nv-end">${row('data-act="jump" data-to="how"', 'how', 'How this guide works', '', ' nv-how')}</ul>`;
}
export function tocSheetHTML(): string {
  return `<div class="scrim screen-only" data-act="sheet-close"></div>
  <div class="sheet-panel screen-only toc" role="dialog" aria-modal="true" aria-labelledby="sh-h">
    <div class="sheet-hd"><h2 id="sh-h">Your ballot</h2><button class="closebtn" data-act="sheet-close" data-fk="sheet-x">Close</button></div>
    <div class="sheet-bd" data-keep="toc">${menuHTML('toc')}</div></div>`;
}
export { sectionOf };
