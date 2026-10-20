# Voting guide: agent instructions

*Last verified: 2026-10-19 (ledger v1).*

A public, one-page guide to the Nov 3, 2026 general election for Kevin's friends and family: enter a ZIP, see the next step and its date, every item on your ballot as a row with your trusted sources' picks beside it, decide, and leave with a cheat sheet. Live at https://vote.kevinhg.com (since Oct 19, 2026; the original https://voting-guide-silk.vercel.app still serves the same site). Vite + vanilla TypeScript, no framework, no analytics, no accounts. This repo is public: nothing private goes in it.

## Run and test

Node 20+. If `node --version` shows an old version, prefix commands with `export PATH=/usr/local/opt/node@22/bin:$PATH;` (a stray 2016 node at `/usr/local/bin` shadowed the real one on Kevin's personal Mac until Oct 19, 2026). Use preview ports 4173 to 4189: Node's `fetch` refuses a few ports on the web's "bad ports" list (4190 is one, as are 6000 and 6665 to 6669), and the sweep then fails with "bad port".

```sh
npm ci && npm run playwright:install
npm run build                      # data bundles + typecheck + production build
npx vite preview --port 4173       # then, against it:
npm run test:model                 # contracts, no browser: save links, districts, lenses, verdicts, fills (~1s)
npm run test:e2e                   # scripted taps at 380px (~2 min)
npm run sweep                      # every ballot the guide can show (68) checked against the data; MODE=full for every district variant
node tests/perf.mjs                # biggest ballots at 4x CPU throttle: taps must paint under 250ms
npm run shots                      # review screenshots of the test ballots into .tmp/shots/ledger/
scripts/ship.sh --gates-only       # all local gates in one go
```

`BASE` points any browser check at another server (a Vercel preview, production). `?today=2026-11-03` pretends it's that date. `?try=fresh|aunt|straight|sources` shows a scenario on whatever ballot opens and never saves anything.

## Where things live

- `data/` is the only copy of the research data. `scripts/build-data.mjs` validates it into `public/data/` bundles (bad records are skipped and reported, never fatal); `scripts/check-data.mjs` and `scripts/check-addresses.mjs` are the data gates. New optional fields must be passed through and shape-checked in build-data and typed in `src/types.ts`.
- `src/ballot.ts`, `src/state.ts`, `src/geo.ts`, `src/util.ts`: the model. `buildBallot` decides what is on a ballot (statewide items, place items, district questions, "may apply"). Don't replace it with a shortcut over `place.order`.
- `src/model/`: rules the views use. `labels` (titles, seat labels, courts, pick words, pass thresholds), `lens` ("Show endorsements from" presets), `tally` (the verdict column), `bulk` (fills with undo), `judges` (official reviews and the section's plain answer), `plan` (the next step from the state file; a place's own `early_in_person` window wins over the state's when every place on the ballot agrees).
- Poll times are local: `plan.ts` keeps each state's time zones, the main one first. A new place in a state's other zone (Pensacola is Central in Eastern Florida) needs a line in `PLACE_ZONE`, or its "polls closed" moment is an hour off.
- `src/views/`: string templates. `render.ts` paints regions and single rows; `actions.ts` holds every `data-act`; `app.ts` the flows; `main.ts` boot and the tap handler (tuned on phones; keep it).
- `tests/`: `model.mjs` + `model-ledger.mjs`, `e2e.mjs`, `sweep.mjs`, `perf.mjs`, `shots.mjs`.
- The look is three materials: paper (Blender renders in `public/paper/`, made by `scripts/paper/`; its README says how to regenerate, and `bake.py` writes the block between `paper:start` and `paper:end` in `src/styles.css`, so don't hand-edit it), one printed green ink for headings (Archivo, with a speck mask), and pen for rules, boxes and ticks. Print and dark mode swap through tokens.

## How changes ship

Branch, pull request, CI (`.github/workflows/ci.yml`: data gates, model tests, build, e2e, sweep), an independent review, then a squash merge. Pushes to `main` deploy to the live site, and friends are using it during early voting, so nothing merges without the gates green on the final commit. Vercel builds a preview for every branch (`voting-guide-git-<branch>-kevinhg.vercel.app`); run the sweep against it before merging.

## Rules that do not bend

The reasons are in the workbench's FOUNDATION.md.

- No real person's street address anywhere: data, code, tests, notes. Public offices and polling places only, through the allowlist.
- Every fact has a source URL. Confidence is marked honestly (verified, sourced, unverified).
- Nonpartisan and parallel: the same fields for every candidate, quote rather than characterize, no recommendations from us. The default lens is papers and nonpartisan guides; anything partisan is the voter's choice.
- Lean labels come only from outside ratings, official party status or a group's own stated mission, never from whom it endorses.
- Endorsement states stay distinct: endorsed, took no stand, no picks found, not checked yet.
- No red or blue in the UI; party is text, lean is a neutral five-step scale plus a word. Color has one job each: gold = your pick, sage = your sources agree, clay = they disagree, dusk = the frame and official reviews.
- No all caps (no `text-transform: uppercase`), no em dashes in guide copy, plain words for a smart 16-year-old.
- Judges' reviews are worded as the reviewer's rating, never ours, and concerns get the same weight as praise.
- Messages for work, school and public channels use official links only, never this guide.

## The save-link and storage contract

Changing any of this silently loses people's picks. `tests/model.mjs` pins it (a golden link, a real pre-ranked-choice link from the live site, round trips).

- localStorage key `vg2`, ballots keyed `ST|place+place` (or `ST|-`). Add fields to `BallotState` only (old saves are back-filled); never rename or remove one.
- Links live in the hash: `#v1~ST~places~zip~picks~districts~notes~sources`; `v2` adds `~ranks` only when a ranking exists; a 10th field `~notMine` is written only when the voter hid "may apply" races (an empty ranks slot fills field 9). Hashes are FNV-1a base36 (`util.hash`), pick codes `Y N S D P` or a 3-char candidate-name hash. Keys are item ids or `id|candidate name` (multi-judge, multi-seat).
- Pick values: candidate names, `YES`/`NO` (measures and judges: keep is `YES`), `SKIP`, `DONE`, `PICK`. Lenses are stored as an explicit endorser-id list in `sources` (`null` = defaults); chips are presets over it.

## Test hooks (keep them, or update the tests in the same change)

`id="i-<item id>"` and `data-item` on every item, `data-undecided` on undecided rows, `data-q` on district questions, `data-act` on every control, `.sec[data-sec]` with `.sec-count`, `.unopp .disc`, `.wi-fold` (folded write-ins), `.bar-txt` ("N of M decided", choices only), `#plan`, `#cheat`, `#r-print`, `.toast`. Test-only query strings: `?today=YYYY-MM-DD`, `?now=HH:MM` (local time where the polls are), `?try=fresh|aunt|straight|sources`.
