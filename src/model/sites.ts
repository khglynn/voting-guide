/* Election Day vote centers, nearest first (Nov 3). In Travis, Williamson and Hays any voter can vote at any
   vote center in their county on Election Day, so after an address lookup this visit the plan's Election Day
   step lists the three closest, each with its distance and a directions link (views/planstrip.ts).

   The rules that keep it private and quiet:
   - The point is the Census's for the address looked up (S.ui.addrPoint), in memory for this visit only. It is
     never saved, never in the save link, never sent anywhere: the distances are worked out here, on the device,
     and a directions link carries only the site's own address.
   - A county's list (public/data/sites/<id>.json, from data/sites/, checked by scripts/build-data.mjs) loads only
     when the block would show, once per visit. A list that doesn't load shows nothing new and logs nothing.
   - The place files name each county's list (`by_county[].sites`), so a county the place doesn't list gets none. */
import type { PlaceBundle } from '../types';
import { countyKey } from './plan';

export interface Site { name: string; address: string; lat: number; lng: number }
export interface SiteFile {
  county: string; state: string; election_date: string;
  list_source: string; coords_source: string; fetched: string; count_official: number;
  sites: Site[];
}
export interface Near { site: Site; mi: number }
export type Point = { lat: number; lon: number };

/* The county's list for this ballot: the first place on it whose by_county entry for that county names one. */
export function sitesIdFor(places: PlaceBundle[], county: string | null | undefined): string | null {
  if (!county || !county.trim()) return null;
  const k = countyKey(county);
  for (const p of places) {
    const c = (p.by_county || []).find((x) => countyKey(x.county) === k && x.sites);
    if (c) return c.sites!;
  }
  return null;
}

/* Miles between two points on the Earth, as the crow flies (haversine, mean radius 3958.8 miles). */
export function milesBetween(a: Point, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lng - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/* The `n` closest sites, nearest first; a tie goes by name, so the order never flickers between repaints. */
export function nearest(sites: Site[], at: Point, n = 3): Near[] {
  return sites.map((site) => ({ site, mi: milesBetween(at, site) }))
    .sort((x, y) => x.mi - y.mi || (x.site.name < y.site.name ? -1 : x.site.name > y.site.name ? 1 : 0))
    .slice(0, n);
}

/* "0.4 mi" under 10 miles, "12 mi" from there; a site at the door is "under 0.1 mi", never "0.0 mi". */
export function fmtMiles(mi: number): string {
  if (mi < 0.05) return 'under 0.1 mi';
  return mi < 9.95 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
}

/* Google Maps directions to the site: the site's own public address, and nothing else (no origin, so the
   phone's maps start from where it is, and the voter's address never rides in a link). */
export const directionsURL = (s: Site): string => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(s.address)}`;

/* ---------- the lists, loaded once per visit ----------
   The view asks (wantSites) only when the block would show; app.ts registers the loader (onWantSites), which
   fetches the file and repaints the plan once it lands. Tests seed a list with putSites. */
const files = new Map<string, SiteFile>();
const asked = new Set<string>();   // asked for this visit: on its way, here, or missed
const missed = new Set<string>();  // asked for and didn't load
let loader: ((id: string) => Promise<boolean> | boolean | void) | null = null;
export function onWantSites(fn: (id: string) => Promise<boolean> | boolean | void): void { loader = fn; }
export const sitesFile = (id: string): SiteFile | null => files.get(id) || null;
export function wantSites(id: string): void {
  if (files.has(id) || asked.has(id) || !loader) return;
  asked.add(id);
  const go = loader;
  // Never inside a paint: the request starts once this render is done.
  queueMicrotask(() => {
    Promise.resolve().then(() => go(id)).then((ok) => { if (ok === false) missed.add(id); }, () => { missed.add(id); });
  });
}
/* A new address lookup may try again a list that didn't load earlier this visit (never one still on its way). */
export function retrySites(): void { for (const id of [...missed]) { missed.delete(id); asked.delete(id); } }

const inRange = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
/* A list as it arrives, checked again on the device (build-data checked it before it shipped): a site with no
   name, no address or a point outside the state is left out, and a list with none left isn't kept. */
export function putSites(id: string, raw: unknown): boolean {
  const f = raw as Partial<SiteFile> | null;
  if (!f || typeof f !== 'object' || typeof f.county !== 'string' || typeof f.election_date !== 'string' || !Array.isArray(f.sites)) return false;
  const sites = f.sites.filter((s): s is Site => !!s && typeof s.name === 'string' && !!s.name.trim() && typeof s.address === 'string' && !!s.address.trim()
    && inRange(s.lat, 18, 72) && inRange(s.lng, -180, -60));
  if (!sites.length) return false;
  files.set(id, { ...(f as SiteFile), sites });
  return true;
}
