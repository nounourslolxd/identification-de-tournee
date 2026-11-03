import { test } from 'node:test';
import assert from 'node:assert/strict';
import { state, setRanges, setPending, effectiveRanges, isAdmin, canDelete } from '../src/js/store.js';
import * as backend from '../src/js/backend.js';
import { parseTable, match, parseAddr } from '../src/js/match.js';

test('mode local : démo chargée, administrateur par défaut', () => {
  assert.equal(state.role, 'local');
  assert.ok(isAdmin());
  assert.equal(state.ranges.length, 3);
});

test('mode local : saveTable remplace le tableau mais garde les plages apprises', async () => {
  await backend.addLearned({ cp: '5500', city: 'Dinant', street: 'rue neuve', from_n: 3, to_n: 3, tournee: '8' });
  await backend.saveTable(parseTable('5000 rue a de 1 a 9 -- tournée 4'), [{ cp: '5000', city: 'Namur' }]);
  assert.equal(state.ranges.filter(r => r.source === 'table').length, 1);
  assert.equal(state.ranges.filter(r => r.source === 'learned').length, 1);
  assert.deepEqual(state.localities, [{ cp: '5000', city: 'Namur' }]);
});

test('mode local : pas de doublon exact pour une plage apprise', async () => {
  const r = { cp: '5500', city: 'Dinant', street: 'rue neuve', from_n: 3, to_n: 3, tournee: '8' };
  await backend.addLearned(r);
  await backend.addLearned(r);
  assert.equal(state.ranges.filter(x => x.source === 'learned').length, 1);
});

test('mode local : la plage apprise est utilisée par la correspondance', () => {
  const r = match(parseAddr('3 rue neuve 5500 Dinant'), effectiveRanges());
  assert.equal(r.e.tournee, '8');
});

test('deleteRange (local)', async () => {
  const l = state.ranges.find(r => r.source === 'learned');
  await backend.deleteRange(l);
  assert.equal(state.ranges.filter(r => r.source === 'learned').length, 0);
});

test('effectiveRanges inclut les ajouts en attente d’envoi', () => {
  setRanges([]);
  setPending([{ cid: 'c1', op: 'add', range: { cp: '5500', street: 'rue p', from_n: 1, to_n: 1, tournee: '2' } }]);
  const e = effectiveRanges();
  assert.equal(e.length, 1);
  assert.equal(e[0].source, 'learned');
  assert.ok(e[0].pending);
  assert.ok(canDelete(e[0]));
  setPending([]);
});
