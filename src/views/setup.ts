/* Step 2, whose picks to see and whether to fill them in: on the first page beside step 1, and in
   the ballot's Edit sheet. On the first page the choices start in memory and become the ballot's
   once a ZIP finds it; it's loaded for the counts but not shown, and nothing is saved until "Show
   my ballot". The chips reuse the lens's actions; "A party" opens its list right here. */
import type { Ballot } from '../ballot';
import { S } from '../state';
import { esc, plural } from '../util';
import { chipsHTML, TICK } from './lens';
import { partiesOnBallot, CHIPS, noEndorsements, doorNone } from '../model/lens';
import { coverage } from '../model/tally';
import { planSetup, fillStands } from '../model/bulk';
import { isOpen, FILL, HIDE, SHOW_ENDS } from './common';

/* "Austin, Texas", "Aurora or Denver, Colorado", "Ward 1, Washington, DC", or the state alone for
   statewide races. */
export function placeLine(b: Ballot): string {
  const bare = (l: string) => l.replace(/\s*\(.*\)$/, '');
  if (!b.places.length) return b.stateName;
  if (b.st === 'DC') return b.places.length === 1 ? `${b.places[0].label.replace(/^DC /, '')}, ${b.stateName}` : b.stateName;
  return `${b.places.map((p) => bare(p.label)).join(' or ')}, ${b.stateName}`;
}

/* What the fill switch would do on this ballot: the party's candidates first, then the races where
   the rest of your sources agree; a part with nothing in it drops out. */
export function fillLine(party: string | null, more = false): string {
  const plan = planSetup(party);
  const a = plan.agree.fills.length;
  const p = plan.party ? plan.party.fills.length : 0;
  // After the fill has run once (the Edit sheet), what's left to fill is "more".
  const m = more ? ' more' : '';
  if (plan.party && (p || a)) return `${[p ? `${p}${m} from the ${party} Party` : '', a ? `${a}${m} where your other sources agree` : ''].filter(Boolean).join(' and ')}.`;
  const one = plan.agree.single;
  return `${a}${m} ${a === 1 ? 'race' : 'races'} where they agree${one ? ` (${one} from just one source)` : ''}. Races where picks split stay open.`;
}

const sw = (act: string, on: boolean, label: string, sub = ''): string =>
  `<button class="su-sw" role="switch" aria-checked="${on}" data-act="${act}" data-fk="${act}"><span class="su-l"><b>${esc(label)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span><span class="tg" aria-hidden="true"><span></span></span></button>`;

/* Step 2's controls, shared with the ballot's Edit sheet: "Show endorsements", the chips and "A
   party", the coverage line, and the two switches. On the first page "A party" opens its list right
   there; in the Edit sheet it opens the party sheet, and "See all sources" opens every source. Before
   a ZIP has found a ballot the first page shows the choices kept so far (S.door), every party the
   guide covers, and no counts. */
export function pickControlsHTML(inSheet = false): string {
  const b = inSheet || S.view === 'setup' ? S.ballot : null;
  const party = b ? S.b.party : S.door.party;
  const parties = b ? partiesOnBallot(b).map((p) => p.party) : S.index?.parties || [];
  const listOpen = !inSheet && !party && isOpen('su-party');
  const partyChip = !parties.length ? '' : party
    ? `<button class="chip" data-act="party-off" aria-pressed="true" data-fk="chip-party">${TICK}${esc(party)} Party</button>`
    : inSheet
      ? '<button class="chip" data-act="sheet" data-s="party" aria-haspopup="dialog" data-fk="chip-party">A party</button>'
      : `<button class="chip" data-act="open" data-k="su-party" aria-expanded="${listOpen}" data-fk="chip-party">A party</button>`;
  const more = inSheet ? '<button class="chip all-src" data-act="sheet" data-s="sources" aria-haspopup="dialog" data-fk="chip-more">See all sources</button>' : '';
  const list = listOpen
    ? `<div class="su-chips su-parties" role="group" aria-label="A party">${parties.map((p) => `<button class="chip" data-act="party-set" data-p="${esc(p)}" data-fk="pty-${esc(p)}">${esc(p)}</button>`).join('')}</div>`
    : '';
  const chips = b ? chipsHTML()
    : CHIPS.map((c) => `<button class="chip" data-act="chip" data-k="${c.key}" aria-pressed="${S.door.chips[c.key]}" data-fk="chip-${c.key}">${TICK}${esc(c.label)}</button>`).join('');
  // "Show endorsements" leads the step as a switch like the two below it, on to start (Kevin, Oct 20:
  // say it the affirmative way). Off, every row shows just the choices: no source on and no party, so
  // the chips, "A party", the coverage line and the fill switch, which only matter with endorsements,
  // step aside. On again, newspapers and guides come back. Turning the last chip off by hand is a
  // different thing (swapping one for another): the chips stay, with the switch on and nothing to
  // fill or count until you choose again.
  const none = b ? noEndorsements() : doorNone();
  const off = none && !S.ui.lensEmptied;
  const ends = `<div class="su-sws su-ends">${sw('ends', !off, SHOW_ENDS)}</div>`;
  // In the Edit sheet once the fill has run: it offers only what's new ("2 more races"), and with
  // nothing new it steps aside (the ballot head's Undo takes the fill back).
  const ran = inSheet && !!b && fillStands();
  const fillSw = none || (ran && !planSetup(party).fills.length) ? ''
    : sw('setup-fill', inSheet ? S.ui.setupFill : S.door.fill, FILL, b ? fillLine(party, ran) : 'Fills the races where they agree. Races where picks split stay open.');
  const only = sw('setup-only', inSheet ? S.ui.setupOnly : S.door.only, HIDE);
  if (off) return `${ends}
    <div class="su-sws">${only}</div>`;
  const cov = b && !none ? coverage() : null;
  return `${ends}
    <div class="su-chips" role="group" aria-labelledby="${inSheet ? 'sh-h' : 'su-h'}">${chips}${partyChip}${more}</div>
    ${list}
    ${cov ? `<p class="su-cov">Picks in ${cov.picked} of your ${plural(cov.total, 'race')}.</p>` : ''}
    <div class="su-sws">
      ${fillSw}
      ${only}
    </div>`;
}

/* Step 2 on the first page. */
export function doorPicksHTML(): string {
  return `<h2 class="step su-h" id="su-h" tabindex="-1" data-fk="su-h"><span class="step-n" aria-hidden="true">2</span>Pick by endorsements or party</h2>
    ${pickControlsHTML()}`;
}

/* The ballot's Edit sheet ("Endorsements: Newspapers and guides · Edit", and "Quick picks" in the menu):
   step 2's controls again. Chips apply as you tap; the two switches apply when it closes. */
export function picksSheetHTML(): string {
  return `<div class="scrim screen-only" data-act="sheet-close"></div>
  <div class="sheet-panel screen-only picks" role="dialog" aria-modal="true" aria-labelledby="sh-h">
    <div class="sheet-hd"><h2 id="sh-h">Pick by endorsements or party</h2><button class="closebtn" data-act="sheet-close" data-fk="sheet-x">Done</button></div>
    <div class="sheet-bd setup" data-keep="picks">${pickControlsHTML(true)}</div></div>`;
}
