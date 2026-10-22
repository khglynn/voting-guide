/* The foot of every page, two quiet lines, the same wherever you are (Kevin, Oct 21: "less loud", one
   design). Line one: how many cities and whose friends, the count opening the list of places. Line two:
   How this guide works, Report a problem, Request a city, Support. Each of the five opens the shelf,
   one sheet from the bottom of the screen (views/shelf.ts; Kevin, Oct 21: "let's use that for all of
   them"). On the ballot and My plan the foot is its own region (#r-trust); on the share page it sits
   above the crowd (pass.ts); on the first page it is the small print under the pad (mast.ts). */
import type { Index } from '../types';
import { S } from '../state';
import { kevinLink, shelfAttrs } from './common';

/* How many cities the guide covers: each place counts once, except that DC's wards are one city
   and New York City's boroughs are one. */
export function cityCount(idx: Pick<Index, 'places'>): number {
  return new Set(Object.entries(idx.places).map(([id, p]) => (p.state === 'DC' ? 'DC' : /^nyc-/.test(id) ? 'NYC' : id))).size;
}

export function trustHTML(inDoor = false): string {
  const idx = S.index;
  const n = idx ? cityCount(idx) : 0;
  // A link on every page (Kevin, Oct 21: "33 cities lost its link"); from a ballot, a place picked there
  // starts over at the first page, as Change does, and the ballot you left stays saved.
  const cover = idx ? `Covers <button class="linkbtn" ${shelfAttrs({ kind: 'cities', fk: 'browse' })}>${n} ${n === 1 ? 'city' : 'cities'}</button> where ${kevinLink()}’s friends live.` : '';
  const links = [
    `<button class="linkbtn" ${shelfAttrs({ kind: 'how', fk: 'help-how' })}>How this guide works</button>`,
    `<button class="linkbtn" ${shelfAttrs({ kind: 'report', fk: 'help-report' })}>Report a problem</button>`,
    `<button class="linkbtn" ${shelfAttrs({ kind: 'city', fk: 'help-city' })}>Request a city</button>`,
    `<button class="linkbtn" ${shelfAttrs({ kind: 'support', fk: 'help-support' })}>Support</button>`,
  ].join(' · ');
  return `<footer class="trust${inDoor ? '' : ' wrap'}">${cover ? `<p class="fine foot-line">${cover}</p>` : ''}
    <p class="fine foot-line foot-acts">${links}</p>
  </footer>`;
}
