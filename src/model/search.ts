/* One forgiving matcher for every search box on the page: the sources sheet's names (views/lens.ts) and the
   plan's dates, ID and what-ifs (views/planstrip.ts). Kevin, Oct 28: "I don't care about search approach,
   just don't want folks to not find what they're looking for because of some small mismatch".

   A word you type finds a word in the text when, after case, accents and punctuation are set aside:
   - the text's word starts with it (so it finds as you type: "chron" finds Chronicle),
   - the two share a stem ("ballots", "voted", "registration" find "ballot", "vote", "register"),
   - it is a typo away: one letter off (added, missing, wrong or two swapped) from five letters on, two
     from eight ("ballto", "provisonal", "chronical"),
   - or it is an everyday word for the data's word ("absentee" finds mail, "never came" finds lost,
     "license" finds ID; WORDS below, written from the 16 questions every state's file shares).
   Words like "my", "the" and "what" are left out unless they're all you typed, and a phrase ("new address",
   "polling place") is found only as neighbors.
   `all` (the sources sheet: short names) wants every word typed. `best` (the what-ifs: a question, a quick
   answer and the full text) looks in the questions and quick answers first, the full text only when that
   finds nothing, and last the answers with most of what you typed, so a missing word never empties it. */

/* Lowercase, no accents, apostrophes gone ("can’t" is "cant"), everything else that isn't a letter or a
   digit a space. */
export const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’'`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const wordsOf = (s: string): string[] => fold(s).split(' ').filter(Boolean);

const STOP = new Set(['a', 'an', 'the', 'i', 'im', 'ive', 'my', 'me', 'mine', 'to', 'of', 'and', 'or', 'in', 'on', 'at', 'for', 'from', 'is', 'it', 'its', 'do', 'does', 'did', 'be', 'been', 'can', 'could', 'what', 'whats', 'how', 'if', 'when', 'where', 'who', 'why', 'was', 'am', 'are', 'with', 'about', 'get', 'got', 'need', 'should', 'would', 'will', 'have', 'has', 'had', 'so', 'this', 'that', 'there', 'than', 'then', 'any', 'some', 'just', 'still', 'you', 'your', 'we', 'our', 'they', 'their', 'not']);

/* A light stem: plurals and the usual endings off, so "ballots", "voting" and "registered" meet "ballot",
   "vote" and "register". Never shorter than three letters. */
export function stem(w: string): string {
  if (w.length <= 3 || /\d/.test(w)) return w;
  let s = w;
  if (/ies$/.test(s) && s.length > 4) s = `${s.slice(0, -3)}y`;
  else if (/(sses|xes|ches|shes)$/.test(s)) s = s.slice(0, -2);
  else if (/[^su]s$/.test(s)) s = s.slice(0, -1);
  for (const end of ['ations', 'ation', 'ments', 'ment', 'ings', 'ing', 'ions', 'ion', 'ers', 'er', 'ed', 'ly']) {
    if (s.endsWith(end) && s.length - end.length >= 3) { s = s.slice(0, -end.length); break; }
  }
  if (s.endsWith('e') && s.length > 3) s = s.slice(0, -1);
  return s;
}

/* Letters to turn one word into the other (a swap of two neighbors counts as one), stopping past `max`. */
export function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let low = max + 1;
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      low = Math.min(low, d[i][j]);
    }
    if (low > max) return max + 1;
  }
  return d[a.length][b.length];
}
const typos = (n: number): number => (n >= 8 ? 2 : n >= 5 ? 1 : 0);

/* Everyday words for the data's words. Each line is one idea; a word or phrase typed that's on a line
   finds any other on it. Phrases match word by word. */
const WORDS: string[][] = [
  ['mail', 'mailin', 'absentee', 'by mail', 'postal', 'mail ballot', 'ballot by mail'],
  ['lost', 'missing', 'never came', 'never arrived', 'didnt come', 'didnt arrive', 'didnt get', 'hasnt come', 'havent got', 'not received', 'replacement', 'replace'],
  ['polling place', 'polling location', 'vote center', 'voting site', 'voting location', 'precinct', 'where to vote', 'where do i vote', 'where can i vote', 'where should i vote', 'location', 'site'],
  ['id', 'identification', 'license', 'drivers license', 'passport', 'photo id'],
  ['moved', 'move', 'moving', 'new address', 'change of address', 'address change', 'relocated', 'new home', 'residence'],
  ['register', 'registration', 'registered', 'sign up', 'signup', 'enroll'],
  ['deadline', 'last day', 'due', 'cutoff'],
  ['mistake', 'error', 'wrong', 'messed up', 'spoiled', 'damaged', 'ruined', 'torn'],
  ['provisional', 'affidavit', 'backup ballot'],
  ['signature', 'cure', 'signed'],
  ['name changed', 'name change', 'married', 'maiden', 'divorced'],
  ['college', 'student', 'university', 'campus', 'dorm'],
  ['away', 'travel', 'traveling', 'out of town', 'vacation', 'trip', 'not home', 'out of state'],
  ['line', 'wait', 'queue', 'polls close', 'closing', 'close'],
  ['track', 'tracker', 'tracking', 'status', 'was counted', 'ballot counted', 'did it count', 'did my ballot count'],
  ['early', 'early voting', 'vote early', 'before election day'],
  ['drop box', 'dropbox', 'drop off', 'return'],
  ['phone', 'phones', 'cell', 'cellphone', 'camera', 'selfie'],
  ['notes', 'cheat sheet', 'list'],
  ['wear', 'shirt', 'hat', 'clothes', 'apparel', 'button'],
  ['election office', 'county office', 'supervisor', 'clerk', 'registrar', 'elections office', 'contact', 'call'],
  ['lookup', 'cant find', 'not found', 'purged', 'not listed', 'not on the list'],
  ['disability', 'disabled', 'accessible', 'accessibility', 'wheelchair', 'assistance'],
].map((g) => g.map((p) => wordsOf(p).join(' ')));
const IDEAS: string[][][] = WORDS.map((g) => g.map((p) => p.split(' ')));

/* A text, read once: its words and their stems (and, for a name, the whole thing run together, so "aflcio"
   finds the AFL-CIO). */
export interface Text { words: string[]; stems: string[]; joined: string }
export function textOf(s: string): Text {
  const words = wordsOf(s);
  return { words, stems: words.map(stem), joined: words.join('') };
}

/* What was typed, read once: one idea per word or phrase, each with the ways it can be found. */
interface Idea { alts: string[][]; own: string }
export interface Query { ideas: Idea[]; raw: string }
/* A word on a line of WORDS and a word typed: the same, the same stem, or a typo away from five letters. */
const sameWord = (a: string, b: string): boolean => a === b || stem(a) === stem(b) || (b.length >= 5 && distance(a, b, typos(b.length)) <= typos(b.length));
export function queryOf(q: string): Query | null {
  const all = wordsOf(q);
  if (!all.length) return null;
  const keep = all.some((w) => !STOP.has(w));
  const ideas: Idea[] = [];
  for (let i = 0; i < all.length;) {
    // The longest phrase on a line of WORDS that starts here ("never came", "out of town").
    let len = 0;
    let lines: number[] = [];
    IDEAS.forEach((g, gi) => g.forEach((p) => {
      if (p.length > all.length - i || p.length < len) return;
      if (!p.every((w, k) => sameWord(w, all[i + k]))) return;
      if (p.length > len) { len = p.length; lines = []; }
      if (!lines.includes(gi)) lines.push(gi);
    }));
    if (len > 1 || (len === 1 && !(keep && STOP.has(all[i])))) {
      const own = all.slice(i, i + len).join(' ');
      ideas.push({ own, alts: [own.split(' '), ...lines.flatMap((gi) => IDEAS[gi])] });
      i += len;
      continue;
    }
    if (!(keep && STOP.has(all[i]))) ideas.push({ own: all[i], alts: [[all[i]]] });
    i += 1;
  }
  return ideas.length ? { ideas, raw: q } : null;
}

/* One word you typed against the text's word at `i`: as you type, by stem, or a typo away (your own words
   only, never a synonym's). */
function wordAt(w: string, t: Text, i: number, fuzzy: boolean): boolean {
  const x = t.words[i];
  if (x === undefined) return false;
  const ws = stem(w);
  if (x.startsWith(w) || t.stems[i] === ws) return true;
  // Stems that run into each other ("registr", "regist"), from five letters.
  if (ws.length >= 5 && t.stems[i].length >= 5 && (ws.startsWith(t.stems[i]) || t.stems[i].startsWith(ws))) return true;
  const n = fuzzy ? typos(w.length) : 0;
  return !!n && (distance(w, x, n) <= n || (x.length > w.length && distance(w, x.slice(0, w.length), n) <= n));
}
/* A word anywhere, or a phrase as neighbors. */
function altIn(alt: string[], t: Text, fuzzy: boolean): boolean {
  for (let i = 0; i + alt.length <= t.words.length; i++) if (alt.every((w, k) => wordAt(w, t, i + k, fuzzy))) return true;
  return false;
}
function ideaIn(idea: Idea, t: Text, joined: boolean): boolean {
  return idea.alts.some((alt, k) => altIn(alt, t, k === 0) || (joined && k === 0 && alt.join('').length >= 3 && t.joined.includes(alt.join(''))));
}
/* How many of the ideas typed a text has. */
export function score(q: Query, t: Text, joined = false): number {
  return q.ideas.filter((idea) => ideaIn(idea, t, joined)).length;
}
/* Every idea typed is in the text (a name, so run-together words count too). */
export const all = (q: Query | null, t: Text): boolean => !q || score(q, t, true) === q.ideas.length;

/* The what-ifs: which items to show, in their own order. Each has a head (its question, or what it's about,
   and its quick answer) and a body (the full text behind "More"). First every item whose head has all you
   typed; if none, every item whose head and body together do; if none, the items with the most of it, where a
   word under three letters doesn't count on its own (a stray "b" would find half the page). */
export interface Item { head: Text; body: Text }
export function best(q: Query, items: Item[]): { shown: number[]; inBody: Set<number> } {
  const n = q.ideas.length;
  const head = items.map((x) => score(q, x.head));
  const idx = items.map((_, i) => i);
  let shown = idx.filter((i) => head[i] === n);
  const inBody = new Set<number>();
  if (shown.length) return { shown, inBody };
  const found = (i: number, ideas: Idea[]) => ideas.filter((idea) => ideaIn(idea, items[i].head, false) || ideaIn(idea, items[i].body, false)).length;
  shown = idx.filter((i) => found(i, q.ideas) === n);
  if (!shown.length) {
    const real = q.ideas.filter((idea) => idea.own.replace(/ /g, '').length >= 3);
    const counts = idx.map((i) => found(i, real));
    const top = Math.max(0, ...counts);
    shown = top ? idx.filter((i) => counts[i] === top) : [];
  }
  // These were found, at least in part, behind "More", so they show their full text.
  shown.forEach((i) => { if (head[i] < n) inBody.add(i); });
  return { shown, inBody };
}
