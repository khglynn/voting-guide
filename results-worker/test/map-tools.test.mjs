/* The map-making tools (review of Nov 13): the option parser, and map-assemble's two halves of a county map, its own
   pairs and its county slices of statewide races, which never undo each other. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { flags } from '../bin/lib.mjs';
import { assemble } from '../bin/map-assemble.mjs';

test('flags: a switch never eats the next word, wherever it sits', () => {
  assert.deepEqual(flags(['--preview', 'CA']), { _: ['CA'], preview: true });
  assert.deepEqual(flags(['CA', '--preview']), { _: ['CA'], preview: true });
  assert.deepEqual(flags(['--kv', '--preview', 'CA']), { _: ['CA'], kv: true, preview: true });
  assert.deepEqual(flags(['phl', '--draft', 'd.json']), { _: ['phl'], draft: 'd.json' });
});

test('flags: with the list of options a script takes, anything else stops the run', () => {
  const known = ['statewide', 'replace', 'draft', 'judge'];
  assert.throws(() => flags(['phl', '--add'], known), /unknown option --add; this takes --statewide, --replace, --draft, --judge/);
  assert.deepEqual(flags(['phl', '--statewide'], known), { _: ['phl'], statewide: true });
  assert.deepEqual(flags(['phl', '--add']), { _: ['phl'], add: true }, 'without the list, as before');
});

const GOV = { 'JOSH SHAPIRO': 'Josh Shapiro', 'STACY GARRITY': 'Stacy Garrity' };
const swSlice = { feed_id: 'G', feed_name: 'Governor', item: 'pa-governor', kind: 'plurality', seats: 1, choices: GOV, reaches: ['Philadelphia', 'other counties'], item_url: null, statewide: true };
// A hand edit made after the first assembly (the Texas and Georgia runoffs' marks), which a rebuild from the old draft loses.
const ownPair = { feed_id: 'H', feed_name: 'House 1', item: 'phl-house', kind: 'rule_unknown', checked_kind: 'plurality', rule_note: 'a runoff if no one passes 50%', seats: 1, choices: { ANN: 'Ann' }, reaches: ['Philadelphia'], item_url: null };
const made = { id: 'phl', state: 'PA', county: 'Philadelphia', guide: { places: ['philadelphia-pa', 'state-PA'] }, contests: [ownPair, swSlice], statewide_unmatched: ['pa-lt-gov'], unmatched_guide: [], unmatched_feed: [] };
const skeleton = { id: 'phl', state: 'PA', county: 'Philadelphia', guide: { places: ['philadelphia-pa'] }, contests: [] };
const ownDraft = {
  contests: [{ feed_id: 'H', feed_name: 'House 1', item: 'phl-house', kind: 'plurality', seats: 1, choices: { ANN: 'Ann' }, reaches: ['Philadelphia'] }],
  unmatched_guide: [], unmatched_feed: [{ feed_id: 'G', feed_name: 'Governor', why: 'no guide item' }, { feed_id: 'X', feed_name: 'Ward leader', why: 'no guide item' }], not_this_county: [],
};
const ownJudge = { verdicts: [{ feed_id: 'H', item: 'phl-house', agree: true }] };
const swDraft = { contests: [{ feed_id: 'G', feed_name: 'Governor', item: 'pa-governor', kind: 'plurality', seats: 1, choices: GOV, whole: true, reaches: ['Pennsylvania'] }], unmatched_guide: ['pa-lt-gov'] };
const swJudge = { verdicts: [{ feed_id: 'G', item: 'pa-governor', agree: true, reaches: ['Pennsylvania'] }] };

test('map-assemble: a first assembly makes the map\'s own pairs', () => {
  const { map } = assemble(skeleton, ownDraft, ownJudge);
  assert.deepEqual(map.contests.map((c) => c.item), ['phl-house']);
  assert.deepEqual(map.unmatched_feed.map((u) => u.feed_id), ['G', 'X']);
});

test('map-assemble: a plain run on a made map is refused, so an old draft never undoes its hand edits or its statewide slices', () => {
  assert.throws(() => assemble(made, ownDraft, ownJudge), /phl already has 1 pairs of its own; --replace rebuilds them/);
});

test('map-assemble --replace rebuilds the map\'s own pairs and keeps its statewide slices exactly', () => {
  const { map } = assemble(made, ownDraft, ownJudge, { replace: true });
  assert.deepEqual(map.contests.find((c) => c.statewide), swSlice);
  assert.equal(map.contests.find((c) => c.item === 'phl-house').kind, 'plurality', 'the own pair is rebuilt from the draft');
  assert.deepEqual(map.statewide_unmatched, ['pa-lt-gov']);
  assert.deepEqual(map.guide.places, ['philadelphia-pa', 'state-PA']);
  assert.deepEqual(map.unmatched_feed.map((u) => u.feed_id), ['X'], 'the governor\'s feed contest is held by its slice, not unmatched');
  assert.deepEqual(made.contests, [ownPair, swSlice], 'the map passed in is untouched');
});

test('map-assemble --statewide adds county slices beside the own pairs, never whole, and leaves the own pairs exactly', () => {
  const start = { ...made, contests: [ownPair], statewide_unmatched: undefined, guide: { places: ['philadelphia-pa'] }, unmatched_feed: ownDraft.unmatched_feed };
  const { map } = assemble(start, swDraft, swJudge, { statewide: true });
  assert.deepEqual(map.contests.find((c) => c.item === 'phl-house'), ownPair);
  const g = map.contests.find((c) => c.item === 'pa-governor');
  assert.equal(g.statewide, true);
  assert.equal(g.whole, undefined, 'the draft\'s whole is dropped');
  assert.deepEqual(g.reaches, ['Philadelphia', 'other counties'], 'the judge\'s "Pennsylvania" is never a reach');
  assert.deepEqual(map.guide.places, ['philadelphia-pa', 'state-PA']);
  assert.deepEqual(map.statewide_unmatched, ['pa-lt-gov']);
  assert.deepEqual(map.unmatched_feed.map((u) => u.feed_id), ['X'], 'the governor\'s feed contest is held by its new slice');
  assert.throws(() => assemble(made, swDraft, swJudge, { statewide: true, replace: true }), /--replace is for the map's own pairs/);
});

test('map-assemble: neither half takes an item or feed contest the other half holds', () => {
  const clashOwn = { ...ownDraft, contests: [...ownDraft.contests, { feed_id: 'G', feed_name: 'Governor', item: 'pa-governor', kind: 'plurality', seats: 1, choices: GOV, reaches: ['Philadelphia'] }] };
  const judge = { verdicts: [...ownJudge.verdicts, { feed_id: 'G', item: 'pa-governor', agree: true }] };
  assert.throws(() => assemble(made, clashOwn, judge, { replace: true }), /already mapped: pa-governor <- G/);
  const clashSw = { contests: [{ ...swDraft.contests[0], feed_id: 'H' }] };
  assert.throws(() => assemble(made, clashSw, { verdicts: [{ feed_id: 'H', item: 'pa-governor', agree: true }] }, { statewide: true }), /already mapped: pa-governor <- H/);
});
