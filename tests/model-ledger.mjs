/* Model checks for the ledger's own modules (lens, verdict, bulk fills, judges, plan, labels).
   Run by tests/model.mjs, which loads the TypeScript and hands over `check`. */
export async function run({ st, bl, geo, common, mods, views, open, head, read, INDEX, check }) {
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

  /* ---------- UX review #5: other school districts' measures may apply ---------- */
  {
    const h = open('TX', ['houston-tx']);
    const local = h.items.filter((x) => x.kind === 'measure' && !h.statewide.has(x.id));
    const cyfair = local.filter((x) => /Cypress-Fairbanks|Spring ISD|Huffman|Crosby/.test(x.jurisdiction));
    check('may apply: Houston shows Cy-Fair, Spring, Huffman and Crosby ISD measures as May apply', cyfair.length >= 4 && cyfair.every((x) => h.mayApply.has(x.id)), cyfair.filter((x) => !h.mayApply.has(x.id)).map((x) => x.id).join(', '));
    const city = local.filter((x) => /City of Houston/.test(x.jurisdiction) || x.level === 'city');
    check('may apply: the City of Houston\'s own measures are not May apply', city.length > 0 && city.every((x) => !h.mayApply.has(x.id)), city.filter((x) => h.mayApply.has(x.id)).map((x) => x.id).join(', '));
    const dn = open('CO', ['denver-co']);
    check('may apply: Denver Public Schools measures cover Denver', dn.items.filter((x) => x.kind === 'measure' && /Denver Public Schools/.test(x.jurisdiction)).every((x) => !dn.mayApply.has(x.id)));
    const ch = open('IL', ['chicago-il']);
    check('may apply: Chicago Public Schools covers every Chicago voter; the mental health areas may apply', ch.items.filter((x) => x.kind === 'measure' && /Chicago Public Schools/.test(x.jurisdiction)).every((x) => !ch.mayApply.has(x.id)) && ch.items.filter((x) => x.kind === 'measure' && /Mental Health/.test(x.jurisdiction)).every((x) => ch.mayApply.has(x.id)));
    // Codex r3: restrictive notes win over a place-name match.
    const au = open('CO', ['aurora-co']);
    check('may apply: Aurora\'s 17th Judicial District measure (Adams County only) may apply', au.mayApply.has('adams-broomfield-da-7e'));
    const sd = open('CA', ['san-diego-ca']);
    check('may apply: San Diego Unified\'s measure (SDUSD voters only) may apply', sd.mayApply.has('sdusd-measure-m'));
    const pf = open('TX', ['pflugerville-tx']);
    check('may apply: ACC\'s Pflugerville measure (area not already in ACC) may apply', pf.mayApply.has('tx-acc-prop-a-pflugerville'));
    const lk = open('CO', ['lakewood-co']);
    check('may apply: Jeffco schools cover Lakewood', lk.items.filter((x) => x.kind === 'measure' && /Jeffco/.test(x.jurisdiction)).every((x) => !lk.mayApply.has(x.id)));
  }

  /* ---------- one source, one endorsement state per row (Orlando and LA walks, Oct 20) ----------
     "No endorsements found: Orlando Sentinel" sat above "Orlando Sentinel: behind a paywall, so we
     couldn't read its endorsements here" in the same row. Each source now gets exactly one state in a
     row, and its record decides which: a paywalled paper's checked "not found" record (the Sentinel
     read its slate: "No November endorsement for this race was listed") is "No endorsements found";
     one marked `unreadable` (the Herald: "The current slate could not be read") or no record at all
     gets only the paywall note, never "Not checked yet" as well (review, Oct 20). */
  {
    const pwNote = (e) => e.paywall === true && e.paywall_note_ok !== false;
    const stateLists = (h) => {
      const t = h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const grab = (re) => [...t.matchAll(re)].flatMap((m) => m[1].split(/,\s*/)).map((x) => x.trim()).filter(Boolean);
      return { nf: grab(/No endorsements? found(?: from)?:? ([^.]*)\./g), nc: grab(/Not checked yet: ([^.]*)\./g), pw: grab(/([^.:]*): behind a paywall/g), ns: grab(/([^.]*) took no stand\./g) };
    };
    let pwRows = 0, nfRows = 0;
    for (const [stc, pid] of [['FL', 'orlando-fl'], ['CA', 'los-angeles-ca'], ['IL', 'chicago-il']]) {
      const b = open(stc, [pid]);
      S.ui.row = null;
      tally.clearLineups();
      const twice = [], wrong = [];
      for (const it of b.items) {
        const l = tally.lineup(it);
        const rec = (e) => (b.ends[it.id] || {})[e.id];
        // The lineup: a paywalled paper's record decides its state; with no record, only the note.
        for (const e of l.paywalled) if (rec(e) && !rec(e).unreadable) wrong.push(`${it.id}: ${e.short} was read but reads "behind a paywall"`);
        for (const e of l.notFound) if (pwNote(e) && rec(e).unreadable) wrong.push(`${it.id}: ${e.short} couldn't be read but reads "No endorsements found"`);
        for (const e of l.notChecked) if (pwNote(e)) wrong.push(`${it.id}: ${e.short} reads "Not checked yet" beside its paywall note`);
        for (const e of l.notFound) if (pwNote(e)) nfRows++;
        // The open row: no source named in two states.
        const s = stateLists(views.open.openHTML(it));
        if (s.pw.length) pwRows++;
        const all = [...s.nf, ...s.nc, ...s.pw, ...s.ns];
        const dup = [...new Set(all.filter((n, i) => all.indexOf(n) !== i))];
        if (dup.length) twice.push(`${it.id}: ${dup.join(', ')}`);
      }
      check(`one state: ${pid} names every source in exactly one state per row`, twice.length === 0, twice.slice(0, 3).join(' | '));
      check(`one state: ${pid} reads a paywalled paper's state from its record`, wrong.length === 0, wrong.slice(0, 3).join(' | '));
    }
    check('one state: these ballots have paywall notes and read paywalled "not found" records to check', pwRows > 0 && nfRows > 0, `${pwRows} notes, ${nfRows} records`);
    // The Orlando Clerk row: the Sentinel read its slate and found no pick, so "No endorsements found".
    const orl = open('FL', ['orlando-fl']);
    S.ui.row = null;
    tally.clearLineups();
    const clerk = orl.byId.get('fl-orange-clerk');
    const cv = tally.verdict(clerk);
    const ch = views.open.openHTML(clerk).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    check('one state: Orlando Clerk reads "No endorsements found" from the Sentinel, as its record says', cv.main === 'No endorsements found' && cv.why === 'not_found' && /No endorsements? found(?: from)?:? Orlando Sentinel/.test(ch) && !/Orlando Sentinel: behind a paywall/.test(ch), `${cv.main} | ${ch.slice(0, 160)}`);
    const la = open('CA', ['los-angeles-ca']);
    S.ui.row = null;
    tally.clearLineups();
    const lh = views.open.openHTML(la.byId.get('ca-lt-governor')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    check('one state: LA Lt. Governor names the Sacramento Bee as "No endorsements found", never "couldn\'t read"', /No endorsements? found[^.]*Sacramento Bee/.test(lh) && !/Sacramento Bee[^.]*: behind a paywall/.test(lh), lh.slice(0, 200));
    // A record that says the page couldn't be read (Miami Herald, Florida's U.S. Senate race) is the
    // paywall note alone.
    open('FL', ['orlando-fl']);
    S.ui.row = null;
    tally.clearLineups();
    const sen = st.S.ballot.byId.get('fl-us-senate-special');
    const sh = views.open.openHTML(sen).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    check('one state: Florida\'s Senate race names the Miami Herald, which couldn\'t be read, only in the paywall note', st.S.ballot.ends['fl-us-senate-special']['miami-herald-eb'].unreadable === true && /Miami Herald[^.]*: behind a paywall/.test(sh) && !/No endorsements? found[^.]*Miami Herald/.test(sh), sh.slice(0, 240));
    // The verdict: a row whose only covering source is a paywalled paper with no record there reads
    // "Behind a paywall"; beside a source that found nothing, it is mixed and counts only that one.
    const b = open('FL', ['orlando-fl']);
    const pws = b.endorsers.filter(pwNote);
    let hit = null;
    for (const e of pws) {
      S.b.sources = [e.id];
      tally.clearLineups();
      const it = b.items.find((x) => tally.lineup(x).paywalled.length === 1);
      if (it) { hit = { e, it }; break; }
    }
    check('one state: Orlando has a row where a paywalled paper has no readable record', !!hit);
    if (hit) {
      S.b.sources = [hit.e.id];
      tally.clearLineups();
      let v = tally.verdict(hit.it);
      check('one state: a row whose only source is paywalled with no readable record reads "Behind a paywall"', v.kind === 'none' && v.main === 'Behind a paywall' && v.why === 'paywall', JSON.stringify(v));
      const plain = b.endorsers.find((e) => !pwNote(e) && !e.paywall && (hit.it.kind === 'measure' ? e.endorses_measures : e.endorses_candidates));
      const keep = b.ends[hit.it.id];
      b.ends[hit.it.id] = { ...(keep || {}), [plain.id]: { s: 'not_found', c: null } };
      S.b.sources = [hit.e.id, plain.id];
      tally.clearLineups();
      v = tally.verdict(hit.it);
      check('one state: one found nothing and one is paywalled is mixed, counting only the one that found nothing', v.why === 'mixed' && v.sub === 'nothing found for 1', JSON.stringify(v));
      if (keep) b.ends[hit.it.id] = keep; else delete b.ends[hit.it.id];
    }
    S.b.sources = null;
    tally.clearLineups();
  }

  /* ---------- "Not checked yet" only where a source speaks (data review, Oct 20) ----------
     "Not checked yet: San Antonio Express-News" showed on 16 Austin district races (CD-37 and on):
     its picks in the two districts Austin shares with San Antonio made it "cover" every one. */
  {
    const LOCAL = ['county', 'city', 'school', 'special_district'];
    const district = (it) => it.kind === 'contest' && !it.every && !LOCAL.includes(it.level);
    const au = open('TX', ['austin-tx']);
    const en = au.eById.get('san-antonio-express-news-eb');
    check('geography: the Express-News names San Antonio as its home', !!en && JSON.stringify(en.home_places) === '["san-antonio-tx"]', en && JSON.stringify(en.home_places));
    const outside = [];
    let regional = 0;
    for (const pid of Object.keys(INDEX.places)) {
      const b = open(INDEX.places[pid].state, [pid]);
      S.b.sources = b.endorsers.map((e) => e.id);
      tally.clearLineups();
      for (const it of b.items) {
        if (!district(it)) continue;
        const l = tally.lineup(it);
        for (const e of [...l.notChecked, ...l.paywalled]) {
          if (!e.home_places) continue;
          regional++;
          if (!e.home_places.includes(pid)) outside.push(`${pid} ${it.id}: ${e.short}`);
        }
      }
    }
    check('geography: a regional source reads "Not checked yet" on district races at home', regional > 0, String(regional));
    check('geography: and never on another place\'s district races', outside.length === 0, `${outside.length}: ${outside.slice(0, 3).join(' | ')}`);
    // Statewide groups, which name no place, still cover every district in their state.
    const a2 = open('TX', ['austin-tx']);
    S.b.sources = ['equality-texas'];
    tally.clearLineups();
    check('geography: a statewide group (Equality Texas) still reads "Not checked yet" on an Austin district it has no row on', tally.lineup(a2.byId.get('tx-us-house-37')).notChecked.some((e) => e.id === 'equality-texas'));
    // Review, Oct 20: a statewide party whose geography lists its state and the places it was
    // researched for (["CO", "boulder-co"], ["CO", "denver-co"]) is not a regional source. A county
    // party, which names only its places, still is.
    S.b.sources = ['bexar-county-gop'];
    tally.clearLineups();
    check('geography: a county party (Bexar County GOP) never reads "Not checked yet" on an Austin district', !tally.lineup(a2.byId.get('tx-us-house-37')).notChecked.length && !!a2.eById.get('bexar-county-gop')?.home_places?.length);
    const aur = open('CO', ['aurora-co']);
    S.b.sources = ['co-wfp'];
    tally.clearLineups();
    check('geography: the Colorado Working Families Party (statewide) has no home places', !aur.eById.get('co-wfp').home_places, JSON.stringify(aur.eById.get('co-wfp').home_places));
    check('geography: and still reads "Not checked yet" on Aurora\'s HD-36', tally.lineup(aur.byId.get('co-hd-36')).notChecked.some((e) => e.id === 'co-wfp'));
    const md = open('MD', []);
    S.b.sources = ['md-democratic-party', 'md-republican-party'];
    tally.clearLineups();
    check('geography: Maryland\'s state parties still read "Not checked yet" on a statewide-only ballot\'s district judge', tally.lineup(md.byId.get('md-retention-killough')).notChecked.length === 2);
    S.b.sources = null;
    tally.clearLineups();
  }

  /* ---------- place notes speak to voters, not to researchers (blockers review, Oct 20) ----------
     "Notes for Pflugerville" said "Kevin's friends ...", Round Rock's "not in this file; see the
     memo", San Marcos's "the county site blocked automated checks". */
  {
    const meta = /\bKevin\b|this file|the memo|automated|research(er)?s?\b|agent/i;
    const bad = Object.keys(INDEX.places).map((p) => [p, read(`place-${p}.json`).notes || '']).filter(([, n]) => meta.test(n) || /—/.test(n));
    check('place notes: no internal research talk or em dashes in any "Notes for" text', bad.length === 0, bad.map(([p, n]) => `${p}: ${(n.match(meta) || ['—'])[0]}`).join(' | '));
    const pf = read('place-pflugerville-tx.json').notes;
    check('place notes: Pflugerville keeps its facts (office, address, phone, vote in your county)', /Williamson County Elections, 301 SE Inner Loop, Georgetown, 512-943-1630/.test(pf) && /county of registration/.test(pf));
    const rr = read('place-round-rock-tx.json').notes;
    check('place notes: Round Rock keeps the Leander ISD places and the Georgetown ISD tax election', /Leander ISD trustee races \(Places 1, 2, 6 and 7\)/.test(rr) && /Georgetown ISD tax election/.test(rr) && /sample ballot/.test(rr));
    const sm = read('place-san-marcos-tx.json').notes;
    check('place notes: San Marcos keeps the site, the measures it looked for and the sample ballot', /120 Stagecoach Trail/.test(sm) && /San Marcos CISD or Hays CISD bond or tax measure/.test(sm) && /Hays sample ballot/.test(sm));
  }

  /* ---------- no shouting: "A NO vote means" reads like "A yes vote" (Austin walk, Oct 20) ---------- */
  {
    const d = common.deshout;
    check('deshout: "A NO vote means" comes out lower case', d('A NO vote means the city cannot sell these bonds; the projects wait.') === 'A no vote means the city cannot sell these bonds; the projects wait.', d('A NO vote means the city cannot sell these bonds; the projects wait.'));
    check('deshout: "A YES vote" still does', d('A YES vote lets the city sell bonds.') === 'A yes vote lets the city sell bonds.');
    check('deshout: NO at the start of a clause is "No"', d('Special taxes need two-thirds. NO means they still need a simple majority.') === 'Special taxes need two-thirds. No means they still need a simple majority.');
    check('deshout: real acronyms and quoted ballot words stay', d('A NO vote keeps the ACC tax; the US rate and "NO on Prop A" stay as written.') === 'A no vote keeps the ACC tax; the US rate and "NO on Prop A" stay as written.');
    // Review, Oct 20: the LA County GOP's "Explicit NO recommendation" (a pick to remove a justice)
    // came out "Explicit no recommendation", which reads as no stand at all.
    const gop = 'The party’s public lookup lists this choice. Its source label is: Explicit NO recommendation for every named justice in this record.';
    check('deshout: "NO recommendation" (a pick of no) never becomes "no recommendation"', d(gop) === gop, d(gop));
    check('deshout: NO before position, endorsement or stand stays too, even beside a shouted word', d('NOTE: the board gave a NO endorsement and a NO position.') === 'Note: the board gave a NO endorsement and a NO position.', d('NOTE: the board gave a NO endorsement and a NO position.'));
    check('deshout: a vote of no still reads "no" ("Recommends NO on", "Measure FD: NO.")', d('Recommends NO on all seven questions.') === 'Recommends no on all seven questions.' && d('Its lookup lists Measure FD: NO.') === 'Its lookup lists Measure FD: No.', `${d('Recommends NO on all seven questions.')} | ${d('Its lookup lists Measure FD: NO.')}`);
    // Every measure on every ballot: its yes and no meanings never shout YES or NO.
    const QUOTED = /“[^”]*”|"[^"]*"|(^|[\s(])'[^']*'(?=[\s.,;:)!?]|$)/g;
    const shouts = [];
    for (const f of [...Object.keys(INDEX.places).map((p) => `place-${p}.json`), ...Object.keys(INDEX.states).map((s) => `state-${s}.json`)]) {
      for (const m of read(f).items) {
        if (m.kind !== 'measure') continue;
        for (const t of [m.yes_means, m.no_means]) if (t && /\b(YES|NO)\b/.test(d(t).replace(QUOTED, ''))) shouts.push(`${m.id}: ${d(t).slice(0, 50)}`);
      }
    }
    check('deshout: no measure\'s yes or no meaning shouts YES or NO', shouts.length === 0, `${shouts.length}: ${shouts.slice(0, 2).join(' | ')}`);
  }

  /* ---------- a neighborhood's own district never covers the whole place (Orlando walk, Oct 20) ---------- */
  {
    const orl = open('FL', ['orlando-fl']);
    check('may apply: Vista Lakes Community Development District is a maybe on an Orlando ballot', orl.mayApply.has('fl-vista-lakes-cdd-3'));
    const ch = open('IL', ['chicago-il']);
    const sub = ch.items.filter((x) => /^il-cook-subcircuit-/.test(x.id));
    check('may apply: every Cook County judicial subcircuit race is a maybe on a Chicago ballot', sub.length > 0 && sub.every((x) => ch.mayApply.has(x.id)), sub.filter((x) => !ch.mayApply.has(x.id)).map((x) => x.id).join(', '));
    // Guards against a wider pattern: districts that hold the whole place stay certain.
    check('may apply: the 1st DCA, which holds all of Tallahassee and Pensacola, stays certain where its scope names their counties', ['tallahassee-fl', 'pensacola-fl'].every((p) => !open('FL', [p]).mayApply.has('fl-retention-1dca-lewis')));
    const en = open('CO', ['englewood-co']);
    check('may apply: Arapahoe County races stay certain in Englewood', en.items.filter((x) => /^arapahoe-/.test(x.id) && x.kind === 'contest').every((x) => !en.mayApply.has(x.id)));
    const se = open('WA', ['seattle-wa']);
    check('may apply: the King County District Court West district (all of Seattle) stays certain', se.items.filter((x) => /^kc-district-court-west/.test(x.id)).every((x) => !se.mayApply.has(x.id)));
    // Review, Oct 20: "Ward 6" matched as a district inside the place, so DC Ward 6's own council and
    // school board races ("Only Ward 6 voters") were maybes on the Ward 6 ballot, and the party fill
    // left Ward 6 Council blank. A ward's own race covers its ward; the ANC race stays a maybe.
    const own = [];
    for (const w of [1, 3, 5, 6]) {
      const dc = open('DC', [`dc-ward-${w}`]);
      own.push(...[`dc-ward-${w}-council`, `dc-ward-${w}-sboe`].filter((id) => !dc.items.some((x) => x.id === id) || dc.mayApply.has(id)));
      if (!dc.mayApply.has(`dc-ward-${w}-anc`)) own.push(`dc-ward-${w}-anc (should stay a maybe)`);
    }
    check('may apply: a DC ward\'s own council and school board races are sure things on its ballot; its ANC race is not', own.length === 0, own.join(', '));
    open('DC', ['dc-ward-6']);
    check('may apply: the Democratic fill on Ward 6 includes the Ward 6 Council race', bulk.planParty('Democratic').fills.some((f) => f.id === 'dc-ward-6-council'));
  }

  /* ---------- Board of Equalization District 3 is all of LA County (LA walk, Oct 20) ---------- */
  {
    const la = open('CA', ['los-angeles-ca']);
    check('may apply: BOE District 3 is a sure thing on an LA ballot, as its scope says', la.items.some((x) => x.id === 'ca-boe-3') && !la.mayApply.has('ca-boe-3'));
    check('may apply: BOE District 3 is still not every Californian\'s race', !la.byId.get('ca-boe-3').every);
    const ca = open('CA', []);
    check('may apply: a statewide-only California ballot still asks which BOE district', ca.groups.some((g) => g.members.includes('ca-boe-3') && g.members.length === 4));
    check('may apply: other places\' BOE races are unchanged', ['fullerton-ca', 'san-diego-ca'].every((p) => open('CA', [p]).mayApply.has('ca-boe-4')) && !open('CA', ['fullerton-ca']).items.some((x) => x.id === 'ca-boe-3'));
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
    check('verdict: two took no stand and one is not checked yet is mixed, with the counts', v.kind === 'none' && v.why === 'mixed' && v.main === 'No endorsements' && v.sub === '2 took no stand', JSON.stringify(v));
    S.b.sources = [e1.id, e2.id];
    tally.clearLineups();
    v = tally.verdict(it);
    check('verdict: all took no stand', v.kind === 'none' && v.why === 'no_stand' && v.main === 'Took no stand', JSON.stringify(v));
    set({ [e1.id]: row('not_found'), [e2.id]: row('not_found') });
    v = tally.verdict(it);
    check('verdict: nothing found', v.kind === 'none' && v.why === 'not_found', JSON.stringify(v));
    set({ [e1.id]: row('not_found'), [e2.id]: row('no_position') });
    v = tally.verdict(it);
    check('verdict: one found nothing and one took no stand is mixed, one short line', v.why === 'mixed' && v.main === 'No endorsements' && v.sub === '1 took no stand', JSON.stringify(v));
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
    // Codex r2 (r1 #3 still open): confirming the same value by hand still takes the row out of Undo.
    {
      const plan3 = bulk.planAgree();
      const same = plan3.fills.find((f) => b.byId.get(f.id).kind === 'measure');
      bulk.applyFills(plan3.fills);
      if (same) { S.b.picks[same.id] = same.set[same.id]; delete S.b.auto[same.id]; bulk.touchUndo(same.id); }
      bulk.undoFills();
      check('undo: a hand pick of the same value the batch set survives Undo', !!same && S.b.picks[same.id] === same.set[same.id], same && same.id);
      if (same) delete S.b.picks[same.id];
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
    // A party fill says it came from the party, not from your sources (Codex, copy pass review).
    const pf1 = party.fills.find((f) => p.byId.get(f.id).vote_for === 1);
    if (pf1) {
      bulk.applyFills([pf1]);
      const pv = tally.verdict(p.byId.get(pf1.id));
      check('party fill: the row says "Filled from your party", not "from your sources"', pv.sub === 'Filled from your party', JSON.stringify(pv));
    } else check('party fill: a single-seat party fill exists to test', false);
    // Top-two: LA has races with two candidates of one party.
    const la = open('CA', ['los-angeles-ca']);
    la.groups.forEach((x) => { S.b.districts[x.key] = '*'; });
    const lap = bulk.planParty('Democratic');
    check('party fill: skips races where the party has two candidates (top-two)', lap.skippedTwo > 0 && lap.fills.every((f) => {
      const c = la.byId.get(f.id); return c.candidates.filter((k) => k.parties.includes('Democratic')).length === 1 || c.vote_for > 1;
    }), `${lap.skippedTwo} skipped`);
  }

  /* ---------- fills never pick a race the row calls "Maybe on your ballot" (walks, Oct 20) ----------
     Austin's fill picked SBOE 5 and Senate 21; after "Not sure" on U.S. Rep it filled six House
     races; LA 90012 with "Not sure" everywhere filled 35. The rule is the row tag's own. */
  {
    const maybe = (b, id) => (b.mayApply.has(id) && !S.b.notMine.includes(id)) || (!!b.groupOf[id] && S.b.districts[b.groupOf[id]] === '*');
    // A maybe race whose sources all agree: the old fill took it.
    const agreeable = (b) => b.items.filter((it) => maybe(b, it.id) && bl.status(it) === 'open' && !(it.kind === 'contest' && (it.ranked_choice || (it.is_retention && it.candidates.length > 1)))).filter((it) => { const l = tally.lineup(it); return l.groups.length === 1 && !l.both.length && l.groups[0].choices.length; });
    for (const [stc, pid] of [['TX', 'austin-tx'], ['CA', 'los-angeles-ca'], ['FL', 'orlando-fl']]) {
      const b = open(stc, [pid]);
      tally.clearLineups();
      const fresh = bulk.planAgree().fills.map((f) => f.id);
      const freshParty = bulk.planParty('Democratic').fills.map((f) => f.id);
      check(`fills: ${pid} has maybe races its sources agree on, so the rule is tested`, agreeable(b).length > 0, String(agreeable(b).length));
      check(`fills: ${pid} agree fill leaves every "Maybe on your ballot" race alone`, fresh.every((id) => !maybe(b, id)), fresh.filter((id) => maybe(b, id)).join(', '));
      b.groups.forEach((g) => { S.b.districts[g.key] = '*'; });
      const agree = bulk.planAgree().fills.map((f) => f.id);
      const party = bulk.planParty('Democratic').fills.map((f) => f.id);
      check(`fills: ${pid} with "Not sure" on every district, the agree fill still skips them all`, agree.every((id) => !maybe(b, id)) && agree.length === fresh.length, `${fresh.length} then ${agree.length}: ${agree.filter((id) => maybe(b, id)).slice(0, 6).join(', ')}`);
      check(`fills: ${pid} with "Not sure" on every district, the party fill count stays the same`, party.every((id) => !maybe(b, id)) && party.length === freshParty.length, `${freshParty.length} then ${party.length}`);
    }
    // A hidden "may apply" race stays out, and one the voter brings back is still a maybe.
    const au = open('TX', ['austin-tx']);
    check('fills: Austin\'s SBOE 5 and Senate 21 are maybes, never filled', ['tx-sboe-5', 'tx-senate-21'].every((id) => au.mayApply.has(id)) && !bulk.planAgree().fills.some((f) => ['tx-sboe-5', 'tx-senate-21'].includes(f.id)));
    // Review, Oct 20: the judges' "Keep all" fill still took maybes. On the Aurora and Denver ballot
    // (80247) it kept 22 judges tagged "Only in Denver"; on Aurora with "Not sure" on the judge
    // questions it went from 7 to 32, three counties' judges. Its button counts what it fills.
    for (const [name, pids, unsure] of [['Aurora and Denver', ['aurora-co', 'denver-co'], false], ['Aurora, "Not sure" on every district', ['aurora-co'], true]]) {
      const b = open('CO', pids);
      if (unsure) b.groups.forEach((g) => { S.b.districts[g.key] = '*'; });
      tally.clearLineups();
      const jb = judges.judgeBatch();
      const fills = bulk.planJudges().fills;
      const maybes = b.items.filter((it) => it.kind === 'contest' && it.is_retention && maybe(b, it.id) && bl.status(it) === 'open');
      check(`fills: ${name} has judges tagged "Maybe on your ballot", so the rule is tested`, maybes.length > 0, String(maybes.length));
      check(`fills: ${name}, the judges' fill never keeps a maybe`, !!jb && fills.length > 0 && fills.every((f) => !maybe(b, f.id)) && jb.targets.every((t) => !maybe(b, t.id)), fills.filter((f) => maybe(b, f.id)).slice(0, 4).map((f) => f.id).join(', '));
      check(`fills: ${name}, the button's count is the judges it keeps`, !!jb && new RegExp(`\\b${jb.targets.length}\\b`).test(jb.label), jb && `${jb.label} / ${jb.targets.length}`);
    }
  }

  /* ---------- "N of M decided" walks the page's own order (nav review, Oct 20) ----------
     It walked printed-ballot order, so LA never reached the U.S. House question, the Sheriff, the
     Mayor or the council question, and Austin never reached its city and school sections. */
  {
    const { ledger } = views;
    const secIdx = Object.fromEntries(bl.SECTIONS.map(([k], i) => [k, i]));
    for (const [stc, pid] of [['CA', 'los-angeles-ca'], ['TX', 'austin-tx'], ['FL', 'orlando-fl']]) {
      const b = open(stc, [pid]);
      const po = typeof ledger.pageOrder === 'function' ? ledger.pageOrder() : [];
      const secOf = (k) => bl.sectionOf(b.byId.get(k.startsWith('q:') ? b.groups.find((g) => `q:${g.key}` === k).members[0] : k));
      const idx = po.map((x) => secIdx[secOf(x.key)]);
      check(`next: ${pid} walks sections in the order the page draws them`, po.length > 0 && idx.every((v, i) => !i || v >= idx[i - 1]), idx.join(','));
      // The count (decisionItems) is the walk minus the closed fold's unclaimed races.
      const want = bl.decisionItems().map((x) => x.id).sort().join();
      const got = po.filter((x) => !x.folded).map((x) => x.key).sort().join();
      check(`next: ${pid} walks every choice and every district question, once`, want === got && new Set(po.map((x) => x.key)).size === po.length && b.groups.every((g) => po.some((x) => x.key === `q:${g.key}`)));
      check(`next: ${pid} starts with the first thing the page shows`, po.length > 0 && po[0].key === bl.SECTIONS.map(([k]) => (bl.entriesBySection().get(k) || []).find((e) => e.t === 'question' || (e.t === 'item' && bl.isDecision(bl.status(b.byId.get(e.id)))))).filter(Boolean).map((e) => (e.t === 'question' ? `q:${e.group.key}` : e.id))[0], po[0] && po[0].key);
    }
    // Review, Oct 20: the walk opened Round Rock, Pflugerville and Leander ISD seats one by one on
    // an Austin ballot, though their fold is closed and says "Open only if one of them is yours".
    // Closed, the fold's races are marked folded (A.next skips them); open, they are walked.
    open('TX', ['austin-tx']);
    S.ui.row = null; S.ui.keep = null; S.ui.unfolded.delete(ledger.OTH_KEY);
    const oth = ledger.otherSchools(bl.entriesBySection().get('school') || []).map((e) => e.id);
    const shut = ledger.pageOrder();
    check('next: Austin\'s closed "Other school districts" fold has races to skip', oth.length >= 3 && oth.includes('tx-rrisd-trustee-3'), oth.join(', '));
    check('next: while that fold is closed, the walk passes every one of its races by', shut.filter((x) => x.folded).map((x) => x.key).sort().join() === [...oth].sort().join() && shut.filter((x) => !x.folded).every((x) => !oth.includes(x.key)));
    S.ui.unfolded.add(ledger.OTH_KEY);
    check('next: opened, the fold\'s races are walked in place', ledger.pageOrder().every((x) => !x.folded) && oth.every((id) => ledger.pageOrder().some((x) => x.key === id)));
    S.ui.unfolded.delete(ledger.OTH_KEY);
  }

  /* ---------- counting: one rule for "N of M decided" (flow, Oct 20) ----------
     A district question counts as one race until it's answered, then its race takes its place;
     the closed "Other school districts" fold's races count only once claimed (the fold opened, or
     one picked or noted); "Maybe on your ballot" rows count. The bar, the bands, the cheat sheet
     and step 2's coverage line all give the same M. */
  {
    const { ledger } = views;
    const tally = mods.tally;
    const reset = () => { S.ui.view = 'ballot'; S.ui.row = null; S.ui.keep = null; S.ui.unfolded = new Set(); S.ui.folded = new Set(); S.ui.onlyUndecided = false; };
    const barM = () => { const m = ledger.barHTML().match(/<span class="bar-txt"><b>(\d+)<\/b> of (\d+)/); return m ? [+m[1], +m[2]] : null; };
    const bandSum = () => bl.SECTIONS.reduce((n, [k]) => { const t = ledger.sectionTally(bl.entriesBySection().get(k) || []); return [n[0] + t.done, n[1] + t.total]; }, [0, 0]);
    const cheatM = () => { const m = views.cheat.cheatHTML(false).match(/(\d+) of (\d+) decided\./); return m ? [+m[1], +m[2]] : null; };
    const b = open('TX', ['austin-tx']);
    reset();
    const items = bl.decisionItems();
    const qs = b.groups.length;
    const oth = ledger.otherSchools(bl.entriesBySection().get('school') || []).map((e) => e.id);
    const may = items.filter((x) => !x.question && bl.isMaybe(x.id)).length;
    const choices = [...bl.entriesBySection().values()].flat().filter((e) => e.t === 'item' && bl.isDecision(bl.status(b.byId.get(e.id)))).length;
    check('count: Austin has district questions, a closed fold and maybe rows to test with', qs >= 5 && oth.length >= 3 && may >= 1, `${qs} questions, ${oth.length} folded, ${may} maybes`);
    check('count: a fresh Austin ballot counts every question once, every maybe row, and no folded race', items.length === choices - oth.length + qs && items.filter((x) => x.question).length === qs && oth.every((id) => !items.some((x) => x.id === id)), `${items.length} vs ${choices} - ${oth.length} + ${qs}`);
    const [n0, m0] = barM() || [];
    check('count: the bar says 0 of M with that M', n0 === 0 && m0 === items.length, `${n0} of ${m0}, want ${items.length}`);
    check('count: the bands add up to the bar', bandSum().join() === `0,${items.length}`, bandSum().join());
    check('count: the cheat sheet gives the bar\'s M', (cheatM() || []).join() === `0,${items.length}`, (cheatM() || []).join());
    check('count: step 2\'s "Picks in N of your M races" gives the bar\'s M', tally.coverage().total === items.length, `${tally.coverage().total} vs ${items.length}`);
    const fed = bl.entriesBySection().get('federal') || [];
    check('count: a band with a district question counts it ("0 of 2 decided", not "0 of 1")', ledger.sectionCount(fed) === `0 of ${fed.filter((e) => e.t === 'question' || (e.t === 'item' && bl.isDecision(bl.status(b.byId.get(e.id))))).length} decided` && fed.some((e) => e.t === 'question'), ledger.sectionCount(fed));
    // Answering a question: its race takes its place, so M holds still.
    const g = b.groups.find((x) => x.members.every((id) => bl.isDecision(bl.status(b.byId.get(id)))));
    S.b.districts[g.key] = g.members[0];
    check('count: answering a question puts its race in its place, so M holds', bl.decisionItems().length === items.length && bl.decisionItems().some((x) => x.id === g.members[0]) && !bl.decisionItems().some((x) => x.id === `q:${g.key}`), String(bl.decisionItems().length));
    // "Not sure": every district's race shows, each a maybe, each counted.
    S.b.districts[g.key] = '*';
    check('count: "Not sure" counts each of its races, each a maybe', bl.decisionItems().length === items.length - 1 + g.members.length && g.members.every((id) => bl.isMaybe(id)), String(bl.decisionItems().length));
    delete S.b.districts[g.key];
    // The fold: opened, its races count; closed again, a race you picked still counts, the rest don't.
    S.ui.unfolded.add(ledger.OTH_KEY);
    check('count: opening the fold claims its races', bl.decisionItems().length === items.length + oth.length && barM()[1] === items.length + oth.length, String(bl.decisionItems().length));
    const one = b.byId.get(oth[0]);
    S.b.picks[one.id] = one.candidates[0].name;
    S.ui.unfolded.delete(ledger.OTH_KEY);
    check('count: closed again, the one you picked still counts, as decided', bl.decisionItems().length === items.length + 1 && (barM() || []).join() === `1,${items.length + 1}` && bandSum().join() === `1,${items.length + 1}`, `${(barM() || []).join()} / ${bandSum().join()}`);
    check('count: the cheat sheet lists the race you picked there and no other folded race', /data-cs="/.test(views.cheat.cheatHTML(false)) && views.cheat.cheatHTML(false).includes(`data-cs="${one.id}"`) && oth.slice(1).every((id) => !views.cheat.cheatHTML(false).includes(`data-cs="${id}"`)));
    delete S.b.picks[one.id];
    S.b.notes[oth[1]] = 'My district?';
    check('count: a note on a folded race claims it too', bl.decisionItems().some((x) => x.id === oth[1]) && bl.decisionItems().length === items.length + 1);
    delete S.b.notes[oth[1]];
    // The school band never counts the unclaimed fold, and the section is done once the rest is.
    const school = bl.entriesBySection().get('school') || [];
    const t = ledger.sectionTally(school);
    check('count: the Schools band leaves the closed fold out', t.total === school.filter((e) => e.t === 'question' || (e.t === 'item' && bl.isDecision(bl.status(b.byId.get(e.id))) && !oth.includes(e.id))).length, `${t.total}`);
    reset();
  }

  /* ---------- the menu (flow, Oct 20): "Next up", the rows and their counts ----------
     "Next up" names the next undecided race or question after the row you're on, in page order,
     and its button opens that one; the section rows' "N left" add up to the bar; when nothing the
     count includes is left there is no "Next up" and every row says "Done". */
  {
    const { ledger } = views;
    const reset = () => { S.ui.view = 'ballot'; S.ui.row = null; S.ui.keep = null; S.ui.unfolded = new Set(); S.ui.folded = new Set(); S.ui.onlyUndecided = false; };
    for (const [stc, pid] of [['TX', 'austin-tx'], ['CA', 'los-angeles-ca']]) {
      const b = open(stc, [pid]);
      reset();
      const left = ledger.pageOrder().filter((x) => !x.folded && !x.done).map((x) => x.key);
      const up = ledger.nextUp();
      check(`menu: ${pid} "Next up" starts with the first thing left on the page`, !!up && up.key === left[0] && up.title.length > 0, up && `${up.key}: ${up.title}`);
      S.ui.row = left[0];
      check(`menu: ${pid} with that row open, "Next up" is the one after it`, ledger.nextUp().key === left[1], ledger.nextUp().key);
      S.ui.row = null; S.ui.keep = left[left.length - 1];
      check(`menu: ${pid} after the last one, "Next up" wraps to the first`, ledger.nextUp().key === left[0], ledger.nextUp().key);
      S.ui.keep = null;
      const html = ledger.menuHTML('toc');
      const n = [...html.matchAll(/<span class="nv-n">(\d+) left<\/span>/g)].reduce((a, m) => a + +m[1], 0);
      const items = bl.decisionItems();
      check(`menu: ${pid} the sections' "N left" add up to the bar`, n === items.filter((x) => !x.done).length, `${n} vs ${items.filter((x) => !x.done).length}`);
      const at = (x) => html.indexOf(x);
      check(`menu: ${pid} "Next up" leads, then your next step and Quick picks, then the switch right above the sections, ending with My plan`, at('data-act="next"') < at('data-to="plan"') && at('data-to="plan"') < at('data-act="picks"') && at('data-act="picks"') < at('data-act="only"')
        && at('data-act="only"') < at('data-act="jump" data-to="federal"') && /My plan<\/span><span class="nv-n"><\/span><i class="nv-a" aria-hidden="true">›<\/i><\/button><\/li><\/ul>$/.test(html.trim()));
      // Everything decided: answer every question, leave every race blank on purpose.
      b.groups.forEach((g) => { S.b.districts[g.key] = g.members[0]; });
      for (const x of bl.decisionItems()) S.b.picks[x.id] = 'SKIP';
      const done = ledger.menuHTML('toc');
      check(`menu: ${pid} with nothing left, no "Next up", and every section reads Done`, ledger.nextUp() === null && !done.includes('data-act="next"') && !/ left<\/span>/.test(done) && /Done/.test(done));
      reset();
    }
  }

  /* ---------- the sources sheet counts your ballot, not every district (walks, Oct 20) ----------
     LA's sheet said "Knock LA: Endorsed in 59 of your races and measures" on a 46-item ballot. */
  {
    for (const [stc, pid] of [['CA', 'los-angeles-ca'], ['FL', 'orlando-fl'], ['TX', 'austin-tx']]) {
      for (const notSure of [false, true]) {
        const b = open(stc, [pid]);
        if (notSure) b.groups.forEach((g) => { S.b.districts[g.key] = '*'; });
        const M = bl.decisionItems().length;
        const h = views.lens.sourcesSheetHTML();
        const ns = [...h.matchAll(/Endorsed in (\d+) of your races and measures/g)].map((m) => +m[1]);
        const rows = h.split('<li class="srow">').slice(1);
        const two = rows.filter((r) => /No endorsements found/.test(r) && /class="pw-note"/.test(r)).length;
        check(`sources sheet: ${pid}${notSure ? ' with "Not sure" answered' : ''} never counts more races than the bar's ${M}`, ns.length > 0 && Math.max(...ns) <= M, `max ${Math.max(...ns)} of ${M}`);
        check(`sources sheet: ${pid}${notSure ? ' with "Not sure" answered' : ''} never shows a paper as both "No endorsements found" and paywalled`, two === 0, String(two));
      }
    }
  }

  /* ---------- a folded section's summary starts with a capital (Orlando walk, Oct 20) ---------- */
  {
    const b = open('FL', ['orlando-fl']);
    S.ui.view = 'ballot'; S.ui.row = null; S.ui.keep = null; S.ui.unfolded = new Set(); S.ui.folded = new Set(); S.ui.onlyUndecided = false;
    S.b.picks['fl-retention-muniz'] = 'NO';
    S.b.picks['fl-9th-circuit-group-1'] = b.byId.get('fl-9th-circuit-group-1').candidates[0].name;
    const html = views.ledger.sectionHTML('judicial', bl.entriesBySection().get('judicial') || []);
    const sub = ((html.match(/<span class="sec-sub">([^<]*)<\/span>/) || [])[1] || '').trim();
    check('fold summary: "Remove 1, Hampton-Johnson", never "remove 1, ..."', /folded/.test(html) && /^Remove 1, /.test(sub), sub);
    S.b.picks['fl-retention-muniz'] = 'YES';
    const sub2 = ((views.ledger.sectionHTML('judicial', bl.entriesBySection().get('judicial') || []).match(/<span class="sec-sub">([^<]*)<\/span>/) || [])[1] || '').trim();
    check('fold summary: "Keep 1, ..." still reads the same', /^Keep 1, /.test(sub2), sub2);
  }

  /* ---------- a fill from one source names it (LA walk, Oct 20) ----------
     A row filled from Knock LA alone read "Filled from your sources", the same as five agreeing. */
  {
    const b = open('CA', ['los-angeles-ca']);
    tally.clearLineups();
    const plan = bulk.planAgree();
    const one = plan.fills.find((f) => f.single);
    const many = plan.fills.find((f) => !f.single);
    check('fill names: LA has a one-source fill and a several-source fill to check', !!one && !!many);
    bulk.applyFills(plan.fills);
    if (one) {
      const src = tally.weighedIn(tally.lineup(b.byId.get(one.id)))[0];
      const v = tally.verdict(b.byId.get(one.id));
      check('fill names: a pick filled from one source says "Filled from" that source', v.sub === `Filled from ${src.short}`, `${one.id}: ${v.sub}`);
    }
    if (many) check('fill names: a pick several sources agreed on still says "Filled from your sources"', tally.verdict(b.byId.get(many.id)).sub === 'Filled from your sources', tally.verdict(b.byId.get(many.id)).sub);
    // A single source whose name holds a comma or the word "Party" is still named, not "your party".
    const it = b.items.find((x) => x.kind === 'measure');
    const party = b.endorsers.find((e) => /party/i.test(e.short) && e.endorses_measures);
    if (party) {
      S.b.picks[it.id] = 'YES';
      S.b.auto[it.id] = `Filled in from your sources: ${party.short}`;
      check('fill names: an agree fill from one party organization names it, not "your party"', tally.verdict(it).sub === `Filled from ${party.short}`, tally.verdict(it).sub);
    }
    const comma = b.endorsers.find((e) => /, /.test(e.short));
    if (comma) {
      S.b.auto[it.id] = `Filled in from your sources: ${comma.short}`;
      check('fill names: a source whose name has a comma is still one source', tally.verdict(it).sub === `Filled from ${comma.short}`, tally.verdict(it).sub);
    }
    bulk.undoFills();
  }

  /* ---------- the cheat sheet lists what the ballot shows, with the bar's count (walks, Oct 20) ----------
     Austin's sheet listed seven Round Rock, Pflugerville and Leander ISD seats the ballot folds
     away, listed six House picks as certain, and said "28 of 56" beside a bar's "28 of 50". */
  {
    const { cheat, ledger } = views;
    const resetUI = () => { S.ui.view = 'ballot'; S.ui.row = null; S.ui.keep = null; S.ui.unfolded = new Set(); S.ui.folded = new Set(); };
    const has = (h, id) => h.includes(`data-cs="${id}"`);
    const rowOf = (h, id) => (h.match(new RegExp(`<tr data-cs="${id}"[\\s\\S]*?</tr>`)) || [''])[0];
    const sheetCount = (h) => (h.match(/(\d+) of (\d+) decided/) || []).slice(1).join(' of ');
    const barCount = () => (ledger.barHTML().match(/<b>(\d+)<\/b> of (\d+)/) || []).slice(1).join(' of ');
    const au = open('TX', ['austin-tx']);
    resetUI();
    const oth = au.items.filter((it) => it.kind === 'contest' && it.level === 'school' && au.mayApply.has(it.id) && !au.groupOf[it.id] && it.candidates.length > 1);
    check('cheat sheet: Austin folds three or more other school districts\' races', oth.length >= 3, String(oth.length));
    let html = cheat.cheatHTML(false);
    check('cheat sheet: the folded other school districts\' races stay off it while undecided', oth.every((it) => !has(html, it.id)), oth.filter((it) => has(html, it.id)).map((it) => it.id).join(', '));
    check('cheat sheet: an unanswered district question is still a line', /Depends on your district/.test(html));
    // Every unanswered question's line is a tap back to that question, with "Pick your district".
    const qLines = au.groups.map((g) => (html.match(new RegExp(`<tr[^>]*data-q="${g.key.replace(/[|()]/g, '\\$&')}"[\\s\\S]*?</tr>`)) || [''])[0]);
    check('cheat sheet: each district line goes back to its question ("Pick your district")', au.groups.length > 0 && qLines.every((l) => /data-act="goto"/.test(l) && /Pick your district/.test(l)), qLines.filter((l) => !/data-act="goto"/.test(l)).length + ' dead');
    check('cheat sheet: printed district lines stay plain', !/data-act/.test(cheat.cheatHTML(true).match(/<tr class="cs-q"[\s\S]*?<\/tr>/)?.[0] || 'data-act'));
    check('cheat sheet: "N of M decided" is the bar\'s count, district questions left out', !!sheetCount(html) && sheetCount(html) === barCount(), `${sheetCount(html)} vs bar ${barCount()}`);
    S.b.picks[oth[0].id] = oth[0].candidates[0].name;
    S.b.picks['tx-sboe-5'] = au.byId.get('tx-sboe-5').candidates[0].name;
    const gov = au.byId.get('tx-governor');
    S.b.picks[gov.id] = gov.candidates[0].name;
    html = cheat.cheatHTML(false);
    check('cheat sheet: an other-district race you picked is listed, the rest stay off', has(html, oth[0].id) && oth.slice(1).every((it) => !has(html, it.id)));
    check('cheat sheet: a pick on a maybe race says "If it’s on your ballot"', /If it’s on your ballot/.test(rowOf(html, 'tx-sboe-5')) && /If it’s on your ballot/.test(rowOf(html, oth[0].id)), rowOf(html, 'tx-sboe-5').slice(0, 200));
    check('cheat sheet: a pick on a race that is surely yours has no such note', has(html, gov.id) && !/If it’s on your ballot/.test(rowOf(html, gov.id)));
    check('cheat sheet: copied text carries the note too', /\(if it’s on your ballot\)/.test(cheat.cheatText().split('\n').find((x) => x.includes(au.byId.get('tx-sboe-5').candidates[0].name)) || ''));
    check('cheat sheet: the count still matches the bar after picks', sheetCount(html) === barCount(), `${sheetCount(html)} vs bar ${barCount()}`);
    // "Not sure" on U.S. Rep: every district shows on the ballot as a maybe; a pick in one is marked.
    const usr = au.groups.find((g) => g.kind === 'cd');
    S.b.districts[usr.key] = '*';
    S.b.picks[usr.members[0]] = au.byId.get(usr.members[0]).candidates[0].name;
    html = cheat.cheatHTML(false);
    check('cheat sheet: a House pick under "Not sure" says "If it’s on your ballot"', /If it’s on your ballot/.test(rowOf(html, usr.members[0])));
    check('cheat sheet: the count matches the bar with "Not sure" answered', sheetCount(html) === barCount(), `${sheetCount(html)} vs bar ${barCount()}`);
    // Opening the fold on the ballot ("Open only if one of them is yours") lists them all again.
    S.ui.unfolded.add('school|oth');
    html = cheat.cheatHTML(false);
    check('cheat sheet: with the other-districts row opened, every one of them is listed', oth.every((it) => has(html, it.id)));
    resetUI();
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
    check('judges: one recommends and one did not rate says 1 of 2, with each group behind "See each group"', r.main === '1 of 2 recommend' && /1 did not rate Example/.test(r.line) && !/\ball\b/i.test(r.line) && r.groups.length === 2 && r.groups[1].by === 'B', JSON.stringify([r.main, r.line]));
    r = judges.candidateReview(cand([ev('favorable', 'Recommended', 'A'), ev('favorable', 'Highly qualified', 'B'), ev('favorable', 'Qualified', 'C')]));
    check('judges: every group recommends is all, favorable', r.main === '3 of 3 recommend' && r.tone === 'fav' && /all 3 recommend/.test(r.line), JSON.stringify([r.main, r.line]));
    const ch = open('IL', ['chicago-il']);
    const nm = ch.byId.get('il-cook-subcircuit-17-brooks-vacancy').candidates.find((c) => /Natalia Moore/.test(c.name));
    r = nm && judges.candidateReview(nm);
    check('judges: Natalia Moore (did not take part in 14 screenings) reads as declined, not 14 groups finding her unfit', !!r && r.main === 'Declined screening' && r.tone === 'none' && /did not take part/.test(r.line) && !/do not \(/.test(r.line), r ? JSON.stringify([r.main, r.line.slice(0, 160)]) : 'not found');
    check('judges: her reason is shown as a reason, not a finding', !!r && r.concerns.length > 0 && r.concerns.every((x) => x.reason));
    // Codex r2: a 7-1 "meets standards" is still a favorable finding; the split is reported beside it.
    const au = open('CO', ['aurora-co']);
    const adams = au.byId.get('adams-district-judges');
    const jr = adams && judges.judgeReview(adams);
    check('judges: Adams County district judges (all five meet standards, one 7-1) read "All 5 favorable", split noted', !!jr && jr.main === 'All 5 favorable' && /1 by a split vote/.test(jr.sub) && /One was by a split vote/.test(jr.line), jr ? `${jr.main} | ${jr.sub}` : 'missing');
    // Codex r2: New York "Failed to Appear" is a group that did not rate them, never "not recommended".
    const bk = open('NY', ['nyc-brooklyn-ny']);
    const md6 = bk.byId.get('nyc-civil-court-brooklyn-md6');
    const dsf = md6 && md6.candidates.find((c) => /DeSouza-Forte/.test(c.name));
    const dr = dsf && judges.candidateReview(dsf);
    check('judges: DeSouza-Forte reads as not rated by LeGaL ("Failed to Appear"), never "not recommended"', !!dr && !/not recommended/i.test(dr.line) && /did not rate/.test(dr.line) && /Failed to Appear/.test(dr.line), dr ? dr.line : 'missing');
  }

  /* ---------- how a lean was placed, in plain words (Codex r2) ---------- */
  {
    const sea = open('WA', ['seattle-wa']);
    const stranger = sea.endorsers.find((e) => /stranger/.test(e.id));
    check('lean: The Stranger reads "rated by Ad Fontes Media" (its basis says no AllSides rating was found)', !!stranger && common.basisWords(stranger) === 'rated by Ad Fontes Media', stranger && common.basisWords(stranger));
    const all = new Map();
    for (const f of [...Object.keys(INDEX.states).map((x) => `state-${x}.json`), ...Object.keys(INDEX.places).map((x) => `place-${x}.json`)]) for (const e of read(f).endorsers) all.set(e.id, e);
    const wrong = [...all.values()].filter((e) => /rated by AllSides/.test(common.basisWords(e)) && /\bno\s+AllSides/i.test(e.lean_basis || ''));
    check('lean: no source whose basis says "no AllSides rating" is credited to AllSides', wrong.length === 0, wrong.map((e) => e.id).join(', '));
    check('lean: a party reads "from its party", a mission "from its mission statement"', [...all.values()].filter((e) => e.lean && e.lean_basis_kind === 'party').every((e) => common.basisWords(e) === 'from its party') && [...all.values()].filter((e) => e.lean && e.lean_basis_kind === 'mission').every((e) => common.basisWords(e) === 'from its mission statement'));
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

  /* ---------- the first page (flow, Oct 20): an address before any ZIP, step 2, the city count ---------- */
  {
    const r = (state, place, extra = {}) => ({ matched: '', state, county: null, place, cd: null, upper: null, lower: null, zip: null, ...extra });
    const go = (x) => JSON.stringify(geo.settleAddress(INDEX, x));
    check('first-page address: Austin, Texas opens Austin', go(r('TX', 'Austin', { zip: '78704' })) === JSON.stringify({ kind: 'open', st: 'TX', ids: ['austin-tx'], zip: '78704' }), go(r('TX', 'Austin', { zip: '78704' })));
    check('first-page address: Census "Los Angeles" finds "Los Angeles (city)"', geo.settleAddress(INDEX, r('CA', 'Los Angeles')).ids?.join() === 'los-angeles-ca');
    check('first-page address: Census "New York" in Kings County finds Brooklyn', geo.settleAddress(INDEX, r('NY', 'New York', { county: 'Kings' })).ids?.join() === 'nyc-brooklyn-ny');
    check('first-page address: DC picks the ward from the upper layer', geo.settleAddress(INDEX, r('DC', 'Washington', { upper: 6 })).ids?.join() === 'dc-ward-6');
    check('first-page address: Aurora, Illinois never opens Aurora, Colorado', geo.settleAddress(INDEX, r('IL', 'Aurora')).kind === 'none');
    const both = geo.settleAddress(INDEX, r('CO', null, { zip: '80247' }));
    check('first-page address: no place name and a ZIP with several places asks which', both.kind === 'choose' && both.ids.includes('aurora-co') && both.ids.includes('denver-co'), JSON.stringify(both));
    check('first-page address: a covered state outside our places gets its statewide ballot', go(r('TX', 'Waco', { zip: '76701' })) === JSON.stringify({ kind: 'open', st: 'TX', ids: [], zip: '76701' }), go(r('TX', 'Waco', { zip: '76701' })));
    check('first-page address: a state we don\'t cover says so', geo.settleAddress(INDEX, r('MA', 'Cambridge', { zip: '02139' })).kind === 'out');
    check('first-page address: no ZIP and no place we know is "none"', geo.settleAddress(INDEX, r('TX', 'Waco')).kind === 'none' && geo.settleAddress(INDEX, r(null, 'Austin')).kind === 'none');

    const au = open('TX', ['austin-tx']);
    tally.clearLineups();
    const agree = bulk.planAgree();
    const solo = bulk.planSetup(null);
    check('step 2: with no party, the fill is the agree fill', solo.fills.map((f) => f.id).join() === agree.fills.map((f) => f.id).join() && !solo.party && solo.agree.single === agree.single);
    lens.setParty(au, 'Democratic');
    tally.clearLineups();
    const both2 = bulk.planSetup('Democratic');
    const pids = both2.party.fills.map((f) => f.id);
    const ids = both2.fills.map((f) => f.id);
    check('step 2: with a party, its candidates come first, then agree in the races it left', pids.length > 0 && ids.slice(0, pids.length).join() === pids.join() && both2.agree.fills.every((f) => !pids.includes(f.id)), `${pids.length} party, ${both2.agree.fills.length} agree`);
    check('step 2: one batch, no race twice', new Set(ids).size === ids.length);
    const n = bulk.applyFills(both2.fills);
    check('step 2: the batch lands whole', n === ids.length, `${n} of ${ids.length}`);
    bulk.undoFills();
    check('step 2: one Undo takes all of it back', Object.keys(S.b.picks).length === 0 && Object.keys(S.b.auto).length === 0, JSON.stringify(S.b.picks).slice(0, 120));
    lens.setParty(au, null);

    const old = { zip: '78704', picks: { 'tx-us-senate': 'X' }, ranks: {}, auto: {}, noAuto: [], notes: {}, districts: {}, notMine: [], sources: null, planSeen: false, offerDismissed: null, addrNote: null, party: null, ticks: [] };
    check('step 2: a save from before step 2 back-fills setupDone as false', ({ ...st.emptyBallotState(), ...old }).setupDone === false);
    const b = st.emptyBallotState('78704');
    b.picks['tx-us-senate'] = au.byId.get('tx-us-senate').candidates[0].name;
    const before = st.encodeShare(au, b);
    b.setupDone = true;
    check('step 2: finishing it never changes the save link', st.encodeShare(au, b) === before);
    check('first page: the city count counts DC\'s wards and New York City\'s boroughs once', views.mast.cityCount(INDEX) === Object.keys(INDEX.places).length - (Object.keys(INDEX.places).filter((id) => id.startsWith('dc-ward-')).length - 1) - (Object.keys(INDEX.places).filter((id) => id.startsWith('nyc-')).length - 1), String(views.mast.cityCount(INDEX)));
    check('step 2: the place line reads like the mock-up', views.setup.placeLine(au) === 'Austin, Texas' && views.setup.placeLine(open('DC', ['dc-ward-1'])) === 'Ward 1, Washington, DC' && views.setup.placeLine(open('NY', ['nyc-brooklyn-ny'])) === 'Brooklyn, New York' && views.setup.placeLine(open('WA', [])) === 'Washington');

    // Round 3 (Oct 20): the fill switch's words, the first page before a ZIP, and the parties it offers.
    open('TX', ['austin-tx']);
    tally.clearLineups();
    const a0 = bulk.planSetup(null).agree;
    check('fill line: no party, "{n} races where they agree ({k} from just one source). Races where they split stay open."', views.setup.fillLine(null) === `${a0.fills.length} races where they agree${a0.single ? ` (${a0.single} from just one source)` : ''}. Races where they split stay open.`, views.setup.fillLine(null));
    lens.setParty(S.ballot, 'Republican');
    tally.clearLineups();
    const pr = bulk.planSetup('Republican');
    const want = [pr.party.fills.length ? `${pr.party.fills.length} from the Republican Party` : '', pr.agree.fills.length ? `${pr.agree.fills.length} where your other sources agree` : ''].filter(Boolean).join(' and ');
    check('fill line: with a party, "{p} from the {Party} Party and {a} where your other sources agree.", zero parts dropped', views.setup.fillLine('Republican') === `${want}.` && !/\b0 /.test(views.setup.fillLine('Republican')), views.setup.fillLine('Republican'));
    lens.setParty(S.ballot, null);
    tally.clearLineups();
    const view0 = S.view; const idx0 = S.index;
    S.view = 'start'; S.index = INDEX;
    const door = views.setup.pickControlsHTML();
    check('first page before a ZIP: the chips from memory, no counts, the fill switch says what it does', /data-k="papers" aria-pressed="true"/.test(door) && /data-k="progressive" aria-pressed="false"/.test(door) && !/su-cov/.test(door)
      && door.includes('Fill in my ballot with their picks') && door.includes('Fills the races where they agree. Races where they split stay open.') && door.includes('Hide races I’ve decided'));
    S.ui.open.add('su-party');
    const listed = [...views.setup.pickControlsHTML().matchAll(/data-act="party-set" data-p="([^"]+)"/g)].map((m) => m[1]);
    S.ui.open.delete('su-party');
    check('first page before a ZIP: "A party" lists every party the guide covers', listed.length > 2 && JSON.stringify(listed) === JSON.stringify(INDEX.parties), listed.join(', '));
    S.view = view0; S.index = idx0;
    check('index: the parties the guide covers, A to Z, each with its own party organization in the data', Array.isArray(INDEX.parties) && INDEX.parties.includes('Democratic') && INDEX.parties.includes('Republican') && JSON.stringify([...INDEX.parties].sort()) === JSON.stringify(INDEX.parties), (INDEX.parties || []).join(', '));
  }

  /* ---------- UX re-walk: the survey in plain words ---------- */
  {
    const ev = (attorneys, non) => ({ kind: 'official_commission', by: 'C', by_short: 'C', rating: 'Meets Performance Standards', verdict: 'favorable', vote: '9-0', vote_note: null, survey_note: null, noted_strength: null, noted_concern: null, url: 'https://example.org', verified_on: null, confidence: 'verified',
      survey: { question: 'Based on your responses to the previous questions related to the performance evaluation criteria, do you think this judge meets judicial performance standards?', attorneys, non_attorneys: non, judges: null, report_url: null, caution: "Small samples. n counts everyone who answered the question, including 'no opinion'." } });
    let p = judges.surveySentence(ev({ yes_pct: 100, no_pct: 0, n: 9 }, { yes_pct: 44, no_pct: 56, n: 9 }), 'Sara Garrido');
    check('survey: "9 of 9 lawyers and 4 of 9 others who saw Judge Garrido in court"', !!p && p.sentence === 'In the survey, 9 of 9 lawyers and 4 of 9 others who saw Judge Garrido in court said the judge meets standards. Small groups, so read with care.' && p.note === '', p && p.sentence);
    p = judges.surveySentence(ev({ yes_pct: 50, no_pct: 50, n: 13 }, null), 'Pat Example');
    check('survey: a count that does not reproduce the percentage keeps the percentage', !!p && /50% of the 13 lawyers who answered/.test(p.sentence), p && p.sentence);
    p = judges.surveySentence(ev({ yes_pct: 67, no_pct: 33, n: 3 }, { yes_pct: 90, no_pct: 10, n: 30 }), 'Pat Example');
    check('survey: under 5 answers shows no count', !!p && /fewer than 5 lawyers answered/.test(p.sentence) && /27 of 30 others/.test(p.sentence), p && p.sentence);
  }

  /* ---------- UX review #1: the judges section leads with the plain answer ---------- */
  {
    open('CO', ['lakewood-co']);
    const lead = judges.judgesLead();
    check('judges lead: Colorado says "meets standards" is a passing grade, not an endorsement, with how many passed', /passing grade on a job review, not an endorsement/.test(lead) && /121 of 123 judges/.test(lead), lead);
    check('judges rule: Colorado band says "A judge stays with more yes votes than no votes."', judges.judgesRule() === 'A judge stays with more yes votes than no votes.', judges.judgesRule());
    open('IL', ['chicago-il']);
    check('judges rule: Chicago band is one line, "A judge needs 60% yes to stay."', judges.judgesRule() === 'A judge needs 60% yes to stay.', judges.judgesRule());
    // UX re-walk: one wording on a retention row and its open row ("say don't keep"), groups by full name.
    const chi = open('IL', ['chicago-il']);
    const smith = chi.items.find((x) => x.kind === 'contest' && x.is_retention && /Tiesha/.test(x.candidates[0]?.name || '') && (x.candidates[0].evaluations || []).length > 5);
    const sr = smith && judges.judgeReview(smith);
    check('judges: a split Chicago retention reads "say don’t keep" in the row and the open row, no acronyms', !!sr && /say don’t keep$/.test(sr.main) && /say don’t keep/.test(sr.line) && !/\b[A-Z]{3,}\b/.test(sr.line) && sr.groups.every((g) => g.by.length > 6), sr ? `${sr.main} | ${sr.line}` : 'missing');
    check('judges lead: Chicago explains a bar "no" can mean a skipped interview', /skipped the interview/.test(judges.judgesLead()), judges.judgesLead());
    const jb = judges.judgeBatch();
    check('judges batch: Chicago reads "Keep the N judges the bar associations recommend"', !!jb && /^Keep the \d+ judges the bar associations recommend$/.test(jb.label), jb && jb.label);
    open('TX', ['houston-tx']);
    check('judges rule: Texas says how judges win, not "to keep a judge"', /^The candidate with the most votes wins\. These aren’t keep-or-remove votes\./.test(judges.judgesRule()));
    check('judges lead: Texas calls a lawyer poll a poll', /poll of lawyers, not a job review/.test(judges.judgesLead()), judges.judgesLead());
    open('OR', ['portland-or']);
    check('judges lead: Oregon says there is no official review', /^Oregon has no official review of these judges\./.test(judges.judgesLead()), judges.judgesLead());
    const lk = open('CO', ['lakewood-co']);
    const cb = judges.judgeBatch();
    check('judges batch: Colorado reads "Keep all N judges the review says meet standards"', !!cb && /^Keep all \d+ judges the review says meet standards$/.test(cb.label), cb && cb.label);
  }

  /* ---------- flow, Oct 20: every "go check" gets a button ---------- */
  {
    const ledger = views.ledger;
    const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const au = open('TX', ['austin-tx']);
    // "Only on some ballots": the address (Congress and the state legislature only), the sample ballot, "It's not on my ballot".
    const sd = views.open.openHTML(au.byId.get('tx-senate-21'));
    const at = (t) => sd.indexOf(t);
    check('go check: a maybe state senate race offers Check with my address, See my sample ballot, It’s not on my ballot, in that order',
      /Only on some ballots\./.test(sd) && at('>Check with my address<') > 0 && at('>Check with my address<') < at('>See my sample ballot<') && at('>See my sample ballot<') < at('>It’s not on my ballot<'), strip(sd).slice(0, 200));
    check('go check: its address button opens the address form', /data-act="addr-open"[^>]*>Check with my address/.test(sd));
    check('go check: "It’s not on my ballot" keeps the notmine action', /data-act="notmine" data-id="tx-senate-21"[^>]*>It’s not on my ballot/.test(sd));
    // The address box leads with "Use my address" only while the lookup can settle something:
    // Congress and the state legislature, before a lookup has run on this ballot.
    const btns = (h) => [...((h.match(/<div class="addrbox">[\s\S]*?<\/div><\/div>/) || [''])[0]).matchAll(/class="mini( dark)?"[^>]*>([^<]+)</g)].map((m) => `${m[2]}${m[1] ? ' (dark)' : ''}`).join('|');
    check('address box: Austin, fresh, offers Use my address first, then the sample ballot', btns(ledger.ballotHeadHTML()) === 'Use my address (dark)|See my sample ballot' && ledger.addressHelps(), btns(ledger.ballotHeadHTML()));
    // What the lookup answers (Congress, the state Senate and House, and the maybe rows for them).
    for (const g of au.groups) if (g.kind) S.b.districts[g.key] = g.members[0];
    for (const id of au.mayApply) { const c = au.byId.get(id); if (c.kind === 'contest' && views.open.censusSettles(c)) S.b.notMine.push(id); }
    const left = ledger.addressCount();
    check('address box: with only council, county and school questions left, the sample ballot leads and Use my address goes', left > 0 && !ledger.addressHelps() && btns(ledger.ballotHeadHTML()) === 'See my sample ballot (dark)' && new RegExp(`${left} races depend on your address`).test(ledger.ballotHeadHTML()), `${left} | ${btns(ledger.ballotHeadHTML())}`);
    S.b.districts = {}; S.b.notMine = [];
    S.b.addrNote = 'Your districts: Congressional District 37. We didn’t save your address. Double-check with your sample ballot.';
    check('address box: once a lookup has run, it offers only the sample ballot', !ledger.addressHelps() && btns(ledger.ballotHeadHTML()) === 'See my sample ballot (dark)', btns(ledger.ballotHeadHTML()));
    const sd2 = views.open.openHTML(au.byId.get('tx-senate-21'));
    check('address box: and a maybe row no longer offers Check with my address', !/Check with my address/.test(sd2) && /class="mini dark"[^>]*>See my sample ballot/.test(sd2));
    S.ui.row = `q:${au.groups.find((x) => x.kind === 'cd').key}`;
    check('address box: nor does a district question', !/data-fk="dq-addr"/.test(ledger.sectionHTML('federal', bl.entriesBySection().get('federal'))));
    S.ui.row = null;
    S.b.addrNote = null;
    S.ui.row = `q:${au.groups.find((x) => x.kind === 'cd').key}`;
    check('address box: before a lookup, a Congress question offers Use my address', /data-fk="dq-addr"/.test(ledger.sectionHTML('federal', bl.entriesBySection().get('federal'))));
    S.ui.row = null;
    open('FL', []);
    check('address box: statewide Florida (appeals judges only) leads with the sample ballot, no Use my address', ledger.addressCount() > 0 && btns(ledger.ballotHeadHTML()) === 'See my sample ballot (dark)', `${ledger.addressCount()} | ${btns(ledger.ballotHeadHTML())}`);
    open('TX', ['austin-tx']);
    const dv = views.open.openHTML(au.byId.get('tx-dvisd-prop-a'));
    check('go check: a maybe measure has no address button (the Census doesn’t settle school districts)', !/Check with my address/.test(dv) && /See my sample ballot/.test(dv) && /It’s not on my ballot/.test(dv));
    const fake = (district) => ({ kind: 'contest', district });
    check('go check: the Census settles CD, SD and HD races, nothing else', views.open.censusSettles(fake('CD-10')) && views.open.censusSettles(fake('SD-21')) && views.open.censusSettles(fake('HD-49')) && !views.open.censusSettles(fake('Precinct 2')) && !views.open.censusSettles(fake('District 3')));
    open('DC', ['dc-ward-1']);
    check('go check: in DC an "upper" district is a ward, which the Census doesn’t settle', !views.open.censusSettles(fake('SD-1')) && views.open.censusSettles(fake('CD-0')));
    // District questions: a last answer for a district you're not in.
    check('go check: districtEntity names school and utility districts only', ledger.districtEntity('Del Valle ISD Trustee') === 'Del Valle ISD' && ledger.districtEntity('Trustee, Somerset ISD') === 'Somerset ISD'
      && ledger.districtEntity('Fullerton Joint Union High School District Governing Board') === 'Fullerton Joint Union High School District' && ledger.districtEntity('San Diego Unified School District Board of Education') === 'San Diego Unified School District'
      && ledger.districtEntity('Rockwood Water People\'s Utility District Director') === 'Rockwood Water People\'s Utility District'
      && [ 'U.S. Representative', 'Austin City Council Member', 'School Board', 'Member of the Chicago Board of Education (nonpartisan)', 'Soil and Water Conservation District Supervisor', 'RTD Board of Directors'].every((o) => ledger.districtEntity(o) === null));
    const a2 = open('TX', ['austin-tx']);
    const g = (re) => a2.groups.find((x) => re.test(x.office));
    check('go check: Austin’s questions end "I’m not in Del Valle ISD", "I’m not in Austin ISD", "Not in any of these"', ledger.noneLabel(g(/Del Valle/)) === 'I’m not in Del Valle ISD' && ledger.noneLabel(g(/Austin ISD/)) === 'I’m not in Austin ISD' && ledger.noneLabel(g(/City Council/)) === 'Not in any of these' && ledger.noneLabel(g(/U\.S\. Rep/)) === 'Not in any of these');
    const dvg = g(/Del Valle/);
    S.ui.row = `q:${dvg.key}`;
    const qh = ledger.sectionHTML('school', bl.entriesBySection().get('school'));
    const opts = [...qh.matchAll(/data-act="district"[^>]*data-v="([^"]+)"/g)].map((m) => m[1]);
    check('go check: "I’m not in Del Valle ISD" is the question’s last answer, after "Not sure"', opts[opts.length - 1] === 'none' && opts[opts.length - 2] === '*' && /I’m not in Del Valle ISD/.test(qh), opts.join(','));
    S.ui.row = null;
    const m0 = bl.decisionItems().length;
    S.b.districts[dvg.key] = 'none';
    const sch = ledger.sectionHTML('school', bl.entriesBySection().get('school'));
    check('go check: answered "none", the question leaves the count and no race takes its place', bl.decisionItems().length === m0 - 1 && !dvg.members.some((id) => sch.includes(`id="i-${id}"`)), `${m0} then ${bl.decisionItems().length}`);
    check('go check: its line says "Not on your ballot", with Change', /Del Valle ISD Trustee: Not on your ballot/.test(strip(sch)) && /data-act="district-change" data-g="[^"]*Del Valle/.test(sch));
    const back = st.decodeShare(a2, head(st.encodeShare(a2, S.b))).state;
    check('go check: "none" travels in the save link', back.districts[dvg.key] === 'none');
    // "No sources on": a button that turns the newspapers and guides back on.
    open('CO', ['denver-co']);
    S.b.sources = [];
    const m81 = views.open.openHTML(S.ballot.byId.get('co-amendment-81'));
    check('go check: "No sources on." with "Turn on newspapers and guides", no "at the top"', /No sources on\./.test(m81) && /data-act="papers-on" data-id="co-amendment-81"[^>]*>Turn on newspapers and guides/.test(m81) && !/at the top/.test(m81));
    S.b.sources = null;
    check('go check: with sources on, no such button', !/papers-on/.test(views.open.openHTML(S.ballot.byId.get('co-amendment-81'))));
    // Statewide-only: the state's sample ballot (its own sample_ballot_url first) and "Ask for your city".
    const wa = open('WA', []);
    const hd = ledger.ballotHeadHTML();
    const ask = (hd.match(/href="([^"]+)"[^>]*>Ask for your city</) || [])[1] || '';
    check('go check: a statewide ballot says so, with See my sample ballot and Ask for your city', /We only have statewide races for your area so far\./.test(hd) && /href="https:[^"]+"[^>]*>See my sample ballot</.test(hd) && /docs\.google\.com/.test(ask), strip(hd).slice(0, 160));
    const askQ = new URLSearchParams(ask.replace(/&amp;/g, '&').split('?')[1] || '');
    check('go check: Ask for your city prefills "Please add my city" and the state', askQ.get('entry.90887649') === 'Please add my city' && /Washington/.test(askQ.get('entry.628621310') || ''), askQ.toString());
    wa.howto = { ...wa.howto, sample_ballot_url: 'https://sos.example.gov/sample' };
    check('go check: a state’s own sample_ballot_url wins on a statewide ballot', common.sampleBallot().url === 'https://sos.example.gov/sample');
    const au3 = open('TX', ['austin-tx']);
    au3.howto = { ...au3.howto, sample_ballot_url: 'https://sos.example.gov/sample' };
    check('go check: a place’s own sample ballot still wins over the state’s', common.sampleBallot().url === au3.places[0].sample_ballot_url);
    // Not covered: Vote.gov, then "Want this for your city? Ask Kevin." with the form prefilled.
    const keep = { view: S.view, ballot: S.ballot, index: S.index, coverage: S.coverage };
    S.view = 'start'; S.ballot = null; S.index = INDEX; S.coverage = { kind: 'not_covered', state: 'MA', zip: '02139' };
    const nc = views.mast.mastHTML();
    const kevin = ((nc.match(/href="([^"]+)"[^>]*data-ask-kevin/) || [])[1] || '').replace(/&amp;/g, '&');
    check('go check: not covered says "We don’t cover Massachusetts yet. Vote.gov has official info for every state."', /We don’t cover Massachusetts yet\. Vote\.gov has official info for every state\./.test(strip(nc)) && !/friends and family vote/.test(nc), strip(nc).slice(0, 300));
    check('go check: then "Want this for your city? Ask Kevin." to the form, prefilled with the state and ZIP', /Want this for your city\? Ask Kevin \./.test(strip(nc)) && new URLSearchParams(kevin.split('?')[1]).get('entry.628621310') === 'Massachusetts, 02139' && new URLSearchParams(kevin.split('?')[1]).get('entry.90887649') === 'Please add my city', kevin);
    // A load error gets "Try again".
    S.coverage = null; S.loadErr = 'We couldn’t load that ballot. Check your connection.'; S.retry = () => {};
    check('go check: a load error gets "Try again"', /data-act="retry"[^>]*>Try again</.test(views.mast.mastHTML()));
    S.retry = null;
    check('go check: no Try again without something to retry', !/data-act="retry"/.test(views.mast.mastHTML()));
    S.loadErr = null;
    Object.assign(S, keep);
    // A lookup that went wrong: "Try again" when the Census didn't answer; "Pick them myself" on a ballot with a question left.
    open('TX', ['austin-tx']);
    S.view = 'ballot'; S.ui.addrOpen = true; S.ui.addrMsg = 'The Census lookup didn’t answer.'; S.ui.addrFail = 'down';
    let ah = views.mast.addrHTML();
    check('go check: Census down on a ballot: Try again and Pick them myself', /data-act="addr-retry"[^>]*>Try again</.test(ah) && /data-act="addr-pick"[^>]*>Pick them myself</.test(ah) && /type="button" data-act="addr-retry"/.test(ah));
    S.ui.addrFail = 'miss';
    ah = views.mast.addrHTML();
    check('go check: a miss on a ballot: only Pick them myself', !/addr-retry/.test(ah) && /addr-pick/.test(ah));
    S.view = 'start'; S.ui.addrFail = 'down';
    ah = views.mast.addrHTML(true);
    check('go check: on the first page: Try again, nothing to pick', /addr-retry/.test(ah) && !/addr-pick/.test(ah));
    S.ui.addrOpen = false; S.ui.addrMsg = null; S.ui.addrFail = ''; S.view = keep.view;
    // The registration alert's button: every state file carries its vote.gov register link.
    const txr = read('state-TX.json').howto;
    check('go check: "Register now" before the deadline, "Register for next time" after', plan.registerAction(txr, '2026-10-01').label === 'Register now' && plan.registerAction(txr, '2026-10-20').label === 'Register for next time' && plan.registerAction(txr, '2026-10-01').url === 'https://vote.gov/register/texas');
    const { register_url, ...noUrl } = txr.registration;
    check('go check: no button without a register link', plan.registerAction({ ...txr, registration: noUrl }, '2026-10-01') === null);
  }

  /* ---------- flow, Oct 20: My plan ---------- */
  {
    const cheat = views.cheat;
    open('TX', ['austin-tx']);
    const sc = cheat.cheatHTML(false);
    check('My plan: titled "Your voting plan", on screen and in print', /<h2 id="cs-h">Your voting plan<\/h2>/.test(sc) && /<h2 id="cs-p">Your voting plan<\/h2>/.test(cheat.cheatHTML(true)) && !/cheat sheet/i.test(sc));
    check('My plan: Texas bans phones in the voting room, so "print it or write it down"', cheat.saveLine('2026-10-20') === 'Print it or write it down.' && /<b>Save it before you go\.<\/b> Print it or write it down\./.test(sc.replace(/&#39;/g, '’')));
    check('My plan: the save line sits under the reminder, on screen only', sc.indexOf('class="remind"') < sc.indexOf('save-go') && !/save-go/.test(cheat.cheatHTML(true)));
    check('My plan: in person, the reminder keeps the booth rules', cheat.essentials('2026-10-20').some((x) => /^In the booth:/.test(x)));
    check('My plan: once voting has closed, no save line', cheat.saveLine('2026-11-04') === null);
    open('CA', ['los-angeles-ca']);
    check('My plan: where phones are allowed, "Print it, copy it, or take a screenshot."', cheat.saveLine('2026-10-20') === 'Print it, copy it, or take a screenshot.');
    const la = cheat.essentials('2026-10-20');
    check('My plan: a mail phase leads with the mail steps and drops the booth line', /^Mail your ballot by/.test(la[0]) && la.some((x) => /drop box/.test(x)) && !la.some((x) => /In the booth/.test(x)), la.join(' | '));
    open('NY', ['nyc-manhattan-ny']);
    check('My plan: where phones are restricted, "Print it or copy it."', cheat.saveLine('2026-10-20') === 'Print it or copy it.');
    open('TX', ['austin-tx']);
    const end = views.ledger.ballotHTML();
    check('My plan: the ballot ends "That’s your whole ballot. Next, save your plan." with "Open my plan"', /That’s your whole ballot\.<\/h3><p>Next, save your plan\.<\/p>/.test(end) && /data-act="cheat" data-fk="endcap-cheat">Open my plan</.test(end));
  }

  /* ---------- flow, Oct 20: the share page ---------- */
  {
    const pass = views.pass;
    const fam = 'Got a plan to vote? Here’s a guide to help you sort through your ballot: https://vote.kevinhg.com/\n\nIf you’ve already voted, text three people and ask if they have a plan too.';
    const sd = pass.shareData(fam);
    check('share: the share sheet gets the message with the guide as its link, not twice', sd.url === pass.GUIDE_URL && sd.title === 'Quickly make your voting plan.' && sd.text === 'Got a plan to vote? Here’s a guide to help you sort through your ballot.\n\nIf you’ve already voted, text three people and ask if they have a plan too.', JSON.stringify(sd));
    const odd = pass.shareData('See https://vote.kevinhg.com/ for your ballot.');
    check('share: a message worded another way goes as written, with no separate link', odd.text === 'See https://vote.kevinhg.com/ for your ballot.' && !('url' in odd));
    // The work message's where-to-vote line: the early voting sites during early voting (dates pinned).
    const had = Object.getOwnPropertyDescriptor(globalThis, 'location');
    const on = (d) => Object.defineProperty(globalThis, 'location', { configurable: true, value: { search: `?today=${d}`, origin: 'http://x', pathname: '/' } });
    try {
      on('2026-10-20');
      open('TX', ['austin-tx']);
      let pub = pass.messages().pub || '';
      check('share: Austin during early voting links the state’s early voting sites', /\nFind early voting places: https:\/\/www\.votetexas\.gov\/voting\/where\.html\n/.test(pub), pub);
      open('FL', ['orlando-fl']);
      pub = pass.messages().pub || '';
      check('share: Orlando during early voting links Orange County’s early voting page, by name', /Find early voting places in Orlando: https:\/\/voteorangefl\.gov\/event\/early-voting-general-election\//.test(pub) && !/find-your-polling-place/.test(pub), pub);
      on('2026-11-02');
      pub = pass.messages().pub || '';
      check('share: Orlando after early voting links where to vote on Election Day', /Find where to vote in Orlando: https:\/\/voteorangefl\.gov\/find-your-polling-place\//.test(pub), pub);
      on('2026-10-20');
      open('CA', ['los-angeles-ca']);
      pub = pass.messages().pub || '';
      check('share: a mail state keeps its own where-to-vote page', /Find where to vote in Los Angeles: https:\/\/locator\.lavote\.net/.test(pub) && !/early voting places/.test(pub), pub);
      open('FL', []);
      pub = pass.messages().pub || '';
      check('share: a statewide ballot before early voting opens gets no where-to-vote line', !/Find (early voting places|where to vote)/.test(pub), pub);
      open('TX', []);
      pub = pass.messages().pub || '';
      check('share: a statewide Texas ballot during early voting gets the state’s early voting page', /Find early voting places: https:\/\/www\.votetexas\.gov\/voting\/where\.html/.test(pub), pub);
    } finally {
      if (had) Object.defineProperty(globalThis, 'location', had); else delete globalThis.location;
    }
  }

  /* ---------- flow, Oct 20: resume ---------- */
  {
    open('TX', ['austin-tx']);
    S.b.picks[bl.decisionItems().find((x) => !x.question).id] = 'SKIP'; // one race decided (left blank)
    const m = bl.decisionItems().length;
    const keep = { view: S.view, uiView: S.ui.view, pending: S.pending };
    S.view = 'ballot'; S.ui.view = 'ballot'; S.pending = null;
    S.ui.resume = true;
    const r = views.mast.restoreHTML();
    check('resume: "Welcome back. You’ve decided 1 of M." with "Pick up where I left off" (the menu’s Next) and a close', /<b>Welcome back\.<\/b> You’ve decided 1 of \d+\./.test(r) && r.includes(`decided 1 of ${m}.`) && /data-act="next"[^>]*>Pick up where I left off</.test(r) && /data-act="resume-x"[^>]*aria-label="Close"/.test(r), r.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
    S.ui.view = 'cheat';
    check('resume: only on the ballot view', views.mast.restoreHTML() === '');
    S.ui.view = 'ballot'; S.ui.resume = false;
    check('resume: nothing once it’s gone', views.mast.restoreHTML() === '');
    S.view = keep.view; S.ui.view = keep.uiView; S.pending = keep.pending;
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
    check('plan: Colorado mentions in-person voting opening today', cs.sub.some((x) => /in person, starting today/.test(x)), cs.sub.join(' | '));
    const caH = read('state-CA.json').howto;
    const alert = plan.registrationAlert(caH, '2026-10-19');
    check('plan: California on Oct 19 warns registration closes today, then same-day', !!alert && /today/i.test(alert) && /register and vote in person/.test(alert), alert || '');
    const words = (st) => st.head.map((p) => p[0]).join('');
    check('plan: Election Day says polls close', /Polls close at 7 PM/.test(words(plan.nextStep(open('TX', ['austin-tx']).howto, '2026-11-03', false, 10 * 60))));
    // Codex r2 (r1 #12): poll times are compared where the polls are, never on the device's clock.
    const austin = open('TX', ['austin-tx']).howto;
    check('plan: Austin is on Central time', JSON.stringify(austin.zones) === '["America/Chicago"]');
    check('plan: at 7:30 PM Central (01:30 UTC) Austin says the polls closed, on any device', plan.nextStep(austin, '2026-11-03', false, new Date('2026-11-04T01:30:00Z')).phase === 'polls_closed');
    check('plan: at 6:59 PM Central Austin is still voting', plan.nextStep(austin, '2026-11-03', false, new Date('2026-11-04T00:59:00Z')).phase === 'election_day');
    const txAll = plan.nextStep(tx, '2026-11-03', false, new Date('2026-11-04T01:30:00Z'));
    check('plan: a statewide Texas ballot waits for El Paso (Mountain time) before saying closed', txAll.phase === 'election_day' && /Your local polls close at 7 PM/.test(words(txAll)), words(txAll));
    check('plan: and says closed once every Texas zone has closed', plan.nextStep(tx, '2026-11-03', false, new Date('2026-11-04T02:01:00Z')).phase === 'polls_closed');
    // Codex r3: after midnight in Texas (10:10 PM on a Pacific device) the polls must not reopen.
    check('plan: after midnight Central on Nov 4, a Pacific device still on Nov 3 says closed', plan.nextStep(austin, '2026-11-03', false, new Date('2026-11-04T06:10:00Z')).phase === 'polls_closed');
    check('plan: a statewide Texas ballot after midnight in both zones says closed', plan.nextStep(tx, '2026-11-03', false, new Date('2026-11-04T07:30:00Z')).phase === 'polls_closed');
    check('plan: Pensacola is on Central time, Orlando Eastern', JSON.stringify(open('FL', ['pensacola-fl']).howto.zones) === '["America/Chicago"]' && JSON.stringify(open('FL', ['orlando-fl']).howto.zones) === '["America/New_York"]');
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
    // Final round A: the place's own where-to-vote tool wins over the state's; a statewide ballot
    // never gets one county's page.
    const den = plan.nextStep(open('CO', ['denver-co']).howto, '2026-10-19');
    check('lookups: Denver\'s drop box button goes to Denver\'s own page', /denvergov\.org/.test((den.primary || {}).url || ''), JSON.stringify(den.primary));
    const spo = plan.nextStep(open('WA', []).howto, '2026-10-19');
    check('lookups: a statewide Washington ballot never gets King County\'s page', !!spo.primary && !/kingcounty\.gov/.test(spo.primary.url), JSON.stringify(spo.primary));
    const sea = plan.nextStep(open('WA', ['seattle-wa']).howto, '2026-10-19');
    check('lookups: Seattle gets King County\'s drop boxes', /kingcounty\.gov/.test((sea.primary || {}).url || ''), JSON.stringify(sea.primary));
    const pgh = plan.nextStep(open('PA', ['pittsburgh-pa']).howto, '2026-11-03', false, 10 * 60);
    check('lookups: Pittsburgh on Election Day finds polls through Allegheny County', /alleghenycounty\.us/.test((pgh.primary || {}).url || ''), JSON.stringify(pgh.primary));
    // Codex #5: a county's own early-voting window wins over the state's.
    const fl = read('state-FL.json').howto;
    const orl = open('FL', ['orlando-fl']).howto.early_in_person;
    const pen = open('FL', ['pensacola-fl']).howto.early_in_person;
    check('plan: Orlando uses Orange County early voting, Oct 19 to Nov 1', orl.start === '2026-10-19' && orl.end === '2026-11-01' && /voteorangefl\.gov/.test(orl.lookup_url || '') && /Orange County/.test(orl.hours_note || ''), JSON.stringify(orl));
    check('plan: Pensacola ends Oct 31 with no Sunday', pen.end === '2026-10-31' && /escambiavotes\.gov/.test(pen.lookup_url || ''), JSON.stringify(pen));
    check('plan: on Nov 1 Orlando can still vote early, Pensacola cannot', plan.nextStep(open('FL', ['orlando-fl']).howto, '2026-11-01').phase === 'early_open' && plan.nextStep(open('FL', ['pensacola-fl']).howto, '2026-11-01').phase === 'election_day_next');
    check('plan: a ballot with no county window keeps the state window', open('FL', []).howto.early_in_person.end === fl.early_in_person.end);
    // Codex r2 P1: a statewide Florida ballot (Hamilton County, 32052) must not say early voting started Oct 19.
    const flAll = plan.nextStep(open('FL', []).howto, '2026-10-19');
    check('plan: statewide Florida on Oct 19 says early voting starts Sat, Oct 24, and that some counties open sooner', /^Early voting starts Sat, Oct 24\.$/.test(words(flAll)) && flAll.sub.some((x) => /Some counties open sooner/.test(x)), `${words(flAll)} | ${flAll.sub.join(' | ')}`);
    check('plan: Orlando on Oct 19 still says early voting starts today', /^Early voting starts today, Oct 19\.$/.test(words(plan.nextStep(open('FL', ['orlando-fl']).howto, '2026-10-19'))));
    const a1 = { early_in_person: { start: '2026-10-19', end: '2026-11-01', hours_note: 'A', lookup_url: 'https://a.example', source: 'https://a.example', confidence: 'verified' } };
    const a2 = { early_in_person: { start: '2026-10-24', end: '2026-10-31', hours_note: 'B', lookup_url: 'https://b.example', source: 'https://b.example', confidence: 'verified' } };
    check('plan: places that disagree keep the state window', plan.localHowto(fl, [a1, a2]).early_in_person === fl.early_in_person && plan.localHowto(fl, [a1, {}]).early_in_person === fl.early_in_person);
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

  /* ---------- common questions: quick answers with buttons (Kevin, Oct 20) ----------
     "They should be quick answers with things that you can do." Each situation's short answer is
     one line with up to two official buttons; the full answer, steps and source sit behind "More".
     A state file without the short lines shows its questions as before. */
  {
    const ps = views.planstrip;
    const n = (t) => String(t || '').trim().split(/\s+/).filter(Boolean).length;
    const bad = [];
    let shorts = 0;
    let buttons = 0;
    for (const s of Object.keys(INDEX.states)) {
      const h = read(`state-${s}.json`).howto;
      for (const x of h.situations || []) {
        if (x.short) { shorts++; if (n(x.short) > 20) bad.push(`${s} ${x.id}: ${n(x.short)} words`); }
        const acts = x.actions || [];
        buttons += acts.length;
        if (acts.length > 2 || acts.some((a) => !a.label || !/^https:\/\//.test(a.url))) bad.push(`${s} ${x.id}: buttons`);
      }
      const gs = h.gotcha_shorts;
      if (gs && (gs.length !== h.gotchas.length || gs.some((g) => g && n(g) > 15))) bad.push(`${s}: gotcha_shorts`);
      if (h.registration.register_url && !/^https:\/\/vote\.gov\/register\/[a-z-]+$/.test(h.registration.register_url)) bad.push(`${s}: register_url`);
    }
    check(`common questions: ${shorts} quick answers and ${buttons} buttons in the bundles, each within its limits`, bad.length === 0 && shorts > 0, bad.slice(0, 5).join(' | '));
    const tx = read('state-TX.json').howto;
    check('common questions: every Texas and California question and mistake has its short line', ['TX', 'CA'].every((s) => { const h = read(`state-${s}.json`).howto; return h.situations.every((x) => x.short) && h.gotcha_shorts && h.gotcha_shorts.every(Boolean); }));
    check('common questions: Texas registers for next time at vote.gov', tx.registration.register_url === 'https://vote.gov/register/texas' && tx.situations.find((x) => x.id === 'not_registered').actions.some((a) => a.label === 'Register for next time' && a.url === tx.registration.register_url));

    const saved = st.S.ui.open;
    open('TX', ['austin-tx']);
    st.S.ui.open = new Set(['whatif', 'wi-not_registered']);
    let html = ps.planHTML();
    // One question's markup: from its button to the next question's.
    const sit = (h, id) => { const i = h.indexOf(`data-k="wi-${id}"`); if (i < 0) return ''; const j = h.indexOf('<button class="wi-q"', i); return h.slice(i, j < 0 ? undefined : j); };
    let q = sit(html, 'not_registered');
    check('common questions: an opened question shows its quick answer and two buttons', /class="wi-short"/.test(q) && (q.match(/class="pbtn line"/g) || []).length === 2 && /href="https:\/\/vote\.gov\/register\/texas"/.test(q) && />Register for next time</.test(q), q.slice(0, 300));
    check('common questions: its full answer waits behind "More"', !/sorry: the Texas deadline/.test(q) && /data-k="wim-not_registered"[^>]*aria-expanded="false"[^>]*>More</.test(q));
    st.S.ui.open.add('wim-not_registered');
    q = sit(ps.planHTML(), 'not_registered');
    check('common questions: "More" shows the full answer, the steps and the source', /sorry: the Texas deadline/.test(q) && /<ol>/.test(q) && /class="src"/.test(q) && />Less</.test(q));
    html = ps.planHTML();
    check('common mistakes: each shows its one-line fix, the full text behind its own "More"', (html.match(/class="g-short"/g) || []).length === tx.gotchas.length && !/Election Code 61\.014/.test(html) && /data-k="gm-2"/.test(html));
    st.S.ui.open.add('gm-2');
    check('common mistakes: "More" shows that mistake in full', /Election Code 61\.014/.test(ps.planHTML()));
    // A state file with no short lines keeps today's display.
    const b = open('TX', ['austin-tx']);
    b.howto = { ...b.howto, situations: b.howto.situations.map(({ short, actions, ...r }) => r), gotcha_shorts: undefined };
    st.S.ui.open = new Set(['whatif', 'wi-not_registered']);
    html = ps.planHTML();
    q = sit(html, 'not_registered');
    check('common questions: without short lines, a question opens to its full answer as before', /sorry: the Texas deadline/.test(q) && !/wi-short|wim-/.test(q) && !/g-short/.test(html) && /<strong>Registration is closed\.<\/strong>/.test(html));
    // An unconfirmed answer says so beside its quick answer, before "More" (review, Oct 20).
    open('GA', ['atlanta-ga']);
    st.S.ui.open = new Set(['whatif', 'wi-no_mail_ballot_or_lost', 'wi-wrong_polling_place']);
    html = ps.planHTML();
    q = sit(html, 'no_mail_ballot_or_lost');
    check('common questions: Georgia’s unconfirmed lost-ballot answer says "Not yet confirmed." before More', /class="wi-short"/.test(q) && /class="meta wi-more">Not yet confirmed\. <button[^>]*>More</.test(q), q.slice(0, 400));
    check('common questions: a confirmed answer has no such mark', !/Not yet confirmed/.test(sit(html, 'wrong_polling_place')));
    const unconfirmed = Object.keys(INDEX.states).flatMap((s) => (read(`state-${s}.json`).howto.situations || []).filter((x) => x.short && x.confidence === 'unverified').map((x) => `${s} ${x.id}`));
    check('common questions: the data has an unconfirmed quick answer for the mark to cover', unconfirmed.length >= 1, unconfirmed.join(', '));
    // Quick answers keep the condition or the place the full answer gives (review, Oct 20).
    const ny = read('state-NY.json').howto.situations.find((x) => x.id === 'wrong_polling_place');
    check('common questions: New York’s wrong poll site says where an affidavit ballot counts', /county and Assembly district/.test(ny.short) && /county and Assembly district/.test(ny.answer), ny.short);
    const fl = read('state-FL.json').howto;
    const flMail = fl.gotchas.findIndex((t) => /IN the supervisor's office/.test(t));
    check('common mistakes: Florida’s late mail ballot goes to early voting or the supervisor’s office', flMail >= 0 && /early voting or the supervisor's office/.test(fl.gotcha_shorts[flMail]) && /supervisor's main or branch office/.test(fl.gotchas[flMail]), fl.gotcha_shorts[flMail]);
    st.S.ui.open = saved;

    // The places' one-line hours, and Austin's window adds nothing else to the plan.
    const au = open('TX', ['austin-tx']);
    const txEp = read('state-TX.json').howto.early_in_person;
    check('hours: Austin and Orlando carry a one-line early voting hours note', au.places[0].early_in_person.hours_short === 'Travis County sites are open 7 AM to 7 PM every day.' && open('FL', ['orlando-fl']).places[0].early_in_person.hours_short === 'Orange County sites are open 8 AM to 8 PM every day.');
    check('hours: Austin keeps the state window, hours note and lookup in the plan', au.howto.early_in_person.start === txEp.start && au.howto.early_in_person.end === txEp.end && au.howto.early_in_person.hours_note === txEp.hours_note && au.howto.early_in_person.lookup_url === txEp.lookup_url);
    // The plan's sub line during early voting: the place's one-line hours, then the ID.
    {
      const had = Object.getOwnPropertyDescriptor(globalThis, 'location');
      Object.defineProperty(globalThis, 'location', { configurable: true, value: { search: '?today=2026-10-20', origin: 'http://x', pathname: '/' } });
      try {
        const subOf = (h) => (h.match(/<p class="plan-sub">([^<]*)<\/p>/) || [])[1] || '';
        open('TX', ['austin-tx']);
        let sub = subOf(ps.planHTML());
        // Austin reaches into Williamson and Hays, so Travis County's hours can't speak for it.
        check('hours: Austin, across three counties, names no one county\'s hours and keeps "in your county"', !/Travis County sites/.test(sub) && /any early voting location in your county\./.test(sub) && /Bring a photo ID\.$/.test(sub), sub);
        // The hours line stands in for the step's own lines ("any early voting location", "Or vote on
        // Election Day"), so the strip reads two short sentences.
        const orl = open('FL', ['orlando-fl']);
        sub = subOf(ps.planHTML());
        check('hours: Orlando\'s next step says when Orange County sites are open, then to bring a photo ID, and nothing else', sub === 'Orange County sites are open 8 AM to 8 PM every day. Bring a photo ID.', sub);
        orl.places[0] = { ...orl.places[0], counties: ['Orange', 'Seminole'] };
        sub = subOf(ps.planHTML());
        check('hours: the same place across two counties drops the hours line', !/Orange County sites/.test(sub) && /Bring a photo ID\.$/.test(sub), sub);
        // Without an hours line the step keeps its own lines, then the ID.
        open('FL', ['pensacola-fl']);
        sub = subOf(ps.planHTML());
        check('hours: a place with no one-line hours keeps the step\'s own lines, then the ID', /in your county\./.test(sub) && /Or vote on Election Day/.test(sub) && /Bring a photo ID\.$/.test(sub), sub);
      } finally {
        if (had) Object.defineProperty(globalThis, 'location', had); else delete globalThis.location;
      }
    }

    // A statewide-only ballot's sample ballot link: the state's own, else a source, else the lookup.
    open('WA', []);
    check('sample ballot: statewide Washington goes to VoteWA, not one county', common.sampleBallot().url === 'https://voter.votewa.gov/');
    open('TX', ['austin-tx']);
    check('sample ballot: a place\'s own link still wins', common.sampleBallot().url === au.places[0].sample_ballot_url);
    open('CA', []);
    check('sample ballot: a state with none keeps the old fallback', !!common.sampleBallot() && !read('state-CA.json').howto.sample_ballot_url);
  }
}
