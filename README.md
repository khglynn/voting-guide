# Your Ballot, Explained (2026 voting guide)

A one-page guide to the Nov 3, 2026 general election for Kevin's friends and family.
Enter a ZIP, see your next step and its date, read your ballot as a calm list of rows
with the picks of the sources you trust beside each one, decide, and take a cheat sheet
to the polls. The layout is "the ledger" (v3, Oct 19 2026); agent notes are in `AGENTS.md`. Static site: Vite + vanilla TypeScript, no framework, no cookies,
no accounts. Visits are counted with Vercel's cookie-free Web Analytics, on Vercel's hosts only, and
nothing personal goes with them (no ZIP, address, picks or contact; `src/stats.ts`). If the page breaks
it sends a scrubbed crash report to Sentry (no address, no picks, no IP; `src/scrub.ts`). Live at
https://vote.kevinhg.com.

## Run it

Needs Node 20 or newer (CI uses 24, Vercel builds on 24).

```sh
npm install
npm run playwright:install   # once: downloads Chromium for the browser checks
npm run dev          # builds the data, then starts Vite at http://localhost:5173
npm run build        # data + typecheck + production build into dist/
npm run preview      # serve dist/ at http://localhost:4173
npm run check        # no stray street addresses, build the data, data rules (no browser)
npm run test:model   # save-link contract, districts, lenses, verdicts, bulk fills (no browser)
npm run test:e2e     # scripted Playwright pass at 380px against the preview
npm run sweep        # opens every ballot the guide can produce at 380px and checks it against the data
npm run shots        # review screenshots of the test ballots (not a test)
node tests/perf.mjs  # the biggest ballots at 4x CPU throttle
scripts/ship.sh --gates-only   # everything above in one go, on a throwaway preview port
```

`test:e2e` and `sweep` read `BASE` (default `http://localhost:4173`, so run `npm run build`
and `npm run preview` first, or point `BASE` at a Vercel preview). `sweep` takes
`MODE=full` to also visit every district variant, and `ONLY=austin-tx,dc-ward-1` to
debug a few ballots. Each sweep run writes its screenshots and report to its own folder
under `.tmp/sweep-shots/` (ignored by git; the newest 10 are kept); `shots/` is the
committed reference set. CI (`.github/workflows/ci.yml`) runs the same gates on every
pull request and every push to `main`, plus a daily sweep of the live site.

To ship: from an up-to-date `main`, `scripts/ship.sh "what changed" path/to/file ...`
runs every gate on a copy of exactly the commit it will make (so a file left out, or
something else staged, cannot slip through), opens a pull request, waits for the `data`
and `browser` checks to pass on that exact commit, then tests the Vercel preview once
it serves that commit. It never merges. After the review and the merge,
`scripts/ship.sh --after-merge <pr>` waits until production serves the merge commit
(or a later `main` commit that includes it), then sweeps it. `scripts/ship.sh --self-test` and `node scripts/check-addresses.mjs
--self-test` check the scripts' own decisions; CI runs both.

`?today=2026-10-30` on the URL pretends it's that date, for checking the plan strip.
`?try=fresh`, `aunt`, `straight` or `sources` shows that scenario on whatever ballot you
open, with a banner, and never touches your saved picks.

## Add a place

`data/` in this repo is the only copy of the research data: edit it here, and nothing
else needs refreshing. The shapes of each file are in `scripts/build-data.mjs` and the
check rules are in `scripts/check-data.mjs`. To add a place, drop in its files and run
the checks:

1. `data/places/{place-id}.json`: label, state, counties, ZIPs, `contest_ids` (and
   optionally `measure_ids`). ZIPs that cross into another place make the app ask
   "Which of these is you?"
2. `data/contests/{file}.json` and `data/measures/{file}.json` for the local items.
3. `data/endorsers-{file}.json` and `data/endorsements-{file}.json`.
4. `npm run check`, then `npm run build`, then `npm run test:e2e` and `npm run sweep`.
   The sweep finds the new place by itself from `data/index.json`, so it is checked
   with no test edits.

The state must already have `data/states/{ST}.json`. Statewide items come from
`data/contests/{st}-statewide.json` and `data/measures/{st}-statewide.json`.

Two guards you may trip, both on purpose:

- **Addresses.** `scripts/check-addresses.mjs` fails on anything shaped like a street
  address, in any capitalization. A public office or polling place is allowed by adding
  its whole address as the checker prints it, with a reason and a source URL, to
  `scripts/address-allowlist.json`. A person's address is never allowed: delete it from
  the data. The check is a best-effort tripwire behind the real rule (nobody writes a
  person's address anywhere, and a reviewer reads what ships), not a complete detector;
  its known limits are listed at the top of the script.
- **Data rules.** `scripts/check-data.mjs` blocks dates after the election, broken
  measure links, bad endorsement states and similar, and anything the build dropped (a
  nameless candidate, a race a place lists but no file defines, a build warning it has
  not seen before). Run it right after `npm run data`. Known older findings are counted
  in `scripts/data-baseline.json`; the count may fall but not rise. After fixing some,
  run `node scripts/check-data.mjs --update-baseline` to lock the gain in.

## What the data step does

`scripts/build-data.mjs` reads everything in `data/`, validates each record, merges
duplicate endorsers, matches endorsement picks to candidate names, links dueling
measures, and writes lazily loaded bundles to `public/data/`:

- `index.json`: states, places and the ZIP index (loaded first, small)
- `state-{ST}.json`: how to vote, statewide contests and measures, endorsements
- `place-{id}.json`: local contests and measures, endorsements, ballot order

A file or record that fails validation is skipped, never fatal. Check
`public/data/build-report.json` after a build: skipped files, skipped records and
warnings are listed there and summarized in the console.

`scripts/config.json` holds the few hand-kept joins: endorser aliases (one board, two
mastheads), and measure pairs that collide (CO 87 vs 136, CA 40, 41 and 42). Other
collisions are detected from the measure text.

## Rules the code keeps

- Every date shown comes from `data/states/{ST}.json`. The plan strip leads with the next
  step and its date (never a countdown), computed for every voting model.
- No red or blue. Party is text only. Lean is a neutral five-step scale plus words. Color
  has one job each: gold = your pick, sage = your sources agree, clay = they disagree,
  dusk = the frame and official judge reviews.
- "Show endorsements from" starts with newspapers and nonpartisan guides. Progressive groups,
  conservative groups, a party, or any single source are the voter's choice; the chips
  are presets over the source list the save link already carries.
- No addresses anywhere. The optional address lookup sends the address only to the
  U.S. Census Geocoder (JSONP) and never stores it.
- Picks save in `localStorage` (wrapped in try/catch) and in the save link's URL
  fragment (`#v1~...`, or `#v2~...` when it holds a ranked-choice ranking, plus an
  optional 10th field for races the voter said aren't on their ballot), which never
  reaches a server. Old v1 links still restore; `tests/model.mjs` pins the format.
- Ranked-choice races come only from the data (`ranked_choice`, `rank_up_to`, `winners`),
  flagged from official sample ballots; `../research/rcv.md` logs each one.

## Where it lives

https://vote.kevinhg.com since Oct 19, 2026. The original https://voting-guide-silk.vercel.app
still serves the same site, but the friends message in "Help your friends vote" always shares
vote.kevinhg.com, whatever host the page is on.

## Deploy

Vercel, static: build command `npm run build`, output directory `dist`, framework
none (see `vercel.json`).

## License

- **Code:** MIT (see `LICENSE`).
- **Data we wrote** (plain-language summaries, explainers and how-to-vote notes in `data/`): [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Reuse it, just credit the guide.
- **Quoted material** (candidate statements, ballot text, endorsement excerpts) belongs to its authors and is quoted with a link to the source.

This is a nonpartisan guide. Always confirm deadlines with your official election office.
