import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGray, sharpness, frameDiff, createTracker, SHARP, MOVE, REARM, STABLE_TICKS } from '../src/js/scanner.js';

const w = 64, h = 48;
const flat = v => new Float32Array(w * h).fill(v);
const checker = (cell = 1) => {
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = ((x / cell | 0) + (y / cell | 0)) % 2 ? 255 : 0;
  return g;
};
const blur = g => {
  const o = new Float32Array(g.length);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    o[i] = (g[i] + g[i - 1] + g[i + 1] + g[i - w] + g[i + w]) / 5;
  }
  return o;
};

test('toGray : pondération, blanc et noir', () => {
  const g = toGray(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]), 2, 1);
  assert.ok(Math.abs(g[0] - 254.9) < 0.5);
  assert.equal(g[1], 0);
});
test('sharpness : image uniforme = 0', () => assert.equal(sharpness(flat(128), w, h), 0));
test('sharpness : une image nette dépasse le seuil, la même floutée est plus basse', () => {
  const net = sharpness(checker(2), w, h), flou = sharpness(blur(blur(checker(2))), w, h);
  assert.ok(net > SHARP, `net=${net}`);
  assert.ok(flou < net);
});
test('frameDiff : identique = 0, décalage de 20 niveaux ≈ 20, tailles différentes = 0', () => {
  assert.equal(frameDiff(flat(10), flat(10)), 0);
  assert.ok(Math.abs(frameDiff(flat(10), flat(30)) - 20) < 1e-9);
  assert.equal(frameDiff(flat(1), new Float32Array(5)), 0);
  assert.equal(frameDiff(null, flat(1)), 0);
});

test('tracker : capture après N images nettes et stables consécutives', () => {
  const t = createTracker(), ok = { sharp: SHARP + 10, move: 0, fromRef: 0 };
  for (let i = 1; i < STABLE_TICKS; i++) assert.equal(t.step(ok).action, null);
  assert.equal(t.step(ok).action, 'capture');
});
test('tracker : une image floue ou qui bouge remet le compteur à zéro', () => {
  const t = createTracker(), ok = { sharp: SHARP + 10, move: 0, fromRef: 0 };
  for (let i = 1; i < STABLE_TICKS; i++) t.step(ok);
  assert.equal(t.step({ sharp: SHARP - 1, move: 0, fromRef: 0 }).status, 'Image floue');
  for (let i = 1; i < STABLE_TICKS; i++) t.step(ok);
  assert.equal(t.step({ sharp: SHARP + 10, move: MOVE, fromRef: 0 }).status, 'Ne bougez pas');
  for (let i = 1; i < STABLE_TICKS; i++) t.step(ok);
  assert.equal(t.step(ok).action, 'capture');
});
test('tracker : verrouillé après capture, réarmé quand l’image s’écarte de la référence', () => {
  const t = createTracker(), ok = { sharp: SHARP + 10, move: 0, fromRef: 0 };
  t.lock();
  for (let i = 0; i < 10; i++) assert.equal(t.step(ok).action, null);           // même lettre : pas de relecture
  assert.equal(t.step({ ...ok, fromRef: REARM - 1 }).action, null);            // petit tremblement : toujours verrouillé
  assert.ok(t.locked);
  assert.equal(t.step({ ...ok, fromRef: REARM + 1 }).status, 'Nouvelle lettre…'); // lettre retirée
  assert.ok(!t.locked);
  for (let i = 1; i < STABLE_TICKS; i++) t.step(ok);
  assert.equal(t.step(ok).action, 'capture');                                    // lettre suivante lue
});
