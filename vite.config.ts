import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

/* The build's short commit, for a problem report's "We'll send along" list (views/shelf.ts): Vercel's
   own variable when it builds, else the checkout's commit (CI, a local build), else "dev". */
function build(): string {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  if (sha) return sha.slice(0, 7);
  try { return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'dev'; } catch { return 'dev'; }
}

export default defineConfig({
  build: { target: 'es2020', sourcemap: false, cssCodeSplit: false },
  define: { 'import.meta.env.VITE_BUILD': JSON.stringify(build()) },
});
