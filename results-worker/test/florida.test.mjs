/* Florida, from real reads on Nov 3, 2026:
   - fl-dos.ElecResultsFL.txt: the state's tab-delimited file read at 10:18 PM CT with the Downloads page's ?v= key
     (Last-Modified Wed, 04 Nov 2026 04:18:03 GMT), trimmed to 13 races, every county row kept so the sums are the state's.
   - fl-dos.ElecResultsFL-nov2-zeros.txt: the same address read without a key a minute earlier: Azure Front Door's
     Nov 2 copy (Last-Modified Mon, 02 Nov 2026 14:33:03 GMT, all zeros), trimmed to the U.S. Senate.
   - vr-escambia.Summary.html: https://enr.electionsfl.org/ESC/3977/Summary/ read at 10:20 PM CT (Last-Modified
     02:23:19 GMT), with inline images, scripts and indentation stripped. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, fixture, mapFor } from './helpers.mjs';
import * as fl_dos from '../src/adapters/fl_dos.js';
import * as vr_enr from '../src/adapters/vr_enr.js';
import { ADAPTERS } from '../src/adapters/index.js';
import { NAMED_UA } from '../src/fetch.js';
import { checkRead, checkFile } from '../src/checks.js';
import { sourceSlices, buildStateFile } from '../src/merge.js';

const FL_LM = 'Wed, 04 Nov 2026 04:18:03 GMT';
const ESC_LM = 'Wed, 04 Nov 2026 02:23:19 GMT';
const flRoutes = (body = fixture('fl-dos.ElecResultsFL.txt'), lm = FL_LM) => ({
  '20261103_ElecResultsFL.txt': (url, opts) => (opts.headers?.['If-Modified-Since'] === lm ? { status: 304, headers: { 'Last-Modified': lm } } : { status: 200, body, headers: { 'Last-Modified': lm } }),
});
const escRoutes = (body = fixture('vr-escambia.Summary.html')) => ({
  '/ESC/3977/Summary/': (url, opts) => (opts.headers?.['If-Modified-Since'] === ESC_LM ? { status: 304, headers: { 'Last-Modified': ESC_LM } } : { status: 200, body, headers: { 'Last-Modified': ESC_LM } }),
});

test('adapters index: fl_dos and vr_enr are registered by the names the maps use', () => {
  assert.equal(ADAPTERS[mapFor('results-FL').feed.adapter], fl_dos);
  assert.equal(ADAPTERS[mapFor('escambia-fl').feed.adapter], vr_enr);
});

test('fl_dos: the state file reads as Nov 3 with the state\'s own totals, progress words and file time', async () => {
  const f = fakeFetch(flRoutes());
  const now = Date.parse('2026-11-04T04:19:30Z');
  const r = await fl_dos.read({ fetch: f, map: mapFor('results-FL'), now });
  assert.equal(r.verdict, 'ok');
  assert.deepEqual(r.election, { id: '11/03/2026', name: null, date: '2026-11-03' });
  assert.equal(r.source_updated, '2026-11-04T04:18:03.000Z', 'the file\'s Last-Modified is the source\'s own time');
  assert.equal(r.changed_token, FL_LM);
  assert.equal(r.official, false);
  assert.equal(r.source_status, null);
  assert.equal(r.contests.length, 13);
  // Every read carries the minute as its ?v= key (the office's Downloads page links the file the same way), and names us.
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /20261103_ElecResultsFL\.txt\?v=29896099$/);
  assert.equal(f.calls[0].headers['User-Agent'], NAMED_UA);

  const senate = r.contests.find((c) => c.feed_id === 'United States Senator');
  assert.equal(senate.category, 'USS');
  assert.deepEqual(senate.choices.map((c) => [c.name, c.votes]), [['Ashley Moody', 4199328], ['Angie Nixon', 3955594], ['Neil J. Gillespie', 94223]]);
  assert.equal(senate.total, 8249145);
  assert.equal(senate.reporting, '5567 of 5626 precincts reporting');
  assert.equal(senate.counties.length, 67);

  // Governor tickets are surnames only in the state's own file; never reshaped into guide names here.
  const gov = r.contests.find((c) => c.feed_id === 'Governor and Lieutenant Governor');
  assert.deepEqual(gov.choices.slice(0, 2).map((c) => [c.name, c.votes]), [['Donalds / Avila', 4123875], ['Jolly / Graham', 4011045]]);
  assert.deepEqual(gov.choices.slice(-2).map((c) => [c.name, c.party, c.votes]), [['Anderson / Nokovich', 'WRI', 0], ['Morris / Alaways', 'WRI', 0]]);

  const amd1 = r.contests.find((c) => c.feed_id === 'Budget Stabilization Fund');
  assert.deepEqual(amd1.choices.map((c) => [c.name, c.votes]), [['Yes for Approval', 3162674], ['No for Rejection', 4567965]]);
  const amd3 = r.contests.find((c) => c.category === 'AMD' && /^Increased Homestead/.test(c.feed_id));
  assert.equal(amd3.feed_id, 'Increased Homestead Exemption; Lower Cap On Increases In Non-Homestead Property Assessments', 'the file\'s leading space is trimmed');

  const muniz = r.contests.find((c) => c.feed_id === 'Shall Justice Carlos G. Muñiz be retained in Office?');
  assert.deepEqual(muniz.choices.map((c) => c.name), ['Yes', 'No']);
  // A district race's progress covers only the counties that vote in it.
  assert.equal(r.contests.find((c) => c.feed_id === 'State Representative, District 2').reporting, '55 of 55 precincts reporting');
  assert.deepEqual(r.contests.find((c) => c.feed_id === 'Representative in Congress, District 1').counties, ['Escambia', 'Okaloosa', 'Santa Rosa', 'Walton']);
  assert.equal(r.contests.find((c) => c.feed_id === 'Shall Judge Joseph Lewis Jr. be retained in Office?').reporting, '693 of 695 precincts reporting');

  assert.equal(checkRead(r, mapFor('results-FL')).ok, true);
});

test('fl_dos: an unchanged file is one conditional request answered 304', async () => {
  const f = fakeFetch(flRoutes());
  const r = await fl_dos.read({ fetch: f, map: mapFor('results-FL'), prevToken: FL_LM });
  assert.deepEqual(r, { verdict: 'ok', unchanged: true, changed_token: FL_LM });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].headers['If-Modified-Since'], FL_LM);
});

test('fl_dos: the Nov 2 template (all zeros) reads as the right election with nothing posted', async () => {
  const r = await fl_dos.read({ fetch: fakeFetch(flRoutes(fixture('fl-dos.ElecResultsFL-nov2-zeros.txt'), 'Mon, 02 Nov 2026 14:33:03 GMT')), map: mapFor('results-FL') });
  assert.equal(r.verdict, 'ok');
  assert.equal(r.source_updated, '2026-11-02T14:33:03.000Z');
  const senate = r.contests[0];
  assert.ok(senate.choices.every((c) => c.votes === 0));
  assert.equal(senate.reporting, '0 of 5626 precincts reporting');
});

test('fl_dos: refusals, an HTML page, a garbled header, a dash for a count, and two election dates', async () => {
  const map = mapFor('results-FL');
  const one = (spec) => fakeFetch({ '20261103_ElecResultsFL.txt': spec });
  assert.equal((await fl_dos.read({ fetch: one({ status: 403, body: 'no' }), map })).verdict, 'refused');
  assert.equal((await fl_dos.read({ fetch: one({ status: 200, body: '<!DOCTYPE html><html>Just a moment...</html>' }), map })).verdict, 'refused');
  assert.equal((await fl_dos.read({ fetch: one({ status: 200, body: 'a\tb\n1\t2\n' }), map })).verdict, 'error');
  const lines = fixture('fl-dos.ElecResultsFL.txt').split('\n');
  const dashed = [lines[0], lines[1].replace(/\t\d+$/, '\t-'), ...lines.slice(2)].join('\n');
  const r = await fl_dos.read({ fetch: one({ status: 200, body: dashed }), map });
  assert.equal(r.verdict, 'ok');
  const c = checkRead(r, map);
  assert.equal(c.ok, false, 'a count that is not a number never becomes zero');
  assert.ok(c.problems.some((p) => p.reason === 'bad numbers'));
  const twoDates = [lines[0], lines[1], lines[2].replace(/^11\/03\/2026/, '08/18/2026'), ...lines.slice(3)].join('\n');
  assert.equal((await fl_dos.read({ fetch: one({ status: 200, body: twoDates }), map })).verdict, 'error');
  const wrong = lines.map((l, i) => (i ? l.replace(/^11\/03\/2026/, '08/18/2026') : l)).join('\n');
  const w = await fl_dos.read({ fetch: one({ status: 200, body: wrong }), map });
  assert.equal(checkRead(w, map).sourceBlocked, true, 'the Aug 18 primary\'s file is an election mismatch');
});

test('vr_enr: Escambia reads with its own election, time, progress words and banner', async () => {
  const f = fakeFetch(escRoutes());
  const map = mapFor('escambia-fl');
  const r = await vr_enr.read({ fetch: f, map });
  assert.equal(r.verdict, 'ok');
  assert.deepEqual(r.election, { id: '3977', name: '2026 General Election', date: '2026-11-03' });
  assert.equal(r.source_updated, '2026-11-04T02:22:57.000Z', '"11/03/2026 8:22:57 pm" Central');
  assert.equal(r.reporting, '80 of 80 precincts reporting · Vote By Mail: Partially Reported');
  assert.deepEqual(r.labels, ['Unofficial Results']);
  assert.equal(r.official, false);
  assert.equal(r.source_status, null);
  assert.equal(r.changed_token, `${ESC_LM}|11/03/2026 8:22:57 pm`);
  assert.equal(r.contests.length, 24);
  assert.equal(f.calls[0].headers['User-Agent'], NAMED_UA);

  const council2 = r.contests.find((c) => c.feed_id === '61251');
  assert.equal(council2.feed_name, 'Pensacola City Council District 2');
  assert.deepEqual(council2.choices, [{ name: 'Charles Bare (NON)', votes: 1122 }, { name: 'Sherri Myers (NON)', votes: 1338 }]);
  assert.equal(council2.total, 2460);
  assert.equal(council2.reporting, '2 of 2 precincts reporting · Vote By Mail: Partially Reported', '"2 of 2" never stands alone while mail is still coming in');
  const lost = r.contests.find((c) => c.feed_id === '61256');
  assert.equal(lost.feed_name, 'County Referendum');
  assert.deepEqual(lost.choices, [{ name: 'FOR the one-cent sales tax (NON)', votes: 83682 }, { name: 'AGAINST the one-cent sales tax (NON)', votes: 28001 }]);
  const gov = r.contests.find((c) => c.feed_id === '61235');
  assert.ok(gov.choices.some((c) => c.name === 'NPA Moliere "Moe" Dimanche (NPA)'), 'entities decoded');
  assert.deepEqual(gov.choices.at(-1), { name: 'Write-in: Not Assigned (NON)', votes: 214 });
  assert.equal(r.contests.find((c) => c.feed_id === '61239').reporting, '41 of 41 precincts reporting · Vote By Mail: Partially Reported');
  assert.equal(checkRead(r, map).ok, true);
});

test('vr_enr: 304 is unchanged; refusal, a 404 page and a dashed count are never read as numbers', async () => {
  const map = mapFor('escambia-fl');
  const token = `${ESC_LM}|11/03/2026 8:22:57 pm`;
  const f = fakeFetch(escRoutes());
  assert.deepEqual(await vr_enr.read({ fetch: f, map, prevToken: token }), { verdict: 'ok', unchanged: true, changed_token: token });
  assert.equal(f.calls[0].headers['If-Modified-Since'], ESC_LM);
  const one = (spec) => fakeFetch({ '/ESC/3977/Summary/': spec });
  assert.equal((await vr_enr.read({ fetch: one({ status: 403, body: 'no' }), map })).verdict, 'refused');
  assert.equal((await vr_enr.read({ fetch: one({ status: 200, body: '<html><title>404 Material Not Found</title></html>' }), map })).verdict, 'error');
  const dashed = fixture('vr-escambia.Summary.html').replace('>1,122<', '>-<');
  const r = await vr_enr.read({ fetch: one({ status: 200, body: dashed }), map });
  assert.equal(checkRead(r, map).ok, false);
  // The Aug 18 primary's page (a different id) is an election mismatch.
  const primary = fixture('vr-escambia.Summary.html').replaceAll('/ESC/3977/', '/ESC/3976/').replace('Election Date: 11/3/2026', 'Election Date: 8/18/2026');
  const p = await vr_enr.read({ fetch: one({ status: 200, body: primary }), map });
  assert.equal(checkRead(p, map).sourceBlocked, true);
});

/* A map with a few of tonight's drafted pairs, to show the reads build clean files: counting, no outcome (Florida has
   no complete marker), whole-race counts from the state, county slices from Escambia. The real pairs wait on the judge. */
test('florida: drafted pairs from both sources build clean preview files with no outcome', async () => {
  const now = '2026-11-04T04:30:00.000Z';
  const fl = { ...mapFor('results-FL'), unmatched_guide: [], contests: [
    { feed_id: 'United States Senator', feed_name: 'United States Senator', item: 'fl-us-senate-special', kind: 'plurality', seats: 1, choices: { 'Ashley Moody': 'Ashley Moody', 'Angie Nixon': 'Angie Nixon', 'Neil J. Gillespie': 'Neil J. Gillespie' }, reaches: ['Florida'], whole: true },
    { feed_id: 'Budget Stabilization Fund', feed_name: 'Budget Stabilization Fund', item: 'fl-amendment-1', kind: 'measure', seats: 1, choices: { 'Yes for Approval': 'yes', 'No for Rejection': 'no' }, reaches: ['Florida'], whole: true, pass_threshold: '60% of votes cast on the measure (Florida Constitution, Art. XI, s. 5(e))' },
  ] };
  const esc = { ...mapFor('escambia-fl'), unmatched_guide: [], contests: [
    { feed_id: '61251', feed_name: 'Pensacola City Council District 2', item: 'fl-pensacola-council-2', kind: 'plurality', seats: 1, choices: { 'Charles Bare (NON)': 'Charles Bare', 'Sherri Myers (NON)': 'Sherri Myers' }, reaches: ['Escambia'] },
    { feed_id: '61256', feed_name: 'County Referendum', item: 'fl-escambia-lost', kind: 'measure', seats: 1, choices: { 'FOR the one-cent sales tax (NON)': 'yes', 'AGAINST the one-cent sales tax (NON)': 'no' }, reaches: ['Escambia'], pass_threshold: 'simple majority of Escambia County voters voting on the question' },
  ] };
  const flRead = await fl_dos.read({ fetch: fakeFetch(flRoutes()), map: fl });
  const escRead = await vr_enr.read({ fetch: fakeFetch(escRoutes()), map: esc });
  for (const [read, map] of [[flRead, fl], [escRead, esc]]) {
    const { raw, ...rd } = read;
    const s = sourceSlices(rd, map, now);
    assert.equal(s.status, 'counting');
    assert.deepEqual(s.problems, []);
  }
  const strip = ({ raw, ...rd }) => rd;
  const f = buildStateFile({ state: 'FL', maps: [fl, esc], srcs: {
    'results-FL': { record: { read: strip(flRead), fetched: now }, checked: false, sched: {} },
    'escambia-fl': { record: { read: strip(escRead), fetched: now }, checked: false, sched: {} },
  }, mode: 'preview', now });
  assert.deepEqual(checkFile(f), []);
  for (const it of Object.values(f.items)) { assert.equal(it.status, 'counting'); assert.equal(it.final ?? null, null); }
  assert.equal(f.items['fl-us-senate-special'].reporting, '5567 of 5626 precincts reporting');
  assert.equal(f.items['fl-pensacola-council-2'].reporting, '2 of 2 precincts reporting · Vote By Mail: Partially Reported');
});
