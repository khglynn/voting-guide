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
   has it); without one the message is printed. A message that fails to send is told again on the next run.
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

/* What to tell, from the last run's state and this run's problems. `unjudged` states keep their open problems as they
   were; hiccups wait for a second run in a row. Returns the messages and the state to keep. */
export function diff(prev, now, nowMs, unjudged = new Set()) {
  const open = { ...(prev?.open || {}) };
  const waiting = prev?.waiting || {};
  const nextWaiting = {};
  const tell = [];
  const seen = new Set();
  for (const p of now) {
    if (p.hiccup && !open[p.key] && !waiting[p.key]) { nextWaiting[p.key] = nowMs; continue; }
    seen.add(p.key);
    const was = open[p.key];
    if (!was) { open[p.key] = { since: nowMs, told: nowMs, text: p.text, label: p.label }; tell.push(p.text); }
    else if (nowMs - was.told >= REMIND_H * 3600_000) { open[p.key] = { ...was, told: nowMs, text: p.text }; tell.push(`Still open since ${ct(was.since)} CT: ${p.text}`); }
    else open[p.key] = { ...was, text: p.text };
  }
  for (const [k, v] of Object.entries(open)) {
    if (seen.has(k) || unjudged.has(k.split('|')[0])) continue;
    delete open[k];
    tell.push(`Cleared: ${v.label || v.text}`);
  }
  return { tell, state: { open, waiting: nextWaiting, last_run: new Date(nowMs).toISOString() } };
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
  const had = new Set(prev?.seen_states || []);
  const nowMs = Date.now();
  const problems = [];
  const checked = [];
  const unjudged = new Set();
  for (const st of states) {
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
    const h = await honesty(st);
    const found = h.killed ? null : honestyProblems(st, h.out);
    if (h.killed || (h.code !== 0 && !found)) {
      unjudged.add(st);
      const why = h.killed ? 'it didn\'t finish in 90 seconds' : ((h.out.split('\n').find((l) => /Error/.test(l)) || h.out.trim().split('\n').pop() || `exit ${h.code}`).trim().slice(0, 200));
      problems.push({ key: `${st}|honesty-ran`, hiccup: true, text: `The honesty check on ${nm(st)}'s file couldn't run: ${why}`, label: `The honesty check on ${nm(st)}'s file runs again.` });
    } else if (found) problems.push(...found);
  }
  const { tell, state } = diff(prev, problems, nowMs, unjudged);
  state.checked = checked;
  state.seen_states = [...new Set([...had, ...checked])];
  const save = () => { fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 1)); fs.renameSync(`${statePath}.tmp`, statePath); };
  console.log(`${new Date(nowMs).toISOString()} checked ${checked.join(' ') || 'nothing'}; open ${Object.keys(state.open).length}; told ${tell.length}`);
  if (!tell.length) return save();
  const msg = message(tell);
  const cmd = process.env.VG_WATCH_NOTIFY;
  if (dry || !cmd) { console.log(msg); return save(); }
  const r = spawnSync('/bin/sh', ['-c', cmd], { input: msg, encoding: 'utf8', timeout: 60_000 });
  // 75 is gabby-notify's "queued in the outbox": delivered as far as we're concerned (retrying would post twice). Any
  // other failure isn't marked told: the state stays as it was, so the next run tells it again.
  if (r.status !== 0 && r.status !== 75) { console.log(`notify failed (${r.status}): ${(r.stderr || '').trim().slice(0, 300)}\n${msg}`); process.exitCode = 2; return; }
  save();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
