/* The one banner for a source you asked for (model/adds.ts), at the top of the ballot in the restore region, and
   the toasts when it lands. One request speaks at a time (the newest still open). The words went through a GPT
   pass and the ux-writing lens on Oct 28 (the workbench's source-preview-log.md has before and after): the
   fewest words that say where it is and what you can do, no time promises. Closing it only hides it; the page
   still adds the source when it's ready. */
import { S } from '../state';
import { esc, host } from '../util';
import { shelfAttrs } from './common';
import { readAdds, bannerAdd, LONG_MS, type Add, type AddStatus } from '../model/adds';

/* The status this visit has read for each request, by its code (app.ts fills it); the last word is kept with the
   request too, so a reload shows the right line before the first answer. */
export const statusOf = new Map<string, AddStatus>();

/* The source's name as the banner says it: the guide's own name for it once the pipeline sends one, else what
   was typed, a link as its site's name, cut short. */
export function addName(a: Add, st: AddStatus | null = statusOf.get(a.code) || null): string {
  const raw = (st && st.name) || a.name;
  const n = /^https?:\/\//i.test(raw) ? host(raw) : raw;
  return n.length > 60 ? `${n.slice(0, 57).trimEnd()}...` : n || 'your source';
}
export const ADD_COPY = {
  sent: (n: string): string => `Request sent for ${n}. You can keep going.`,
  reading: (n: string): string => `Reading ${n}’s page.`,
  checking: (n: string): string => `Checking ${n}’s picks.`,
  long: (n: string, reply: boolean): string => `Still waiting on ${n}. Kevin will ${reply ? 'follow up' : 'take a look'}.`,
  held: (n: string): string => `Kevin is checking ${n} himself. If he adds it, it shows up here.`,
  blocked: (n: string): string => `We can’t read ${n}’s page. Can you paste their picks?`,
  pasteBtn: 'Paste their picks',
  notSource: (n: string, note: string): string => `We can’t add ${n}.${note ? ` ${note}` : ''}`,
  failed: (n: string, reply: boolean): string => `Couldn’t add ${n}. Kevin will ${reply ? 'follow up' : 'take a look'}.`,
  hide: 'Hide request status',
  /* Toasts: on this device, before the merge; live before this device saw it; a source the guide had, with new
     picks; live, with no picks on the ballot that's open. */
  onEarly: (n: string): string => `${n} is on. Only you see it for now.`,
  newPicks: (n: string): string => `${n}’s new picks are in.`,
  elsewhere: (n: string): string => `${n} is in the guide now, but not on this ballot.`,
  /* The sources sheet, after its type: a source on this device before the merge. */
  sheetNote: 'New. Only you see it until it’s checked.',
};

/* The banner's line for one request, by its last status and how long it has waited. */
export function addLine(a: Add, now = Date.now()): string {
  const st = statusOf.get(a.code) || null;
  const n = addName(a, st);
  const word = (st && st.state) || a.st || null;
  if (word === 'held') return ADD_COPY.held(n);
  if (word === 'blocked') return ADD_COPY.blocked(n);
  if (word === 'not_a_source') return ADD_COPY.notSource(n, st ? st.note : '');
  if (word === 'failed') return ADD_COPY.failed(n, !!a.reply);
  if (now - a.at >= LONG_MS) return ADD_COPY.long(n, !!a.reply);
  if (word === 'reading') return ADD_COPY.reading(n);
  if (word === 'checking' || word === 'ready') return ADD_COPY.checking(n);
  return ADD_COPY.sent(n);
}

const CLOSE = '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false"><path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></svg>';
/* On the ballot only, and never in a "try as" scenario. `.adds` with `data-state` (the status word, or "sent"),
   its close `[data-act="adds-x"]`, and on a blocked page `[data-fk="adds-paste"]`, which opens the shelf. */
export function addsHTML(now = Date.now()): string {
  if (S.tryMode || S.view !== 'ballot' || !S.ballot || S.ui.view !== 'ballot') return '';
  const a = bannerAdd(readAdds(now));
  if (!a) return '';
  const st = statusOf.get(a.code) || null;
  const word = (st && st.state) || a.st || 'sent';
  // Blocked: Add a source again, the paste box first and the source as they typed it (views/shelf.ts isPaste).
  const paste = word === 'blocked' ? `<div class="row-btns"><button class="mini dark" ${shelfAttrs({ kind: 'source', hint: 'paste', fk: 'adds-paste' })} data-code="${esc(a.code)}" data-src="${esc(a.name)}">${esc(ADD_COPY.pasteBtn)}</button></div>` : '';
  return `<div class="notice adds wrap" role="status" data-state="${esc(word)}">
    <p>${esc(addLine(a, now))}</p>${paste}
    <button class="ibtn resume-x" data-act="adds-x" data-code="${esc(a.code)}" data-fk="adds-x" aria-label="${esc(ADD_COPY.hide)}">${CLOSE}</button></div>`;
}
