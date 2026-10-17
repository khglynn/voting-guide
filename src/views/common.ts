/* Small render helpers shared by every view. */
import type { Lean } from '../types';
import { S } from '../state';
import { esc, host } from '../util';

export const LEANS: Record<Lean, [number, string]> = {
  left: [0, 'Left'], lean_left: [1, 'Lean left'], neutral: [2, 'Neutral'], lean_right: [3, 'Lean right'], right: [4, 'Right'],
};

/* Neutral 5-step scale plus words. Never color. */
export function leanHTML(lean: Lean | null, words = true): string {
  if (!lean) return `<span class="lean"><span class="lean-scale none" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>${words ? '<span>Not rated</span>' : '<span class="vh">Not rated</span>'}</span>`;
  const [idx, word] = LEANS[lean];
  const cells = [0, 1, 2, 3, 4].map((i) => `<i class="${i === idx ? 'on' : ''}"></i>`).join('');
  return `<span class="lean" title="${word}"><span class="lean-scale" role="img" aria-label="Lean: ${word}">${cells}</span>${words ? `<span>${word}</span>` : `<span class="vh">${word}</span>`}</span>`;
}

export const confLabel = (c: string | null | undefined): string =>
  c === 'unverified' ? 'Not yet confirmed' : c === 'sourced' ? 'Secondhand source' : '';

export const ext = (url: string | null | undefined, text: string, cls = ''): string =>
  url ? `<a href="${esc(url)}" target="_blank" rel="noopener"${cls ? ` class="${cls}"` : ''}>${esc(text)}</a>` : esc(text);

export const srcLink = (url: string | null | undefined): string =>
  url ? `<a class="src" href="${esc(url)}" target="_blank" rel="noopener">${esc(host(url))}</a>` : '';

/* The official place to see your exact ballot: the place file's lookup, then any
   state source named like a sample ballot, then the state's registration lookup. */
export function sampleBallot(): { url: string; label: string } | null {
  const b = S.ballot;
  if (!b) return null;
  const p = b.places.find((x) => x.sample_ballot_url);
  if (p && p.sample_ballot_url) return { url: p.sample_ballot_url, label: 'See your official sample ballot' };
  const src = b.howto.sources.find((s) => /sample ballot/i.test(s.name));
  if (src) return { url: src.url, label: 'See official sample ballots' };
  const look = b.howto.sources.find((s) => /voter lookup|my voter|myvote|voterview|my vote/i.test(s.name));
  if (look) return { url: look.url, label: `Look up your ballot (${host(look.url)})` };
  if (b.howto.registration.check_url) return { url: b.howto.registration.check_url, label: `Your official voter lookup (${host(b.howto.registration.check_url)})` };
  return { url: b.howto.official_site.url, label: b.howto.official_site.name };
}

/* A "disclosure" button. The key lives in S.ui.open. */
export const isOpen = (k: string): boolean => S.ui.open.has(k);
export function discBtn(k: string, label: string, cls = 'disc'): string {
  return `<button class="${cls}" data-act="open" data-k="${esc(k)}" aria-expanded="${isOpen(k)}">${esc(label)}</button>`;
}

export const firstSentence = (s: string): [string, string] => {
  const m = s.match(/^(.+?[.!?])(\s+|$)([\s\S]*)$/);
  if (!m) return [s.trim(), ''];
  return [m[1].replace(/\.$/, '').trim(), m[3].trim()];
};
