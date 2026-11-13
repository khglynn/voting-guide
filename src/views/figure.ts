/* Where results stand (Nov 3, results Phase 1): one figure at the top of the ballot, from the tally mock-up that won
   (the workbench's prototypes/results/tally.html, "A. Dots by ballot section") and the copy review's head order.
   A row per ballot section, a dot per race in ballot order. Your picks are big dots in the pick gold: filled where your
   pick is winning or won, a ring where it's losing or lost, half filled where the numbers are in but we can't tell,
   dotted where there are no numbers here. Races you didn't pick are small ink dots. Shape carries the meaning, never
   hue alone, so it reads in print (black marks) and in dark mode. The key sits above the dots, so nobody misses it, and
   names only the marks this ballot has, in words about your pick (Kevin, Nov 5: "Ahead · Behind · Not compared · Not
   picked" was "confusing af", and "ahead" beside a measure read as the measure passing).
   Test hooks: #vz, .vz-st (the status word), .vz-key, .vz-r[data-sec] with .d dots ([data-id], classes up down wq wp
   po w ln), [data-act="fig-row"] (a row's chevron, its list .vz-list), [data-act="fig-hide"], .vz-sum, .vz-src. */
import { S } from '../state';
import { esc, load, save } from '../util';
import { rowTitle } from '../model/labels';
import { figure, countLine, splitLine, dotLine, checkedLine, sourceLines, R, resultsMode, resultsWaiting, anyPick, anyChoice, selName, viewFor, type Dot, type Figure, type CmpSel } from '../model/results';
import { CHIPS, emptyNote, partiesOnBallot, chipMembers } from '../model/lens';
import { planAgree, planParty } from '../model/bulk';
import { sectionTitle, resColOf } from './ledger';
import { ext } from './common';
import { TICK } from './lens';

const HIDE_KEY = 'vg-tally';
/* "Hide summary" is remembered on this device in its own key, never in vg2 or the save link. */
export const figHidden = (): boolean => load<boolean>(HIDE_KEY, false) === true;
export const setFigHidden = (v: boolean): void => { save(HIDE_KEY, v); };

const CHEV = '<svg class="chev" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 5l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
const dot = (k: Dot['kind'], id = ''): string => `<i class="d ${k}"${id ? ` data-id="${esc(id)}"` : ''} aria-hidden="true"></i>`;
const WORDS: Record<Dot['kind'], string> = { up: 'winning or won', down: 'losing or lost', wq: 'can’t tell yet', wp: 'not posted here', po: 'no pick', w: 'no pick, not posted yet', ln: 'no pick, results on the office’s site' };

function rowLabel(f: Figure, sec: string, dots: Dot[]): string {
  const n = (k: Dot['kind']) => dots.filter((d) => d.kind === k).length;
  const bits = (['up', 'down', 'wq', 'wp', 'po', 'w', 'ln'] as const).filter((k) => n(k)).map((k) => `${n(k)} ${WORDS[k]}`);
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
  const hd = `<div class="vz-hd"><h3 class="vz-st" id="vz-h" data-fk="vz-h" tabindex="-1">${esc(f.word)}</h3><button class="linkbtn" data-act="fig-hide" data-fk="vz-hide" aria-expanded="${!hidden}" aria-controls="vz-bd">${hidden ? 'Show summary' : 'Hide summary'}</button></div>
    <p class="vz-ex">${esc(f.explain)}</p>`;
  const failed = R.failed ? '<p class="vz-note">Couldn’t check the election offices just now. These are the last numbers we read.</p>' : '';
  // Every race here links to the office's own page (Manhattan): no figure, no Refresh, one line (DESIGN, link-only places).
  if (f.allLinks) return `<section class="vz vz-links" id="vz"><p class="vz-ex">${esc(linksLine())}</p>${officesHTML()}</section>`;
  if (hidden) return `<section class="vz is-hidden" id="vz" aria-labelledby="vz-h">${hd}</section>`;
  const q = f.questions.n ? `<p class="vz-more"><button class="linkbtn" data-act="goto" data-q="${esc(f.questions.first!.slice(2))}" data-fk="vz-q">${f.questions.n === 1 ? 'Choose your district to see 1 more race' : `Choose your district to see ${f.questions.n} more races`}</button></p>` : '';
  // Something chosen: how it's doing, headline first, then the dots. Nothing chosen: where races stand.
  const body = f.sel ? selHTML(f, f.sel) : standHTML(f);
  return `<section class="vz${f.sel ? '' : ' vz-stand'}" id="vz" aria-labelledby="vz-h">${hd}
    <div id="vz-bd">${cmpHTML(f)}${body}${q}${failed}</div></section>`;
}

/* "Compare with" (DESIGN-OVERNIGHT-2 section 1; Kevin, on the group switch: "how does this work with 'your picks'?").
   Your picks first, only when this ballot has one, and chosen by default; then the picking step's groups, same names
   and order, and A party (its parties open inline, as on the first page, so choosing one never changes the ballot's
   party). One at a time; tapping the chosen one clears it. Nothing here saves or changes a pick. */
function cmpHTML(f: Figure): string {
  const sel = f.sel;
  const on = (k: string): boolean => !!sel && (sel.kind === 'mine' ? k === 'mine' : sel.kind === 'group' ? k === sel.key : k === 'party');
  // Short labels so the row stays two lines at 390 px with Your picks (PR #139 review); the full name is what a screen
  // reader hears, and the headline under the chips uses it.
  const chip = (k: string, label: string, full = label, extra = ''): string => `<button class="chip cmp-c" data-act="cmp" data-k="${k}" aria-pressed="${on(k)}" data-fk="cmp-${k}"${full !== label ? ` aria-label="${esc(full)}"` : ''}${extra}>${TICK}${esc(label)}</button>`;
  const parties = partiesOnBallot(S.ballot!);
  const partyOpen = S.ui.open.has('cmp-party') && parties.length > 0;
  // A party is a second step in the same place: its parties replace the groups, with Back, so the answer never moves.
  const chips = partyOpen
    ? [`<button class="chip cmp-c cmp-back" data-act="cmp" data-k="party" aria-expanded="true" data-fk="cmp-party">‹ Back</button>`,
      ...parties.map((p) => `<button class="chip cmp-c" data-act="cmp-party" data-p="${esc(p.party)}" aria-pressed="${!!sel && sel.kind === 'party' && sel.party === p.party}" data-fk="cmp-p-${esc(p.party)}">${TICK}${esc(p.party)}</button>`)].join('')
    : [
      anyPick() ? chip('mine', 'Your picks') : '',
      ...CHIPS.map((c) => chip(c.key, SHORT[c.key] || c.label, c.label)),
      parties.length ? chip('party', sel && sel.kind === 'party' ? sel.party : 'A party', sel && sel.kind === 'party' ? selName(sel) : 'A party', ' aria-expanded="false"') : '',
    ].join('');
  // With a group or party chosen over picks of your own, say plainly what it doesn't do (GPT copy pass).
  const own = !sel && !anyChoice() ? '<p class="cmp-own"><button class="linkbtn" data-act="picks" data-fk="cmp-own">Or make your own picks</button></p>'
    : sel && sel.kind !== 'mine' && anyChoice() ? '<p class="cmp-own cmp-hint">Your picks don’t change. Tap it again to clear.</p>' : '';
  return `<div class="cmp" role="group" aria-labelledby="cmp-l"><p class="cmp-l" id="cmp-l">${partyOpen ? 'Compare with a party' : 'Compare with'}</p><div class="cmp-chips">${chips}</div>${own}</div>`;
}
const SHORT: Record<string, string> = { papers: 'Newspapers', progressive: 'Progressive', conservative: 'Conservative', unions: 'Unions' };
/* The answer for a choice: the count line as the headline, the dot figure by section with its key in one line above,
   and for a group or party on a ballot with no picks of your own, "Make these my picks" (today's fill, with Undo). */
function selHTML(f: Figure, sel: CmpSel): string {
  if (!f.picks) {
    const empty = sel.kind === 'group' ? (chipMembers(S.ballot!, sel.key).length ? `No shared picks from ${selName(sel).toLowerCase()} on this ballot.${f.splits ? ` ${splitLine(f)}` : ''}` : emptyNote(S.ballot!, sel.key))
      : sel.kind === 'party' ? `No ${selName(sel)} candidates on this ballot.` : '';
    return empty ? `<p class="vz-sum">${esc(empty)}</p>` : '';
  }
  const rows = f.rows.map(({ sec, dots }) => {
    const label = sectionTitle(sec);
    const k = `vz-${sec}`;
    const open = S.ui.open.has(k);
    return `<div class="vz-r" data-sec="${sec}"><button class="vz-l" data-act="jump" data-to="${sec}" data-fk="vz-l-${sec}">${esc(label)}</button>
      <span class="vz-dots" role="img" aria-label="${esc(rowLabel(f, label, dots))}">${dots.map((d) => dot(d.kind, d.id)).join('')}</span>
      <button class="vz-cv" data-act="fig-row" data-sec="${sec}" aria-expanded="${open}" aria-label="${esc(`${open ? 'Hide' : 'List'} the races in ${label}`)}" data-fk="vz-cv-${sec}">${CHEV}</button></div>
      ${open ? listHTML(dots) : ''}`;
  }).join('');
  const split = splitLine(f);
  // "Make these my picks" says exactly what it fills: the plan it runs (today's fill leaves ranked races to rank, and a
  // race of several seats unless the group names a full set), so the promise and the result never differ.
  const fills = sel.kind === 'mine' || anyChoice() ? 0 : sel.kind === 'group' ? planAgree(chipMembers(S.ballot!, sel.key)).fills.length : planParty(sel.party).fills.length;
  const take = fills ? `<div class="cmp-take"><button class="mini dark" data-act="cmp-take" data-fk="cmp-take">Make these my picks</button><span>${esc(fills === f.picks ? `Fills ${fills === 1 ? 'this race' : `these ${fills} races`}.` : `Fills ${fills} of these ${f.picks} races.`)} You can undo it.</span></div>` : '';
  const notes = f.notes.map((n) => `<p class="vz-note">${esc(n)}</p>`).join('');
  return `<p class="vz-sum vz-head">${esc(countLine(f))}</p>${split ? `<p class="vz-more">${esc(split)}</p>` : ''}
    ${keyHTML(f)}<div class="vz-fig">${rows}</div>${take}${notes}`;
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
        : c.kind === 'num' ? `<b>${esc(c.main)}</b>${c.sub ? `<small>${esc(c.sub)}</small>` : ''}${c.area ? `<small>${esc(c.area)}</small>` : ''}` : `<span class="st-none">${esc(c.main)}</span>`;
      return `<li><button class="st-t" data-act="goto" data-id="${esc(d.id)}" data-fk="st-go-${esc(d.id)}">${esc(t.title)}${t.sub ? `<small>${esc(it.kind === 'measure' && it.short_title ? it.short_title : t.sub)}</small>` : it.kind === 'measure' && it.short_title ? `<small>${esc(it.short_title)}</small>` : ''}</button><span class="st-v">${v}</span></li>`;
    }).join('');
    return `<div class="st-sec" data-sec="${sec}"><h4 class="st-h"><button class="linkbtn" data-act="jump" data-to="${sec}" data-fk="st-${sec}">${esc(sectionTitle(sec))}</button></h4>
      <ul class="st-list">${lines}</ul>${more ? `<p class="st-more"><button class="linkbtn" data-act="jump" data-to="${sec}" data-fk="st-more-${sec}">${more === 1 ? '1 more race' : `${more} more races`} in ${esc(sectionTitle(sec))}</button></p>` : ''}</div>`;
  }).join('')}</div>`;
}

/* The key, above the dots: the shapes on this ballot, and nothing it doesn't use, in one compact line
   (DESIGN-OVERNIGHT-2). "Winning" and "Losing" while counting; "Won" and "Lost" once a count is final, both when both. */
function keyHTML(f: Figure): string {
  const has = (k: Dot['kind']) => f.rows.some((r) => r.dots.some((d) => d.kind === k));
  const c = f.counts;
  const two = (now: number, done: number, a: string, b: string): string => (now && done ? `${a} or ${b.toLowerCase()}` : done ? b : a);
  const mine = !!f.sel && f.sel.kind === 'mine';
  const bits: [Dot['kind'], string][] = f.picks
    ? [['up', two(c.ahead, c.won, 'Winning', 'Won')], ['down', two(c.behind, c.lost, 'Losing', 'Lost')], ['wq', 'Can’t tell yet'], ['wp', 'Not posted here'],
      ['po', mine ? 'You didn’t pick' : f.sel && f.sel.kind === 'party' ? 'No candidate' : 'No pick']]
    : [['po', 'Numbers posted'], ['w', 'No numbers yet'], ['ln', 'On the office’s site']];
  return `<p class="vz-key">${bits.filter(([k]) => has(k)).map(([k, t]) => `<span>${dot(k)}${esc(t)}</span>`).join('')}</p>`;
}
const noPicksLine = (f: Figure): string => `No picks on this ballot. ${f.posted} of ${f.total} ${f.total === 1 ? 'race has' : 'races have'} numbers here${f.links ? `; ${f.links} more ${f.links === 1 ? 'links' : 'link'} to official results` : ''}.`;
/* "Results for your races are on the NYC Board of Elections site. Your picks stay here." */
function linksLine(): string {
  // The office behind each row as the row shows it (viewFor: a county's share of a statewide race only in that county).
  const ids = new Set(S.ballot!.items.map((it) => { const r = R.file?.items[it.id]; return r ? viewFor(it, r)?.source : undefined; }).filter(Boolean));
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
