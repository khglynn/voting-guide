#!/usr/bin/env node
/* The outside watch on the Worker's public files (Nov 4, 2026), meant for an always-on Mac (Gabby's Air), never the
   Worker itself. The Worker pings its own source troubles through its Slack secrets (a refusal, a source failing 30
   minutes, a falling total), but it can't say when it has stopped, and nothing else re-checks the files it built.
   Kevin, Nov 4: "using this machine clearly isn't reliable I move it around too much" (the watch kept dying with his
   laptop). Each run, once (launchd starts the next):
   - reads each state's public file, with one retry after 15 s (a dropped connection is not a state's problem); a state
     with no file yet (404) is skipped;
   - a file older than 75 minutes while any of its sources still reads means the Worker stalled (quiet sources are read
     hourly from Nov 4, so a file can sit up to an hour);
   - runs bin/honesty.mjs on the file; falling-total notes are left out, since the Worker pings those itself;
   - compares with the last run's open problems in <dir>/state.json and tells Kevin only what changed: a new problem,
     one cleared, and one still open again every 6 hours. A quiet run posts nothing (Kevin, Oct 6: "Just final done or
     stuck pings").
   It reads public URLs only: no git, no login, nothing written outside <dir>. Telling is a shell command in
   VG_WATCH_NOTIFY that reads the message on stdin (on the Air, Gabby's own notify); without one the message is printed.
   Usage: node bin/watch.mjs [--dir ~/.vg-results-watch] [--states "TX CO"] [--dry]   (--dry: print, never notify) */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'https://vg-results.kevinhg.workers.dev/results/2026-11-03';
const UA = 'vote.kevinhg.com results fetcher (+https://vote.kevinhg.com)';
export const STATES = ['TX', 'CO', 'DC', 'CA', 'NY', 'MO', 'TN', 'FL', 'PA', 'GA', 'MD', 'IL', 'AL', 'OR', 'WA'];
export const STALE_MIN = 75;
export const REMIND_H = 6;
const NAMES = { TX: 'Texas', CO: 'Colorado', DC: 'DC', CA: 'California', NY: 'New York', MO: 'Missouri', TN: 'Tennessee', FL: 'Florida', PA: 'Pennsylvania', GA: 'Georgia', MD: 'Maryland', IL: 'Illinois', AL: 'Alabama', OR: 'Oregon', WA: 'Washington' };

/* One state's file judged on its own: the problems a person needs to hear about, as stable keys and plain words. */
export function judgeFile(st, file, nowMs) {
  const out = [];
  const srcs = Array.isArray(file.sources) ? file.sources : Object.values(file.sources || {});
  const reading = srcs.some((x) => x.status !== 'link_only' && !(x.failing_since && /refused/i.test(x.note || '')));
  const age = (nowMs - Date.parse(file.generated)) / 60000;
  if (!Number.isFinite(age)) out.push({ key: `${st}|no-time`, text: `${NAMES[st] || st}'s results file has no time on it.` });
  else if (reading && age > STALE_MIN) out.push({ key: `${st}|stale`, text: `${NAMES[st] || st}'s results file hasn't been rebuilt for ${Math.round(age)} minutes, so the Worker may have stopped.` });
  return out;
}

/* The honesty script's problem lines, minus the falling-total notes the Worker already pings. */
export function honestyProblems(st, output) {
  return String(output || '').split('\n').filter((l) => /^ {2}\S/.test(l) && !/falling-total note/.test(l))
    .map((l) => l.trim()).map((l) => ({ key: `${st}|honesty|${l.replace(/\d[\d,.]*/g, '#')}`, text: `${NAMES[st] || st}'s results file failed an honesty check: ${l}` }));
}

/* What to tell, from the last run's open problems and this run's: new ones, cleared ones, and open ones again every
   REMIND_H hours. Returns the messages and the state to keep. */
export function diff(prev, now, nowMs) {
  const open = { ...(prev?.open || {}) };
  const tell = [];
  const seen = new Set();
  for (const p of now) {
    seen.add(p.key);
    const was = open[p.key];
    if (!was) { open[p.key] = { since: nowMs, told: nowMs, text: p.text }; tell.push(p.text); }
    else if (nowMs - was.told >= REMIND_H * 3600_000) { open[p.key] = { ...was, told: nowMs, text: p.text }; tell.push(`Still open since ${new Date(was.since).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' })} CT: ${p.text}`); }
    else open[p.key] = { ...was, text: p.text };
  }
  for (const [k, v] of Object.entries(open)) if (!seen.has(k)) { delete open[k]; tell.push(`Cleared: ${v.text}`); }
  return { tell, state: { open, last_run: new Date(nowMs).toISOString() } };
}

async function getFile(st) {
  const once = async () => {
    const r = await fetch(`${BASE}/${st}.json?watch=${Date.now()}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) });
    return { status: r.status, body: r.status === 200 ? await r.text() : null };
  };
  try { return await once(); } catch {
    await new Promise((ok) => setTimeout(ok, 15_000));
    try { return await once(); } catch (e) { return { status: 0, error: String(e?.message || e) }; }
  }
}

const honesty = (st) => new Promise((ok) => {
  execFile(process.execPath, [path.join(HERE, 'honesty.mjs'), st], { timeout: 90_000, encoding: 'utf8' }, (err, stdout, stderr) => ok({ code: err ? (err.code ?? 1) : 0, out: `${stdout || ''}${stderr || ''}`, killed: !!err?.killed }));
});

async function main() {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
  const dry = argv.includes('--dry');
  const dir = opt('dir') || path.join(os.homedir(), '.vg-results-watch');
  const states = (opt('states') || STATES.join(' ')).split(/\s+/).filter(Boolean);
  fs.mkdirSync(dir, { recursive: true });
  const statePath = path.join(dir, 'state.json');
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* first run */ }
  const nowMs = Date.now();
  const problems = [];
  const checked = [];
  for (const st of states) {
    const r = await getFile(st);
    if (r.status === 404) continue;
    if (r.status !== 200) { problems.push({ key: `${st}|unreachable`, text: `${NAMES[st] || st}'s results file didn't load (${r.error || `HTTP ${r.status}`}).` }); continue; }
    let file;
    try { file = JSON.parse(r.body); } catch { problems.push({ key: `${st}|not-json`, text: `${NAMES[st] || st}'s results file isn't readable data.` }); continue; }
    checked.push(st);
    problems.push(...judgeFile(st, file, nowMs));
    const h = await honesty(st);
    if (h.killed) problems.push({ key: `${st}|honesty-timeout`, text: `The honesty check on ${NAMES[st] || st}'s file didn't finish in 90 seconds.` });
    else if (h.code !== 0) {
      const lines = honestyProblems(st, h.out);
      if (lines.length) problems.push(...lines);
      else if (!/falling-total note/.test(h.out)) problems.push({ key: `${st}|honesty-error`, text: `The honesty check on ${NAMES[st] || st}'s file stopped with an error: ${h.out.trim().split('\n').pop()}` });
    }
  }
  const { tell, state } = diff(prev, problems, nowMs);
  state.checked = checked;
  const save = () => { fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 1)); fs.renameSync(`${statePath}.tmp`, statePath); };
  console.log(`${new Date(nowMs).toISOString()} checked ${checked.join(' ') || 'nothing'}; open ${Object.keys(state.open).length}; told ${tell.length}`);
  if (!tell.length) return save();
  const msg = `Results watch: ${tell.join('\n')}`;
  const cmd = process.env.VG_WATCH_NOTIFY;
  if (dry || !cmd) { console.log(msg); return save(); }
  const r = spawnSync('/bin/sh', ['-c', cmd], { input: msg, encoding: 'utf8', timeout: 60_000 });
  // A message that didn't go out isn't marked told: the state stays as it was, so the next run tells it again.
  if (r.status !== 0) { console.log(`notify failed (${r.status}): ${(r.stderr || '').trim().slice(0, 300)}\n${msg}`); process.exitCode = 2; return; }
  save();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
