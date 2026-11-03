/* Who won, or whether a measure passed, set only for a complete or official count (DESIGN.md honesty rule 3).
   The source's own declared outcome comes first. Otherwise a written rule per kind of contest, on unrounded counts:
   plurality, most votes (a tie gives none); multi, the top `seats` (a tie at the cut gives none); measure, yes against
   the guide's own threshold; retention, the state's threshold. Ranked choice before its final round, a rule we don't
   hold, and any race whose voters span sources: none (plan call 6). */

/* Retention thresholds by state, where they aren't a simple majority. */
export const RETENTION = { IL: { pct: 60, inclusive: true } };

/* "simple majority", "majority", "55%", "60 percent", "two-thirds", "at least 55%": { pct, inclusive } or null. */
export function parseThreshold(s) {
  const t = String(s ?? '').toLowerCase();
  if (!t) return null;
  if (/two[- ]thirds|2\/3/.test(t)) return { pct: 200 / 3, inclusive: /at least/.test(t) };
  if (/three[- ]fifths|3\/5/.test(t)) return { pct: 60, inclusive: /at least/.test(t) };
  const m = t.match(/(\d+(?:\.\d+)?)\s*(%|percent)/);
  if (m) return { pct: Number(m[1]), inclusive: /at least|or more/.test(t) };
  if (/majority|more than half|50%/.test(t)) return { pct: 50, inclusive: false };
  return null;
}

function meets(yes, no, th) {
  const total = yes + no;
  if (total <= 0 || !th) return null;
  // Compare yes/total with pct/100 on whole numbers: yes*100 vs pct*total (no rounding).
  const lhs = yes * 100, rhs = th.pct * total;
  if (lhs === rhs) return th.inclusive ? true : false;
  return lhs > rhs;
}

export function outcomeFor({ status, kind, seats = 1, candidates = [], measure = null, declared = null, threshold = null, spanning = false }) {
  if (status !== 'complete' && status !== 'official') return null;
  if (spanning) return null;
  if (declared && declared.length && (kind === 'plurality' || kind === 'multi')) return { winners: declared.slice() };
  switch (kind) {
    case 'plurality': {
      if (candidates.length === 0) return null;
      const s = [...candidates].sort((a, b) => b.votes - a.votes);
      if (s.length > 1 && s[0].votes === s[1].votes) return null;
      if (s[0].votes <= 0) return null;
      return { winners: [s[0].name] };
    }
    case 'multi': {
      const n = Number(seats) || 1;
      const s = [...candidates].sort((a, b) => b.votes - a.votes);
      if (s.length <= n) return s.every((c) => c.votes > 0) ? { winners: s.map((c) => c.name) } : null;
      if (s[n - 1].votes === s[n].votes) return null;
      return { winners: s.slice(0, n).map((c) => c.name) };
    }
    case 'measure':
    case 'retention': {
      if (!measure) return null;
      const r = meets(measure.yes, measure.no, threshold);
      return r === null ? null : { passed: r };
    }
    default:
      return null; // rcv before its final round, rule_unknown
  }
}
