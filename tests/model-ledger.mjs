/* Model checks for the ledger's own modules (lens, verdict, bulk fills, judges, plan, labels).
   Run by tests/model.mjs, which loads the TypeScript and hands over `check`. */
export async function run({ st, bl, geo, mods, open, head, read, INDEX, check }) {
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
    // Codex #7: "Took no stand" only when every source that covers this took no stand.
    set({ [e1.id]: row('no_position'), [e2.id]: row('no_position') });
    v = tally.verdict(it);
    check('verdict: two took no stand and one is not checked yet is mixed, with the counts', v.kind === 'none' && v.why === 'mixed' && v.main === 'No picks yet' && v.sub === '2 took no stand, 1 not checked yet', JSON.stringify(v));
    S.b.sources = [e1.id, e2.id];
    tally.clearLineups();
    v = tally.verdict(it);
    check('verdict: all took no stand', v.kind === 'none' && v.why === 'no_stand' && v.main === 'Took no stand', JSON.stringify(v));
    set({ [e1.id]: row('not_found'), [e2.id]: row('not_found') });
    v = tally.verdict(it);
    check('verdict: nothing found', v.kind === 'none' && v.why === 'not_found', JSON.stringify(v));
    set({ [e1.id]: row('not_found'), [e2.id]: row('no_position') });
    v = tally.verdict(it);
    check('verdict: one found nothing and one took no stand is mixed', v.why === 'mixed' && /1 took no stand/.test(v.sub) && /nothing found for 1/.test(v.sub), JSON.stringify(v));
    S.b.sources = [e1.id, e2.id, e3.id];
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

  /* ---------- Codex #6: the same set of names in a different order is agreement ---------- */
  {
    const sea = open('WA', ['seattle-wa']);
    S.b.sources = ['king-county-democrats', 'fuse-washington'];
    tally.clearLineups();
    const it = sea.byId.get('wa-hd-32-2');
    const v = tally.verdict(it);
    check('verdict: King County Democrats (Davis, Siddiqi) and Fuse (Siddiqi, Davis) agree', v.kind === 'agree' && /Davis.*Siddiqi/.test(v.main) && tally.lineup(it).groups.length === 1, JSON.stringify(v));
    // A ranking keeps its order: two different rankings of the same names are a split.
    const rcv = sea.items.concat(open('OR', ['portland-or']).items).find((x) => x.kind === 'contest' && x.ranked_choice && x.candidates.length >= 2);
    if (rcv) {
      const pb = S.ballot;
      const [a, c] = [rcv.candidates[0].name, rcv.candidates[1].name];
      const [s1, s2] = pb.endorsers.slice(0, 2);
      S.b.sources = [s1.id, s2.id];
      const keep = pb.ends[rcv.id];
      pb.ends[rcv.id] = { [s1.id]: { s: 'endorsed', c: [a, c] }, [s2.id]: { s: 'endorsed', c: [c, a] } };
      tally.clearLineups();
      check('verdict: in a ranked race, a different ranking is a different pick', tally.lineup(rcv).groups.length === 2);
      pb.ends[rcv.id] = keep;
      tally.clearLineups();
    }
    check('verdict: the test found a ranked race to try', !!rcv);
    // UX review #3: Multnomah County Chair read "Singleton, Brim-Edwards, Meieran 1, Singleton 1, ...".
    {
      const pd = open('OR', ['portland-or']);
      pd.groups.forEach((x) => { S.b.districts[x.key] = '*'; });
      const races = pd.items.filter((x) => x.kind === 'contest' && x.ranked_choice);
      S.b.sources = pd.endorsers.map((e) => e.id);
      tally.clearLineups();
      const bad = races.map((x) => ({ x, v: tally.verdict(x), l: tally.lineup(x) })).filter(({ l }) => l.groups.some((g) => g.choices.length > 1));
      check('ranked: no verdict counts a whole ranked list as one candidate', races.length > 0 && bad.length === 0, bad.slice(0, 2).map(({ x, v }) => `${x.id}: ${v.main}`).join(' | '));
      const chair = races.find((x) => /Chair/i.test(x.office));
      const v = chair && tally.verdict(chair);
      check('ranked: the County Chair verdict names first choices', !!v && (/first/.test(v.main) || /First choice/.test(v.main)), v && v.main);
    }
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
    // Codex #3: a pick made while the Undo toast is up survives Undo.
    {
      const plan2 = bulk.planAgree();
      const filledIds = new Set(plan2.fills.map((f) => f.id));
      const other = b.items.find((x) => x.kind === 'measure' && !filledIds.has(x.id) && !S.b.picks[x.id]);
      const changed = plan2.fills.find((f) => f.set[f.id] && b.byId.get(f.id).kind === 'measure');
      bulk.applyFills(plan2.fills);
      if (other) S.b.picks[other.id] = 'YES';
      if (changed) { S.b.picks[changed.id] = changed.set[changed.id] === 'YES' ? 'NO' : 'YES'; delete S.b.auto[changed.id]; }
      bulk.undoFills();
      check('undo: the test has a row to decide and a filled row to change', !!other && !!changed);
      check('undo: a decision made after the fill survives Undo', !other || S.b.picks[other.id] === 'YES', other && other.id);
      check('undo: a filled row you changed keeps your change', !changed || (S.b.picks[changed.id] && S.b.picks[changed.id] !== changed.set[changed.id]), changed && changed.id);
      check('undo: the rest of the batch is cleared', plan2.fills.filter((f) => f !== changed).every((f) => Object.keys(f.set).every((k) => S.b.picks[k] === undefined) && !S.b.auto[f.id]));
      if (other) delete S.b.picks[other.id];
      if (changed) delete S.b.picks[changed.id];
    }
    // Codex #1: a multi-seat race you started picking is never filled past its seats.
    {
      const bo = open('CO', ['boulder-co']);
      S.b.sources = ['plan-boulder'];
      tally.clearLineups();
      const council = bo.byId.get('boulder-council');
      const planIn = bulk.planAgree().fills.find((f) => f.id === 'boulder-council');
      check('multi-seat: with no picks yet, PLAN-Boulder fills all five council seats', !!planIn && Object.keys(planIn.set).length === council.vote_for);
      S.b.picks['boulder-council|Lee Gilbert'] = 'PICK';
      const pa = bulk.planAgree();
      check('multi-seat: after you pick Lee Gilbert, agreement fill leaves the council alone', !pa.fills.some((f) => f.id === 'boulder-council') && pa.skippedPartial === 1, JSON.stringify(pa.skippedPartial));
      bulk.applyFills([planIn]);
      const n = council.candidates.filter((c) => S.b.picks[`boulder-council|${c.name}`] === 'PICK').length;
      check('multi-seat: a fill that would make six picks for five seats is refused', n === 1, String(n));
      const ch = open('IL', ['chicago-il']);
      ch.groups.forEach((x) => { S.b.districts[x.key] = '*'; });
      check('multi-seat: party fill fills an untouched three-seat race', bulk.planParty('Democratic').fills.some((f) => f.id === 'il-mwrd-6yr'));
      S.b.picks['il-mwrd-6yr|Michelle Pennington'] = 'PICK';
      const pp = bulk.planParty('Democratic');
      check('multi-seat: party fill skips a race you started picking and says so', !pp.fills.some((f) => f.id === 'il-mwrd-6yr') && pp.skippedPartial >= 1);
    }
    open('CO', ['lakewood-co']);
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

  /* ---------- Codex #8 and the bar-group states ---------- */
  {
    const ev = (verdict, rating, by, concern = null) => ({ kind: 'bar_group', by, by_short: by, rating, verdict, vote: null, vote_note: null, noted_concern: concern, noted_strength: null, url: 'https://example.org', survey: null, survey_note: null });
    const cand = (evs) => ({ name: 'Pat Example', short: 'Example', parties: [], own_words: [], evaluations: evs });
    let r = judges.candidateReview(cand([ev('favorable', 'Recommended', 'A'), ev('mixed', 'Mixed', 'B'), ev('none', 'Not listed', 'C')]));
    check('judges: favorable, mixed and not listed never reads as all recommend', r.main === '1 of 3 recommend' && r.tone === 'mixed' && !/\ball\b/i.test(r.line), JSON.stringify([r.main, r.tone, r.line]));
    r = judges.candidateReview(cand([ev('favorable', 'Recommended', 'A'), ev('none', 'Not listed', 'B')]));
    check('judges: one recommends and one did not rate says 1 of 2 and names the one that did not', r.main === '1 of 2 recommend' && /1 did not rate Example \(B\)/.test(r.line) && !/\ball\b/i.test(r.line), JSON.stringify([r.main, r.line]));
    r = judges.candidateReview(cand([ev('favorable', 'Recommended', 'A'), ev('favorable', 'Highly qualified', 'B'), ev('favorable', 'Qualified', 'C')]));
    check('judges: every group recommends is all, favorable', r.main === '3 of 3 recommend' && r.tone === 'fav' && /all 3 recommend/.test(r.line), JSON.stringify([r.main, r.line]));
    const ch = open('IL', ['chicago-il']);
    const nm = ch.byId.get('il-cook-subcircuit-17-brooks-vacancy').candidates.find((c) => /Natalia Moore/.test(c.name));
    r = nm && judges.candidateReview(nm);
    check('judges: Natalia Moore (did not take part in 14 screenings) reads as declined, not 14 groups finding her unfit', !!r && r.main === 'Declined screening' && r.tone === 'none' && /did not take part/.test(r.line) && !/do not \(/.test(r.line), r ? JSON.stringify([r.main, r.line.slice(0, 160)]) : 'not found');
    check('judges: her reason is shown as a reason, not a finding', !!r && r.concerns.length > 0 && r.concerns.every((x) => x.reason));
  }

  /* ---------- what it takes to pass, read as a rule ---------- */
  {
    const t = labels.thresholdLabel;
    check('threshold: "Simple majority (... the 55% rule does not apply)" is a simple majority', t('Simple majority (because it only repeals language, the 55% rule does not apply)') === 'Needs a simple majority to pass.');
    check('threshold: "Simple majority (more than 50% yes)" never reads as 50%', t('Simple majority (more than 50% yes). The pamphlet cites RCW 36.73.065(1).') === 'Needs a simple majority to pass.');
    check('threshold: a leading 55% is the rule', t('55% (constitutional amendment that adds language)') === 'Needs 55% yes to pass.');
    check('threshold: Florida 60%', t('60% of votes cast on the measure (Florida Constitution, Art. XI, s. 5(e))') === 'Needs 60% yes to pass.');
    check('threshold: advisory questions say so', /Advisory only/.test(t("Simple majority, but advisory only: the result is not binding and doesn't change any law.")));
    check('threshold: the Washington one-third turnout rule rides along', /one-third/.test(t('Simple majority of votes cast on the measure; at least one-third of voters taking part in the election must vote on it.')));
    check('threshold: anything else is shown as written', t('whichever option gets more votes; takes effect only if Question 200 passes') === 'To pass: whichever option gets more votes; takes effect only if Question 200 passes.');
    const co = read('state-CO.json');
    const a87 = co.items.find((x) => x.id === 'co-amendment-87');
    check('threshold: Colorado Amendment 87 reads simple majority from the data', !!a87 && t(a87.pass_threshold) === 'Needs a simple majority to pass.', a87 && a87.pass_threshold);
    check('measures: every measure carries a short title', [...Object.values(INDEX.states)].length > 0 && co.items.filter((x) => x.kind === 'measure').every((x) => x.short_title));
    check('measures: the row title uses the short title', labels.rowTitle(a87).sub === a87.short_title);
  }

  /* ---------- Codex #2: an address picks a place only in its own state ---------- */
  {
    const r = (state, place, upper = null) => ({ matched: '', state, county: null, place, cd: null, upper, lower: null });
    const ids = INDEX.zips['80247'] || [];
    check('address: 80247 asks between places that include Aurora, CO', ids.includes('aurora-co'), ids.join());
    check('address: a Census result for Aurora, Illinois never picks Aurora, Colorado', geo.placeFromGeo(INDEX.places, ids, r('IL', 'Aurora')) === null);
    check('address: Aurora, Colorado still does', geo.placeFromGeo(INDEX.places, ids, r('CO', 'Aurora')) === 'aurora-co');
    check('address: a result with no state picks nothing', geo.placeFromGeo(INDEX.places, ids, r(null, 'Aurora')) === null);
    const dc = Object.keys(INDEX.places).filter((id) => id.startsWith('dc-ward-'));
    check('address: DC still picks a ward from the upper layer', geo.placeFromGeo(INDEX.places, dc, r('DC', null, 2)) === 'dc-ward-2');
    check('address: a Maryland "Ward 2" never picks DC Ward 2', geo.placeFromGeo(INDEX.places, dc, r('MD', null, 2)) === null);
  }

  /* ---------- plan strip ---------- */
  {
    const tx = read('state-TX.json').howto;
    const step = plan.nextStep(tx, '2026-10-19');
    const text = step.head.map((p) => p[0]).join('');
    check('plan: Texas on Oct 19 says early voting starts today', text === 'Early voting starts today, Oct 19.', text);
    const co = read('state-CO.json').howto;
    const cs = plan.nextStep(co, '2026-10-19');
    // UX review #10: the headline is this week's action, mail it by the state's suggested day.
    check('plan: Colorado on Oct 19 says mail it by Mon, Oct 26, then a drop box by 7 PM Nov 3', /^Mail your ballot by Mon, Oct 26\.$/.test(cs.head.map((p) => p[0]).join('')) && /drop box by 7 PM Tue, Nov 3/.test(cs.sub.join(' ')), `${cs.head.map((p) => p[0]).join('')} | ${cs.sub.join(' | ')}`);
    const co27 = plan.nextStep(co, '2026-10-27');
    check('plan: Colorado from Oct 27 says drop it off by 7 PM Tue, Nov 3, and not to mail it', /^Drop off your ballot by 7 PM Tue, Nov 3\.$/.test(co27.head.map((p) => p[0]).join('')) && /drop box or a vote center/.test(co27.sub.join(' ')), co27.sub.join(' | '));
    check('plan: Colorado mentions in-person voting opening today', cs.sub.some((x) => /opens today/.test(x)), cs.sub.join(' | '));
    const caH = read('state-CA.json').howto;
    const alert = plan.registrationAlert(caH, '2026-10-19');
    check('plan: California on Oct 19 warns registration closes today, then same-day', !!alert && /today/i.test(alert) && /register and vote in person/.test(alert), alert || '');
    const words = (st) => st.head.map((p) => p[0]).join('');
    check('plan: Election Day says polls close', /Polls close at/.test(words(plan.nextStep(tx, '2026-11-03', false, 10 * 60))));
    // Codex #12: after the polls close on Election Day, say so, and keep the in-line rule.
    const shut = plan.nextStep(tx, '2026-11-03', false, 19 * 60);
    check('plan: at 7 PM on Election Day Texas says the polls closed', shut.phase === 'polls_closed' && /^Polls closed at 7 PM\. Already in line\? Stay in line\.$/.test(words(shut)), words(shut));
    check('plan: after close the in-line rule stays', shut.sub.some((x) => /in line/i.test(x)) && !/Find where to vote/.test(JSON.stringify(shut.primary)), shut.sub.join(' | '));
    check('plan: one minute before close it is still Election Day', plan.nextStep(tx, '2026-11-03', false, 18 * 60 + 59).phase === 'election_day');
    check('plan: a mail state says voting closed, not polls', /^Voting closed at 7 PM/.test(words(plan.nextStep(co, '2026-11-03', false, 21 * 60))));
    check('plan: text read later (absolute) never says closed', plan.nextStep(tx, '2026-11-03', true, 23 * 60).phase === 'election_day');
    // Codex #4: a postmark deadline is not a drop-off time.
    for (const s of ['CA', 'DC', 'OR', 'WA']) {
      const hs = read(`state-${s}.json`).howto;
      const early = plan.nextStep(hs, '2026-10-19');
      check(`plan: ${s} on Oct 19 says mail by the suggested day, with 8 PM only on the drop box`, /^Mail your ballot by (about )?Tue, Oct 27\.$/.test(words(early)) && !/8 PM/.test(words(early)) && /drop box by 8 PM Tue, Nov 3/.test(early.sub[0] || ''), `${words(early)} | ${early.sub.join(' | ')}`);
      const ms = plan.nextStep(hs, '2026-10-29');
      check(`plan: ${s} after that puts 8 PM on drop-off and states the postmark rule apart`, /^Drop off your ballot by 8 PM Tue, Nov 3\.$/.test(words(ms)) && /postmark dated Nov 3 or earlier/.test(ms.sub[0] || ''), `${words(ms)} | ${ms.sub.join(' | ')}`);
    }
    check('plan: Colorado (received by) never mentions a postmark', !/postmark/.test(cs.sub.join(' ') + co27.sub.join(' ')));
    const ca = read('state-CA.json').howto;
    const caIn = plan.nextStep(ca, '2026-10-29');
    check('plan: in-person voting through Nov 2 never reads as if Election Day is closed', caIn.sub.some((x) => /^Or vote early in person through Mon, Nov 2, or on Election Day\.$/.test(x)), caIn.sub.join(' | '));
    check('plan: on the registration deadline it says "Today is the last day to register online"', /^Not registered\? Today is the last day to register online\. After that, you can still register and vote in person\.$/.test(plan.registrationAlert(ca, '2026-10-19') || ''), plan.registrationAlert(ca, '2026-10-19') || '');
    check('plan: mailBy rejects a weekday that does not match the date', plan.mailBy({ ...co, mail_ballot: { ...co.mail_ballot, mail_cutoff_advice: 'Mail it by Tuesday, October 26.' } }) === null);
    // Codex #5: a county's own early-voting window wins over the state's.
    const fl = read('state-FL.json').howto;
    const orl = open('FL', ['orlando-fl']).howto.early_in_person;
    const pen = open('FL', ['pensacola-fl']).howto.early_in_person;
    check('plan: Orlando uses Orange County early voting, Oct 19 to Nov 1', orl.start === '2026-10-19' && orl.end === '2026-11-01' && /voteorangefl\.gov/.test(orl.lookup_url || '') && /Orange County/.test(orl.hours_note || ''), JSON.stringify(orl));
    check('plan: Pensacola ends Oct 31 with no Sunday', pen.end === '2026-10-31' && /escambiavotes\.gov/.test(pen.lookup_url || ''), JSON.stringify(pen));
    check('plan: on Nov 1 Orlando can still vote early, Pensacola cannot', plan.nextStep(open('FL', ['orlando-fl']).howto, '2026-11-01').phase === 'early_open' && plan.nextStep(open('FL', ['pensacola-fl']).howto, '2026-11-01').phase === 'election_day_next');
    check('plan: a ballot with no county window keeps the state window', open('FL', []).howto.early_in_person.end === fl.early_in_person.end);
    const a1 = { early_in_person: { start: '2026-10-19', end: '2026-11-01', hours_note: 'A', lookup_url: 'https://a.example', source: 'https://a.example', confidence: 'verified' } };
    const a2 = { early_in_person: { start: '2026-10-24', end: '2026-10-31', hours_note: 'B', lookup_url: 'https://b.example', source: 'https://b.example', confidence: 'verified' } };
    check('plan: places that disagree keep the state window', plan.localHowto(fl, [a1, a2]) === fl && plan.localHowto(fl, [a1, {}]) === fl);
    check('plan: places that agree on dates but not pages keep the state page', plan.localHowto(fl, [a1, { early_in_person: { ...a1.early_in_person, lookup_url: 'https://c.example' } }]).early_in_person.lookup_url === fl.early_in_person.lookup_url);
    check('plan: after Election Day says voting has closed', plan.nextStep(co, '2026-11-04').phase === 'closed');
    check('plan: never a countdown', !/days? (left|until|to Election)/i.test(JSON.stringify([step, cs])));
    check('plan: clockMinutes reads 7:00 PM, 8 p.m. and noon', plan.clockMinutes('7:00 PM') === 1140 && plan.clockMinutes('8 p.m. sharp') === 1200 && plan.clockMinutes('by noon') === 720 && plan.clockMinutes('12:30 AM') === 30);
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
