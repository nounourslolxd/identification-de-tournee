import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cer, parseTruth, scoreLetter, summarize } from '../src/js/metrics.js';
import { parseTable } from '../src/js/match.js';

const ranges = parseTable("5500 rue de l'oublie de 1 a 5 -- tournée 1");
test('cer', () => { assert.equal(cer('abc', 'abc'), 0); assert.equal(cer('abd', 'abc'), 1 / 3); assert.equal(cer('', ''), 0); assert.equal(cer('x', ''), 1); });
test('parseTruth', () => assert.deepEqual(parseTruth("5;rue de l'oublie;5500;Dinant;1\n\n;rue x;5000;Namur;2"), [
  { num: 5, street: "rue de l'oublie", cp: '5500', city: 'Dinant', tournee: '1' },
  { num: null, street: 'rue x', cp: '5000', city: 'Namur', tournee: '2' }]));
test('scoreLetter : lecture parfaite', () => {
  const s = scoreLetter("5 rue de l'oublie 5500 Dinant", parseTruth("5;rue de l'oublie;5500;Dinant;1")[0], ranges);
  assert.ok(Object.values(s.ok).every(Boolean));
});
test('scoreLetter : faute sur la rue détectée, tournée quand même trouvée', () => {
  const s = scoreLetter("5 rue de l'oubliee 5500 Dinant", parseTruth("5;rue de l'oublie;5500;Dinant;1")[0], ranges);
  assert.equal(s.ok.street, false); assert.equal(s.ok.tournee, true); assert.ok(s.cerStreet > 0);
});
test('summarize', () => {
  const t = parseTruth("5;rue de l'oublie;5500;Dinant;1")[0];
  const s = summarize([scoreLetter("5 rue de l'oublie 5500 Dinant", t, ranges), scoreLetter('illisible', t, ranges)]);
  assert.equal(s.n, 2); assert.equal(s.tournee, 0.5);
});
