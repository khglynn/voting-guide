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
import { figure, countLine, othersLine, dotLine, checkedLine, sourceLines, R, resultsMode, resultsWaiting, type Dot, type Figure } from '../model/results';
import { sectionTitle, resColOf } from './ledger';
import { ext, isOpen } from './common';

const HIDE_KEY = 'vg-tally';
/* "Hide summary" is remembered on this device in its own key, never in vg2 or the save link. */
export const figHidden = (): boolean => load<boolean>(HIDE_KEY, false) === true;
export const setFigHidden = (v: boolean): void => { save(HIDE_KEY, v); };

const CHEV = '<svg class="chev" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 5l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
const dot = (k: Dot['kind'], id = ''): string => `<i class="d ${k}"${id ? ` data-id="${esc(id)}"` : ''} aria-hidden="true"></i>`;
const WORDS: Record<Dot['kind'], string> = { up: 'ahead or won', down: 'behind or didn’t win', wp: 'no comparison', po: 'other race, numbers posted', w: 'other race, no numbers yet', ln: 'other race, results on the office’s site' };

function rowLabel(f: Figure, sec: string, dots: Dot[]): string {
  const n = (k: Dot['kind']) => dots.filter((d) => d.kind === k).length;
  const bits = (['up', 'down', 'wp', 'po', 'w', 'ln'] as const).filter((k) => n(k)).map((k) => `${n(k)} ${WORDS[k]}`);
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
  if (!f) {
    if (forPrint) return '';
    // No file for this state (California tonight), or the first read failed: one line and the offices' own pages, so a
    // friend's city still reads as results, not as a guide from before the polls closed.
    if (resultsMode() && !resultsWaiting() && (R.none || R.failed)) {
      return `<section class="vz vz-links" id="vz"><p class="vz-ex">${esc(R.failed && !R.none ? 'Couldn’t check the election offices just now. Their own pages have the counts:' : 'This guide has no counts for these races yet. The election offices’ own pages have them:')}</p>${officesHTML()}</section>`;
    }
    return '<div id="vz" hidden></div>';
  }
  const hidden = !forPrint && figHidden();
  if (forPrint) return printHTML(f);
  const hd = `<div class="vz-hd"><h3 class="vz-st" id="vz-h">${esc(f.word)}</h3><button class="linkbtn" data-act="fig-hide" data-fk="vz-hide" aria-expanded="${!hidden}" aria-controls="vz-bd">${hidden ? 'Show summary' : 'Hide summary'}</button></div>
    <p class="vz-ex">${esc(f.explain)}</p>`;
  const failed = R.failed ? '<p class="vz-src">Couldn’t check the election office’s results just now. These are the last numbers we read.</p>' : '';
  // Every race here links to the office's own page (Manhattan): no figure, no Refresh, one line (DESIGN, link-only places).
  if (f.allLinks) return `<section class="vz vz-links" id="vz"><p class="vz-ex">${esc(linksLine())}</p>${officesHTML()}</section>`;
  if (hidden) return `<section class="vz is-hidden" id="vz" aria-labelledby="vz-h">${hd}</section>`;
  const picks = f.picks > 0;
  const key = keyHTML(f);
  const rows = f.rows.map(({ sec, dots }) => {
    const label = sectionTitle(sec);
    const k = `vz-${sec}`;
    const open = S.ui.open.has(k);
    return `<div class="vz-r" data-sec="${sec}"><button class="vz-l" data-act="jump" data-to="${sec}" data-fk="vz-l-${sec}">${esc(label)}</button>
      <span class="vz-dots" role="img" aria-label="${esc(rowLabel(f, label, dots))}">${dots.map((d) => dot(d.kind, d.id)).join('')}</span>
      <button class="vz-cv" data-act="fig-row" data-sec="${sec}" aria-expanded="${open}" aria-label="${esc(`${open ? 'Hide' : 'List'} the races in ${label}`)}" data-fk="vz-cv-${sec}">${CHEV}</button></div>
      ${open ? listHTML(dots) : ''}`;
  }).join('');
  const sum = `<p class="vz-sum">${esc(picks ? countLine(f) : noPicksLine(f))}</p>`;
  const other = picks && f.others ? esc(othersLine(f)) : '';
  const q = f.questions.n ? `<button class="linkbtn" data-act="goto" data-q="${esc(f.questions.first!.slice(2))}" data-fk="vz-q">${f.questions.n === 1 ? '1 more race needs your district' : `${f.questions.n} more races need your district`}</button>` : '';
  const more = other || q ? `<p class="vz-more">${[other, q].filter(Boolean).join('<span class="dot" aria-hidden="true"> · </span>')}</p>` : '';
  const notes = f.notes.map((n) => `<p class="vz-note">${esc(n)}</p>`).join('');
  // No picks (a friend's city): where races stand, as a list, in place of the dots (overnight).
  const body = picks ? `${key}<div class="vz-fig">${rows}</div>${sum}` : standHTML(f);
  return `<section class="vz${picks ? '' : ' vz-stand'}" id="vz" aria-labelledby="vz-h">${hd}
    <div id="vz-bd">${body}${more}${notes}${failed}${srcFoldHTML()}</div></section>`;
}
/* Where the numbers come from, folded under one link (overnight: the run of each office's times was a paragraph at the
   top of the ballot). Open: when we checked, then each office's own update time and words. The menu has the same. */
function srcFoldHTML(): string {
  const srcs = [checkedLine(), ...sourceLines()].filter(Boolean);
  if (!srcs.length) return '';
  const k = 'vz-src';
  const open = isOpen(k);
  return `<p class="vz-srcs"><button class="linkbtn" data-act="open" data-k="${k}" aria-expanded="${open}" data-fk="${k}">Where these numbers come from</button></p>${open ? `<div class="vz-src">${srcs.map((x) => `<p>${esc(x)}</p>`).join('')}</div>` : ''}`;
}
/* The offices' own results pages for this ballot, as links: the voter's county first, then the state. */
function officesHTML(): string {
  const rows = (S.ballot?.howto.results?.sources || []).filter((x) => /^https:\/\//i.test(x.results_url));
  return rows.length ? `<p class="vz-offs">${rows.map((x) => ext(x.results_url, `${x.label || x.name} results`)).join('')}</p>` : '';
}
/* No picks on this ballot (overnight, Kevin: "I keep checking out states my friends are in and it's hard to see
   summaries"): where races stand, grouped like the ballot, the first few races of each section, top of the ballot
   first. Each line says what the row's own column says: the leader and share with its status word or county, a
   measure's yes share beside its bar, "Not posted yet", or the office's page as a link. A section's title jumps to it. */
const STAND_N = 3;
function standHTML(f: Figure): string {
  const b = S.ballot!;
  return `<div class="st">${f.rows.map(({ sec, dots }) => {
    const shown = dots.slice(0, STAND_N);
    const more = dots.length - shown.length;
    const lines = shown.map((d) => {
      const it = b.byId.get(d.id)!;
      const t = rowTitle(it);
      const c = resColOf(it);
      const v = !c ? '' : c.kind === 'link' && c.url ? ext(c.url, c.main, 'st-go')
        : c.kind === 'num' ? `<b>${esc(c.main)}</b>${c.sub ? `<small>${esc(c.sub)}</small>` : ''}` : `<span class="st-none">${esc(c.main)}</span>`;
      return `<li><button class="st-t" data-act="goto" data-id="${esc(d.id)}" data-fk="st-go-${esc(d.id)}">${esc(t.title)}${t.sub ? `<small>${esc(it.kind === 'measure' && it.short_title ? it.short_title : t.sub)}</small>` : it.kind === 'measure' && it.short_title ? `<small>${esc(it.short_title)}</small>` : ''}</button><span class="st-v">${v}</span></li>`;
    }).join('');
    return `<div class="st-sec" data-sec="${sec}"><h4 class="st-h"><button class="linkbtn" data-act="jump" data-to="${sec}" data-fk="st-${sec}">${esc(sectionTitle(sec))}</button></h4>
      <ul class="st-list">${lines}</ul>${more ? `<p class="st-more"><button class="linkbtn" data-act="jump" data-to="${sec}" data-fk="st-more-${sec}">${more === 1 ? '1 more race' : `${more} more races`} in ${esc(sectionTitle(sec))}</button></p>` : ''}</div>`;
  }).join('')}</div>`;
}

/* The key, above the dots: the shapes on this ballot, and nothing it doesn't use. */
function keyHTML(f: Figure): string {
  const has = (k: Dot['kind']) => f.rows.some((r) => r.dots.some((d) => d.kind === k));
  const bits: [Dot['kind'], string][] = f.picks
    ? [['up', 'Ahead or won'], ['down', 'Behind or didn’t win'], ['wp', 'No comparison'], ['po', 'Races you didn’t pick']]
    : [['po', 'Numbers posted'], ['w', 'No numbers yet']];
  if (has('ln')) bits.push(['ln', 'On the office’s site']);
  return `<p class="vz-key">${bits.map(([k, t]) => `<span>${dot(k)}${esc(t)}</span>`).join('')}</p>`;
}
const noPicksLine = (f: Figure): string => `No picks on this ballot. ${f.posted} of ${f.total} ${f.total === 1 ? 'race has' : 'races have'} numbers here${f.links ? `; ${f.links} more ${f.links === 1 ? 'links' : 'link'} to official results` : ''}.`;
/* "Results for your races are on the NYC Board of Elections site. Your picks stay here." */
function linksLine(): string {
  const ids = new Set(S.ballot!.items.map((it) => R.file?.items[it.id]?.source).filter(Boolean));
  const names = (R.file?.sources || []).filter((x) => ids.has(x.id)).map((x) => x.name);
  return `${names.length === 1 ? `The ${names[0]} posts` : 'The election offices post'} results for your races on ${names.length === 1 ? 'its' : 'their'} own site. Your picks stay here.`;
}
export const allLinksNow = (): boolean => !!figure()?.allLinks;
function printHTML(f: Figure): string {
  const rows = f.rows.map(({ sec, dots }) => `<div class="vz-r"><span class="vz-l">${esc(sectionTitle(sec))}</span><span class="vz-dots">${dots.map((d) => dot(d.kind)).join('')}</span><span></span></div>`).join('');
  if (f.allLinks) return `<section class="vz vz-print"><p class="vz-ex">${esc(linksLine())}</p></section>`;
  const key = keyHTML(f);
  const sum = f.picks ? countLine(f) : noPicksLine(f);
  const srcs = [checkedLine(), ...sourceLines()].filter(Boolean);
  return `<section class="vz vz-print"><div class="vz-hd"><h3 class="vz-st">${esc(f.word)}</h3></div><p class="vz-ex">${esc(f.explain)}</p>${key}<div class="vz-fig">${rows}</div><p class="vz-sum">${esc(sum)}</p>${f.notes.map((n) => `<p class="vz-note">${esc(n)}</p>`).join('')}${srcs.length ? `<div class="vz-src">${srcs.map((x) => `<p>${esc(x)}</p>`).join('')}</div>` : ''}</section>`;
}
