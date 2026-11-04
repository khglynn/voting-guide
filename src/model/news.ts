/* AP's race calls (Nov 3, results Phase 1; Kevin's call on the design review: AP only, under federal and statewide
   races, to AP's race page where it has one, else its state page). The URL pattern is the workbench's
   registry/news-links.json (AP's `race_url_template`); a race page ships only where it answered 200 when checked, so a
   link never lands on a 404. Checked from the builder's Mac on Nov 3, 2026, about 7:30 PM CT, for all 15 covered states
   and the seven office pages AP builds. AP calls races; the guide doesn't, so this is a link out, labeled as theirs. */
import type { Contest, Item } from '../types';
import { apStateURL } from './plan';

const RACE_PAGES: Record<string, string[]> = {
  TX: ['us-senate', 'governor', 'us-house', 'attorney-general', 'lieutenant-governor', 'railroad-commissioner'],
  CO: ['us-senate', 'governor', 'us-house', 'attorney-general', 'secretary-of-state'],
  CA: ['governor', 'us-house', 'attorney-general', 'lieutenant-governor', 'secretary-of-state'],
  NY: ['governor', 'us-house', 'attorney-general'],
  IL: ['us-senate', 'governor', 'us-house', 'attorney-general', 'secretary-of-state'],
  MO: ['us-house'],
  MD: ['governor', 'us-house', 'attorney-general'],
  FL: ['us-senate', 'governor', 'us-house', 'attorney-general'],
  DC: ['attorney-general'],
  GA: ['us-senate', 'governor', 'us-house', 'attorney-general', 'lieutenant-governor', 'secretary-of-state'],
  OR: ['us-senate', 'governor', 'us-house'],
  WA: ['us-house'],
  AL: ['us-senate', 'governor', 'us-house', 'attorney-general', 'lieutenant-governor', 'secretary-of-state'],
  PA: ['governor', 'us-house'],
  TN: ['us-senate', 'governor', 'us-house'],
};
/* AP's page slug for an office, by the office's own name. */
function slugOf(c: Contest): string | null {
  const o = c.office.toLowerCase();
  if (/u\.?\s*s\.?\s*senat/.test(o)) return 'us-senate';
  if (/u\.?\s*s\.?\s*(representative|house)|congress|delegate to (the )?u\.?s/.test(o)) return 'us-house';
  if (/^lieutenant governor|^lt\.? governor/.test(o)) return 'lieutenant-governor';
  if (/^governor\b/.test(o)) return 'governor';
  if (/^attorney general\b/.test(o)) return 'attorney-general';
  if (/^secretary of state\b/.test(o)) return 'secretary-of-state';
  if (/^railroad commissioner/.test(o)) return 'railroad-commissioner';
  return null;
}
/* Federal and statewide races only (judges and measures aren't AP's to call here): AP's race page, else its state page. */
export function apRaceURL(it: Item, st: string, stateName: string): string | null {
  if (it.kind !== 'contest' || it.is_retention || (it.level !== 'federal' && it.level !== 'state')) return null;
  const state = apStateURL(st, stateName);
  const slug = slugOf(it);
  return slug && (RACE_PAGES[st] || []).includes(slug) ? state.replace(/-results\/$/, `-${slug}-results/`) : state;
}
