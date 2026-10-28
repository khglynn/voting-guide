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
    check('verdict: under a tally the column says "picks split" (Kevin, Oct 20: "they split" was confusing)', v.sub === 'picks split', v.sub);
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
      check('party fill: the row says "From your party", not "From your sources"', pv.sub === 'From your party', JSON.stringify(pv));
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
    const reset = () => { S.ui.view = 'ballot'; S.ui.row = null; S.ui.keep = null; S.ui.unfolded = new Set(); S.ui.folded = new Set(); S.b.hideDecided = false; };
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

  /* ---------- "Hide races I've decided" (Kevin, Oct 20): the beat and the band's count ----------
     A decided row hides unless it is open, in its beat, or in a section whose count you tapped; a
     finished section stays on the page as its folded band; the count is a button with Show or
     Hide after it, except under the filter with nothing decided yet. */
  {
    const { ledger } = views;
    const b = open('CO', ['denver-co']);
    const reset = () => { S.ui.view = 'ballot'; S.ui.row = null; S.ui.keep = null; S.ui.beat = null; S.ui.unfolded = new Set(); S.ui.folded = new Set(); S.ui.reveal = new Set(); S.b.hideDecided = false; };
    reset();
    const ms = () => bl.entriesBySection().get('measures') || [];
    const m0 = ms().find((e) => e.t === 'item').id;
    S.b.picks[m0] = 'YES';
    const has = (sec, id) => ledger.sectionHTML(sec, bl.entriesBySection().get(sec) || []).includes(`id="i-${id}"`);
    const cnt = (sec) => ledger.countHTML(sec, bl.entriesBySection().get(sec) || []);
    check('hide: without the filter the count folds its section: a button reading Hide', /^<button class="sec-r sec-cb" data-act="sec-count" data-sec="measures" aria-expanded="true"[^>]*><span class="sec-count">1 of \d+ decided<\/span> <span class="sec-edit">Hide<\/span><\/button>$/.test(cnt('measures')) && has('measures', m0), cnt('measures'));
    S.b.hideDecided = true;
    check('hide: under the filter a decided row hides', ledger.hiddenByOnly({ t: 'item', id: m0 }, 'measures') && !has('measures', m0));
    check('hide: and its count reads Show, collapsed', /aria-expanded="false"[^>]*><span class="sec-count">1 of \d+ decided<\/span> <span class="sec-edit">Show</.test(cnt('measures')), cnt('measures'));
    S.ui.beat = m0;
    check('hide: in its beat the row stays, marked', !ledger.hiddenByOnly({ t: 'item', id: m0 }, 'measures') && /data-beat/.test(ledger.rowHTML(b.byId.get(m0))) && has('measures', m0));
    S.ui.beat = null;
    S.ui.row = m0;
    check('hide: open, it stays', has('measures', m0));
    S.ui.row = null;
    S.ui.reveal.add('measures');
    check('hide: its section\'s count tapped, the decided rows show, and the count reads Hide', has('measures', m0) && /aria-expanded="true"[^>]*><span class="sec-count">1 of \d+ decided<\/span> <span class="sec-edit">Hide</.test(cnt('measures')), cnt('measures'));
    check('hide: other sections keep hiding theirs', (() => { const st0 = (bl.entriesBySection().get('state') || []).find((e) => e.t === 'item'); S.b.picks[st0.id] = 'SKIP'; const out = !has('state', st0.id); delete S.b.picks[st0.id]; return out; })());
    S.ui.reveal.delete('measures');
    const fed = bl.entriesBySection().get('federal') || [];
    check('hide: with nothing decided under the filter, the count is just the count', cnt('federal') === `<span class="sec-r"><span class="sec-count">${ledger.sectionCount(fed)}</span></span>` && /^0 of /.test(ledger.sectionCount(fed)), cnt('federal'));
    // A finished section: under the filter, its band, folded, with Show; in its last row's beat, open.
    const city = b.byId.get('denver-council-at-large-b');
    S.b.picks[city.id] = city.candidates[0].name;
    const ch = () => ledger.sectionHTML('city', bl.entriesBySection().get('city') || []);
    check('hide: a finished section under the filter stays as its folded band, "1 of 1 decided" with Show', /class="sec done folded"/.test(ch()) && !/<li class="row/.test(ch()) && /1 of 1 decided<\/span> <span class="sec-edit">Show/.test(ch()), ch().slice(0, 200));
    S.ui.beat = city.id;
    check('hide: while its last row has its beat, it stays open', !/folded/.test(ch()) && ch().includes(`id="i-${city.id}"`));
    S.ui.beat = null;
    S.ui.reveal.add('city');
    check('hide: its count tapped, it opens with the decided row', !/folded/.test(ch()) && ch().includes(`id="i-${city.id}"`) && /sec-edit">Hide/.test(ch()));
    S.ui.reveal.delete('city');
    S.b.hideDecided = false;
    check('hide: without the filter the finished section folds as before, and its count reads Show', /class="sec done folded"/.test(ch()) && /sec-edit">Show/.test(ch()));
    S.ui.unfolded.add('city');
    check('hide: unfolded, it reads Hide', !/folded/.test(ch()) && /sec-edit">Hide/.test(ch()));
    check('hide: the band\'s title and its count are two buttons, the count outside the band\'s', /<button class="sec-hd" data-act="sec"[^>]*>\s*<span class="sec-l">[\s\S]*?<\/button><button class="sec-r sec-cb" data-act="sec-count"/.test(ch()), ch().slice(0, 400));
    delete S.b.picks[city.id];
    delete S.b.picks[m0];
    reset();
  }

  /* ---------- the menu (flow, Oct 20): "Next up", the rows and their counts ----------
     "Next up" names the next undecided race or question after the row you're on, in page order,
     and its button opens that one; the section rows' "N left" add up to the bar; when nothing the
     count includes is left there is no "Next up" and every row says "Done". */
  {
    const { ledger } = views;
    const reset = () => { S.ui.view = 'ballot'; S.ui.row = null; S.ui.keep = null; S.ui.unfolded = new Set(); S.ui.folded = new Set(); S.b.hideDecided = false; };
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
      check(`menu: ${pid} "Next up" leads, then your next step and Quick picks, then the switch right above the sections, then My plan, then Report a problem, ending with How this guide works, both opening the shelf`, at('data-act="next"') < at('data-to="plan"') && at('data-to="plan"') < at('data-act="picks"') && at('data-act="picks"') < at('data-act="only"')
        && at('data-act="only"') < at('data-act="jump" data-to="federal"') && at('data-act="jump" data-to="federal"') < at('data-act="cheat"')
        && /My plan<\/span><span class="nv-n"><\/span><i class="nv-a" aria-hidden="true">›<\/i><\/button><\/li><\/ul>\s*<ul class="nv-list nv-end"><li><button class="nv nv-report" data-act="shelf" data-kind="report" aria-haspopup="dialog" data-fk="toc-report"><span class="nv-t">Report a problem<\/span><span class="nv-n"><\/span><i class="nv-a" aria-hidden="true">›<\/i><\/button><\/li>\s*<li><button class="nv nv-how" data-act="shelf" data-kind="how" aria-haspopup="dialog" data-fk="toc-how"><span class="nv-t">How this guide works<\/span><span class="nv-n"><\/span><i class="nv-a" aria-hidden="true">›<\/i><\/button><\/li><\/ul>$/.test(html.trim()));
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
    S.ui.view = 'ballot'; S.ui.row = null; S.ui.keep = null; S.ui.unfolded = new Set(); S.ui.folded = new Set(); S.b.hideDecided = false;
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
      check('fill names: a pick filled from one source says "From" that source', v.sub === `From ${src.short}`, `${one.id}: ${v.sub}`);
    }
    if (many) check('fill names: a pick several sources agreed on still says "From your sources"', tally.verdict(b.byId.get(many.id)).sub === 'From your sources', tally.verdict(b.byId.get(many.id)).sub);
    // A single source whose name holds a comma or the word "Party" is still named, not "your party".
    const it = b.items.find((x) => x.kind === 'measure');
    const party = b.endorsers.find((e) => /party/i.test(e.short) && e.endorses_measures);
    if (party) {
      S.b.picks[it.id] = 'YES';
      S.b.auto[it.id] = `Filled in from your sources: ${party.short}`;
      check('fill names: an agree fill from one party organization names it, not "your party"', tally.verdict(it).sub === `From ${party.short}`, tally.verdict(it).sub);
    }
    const comma = b.endorsers.find((e) => /, /.test(e.short));
    if (comma) {
      S.b.auto[it.id] = `Filled in from your sources: ${comma.short}`;
      check('fill names: a source whose name has a comma is still one source', tally.verdict(it).sub === `From ${comma.short}`, tally.verdict(it).sub);
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
    check('cheat sheet: an unanswered district question is still a line, pointing to the sample ballot', /Your official sample ballot shows which/.test(html));
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
    check('fill line: no party, "{n} races where they agree ({k} from just one source). Races where picks split stay open."', views.setup.fillLine(null) === `${a0.fills.length} races where they agree${a0.single ? ` (${a0.single} from just one source)` : ''}. Races where picks split stay open.`, views.setup.fillLine(null));
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
      && door.includes('Fill in my ballot with their picks') && door.includes('Fills the races where they agree. Races where picks split stay open.') && door.includes('Hide races I’ve decided'));
    S.door.chips = { papers: false, progressive: false, conservative: false };
    const doorNone = views.setup.pickControlsHTML();
    check('first page before a ZIP: every chip off is "Show endorsements" off, with no chips and no fill switch', lens.doorNone() && /data-act="ends" data-fk="ends"/.test(doorNone) && /role="switch" aria-checked="false" data-act="ends"/.test(doorNone) && !/data-act="chip"/.test(doorNone) && !/setup-fill/.test(doorNone));
    S.door.chips = { papers: true, progressive: false, conservative: false };
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
    check('go check: a maybe state senate race offers Check with my address, Official sample ballot, It’s not on my ballot, in that order',
      /Only on some ballots\./.test(sd) && at('>Check with my address<') > 0 && at('>Check with my address<') < at('>Official sample ballot<') && at('>Official sample ballot<') < at('>It’s not on my ballot<'), strip(sd).slice(0, 200));
    check('go check: its address button opens the address form', /data-act="addr-open"[^>]*>Check with my address/.test(sd));
    check('go check: "It’s not on my ballot" keeps the notmine action', /data-act="notmine" data-id="tx-senate-21"[^>]*>It’s not on my ballot/.test(sd));
    // The address box leads with "Use my address" only while the lookup can settle something:
    // Congress and the state legislature, before a lookup has run on this ballot.
    const btns = (h) => [...((h.match(/<div class="addrbox[^"]*">[\s\S]*?<\/div><\/div>/) || [''])[0]).matchAll(/class="mini( dark)?"[^>]*>([^<]+)</g)].map((m) => `${m[2]}${m[1] ? ' (dark)' : ''}`).join('|');
    check('address box: Austin, fresh, offers Use my address first, then the sample ballot', btns(ledger.ballotHeadHTML()) === 'Use my address (dark)|Official sample ballot' && ledger.addressHelps(), btns(ledger.ballotHeadHTML()));
    // What the lookup answers (Congress, the state Senate and House, and the maybe rows for them).
    for (const g of au.groups) if (g.kind) S.b.districts[g.key] = g.members[0];
    for (const id of au.mayApply) { const c = au.byId.get(id); if (c.kind === 'contest' && views.open.censusSettles(c)) S.b.notMine.push(id); }
    // Austin has district maps (council, trustees, county precincts), so its council, county and school
    // questions are the address's to answer too, and Use my address stays.
    check('address box: Austin, with the Census’s races answered, still offers Use my address: its maps answer the council, county and trustee questions', ledger.addressCount() > 0 && ledger.addressHelps() && btns(ledger.ballotHeadHTML()) === 'Use my address (dark)|Official sample ballot', btns(ledger.ballotHeadHTML()));
    S.b.districts = {}; S.b.notMine = [];
    // A ballot with no maps (San Antonio; Dallas has them since Oct 26): once only council, county and
    // school questions are left, the sample ballot leads.
    const da = open('TX', ['san-antonio-tx']);
    for (const g of da.groups) if (g.kind) S.b.districts[g.key] = g.members[0];
    for (const id of da.mayApply) { if (views.open.censusSettles(da.byId.get(id))) S.b.notMine.push(id); } // races and school measures alike
    const left = ledger.addressCount();
    check('address box: with only council, county and school questions left, the sample ballot leads and Use my address goes', left > 0 && !ledger.addressHelps() && btns(ledger.ballotHeadHTML()) === 'Official sample ballot (dark)' && new RegExp(`${left} races depend on your address`).test(ledger.ballotHeadHTML()), `${left} | ${btns(ledger.ballotHeadHTML())}`);
    open('TX', ['austin-tx']);
    S.b.districts = {}; S.b.notMine = [];
    S.b.addrNote = 'Your districts: Congressional District 37. We didn’t save your address. Double-check with your sample ballot.';
    check('address box: once a lookup has run, it offers only the sample ballot', !ledger.addressHelps() && btns(ledger.ballotHeadHTML()) === 'Official sample ballot (dark)', btns(ledger.ballotHeadHTML()));
    const sd2 = views.open.openHTML(au.byId.get('tx-senate-21'));
    // Kevin, Oct 25: one sample-ballot button per screen, the head's; a row's is a plain link.
    check('address box: and a maybe row no longer offers Check with my address, its sample ballot a plain link', !/Check with my address/.test(sd2) && /class="linkbtn" href="https:[^"]+"[^>]*>Official sample ballot/.test(sd2) && !/class="mini[^"]*"[^>]*>Official sample ballot/.test(sd2));
    S.ui.row = `q:${au.groups.find((x) => x.kind === 'cd').key}`;
    check('address box: nor does a district question', !/data-fk="dq-addr"/.test(ledger.sectionHTML('federal', bl.entriesBySection().get('federal'))));
    S.ui.row = null;
    S.b.addrNote = null;
    S.ui.row = `q:${au.groups.find((x) => x.kind === 'cd').key}`;
    check('address box: before a lookup, a Congress question offers Use my address', /data-fk="dq-addr"/.test(ledger.sectionHTML('federal', bl.entriesBySection().get('federal'))));
    S.ui.row = null;
    open('FL', []);
    check('address box: statewide Florida (appeals judges only) offers the sample ballot, no Use my address', ledger.addressCount() > 0 && btns(ledger.ballotHeadHTML()) === 'Official sample ballot (dark)', `${ledger.addressCount()} | ${btns(ledger.ballotHeadHTML())}`);
    // With the index loaded, the coverage card shows (Oct 25), owns the dark button, and the box's is an outline.
    { const i0 = S.index; S.index = INDEX;
      check('address box: under a statewide card, the sample ballot is an outline and the city is the card’s', btns(ledger.ballotHeadHTML()) === 'Official sample ballot' && /Ask for my city/.test(views.coverage.covCardHTML('ballot')), btns(ledger.ballotHeadHTML()));
      S.index = i0; }
    open('TX', ['austin-tx']);
    const dv = views.open.openHTML(au.byId.get('tx-dvisd-prop-a'));
    check('go check: a school district’s measure offers Check with my address (the Census names your school district)', /Check with my address/.test(dv) && /Official sample ballot/.test(dv) && /It’s not on my ballot/.test(dv));
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
    // Kevin, Oct 20: a race that isn't yours leaves its section for one line at the bottom of the ballot.
    const off = ledger.offHTML();
    check('go check: it leaves its section for "Not on your ballot" at the bottom', !/Del Valle ISD Trustee/.test(strip(sch)) && /Not on your ballot: .*Del Valle ISD Trustee/.test(strip(off)), strip(off));
    S.ui.open.add('off');
    check('go check: opened, the list gives it "It’s on my ballot", which asks the question again', /data-act="district-change" data-g="[^"]*Del Valle[^"]*"[^>]*>It’s on my ballot/.test(ledger.offHTML()));
    S.ui.open.delete('off');
    const back = st.decodeShare(a2, head(st.encodeShare(a2, S.b))).state;
    check('go check: "none" travels in the save link', back.districts[dvg.key] === 'none');
    // "No endorsements" (Kevin, Oct 20): an option, never the default. Every source off and no party;
    // the rows stay tight: what it is, the choices with Pick, and the foot.
    const dn = open('CO', ['denver-co']);
    check('no endorsements: off by default, "Show endorsements" on', !lens.noEndorsements() && /role="switch" aria-checked="true" data-act="ends"/.test(views.setup.pickControlsHTML(true)));
    S.b.sources = [];
    tally.clearLineups();
    check('no endorsements: an empty source list is it, and the line says so', lens.noEndorsements() && views.lens.lensSummary() === 'Off');
    const sh = views.setup.pickControlsHTML(true);
    check('no endorsements: "Show endorsements" is off, the chips, the fill switch and the counts step aside, the filter stays', /role="switch" aria-checked="false" data-act="ends"[^>]*>.*Show endorsements.*<\/button>/.test(sh) && !/data-act="chip"|data-act="party|all-src/.test(sh) && !/setup-fill/.test(sh) && !/su-cov/.test(sh) && /setup-only/.test(sh));
    const m81 = views.open.openHTML(dn.byId.get('co-amendment-81'));
    check('no endorsements: a measure is tight, yes and no with no source lines', /A yes vote means/.test(m81) && /data-act="pick"[^>]*data-v="YES"/.test(m81) && !/none-line|gridnote|papers-on|others-wrap|class="grid/.test(m81), strip(m81).slice(0, 120));
    const race = dn.items.find((x) => x.kind === 'contest' && !x.is_retention && x.candidates.length > 1 && x.candidates.length <= 6 && !x.ranked_choice && bl.status(x) === 'open');
    S.ui.row = race.id;
    const rh = ledger.rowHTML(race);
    S.ui.row = null;
    check('no endorsements: a race lists its candidates with Pick, no grid, no source lines', /class="clist( full)?"/.test(rh) && (rh.match(/data-act="pick"/g) || []).length === race.candidates.length && !/class="grid|class="by"|none-line|gridnote|others-wrap/.test(rh), race.id);
    check('no endorsements: the verdict column is empty', /<span class="vd none blank"><\/span>/.test(ledger.rowHTML(race)) && !/No sources on/.test(ledger.rowHTML(race)));
    S.b.party = 'Democratic';
    check('no endorsements: a party ends it', !lens.noEndorsements());
    S.b.party = null;
    S.b.sources = null;
    tally.clearLineups();
    check('no endorsements: with sources on, the rows say whose picks they are again', /role="switch" aria-checked="true" data-act="ends"/.test(views.setup.pickControlsHTML(true)) && /setup-fill/.test(views.setup.pickControlsHTML(true)));
    // Statewide-only (Kevin, Oct 25: no double button stack): the coverage card under the masthead says so,
    // with the state's sample ballot (its own sample_ballot_url first) as a link and, picked from the list
    // with no ZIP, "Ask for my city"; the head holds no second notice.
    const wa = open('WA', []);
    const i1 = S.index; S.index = INDEX;
    const hd = ledger.ballotHeadHTML();
    const card = views.coverage.covCardHTML('ballot');
    const ask = (card.match(/<button ([^>]*)>Ask for my city</) || [])[1] || '';
    check('go check: a statewide ballot’s card says so, with the sample ballot as a link and Ask for my city', /Your city’s races aren’t in the guide yet\./.test(strip(card)) && /<a href="https:[^"]+"[^>]*>official sample ballot<\/a>/.test(card) && !!ask && /Tell Kevin your city and he’ll add it, usually within a day\./.test(strip(card)), strip(card).slice(0, 200));
    check('go check: Ask for my city opens the city request sheet (Oct 21)', /data-act="shelf"/.test(ask) && /data-kind="city"/.test(ask) && /aria-haspopup="dialog"/.test(ask), ask);
    check('go check: the head holds no statewide notice, and no sample ballot is dark', !/statewide-note|We only have/.test(hd) && !/class="mini dark"[^>]*>Official sample ballot/.test(hd + card), strip(hd));
    S.index = i1;
    wa.howto = { ...wa.howto, sample_ballot_url: 'https://sos.example.gov/sample' };
    check('go check: a state’s own sample_ballot_url wins on a statewide ballot', common.sampleBallot().url === 'https://sos.example.gov/sample');
    const au3 = open('TX', ['austin-tx']);
    au3.howto = { ...au3.howto, sample_ballot_url: 'https://sos.example.gov/sample' };
    check('go check: a place’s own sample ballot still wins over the state’s', common.sampleBallot().url === au3.places[0].sample_ballot_url);
    // Not covered: Vote.gov, then "Want this for your city? Ask Kevin." with the form prefilled.
    const keep = { view: S.view, ballot: S.ballot, index: S.index, coverage: S.coverage };
    S.view = 'start'; S.ballot = null; S.index = INDEX; S.coverage = { kind: 'not_covered', state: 'MA', zip: '02139' };
    const nc = views.mast.mastHTML();
    const kevin = (nc.match(/<button ([^>]*data-ask-kevin[^>]*)>Ask for my city</) || [])[1] || '';
    check('go check: not covered says "We don’t cover Massachusetts yet. Vote.gov has official info for every state."', /We don’t cover Massachusetts yet\. Vote\.gov has official info for every state\./.test(strip(nc)) && !/friends and family vote/.test(nc), strip(nc).slice(0, 300));
    check('go check: then one action, "Ask for my city", which opens the city request sheet (Oct 25: no "Ask Kevin", the sheet names him)', !/Ask Kevin/.test(nc) && /data-act="shelf"/.test(kevin) && /data-kind="city"/.test(kevin), kevin);
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
    {
      // The plan you carry: the sites' hours, Election Day, the ID rule, and a plain phone rule (UX walk, Oct 20).
      open('FL', ['orlando-fl']);
      const or = cheat.essentials('2026-10-21');
      check('My plan: Orlando keeps the hours, Election Day and the photo ID', or.some((x) => /open \d+ AM to \d+ PM/.test(x)) && or.some((x) => /^Or vote on Election Day, Tue, Nov 3/.test(x)) && or.includes('Bring a photo ID.'), or.join(' / '));
      check('My plan: a "restricted" phone rule is the state’s own line, not the bare word', or.includes('In the booth: notes are allowed. You can read your plan on your phone; the only photo allowed is of your own ballot.') && !or.some((x) => /restricted/.test(x)), or.join(' / '));
    }
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
    const heads = [...html.matchAll(/<h3 class="wi-h">([^<]*)<\/h3>/g)].map((m) => m[1]);
    check('details: dates and ID first, then "Gotchas in Texas", then "If something goes wrong"', heads.join('|') === 'Dates, ID and voting rules|Gotchas in Texas|If something goes wrong' && html.indexOf('data-k="bx-dates"') < html.indexOf('data-k="gm-0"') && html.indexOf('data-k="gm-0"') < html.indexOf('data-k="wi-not_registered"'), heads.join('|'));
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
  /* ---------- Kevin, Oct 20: a clear address result ----------
     The Census's capitals tidied, every match it found, what the districts set on the ballot, and the
     line the ballot keeps (never the address). Made-up addresses only. */
  {
    const { address } = mods;
    const ledger = views.ledger;
    const t = geo.tidyAddress;
    check('address: the Census capitals read the way people write them', t('100 N TEST ST, AUSTIN, TX, 78704') === '100 N Test St, Austin, TX 78704', t('100 N TEST ST, AUSTIN, TX, 78704'));
    check('address: ordinals, units and road prefixes', t('12 W 1ST AVE APT 4B, TESTVILLE, CO, 80205-1234') === '12 W 1st Ave Apt 4B, Testville, CO 80205-1234' && t('9 FM 1626, TEST CITY, TX, 78748') === '9 FM 1626, Test City, TX 78748' && t("1 O'TEST LN-EAST, TESTTOWN, MD, 21201") === "1 O'Test Ln-East, Testtown, MD 21201", t('12 W 1ST AVE APT 4B, TESTVILLE, CO, 80205-1234'));
    check('address: the bare test string', t('TEST') === 'Test' && t('') === '');
    const g = (matched, cd, upper, lower) => ({ matchedAddress: matched, geographies: {
      States: [{ STATE: '48' }], 'Incorporated Places': [{ BASENAME: 'Austin' }], '119th Congressional Districts': [{ BASENAME: String(cd) }],
      '2024 State Legislative Districts - Upper': [{ BASENAME: String(upper) }], '2024 State Legislative Districts - Lower': [{ BASENAME: String(lower) }] } });
    const one = geo.parseCensus({ result: { addressMatches: [g('TEST ONE, AUSTIN, TX, 78704', 37, 14, 49)] } });
    check('address: one Census match is one result, with its districts and ZIP', one.length === 1 && one[0].state === 'TX' && one[0].place === 'Austin' && one[0].cd === 37 && one[0].upper === 14 && one[0].lower === 49 && one[0].zip === '78704', JSON.stringify(one));
    const two = geo.parseCensus({ result: { addressMatches: [g('TEST ONE, AUSTIN, TX, 78704', 37, 14, 49), g('TEST ONE, AUSTIN, TX, 78704', 37, 14, 49), g('TEST TWO, AUSTIN, TX, 78745', 35, 21, 50)] } });
    check('address: several matches are all kept, the same address once', two.length === 2 && two[1].matched === 'TEST TWO, AUSTIN, TX, 78745' && two[1].upper === 21, JSON.stringify(two.map((x) => x.matched)));
    // layers=all: the newest Congress and legislature maps win whatever order they come in, and school districts come along.
    const all = geo.parseCensus({ result: { addressMatches: [{ matchedAddress: 'TEST ONE, AUSTIN, TX, 78704', geographies: {
      States: [{ STATE: '48' }], '119th Congressional Districts': [{ BASENAME: '35' }], '120th Congressional Districts': [{ BASENAME: '37' }],
      '2024 State Legislative Districts - Upper': [{ BASENAME: '21' }], '2026 State Legislative Districts - Upper': [{ BASENAME: '14' }], '2026 State Legislative Districts - Lower': [{ BASENAME: '49' }],
      'Unified School Districts': [{ NAME: 'Round Rock Independent School District', BASENAME: 'Round Rock Independent School District' }] } }] } });
    check('address: with every layer, the 120th Congress and the 2026 legislature, and the school district', all[0].cd === 37 && all[0].upper === 14 && all[0].lower === 49 && all[0].schools.join() === 'Round Rock Independent School District', JSON.stringify(all[0]));
    check('address: no match, or a broken answer, is none', geo.parseCensus({ result: { addressMatches: [] } }).length === 0 && geo.parseCensus(null).length === 0 && geo.parseCensus({}).length === 0);

    // Austin: Congress and the state House are questions; the one state Senate race (SD-21) may apply.
    const au = open('TX', ['austin-tx']);
    const before = ledger.addressCount();
    const set = address.setFromAddress(au, S.b, { cd: 37, upper: 14, lower: 49 });
    check('address: Austin names the races it put on the ballot, Congress, then the House', set.join(' | ') === 'U.S. Representative, District 37 | State Representative, District 49', set.join(' | '));
    check('address: the line the ballot keeps is Kevin’s, word for word', address.addrSummary(set) === 'Set from your address: U.S. Representative, District 37 · State Representative, District 49.', address.addrSummary(set));
    check('address: Senate District 14 isn’t named, since no District 14 race is on this ballot (the SD-21 row says "Not on your ballot")', !/Senator/.test(set.join(' ')), set.join(' | '));
    const cdq = au.groups.find((x) => x.kind === 'cd');
    check('address: the Congress question gets its race', S.b.districts[cdq.key] === 'tx-us-house-37' || /37/.test(au.byId.get(S.b.districts[cdq.key])?.district || ''), S.b.districts[cdq.key]);
    check('address: Senate District 14 takes the SD-21 race off the ballot', S.b.notMine.includes('tx-senate-21') && !S.b.mine.includes('tx-senate-21') && !bl.isMaybe('tx-senate-21'));
    const after = ledger.addressCount();
    check('address: fewer races depend on your address after it', after < before, `${before} then ${after}`);
    // Not it: a second address in SD-21 puts the race back, on the ballot for sure now.
    const set2 = address.setFromAddress(au, S.b, { cd: 35, upper: 21, lower: 50 });
    check('address: a district with no race here ("none") isn’t named; the race it put on is', S.b.districts[cdq.key] === 'none' && !/Representative, District 35/.test(set2.join(' ')) && set2.includes('State Senator, District 21'), set2.join(' | '));
    check('address: a second lookup moves the race to "on your ballot", no longer a maybe', S.b.mine.includes('tx-senate-21') && !S.b.notMine.includes('tx-senate-21') && !bl.isMaybe('tx-senate-21'), JSON.stringify({ mine: S.b.mine, notMine: S.b.notMine }));
    check('address: so it no longer counts as depending on your address', ledger.addressCount() === after, `${ledger.addressCount()} vs ${after}`);
    const row = views.open.openHTML(au.byId.get('tx-senate-21'));
    const secH = ledger.sectionHTML('state', bl.entriesBySection().get('state'));
    const own = secH.slice(secH.indexOf('id="i-tx-senate-21"'), secH.indexOf('id="i-', secH.indexOf('id="i-tx-senate-21"') + 5) >>> 0);
    check('address: its row drops "Maybe on your ballot" and its open row "Only on some ballots"', own.length > 0 && !/Maybe on your ballot/.test(own) && !/Only on some ballots/.test(row), own.slice(0, 120));
    // The save link carries none of it beyond the districts and notMine it always had.
    const linked = st.encodeShare(au, S.b);
    const bare = { ...S.b, mine: [] };
    check('address: "mine" never goes in the save link', st.encodeShare(au, bare) === linked && st.decodeShare(au, head(linked)).state.mine.length === 0);
    const old = { zip: '78704', picks: {}, ranks: {}, auto: {}, noAuto: [], notes: {}, districts: {}, notMine: [], sources: null, planSeen: false, offerDismissed: null, addrNote: null, party: null, ticks: [], setupDone: true, hideDecided: false };
    check('address: an older save reads "mine" as empty', JSON.stringify({ ...st.emptyBallotState(), ...old }.mine) === '[]');
    // The sections you folded or opened are saved with the ballot on this device, never in the link.
    const folded = { ...S.b, secs: { folded: ['state'], unfolded: ['judicial'], reveal: ['measures'] } };
    check('sections: what you folded or opened never goes in the save link', st.encodeShare(au, folded) === linked && JSON.stringify(st.decodeShare(au, head(linked)).state.secs) === JSON.stringify(st.noSections()));
    check('sections: an older save reads them as none', JSON.stringify({ ...st.emptyBallotState(), ...old }.secs) === JSON.stringify(st.noSections()));
    // Statewide Florida: the appeals judges are the sample ballot's; nothing here turns on Congress.
    const fl = open('FL', []);
    const fset = address.setFromAddress(fl, S.b, { cd: 24, upper: 38, lower: null });
    check('address: statewide Florida sets nothing, and keeps "Found your address."', fset.length === 0 && address.addrSummary(fset) === 'Found your address.', fset.join(' | '));
    // DC: the "upper" layer is the ward, which the place already settles.
    const dc = open('DC', ['dc-ward-1']);
    check('address: DC sets nothing from its ward layer', address.setFromAddress(dc, S.b, { cd: null, upper: 1, lower: null }).length === 0);
    // Lakewood: three races by congressional district may apply; District 7 puts them on the ballot.
    const lk = open('CO', ['lakewood-co']);
    const lset = address.setFromAddress(lk, S.b, { cd: 7, upper: 22, lower: 24 });
    check('address: Lakewood names each office District 7 set', lset.filter((x) => /District 7$/.test(x)).length === 3 && ['co-us-house-7', 'co-sboe-7', 'co-cu-regent-7'].every((id) => S.b.mine.includes(id) && !bl.isMaybe(id)), lset.join(' | '));

    // The other ways the research writes Census districts (Oct 20): each is read, so an address settles
    // the House and legislature in Atlanta, Seattle, Chicago, Portland and New York too. Washington's
    // two representatives per district are both its lower-house district: one answer shows both.
    const kd = (office, district) => { const r = bl.contestDistrict({ office, district }); return `${r.kind}:${r.n}`; };
    const kinds = [kd('U.S. Representative', 'CD-37'), kd('U.S. House of Representatives', 'GA-5'), kd('U.S. Representative', 'NY-13'), kd('Georgia State Senate', 'Senate District 35'),
      kd('Georgia House of Representatives', 'House District 53'), kd('State Senator', 'LD-32'), kd('House of Delegates', 'HD-43A'),
      kd('State Representative', 'LD-32 Position 1'), kd('County Commissioner', 'TX-3'), kd('State Board of Education', 'District 5')];
    check('address: districts written other ways are read, and nothing else is', kinds.join() === 'cd:37,cd:5,cd:13,upper:35,lower:53,upper:32,lower:43,lower:32,null:null,null:null', kinds.join());
    open('GA', ['atlanta-ga']);
    const atl = address.setFromAddress(S.ballot, S.b, { cd: 5, upper: 35, lower: 53 });
    check('address: Atlanta settles Congress, the state senate and the state house', S.b.districts['federal|U.S. House of Representatives'] === 'ga-us-house-5' && S.b.districts['state|Georgia State Senate'] === 'ga-sd-35' && S.b.districts['state|Georgia House of Representatives'] === 'ga-hd-53' && atl.length === 3, atl.join(' | '));
    open('WA', ['seattle-wa']);
    const sea = address.setFromAddress(S.ballot, S.b, { cd: 7, upper: 32, lower: 32 });
    check('address: Seattle settles Congress, the state senator and the state house', S.b.districts['federal|U.S. Representative'] === 'wa-us-house-7' && S.b.districts['state|State Senator'] === 'wa-sd-32' && ['wa-hd-32-1', 'wa-hd-32-2'].includes(S.b.districts['state|State Representative']) && sea.join(' | ') === 'U.S. Representative, District 7 | State Senator, District 32 | State Representative, District 32', sea.join(' | '));
    const stateRows = (bl.entriesBySection().get('state') || []).filter((e) => e.t === 'item').map((e) => e.id);
    check('address: both of District 32’s representative seats are on the ballot, and no other district’s', stateRows.includes('wa-hd-32-1') && stateRows.includes('wa-hd-32-2') && !stateRows.some((id) => /^wa-hd-(?!32-)/.test(id)), stateRows.filter((id) => /^wa-hd/.test(id)).join());
    S.b.districts['state|State Representative'] = 'wa-hd-36-2';
    const by36 = (bl.entriesBySection().get('state') || []).filter((e) => e.t === 'item' && /^wa-hd/.test(e.id)).map((e) => e.id);
    check('districts: answering with either seat of a two-seat district shows both', by36.join() === 'wa-hd-36-1,wa-hd-36-2', by36.join());

    // School districts (Kevin, Oct 20): the Census names yours, so one district's races go on or off by it.
    const rr = open('TX', ['austin-tx']);
    const rset = address.setFromAddress(rr, S.b, { cd: 37, upper: 14, lower: 49, schools: ['Round Rock Independent School District'] });
    check('school districts: in Round Rock ISD, its four trustee seats go on the ballot and the line names it', ['tx-rrisd-trustee-3', 'tx-rrisd-trustee-4', 'tx-rrisd-trustee-5', 'tx-rrisd-trustee-6'].every((id) => S.b.mine.includes(id)) && /Round Rock ISD\.$/.test(address.addrSummary(rset)), address.addrSummary(rset));
    const oth = bl.otherSchools(bl.entriesBySection().get('school') || []).map((e) => e.id);
    check('school districts: Round Rock’s seats leave the "Other school districts" fold and stand as rows', !oth.some((id) => /rrisd/.test(id)) && (bl.entriesBySection().get('school') || []).some((e) => e.t === 'item' && e.id === 'tx-rrisd-trustee-3'), oth.join());
    check('school districts: Pflugerville, Leander and Del Valle’s races go off', ['tx-pfisd-trustee-6', 'tx-lisd-trustee-1', 'tx-dvisd-prop-a'].every((id) => S.b.notMine.includes(id)), JSON.stringify(S.b.notMine));
    check('school districts: the Austin ISD and Del Valle ISD trustee questions answer "none"', S.b.districts['school|Austin ISD Trustee'] === 'none' && S.b.districts['school|Del Valle ISD Trustee'] === 'none', JSON.stringify(S.b.districts));
    check('school districts: Austin ISD’s at-large seat, shown to all of Austin, comes off for a Round Rock ISD address', S.b.notMine.includes('tx-aisd-at-large-9') && (bl.entriesBySection().get('school') || []).some((e) => e.t === 'notmine' && e.id === 'tx-aisd-at-large-9'));
    const rrLink = st.decodeShare(rr, head(st.encodeShare(rr, S.b)));
    check('school districts: and a save link keeps it off', !!rrLink && rrLink.state.notMine.includes('tx-aisd-at-large-9') && rrLink.state.notMine.includes('tx-pfisd-trustee-6'), JSON.stringify(rrLink && rrLink.state.notMine));
    const ai = open('TX', ['austin-tx']);
    address.setFromAddress(ai, S.b, { cd: 37, upper: 14, lower: 49, schools: ['Austin Independent School District'] });
    check('school districts: in Austin ISD, its trustee question stays for the sample ballot; Del Valle’s answers "none"; the at-large seat stays', !S.b.districts['school|Austin ISD Trustee'] && S.b.districts['school|Del Valle ISD Trustee'] === 'none' && S.b.notMine.includes('tx-rrisd-trustee-3') && !S.b.notMine.includes('tx-aisd-at-large-9'), JSON.stringify(S.b.districts));
    // Review, Oct 20: a second lookup (the first was the wrong address) brings back a trustee question the first answered "none".
    const re = open('TX', ['austin-tx']);
    address.setFromAddress(re, S.b, { cd: 37, upper: 14, lower: 49, schools: ['Round Rock Independent School District'] });
    address.setFromAddress(re, S.b, { cd: 37, upper: 14, lower: 49, schools: ['Austin Independent School District'] });
    check('school districts: a second lookup in Austin ISD brings its trustee question back; Round Rock’s seats go off', !S.b.districts['school|Austin ISD Trustee'] && !(S.b.addrSet || []).includes('school|Austin ISD Trustee') && S.b.notMine.includes('tx-rrisd-trustee-3') && !S.b.notMine.includes('tx-aisd-at-large-9'), JSON.stringify(S.b.districts));
    S.b.districts['school|Del Valle ISD Trustee'] = 'tx-dvisd-trustee-3'; S.b.addrSet = (S.b.addrSet || []).filter((k) => k !== 'school|Del Valle ISD Trustee');
    address.setFromAddress(re, S.b, { cd: 37, upper: 14, lower: 49, schools: ['Austin Independent School District'] });
    check('school districts: an answer you gave yourself stands', S.b.districts['school|Del Valle ISD Trustee'] === 'tx-dvisd-trustee-3');
    // The menu lists only the sections the ballot draws.
    const hou = open('TX', ['houston-tx']);
    address.setFromAddress(hou, S.b, { cd: 18, upper: 13, lower: 147, schools: ['Houston Independent School District'] });
    const drawn = ledger.ballotHTML();
    const menu = ledger.tocSheetHTML ? ledger.tocSheetHTML() : '';
    check('menu: a section the ballot doesn’t draw isn’t in the menu', [...menu.matchAll(/data-to="([a-z_]+)"/g)].map((m) => m[1]).filter((k) => !['plan', 'how'].includes(k)).every((k) => drawn.includes(`id="sec-${k}"`)), [...menu.matchAll(/data-to="([a-z_]+)"/g)].map((m) => m[1]).join());
    const nos = open('TX', ['austin-tx']);
    address.setFromAddress(nos, S.b, { cd: 37, upper: 14, lower: 49 });
    check('school districts: a lookup with no school layer changes no school race', !S.b.mine.some((id) => /isd/.test(id)) && !S.b.notMine.some((id) => /isd/.test(id)) && !S.b.districts['school|Austin ISD Trustee']);
    check('school districts: only one school district’s whole races count as settled; trustee districts and college districts don’t', views.open.censusSettles(nos.byId.get('tx-rrisd-trustee-3')) && !views.open.censusSettles(nos.byId.get('tx-aisd-district-1')) && !views.open.censusSettles(nos.byId.get('tx-acc-trustee-1')));

    // The address box: before, after (this visit, with what was found), after a reload (no address).
    const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const box = () => strip((ledger.ballotHeadHTML().match(/<div class="addrbox[^"]*">[\s\S]*?<\/div>(?=\s*<\/div>)/) || [''])[0]);
    open('TX', ['austin-tx']);
    const view0 = S.view;
    S.view = 'ballot'; S.ui.addrOpen = false; S.ui.addrFound = null;
    const n0 = ledger.addressCount();
    check('address box: before a lookup, "{n} races depend on your address."', box().startsWith(`${n0} races depend on your address.`), box());
    S.b.addrNote = address.addrSummary(address.setFromAddress(S.ballot, S.b, { cd: 37, upper: 14, lower: 49 }));
    S.ui.addrFound = 'Test One, Austin, TX 78704';
    const n1 = ledger.addressCount();
    // (A lookup with no point for the maps, so the races they'd settle are left; the line doesn't blame the lookup for them.)
    check('address box: after one, what was found, what it set, and the rest counted', box() === `Found: Test One, Austin, TX 78704 Not it? Try again Set from your address: U.S. Representative, District 37 · State Representative, District 49. ${n1} races need your official sample ballot. Official sample ballot`, box());
    check('address box: the masthead no longer carries it', !/Set from|Your districts/.test(views.mast.mastHTML()));
    // A ballot with no district maps (San Antonio): what's left is named by kind, since the lookup doesn't cover it.
    open('TX', ['san-antonio-tx']);
    S.b.addrNote = address.addrSummary(address.setFromAddress(S.ballot, S.b, { cd: 20, upper: 26, lower: 123 }));
    check('address box: where no map covers them, the kinds of race the lookup doesn’t cover', /races need your official sample ballot\. The address lookup doesn’t cover races like [a-z ]+( or [a-z ]+)?\./.test(box()), box());
    open('TX', ['austin-tx']);
    S.b.addrNote = address.addrSummary(address.setFromAddress(S.ballot, S.b, { cd: 37, upper: 14, lower: 49 }));
    S.ui.addrFound = 'Test One, Austin, TX 78704';
    S.ui.addrFound = null;
    check('address box: after a reload, what it set without the address', !/Found:|Test One/.test(box()) && /^Set from your address: /.test(box()), box());
    open('FL', []);
    S.b.addrNote = address.addrSummary(address.setFromAddress(S.ballot, S.b, { cd: 24, upper: 38, lower: null }));
    check('address box: nothing set, what is left for the sample ballot', /^\d+ races? needs? your official sample ballot\.( The address lookup doesn’t cover races like [a-zA-Z .]+( or [a-zA-Z .]+)?\.)? Official sample ballot$/.test(box()), box());
    check('address: the kinds of race the lookup can’t settle, most common first, and never the ones it answers', address.addressKinds(['Austin City Council Member', 'Austin ISD Trustee', 'Round Rock ISD Trustee, Place 3', 'Travis County Commissioner', 'Mayor of Kyle', 'U.S. Representative', 'State Representative']).join('|') === 'school board|city council|county board|city office');
    // A source's name opens its page for the race, at the pick where the browser can (Kevin, Oct 20).
    {
      const ab = open('TX', ['austin-tx']);
      const chron = ab.eById.get('austin-chronicle-eb');
      const race = ab.byId.get('tx-us-house-10');
      const r = ab.ends['tx-us-house-10']['austin-chronicle-eb'];
      const u = views.open.pickURL(race, chron);
      check('sources: a pick links to its page, at the candidate’s full name, then last name', u === `${r.url}#:~:text=${encodeURIComponent(r.c[0])}&text=${encodeURIComponent(r.c[0].split(' ').pop())}`, u);
      const prop = ab.items.find((x) => x.kind === 'measure' && /^Proposition \S+$/.test(x.number) && Object.values(ab.ends[x.id] || {}).some((e) => e.s === 'endorsed'));
      const pe = Object.entries(ab.ends[prop.id]).find(([, e]) => e.s === 'endorsed');
      const pu = views.open.pickURL(prop, ab.eById.get(pe[0]));
      check('sources: a measure’s pick links at its number, written both ways', pu.endsWith(`:~:text=${encodeURIComponent(prop.number)}&text=${encodeURIComponent(prop.number.replace('Proposition', 'Prop'))}&text=${encodeURIComponent(prop.number.replace('Proposition', 'Prop.'))}`), pu);
      const np = Object.entries(ab.ends).flatMap(([id, by]) => Object.entries(by).filter(([, e]) => e.s === 'no_position' && e.url).map(([eid, e]) => [id, eid, e]))[0];
      check('sources: a source that took no stand links to the page we checked, as is', views.open.pickURL(ab.byId.get(np[0]), ab.eById.get(np[1])) === np[2].url);
      S.ui.row = race.id;
      check('sources: the grid’s source names are links that open a new tab', new RegExp(`<a class="sn" href="${r.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}#:~:text=`).test(ledger.rowHTML(race)) && /<a class="sn"[^>]*target="_blank" rel="noopener"/.test(ledger.rowHTML(race)));
      S.ui.row = null;
    }
    // A DC ward: nothing turns on the address, so after a lookup only what was found, and no "the rest".
    open('DC', ['dc-ward-1']);
    const hasBox = () => /class="addrbox"/.test(ledger.ballotHeadHTML());
    check('address box: a DC ward has no box before a lookup', ledger.addressCount() === 0 && !hasBox());
    S.b.addrNote = address.addrSummary(address.setFromAddress(S.ballot, S.b, { cd: 98, upper: 1, lower: null }));
    S.ui.addrFound = 'Test Four, Washington, DC 20001';
    check('address box: a DC ward after a lookup holds only what was found', box() === 'Found: Test Four, Washington, DC 20001 Not it? Try again', box());
    S.ui.addrOpen = true;
    check('address box: and Not it? Try again keeps the box, with the form', /<div class="addrbox">[\s\S]*data-form="addr"/.test(ledger.ballotHeadHTML()) && !/the rest/.test(ledger.ballotHeadHTML()));
    S.ui.addrOpen = false; S.ui.addrFound = null;
    check('address box: a DC ward after a reload has no box', !hasBox(), box());
    S.view = view0; S.ui.addrFound = null;
  }

  /* ---------- the shelf's two forms (Oct 21): what goes into Kevin's Google Form ----------
     The form's response sheet is the queue the city and fix pipeline reads, so the five ids and the
     city request's wording are a contract. The forms ask for a note and a way back; the rest is what
     the page sends along by itself, and the person sees it word for word before it goes. */
  {
    const { shelf, errors: errs } = views;
    const ids = ['entry.90887649', 'entry.628621310', 'entry.780704302', 'entry.1986493507', 'entry.2040687555'];
    const along = { page: 'Your ballot', where: 'Austin, 78704', url: 'https://vote.kevinhg.com/', data: '2026-10-21 19:04 UTC', build: 'abc1234', device: 'Safari 18 on iPhone, 390px wide', errors: [] };
    const base = { what: '', tag: '', hint: '', along, state: 'edit', err: false, fk: '', back: null };
    const rep = { ...base, kind: 'report', f: { wrong: ' A wrong date. ', reach: '' }, what: 'Governor', tag: 'tx-governor' };
    const body = shelf.reportBody(rep);
    // Codex, Oct 21: every value the page fills in, not only the "Sent along:" block, is on the list word for word.
    const filled = (b, lines) => ['entry.90887649', 'entry.628621310', 'entry.1986493507'].every((k) => !b[k] || lines.some((l) => l.endsWith(`: ${b[k]}`)));
    check('shelf: a report posts all five of the form’s ids, the empty ones too', ids.every((k) => k in body) && body['entry.2040687555'] === '' && body.fvv === '1' && body.pageHistory === '0' && Object.keys(body).length === 7, JSON.stringify(body));
    check('shelf: a row’s report names the race with its id, and the place and ZIP', body['entry.90887649'] === 'Governor [tx-governor]' && body['entry.628621310'] === 'Austin, 78704', JSON.stringify(body));
    check('shelf: "What’s wrong?" is your note, a blank line, then "Sent along:" and the list, word for word', body['entry.780704302'] === 'A wrong date.\n\nSent along:\nPage: Your ballot\nPlace: Austin, 78704\nAbout: Governor [tx-governor]\nPage address: https://vote.kevinhg.com/ (build abc1234)\nData built: 2026-10-21 19:04 UTC\nBrowser: Safari 18 on iPhone, 390px wide', body['entry.780704302']);
    check('shelf: the link question gets the page’s address and the build', body['entry.1986493507'] === 'https://vote.kevinhg.com/ (build abc1234)', body['entry.1986493507']);
    const foot = shelf.reportBody({ ...base, kind: 'report', f: { wrong: 'Hours look off.', reach: 'kev@example.org' }, along: { ...along, page: 'My plan' } });
    check('shelf: from the foot or the menu, the race question gets the page, and no "About" line', foot['entry.90887649'] === 'My plan' && !/About:/.test(foot['entry.780704302']) && foot['entry.2040687555'] === 'kev@example.org'
      && filled(foot, shelf.alongLines({ ...base, kind: 'report', along: { ...along, page: 'My plan' } })), JSON.stringify(foot));
    const err = shelf.reportBody({ ...rep, along: { ...along, errors: ['TypeError: x is undefined (index-Bx9.js:1:2345) at 19:05'] } });
    check('shelf: an error the page caught goes last in the list', /\nError the page caught: TypeError: x is undefined \(index-Bx9\.js:1:2345\) at 19:05$/.test(err['entry.780704302']), err['entry.780704302']);
    check('shelf: the list the sheet shows is the list that goes', shelf.alongLines(rep).join('\n') === body['entry.780704302'].split('Sent along:\n')[1]);
    check('shelf: the race with its record id, the place and the page’s address are each on the list as posted', filled(body, shelf.alongLines(rep)), shelf.alongLines(rep).join(' | '));
    const city = shelf.reportBody({ ...base, kind: 'city', f: { city: ' Round Rock ', zip: '78664', reach: 'kev@example.org' } });
    check('shelf: a city request goes in as the city form always has, then a shorter "Sent along:" (no browser)', ids.every((k) => k in city) && city['entry.90887649'] === 'Please add my city' && city['entry.628621310'] === '78664'
      && city['entry.780704302'] === 'Please add Round Rock\n\nSent along:\nPage: Your ballot\nPlace: Austin, 78704\nPage address: https://vote.kevinhg.com/ (build abc1234)\nData built: 2026-10-21 19:04 UTC' && city['entry.2040687555'] === 'kev@example.org'
      && city['entry.1986493507'] === 'https://vote.kevinhg.com/ (build abc1234)', JSON.stringify(city));
    const alt = new URL(shelf.reportFallbackURL({ ...base, kind: 'city', f: { city: 'Round Rock', zip: '78664', reach: '' } }));
    check('shelf: "Open the form in a new tab instead" is the form prefilled with the same answers', /\/viewform$/.test(alt.pathname) && alt.searchParams.get('usp') === 'pp_url' && /^Please add Round Rock\n\nSent along:/.test(alt.searchParams.get('entry.780704302')) && alt.searchParams.get('entry.628621310') === '78664' && !alt.searchParams.has('entry.2040687555'), alt.search);
    check('shelf: it posts to the same form the link opens', common.FORM.post.replace(/formResponse$/, 'viewform') === common.FORM.view);
    // The page's address: never its hash (the save link), only the test settings of its query.
    check('shelf: the page’s address drops the hash and any query but ?today, ?now and ?try', shelf.pageURL({ origin: 'https://vote.kevinhg.com', pathname: '/', search: '?today=2026-10-19&q=12+Main+St&try=aunt' }) === 'https://vote.kevinhg.com/?today=2026-10-19&try=aunt'
      && shelf.pageURL({ origin: 'https://vote.kevinhg.com', pathname: '/', search: '' }) === 'https://vote.kevinhg.com/');
    // The browser in a few words.
    const dw = (ua, w = 390, t = 0) => shelf.deviceWords(ua, w, t);
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
    check('shelf: the browser in a few words', dw(iphone) === 'Safari 18 on iPhone, 390px wide'
      && dw('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', 412) === 'Chrome 130 on Android, 412px wide'
      && dw('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 1024, 5) === 'Safari 18 on iPad, 1024px wide'
      && dw('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', 1280) === 'Edge 130 on Windows, 1280px wide'
      && dw('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/605.1.15') === 'Firefox 132 on iPhone, 390px wide'
      && dw(`${iphone.replace(' Safari/604.1', '')} Instagram 350.0.0.0`) === 'Instagram app on iPhone, 390px wide', dw(iphone));
    // errors.ts: the last three, newest first, URLs without query or hash, the Census lookup never.
    errs.note(new Error('first'), 'https://vote.kevinhg.com/assets/index-Bx9.js?v=1#x', 10, 4);
    errs.note('Failed: https://vote.kevinhg.com/data/state-TX.json?x=1#v1~TX~austin-tx', '', 0, 0);
    errs.note('Script error at https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?address=12+Main+St', '', 0, 0);
    errs.note(new TypeError('second'), 'https://vote.kevinhg.com/assets/index-Bx9.js', 20, 8);
    errs.note('third', '', 0, 0);
    const last = errs.lastErrors();
    check('errors: keeps the last three, newest first, never one that names the Census lookup', last.length === 3 && last[0].msg === 'third' && last[1].msg === 'TypeError: second' && last[1].at === 'index-Bx9.js:20:8' && last.every((e) => !/census|Main/i.test(e.msg)), JSON.stringify(last));
    check('errors: a URL in a message loses its query and hash (the save link lives in the hash)', last[2].msg === 'Failed: https://vote.kevinhg.com/data/state-TX.json' && /^\d{2}:\d{2}$/.test(last[2].time), JSON.stringify(last[2]));
    // Codex, Oct 21: a query can hold an apostrophe, a paren or a space, so the whole tail goes, in the message,
    // in a file the event names, and in a file read from a stack.
    const PRIV = /Test|Lane|rear|Main|PRIVATE|v1~|address=/;
    const newest = () => errs.lastErrors()[0];
    errs.note("Failed: https://example.test/?address=12%20O'Test%20Lane#v1~PRIVATE");
    check('errors: an apostrophe in a query doesn’t end the cut', newest().msg === 'Failed: https://example.test/', JSON.stringify(newest()));
    errs.note('Bad (https://example.test/a.js?address=12%20Main%20(rear)#v1~PRIVATE) and more');
    check('errors: nor does a paren', newest().msg === 'Bad (https://example.test/a.js' && !PRIV.test(newest().msg), JSON.stringify(newest()));
    errs.note('Load failed https://example.test/a.js?address=12 Main St#v1~PRIVATE');
    check('errors: nor a space', !PRIV.test(newest().msg), JSON.stringify(newest()));
    errs.note('x', "https://example.test/assets/i-B9.js?address=12%20O'Test%20Lane#v1~PRIVATE", 3, 4);
    check('errors: a file the event names is its file name only', newest().at === 'i-B9.js:3:4', JSON.stringify(newest()));
    const thrown = new Error('boom');
    thrown.stack = "Error: boom\n    at f (https://example.test/assets/i-B9.js?address=12%20O'Test%20Lane#v1~PRIVATE:7:9)\n    at g (https://example.test/?address=(rear):1:1)";
    errs.note(thrown);
    check('errors: a file read from a stack is its file name only', !PRIV.test(newest().at) && !PRIV.test(newest().msg) && newest().msg === 'Error: boom', JSON.stringify(newest()));
    // Codex, Oct 21, round 2: a scheme in capitals is still a URL.
    errs.note('Failed HTTPS://example.test/a?secret=PRIVATE#tail');
    check('errors: an uppercase scheme is still a URL', newest().msg === 'Failed HTTPS://example.test/a', JSON.stringify(newest()));
    const shouted = new Error('loud');
    shouted.stack = "Error: loud\n    at f (hTtPs://example.test/assets/i-B9.js?address=12%20Main#v1~PRIVATE:7:9)";
    errs.note(shouted);
    check('errors: and so is a mixed-case one in a stack', newest().at === 'i-B9.js:7:9' && !PRIV.test(newest().at), JSON.stringify(newest()));
    errs.note('Saved link v1~TX~austin-tx~78704~zz9 did not open');
    check('errors: a save link’s own words go wherever they stand', newest().msg === 'Saved link [save link] did not open', JSON.stringify(newest()));
    const census = new Error('script failed');
    census.stack = 'Error: script failed\n    at s.onerror (https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?address=12+Main:1:1)';
    errs.note(census);
    check('errors: one whose stack names the Census lookup is still dropped whole', newest().msg !== 'Error: script failed', JSON.stringify(newest()));
  }

  /* ---------- crash reports (scrub.ts, errors.ts): what may leave for Sentry ----------
     The site's How text says a crash report has no address, no picks and no IP. Every event passes
     scrubEvent on its way out, and every envelope envelopeAllowed (sentry.ts); these are their rules on
     deeply nested events, without a browser. The e2e checks the same in a real one, on the envelopes. */
  {
    const { scrub, errors: errs } = views;
    const O = 'https://vote.kevinhg.com';
    const HASH = 'v1~TX~austin-tx~78704~zz9pick';
    const SECRETS = ['12 testing lane'];
    const ctx = (over = {}) => {
      const words = over.words || SECRETS;
      return { origin: O, path: '/', hashes: [HASH, 'notes-PRIVHASH9'], holds: (ss, joined) => errs.holdsPrivate(ss, words, joined), bare: errs.bareURLs, readings: errs.readings, ua: 'TestAgent/1.0', ...over };
    };
    const frame = (filename, fn = 'f') => ({ filename, function: fn, lineno: 1, colno: 2, in_app: true });
    const ev = () => ({
      event_id: 'e0', level: 'error', platform: 'javascript', environment: 'production', release: 'abc1234', timestamp: 1,
      exception: { values: [
        { type: 'TypeError', value: `cause: ${O}/data/state-TX.json?zip=78704#${HASH}`, stacktrace: { frames: [frame(`${O}/assets/index-Bx9.js?v=2#frag`)] }, mechanism: { type: 'chained', parent_id: 0, data: { target: 'x' } } },
        { type: 'Error', value: 'Save failed for notes-PRIVHASH9', stacktrace: { frames: [frame(`${O}/assets/index-Bx9.js`, 'g'), frame('<anonymous>', '?')] }, mechanism: { type: 'generic', handled: true } },
      ] },
      contexts: { trace: { trace_id: 't1', span_id: 's1' }, app: { at: `${O}/?today=1#${HASH}` } },
      debug_meta: { images: [{ type: 'sourcemap', code_file: `${O}/assets/index-Bx9.js?v=2#${HASH}`, debug_id: 'd1' }] },
      extra: { nested: [{ deep: { at: `${O}/?today=2026-10-19#${HASH}`, note: "O'Test (rear) https://x.test/a.js?b=1#c" } }] },
      tags: { mood: 'fine' }, modules: { x: '1' }, message: 'm',
      user: { ip_address: '{{auto}}', id: 'u1' },
      breadcrumbs: [{ category: 'ui.click', message: 'button[data-act=pick]' }],
      request: { url: `${O}/?today=1#${HASH}`, headers: { Referer: 'https://elsewhere.test/?q=x' } },
      sdk: { name: 'sentry.javascript.browser', version: '11.8.0', integrations: ['GlobalHandlers'], settings: { infer_ip: 'never' }, extra: 'gone' },
      sdkProcessingMetadata: { scope: 'not for sending' },
    });
    const input = ev();
    const before = JSON.stringify(input);
    const out = scrub.scrubEvent(input, ctx());
    const js = JSON.stringify(out);
    check('crash reports: a nested event passes, and the one handed in is left as it was', !!out && out !== input && JSON.stringify(input) === before, js);
    check('crash reports: no save link anywhere, hash or words, and no "#"', !!out && !/zz9pick|PRIVHASH9|v1~|#/.test(js) && out.exception.values[1].value === 'Save failed for [save link]', js);
    check('crash reports: every URL loses its query and hash, in messages, frames and source map ids', !!out && !/today=|zip=|v=2|frag|\?[^"]/.test(js)
      && out.exception.values[0].value === `cause: ${O}/data/state-TX.json` && out.exception.values[0].stacktrace.frames[0].filename === `${O}/assets/index-Bx9.js`
      && out.debug_meta.images[0].code_file === `${O}/assets/index-Bx9.js` && out.debug_meta.images[0].debug_id === 'd1', js);
    check('crash reports: only known fields go: no user, breadcrumbs, extra, tags, modules, message, SDK bookkeeping, mechanism data, or contexts but the trace', !!out
      && ['user', 'breadcrumbs', 'extra', 'tags', 'modules', 'message', 'sdkProcessingMetadata'].every((k) => !(k in out))
      && JSON.stringify(out.contexts) === '{"trace":{"trace_id":"t1","span_id":"s1"}}' && !('data' in out.exception.values[0].mechanism) && !('extra' in out.sdk) && !/elsewhere|Referer|O'Test/.test(js), js);
    check('crash reports: the request is the origin and path with the browser; the rest goes as it came (release, mechanism, the never-infer-IP setting)', !!out
      && JSON.stringify(out.request) === JSON.stringify({ url: `${O}/`, headers: { 'User-Agent': 'TestAgent/1.0' } })
      && out.release === 'abc1234' && out.sdk.settings.infer_ip === 'never' && out.exception.values[1].mechanism.type === 'generic' && out.exception.values[0].mechanism.parent_id === 0, js);
    // A thrown value that isn't an Error: the SDK's words for it stay, what it held never goes (Codex, Oct 25:
    // a rejected {picks, notes} went out whole in extra.__serialized__).
    const obj = { exception: { values: [{ type: 'UnhandledRejection', value: 'Object captured as promise rejection with keys: notes, picks', mechanism: { type: 'auto.browser.global_handlers.onunhandledrejection', handled: false, synthetic: true } }] },
      extra: { __serialized__: { picks: { 'tx-governor': 'Jane Q Candidate' }, notes: { 'tx-governor': 'my own words' } } }, sdk: {} };
    const objOut = scrub.scrubEvent(obj, ctx());
    const str = scrub.scrubEvent({ exception: { values: [{ type: 'UnhandledRejection', value: 'Non-Error promise rejection captured with value: Jane Q Candidate' }] } }, ctx());
    const bare = scrub.scrubEvent({ exception: { values: [{ type: 'Error', value: 'Jane Q Candidate', mechanism: { type: 'generic', synthetic: true } }] } }, ctx());
    check('crash reports: a thrown object or string never sends what it held, only that one was thrown', !!objOut && !/Jane|my own words|__serialized__|picks\W*:/.test(JSON.stringify(objOut))
      && objOut.exception.values[0].value === 'Object captured as promise rejection with keys: [not sent]' && str.exception.values[0].value === 'Non-Error promise rejection captured with value: [not sent]'
      && bare.exception.values[0].value === 'A thrown value that isn’t an Error: [not sent]', `${JSON.stringify(objOut)} | ${JSON.stringify(str)}`);
    // Dropped whole.
    const census = ev(); census.extra.nested[0].deep.script = 'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?address=1+A+St';
    const cap = ev(); cap.exception.values[1].value = 'x at GEOCODING.GEO.CENSUS.GOV';
    check('crash reports: anything that mentions the Census lookup, however deep (even in a part that wouldn’t go) and in any case, never leaves', scrub.scrubEvent(census, ctx()) === null && scrub.scrubEvent(cap, ctx()) === null);
    const addr = (v, words) => { const e = ev(); e.exception.values[1].value = v; return scrub.scrubEvent(e, ctx(words ? { words } : {})); };
    check('crash reports: anything that mentions the address never leaves: as typed, in capitals, spaced out, URL-encoded either way', addr('Lookup failed for 12 Testing Lane') === null && addr('LOOKUP 12 TESTING  LANE') === null && addr('q=12%20Testing%20Lane') === null && addr('q=12+Testing+Lane') === null);
    check('crash reports: nor with tabs or line breaks between its words, repeated encoded spaces, or encoded twice (Codex, Oct 25)', addr('a 12\tTesting\tLane b') === null && addr('12\nTesting\r\nLane') === null && addr('q=12%20%20Testing%09Lane') === null && addr('q=12%2520Testing%2520Lane') === null
      && (() => { const e = ev(); e.extra.q = '12\tTesting Lane'; return scrub.scrubEvent(e, ctx()); })() === null, 'one got through');
    check('crash reports: nor with a quote in it, as JSON writes it', (() => { const e = ev(); e.extra.q = 'see "12 O"Test Lane"'; return scrub.scrubEvent(e, ctx({ words: ['12 o"test lane'] })); })() === null && addr('12 O\\"Test Lane', ['12 o"test lane']) === null);
    const elsewhere = (filename) => { const e = ev(); e.exception.values[1].stacktrace.frames.push(frame(filename)); return scrub.scrubEvent(e, ctx()); };
    check('crash reports: thrown by a script that isn’t ours (an extension, a look-alike host) never leaves', elsewhere('chrome-extension://abcdef/inject.js') === null && elsewhere(`${O}.evil.test/x.js`) === null && elsewhere('https://cdn.example.test/ads.js') === null);
    check('crash reports: frames that name no script don’t count; the newest one that does decides', elsewhere('[native code]') !== null && (() => { const e = ev(); e.exception.values[1].stacktrace.frames = [frame('https://cdn.example.test/lib.js'), frame(`${O}/assets/index-Bx9.js`), frame('<anonymous>')]; return scrub.scrubEvent(e, ctx()); })() !== null);
    const empty = ev(); empty.exception.values = [{ type: 'Error', value: 'Script error.' }];
    check('crash reports: a browser’s empty "Script error." says nothing, so it isn’t sent; nor is an event with no error in it', scrub.scrubEvent(empty, ctx()) === null && scrub.scrubEvent({ message: 'hello' }, ctx()) === null);
    check('crash reports: a short hash is left alone (it can’t be a save link, and replacing it would mangle words)', (() => { const o = scrub.scrubEvent({ exception: { values: [{ type: 'Error', value: 'plan view' }] } }, ctx({ hashes: ['plan'] })); return !!o && o.exception.values[0].value === 'plan view'; })());
    // The last check, on the bytes: an envelope's lines of JSON.
    const env = (item) => [JSON.stringify({ event_id: 'e1', sent_at: 'now', sdk: { name: 'sentry.javascript.browser' } }), JSON.stringify({ type: 'event' }), JSON.stringify(item)].join('\n');
    check('crash reports: the envelope check lets a clean report by', scrub.envelopeAllowed(env(out), ctx()));
    // Accented letters, encoded (security review, Oct 25): a stray "%" in the same text made the decoder give up on
    // the whole of it, so "Pe%C3%B1a+St" was never read as "peña st". Now each line and each string is read on its
    // own, %XX runs are read as UTF-8, and escapes that won't decode count as private: when in doubt, send nothing.
    const PENA = ['12 peña st'];
    const mp = (t, w = PENA) => errs.holdsPrivate([t], w);
    check('crash reports: an accented address, encoded, is found even beside a stray "%" or a bad escape in the same text', mp('q=12+Pe%C3%B1a+St and 100% sure') && mp('q=12%20Pe%C3%B1a%20St, then %E0%A4') && mp('12 Pe%C3%B1a St') && mp('q=12%2520Pe%25C3%25B1a%2520St'));
    check('crash reports: escapes the browser wouldn’t decode (a Latin-1 "%F1") count as private when there is an address to protect', mp('q=12+Pe%F1a+St') && !errs.holdsPrivate(['q=12+Pe%F1a+St'], []));
    check('crash reports: ordinary text with a "%" or with good escapes isn’t taken for the address', !mp('progress 100% done') && !mp('q=caf%C3%A9+au+lait') && !mp('12 Peña Road') && !mp('{"m":"50%25 off"}'));
    const split = ev(); split.exception.values[0].value = 'progress 100% done'; split.exception.values[1].value = 'lookup q=12+Pe%C3%B1a+St failed';
    check('crash reports: one string’s stray "%" can’t hide the address in another string of the same report', scrub.scrubEvent(split, ctx({ words: PENA })) === null
      && !scrub.envelopeAllowed(env({ a: 'progress 100% done', b: 'q=12+Pe%C3%B1a+St' }), ctx({ words: PENA })));
    // Codex round 2, Oct 25: escapes inside encodings; an address split between two fields (security review);
    // fixed words for a thrown non-Error; a save link with its "~" encoded; a lone surrogate.
    check('crash reports: an escape inside an encoding unwinds too ("%5Ct", "%5Cu0020")', mp('12%5CtTesting%5CtLane', SECRETS) && mp('12%5Cu0020Testing%5Cu0020Lane', SECRETS) && mp('12\\u0020Testing\\u0020Lane', SECRETS) && mp('12%255Ct%2520Testing Lane', SECRETS));
    const halves = ev(); halves.exception.values[1].value = "lookup failed for 12 O'Test"; halves.exception.values[1].stacktrace.frames[0].filename = 'Lane';
    check('crash reports: an address split between two fields still counts', scrub.scrubEvent(halves, ctx({ words: ["12 o'test lane"] })) === null
      && !scrub.envelopeAllowed(env({ a: "for 12 O'Test", b: 'Lane is wrong' }), ctx({ words: ["12 o'test lane"] })));
    const wrapped = (value, type = 'Error') => scrub.scrubEvent({ exception: { values: [{ type, value, mechanism: { type: 'auto.browser.global_handlers.onunhandledrejection', handled: false, synthetic: true } }] } }, ctx());
    check('crash reports: a thrown non-Error gets fixed words, never a prefix the page wrote', wrapped('Private choice Jane Q Purposeful with value: secret tail').exception.values[0].value === 'A thrown value that isn’t an Error: [not sent]'
      && wrapped('Object captured as exception with keys: picks').exception.values[0].value === 'Object captured as exception with keys: [not sent]'
      && wrapped('Event `ErrorEvent` captured as promise rejection with message `Jane`').exception.values[0].value === 'An event object captured as promise rejection: [not sent]'
      && wrapped('Non-Error promise rejection captured with value: Jane', 'UnhandledRejection').exception.values[0].value === 'Non-Error promise rejection captured with value: [not sent]');
    const tilde = (v) => { const e = ev(); e.exception.values[1].value = v; return scrub.scrubEvent(e, ctx()); };
    check('crash reports: a save link with its "~" encoded, once or twice, or JSON-escaped, never leaves', tilde(`see ${HASH.replace(/~/g, '%7E')}`) === null && tilde(`see ${HASH.replace(/~/g, '%257E')}`) === null && tilde('x v1%7EDC%7Edc-ward-1') === null && tilde('x v1\\u007EDC') === null
      && !scrub.envelopeAllowed(env({ v: HASH.replace(/~/g, '%7E') }), ctx()));
    let threw = false; let lone = null;
    try { lone = [errs.holdsPrivate(['nothing here'], ['12 test \ud800 lane']), errs.holdsPrivate(['at 12 Test \ud800 Lane'], ['12 test \ud800 lane'])]; } catch { threw = true; }
    check('crash reports: a lone surrogate in the address doesn’t break the check', !threw && lone[0] === false && lone[1] === true, JSON.stringify(lone));
    // Round four (security review, Oct 25): one rule, failing closed. Box text is private at five characters, number or
    // not, as a substring, with its street line; keys are judged as well as values; a common word in the box drops reports.
    const hp = (t, w) => errs.holdsPrivate([t], w);
    check('crash reports: a street typed without its number is private, written any way', hp('lookup Shoal Creek Blvd broke', ['shoal creek blvd']) && hp('q=Shoal+Creek+Blvd&x=1', ['shoal creek blvd']) && hp('a\tSHOAL\nCreek Blvd', ['shoal creek blvd']));
    check('crash reports: box text counts as a substring, so a half-typed street is found inside the whole one', hp('On purpose: Shoal Creek Blvd is long', ['shoal creek bl']) && hp('x12 testing lanes', SECRETS));
    check('crash reports: keys are judged as well as values: a key holding the address drops the report', (() => { const e = ev(); e.extra['12 Testing Lane'] = 1; return scrub.scrubEvent(e, ctx()); })() === null && !scrub.envelopeAllowed(env({ '12 Testing Lane': 'x' }), ctx()));
    check('crash reports: a common word left in the box ("trace") drops even an ordinary report, by design: a dropped report is fine, a sent address is not', scrub.scrubEvent(ev(), ctx({ words: ['trace'] })) === null);
    errs.keepPrivate('500 Shoal Creek Blvd, Austin TX', 'Shoal Ridge Way, Austin');
    check('crash reports: a box’s street line is kept too, with or without a number', errs.privateWords().includes('500 shoal creek blvd') && errs.privateWords().includes('shoal ridge way'), errs.privateWords().join(' | '));
    // The shape layer: no digits, nothing quoted but a plain name from the code, a type that is a name.
    const said = (value, type = 'TypeError') => { const o = scrub.scrubEvent({ exception: { values: [{ type, value, stacktrace: { frames: [frame(`${O}/assets/index-Bx9.js`, 'Object.f [as g]'), frame(`${O}/assets/index-Bx9.js`, 'evil(); code')] } }] } }, ctx()); return o && o.exception.values[0]; };
    const shaped = ["Cannot read properties of undefined (reading 'dataset')", 'Unexpected token \'x\', "{"picks":{"a":"Jane"}}" is not valid JSON', "Failed: '#i-tx-gov' is not a valid selector.", 'lookup 12 Elm, 78704 failed', "undefined is not an object (evaluating 'a.b.c')", 'Can’t find variable: foo', `cause: ${O}/data/state-TX.json`, 'Save failed for [save link]'].map((v) => said(v).value);
    check('crash reports: a message keeps plain words, names from the code and cut URLs; a number, a JSON snippet or a quoted selector becomes "…"', JSON.stringify(shaped) === JSON.stringify(["Cannot read properties of undefined (reading 'dataset')", "Unexpected token 'x', … is not valid JSON", 'Failed: … is not a valid selector.', 'lookup … Elm, … failed', "undefined is not an object (evaluating 'a.b.c')", 'Can’t find variable: foo', `cause: ${O}/data/state-TX.json`, 'Save failed for [save link]']), JSON.stringify(shaped));
    check('crash reports: a type that isn’t a name becomes "Error", and a frame’s function that isn’t a name becomes "?"', said('x', 'Jane Q Doe').type === 'Error' && said('x').stacktrace.frames[0].function === 'Object.f [as g]' && said('x').stacktrace.frames[1].function === '?');
    const plain = ev(); plain.exception.values[0].value = 'progress 100% done';
    check('crash reports: and a report whose only "%" is ordinary text still goes', scrub.scrubEvent(plain, ctx({ words: PENA })) !== null);

    check('crash reports: and holds back one with the address (even JSON-escaped with a tab), the Census lookup, a save link’s hash or words', !scrub.envelopeAllowed(env({ value: '12\tTesting Lane' }), ctx())
      && !scrub.envelopeAllowed(env({ u: 'https://geocoding.geo.census.gov/x' }), ctx()) && !scrub.envelopeAllowed(env({ v: 'notes-PRIVHASH9' }), ctx()) && !scrub.envelopeAllowed(env({ v: 'x v1~DC~a' }), ctx())
      && !scrub.envelopeAllowed('not json at all: 12 testing lane', ctx()));
    // errors.ts: what counts as private, and the problem report's list follows the same rule.
    errs.keepPrivate('12 Quartz Way, Springfield, IL 62701', 'Springfield, IL', null, '  ', '12\tQuartz\nWay');
    const words = errs.privateWords();
    check('crash reports: an address and its street line are kept to compare against, number or not (a bare city keeps its name: a dropped report is fine)', words.includes('12 quartz way, springfield, il 62701') && words.includes('12 quartz way') && words.includes('springfield, il') && words.includes('springfield'), words.join(' | '));
    check('crash reports: the rule finds them however they’re written', [['Failed: 12 QUARTZ   WAY'], ['?a=12%20Quartz%20Way'], ['?a=12+quartz+way'], ['{"m":"12\\tQuartz\\nWay"}'], ['12%2520Quartz%2520Way']].every((x) => errs.holdsPrivate(x)) && !errs.holdsPrivate(['Quartz is a mineral']));
    const was = JSON.stringify(errs.lastErrors()[0]);
    errs.note(new Error('Lookup failed for 12 Quartz Way'));
    check('crash reports: the problem report’s list drops an error that mentions the address too', JSON.stringify(errs.lastErrors()[0]) === was, JSON.stringify(errs.lastErrors()[0]));
  }

  /* ---------- coverage (Oct 25): how many sources a ballot has, a thin place, one tap ----------
     build-data counts them (scripts/coverage.mjs) over the ballot the app builds; the app says them
     (model/coverage.ts, views/coverage.ts). */
  {
    const cov = await import('../scripts/coverage.mjs');
    const mc = mods.coverage;
    const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // A fixture: a state with a statewide race, a measure and a district race; a place with two races of its own.
    const E = (id, extra = {}) => ({ id, name: id, short: id, type: 'publication', lean: null, default_on: true, endorses_candidates: true, endorses_measures: true, ...extra });
    const row = (s, date, c = null) => ({ s, c, note: null, why: null, url: null, date, conf: 'verified' });
    const C = (id, n, extra = {}) => ({ kind: 'contest', id, every: false, is_retention: false, candidates: Array.from({ length: n }, (_, i) => ({ name: `${id}-${i}` })), ...extra });
    const sb = {
      order: ['gov', 'm1', 'hd-1'],
      items: [C('gov', 2, { every: true }), { kind: 'measure', id: 'm1' }, C('hd-1', 2)],
      endorsers: [E('paper'), E('guide'), E('quiet')],
      endorsements: { gov: { paper: row('endorsed', '2026-10-12'), quiet: row('no_position', '2026-10-14') }, m1: { guide: row('not_found', '2026-10-10') } },
    };
    const pb = {
      order: ['hd-1', 'mayor', 'council'], local: ['mayor', 'council'],
      items: [C('mayor', 3), C('council', 1)],
      endorsers: [E('city-paper', { home_places: ['town'] }), E('city-guide', { home_places: ['town'] }), E('far-paper', { home_places: ['elsewhere'] })],
      endorsements: { mayor: { 'city-paper': row('not_found', '2026-10-20'), 'far-paper': row('endorsed', '2026-10-18') }, 'hd-1': { 'city-guide': row('no_position', '2026-10-16') } },
    };
    const sw = cov.coverageOf(sb, []);
    check('coverage fixture: a statewide ballot counts its sources, the ones with picks, the statewide ones and the newest date',
      sw.sources === 3 && sw.with_picks === 1 && sw.local_sources === 3 && sw.local_with_picks === 1 && sw.checked === '2026-10-14', JSON.stringify(sw));
    const pl = cov.coverageOf(sb, [pb], 'town');
    // On the place's ballot: gov and m1 (every voter), hd-1 and mayor and council (the place lists them).
    check('coverage fixture: a place counts every source on its ballot, statewide ones too',
      pl.sources === 6 && pl.with_picks === 2 && pl.checked === '2026-10-20', JSON.stringify(pl));
    check('coverage fixture: its local sources are the ones whose home is the place, and none has a pick',
      pl.local_sources === 2 && pl.local_with_picks === 0, JSON.stringify(pl));
    check('coverage fixture: its own races leave out an unopposed one; the mayor has a pick from a paper elsewhere',
      pl.local_races === 1 && pl.local_races_with_picks === 1, JSON.stringify(pl));
    check('coverage fixture: so it isn’t thin (every race of its own has a pick from someone)', !cov.isThin(pl) && !mc.isThin(pl));
    const thinPl = { ...pl, local_races: 2 };
    check('coverage fixture: thin once one of its races has no pick from anyone, and not once a local source picks', cov.isThin(thinPl) && mc.isThin(thinPl) && !cov.isThin({ ...thinPl, local_with_picks: 1 }) && !mc.isThin({ ...thinPl, local_with_picks: 1 }));
    check('coverage fixture: a statewide race outside every-voter isn’t on a place’s ballot unless the place lists it', cov.ballotIds(sb, [{ ...pb, order: ['mayor'] }]).join() === 'gov,m1,mayor');

    // The index's numbers are the app's own ballot's, for every place and every state.
    const off = [];
    for (const [id, p] of Object.entries(INDEX.places)) {
      const b = open(p.state, [id]);
      const n = b.endorsers.length, w = lens.withPicks(b, b.endorsers).length;
      if (p.sources !== n || p.with_picks !== w) off.push(`${id}: index ${p.sources}/${p.with_picks}, ballot ${n}/${w}`);
      if (cov.isThin(p) !== mc.isThin(p)) off.push(`${id}: the two thin rules disagree`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p.checked || '')) off.push(`${id}: checked is ${p.checked}`);
    }
    for (const [stc, s2] of Object.entries(INDEX.states)) {
      const b = open(stc, []);
      if (s2.sources !== b.endorsers.length || s2.with_picks !== lens.withPicks(b, b.endorsers).length) off.push(`${stc}: index ${s2.sources}/${s2.with_picks}, ballot ${b.endorsers.length}/${lens.withPicks(b, b.endorsers).length}`);
    }
    check('coverage: index.json’s source counts match the ballot the app builds, every place and state', off.length === 0, off.slice(0, 4).join(' | '));
    check('coverage: a place with a local source that picks is never thin', Object.values(INDEX.places).every((p) => p.local_with_picks === 0 || !mc.isThin(p)));
    check('coverage: Chicago isn’t thin', !mc.isThin(INDEX.places['chicago-il']), JSON.stringify(INDEX.places['chicago-il']));
    // Codex, Oct 26: the Pensacola News Journal is Pensacola's own paper, so it counts as one of its local
    // sources (5, none with picks); Ballwin's three are the Post-Dispatch (one pick), LWV Metro STL and STLPR.
    const pn = INDEX.places['pensacola-fl'], bw = INDEX.places['ballwin-mo'];
    check('coverage: Pensacola’s own paper is a local source; Ballwin has three, one with picks', pn.local_sources === 5 && pn.local_with_picks === 0 && bw.local_sources === 3 && bw.local_with_picks === 1, `${JSON.stringify(pn)} ${JSON.stringify(bw)}`);

    // What the app says, from a copy of the index with numbers set.
    const idx = JSON.parse(JSON.stringify(INDEX));
    const thinNums = { local_sources: 4, local_with_picks: 0, local_races: 10, local_races_with_picks: 7, checked: '2026-10-19' };
    idx.places['pensacola-fl'] = { ...idx.places['pensacola-fl'], ...thinNums };
    const pen = open('FL', ['pensacola-fl']);
    const c1 = mc.ballotCoverage(pen, idx, '32501', '2026-10-25');
    check('coverage: a thin place offers to gather its endorsements, in one tap',
      c1.kind === 'thin' && c1.state === 'none' && c1.name === 'Pensacola' && c1.ask.key === 'p:pensacola-fl' && c1.ask.what === 'Gather endorsements: Pensacola' && c1.ask.wrong === 'Please gather local endorsements for Pensacola (one-tap from the page)', JSON.stringify(c1));
    idx.places['pensacola-fl'].local_with_picks = 1;
    check('coverage: the same place with a local source’s pick reads full, with no offer', mc.ballotCoverage(pen, idx, '32501').kind === 'full' && mc.ballotCoverage(pen, idx, '32501').ask === null);
    idx.places['pensacola-fl'].local_with_picks = 0;
    const mo = open('MO', []);
    const c2 = mc.ballotCoverage(mo, idx, '63110', '2026-10-25');
    check('coverage: a statewide ballot found by its ZIP offers to add the city, the way Request a city asks',
      c2.kind === 'statewide' && c2.state === 'none' && c2.ask.key === 'z:63110' && c2.ask.what === 'Please add my city' && c2.ask.wrong === 'Please add the city for ZIP 63110 in Missouri (one-tap from the page)' && c2.checked === INDEX.states.MO.checked, JSON.stringify(c2));
    check('coverage: one picked from the list (no ZIP) can’t ask in one tap', mc.ballotCoverage(mo, idx, '').ask === null);
    idx.zips['63110'] = ['ballwin-mo'];
    check('coverage: once its ZIP has a place, it says the city is in', mc.ballotCoverage(mo, idx, '63110').state === 'landed');
    delete idx.zips['63110'];

    // Remembered on this device, apart from the saved ballots, until the data lands or three days pass.
    const mem = {};
    globalThis.window = { localStorage: { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } } };
    try {
      mc.rememberAsk('p:pensacola-fl', '2026-10-25');
      check('coverage: a request is kept under its own key, never vg2', Object.keys(mem).join() === 'vg-asked' && JSON.parse(mem['vg-asked'])['p:pensacola-fl'] === '2026-10-25');
      check('coverage: asked, the thin place says so the same day and the next', mc.ballotCoverage(pen, idx, '32501', '2026-10-25').state === 'asked' && mc.ballotCoverage(pen, idx, '32501', '2026-10-26').state === 'asked');
      idx.places['pensacola-fl'].checked = '2026-10-26';
      check('coverage: data checked after the request day ends it', mc.ballotCoverage(pen, idx, '32501', '2026-10-26').state === 'none');
      idx.places['pensacola-fl'].checked = '2026-10-25';
      check('coverage: data checked the same day doesn’t (the request may have come after it)', mc.ballotCoverage(pen, idx, '32501', '2026-10-25').state === 'asked');
      // Codex, Oct 26: three days means three (an Oct 25 request counts on the 25th, 26th and 27th), not four.
      check('coverage: after three days with nothing landed, the offer comes back', mc.ballotCoverage(pen, idx, '32501', '2026-10-27').state === 'asked' && mc.ballotCoverage(pen, idx, '32501', '2026-10-28').state === 'none');
      mc.rememberAsk('z:63110', '2026-10-28');
      check('coverage: a new request lets go of ones past the window, from the third day on', !('p:pensacola-fl' in JSON.parse(mem['vg-asked'])) && JSON.parse(mem['vg-asked'])['z:63110'] === '2026-10-28');
      // Codex, Oct 26: a record that isn't a plain object (an array left by something else) reads as empty,
      // so the request is kept and acknowledged instead of vanishing when it's written back.
      mem['vg-asked'] = '[]';
      mc.rememberAsk('p:pensacola-fl', '2026-10-25');
      check('coverage: a vg-asked that is a list is read as empty, and the request sticks', mc.askedOn('p:pensacola-fl', '2026-10-25') === '2026-10-25' && !Array.isArray(JSON.parse(mem['vg-asked'])), mem['vg-asked']);
      mem['vg-asked'] = '"oops"';
      check('coverage: and so is one that is text', mc.askedOn('p:pensacola-fl', '2026-10-25') === null);
    } finally { delete globalThis.window; idx.places['pensacola-fl'].checked = '2026-10-19'; }

    // The words (Oct 25 copy pass, coverage-copy-pass.md): one gold card in the place slot that owns the
    // action; quiet lines with no button in the head, step 2 and the Edit sheet. Today is pinned through
    // ?today (todayISO reads location), and requests live in a stand-in localStorage.
    const keep = { index: S.index, view: S.view, uiView: S.ui.view, pending: S.pending, resume: S.ui.resume };
    // Text with block ends spaced and inline tags (PR 2's count link) dropped, as a reader sees it.
    const txt = (h) => h.replace(/<\/(p|div|li|h\d)>|<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const store = {};
    globalThis.window = { localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } } };
    const setToday = (d) => { globalThis.location = { search: `?today=${d}`, origin: 'https://vote.kevinhg.com', pathname: '/' }; };
    setToday('2026-10-25');
    try {
      S.index = idx;
      S.ui.view = 'ballot'; S.pending = null; S.ui.resume = false;
      const darkOf = (h) => [...h.matchAll(/class="mini dark"[^>]*>([^<]+)</g)].map((m) => m[1]);
      const day = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
      // A covered place: no card, scoped counts.
      open('IL', ['chicago-il']);
      const p = INDEX.places['chicago-il'];
      S.view = 'setup';
      check('coverage: a covered place gets no card', views.coverage.covCardHTML('door') === '' && views.coverage.covCardHTML('ballot') === '');
      check('coverage: step 2 says how many sources on the place’s ballot, how many picked, and when', txt(views.coverage.covHTML()) === `${p.sources} sources on Chicago’s ballot, ${p.with_picks} with picks. Last checked ${day(p.checked)}. Add a source` && /class="su-src"/.test(views.setup.pickControlsHTML()), txt(views.coverage.covHTML()));
      check('coverage: step 2’s first line says whose picks', /<p class="su-cov">Your sources have picks in \d+ of your \d+ races\.<\/p>/.test(views.setup.pickControlsHTML()));
      check('coverage: the Edit sheet says the same', /class="su-src"/.test(views.setup.pickControlsHTML(true)) && /Your sources have picks in/.test(views.setup.pickControlsHTML(true)));
      S.view = 'ballot';
      check('coverage: the ballot’s head says it for the ballot, under the picks line, no button', txt(views.coverage.headCovHTML()) === `${p.sources} sources on your ballot, ${p.with_picks} with picks. Last checked ${day(p.checked)}.` && /picks-line[\s\S]*class="picks-cov"/.test(views.ledger.ballotHeadHTML()) && !/class="mini/.test(views.coverage.headCovHTML()));
      S.b.sources = [];
      check('coverage: with endorsements off, the counts step aside', !/su-src|picks-cov/.test(views.setup.pickControlsHTML(true) + views.ledger.ballotHeadHTML()));
      S.b.sources = null;

      // A thin place: the card says what's missing and what's here, and owns the one dark button.
      open('FL', ['pensacola-fl']);
      S.b.zip = '32501';
      S.view = 'setup';
      const tc = views.coverage.covCardHTML('door');
      check('coverage: a thin place’s card leads with what’s missing, then what’s here and what isn’t, with the gap counted', txt(tc) === 'Pensacola’s local picks aren’t in yet. Here now: every race on your ballot, with picks from newspapers and groups across Florida. Not here yet: picks from Pensacola’s own paper and groups. 3 of your 10 local races have no picks from anyone. Ask Kevin to look for local picks One tap. It sends Kevin the place and nothing about you. He’ll look within about a day.', txt(tc));
      check('coverage: its button is the dark one, and it is a gold card', darkOf(tc).join() === 'Ask Kevin to look for local picks' && /class="notice strong cov-card"/.test(tc) && /data-act="cov-ask"/.test(tc));
      check('coverage: step 2 says it quietly, with no button', txt(views.coverage.covHTML()) === '21 sources, 13 with picks, none from Pensacola’s own paper and groups. Last checked Oct 19.' && !/class="mini/.test(views.coverage.covHTML()));
      S.view = 'ballot';
      const th = views.ledger.ballotHeadHTML();
      check('coverage: the head’s line is quiet, and while the card asks the address box has no dark button', txt(views.coverage.headCovHTML()) === '21 sources, 13 with picks, none from Pensacola’s own paper and groups. Last checked Oct 19.' && darkOf(th).length === 0 && /Use my address/.test(th), darkOf(th).join());
      check('coverage: on the ballot the card sits in the slot under the masthead', /class="notice strong cov-card wrap"/.test(views.mast.restoreHTML()));
      S.pending = { kind: 'shared', key: 'x', incoming: S.b, summary: 'This link brought 2 picks.' };
      check('coverage: under a shared link’s question its button is an outline, so the slot has one dark button', darkOf(views.mast.restoreHTML()).join() === 'Use the link’s picks' && /class="mini" data-act="cov-ask"/.test(views.mast.restoreHTML()), darkOf(views.mast.restoreHTML()).join());
      S.pending = null;
      S.b.sources = [];
      check('coverage: a thin place’s card goes while endorsements are off', views.coverage.covCardHTML('ballot') === '');
      S.b.sources = null;
      idx.places['pensacola-fl'].local_races_with_picks = 9;
      check('coverage: one race without picks reads "1 of your 10 ... has"', /1 of your 10 local races has no picks from anyone\./.test(views.coverage.covCardHTML('door')));
      idx.places['pensacola-fl'].local_races_with_picks = 7;
      // Asked: the card keeps its slot and gold, a tick and "Request sent.", the day, an outline follow-up.
      mc.rememberAsk('p:pensacola-fl', '2026-10-25');
      const ta = views.coverage.covCardHTML('ballot');
      check('coverage: asked, a thin place’s card says so plainly, may find none, and offers Tell me what he finds', txt(ta) === 'Request sent. Kevin is looking for Pensacola’s local picks. You asked today. It usually takes about a day. He may not find any, since some groups don’t endorse. Your ballot works now. Any local picks he finds will show up here. Tell me what he finds' && /role="status"/.test(ta) && /class="cov-tick"/.test(ta) && darkOf(ta).length === 0 && /class="notice strong cov-card wrap"/.test(ta), txt(ta));
      check('coverage: asked, the quiet lines add the day', txt(views.coverage.headCovHTML()).endsWith('You asked for local picks today.') && darkOf(views.ledger.ballotHeadHTML()).join() === 'Use my address');
      setToday('2026-10-26');
      check('coverage: the next day it reads the date', /You asked Oct 25\. It usually takes about a day\./.test(txt(views.coverage.covCardHTML('ballot'))) && txt(views.coverage.headCovHTML()).endsWith('You asked for local picks Oct 25.'));
      setToday('2026-10-25');
      delete store['vg-asked'];

      // A statewide ballot found by ZIP (St. Louis City).
      open('MO', []);
      S.b.zip = '63110';
      S.view = 'setup';
      const sc = views.coverage.covCardHTML('door');
      check('coverage: a statewide ballot’s card leads with the missing races, says the statewide picks are here, and asks Kevin', txt(sc).startsWith(`Your city’s races aren’t in the guide yet. Here now: Missouri’s statewide races, with picks from ${INDEX.states.MO.with_picks} of ${INDEX.states.MO.sources} sources. Not here yet: races for your city, county and districts. Ask Kevin to add my city One tap. It sends Kevin your ZIP and nothing about you. It usually takes about a day. Voting before then? Your official sample ballot lists every race.`) && darkOf(sc).join() === 'Ask Kevin to add my city', txt(sc));
      check('coverage: its sample ballot is a link in a sentence, never a button', /Voting before then\? Your <a href="https:[^"]+"[^>]*>official sample ballot<\/a> lists every race\./.test(sc) && !/class="mini[^"]*"[^>]*>Official sample ballot/.test(sc) && /statewide-note/.test(sc));
      check('coverage: step 2 says it quietly', txt(views.coverage.covHTML()) === `${INDEX.states.MO.sources} sources for Missouri’s statewide races, ${INDEX.states.MO.with_picks} with picks. Last checked ${day(INDEX.states.MO.checked)}.` && /Your sources have picks in \d+ of the \d+ statewide races here\./.test(views.setup.pickControlsHTML()));
      S.view = 'ballot';
      const sh = views.ledger.ballotHeadHTML();
      check('coverage: the head says "Statewide races only", the address box keeps its own job, and no sample ballot is dark', txt(views.coverage.headCovHTML()).startsWith('Statewide races only: ') && !/cov-ask|Ask Kevin|We only have/.test(sh) && darkOf(sh).length === 0 && (sh.match(/>Official sample ballot</g) || []).length <= 1, txt(sh));
      S.b.sources = [];
      check('coverage: with endorsements off the statewide card stays, without the picks', /Here now: Missouri’s statewide races\./.test(txt(views.coverage.covCardHTML('ballot'))));
      S.b.sources = null;
      setToday('2026-11-02');
      check('coverage: two days out, the fine print says it may not land before Election Day', /One tap\. It sends Kevin your ZIP and nothing about you\. Kevin may not get to it before Election Day\./.test(txt(views.coverage.covCardHTML('ballot'))));
      setToday('2026-10-25');
      mc.rememberAsk('z:63110', '2026-10-25');
      const sa = views.coverage.covCardHTML('ballot');
      check('coverage: asked, the statewide card says Request sent, check back tomorrow, and offers Tell me when it’s in', txt(sa) === 'Request sent. Kevin is adding your city. You asked today. It usually takes about a day, so check back tomorrow. Until then, you can pick your statewide races below. Voting before then? Your official sample ballot lists every race. Tell me when it’s in' && darkOf(sa).length === 0, txt(sa));
      check('coverage: and the quiet lines add the day', txt(views.coverage.headCovHTML()).endsWith('You asked for your city’s races today.'));
      setToday('2026-11-02');
      mc.rememberAsk('z:63110', '2026-11-01');
      check('coverage: asked two days out, it says it may not be in before you vote', /You asked Nov 1\. It may not be in before you vote\./.test(txt(views.coverage.covCardHTML('ballot'))), txt(views.coverage.covCardHTML('ballot')));
      setToday('2026-10-25');
      mc.rememberAsk('z:63110', '2026-10-25');

      // "Tell me when it's in": a follow-up, never a second "Please add my city".
      const F2 = common.FORM;
      const fa = { page: 'Your ballot', where: 'Missouri, 63110', url: 'https://vote.kevinhg.com/', data: '2026-10-25 12:00 UTC', build: 'abc1234', device: 'x', errors: [] };
      S.ui.report = { kind: 'city', f: { reach: '' }, what: '', tag: '', hint: 'follow', along: fa, state: 'edit', err: false, fk: 'cov-hear', back: null };
      const fh = views.shelf.shelfHTML();
      check('follow-up: titled Tell me when it’s in, the request shown as text, an email or phone the one field, required', /<h2 id="sh-h">Tell me when it’s in<\/h2>/.test(fh) && /<b>Your request:<\/b> your city’s races, for ZIP 63110 in Missouri\. Sent today\./.test(fh) && (fh.match(/data-rf="/g) || []).length === 1 && /id="rf-reach"[^>]*aria-required="true"/.test(fh) && !/Which city or town/.test(fh) && views.shelf.requiredOf(S.ui.report) === 'reach', txt(fh).slice(0, 300));
      check('follow-up: its button says what it does, and what goes along is folded under it', />Tell me when it’s in<\/button>/.test(fh) && /<details class="rp-along"/.test(fh) && fh.indexOf('<details') > fh.indexOf('report-send') && !/Add anything else in your note/.test(fh));
      S.ui.report.f.reach = 'friend@example.org';
      const fb = views.shelf.reportBody(S.ui.report);
      check('follow-up: it posts a follow-up with the place, ZIP and request day, never "Please add my city"', fb[F2.what] === 'Follow-up: tell me when it’s in' && fb[F2.where] === 'Missouri, 63110' && fb[F2.reach] === 'friend@example.org'
        && fb[F2.wrong].startsWith('Tell me when the city for ZIP 63110 is in. Follow-up to the one-tap request from Oct 25.\n\nSent along:\n') && !/Please add/.test(Object.values(fb).join('\n')), JSON.stringify(fb));
      S.ui.report.state = 'sent';
      check('follow-up: sent, "Got it." and never the email or phone back', /<b>Got it\.<\/b> Kevin will tell you when it’s in\./.test(views.shelf.shelfHTML()) && !/friend@example\.org/.test(views.shelf.shelfHTML()));
      S.ui.report = null;
      open('FL', ['pensacola-fl']);
      S.b.zip = '32501';
      mc.rememberAsk('p:pensacola-fl', '2026-10-25');
      S.ui.report = { kind: 'city', f: { reach: '' }, what: '', tag: '', hint: 'follow', along: { ...fa, where: 'Pensacola, 32501' }, state: 'edit', err: false, fk: 'cov-hear', back: null };
      const ph = views.shelf.shelfHTML();
      check('follow-up: for a thin place, Tell me what he finds, even if it’s nothing', /<h2 id="sh-h">Tell me what he finds<\/h2>/.test(ph) && /what he finds for Pensacola, even if it’s nothing\./.test(ph) && /<b>Your request:<\/b> local picks for Pensacola, ZIP 32501\. Sent today\./.test(ph) && views.shelf.reportBody(S.ui.report)[F2.what] === 'Follow-up: tell me what you find' && views.shelf.reportBody(S.ui.report)[F2.wrong].startsWith('Tell me what you find for Pensacola. Follow-up to the one-tap request from Oct 25.'), txt(ph).slice(0, 300));
      S.ui.report = null;
    } finally {
      delete globalThis.window; delete globalThis.location;
      S.index = keep.index; S.view = keep.view; S.ui.view = keep.uiView; S.pending = keep.pending; S.ui.resume = keep.resume;
    }

    // One tap sends the form's five answers, its own words, nothing typed.
    const along = { page: 'First page', where: 'Pensacola, 32501', url: 'https://vote.kevinhg.com/', data: '2026-10-25 12:00 UTC', build: 'abc1234', device: 'Safari 18 on iPhone, 390px wide', errors: ['Error: boom'] };
    const body = views.shelf.askBody(c1.ask, along);
    const F = common.FORM;
    check('coverage: one tap posts the five ids, the place and ZIP, and nothing typed', [F.what, F.where, F.wrong, F.link, F.reach].every((k) => k in body) && body[F.what] === 'Gather endorsements: Pensacola' && body[F.where] === 'Pensacola, 32501' && body[F.reach] === '' && body[F.link] === 'https://vote.kevinhg.com/ (build abc1234)', JSON.stringify(body));
    check('coverage: "What’s wrong?" is its own sentence and a city request’s "Sent along" (no browser, no errors)', body[F.wrong] === 'Please gather local endorsements for Pensacola (one-tap from the page)\n\nSent along:\nPage: First page\nPlace: Pensacola, 32501\nPage address: https://vote.kevinhg.com/ (build abc1234)\nData built: 2026-10-25 12:00 UTC', body[F.wrong]);
  }

  /* ---------- every source in reach (Oct 25): the count opens the sheet, "Couldn't read", "Add a source" ---------- */
  {
    const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const keep = { index: S.index, view: S.view };
    S.index = INDEX;
    const ch = open('IL', ['chicago-il']);
    S.view = 'setup';
    // The count is a button that opens the sheet right there, and "Add a source" sits beside it.
    const door = views.coverage.covHTML();
    check('sources: on the first page the count opens "Every source on your ballot", with Add a source beside it', /<button class="linkbtn cov-n" data-act="sheet" data-s="sources"[^>]*data-fk="cov-src">\d+ sources<\/button>/.test(door) && /data-act="shelf" data-kind="source"[^>]*>Add a source</.test(door), door);
    check('sources: the Edit sheet has the same count and the same Add a source', /data-act="sheet" data-s="sources"[^>]*data-fk="cov-src"/.test(views.setup.pickControlsHTML(true)) && /data-kind="source"[^>]*>Add a source</.test(views.setup.pickControlsHTML(true)));
    S.view = 'ballot';
    check('sources: the ballot’s head count opens it too', /data-act="sheet" data-s="sources"[^>]*data-fk="hd-src"/.test(views.coverage.headCovHTML()));
    // The sheet: the legend, the lean groups with switches, "Couldn't read" with none.
    const sh = views.lens.sourcesSheetHTML();
    check('sources: the sheet opens with what’s on to start', /On by default: newspapers and nonpartisan guides\. Tap a switch to add or drop one\./.test(strip(sh)) && /data-act="src-default"/.test(sh) && /data-act="src-none"/.test(sh));
    const unread = ch.endorsers.filter((e) => lens.cantRead(e) && !lens.picksOnBallot(ch, e.id));
    const box = (sh.match(/<section class="sgrp unread">[\s\S]*?<\/section>/) || [''])[0];
    check('sources: "Couldn’t read (N)" lists every paywalled or bot-checked source with no pick here', unread.length >= 2 && new RegExp(`<h3>Couldn’t read \\(${unread.length}\\)</h3>`).test(box) && unread.every((e) => box.includes(`data-unread="${e.id}"`)) && ['crains-chicago-eb', 'sierra-club-il'].every((id) => box.includes(`data-unread="${id}"`)), unread.map((e) => e.id).join());
    check('sources: with no switch, each with its reason and Send it to us', !/data-act="src"/.test(box) && /bot check to anything that isn’t a browser/.test(box) && (box.match(/>Send it to us</g) || []).length === unread.length);
    check('sources: a bot-checked source’s Send it to us opens the form without asking for a login', /data-unread="sierra-club-il"[\s\S]*?data-hint="blocked"/.test(box) && /data-unread="crains-chicago-eb"[\s\S]*?data-hint="paywall"/.test(box));
    const trib = ch.endorsers.find((e) => e.id === 'chicago-tribune-eb');
    check('sources: a paywalled paper with picks here stays in its lean group with a switch', !!trib && lens.picksOnBallot(ch, trib.id) > 0 && !box.includes('chicago-tribune-eb') && /data-act="src" data-id="chicago-tribune-eb"/.test(sh));
    check('sources: none of the couldn’t-read ones has a switch anywhere in the sheet', unread.every((e) => !sh.includes(`data-act="src" data-id="${e.id}"`)));
    check('sources: Add a source ends the sheet', /class="s-add"[\s\S]*data-act="shelf" data-kind="source"[^>]*data-fk="src-add"[^>]*>Add a source</.test(sh) && sh.lastIndexOf('Add a source') > sh.lastIndexOf('Couldn’t read'));
    // A paywalled paper that endorses nothing (the Pensacola News Journal) isn't "couldn't read": it stays
    // in its group as an explainer.
    const pen2 = open('FL', ['pensacola-fl']);
    const pnj = pen2.eById.get('pensacola-news-journal-eb');
    const psh = views.lens.sourcesSheetHTML();
    check('sources: a paywalled paper that doesn’t endorse stays in its group as an explainer, not under Couldn’t read', !!pnj && pnj.paywall === true && lens.explainsOnly(pnj) && !(psh.match(/<section class="sgrp unread">[\s\S]*?<\/section>/) || [''])[0].includes('pensacola-news-journal-eb') && /data-act="src" data-id="pensacola-news-journal-eb"/.test(psh));
    // A bot-checked source with picks from an earlier read keeps them, and says why it can't be checked again.
    const mo = open('MO', []);
    const smo = mo.eById.get('sierra-club-mo');
    check('sources: a bot-checked source with picks stays switchable, its note under its name', !!smo && smo.blocked === true && lens.picksOnBallot(mo, smo.id) > 0 && /data-act="src" data-id="sierra-club-mo"/.test(views.lens.sourcesSheetHTML()) && /earlier read/.test(common.blockedSourceHTML(smo)));
    Object.assign(S, keep);

    // The row verdict: a bot-checked source with nothing here reads "Couldn't read", never "Not checked yet".
    const il = open('IL', ['chicago-il']);
    const sil = il.eById.get('sierra-club-il');
    S.b.sources = ['sierra-club-il'];
    // Sierra Club Illinois has a "not found" row on every race it covers here; take one away for a race it
    // covers with no record.
    const it = il.items.find((x) => (il.ends[x.id] || {})['sierra-club-il']?.s === 'not_found' && !(x.kind === 'contest' && x.is_retention) && bl.status(x) === 'open');
    const saved = it ? il.ends[it.id]['sierra-club-il'] : null;
    if (it) delete il.ends[it.id]['sierra-club-il'];
    tally.clearLineups();
    check('sources: a covered race with no record from a bot-checked source lists it as blocked', !!it && !!sil && tally.lineup(it).blocked.some((e) => e.id === 'sierra-club-il') && !tally.lineup(it).notChecked.length);
    if (it) {
      const v = tally.verdict(it);
      check('sources: its verdict is "Couldn’t read"', v.kind === 'none' && v.main === 'Couldn’t read' && v.why === 'blocked' && tally.NONE_WORDS.blocked === 'Couldn’t read', JSON.stringify(v));
      check('sources: and the open row says why, once, with Send it to us', /shows a bot check to anything that isn’t a browser, so we couldn’t read its endorsements here/.test(strip(views.open.openHTML(it))) && (views.open.openHTML(it).match(/data-hint="blocked"/g) || []).length === 1);
      il.ends[it.id]['sierra-club-il'] = saved;
      // A record marked unreadable reads the same way; one that was read stays "No endorsements found".
      const nf = it;
      const r = il.ends[nf.id]['sierra-club-il'];
      tally.clearLineups();
      check('sources: a bot-checked source’s read "not found" stays "No endorsements found"', tally.lineup(nf).notFound.some((e) => e.id === 'sierra-club-il'));
      r.unreadable = true;
      tally.clearLineups();
      check('sources: one marked unreadable reads "Couldn’t read"', tally.lineup(nf).blocked.some((e) => e.id === 'sierra-club-il') && !tally.lineup(nf).notFound.length);
      delete r.unreadable;
      check('sources: a mixed row counts it', tally.noneCounts({ noStand: [], notFound: [], notChecked: [], both: [], paywalled: [], blocked: [sil] }) === '1 couldn’t be read');
    }
    S.b.sources = null;
    tally.clearLineups();

    // Add a source: a name or link, where you vote, the pasted picks; the same five answers.
    const F = common.FORM;
    const along = { page: 'First page', where: 'Chicago, 60601', url: 'https://vote.kevinhg.com/', data: '2026-10-25 12:00 UTC', build: 'abc1234', device: 'Safari 18 on iPhone, 390px wide', errors: ['Error: boom'] };
    const sr = (f) => ({ kind: 'source', f: { src: '', where: 'Chicago, 60601', picks: '', reach: '', ...f }, what: '', tag: '', hint: '', along, state: 'edit', err: false, fk: 'src-add', back: null });
    const b1 = views.shelf.reportBody(sr({ src: 'https://example.org/guide', picks: 'Mayor: A. Person\nProp 1: Yes' }));
    check('add a source: a link goes in as the race and the link, the pasted picks in "What’s wrong?"', b1[F.what] === 'Add source: https://example.org/guide' && b1[F.link] === 'https://example.org/guide' && b1[F.where] === 'Chicago, 60601'
      && b1[F.wrong] === 'Mayor: A. Person\nProp 1: Yes\n\nSent along:\nPage: First page\nPlace: Chicago, 60601\nPage address: https://vote.kevinhg.com/ (build abc1234)\nData built: 2026-10-25 12:00 UTC' && b1[F.reach] === '', JSON.stringify(b1));
    const b2 = views.shelf.reportBody(sr({ src: 'Chicago Reader', reach: 'me@example.org' }));
    check('add a source: a name with nothing pasted asks plainly, and the page’s link goes along', b2[F.what] === 'Add source: Chicago Reader' && b2[F.wrong].startsWith('Please add this source\n\nSent along:\n') && b2[F.link] === 'https://vote.kevinhg.com/ (build abc1234)' && b2[F.reach] === 'me@example.org', JSON.stringify(b2));
    check('add a source: its one required box is the source', views.shelf.requiredOf(sr({})) === 'src' && views.shelf.isForm('source'));
    S.ui.report = sr({});
    S.ui.open.delete(views.shelf.PICKS_FOLD);
    const form = views.shelf.shelfHTML();
    // Kevin, Oct 28: the paste box folds under one row, "Paste in their picks", optional.
    check('add a source: the sheet asks which source and where you vote (filled in), the paste box folded under "Paste in their picks"', /Add a source/.test(form) && /Tell Kevin which source to add\./.test(form) && /id="rf-src"/.test(form) && /id="rf-where"[^>]*value="Chicago, 60601"/.test(form)
      && /data-k="rf-picks-fold"[^>]*aria-expanded="false"[^>]*><b>Paste in their picks<\/b> <span class="rp-opt">optional<\/span>/.test(form) && !/id="rf-picks"/.test(form) && !/Behind a login/.test(form));
    S.ui.open.add(views.shelf.PICKS_FOLD);
    const opened = views.shelf.shelfHTML();
    check('add a source: opened, the row shows the paste box with its hint, labelled by the row', /aria-expanded="true" aria-controls="rf-picks"/.test(opened) && /<textarea id="rf-picks" aria-labelledby="rf-picks-b"/.test(opened) && /Behind a login\? Copy their endorsement list and paste it here\./.test(opened));
    S.ui.open.delete(views.shelf.PICKS_FOLD);
    S.ui.report.state = 'sent';
    check('add a source: sent, it says a source usually shows up within a day', /Sent\.<\/b> Kevin reads every one; a source usually shows up within a day\./.test(views.shelf.shelfHTML()));
    S.ui.report = null;
  }

}
