/* Hand-written files served until a state has a real one (plan sub-phase 1). `test: true`: the site ignores a test
   file unless the page's address has ?results=test. The numbers are made up and round on purpose; the item ids and
   candidate names are the guide's own, so the site's results view can be built against them. */
export const TEST_FILES = {
  TX: {
    election: '2026-11-03',
    state: 'TX',
    generated: '2026-11-03T21:30:00.000Z',
    test: true,
    note: 'Test file with made-up numbers, not results. The fetcher replaces it once Travis, Dallas, Bexar or Harris passes its first-run check.',
    sources: [
      { id: 'travis-tx', name: 'Travis County', url: 'https://results.enr.clarityelections.com/TX/Travis/', updated: '2026-11-04T03:35:00.000Z', status: 'counting', reporting: '120 of 200 precincts reporting', fetched: '2026-11-04T03:42:00.000Z', next_due: '2026-11-04T03:43:00.000Z' },
      { id: 'williamson-tx', name: 'Williamson County', url: 'https://results.enr.clarityelections.com/TX/Williamson/127488/', updated: '2026-11-04T03:30:00.000Z', status: 'counting', reporting: '50 of 100 precincts reporting', fetched: '2026-11-04T03:41:00.000Z' },
      { id: 'harris-county-tx', name: 'Harris County', url: 'https://www.harrisvotes.com/Election-Results/Live-Results', updated: '2026-11-04T03:12:00.000Z', status: 'counting', reporting: '300 of 623 vote centers reporting', fetched: '2026-11-04T03:41:00.000Z', failing_since: '2026-11-04T03:20:00.000Z' },
    ],
    items: {
      'tx-us-house-37': { source: 'travis-tx', status: 'counting', reporting: '120 of 200 precincts reporting', updated: '2026-11-04T03:35:00.000Z', url: 'https://results.enr.clarityelections.com/TX/Travis/', total_votes: 100000, candidates: [{ name: 'Greg Casar', votes: 70000, pct: 70 }, { name: 'Lauren B. Peña', votes: 30000, pct: 30 }], final: null },
      'tx-house-49': { source: 'travis-tx', status: 'complete', reporting: '200 of 200 precincts reporting', updated: '2026-11-04T03:35:00.000Z', url: 'https://results.enr.clarityelections.com/TX/Travis/', total_votes: 50000, candidates: [{ name: 'Montserrat Garibay', votes: 30000, pct: 60 }, { name: 'Arshia Papari', votes: 20000, pct: 40 }], final: { winners: ['Montserrat Garibay'] } },
      'tx-aisd-at-large-9': { source: 'travis-tx', status: 'pending', reporting: null, updated: null, url: 'https://results.enr.clarityelections.com/TX/Travis/', final: null },
      'tx-acc-trustee-1': { source: 'travis-tx', status: 'link_only', reporting: null, updated: null, url: 'https://results.enr.clarityelections.com/TX/Travis/', reason: 'not matched' },
      'tx-austin-prop-a': {
        source: 'travis-tx', status: 'counting', reporting: '120 of 200 precincts reporting', updated: '2026-11-04T03:35:00.000Z', url: 'https://results.enr.clarityelections.com/TX/Travis/', total_votes: 80000,
        measure: { yes: 52000, no: 28000, yes_pct: 65, threshold: 50 },
        slices: [
          { source: 'travis-tx', county: 'Travis', status: 'counting', reporting: '120 of 200 precincts reporting', updated: '2026-11-04T03:35:00.000Z', url: 'https://results.enr.clarityelections.com/TX/Travis/', total_votes: 80000, measure: { yes: 52000, no: 28000, yes_pct: 65, threshold: 50 } },
          { source: 'williamson-tx', county: 'Williamson', status: 'counting', reporting: '50 of 100 precincts reporting', updated: '2026-11-04T03:30:00.000Z', url: 'https://results.enr.clarityelections.com/TX/Williamson/127488/', total_votes: 4000, measure: { yes: 2400, no: 1600, yes_pct: 60, threshold: 50 } },
        ],
        missing: ['Hays'],
        final: null,
      },
    },
  },
};
