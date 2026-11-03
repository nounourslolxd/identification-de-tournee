import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrastStretch, inkMask, findTextBlock } from '../src/js/ocr.js';

const W = 120, H = 90;
/** Image claire (230) ; `lines` bandes de texte simulées (traits sombres alternés) dans le rectangle donné. */
function page({ x0, y0, x1, y1, lines = 3, noise = false }) {
  const g = new Float32Array(W * H).fill(230);
  const lh = (y1 - y0) / lines;
  for (let l = 0; l < lines; l++) {
    const ya = Math.round(y0 + l * lh + lh * 0.1), yb = Math.round(y0 + l * lh + lh * 0.85); // interligne réaliste (~1-2 % de la hauteur)
    for (let y = ya; y < yb; y++) for (let x = x0; x < x1; x++) if ((x >> 1) % 3 !== 0) g[y * W + x] = 30;
  }
  if (noise) for (let i = 0; i < 40; i++) g[(i * 37) % (W * H)] = 20; // poussière
  return g;
}

test('contrastStretch : étale une image terne sur 0–255', () => {
  const g = new Float32Array(1000);
  for (let i = 0; i < g.length; i++) g[i] = 100 + (i % 50); // 100–149
  const s = contrastStretch(g);
  assert.ok(Math.min(...s) <= 5 && Math.max(...s) >= 250);
});
test('contrastStretch : image uniforme ne produit pas NaN', () => {
  const s = contrastStretch(new Float32Array(100).fill(80));
  assert.ok([...s].every(v => Number.isFinite(v)));
});
test('inkMask : repère les pixels sombres, pas le fond', () => {
  const g = page({ x0: 30, y0: 30, x1: 90, y1: 60 });
  const m = inkMask(g, W, H);
  assert.equal(m[5 * W + 5], 0);
  assert.ok(m.reduce((a, b) => a + b, 0) > 300);
});
test('findTextBlock : retrouve un bloc d’adresse au milieu', () => {
  const g = page({ x0: 40, y0: 35, x1: 100, y1: 65, lines: 3 });
  const b = findTextBlock(inkMask(g, W, H), W, H);
  assert.ok(b, 'bloc trouvé');
  assert.ok(b.x * W <= 40 && (b.x + b.w) * W >= 100, `horizontal ${b.x * W}-${(b.x + b.w) * W}`);
  assert.ok(b.y * H <= 35 && (b.y + b.h) * H >= 65, `vertical ${b.y * H}-${(b.y + b.h) * H}`);
  assert.ok(b.w < 0.75, 'recadre bien (ne prend pas toute l’image)');
});
test('findTextBlock : préfère le gros bloc central à un petit bloc dans un coin', () => {
  const g = page({ x0: 40, y0: 35, x1: 105, y1: 65, lines: 3 });
  for (let y = 4; y < 8; y++) for (let x = 5; x < 30; x++) if ((x >> 1) % 3 !== 0) g[y * W + x] = 30; // expéditeur
  const b = findTextBlock(inkMask(g, W, H), W, H);
  assert.ok(b.y * H > 15, 'ne retient pas la ligne du coin');
});
test('findTextBlock : page vide → null', () => {
  assert.equal(findTextBlock(inkMask(new Float32Array(W * H).fill(230), W, H), W, H), null);
});
