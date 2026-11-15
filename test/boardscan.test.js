// Découpage d'une photo de tableau en colonnes, assemblage des lignes lues, vérification côté serveur.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rulePositions, columnsFromRules, trackRules, fitLine, planTiles, mergeBoardRows, rowLine } from '../src/js/board-scan.js';
import { parseModelRows, resolveRows, fixTournee } from '../server/board.mjs';
import * as boardModule from '../server/board.mjs';
import { createGazetteer } from '../server/gazetteer.mjs';
import { parseTable } from '../src/js/match.js';

/** Tableau de synthèse : `cols` colonnes, traits verticaux penchés (pente `slope`), faux texte entre les traits. */
function board({ w = 1200, h = 1600, cols = 4, colW = 290, slope = 0.02, left = 20 } = {}) {
  const g = new Uint8Array(w * h).fill(215);
  let seed = 3; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let y = 60; y < h - 60; y++) {
    const dx = Math.round(slope * y);
    for (let c = 0; c < cols; c++) {
      for (const off of [0, 30, 56, colW - 6]) {
        const x = left + c * colW + off + dx;
        if (x >= 0 && x + 1 < w) g[y * w + x] = g[y * w + x + 1] = 80;
      }
    }
  }
  // « Texte » : petits traits sombres de 9 px de haut, une ligne tous les 16 px.
  for (let y = 70; y < h - 70; y += 16) for (let x = 0; x < w; x += 3) if (rnd() < 0.3) for (let k = 0; k < 9; k++) if (g[(y + k) * w + x] > 100) g[(y + k) * w + x] = 60;
  return { g, w, h };
}

test('rulePositions : regroupe les pics voisins', () => {
  const h = new Uint16Array(50); h[10] = 30; h[11] = 40; h[30] = 35;
  assert.deepEqual(rulePositions(h, 20), [11, 30]);
});

test('columnsFromRules : trois traits rapprochés puis un grand vide = début de colonne', () => {
  const cols = columnsFromRules([20, 50, 76, 310, 340, 366, 600], 1200);
  assert.deepEqual(cols.map(c => c.x0), [20, 310]);
  assert.equal(cols[0].x1, 310);
  assert.deepEqual(columnsFromRules([20, 50, 400], 1200), []);            // pas de triple
});

test('trackRules : un trait manqué dans une bande est replacé entre ses voisins', () => {
  const out = trackRules([[100], [102], [], [106], [108], [110]], 8, { minLen: 4 });
  assert.deepEqual(out[2], [104]);
  assert.deepEqual(trackRules([[100], [], [], [300]], 8, { minLen: 2 }).flat(), []);   // bruit isolé écarté
});

test('fitLine : droite des moindres carrés', () => {
  const l = fitLine([{ x: 10, y: 0 }, { x: 12, y: 100 }, { x: 14, y: 200 }]);
  assert.ok(Math.abs(l.slope - 0.02) < 1e-9);
  assert.ok(Math.abs(l.at(300) - 16) < 1e-9);
});

test('planTiles : retrouve les colonnes d\'un tableau penché et découpe une colonne par morceau', () => {
  const { g, w, h } = board();
  const { tiles, columns } = planTiles(g, w, h);
  assert.equal(columns, 4);
  assert.ok(tiles.length >= 8);
  for (const t of tiles) assert.ok(t.w > 200 && t.w < 400, `largeur ${t.w}`);            // une seule colonne (290 px)
  const first = tiles.filter(t => t.col === 0);
  assert.ok(first.at(-1).x > first[0].x, 'le découpage suit la pente');
  for (let i = 1; i < first.length; i++) assert.ok(first[i].y < first[i - 1].y + first[i - 1].h, 'recouvrement vertical');
});

test('planTiles : image sans tableau → aucun morceau', () => {
  assert.equal(planTiles(new Uint8Array(400 * 400).fill(200), 400, 400).tiles.length, 0);
});

const row = (cp, tournee, street, segs = [], extra = {}) => ({ cp, tournee, street, segs, note: '', check: false, why: '', ...extra });

test('mergeBoardRows : le recouvrement entre deux morceaux n\'est gardé qu\'une fois', () => {
  const a = [row('5600', '001', 'Rue A'), row('5600', '002', 'Rue B'), row('5620', '003', 'Rue C')];
  const b = [row('5600', '002', 'Rue B'), row('5620', '003', 'Rue C'), row('5680', '004', 'Rue D')];
  const m = mergeBoardRows([{ col: 0, row: 1, rows: b }, { col: 0, row: 0, rows: a }]);
  assert.deepEqual(m.map(r => r.street), ['Rue A', 'Rue B', 'Rue C', 'Rue D']);
  assert.ok(m.every(r => !r.check));
});

test('mergeBoardRows : deux lectures différentes de la même ligne → la plus loin du bord, marquée à vérifier', () => {
  const a = [row('5600', '001', 'Rue A'), row('5600', '002', 'Rue B'), row('5620', '003', 'Rue C'), row('5648', '004', 'Rue D')];   // dernière ligne coupée : mal lue
  const b = [row('5600', '002', 'Rue B'), row('5620', '003', 'Rue C'), row('5640', '004', 'Rue D'), row('5680', '005', 'Rue E')];
  const m = mergeBoardRows([{ col: 0, row: 0, rows: a }, { col: 0, row: 1, rows: b }]);
  assert.equal(m.length, 5);
  const d = m.find(r => r.street === 'Rue D');
  assert.equal(d.cp, '5640');
  assert.ok(d.check);
});

test('mergeBoardRows : même rue dans deux communes (lignes voisines) conservée, colonnes dans l\'ordre', () => {
  const a = [row('5600', '001', "Rue de l'Église"), row('5620', '007', "Rue de l'Église"), row('5680', '011', "Rue de l'Église")];
  const m = mergeBoardRows([{ col: 1, row: 0, rows: [row('5600', '009', 'Rue Z')] }, { col: 0, row: 0, rows: a }]);
  assert.deepEqual(m.map(r => r.cp + r.tournee), ['5600001', '5620007', '5680011', '5600009']);
});

test('rowLine → parseTable : la ligne produite est relue telle quelle', () => {
  const r = row('5620', '009', "Rue d'Anthée", [{ from_n: 2, to_n: 146, parity: 'even' }, { from_n: 1, to_n: 147, parity: 'odd' }], { check: true });
  assert.equal(rowLine(r), "? 5620 009 Rue d'Anthée 2-146 / 1-147");
  const p = parseTable(rowLine(r));
  assert.deepEqual(p.map(x => [x.tournee, x.from_n, x.to_n, x.parity]), [['009', 2, 146, 'even'], ['009', 1, 147, 'odd']]);
});

test('parseModelRows / fixTournee', () => {
  const rows = parseModelRows("Voici les lignes :\n5640;526;11 NOVEMBRE RUE DU\n56O0 ; 0I3 ; ARMES PLACE D'\nA A A\n4/1-17;\n5651;515;AHÉRÉE RUE 1-1");
  assert.deepEqual(rows.map(r => r.tournee), ['526', '0I3', '515']);
  assert.equal(fixTournee('0I3'), '013');
  assert.equal(fixTournee('A13'), '');
});

test('resolveRows : nom officiel, code postal illisible retrouvé, code postal lisible jamais changé', () => {
  const g = createGazetteer();
  g.addLocality('5630', 'Cerfontaine'); g.addLocality('5640', 'Mettet'); g.addLocality('5650', 'Walcourt'); g.addLocality('5651', 'Walcourt');
  g.addStreet({ cp: '5640', street: 'Rue du 11 Novembre', city: 'Mettet', num: 1, src: 'BeST' });
  g.addStreet({ cp: '5651', street: 'Rue Basse', city: 'Walcourt', num: 1, src: 'BeST' });
  g.addStreet({ cp: '5650', street: "Rue de l'Abreuvoir", city: 'Walcourt', num: 1, src: 'BeST' });
  const r = resolveRows([
    { cp: '5640', tournee: '526', text: '11 NOVEMBRE RUE DU' },
    { cp: '5630', tournee: '030', text: 'BASSE RUE 104-104 / 112-107' },     // 5630 est lisible : on le garde
    { cp: '56A7', tournee: '517', text: "ABREUVOIR RUE DE L'" },             // code postal illisible
    { cp: '5650', tournee: 'A13', text: "ABREUVOIR RUE DE L'" },             // tournée illisible
    { cp: '5650', tournee: '004', text: 'ZZKQX RUE DES' },                   // rue inconnue partout
  ], g, ['5630']);
  assert.deepEqual([r[0].street, r[0].check], ['Rue du 11 Novembre', false]);
  assert.equal(r[1].cp, '5630');
  assert.deepEqual(r[1].segs.map(s => [s.from_n, s.to_n]), [[104, 104], [107, 112]]);
  assert.deepEqual([r[2].cp, r[2].check], ['5650', true]);
  assert.ok(r[3].check && /tournée/.test(r[3].why));
  assert.ok(r[4].check && /absente/.test(r[4].why));
});

test('dropRuns : une ligne répétée en boucle (invention du modèle) est supprimée, les vraies répétitions restent', () => {
  const loop = Array.from({ length: 30 }, (_, i) => ({ cp: '1000', tournee: String(87 + i), text: 'PAVIE RUE DE' }));
  const real = [
    { cp: '5600', tournee: '001', text: "ÉGLISE RUE DE L'" }, { cp: '5620', tournee: '007', text: "ÉGLISE RUE DE L'" }, { cp: '5680', tournee: '011', text: "ÉGLISE RUE DE L'" },
    { cp: '5640', tournee: '021', text: 'COMBATTANTS PLACE DES 2-2 / 1-1' },
  ];
  const { dropRuns } = boardModule;
  assert.deepEqual(dropRuns([...real, ...loop]), real);
});

test('mergeBoardRows : code postal ou tournée presque absents du tableau → à vérifier', () => {
  const rows = Array.from({ length: 120 }, (_, i) => row('5600', i % 2 ? '001' : '002', 'Rue ' + i));
  rows[50] = row('5840', '001', 'Rue Isolée'); rows[70] = row('5600', '903', 'Rue Autre');
  const m = mergeBoardRows([{ col: 0, row: 0, rows }]);
  assert.deepEqual(m.filter(r => r.check).map(r => r.street), ['Rue Isolée', 'Rue Autre']);
});
