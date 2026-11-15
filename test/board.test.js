// Format du tableau de tri du bureau (lignes relevées sur les photos du tableau Philippeville / Florennes / Walcourt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBoardText, parseSegment, parseTable, formatTable, match, parseAddr, inRange, isWhole, fmtRange, WHOLE } from '../src/js/match.js';

test('parseBoardText : le type et l\'article en fin de ligne repassent devant le nom', () => {
  const s = t => parseBoardText(t).street;
  assert.equal(s('COURTILAS RUE DES'), 'Rue des Courtilas');
  assert.equal(s("ABBAYE RUE DE L'"), "Rue de l'Abbaye");
  assert.equal(s("ANTHÉE RUE D'"), "Rue d'Anthée");
  assert.equal(s('COUTURELLE RUE DE LA'), 'Rue de la Couturelle');
  assert.equal(s('DOCTEUR VANDER ELST AVENUE'), 'Avenue Docteur Vander Elst');
  assert.equal(s('CROIX DES DAMES CHEMIN'), 'Chemin Croix des Dames');
  assert.equal(s('MOULIN DE ROLY RUE DU'), 'Rue du Moulin de Roly');
  assert.equal(s('13 NOVEMBRE RUE DU'), 'Rue du 13 Novembre');
  assert.equal(s('NATIONALE 5 ROUTE'), 'Route Nationale 5');
  assert.equal(s('SART-EN-FAGNE PLACE DE'), 'Place de Sart-En-Fagne');
  assert.equal(s('AUBÉPINES ALLÉE DES'), 'Allée des Aubépines');
  assert.equal(s('COUR RUE DE LA'), 'Rue de la Cour');
});

test('parseBoardText : nom sans type en fin de ligne conservé', () => {
  assert.equal(parseBoardText('MOULIN BAYOT').street, 'Moulin Bayot');
  assert.equal(parseBoardText('COUR DES USINES').street, 'Cour des Usines');
  assert.equal(parseBoardText('GRAND ROUTE').street, 'Grand Route');
  assert.equal(parseBoardText("rue de l'oublie").street, "rue de l'oublie");     // déjà en casse courante : intact
});

test('parseSegment : parité déduite des bornes', () => {
  assert.deepEqual(parseSegment('2-146'), { from_n: 2, to_n: 146, parity: 'even' });
  assert.deepEqual(parseSegment('1-147'), { from_n: 1, to_n: 147, parity: 'odd' });
  assert.deepEqual(parseSegment('2-5'), { from_n: 2, to_n: 5, parity: '' });      // parités différentes : tous
  assert.deepEqual(parseSegment('63-63'), { from_n: 63, to_n: 63, parity: '' });  // un seul numéro
  assert.deepEqual(parseSegment('25-24'), { from_n: 24, to_n: 25, parity: '' });  // écrit à l'envers
  assert.deepEqual(parseSegment('17-18A'), { from_n: 17, to_n: 18, parity: '' });
  assert.deepEqual(parseSegment('1-5', true), { from_n: 1, to_n: 5, parity: '' });
});

test('parseBoardText : plages paires / impaires, plusieurs segments, ligne spéciale', () => {
  assert.deepEqual(parseBoardText("ANTHÉE RUE D' 2-146 / 1-147").segs,
    [{ from_n: 2, to_n: 146, parity: 'even' }, { from_n: 1, to_n: 147, parity: 'odd' }]);
  assert.equal(parseBoardText('MOULIN RUE DU 178-180 / 181-201 / 206-208').segs.length, 3);
  assert.deepEqual(parseBoardText('COUVENT RUE DU 1-1').segs, [{ from_n: 1, to_n: 1, parity: '' }]);
  const sp = parseBoardText('METTET RUE DE 127 ATELIER 85 ASBL');
  assert.deepEqual([sp.street, sp.segs, sp.note], ['Rue de Mettet', [{ from_n: 127, to_n: 127, parity: '' }], 'ATELIER 85 ASBL']);
  assert.deepEqual(parseBoardText('COURTILAS RUE DES').segs, []);
});

const BOARD = `5600 513 COURTILAS RUE DES
5620 009 ANTHÉE RUE D' 2-146 / 1-147
5640 526 ALBERT IER RUE 2-126 / 1-123
5640 523 ALBERT IER RUE 63-63
5620 506 METTET RUE DE 2-300 / 1-251
5620 506 METTET RUE DE 127 ATELIER 85 ASBL
? 5640 528 13 NOVEMBRE RUE DU
AAA
5651;515;AHÉRÉE RUE 1-1`;

test('parseTable : lignes du tableau de tri (séparateur espace ou point-virgule, « ? » ignoré, titres ignorés)', () => {
  const r = parseTable(BOARD);
  assert.equal(r.length, 11);
  assert.deepEqual(r[0], { cp: '5600', city: '', street: 'Rue des Courtilas', from_n: WHOLE[0], to_n: WHOLE[1], parity: '', tournee: '513', source: 'table' });
  assert.ok(isWhole(r[0]));
  assert.deepEqual([r[1].tournee, r[1].from_n, r[1].to_n, r[1].parity], ['009', 2, 146, 'even']);
  assert.equal(r.find(x => x.street === 'Rue du 13 Novembre').tournee, '528');
  assert.equal(r.at(-1).street, 'Rue Ahérée');
});

test('match : la tournée dépend du numéro et de sa parité', () => {
  const r = parseTable(BOARD);
  const t = s => match(parseAddr(s), r).e.tournee;
  assert.equal(t('12 Rue des Courtilas 5600 Philippeville'), '513');          // toute la rue
  assert.equal(t('40 rue Albert Ier 5640 Mettet'), '526');                    // pair dans 2-126
  assert.equal(t('63 rue Albert Ier 5640 Mettet'), '523');                    // numéro isolé : l'autre plage s'arrête à 123 mais 63 y est aussi…
  assert.equal(t("146 rue d'Anthée 5620 Florennes"), '009');
  const hors = match(parseAddr("148 rue d'Anthée 5620 Florennes"), r);
  assert.equal(hors.n, 0);                                                    // 148 > 146 : numéro hors plage
  assert.ok(inRange(3, { from_n: 1, to_n: 147, parity: 'odd' }));
  assert.ok(!inRange(4, { from_n: 1, to_n: 147, parity: 'odd' }));
});

test('formatTable ↔ parseTable : aller-retour au format du tableau', () => {
  const r = parseTable(BOARD);
  const txt = formatTable(r);
  assert.match(txt, /^5600 513 Rue des Courtilas$/m);
  assert.match(txt, /^5620 009 Rue d'Anthée 2-146 \/ 1-147$/m);
  assert.deepEqual(parseTable(txt), r);
  // Plage « tous les numéros » aux bornes de même parité : marquée « tous » pour ne pas devenir impaire.
  const old = parseTable("5500 rue de l'oublie de 1 a 5 -- tournée 1");
  assert.equal(formatTable(old), "5500 1 rue de l'oublie 1-5 tous");
  assert.deepEqual(parseTable(formatTable(old)), old);
});

test('fmtRange : parité et rue entière', () => {
  assert.equal(fmtRange([2, 146, 'even']), '2–146 pairs');
  assert.equal(fmtRange([1, 147, 'odd']), '1–147 impairs');
  assert.equal(fmtRange(WHOLE), 'toute la rue');
});

test('searchStreets : une rue, par son nom, avec une faute, ou avec son code postal', async () => {
  const { searchStreets } = await import('../src/js/match.js');
  const r = parseTable(`5600 002 Rue Lavaux
5600 003 Gueule-du-Loup
5600 512 Rue de Namur 2-40 / 1-39
5600 513 Rue de Namur 42-90 / 41-89
5620 007 Rue de Namur
5640 526 Rue Albert Ier 2-126 / 1-123`);
  const s = q => searchStreets(q, r).map(x => x.cp + ' ' + x.street);
  assert.deepEqual(s('rue de namur'), ['5600 Rue de Namur', '5620 Rue de Namur']);
  assert.deepEqual(s('namur'), ['5600 Rue de Namur', '5620 Rue de Namur']);
  assert.deepEqual(s('namur 5620'), ['5620 Rue de Namur']);
  assert.deepEqual(s('gueule du loup'), ['5600 Gueule-du-Loup']);
  assert.deepEqual(s('albert 1er'), ['5640 Rue Albert Ier']);             // « 1er » au lieu de « Ier » : trouvée quand même
  assert.deepEqual(s('albert'), ['5640 Rue Albert Ier']);
  assert.deepEqual(s('lavau'), ['5600 Rue Lavaux']);                       // début du nom
  assert.deepEqual(s('lavaus'), ['5600 Rue Lavaux']);                      // faute de frappe
  assert.deepEqual(s('zz'), []);
  const namur = searchStreets('namur 5600', r)[0];
  assert.deepEqual(namur.tours.map(t => t.tournee), ['512', '513']);       // plusieurs tournées dans la même rue
  assert.deepEqual(namur.tours[0].ranges, [[2, 40, 'even'], [1, 39, 'odd']]);
});
