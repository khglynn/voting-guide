/* Where results stand (Nov 3, results Phase 1): one figure at the top of the ballot, from the tally mock-up that won
   (the workbench's prototypes/results/tally.html, "A. Dots by ballot section") and the copy review's head order.
   A row per ballot section, a dot per race in ballot order. Your picks are big dots in the pick gold: filled where your
   pick is ahead or won, a ring where it's behind or didn't win, dotted where we can't compare. Races you didn't pick
   are small ink dots, dotted while they have no numbers. Shape carries the meaning, never hue alone, so it reads in
   print (black marks) and in dark mode. The key sits above the dots, so nobody misses it.
   Test hooks: #vz, .vz-st (the status word), .vz-key, .vz-r[data-sec] with .d dots ([data-id], classes up down wp po
   w), [data-act="fig-row"] (a row's chevron, its list .vz-list), [data-act="fig-hide"], .vz-sum, .vz-src. */
import { S } from '../state';
import { esc, load, save } from '../util';
import { rowTitle } from '../model/labels';
import { figure, countLine, othersLine, dotLine, checkedLine, sourceLines, R, type Dot, type Figure } from '../model/results';
import { sectionTitle } from './ledger';

const HIDE_KEY = 'vg-tally';
/* "Hide summary" is remembered on this device in its own key, never in vg2 or the save link. */
export const figHidden = (): boolean => load<boolean>(HIDE_KEY, false) === true;
export const setFigHidden = (v: boolean): void => { save(HIDE_KEY, v); };

const CHEV = '<svg class="chev" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 5l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
const dot = (k: Dot['kind'], id = ''): string => `<i class="d ${k}"${id ? ` data-id="${esc(id)}"` : ''} aria-hidden="true"></i>`;
const WORDS: Record<Dot['kind'], string> = { up: 'ahead or won', down: 'behind or didn’t win', wp: 'no comparison', po: 'other race, numbers posted', w: 'other race, no numbers yet' };

function rowLabel(f: Figure, sec: string, dots: Dot[]): string {
  const n = (k: Dot['kind']) => dots.filter((d) => d.kind === k).length;
  const bits = (['up', 'down', 'wp', 'po', 'w'] as const).filter((k) => n(k)).map((k) => `${n(k)} ${WORDS[k]}`);
  return `${sec}: ${bits.join(', ')}`;
}
function listHTML(dots: Dot[]): string {
  const b = S.ballot!;
  return `<ul class="vz-list">${dots.map((d) => {
    const it = b.byId.get(d.id)!;
    return `<li>${dot(d.kind)}<span><button class="linkbtn" data-act="goto" data-id="${esc(d.id)}" data-fk="vz-go-${esc(d.id)}">${esc(rowTitle(it).title)}${rowTitle(it).sub ? `, ${esc(rowTitle(it).sub!)}` : ''}</button><small>${esc(dotLine(it))}</small></span></li>`;
  }).join('')}</ul>`;
}
/* `forPrint`: the same figure on What's next's printed page (black marks there), with no ids and nothing to tap. */
export function figureHTML(forPrint = false): string {
  const f = figure();
  if (!f) return forPrint ? '' : '<div id="vz" hidden></div>';
  const hidden = !forPrint && figHidden();
  if (forPrint) return printHTML(f);
  const hd = `<div class="vz-hd"><h3 class="vz-st" id="vz-h">${esc(f.word)}</h3><button class="linkbtn" data-act="fig-hide" data-fk="vz-hide" aria-expanded="${!hidden}" aria-controls="vz-bd">${hidden ? 'Show summary' : 'Hide summary'}</button></div>
    <p class="vz-ex">${esc(f.explain)}</p>`;
  const srcs = [checkedLine(), ...sourceLines()].filter(Boolean);
  const failed = R.failed ? '<p class="vz-src">Couldn’t check the election office’s results just now. These are the last numbers we read.</p>' : '';
  if (hidden) return `<section class="vz is-hidden" id="vz" aria-labelledby="vz-h">${hd}</section>`;
  const picks = f.picks > 0;
  const key = picks
    ? `<p class="vz-key"><span>${dot('up')}Ahead or won</span><span>${dot('down')}Behind or didn’t win</span><span>${dot('wp')}No comparison</span><span>${dot('po')}Races you didn’t pick</span></p>`
    : `<p class="vz-key"><span>${dot('po')}Numbers posted</span><span>${dot('w')}No numbers yet</span></p>`;
  const rows = f.rows.map(({ sec, dots }) => {
    const label = sectionTitle(sec);
    const k = `vz-${sec}`;
    const open = S.ui.open.has(k);
    return `<div class="vz-r" data-sec="${sec}"><button class="vz-l" data-act="jump" data-to="${sec}" data-fk="vz-l-${sec}">${esc(label)}</button>
      <span class="vz-dots" role="img" aria-label="${esc(rowLabel(f, label, dots))}">${dots.map((d) => dot(d.kind, d.id)).join('')}</span>
      <button class="vz-cv" data-act="fig-row" data-sec="${sec}" aria-expanded="${open}" aria-label="${esc(`${open ? 'Hide' : 'List'} the races in ${label}`)}" data-fk="vz-cv-${sec}">${CHEV}</button></div>
      ${open ? listHTML(dots) : ''}`;
  }).join('');
  const sum = picks ? `<p class="vz-sum">${esc(countLine(f))}</p>` : `<p class="vz-sum">${esc(`No picks on this ballot. ${f.posted} of ${f.total} ${f.total === 1 ? 'race has' : 'races have'} numbers posted.`)}</p>`;
  const other = picks && f.others ? esc(othersLine(f)) : '';
  const q = f.questions.n ? `<button class="linkbtn" data-act="goto" data-q="${esc(f.questions.first!.slice(2))}" data-fk="vz-q">${f.questions.n === 1 ? '1 district question still needs an answer' : `${f.questions.n} district questions still need an answer`}</button>` : '';
  const more = other || q ? `<p class="vz-more">${[other, q].filter(Boolean).join('<span class="dot" aria-hidden="true"> · </span>')}</p>` : '';
  const notes = f.notes.map((n) => `<p class="vz-note">${esc(n)}</p>`).join('');
  return `<section class="vz" id="vz" aria-labelledby="vz-h">${hd}
    <div id="vz-bd">${key}<div class="vz-fig">${rows}</div>${sum}${more}${notes}
    ${failed}${srcs.length ? `<div class="vz-src">${srcs.map((s) => `<p>${esc(s)}</p>`).join('')}</div>` : ''}</div></section>`;
}

function printHTML(f: Figure): string {
  const rows = f.rows.map(({ sec, dots }) => `<div class="vz-r"><span class="vz-l">${esc(sectionTitle(sec))}</span><span class="vz-dots">${dots.map((d) => dot(d.kind)).join('')}</span><span></span></div>`).join('');
  const key = f.picks
    ? `<p class="vz-key"><span>${dot('up')}Ahead or won</span><span>${dot('down')}Behind or didn’t win</span><span>${dot('wp')}No comparison</span><span>${dot('po')}Races you didn’t pick</span></p>`
    : `<p class="vz-key"><span>${dot('po')}Numbers posted</span><span>${dot('w')}No numbers yet</span></p>`;
  const sum = f.picks ? countLine(f) : `No picks on this ballot. ${f.posted} of ${f.total} races have numbers posted.`;
  const srcs = [checkedLine(), ...sourceLines()].filter(Boolean);
  return `<section class="vz vz-print"><div class="vz-hd"><h3 class="vz-st">${esc(f.word)}</h3></div><p class="vz-ex">${esc(f.explain)}</p>${key}<div class="vz-fig">${rows}</div><p class="vz-sum">${esc(sum)}</p>${f.notes.map((n) => `<p class="vz-note">${esc(n)}</p>`).join('')}${srcs.length ? `<div class="vz-src">${srcs.map((x) => `<p>${esc(x)}</p>`).join('')}</div>` : ''}</section>`;
}
