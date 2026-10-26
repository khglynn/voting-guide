import { defineConfig } from 'vite';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { execSync } from 'node:child_process';

/* The build's short commit, for a problem report's "We'll send along" list (views/shelf.ts) and as the
   crash reports' release (sentry.ts): Vercel's own variable when it builds, else the checkout's commit
   (CI, a local build), else "dev". */
function build(): string {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  if (sha) return sha.slice(0, 7);
  try { return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'dev'; } catch { return 'dev'; }
}
const release = build();

/* Readable stacks in Sentry: only when SENTRY_AUTH_TOKEN is set (a build-only secret in Vercel, Kevin's to
   mint; never with a VITE_ prefix, which would put it in the page). Then the build writes source maps
   without the comment that points browsers at them, uploads them, and deletes them, so they are never
   served. The plugin deletes them even when the upload fails, and a failure only warns, so a bad token
   can't stop a deploy. Without the token: no maps at all, and the build is the same as before.
   VITE_SENTRY_DSN (public by design) comes from the environment like any VITE_ variable. */
const token = process.env.SENTRY_AUTH_TOKEN;

export default defineConfig({
  build: { target: 'es2020', sourcemap: token ? 'hidden' : false, cssCodeSplit: false },
  define: {
    'import.meta.env.VITE_BUILD': JSON.stringify(release),
    'import.meta.env.VITE_VERCEL_ENV': JSON.stringify(process.env.VERCEL_ENV || 'local'),
  },
  plugins: token
    ? [sentryVitePlugin({
        org: 'khg-y1',
        project: 'voting-guide',
        authToken: token,
        telemetry: false,
        release: { name: release, inject: false }, // sentry.ts sets the release itself
        sourcemaps: { filesToDeleteAfterUpload: ['dist/**/*.map'] },
        errorHandler: (err) => { console.warn(`Sentry source map upload failed; the build goes on without it: ${err.message}`); },
      })]
    : [],
});
