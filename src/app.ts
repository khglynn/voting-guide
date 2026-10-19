/* The app's flows: loading data, opening a ballot (saved picks, save links, the restore prompt),
   the ZIP box, the Census address lookup, views and the browser's Back button, and the hidden
   "try as" scenarios. */
import type { Index, PlaceBundle, StateBundle, Contest } from './types';
import { S, emptyBallotState, persist, savedBallot, parseShareHead, decodeShare, normalizeRanks, type BallotState, type View } from './state';
import { buildBallot, contestDistrict, entriesBySection, status, isRCV, isMultiSeat, isMultiJudge, rankMax } from './ballot';
import { zipState, censusLookup, placeFromGeo, type GeoResult } from './geo';
import { toast } from './util';
import { render, renderBallot, renderAddr, $ } from './render';
import { setInvolved, type GetInvolved } from './views/pass';
import { planAgree, applyFills, planParty, forgetUndo } from './model/bulk';
import { partiesOnBallot, toggleChip } from './model/lens';

/* ---------- data ---------- */
const BASE = import.meta.env.BASE_URL || '/';
const cache = new Map<string, Promise<unknown>>();
export function getJSON<T>(path: string): Promise<T> {
  if (!cache.has(path)) {
    const p = fetch(`${BASE}data/${path}`, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${path}`);
      return r.json();
    });
    p.catch(() => cache.delete(path));
    cache.set(path, p);
  }
  return cache.get(path) as Promise<T>;
}
export async function ensureIndex(): Promise<Index> {
  if (!S.index) S.index = await getJSON<Index>('index.json');
  return S.index;
}
/* Optional: ways to get involved, from the data track. A missing file is normal. */
let involvedTried = false;
export async function loadInvolved(): Promise<void> {
  if (involvedTried || !S.index || !S.index.involved) return;
  involvedTried = true;
  try {
    const r = await fetch(`${BASE}data/get-involved.json`, { cache: 'no-cache' });
    if (r.ok) setInvolved(await r.json() as GetInvolved);
  } catch { /* none yet */ }
}

/* ---------- views and the Back button ---------- */
export function resetUI(): void {
  const u = S.ui;
  u.view = 'ballot'; u.row = null; u.page = {}; u.others.clear(); u.folded.clear(); u.unfolded.clear(); u.keep = null;
  u.noteOpen.clear(); u.reader = null; u.sheet = null; u.sheetFrom = null; u.addrOpen = false; u.addrMsg = null; u.saveOpen = false; u.copyFallback = null; u.bulk = null;
  u.open.delete('voted');
}
export function go(view: View, push = true): void {
  if (S.ui.view === view) return;
  S.ui.view = view;
  S.ui.reader = null; S.ui.sheet = null;
  if (push) { try { history.pushState({ vg: view }, '', location.pathname + location.search); } catch { /* ignore */ } }
  render();
  if (view === 'cheat') render(['print']);
  window.scrollTo(0, 0);
  if (view === 'pass') void loadInvolved().then(() => { if (S.ui.view === 'pass') render(['pass']); });
}
export function openReader(id: string, push = true): void {
  S.ui.reader = id;
  if (push) { try { history.pushState({ vg: S.ui.view, reader: id }, '', location.pathname + location.search); } catch { /* ignore */ } }
  render(['sheet']);
  document.body.classList.add('sheet-open');
  ($('[data-fk="reader-x"]'))?.focus({ preventScroll: true });
}
window.addEventListener('popstate', (e) => {
  if (!S.ballot) return;
  const st = (e.state || {}) as { vg?: View; reader?: string };
  const view = st.vg || 'ballot';
  const fromReader = S.ui.reader;
  S.ui.reader = st.reader || null;
  S.ui.sheet = null;
  if (view !== S.ui.view) { S.ui.view = view; render(); window.scrollTo(0, 0); }
  else render(['sheet']);
  if (fromReader && !S.ui.reader) document.querySelector<HTMLElement>(`[data-fk="rd-${CSS.escape(fromReader)}"]`)?.focus({ preventScroll: true });
});

/* ---------- opening a ballot ---------- */
const countPicks = (b: BallotState): number => Object.keys(b.picks).length + Object.keys(b.ranks || {}).filter((k) => !(k in b.picks)).length;
/* Resolves true once the ballot is open, false when it couldn't load (the start view then
   shows why). Callers that do more after opening check it. */
export async function openBallot(st: string, placeIds: string[], zip: string, opts: { share?: ReturnType<typeof parseShareHead> } = {}): Promise<boolean> {
  S.view = 'loading';
  S.loadErr = null;
  render(['mast']);
  try {
    await ensureIndex();
    const [sb, ...pbs] = await Promise.all([getJSON<StateBundle>(`state-${st}.json`), ...placeIds.map((id) => getJSON<PlaceBundle>(`place-${id}.json`))]);
    const ballot = buildBallot(sb, pbs);
    S.ballot = ballot;
    forgetUndo();
    const existing = S.tryMode ? null : savedBallot(ballot.key);
    const reopened = existing ? normalizeRanks(ballot, existing) : 0;
    S.b = existing || emptyBallotState(zip);
    if (zip) S.b.zip = zip;
    S.pending = null;
    if (reopened && !opts.share) toast(`${reopened === 1 ? 'A race you marked is' : `${reopened} races you marked are`} ranked choice now. Rank your picks there again.`);
    if (opts.share && !S.tryMode) {
      const { state, dropped } = decodeShare(ballot, opts.share);
      normalizeRanks(ballot, state);
      const n = countPicks(state);
      const m = existing ? countPicks(existing) : 0;
      const same = existing && JSON.stringify(existing.picks) === JSON.stringify(state.picks) && JSON.stringify(existing.notes) === JSON.stringify(state.notes)
        && JSON.stringify(existing.ranks) === JSON.stringify(state.ranks);
      if (existing && m > 0 && !same) {
        S.pending = { kind: 'restore', key: ballot.key, incoming: state, summary: `This link has ${n} ${n === 1 ? 'pick' : 'picks'}. This device already has ${m} saved for this ballot. Which do you want to keep?` };
      } else {
        S.b = state;
        toast(`Restored ${n} ${n === 1 ? 'pick' : 'picks'} from your link.${dropped ? ` ${dropped} couldn’t be matched to today’s data.` : ''}`);
      }
      try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ }
    }
    if (S.tryMode) applyScenario(S.tryMode);
    S.view = 'ballot';
    S.zipChoice = null;
    S.coverage = null;
    resetUI();
    render();
    persist(true);
    window.scrollTo(0, 0);
    if (S.pending) $('[data-fk="restore-yes"]')?.focus();
    return true;
  } catch (e) {
    console.warn('Could not load ballot', e);
    S.view = 'start';
    S.ballot = null;
    S.loadErr = 'We couldn’t load that ballot. Check your connection and try again.';
    render();
    return false;
  }
}

export async function submitZip(raw: string): Promise<void> {
  const v = String(raw || '').replace(/\D/g, '');
  S.zip = v; S.zipErr = ''; S.zipChoice = null; S.coverage = null; S.loadErr = null;
  if (v.length !== 5) { S.zipErr = 'Enter all 5 digits, like 80205.'; render(['mast']); $('#zip')?.focus(); return; }
  let idx: Index;
  try { idx = await ensureIndex(); } catch { S.loadErr = 'We couldn’t reach the guide’s data. Check your connection and try again.'; render(['mast']); return; }
  const places = idx.zips[v] || [];
  if (places.length === 1) { await openBallot(idx.places[places[0]].state, places, v); return; }
  if (places.length > 1) { S.zipChoice = { zip: v, placeIds: places }; S.ui.addrOpen = false; render(['mast']); $(`[data-fk="cp-${CSS.escape(places[0])}"]`)?.focus(); return; }
  const st = zipState(v);
  if (st && idx.states[st]) { await openBallot(st, [], v); return; }
  if (!st) { S.zipErr = 'We couldn’t find that ZIP. Check the digits and try again.'; render(['mast']); $('#zip')?.focus(); return; }
  S.coverage = { kind: 'not_covered', state: st, zip: v };
  render(['mast']);
}

/* ---------- address lookup ----------
   The address goes only to the Census geocoder and is never stored. Picking a place from the
   result lives in geo.ts (placeFromGeo), where the state must match before anything else. */
export async function runAddress(addr: string): Promise<void> {
  const choosing = S.view !== 'ballot' && S.zipChoice;
  const b = S.ballot;
  if (!b && !choosing) return;
  if (addr.trim().length < 6) { S.ui.addrMsg = 'Enter a street address with the city or ZIP.'; renderAddr(); return; }
  S.ui.addrBusy = true; S.ui.addrMsg = null; renderAddr();
  let r: GeoResult | null;
  try { r = await censusLookup(addr.trim()); }
  catch { S.ui.addrBusy = false; S.ui.addrMsg = 'The Census lookup didn’t answer. Try again, or answer the questions yourself.'; renderAddr(); return; }
  S.ui.addrBusy = false;
  if (!r) { S.ui.addrMsg = 'The Census lookup couldn’t find that address. Try adding the city and ZIP.'; renderAddr(); return; }
  if (choosing && S.zipChoice) {
    const idx = S.index!;
    const ids = S.zipChoice.placeIds;
    const hit = placeFromGeo(idx.places, ids, r);
    if (!hit) {
      const st = idx.places[ids[0]]?.state;
      S.ui.addrMsg = r.state && st && ids.every((id) => idx.places[id].state !== r.state)
        ? `That address is outside ${idx.states[st]?.name || st}. Check the ZIP, or pick a place below.`
        : 'That address didn’t match one of these places. Pick one, or “I’m not sure”.';
      renderAddr(); return;
    }
    const zip = S.zipChoice.zip;
    S.ui.addrOpen = false;
    if (await openBallot(idx.places[hit].state, [hit], zip)) applyGeo(r);
    return;
  }
  if (!b) return;
  if (r.state && r.state !== b.st) { S.ui.addrMsg = `That address is outside ${b.stateName}. Change your ZIP first.`; renderAddr(); return; }
  if (b.places.length > 1) {
    const hit = placeFromGeo(S.index!.places, b.places.map((p) => p.id), r);
    if (hit) { if (await openBallot(b.st, [hit], S.b.zip)) applyGeo(r); return; }
  }
  applyGeo(r);
}
export function applyGeo(r: { cd: number | null; upper: number | null; lower: number | null; state?: string | null }): void {
  const b = S.ballot!;
  const num = (k: 'cd' | 'upper' | 'lower') => (b.st === 'DC' && k === 'upper' ? null : r[k]);
  let answered = 0;
  for (const g of b.groups) {
    if (!g.kind || num(g.kind) == null) continue;
    const hit = g.members.find((id) => contestDistrict(b.byId.get(id) as Contest).n === num(g.kind!));
    S.b.districts[g.key] = hit || 'none';
    answered++;
  }
  for (const id of b.mayApply) {
    const c = b.byId.get(id);
    if (!c || c.kind !== 'contest') continue;
    const d = contestDistrict(c);
    if (!d.kind || num(d.kind) == null) continue;
    S.b.notMine = S.b.notMine.filter((x) => x !== id);
    if (d.n !== num(d.kind)) S.b.notMine.push(id);
    answered++;
  }
  const parts = [r.cd != null ? `Congressional District ${r.cd}` : '', r.upper != null ? (b.st === 'DC' ? `Ward ${r.upper}` : `State Senate ${r.upper}`) : '', r.lower != null ? `State House ${r.lower}` : ''].filter(Boolean);
  S.b.addrNote = parts.length ? `From the address you entered: ${parts.join(', ')}. We didn’t keep the address. Double-check with your sample ballot.` : null;
  S.ui.addrOpen = false;
  S.ui.addrMsg = null;
  render();
  persist();
  toast(answered ? `Matched ${answered} district ${answered === 1 ? 'question' : 'questions'} from your address.` : 'Found your address. None of the questions here depend on it.');
}

/* ---------- "try as": scenarios for feeling the guide, never saved ---------- */
function applyScenario(kind: string): void {
  const b = S.ballot!;
  S.b = emptyBallotState(S.b.zip);
  b.groups.forEach((g) => { S.b.districts[g.key] = g.members[0]; });
  if (kind === 'fresh') return;
  if (kind === 'sources') { toggleChip(b, 'progressive'); toggleChip(b, 'conservative'); return; }
  if (kind === 'straight') {
    const p = partiesOnBallot(b).sort((x, y) => y.nominees - x.nominees)[0];
    if (p) { S.b.party = p.party; applyFills(planParty(p.party).fills); forgetUndo(); }
    return;
  }
  if (kind === 'aunt') {
    // Everything decided but the measures: her sources where they agree, then the first name.
    applyFills(planAgree().fills.filter((f) => b.byId.get(f.id)?.kind !== 'measure'));
    for (const [, entries] of entriesBySection()) {
      for (const e of entries) {
        if (e.t !== 'item') continue;
        const it = b.byId.get(e.id)!;
        if (it.kind !== 'contest' || status(it) !== 'open') continue;
        if (isMultiJudge(it)) it.candidates.forEach((c) => { S.b.picks[`${it.id}|${c.name}`] = 'YES'; });
        else if (it.is_retention) S.b.picks[it.id] = 'YES';
        else if (isRCV(it)) { S.b.ranks[it.id] = it.candidates.slice(0, Math.min(2, rankMax(it))).map((c) => c.name); S.b.picks[it.id] = 'DONE'; }
        else if (isMultiSeat(it)) { it.candidates.slice(0, it.vote_for).forEach((c) => { S.b.picks[`${it.id}|${c.name}`] = 'PICK'; }); }
        else if (it.candidates[0]) S.b.picks[it.id] = it.candidates[0].name;
      }
    }
    forgetUndo();
  }
}
export { renderBallot };
