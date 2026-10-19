/* Model checks for the ledger's own modules (lens, verdict, bulk fills, judges, plan, labels).
   Run by tests/model.mjs, which loads the TypeScript and hands over `check`. */
export async function run({ st, bl, mods, open, head, read, INDEX, check }) {
  const { lens, tally, bulk, judges, labels } = mods;
  const plan = mods.plan;
  const S = st.S;

  /* ---------- notMine in the save link ---------- */
  {
    const ballot = open('CO', ['lakewood-co']);
    const may = [...ballot.mayApply];
    check('notMine: Lakewood has May apply races to say no to', may.length > 0, String(may.length));
    const b = st.emptyBallotState('80226');
    b.picks['co-amendment-81'] = 'NO';
    b.notMine = [may[0]];
    const link = st.encodeShare(ballot, b);
    const f = link.split('~');
    check('notMine: written as a 10th field after an empty ranks field, head stays v1', f[0] === 'v1' && f.length === 10 && f[8] === '' && f[9].length === 5, link);
    const { state } = st.decodeShare(ballot, head(link));
    check('notMine: comes back from the link', state.notMine.join() === may[0]);
    b.notMine = [];
    check('notMine: none written means the link is the old 8 fields', st.encodeShare(ballot, b).split('~').length === 8);
    // An old client reads fields by position: picks still decode with the 10-field link.
    check('notMine: picks still decode beside it', state.picks['co-amendment-81'] === 'NO');
  }

  /* ---------- the seat rule ---------- */
  {
    const h = open('TX', ['houston-tx']);
    check('seats: Klein ISD positions are not a district question', !h.groups.some((g) => /Klein ISD/.test(g.key)));
    check('seats: both Klein ISD positions are on the ballot as May apply', ['tx-kleinisd-trustee-1', 'tx-kleinisd-trustee-2'].every((id) => h.mayApply.has(id)));
    check('seats: Houston still asks real district questions', h.groups.length >= 6, String(h.groups.length));
    const t = open('FL', ['tallahassee-fl']);
    check('seats: Tallahassee City Commission seats are not a question', !t.groups.some((g) => /City Commissioner/.test(g.key)));
  }

  /* ---------- lenses ---------- */
  {
    const b = open('CO', ['lakewood-co']);
    const papers = lens.chipMembers(b, 'papers');
    check('lens: Papers and guides are publications and civic groups only', papers.length > 0 && papers.every((e) => e.type === 'publication' || e.type === 'civic_nonpartisan'));
    check('lens: Papers and guides equal the default sources', papers.map((e) => e.id).sort().join() === b.endorsers.filter((e) => e.default_on).map((e) => e.id).sort().join());
    const prog = lens.chipMembers(b, 'progressive');
    check('lens: Progressive groups lean left, never a party or a paper', prog.length > 0 && prog.every((e) => ['left', 'lean_left'].includes(e.lean) && e.type !== 'party' && e.type !== 'publication'));
    const cons = lens.chipMembers(b, 'conservative');
    check('lens: Conservative groups lean right, never a party or a paper', cons.every((e) => ['right', 'lean_right'].includes(e.lean) && e.type !== 'party' && e.type !== 'publication'));
    check('lens: default chip state is on', lens.chipState(b, 'papers') === 'on');
    lens.toggleChip(b, 'progressive');
    check('lens: turning a chip on adds its members to the saved list', prog.every((e) => S.b.sources.includes(e.id)));
    lens.toggleChip(b, 'progressive');
    check('lens: turning it off again returns to the defaults (null, short link)', S.b.sources === null);
    lens.toggleChip(b, 'papers');
    check('lens: turning Papers off leaves an explicit empty list', Array.isArray(S.b.sources) && S.b.sources.length === 0);
    const parties = lens.partiesOnBallot(b).map((p) => p.party);
    check('lens: Colorado parties include Democratic, Republican, Working Families', ['Democratic', 'Republican', 'Working Families'].every((p) => parties.includes(p)), parties.join(', '));
    const jd = b.eById.get('jeffco-democrats');
    if (jd) check('lens: "Jefferson County Democratic Party" speaks for Democratic', lens.partyOf(jd, b) === 'Democratic');
    const ny = open('NY', ['nyc-brooklyn-ny']);
    const nyp = lens.partiesOnBallot(ny).map((p) => p.party);
    check('lens: New York lists four parties', ['Conservative', 'Democratic', 'Republican', 'Working Families'].every((p) => nyp.includes(p)), nyp.join(', '));
    const dc = open('DC', ['dc-ward-1']);
    const dcp = lens.partiesOnBallot(dc).map((p) => p.party);
    check('lens: DC lists the Statehood Green party by its ballot name', dcp.some((p) => /Statehood Green/.test(p)), dcp.join(', '));
    // Choosing a party turns its sources on and back off.
    const co = open('CO', ['lakewood-co']);
    lens.setParty(co, 'Democratic');
    const dem = lens.partiesOnBallot(co).find((p) => p.party === 'Democratic');
    check('lens: choosing a party turns on its sources', dem.sources.every((e) => S.b.sources.includes(e.id)) && S.b.party === 'Democratic');
    lens.setParty(co, null);
    check('lens: clearing the party returns to the defaults', S.b.sources === null && S.b.party === null);
  }

  /* ---------- the verdict, for every state of a lineup ---------- */
  {
    const b = open('CO', ['lakewood-co']);
    const it = b.byId.get('co-amendment-81');
    const [e1, e2, e3] = b.endorsers.filter((e) => e.default_on && e.endorses_measures).slice(0, 3);
    S.b.sources = [e1.id, e2.id, e3.id];
    const set = (rows) => { b.ends[it.id] = rows; tally.clearLineups(); };
    const row = (s, c = null) => ({ s, c, note: null, why: null, url: 'https://example.org', date: null, conf: 'verified' });
    set({ [e1.id]: row('endorsed', ['NO']), [e2.id]: row('endorsed', ['NO']) });
    let v = tally.verdict(it);
    check('verdict: two sources agree is sage "agree" with the choice and their names', v.kind === 'agree' && v.main === 'No' && v.sub.includes(tally.tagOf(e1)), JSON.stringify(v));
    set({ [e1.id]: row('endorsed', ['NO']), [e2.id]: row('endorsed', ['YES']) });
    v = tally.verdict(it);
    check('verdict: a disagreement names the lineup, not "Sources split"', v.kind === 'split' && /no/.test(v.main) && /yes/.test(v.main) && !/split/i.test(v.main), JSON.stringify(v));
    set({ [e1.id]: row('no_position'), [e2.id]: row('no_position') });
    v = tally.verdict(it);
    check('verdict: all took no stand', v.kind === 'none' && v.why === 'no_stand' && v.main === 'Took no stand', JSON.stringify(v));
    set({ [e1.id]: row('not_found'), [e2.id]: row('no_position') });
    v = tally.verdict(it);
    check('verdict: nothing found', v.kind === 'none' && v.why === 'not_found', JSON.stringify(v));
    set({});
    v = tally.verdict(it);
    check('verdict: sources that cover this area but have no row: not checked yet', v.kind === 'none' && v.why === 'not_checked', JSON.stringify(v));
    S.b.sources = [];
    tally.clearLineups();
    v = tally.verdict(it);
    check('verdict: no sources chosen says so', v.kind === 'none' && v.why === 'no_sources', JSON.stringify(v));
    S.b.sources = [e1.id];
    S.b.picks[it.id] = 'YES';
    set({ [e1.id]: row('endorsed', ['NO']) });
    v = tally.verdict(it);
    check('verdict: your pick replaces the verdict, sources beneath', v.kind === 'mine' && v.main === 'Yes' && /no/.test(v.sub), JSON.stringify(v));
    delete S.b.picks[it.id];
    // Four sources: a tally with direction, leading side first.
    const four = b.endorsers.filter((e) => e.endorses_measures).slice(0, 5);
    S.b.sources = four.map((e) => e.id);
    set(Object.fromEntries(four.map((e, i) => [e.id, row('endorsed', [i < 3 ? 'YES' : 'NO'])])));
    v = tally.verdict(it);
    check('verdict: more than three sources shows a tally, leading side first', v.kind === 'split' && /^Yes 3, No [12]/.test(v.main), JSON.stringify(v));
  }

  /* ---------- bulk fills and undo ---------- */
  {
    const b = open('CO', ['lakewood-co']);
    const plan1 = bulk.planAgree();
    check('agree fill: finds rows on the default Lakewood lens', plan1.fills.length > 0, String(plan1.fills.length));
    const ok = plan1.fills.every((f) => {
      const l = tally.lineup(b.byId.get(f.id));
      return l.groups.length === 1 && !l.both.length;
    });
    check('agree fill: only rows where every source that weighed in agrees', ok);
    const before = JSON.stringify(S.b.picks);
    bulk.applyFills(plan1.fills);
    check('agree fill: fills those rows and marks them filled', plan1.fills.every((f) => Object.keys(f.set).every((k) => S.b.picks[k] === f.set[k]) && S.b.auto[f.id]));
    check('agree fill: a second pass has nothing left to fill', bulk.planAgree().fills.length === 0);
    bulk.undoFills();
    check('agree fill: Undo restores every pick exactly', JSON.stringify(S.b.picks) === before);
    // Never a ranked race.
    const p = open('OR', ['portland-or']);
    S.b.sources = p.endorsers.map((e) => e.id);
    const g = p.groups.find((x) => /Council/.test(x.key));
    if (g) S.b.districts[g.key] = '*';
    const pf = bulk.planAgree();
    check('agree fill: never touches a ranked-choice race', !pf.fills.some((f) => p.byId.get(f.id).ranked_choice));
    // Party fill reads normalized parties: Portland's display text says "Democrat".
    const party = bulk.planParty('Democratic');
    check('party fill: finds Democratic races in Portland (display text says "Democrat")', party.fills.length > 0, String(party.fills.length));
    check('party fill: never fills a ranked race, counts them instead', !party.fills.some((f) => p.byId.get(f.id).ranked_choice));
    // Top-two: LA has races with two candidates of one party.
    const la = open('CA', ['los-angeles-ca']);
    la.groups.forEach((x) => { S.b.districts[x.key] = '*'; });
    const lap = bulk.planParty('Democratic');
    check('party fill: skips races where the party has two candidates (top-two)', lap.skippedTwo > 0 && lap.fills.every((f) => {
      const c = la.byId.get(f.id); return c.candidates.filter((k) => k.parties.includes('Democratic')).length === 1 || c.vote_for > 1;
    }), `${lap.skippedTwo} skipped`);
  }

  /* ---------- judges ---------- */
  {
    const b = open('CO', ['lakewood-co']);
    const rets = b.items.filter((i) => i.kind === 'contest' && i.is_retention && i.candidates.length === 1).slice(0, 3);
    const ev = (verdict, vote, concern = null) => ({ by: 'First Judicial District Commission on Judicial Performance', by_short: 'Commission', kind: 'official_commission', rating: verdict === 'favorable' ? 'Meets Performance Standards' : 'Does Not Meet Performance Standards', verdict, vote, survey: null, noted_strength: 'Prepared.', noted_concern: concern, url: 'https://judicialperformance.colorado.gov/', verified_on: '2026-10-19', confidence: 'verified' });
    const saved = rets.map((r) => r.candidates[0].evaluations);
    rets[0].candidates[0].evaluations = [ev('favorable', '10-0')];
    rets[1].candidates[0].evaluations = [ev('favorable', '7-1', 'At times can be critical.')];
    rets[2].candidates[0].evaluations = [ev('unfavorable', '2-8')];
    const r0 = judges.judgeReview(rets[0]);
    check('judges: a review reads as the commission’s rating, in a sentence', r0 && r0.main === 'Meets standards' && /voted 10-0 that Judge \S+ meets performance standards/.test(r0.line), r0 && r0.line);
    const v0 = tally.verdict(rets[0]);
    check('judges: the row verdict is the review, not a source color', v0.kind === 'review', JSON.stringify(v0));
    const jb = judges.judgeBatch();
    check('judges: the batch keeps judges the review favors, not the one it doesn’t', jb && jb.targets.some((t) => t.id === rets[0].id) && jb.targets.some((t) => t.id === rets[1].id) && !jb.targets.some((t) => t.id === rets[2].id));
    check('judges: split votes and concerns are listed to read first', jb && jb.readFirst.some((x) => x.id === rets[1].id) && jb.readFirst.some((x) => x.id === rets[2].id));
    const pj = bulk.planJudges();
    bulk.applyFills(pj.fills);
    check('judges: the batch stores YES, as v2 does', S.b.picks[rets[0].id] === 'YES' && S.b.picks[rets[2].id] === undefined);
    bulk.undoFills();
    check('judges: Undo clears the batch', S.b.picks[rets[0].id] === undefined);
    rets.forEach((r, i) => { r.candidates[0].evaluations = saved[i]; });
  }

  /* ---------- plan strip ---------- */
  {
    const tx = read('state-TX.json').howto;
    const step = plan.nextStep(tx, '2026-10-19');
    const text = step.head.map((p) => p[0]).join('');
    check('plan: Texas on Oct 19 says early voting starts today', text === 'Early voting starts today, Oct 19.', text);
    const co = read('state-CO.json').howto;
    const cs = plan.nextStep(co, '2026-10-19');
    check('plan: Colorado says return your ballot, with the time and date', /^Return your ballot by 7 PM Tue, Nov 3\.$/.test(cs.head.map((p) => p[0]).join('')), cs.head.map((p) => p[0]).join(''));
    check('plan: Colorado mentions in-person voting opening today', cs.sub.some((x) => /opens today/.test(x)), cs.sub.join(' | '));
    const ca = read('state-CA.json').howto;
    const alert = plan.registrationAlert(ca, '2026-10-19');
    check('plan: California on Oct 19 warns registration closes today, then same-day', !!alert && /today/.test(alert) && /through Election Day/.test(alert), alert || '');
    check('plan: Election Day says polls close', /Polls close at/.test(plan.nextStep(tx, '2026-11-03').head.map((p) => p[0]).join('')));
    check('plan: after Election Day says voting has closed', plan.nextStep(co, '2026-11-04').phase === 'closed');
    check('plan: never a countdown', !/days? (left|until|to Election)/i.test(JSON.stringify([step, cs])));
  }

  /* ---------- titles: unique on every ballot the guide can show ---------- */
  {
    const views = [];
    for (const s of Object.keys(INDEX.states)) views.push([s, []]);
    for (const [id, p] of Object.entries(INDEX.places)) views.push([p.state, [id]]);
    const combos = new Set(Object.values(INDEX.zips).filter((l) => l.length > 1).map((l) => l.join('+')));
    for (const c of combos) views.push([INDEX.places[c.split('+')[0]].state, c.split('+')]);
    const dups = [];
    for (const [s, places] of views) {
      open(s, places);
      const seen = new Map();
      for (const it of S.ballot.items) { const t = labels.cheatTitle(it); if (seen.has(t)) dups.push(`${s}|${places.join('+')}: ${t}`); seen.set(t, it.id); }
    }
    check(`titles: every cheat-sheet title is unique on all ${views.length} ballots`, dups.length === 0, dups.slice(0, 4).join(' | '));
  }
}
