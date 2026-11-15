#!/usr/bin/env node
/* The outside watch on the Worker's public files (Nov 4, 2026), meant for an always-on Mac (Gabby's Air), never the
   Worker itself. The Worker pings its own source troubles through its Slack secrets (a refusal, a source failing 30
   minutes, a falling total), but it can't say when it has stopped, and nothing else re-checks the files it built.
   Kevin, Nov 4: "using this machine clearly isn't reliable I move it around too much" (the watch kept dying with his
   laptop). Each run, once (launchd starts the next):
   - reads each state's public file, retrying once after 15 s on a dropped connection or a 5xx; a state that has never
     had a file (404) is skipped, but a 404 for a state that had one is a problem (the Worker or its route is gone);
   - a file whose earliest planned read (`next_due` on its sources) is more than 20 minutes past means the Worker
     stalled. It follows the Worker's own plan, so overnight quiet hours (11 PM to 6 AM local from Nov 4), hourly and
     six-hourly polls, and sources stopped at certification are quiet, never "stale" (review, Nov 4: a fixed 75-minute
     age would have buzzed Kevin every night and every state once counting ended);
   - runs bin/honesty.mjs on the file and reads only its PROBLEMS list; falling-total notes are left out, since the
     Worker pings those itself;
   - compares with the last run's open problems in <dir>/state.json and tells Kevin only what changed: a new problem, one
     cleared (in a short line of its own), and one still open again every 6 hours. A quiet run posts nothing (Kevin,
     Oct 6: "Just final done or stuck pings"). A state it couldn't judge this run keeps its open problems as they were,
     and a passing hiccup (a file that didn't load, a check that couldn't run) is told only when it happens twice in a row.
   It reads public URLs only: no git, no login, nothing written outside <dir>. Telling is a shell command in
   VG_WATCH_NOTIFY that reads the message on stdin (on the Air, Gabby's `gabby-notify -`, whose exit 75 means her outbox
   has it); without one the message is printed. A message that fails to send is told again on the next run. When
   VG_WATCH_NOTIFY_QUIET is set too (Nov 15), the lines with nothing in them for Kevin go through it instead: this Mac's
   own trouble and every "Cleared" (diff says which). On the Air the two are gabby-notify with --urgent broken and
   with --for-brief, so only what is broken reaches his phone and the rest waits for his brief.
   Every step fits inside the 9 minutes the start script gives a run (Nov 12; review, Nov 13): a state starts only while
   its slowest file read, honesty check and the notify step still fit, and its honesty check only while that check and
   the notify step do. A state left out keeps its open problems and its first hiccups as they were (one whose honesty
   check was left out, only its honesty problems) and goes first on the next run, so a slow Mac never leaves the same
   last states unwatched run after run.
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
export const LATE_MIN = 20;
export const REMIND_H = 6;
// The start script ends a run at 9 minutes. The slowest each step can be: a file read 55 s (20 s, a 15 s wait, 20 s
// again), an honesty check 90 s, the notify step 60 s (both its sends together), with 10 s kept for node starting and the state being saved. So a
// state starts by 5:25 and its honesty check by 6:20.
export const STOP_MS = 9 * 60_000;
const SPARE_MS = 10_000;
const FILE_MS = 55_000;
const HONESTY_MS = 90_000;
export const NOTIFY_MS = 60_000;   // the whole notify step: two sends (quiet, then the rest) share it
export const SEND_MIN_MS = 5_000;  // less than this left of it: the next send waits for the next run
export const HONESTY_BY_MS = STOP_MS - SPARE_MS - NOTIFY_MS - HONESTY_MS;
export const START_BY_MS = HONESTY_BY_MS - FILE_MS;

/* How long the next send may take, from what is left of the notify step's one budget (`notifyBy`, when it ends), or
   null when too little is left to start one (review of voting-guide#150, round 1: two sends of 60 s each could run the
   step past the 9-minute stop, and a run cut off after its second send, before its state is saved, would tell it again). */
export function sendTimeout(notifyBy, nowMs) {
  const left = notifyBy - nowMs;
  return left >= SEND_MIN_MS ? left : null;
}

/* This run's order: the states the last run left out first, then the rest in their usual order. */
export function runOrder(states, prev) {
  const first = (prev?.skipped || []).filter((st) => states.includes(st));
  return [...first, ...states.filter((st) => !first.includes(st))];
}
const MAX_MSG = 1150; // gabby-notify takes 1,200 characters from stdin
const NAMES = { TX: 'Texas', CO: 'Colorado', DC: 'DC', CA: 'California', NY: 'New York', MO: 'Missouri', TN: 'Tennessee', FL: 'Florida', PA: 'Pennsylvania', GA: 'Georgia', MD: 'Maryland', IL: 'Illinois', AL: 'Alabama', OR: 'Oregon', WA: 'Washington' };
const nm = (st) => NAMES[st] || st;
const ct = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/* One state's file judged on its own. A problem is a stable key, the words that tell it, and a short line for when it
   clears. `hiccup` problems are told only when they happen on two runs in a row. */
export function judgeFile(st, file, nowMs) {
  if (!Number.isFinite(Date.parse(file.generated))) return [{ key: `${st}|no-time`, text: `${nm(st)}'s results file has no time on it.`, label: `${nm(st)}'s results file has its time again.` }];
  const srcs = Array.isArray(file.sources) ? file.sources : Object.values(file.sources || {});
  const due = srcs.map((x) => Date.parse(x.next_due)).filter(Number.isFinite);
  const late = due.length ? (nowMs - Math.min(...due)) / 60000 : -Infinity;
  if (late > LATE_MIN) return [{ key: `${st}|stale`, text: `${nm(st)}'s results file was due a fresh read ${Math.round(late)} minutes ago and hasn't been rebuilt, so the Worker may have stopped.`, label: `${nm(st)}'s results file is being rebuilt again.` }];
  return [];
}

/* The honesty script's PROBLEMS list, minus the falling-total notes the Worker already pings. Numbers are masked only
   after the item id, so a count changing doesn't make a new problem each run while two races stay two problems. */
export function honestyProblems(st, output) {
  const lines = String(output || '').split('\n');
  const at = lines.findIndex((l) => /^PROBLEMS \(\d+\):/.test(l));
  if (at < 0) return null;
  return lines.slice(at + 1).filter((l) => /^ {2}\S/.test(l) && !/falling-total note/.test(l)).map((l) => l.trim()).map((l) => {
    const i = l.indexOf(': ');
    const key = i < 0 ? l.replace(/\d[\d,.]*/g, '#') : l.slice(0, i) + l.slice(i).replace(/\d[\d,.]*/g, '#');
    return { key: `${st}|honesty|${key}`, text: `${nm(st)}'s results file failed an honesty check: ${l}`, label: `${nm(st)}: ${i < 0 ? l : l.slice(0, i)} passes its honesty check again.` };
  });
}

/* What to tell, from the last run's state and this run's problems. `unjudged` states keep their open problems and their
   waiting hiccups as they were (`ST|honesty` in it: only that state's honesty problems); hiccups wait for a second run
   in a row. Returns the messages, which of them are quiet (below) and the state to keep.
   Quiet (Nov 15): news with nothing in it for Kevin, which on the Air waits for his next brief instead of buzzing him
   (VG_WATCH_NOTIFY_QUIET): a problem marked `quiet` (this Mac's own trouble, like an honesty check that ran out of time
   on a busy Air), its reminders, and every "Cleared" line. On Nov 15 the watch posted "The honesty check on DC's file
   couldn't run: it didn't finish in 90 seconds" and its "Cleared" eleven minutes later straight to his DM at 4 AM, past
   Gabby's rule that a program's notice reaches him at once only when something is broken that only he can fix. A stalled
   Worker, a failed honesty rule, a file gone or unreadable still reach him at once. */
export function diff(prev, now, nowMs, unjudged = new Set()) {
  const open = { ...(prev?.open || {}) };
  const waiting = prev?.waiting || {};
  const nextWaiting = {};
  const tell = [];
  const quiet = [];
  const seen = new Set();
  const say = (text, hush) => { tell.push(text); if (hush) quiet.push(text); };
  const kept = (k) => { const [st, kind = ''] = k.split('|'); return unjudged.has(st) || (unjudged.has(`${st}|honesty`) && kind.startsWith('honesty')); };
  for (const p of now) {
    if (p.hiccup && !open[p.key] && !waiting[p.key]) { nextWaiting[p.key] = nowMs; continue; }
    seen.add(p.key);
    const was = open[p.key];
    const hush = !!p.quiet;
    if (!was) { open[p.key] = { since: nowMs, told: nowMs, text: p.text, label: p.label, ...(hush ? { quiet: true } : {}) }; say(p.text, hush); }
    else if (nowMs - was.told >= REMIND_H * 3600_000) { open[p.key] = { ...was, told: nowMs, text: p.text }; say(`Still open since ${ct(was.since)} CT: ${p.text}`, hush); }
    else open[p.key] = { ...was, text: p.text };
  }
  for (const [k, v] of Object.entries(open)) {
    if (seen.has(k) || kept(k)) continue;
    delete open[k];
    say(`Cleared: ${v.label || v.text}`, true);
  }
  for (const [k, v] of Object.entries(waiting)) if (!(k in nextWaiting) && !open[k] && kept(k)) nextWaiting[k] = v;
  return { tell, quiet, state: { open, waiting: nextWaiting, last_run: new Date(nowMs).toISOString() } };
}

/* The run's messages by the command each goes through: [[command, lines]], the quiet ones first. With no quiet command
   (VG_WATCH_NOTIFY_QUIET unset: any Mac but the Air's, or before its config gains the line) every line goes through
   the one command, in one message, as before. */
export function sends(tell, quiet, cmd, quietCmd) {
  if (!quietCmd) return tell.length ? [[cmd, tell]] : [];
  const hush = new Set(quiet);
  const later = tell.filter((t) => hush.has(t));
  const now = tell.filter((t) => !hush.has(t));
  return [...(later.length ? [[quietCmd, later]] : []), ...(now.length ? [[cmd, now]] : [])];
}

/* The message for the notify command, cut to fit with a count of what was left out. */
export function message(tell) {
  let msg = 'Results watch: ';
  let i = 0;
  for (; i < tell.length; i++) {
    const add = `${i ? '\n' : ''}${tell[i]}`;
    if (msg.length + add.length > MAX_MSG - 80) break; // room for the "(and N more…)" line
    msg += add;
  }
  if (i < tell.length) msg += `\n(and ${tell.length - i} more; ~/.vg-results-watch/state.json has them all)`;
  return msg;
}

async function getFile(st) {
  const once = async () => {
    const r = await fetch(`${BASE}/${st}.json?watch=${Date.now()}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) });
    return { status: r.status, body: r.status === 200 ? await r.text() : null };
  };
  let r;
  try { r = await once(); } catch (e) { r = { status: 0, error: String(e?.message || e) }; }
  if (r.status === 0 || r.status >= 500) {
    await new Promise((ok) => setTimeout(ok, 15_000));
    try { r = await once(); } catch (e) { r = { status: 0, error: String(e?.message || e) }; }
  }
  return r;
}

const honesty = (st) => new Promise((ok) => {
  execFile(process.execPath, [path.join(HERE, 'honesty.mjs'), st], { timeout: HONESTY_MS, encoding: 'utf8' }, (err, stdout, stderr) => ok({ code: err ? (err.code ?? 1) : 0, out: `${stdout || ''}${stderr || ''}`, killed: !!err?.killed }));
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
  const had = new Set(prev?.seen_states || []);
  const nowMs = Date.now();
  const problems = [];
  const checked = [];
  const unjudged = new Set();
  const skipped = [];
  for (const st of runOrder(states, prev)) {
    // Out of time (a slow connection, a very busy Mac): leave the rest as they were for the next run, rather than hold
    // up every run after this one (launchd starts no new run while one is going; Nov 11, 7 hours unwatched).
    if (Date.now() - nowMs > START_BY_MS) { unjudged.add(st); skipped.push(st); continue; }
    const r = await getFile(st);
    if (r.status === 404) {
      if (had.has(st)) { unjudged.add(st); problems.push({ key: `${st}|gone`, hiccup: true, text: `${nm(st)}'s results file is gone (HTTP 404), though it was there before.`, label: `${nm(st)}'s results file is back.` }); }
      continue;
    }
    if (r.status !== 200) { unjudged.add(st); problems.push({ key: `${st}|unreachable`, hiccup: true, text: `${nm(st)}'s results file didn't load (${r.error || `HTTP ${r.status}`}).`, label: `${nm(st)}'s results file loads again.` }); continue; }
    let file;
    try { file = JSON.parse(r.body); } catch { unjudged.add(st); problems.push({ key: `${st}|not-json`, hiccup: true, text: `${nm(st)}'s results file isn't readable data.`, label: `${nm(st)}'s results file reads again.` }); continue; }
    checked.push(st);
    problems.push(...judgeFile(st, file, nowMs));
    if (Date.now() - nowMs > HONESTY_BY_MS) { unjudged.add(`${st}|honesty`); skipped.push(st); continue; }
    const h = await honesty(st);
    const found = h.killed ? null : honestyProblems(st, h.out);
    if (h.killed || (h.code !== 0 && !found)) {
      unjudged.add(st);
      const why = h.killed ? 'it didn\'t finish in 90 seconds' : ((h.out.split('\n').find((l) => /Error/.test(l)) || h.out.trim().split('\n').pop() || `exit ${h.code}`).trim().slice(0, 200));
      // This Mac's own trouble (a busy Air, a node error), not the Worker's: quiet (diff).
      problems.push({ key: `${st}|honesty-ran`, hiccup: true, quiet: true, text: `The honesty check on ${nm(st)}'s file couldn't run: ${why}`, label: `The honesty check on ${nm(st)}'s file runs again.` });
    } else if (found) problems.push(...found);
  }
  const { tell, quiet, state } = diff(prev, problems, nowMs, unjudged);
  state.checked = checked;
  if (skipped.length) state.skipped = skipped;
  state.seen_states = [...new Set([...had, ...checked])];
  const save = () => { fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 1)); fs.renameSync(`${statePath}.tmp`, statePath); };
  console.log(`${new Date(nowMs).toISOString()} checked ${checked.join(' ') || 'nothing'}; open ${Object.keys(state.open).length}; told ${tell.length}${skipped.length ? `; out of time before ${skipped.join(' ')}` : ''}`);
  if (!tell.length) return save();
  const cmd = process.env.VG_WATCH_NOTIFY;
  if (dry || !cmd) { console.log(message(tell)); return save(); }
  // The quiet message goes first: if the one that reaches him then fails, the next run tells both again, so at worst a
  // quiet line is kept twice for his brief, never a buzz sent twice or lost. Both sends share the notify step's one
  // budget, which the run keeps for it (HONESTY_BY_MS), so the step ends, state saved, inside the 9-minute stop.
  const notifyBy = Date.now() + NOTIFY_MS;
  for (const [command, lines] of sends(tell, quiet, cmd, process.env.VG_WATCH_NOTIFY_QUIET)) {
    const msg = message(lines);
    const timeout = sendTimeout(notifyBy, Date.now());
    if (timeout === null) { console.log(`notify out of time: told on the next run\n${msg}`); process.exitCode = 2; return; }
    const r = spawnSync('/bin/sh', ['-c', command], { input: msg, encoding: 'utf8', timeout });
    // 75 is gabby-notify's "queued in the outbox": delivered as far as we're concerned (retrying would post twice). Any
    // other failure isn't marked told: the state stays as it was, so the next run tells it again.
    if (r.status !== 0 && r.status !== 75) { console.log(`notify failed (${r.status}): ${(r.stderr || '').trim().slice(0, 300)}\n${msg}`); process.exitCode = 2; return; }
  }
  save();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
