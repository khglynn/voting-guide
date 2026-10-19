# Voting Guide: progress

Resume file. Keep current. Agent notes: `AGENTS.md`.

## v3, the ledger (Mon Oct 19, 2026)
- Kevin picked prototype A ("the ledger") from the Oct 18 design round. Spec and research:
  the workbench's `claude-plans/2026-10-19-ledger-v1/` (BUILD-SPEC.md, research/).
- The model layer stayed (`ballot.ts`, `state.ts`, save links byte for byte); the views were
  replaced: masthead, dusk plan strip (next step plus its date, every voting model), "Who do
  you trust?" chips over the saved source list, one row per item with a verdict column,
  open rows (grid of your sources, ranked choice, mark up to N, judges, measures, district
  questions), a Full read sheet, a cheat sheet that ends with Pass it on as its own step.
- New: "Use their picks where they agree", "Fill in the {party} candidates" and the judges'
  review batch, each undone as one batch; judge reviews from structured `evaluations`;
  `heads_up`, `judicial_review`, `seat_label`, `district_finders` from data; "not on my
  ballot" in the save link; DC wards from an address; numbered seats that share a scope are
  no longer a district question; unique cheat-sheet titles on every ballot.
- Removed with v2's views: the Filter shelf, party filter, "only endorsed" and auto-pick
  (replaced by the lens and the fills).
- Gates: `tests/model.mjs` (81), `tests/e2e.mjs` (128), the sweep 68/68 fast and full,
  `tests/perf.mjs` (taps under 250ms at 4x throttle on Chicago and Houston).

## v2 history

## Done
- Vite + vanilla TS app in this folder, local git history (branch `main`).
- `scripts/build-data.mjs`: validates, merges and bundles `data/` into `public/data/`.
  All 32 places and 14 states validate (0 skipped records) as of the last copy.
- One-page flow: ZIP, place question, plan card, sources line (picker + grid in the Filter shelf), ballot
  sections, district questions, Census address lookup, filters + auto-pick offer,
  notes, cheat sheet with print, copy and save link, "How this guide works".
- `tests/e2e.mjs`: 89 checks at 380px (Denver, Austin, Atlanta, uncovered state, Portland and DC ranked choice, old v1 link). All pass.
  Screenshots in `shots/`.
- Smoke pass over every place: no console errors, no sideways scroll at 380px.

## v2.1 (Sat Oct 17): skimmable copy, sources in the Filter shelf, no all caps
- Plan card: next step is the title, one short tip, and the button. Below it, "The basics"
  as label/value rows (Early voting, Election Day, By mail, Bring, In the booth, Your
  office, Your ballot), each with its full rules one tap away. Key dates, "Things people
  get wrong" (bold lead sentence per bullet) and "More about voting in {place}" (state
  overview and place notes as bullets) sit behind disclosures.
- Mail row reads the state file's own words: mail-to-all model, else "Anyone can ask" when
  who_gets_one says no excuse or any registered voter, else "Only if you qualify" (TX
  adds the qualifier list from model_plain).
- Shared helpers in `src/views/common.ts`: `sentences`, `leadRest`, `clampP` (lead plus an
  inline More), `bulletsHTML` (colon-plus-semicolon lists become sub-bullets),
  `leadBulletsHTML`, `telHTML`, `deshout`, `choiceWord`. All display-only: no data edits.
- Cards: measure summaries, confusing-wording notes, why-it-matters, endorsement reasons and
  retention-judge backgrounds show a lead plus More.
- Sources: the page keeps one line ("Endorsements from N sources · Change"). It opens the
  Filter shelf scrolled to the sources section with focus on its heading. The endorsed-only
  toggle, Reset/Turn off, defaults and lean groups live there. "See their picks side by
  side" swaps the shelf to the full-height grid; Back returns. Shelf footer holds Done.
- No all caps: no text-transform uppercase anywhere (screen or print). Kickers, badges,
  party labels and disclosures are sentence case. Stressed caps words in research prose
  (NOT, RECEIVED, NOON, YES, FOR...) show in lower case via `deshout`; acronyms and anything
  in quotation marks (ballot language like 'SHALL ... TAXES BE INCREASED') stay verbatim.
  Measure boxes read "A **yes** vote means". The official ballot wording block is verbatim.
- Taps cancel their follow-up mouse events (touchend preventDefault right after a fired tap)
  so focus stays where the action put it.
- e2e now 41 checks. Screenshots: `shots/v2.1-before-*` and `shots/v2.1-after-*`.
- Coordinator note: fact-checkers are editing `../data/measures/*.json`; they re-copy data
  and push after. This pass made no data edits.

## Ranked choice (Sat Oct 17)
- Data: 12 contests flagged from official sample ballots (`../research/rcv.md`): DC Mayor,
  Delegate, At-large (rank 5, 2 winners, one vote per ballot), Ward 1 and 5 Council, Ward 6
  State Board; Boulder Mayor (6); Multnomah Chair (4, the research said 6), Commissioner D2 (6);
  Portland Auditor (2, shows as unopposed), Council D3 and D4 (6, 3 winners). Fields:
  `ranked_choice`, `rank_up_to`, `winners`, `rcv_url`, `rcv_how` (SCHEMA Contest).
- Card: a calm box under the explainer ("Ranked choice: rank up to 6. Three people win.", one
  counting sentence, official link). Tap Rank to give the next rank; tap a ranked candidate to
  take them out and the rest renumber. "Your ranking" panel lists ranks with Move up and Remove
  (44px, keyboard friendly; focus follows the row). The card stays open while ranking, even
  when every rank is used; "Done ranking" folds it to "1. Name, 2. Name".
- Status: decided when every rank this guide can fill is used, or after Done ranking. The
  guide fills up to min(rank_up_to, candidates); the extra ballot column is a write-in line.
- Cheat sheet and print list ranks in order (1st, 2nd...) with "Ranked choice: rank up to N".
- Save link: `#v2~...` adds a ranks field (hash5(id) + hash3 per name, in order), written only
  when a ranking exists, so other ballots still get byte-identical v1 links. v1 links restore:
  a pick-one choice on a now-ranked race becomes the 1st choice; old "mark up to N" seat marks
  on DC at-large can't become an order without guessing, so they drop (reported) and it reopens.
- Auto-pick never touches ranked races. Non-ranked multi-seat races keep "mark up to N".
- e2e: 89 checks (Portland D3 ranking, renumbering, keyboard move up, note, link round trip,
  filters; DC Ward 1; a real v1 link captured from the live site before this change).
  Screenshots `shots/rcv-*.png`.

## (Resolved) GitHub repo and Vercel deploy
Repo `khglynn/voting-guide` exists; pushes to `main` deploy to https://voting-guide-silk.vercel.app.
Notes below kept for history.
- **GitHub:** this session can't create repos. The GitHub MCP returns 403 and `gh api
  user/repos` is refused by session policy ("sessions are bound to their configured
  repositories"). `khglynn/voting-guide` does not exist yet.
- **Vercel:** no CLI or token here; the MCP can only deploy from a linked Git repo or
  from file contents passed inline (about 550KB gzipped, 735KB base64). Not done.
- **To finish (about 5 minutes once the repo exists):**
  1. Kevin creates an empty private repo `khglynn/voting-guide` on github.com.
  2. In a session: `add_repo(owner: khglynn, repo: voting-guide, access: push)`, then
     `git remote add origin https://github.com/khglynn/voting-guide.git && git push -u origin main`.
  3. Vercel MCP `create_project` (team `kevinhg`, name `voting-guide`, framework null,
     buildCommand `npm run build`, outputDirectory `dist`, gitRepository
     `{type: github, repo: khglynn/voting-guide}`), then `create_deployment` with
     `gitSource {type: github, org: khglynn, repo: voting-guide, ref: main}`, target production.
  4. Re-copy `../data`, rebuild, run `BASE=https://<url> node tests/e2e.mjs`, and open the
     URL in a fresh logged-out browser context.

## Next
- Data last re-copied Fri Oct 16 late evening: 14 states, 32 places, 887 contests, 164 measures, 0 skipped.
- Re-copy `../data/` right before deploy (`rm -rf data && cp -r ../data data && npm run build`).
- Perf at 4x CPU throttle on the biggest ballots (Chicago, Houston): open ~1s, pick ~250ms, filter applies on sheet close (~700ms).
- Kevin decisions: Report-a-problem destination (`REPORT_URL`), domain, Deployment Protection.

## Decisions made
- Default sources follow SCHEMA: `type` publication or civic_nonpartisan = on, everything
  else opt-in. The files' own `default_on` flags disagreed in places (Austin Chronicle).
- Endorser merges: Springs and Denver Gazette folded into one board; duplicate masthead
  ids aliased in `scripts/config.json`. Lean disagreements show a note on the source.
- Issue-committee "endorsers" with both a YES and NO row become one "Both sides" entry.
- District groups: races only some voters see (scope not "Every ..."), same office, two
  or more on a ballot, become one "Which district is yours?" question placed inline. A
  single such race shows "May apply" with its scope and a "Not on my ballot" button,
  unless the place listed it and its scope names the place's county with no district.
- Unopposed = one candidate and not a retention vote. Folded per section, not counted.
- Multi-judge retention (CA appeals courts) gets per-judge Yes/No. Non-ranked multi-seat
  races (Boulder council, Chicago MWRD) allow up to `vote_for` marks. Ranked races rank.
- Special districts get their own section after School (the brief listed 7 sections).
- Save link: `#v1~ST~places~zip~picks~districts~notes~sources` (v2 adds `~ranks`), hashes
  not indexes, so a data refresh drops (and reports) unmatched picks instead of mis-restoring them.
- Plan "next step" is computed from `voting_model` and dates in the state file.
- Smooth scroll is off (FOUNDATION: it failed on phones last cycle).
