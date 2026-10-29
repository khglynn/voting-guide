/* The one script a static page loads (src/pages/site.ts): the guide's own cookie-free visit count, with every
   rule stats.ts keeps (its host check, the address cut to origin and path, the referring site cut to its
   origin). A page view only; these pages send no events. Built on its own by scripts/build-pages.mjs, so the
   app's bundle and its load order don't change. */
import { startStats } from '../stats';

startStats();
