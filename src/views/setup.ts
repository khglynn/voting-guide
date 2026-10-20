/* Step 2 on the first page, after a ZIP: whose picks to see, and whether to fill them in. The
   ballot is loaded (the chips and counts need it) but not shown, and nothing is saved until
   "Show my ballot". The chips reuse the lens's actions; "A party" opens its list right here. */
import type { Ballot } from '../ballot';
import { S } from '../state';
import { esc, plural } from '../util';
import { chipsHTML, TICK } from './lens';
import { partiesOnBallot } from '../model/lens';
import { coverage } from '../model/tally';
import { planSetup } from '../model/bulk';
import { isOpen } from './common';

/* "Austin, Texas", "Aurora or Denver, Colorado", "Ward 1, Washington, DC", or the state alone for
   statewide races. */
export function placeLine(b: Ballot): string {
  const bare = (l: string) => l.replace(/\s*\(.*\)$/, '');
  if (!b.places.length) return b.stateName;
  if (b.st === 'DC') return b.places.length === 1 ? `${b.places[0].label.replace(/^DC /, '')}, ${b.stateName}` : b.stateName;
  return `${b.places.map((p) => bare(p.label)).join(' or ')}, ${b.stateName}`;
}

const sw = (act: string, on: boolean, label: string, sub = ''): string =>
  `<button class="su-sw" role="switch" aria-checked="${on}" data-act="${act}" data-fk="${act}"><span class="su-l"><b>${esc(label)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span><span class="tg" aria-hidden="true"><span></span></span></button>`;

export function setupHTML(): string {
  const b = S.ballot!;
  const party = S.b.party;
  const parties = partiesOnBallot(b);
  const listOpen = !party && isOpen('su-party');
  const partyChip = !parties.length ? '' : party
    ? `<button class="chip" data-act="party-off" aria-pressed="true" data-fk="chip-party">${TICK}${esc(party)} Party</button>`
    : `<button class="chip" data-act="open" data-k="su-party" aria-expanded="${listOpen}" data-fk="chip-party">A party</button>`;
  const list = listOpen
    ? `<div class="su-chips su-parties" role="group" aria-label="A party">${parties.map((p) => `<button class="chip" data-act="party-set" data-p="${esc(p.party)}" data-fk="pty-${esc(p.party)}">${esc(p.party)}</button>`).join('')}</div>`
    : '';
  const cov = coverage();
  const plan = planSetup(party);
  const a = plan.agree.fills.length;
  const one = plan.agree.single;
  const fillSub = plan.party
    ? `${plan.party.fills.length} from the ${party} Party, ${a} more where your sources agree.`
    : `${plural(a, 'race')} where they agree${one ? ` (${one} from just one source)` : ''}. Skips the ones where they split.`;
  return `<header class="mast front setup wrap" id="setup">
    <p class="su-done"><span><b>${esc(placeLine(b))}</b>${S.b.zip ? ` · ${esc(S.b.zip)}` : ''}</span><button class="linkbtn" data-act="change-place" data-fk="change-place">Change</button></p>
    <h1 class="step su-h" id="su-h" tabindex="-1" data-fk="su-h"><span class="step-n" aria-hidden="true">2</span>Pick by endorsements or party</h1>
    <div class="su-chips" role="group" aria-labelledby="su-h">${chipsHTML()}${partyChip}</div>
    ${list}
    <p class="su-cov">Picks in ${cov.picked} of your ${plural(cov.total, 'race')}.</p>
    <div class="su-sws">
      ${sw('setup-fill', S.ui.setupFill, 'Fill in their picks', fillSub)}
      ${sw('setup-only', S.ui.setupOnly, 'Show only what’s left')}
    </div>
    <button class="bigbtn" data-act="setup-done" data-fk="setup-done">Show my ballot</button>
  </header>`;
}
