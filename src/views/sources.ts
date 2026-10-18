/* Sources: one line on the page. The picker lives in the Filter shelf, and the
   side-by-side grid opens inside the shelf from there. */
import type { Contest, Endorser, Item } from '../types';
import { S } from '../state';
import { chosen, chosenIds, endorsement, entriesBySection, status, isDecision, shortTitle, isMultiJudge, isMultiSeat, isRCV, filterCands, myChoices } from '../ballot';
import { esc, plural } from '../util';
import { leanHTML, isOpen, ext, choiceWord, deshout } from './common';

const CHOICE_VALUES = ['YES', 'NO', 'FOR', 'AGAINST'];

const TYPE_WORD: Record<string, string> = {
  publication: 'Publication', civic_nonpartisan: 'Nonpartisan group', party: 'Political party', advocacy: 'Advocacy group',
  labor: 'Labor group', business: 'Business group', elected_official: 'Elected official', other: 'Other',
};
const GROUPS: [string, string][] = [['left', 'Left'], ['lean_left', 'Lean left'], ['neutral', 'No lean'], ['lean_right', 'Lean right'], ['right', 'Right'], ['none', 'Not rated']];

function countOnBallot(e: Endorser): number {
  const b = S.ballot!;
  let n = 0;
  for (const id of b.order) if (b.ends[id] && b.ends[id][e.id] && b.ends[id][e.id].s === 'endorsed') n++;
  return n;
}

function rowHTML(e: Endorser): string {
  const on = chosenIds().includes(e.id);
  const k = `lean-${e.id}`;
  const scope = e.endorses_candidates && e.endorses_measures ? 'Races and measures' : e.endorses_candidates ? 'Races' : e.endorses_measures ? 'Measures' : '';
  const n = countOnBallot(e);
  return `<div class="src-row">
    <div class="stack-xs"><span class="src-name" id="sn-${esc(e.id)}">${esc(e.name)}</span>
      <span class="src-desc">${esc(TYPE_WORD[e.type] || e.type)}${scope ? `. ${scope}` : ''}. Picks on ${plural(n, 'item')} here.</span></div>
    <button class="tg" role="switch" aria-checked="${on}" aria-labelledby="sn-${esc(e.id)}" data-act="src" data-id="${esc(e.id)}" data-fk="tg-${esc(e.id)}"><span></span></button>
    <div class="src-meta">${leanHTML(e.lean)}
      <button class="btn-text btn btn-xs" data-act="open" data-k="${esc(k)}" aria-expanded="${isOpen(k)}">How we rate this</button></div>
    ${isOpen(k) ? `<p class="disclose">${esc(e.lean_basis || 'No rating basis recorded.')}${e.lean_note ? ` <strong>${esc(e.lean_note)}</strong>` : ''}${e.guide_url ? ` ${ext(e.guide_url, 'Their guide')}` : ''}</p>` : ''}
  </div>`;
}

function pickerHTML(): string {
  const b = S.ballot!;
  const byCount = (a: Endorser, c: Endorser) => countOnBallot(c) - countOnBallot(a) || a.name.localeCompare(c.name);
  const defaults = b.endorsers.filter((e) => e.default_on).sort(byCount);
  const optIn = b.endorsers.filter((e) => !e.default_on);
  const groups = GROUPS.map(([lean, word]) => {
    const list = optIn.filter((e) => (e.lean || 'none') === lean).sort(byCount);
    if (!list.length) return '';
    const k = `srcg-${lean}`;
    const onN = list.filter((e) => chosenIds().includes(e.id)).length;
    return `<div class="src-group"><button class="disc" data-act="open" data-k="${k}" aria-expanded="${isOpen(k)}" data-fk="${k}">
        <span class="row">${lean === 'none' ? '' : leanHTML(lean as Endorser['lean'], false)} ${esc(word)}: ${plural(list.length, 'source')}${onN ? `, ${onN} on` : ''}</span></button>
      ${isOpen(k) ? list.map(rowHTML).join('') : ''}</div>`;
  }).join('');
  return `<div class="picker">
    <h4 class="kicker src-hd">On by default: publications and nonpartisan groups</h4>
    ${defaults.length ? defaults.map(rowHTML).join('') : '<p class="small muted">None for this ballot.</p>'}
    <h4 class="kicker src-hd">Opt in: parties and advocacy groups, by lean</h4>
    ${groups || '<p class="small muted">None for this ballot.</p>'}
  </div>`;
}

/* ---------- the grid ---------- */
function cellHTML(it: Item, e: Endorser): string {
  const en = endorsement(it.id, e.id);
  if (!en) {
    // A source that never makes this kind of pick (LWV on candidates, newsrooms that don't endorse) is a known "no stand", not a gap.
    const picksThis = it.kind === 'measure' ? e.endorses_measures : e.endorses_candidates;
    if (!picksThis) return `<td class="cell np" title="${it.kind === 'measure' ? 'Doesn’t take positions on measures' : 'Doesn’t endorse candidates'}">no stand</td>`;
    return '<td class="cell uc" title="Not checked yet">?</td>';
  }
  if (en.s === 'no_position') return '<td class="cell np">no stand</td>';
  if (en.s === 'not_found') return '<td class="cell nf"><span>none found</span></td>';
  let label = 'Endorsed';
  if (en.both) label = 'Both';
  else if (en.c && en.c.length) {
    label = en.c.map((x) => {
      if (CHOICE_VALUES.includes(x)) return choiceWord(x);
      const c = it.kind === 'contest' ? it.candidates.find((k) => k.name === x) : null;
      return c ? c.short : x;
    }).join(' + ');
  } else if (en.note) { const n = deshout(en.note); label = n.length > 14 ? `${n.slice(0, 12)}...` : n; }
  const mine = myChoices(it);
  const match = !!en.c && mine.some((x) => en.c!.includes(x));
  return `<td class="cell en ${match ? 'match' : ''}">${esc(label)}${match ? '<span class="vh"> (matches your pick)</span>' : ''}${en.conf === 'unverified' ? '<span class="unv">unconfirmed</span>' : ''}</td>`;
}
function pickCellHTML(it: Item): string {
  const p = S.b.picks[it.id];
  if (it.kind === 'contest' && (isMultiJudge(it) || isMultiSeat(it) || isRCV(it))) return `<td class="pickcell"><button class="btn-text btn btn-xs" data-act="jump" data-id="${esc(it.id)}">Open race</button></td>`;
  if (it.kind === 'measure' || (it.kind === 'contest' && it.is_retention)) {
    return `<td class="pickcell"><div class="yn-inline" role="group" aria-label="Your pick for ${esc(shortTitle(it))}">
      <button data-act="pick" data-id="${esc(it.id)}" data-v="YES" aria-pressed="${p === 'YES'}" data-fk="g-${esc(it.id)}-y">Yes</button>
      <button data-act="pick" data-id="${esc(it.id)}" data-v="NO" aria-pressed="${p === 'NO'}" data-fk="g-${esc(it.id)}-n">No</button></div></td>`;
  }
  const c = it as Contest;
  const shown = filterCands(c).shown;
  const opts = (shown.length ? shown : c.candidates);
  return `<td class="pickcell"><label class="vh" for="sel-${esc(it.id)}">Your pick for ${esc(shortTitle(it))}</label>
    <select id="sel-${esc(it.id)}" data-pick-item="${esc(it.id)}" data-fk="sel-${esc(it.id)}">
      <option value="">Undecided</option>
      ${opts.map((k) => `<option value="${esc(k.name)}" ${p === k.name ? 'selected' : ''}>${esc(k.short)}${k.party ? ` (${esc(k.party)})` : ''}</option>`).join('')}
      <option value="SKIP" ${p === 'SKIP' ? 'selected' : ''}>Skip</option></select></td>`;
}
export function gridRows(): Item[] {
  const b = S.ballot!;
  const out: Item[] = [];
  for (const [, entries] of entriesBySection()) {
    for (const e of entries) {
      if (e.t !== 'item') continue;
      const it = b.byId.get(e.id)!;
      if (isDecision(status(it))) out.push(it);
    }
  }
  return out;
}
function gridHTML(): string {
  const cols = chosen();
  if (!cols.length) return '<p class="empty-src">Go back and turn on a source to fill the grid.</p>';
  const rows = gridRows();
  const head = `<thead><tr><th scope="col" class="rowhd">Ballot item</th>${cols.map((e) => `<th scope="col"><span class="th-name">${esc(e.short)}</span>${leanHTML(e.lean, false)}</th>`).join('')}<th scope="col" class="pickcell">Your pick</th></tr></thead>`;
  const body = rows.map((it) => `<tr><th scope="row" class="rowhd"><button class="rowbtn" data-act="jump" data-id="${esc(it.id)}"><span class="t">${esc(shortTitle(it))}</span></button></th>${cols.map((e) => cellHTML(it, e)).join('')}${pickCellHTML(it)}</tr>`).join('');
  return `<div class="grid-legend lim"><span><i class="sw match"></i>Matches your pick</span><span>no stand: they don’t weigh in</span><span>none found: we looked</span><span>?: not checked yet</span></div>
    <div class="grid-wrap" data-keep="grid" tabindex="0" role="region" aria-label="Your sources side by side. Scrolls sideways."><table class="sheet">${head}<tbody>${body}</tbody></table></div>`;
}

/* The one line on the page where the sources block used to be. */
export function sourcesHTML(): string {
  const b = S.ballot!;
  const n = chosen().length;
  if (!b.endorsers.length) return '';
  return `<section class="src-line-wrap" id="sources" aria-label="Endorsement sources">
    <button class="src-line" data-act="sources" aria-haspopup="dialog" data-fk="sources-btn">
      <span class="src-line-t">${n ? `Endorsements from <strong>${plural(n, 'source')}</strong>` : 'No endorsement sources on'}</span>
      <span class="src-line-cta">Change</span></button></section>`;
}

/* The sources section of the Filter shelf. */
export function sourcesShelfHTML(tgl: (act: string, on: boolean, label: string, sub: string, fk: string) => string): string {
  const b = S.ballot!;
  const n = chosen().length;
  return `<section class="flt-src" id="flt-src" aria-labelledby="flt-src-h">
    <h3 class="h3" id="flt-src-h" tabindex="-1">Endorsement sources</h3>
    <p class="small muted"><strong class="ink">${n} of ${b.endorsers.length} on.</strong> Turn a source on to see its picks on every race.</p>
    ${tgl('f-endorsed', S.prefs.endorsedOnly, 'Only candidates my sources endorsed', `In races where at least one of your ${plural(n, 'source')} picked someone.`, 'f-end')}
    <button class="btn btn-block" data-act="grid-open" data-fk="grid-open" ${n ? '' : 'disabled'}>See their picks side by side</button>
    <div class="row"><button class="btn btn-sm" data-act="src-default" data-fk="src-default">Reset to default</button><button class="btn btn-sm" data-act="src-none" data-fk="src-none">Turn all off</button></div>
    ${pickerHTML()}
    <p class="lim">Each source’s lean is shown on a five-step scale, Left to Right. One side’s sources aren’t balanced by the other’s unless you turn them on.</p>
  </section>`;
}

/* The side-by-side grid, full height inside the shelf. */
export function gridShelfHTML(): string {
  return `<p class="small muted">Rows are your ballot. Columns are the ${plural(chosen().length, 'source')} you turned on. You can pick from here too.</p>${gridHTML()}`;
}
