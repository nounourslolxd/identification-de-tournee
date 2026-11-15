import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  norm, lev, sim, parseAddr, parseTable, formatTable, parseLocalities, match,
  isFound, confidence, cls, clsGlobal, localityIndex, searchLocality, fmtRange, checkCity,
} from '../src/js/match.js';

const TABLE = `5500 rue de l'avie de 1 a 16 -- tournée 13
5100 rue de l'oublie de 1 a 4 -- tournée 5
5500 rue de l'oublie de 1 a 5 -- tournée 1`;
const ranges = parseTable(TABLE);

/* ---------- norm ---------- */
test('norm : accents, casse, apostrophes, articles', () => {
  assert.equal(norm("Rue de l'Église"), 'rue eglise');
  assert.equal(norm("RUE DE LA GARE"), 'rue gare');
  assert.equal(norm("Rue d’Hastière"), 'rue hastiere');
  assert.equal(norm('  Place   du   Marché '), 'place marche');
});
test('norm : valeurs vides ou non texte', () => {
  assert.equal(norm(''), '');
  assert.equal(norm(null), '');
  assert.equal(norm(undefined), '');
});
test('norm : ne supprime pas les articles à l’intérieur d’un mot', () => {
  assert.equal(norm('Rue Delattre'), 'rue delattre');
  assert.equal(norm('Rue du Lac'), 'rue lac');
});

/* ---------- lev / sim ---------- */
test('lev : cas de base', () => {
  assert.equal(lev('', ''), 0);
  assert.equal(lev('abc', ''), 3);
  assert.equal(lev('chat', 'chats'), 1);
  assert.equal(lev('kitten', 'sitting'), 3);
});
test('sim : identique = 1, ignore accents et articles', () => {
  assert.equal(sim("rue de l'oublie", "Rue de l'oublié"), 1);
  assert.equal(sim("Rue de la Gare", "rue gare"), 1);
});
test('sim : tolérant à une faute d’OCR, sévère sur autre chose', () => {
  assert.ok(sim("rue de l'oubliere", "rue de l'oublie") > 0.7);
  assert.ok(sim("rue de l'oublie", "rue de l'avie") < 0.7);
  assert.equal(sim('', ''), 0);
});

/* ---------- parseTable ---------- */
test('parseTable : lit les lignes valides', () => {
  assert.equal(ranges.length, 3);
  assert.deepEqual(ranges[2], {
    cp: '5500', city: '', street: "rue de l'oublie", from_n: 1, to_n: 5, parity: '', tournee: '1', source: 'table',
  });
});
test('parseTable : variantes de séparateurs et lignes parasites', () => {
  const r = parseTable("bruit\n5500 rue x de 2 à 8 — tournée A7\n\n5000 rue y 3-9 : tournee 12");
  assert.equal(r.length, 2);
  assert.equal(r[0].tournee, 'A7');
  assert.equal(r[1].from_n, 3);
  assert.equal(r[1].tournee, '12');
});
test('parseTable : inverse une plage écrite à l’envers', () => {
  const [r] = parseTable('5500 rue x de 9 a 3 -- tournée 2');
  assert.equal(r.from_n, 3);
  assert.equal(r.to_n, 9);
});
test('formatTable ↔ parseTable : aller-retour, sans les plages apprises', () => {
  const withLearned = [...ranges, { cp: '5500', street: 'rue z', from_n: 1, to_n: 1, tournee: '9', source: 'learned' }];
  assert.deepEqual(parseTable(formatTable(withLearned)), ranges);
});
test('parseLocalities', () => {
  assert.deepEqual(parseLocalities('5500 Dinant\nn’importe quoi\n 5100  Jambes '), [
    { cp: '5500', city: 'Dinant' }, { cp: '5100', city: 'Jambes' },
  ]);
});

/* ---------- parseAddr ---------- */
test('parseAddr : « 5 rue … 5500 Dinant »', () => {
  const a = parseAddr("5 rue de l'oubliere 5500 Dinant");
  assert.equal(a.num, 5);
  assert.equal(a.street, "rue de l'oubliere");
  assert.equal(a.cp, '5500');
  assert.equal(a.city, 'Dinant');
});
test('parseAddr : sur plusieurs lignes', () => {
  const a = parseAddr("M. Dupont\n12 Avenue de la Gare\n5100 Jambes");
  assert.equal(a.num, 12);
  assert.equal(a.street, 'Avenue de la Gare');
  assert.equal(a.cp, '5100');
  assert.equal(a.city, 'Jambes');
});
test('parseAddr : numéro après la rue, avec virgule', () => {
  const a = parseAddr("Rue de l'Oublie, 5\n5500 Dinant");
  assert.equal(a.num, 5);
  assert.equal(a.street, "Rue de l'Oublie");
});
test('parseAddr : boîte « bte »', () => {
  const a = parseAddr('7 bte 3 rue Grande 5500 Dinant');
  assert.equal(a.num, 7);
  assert.equal(a.street, 'rue Grande');
});
test('parseAddr : texte sans adresse → champs vides', () => {
  const a = parseAddr('ILLISIBLE');
  assert.equal(a.num, null);
  assert.equal(a.street, '');
  assert.equal(a.cp, '');
  assert.equal(parseAddr(null).raw, '');
});
test('parseAddr : garde le dernier code postal (celui de la localité)', () => {
  const a = parseAddr('5500 Dinant\n3 rue Grande\n5100 Jambes');
  assert.equal(a.cp, '5100');
});

/* ---------- match ---------- */
test('match : correspondance exacte = 100 %, bonne tournée', () => {
  const r = match(parseAddr("5 rue de l'oublie 5500 Dinant"), ranges);
  assert.equal(r.e.tournee, '1');
  assert.ok(Math.abs(r.score - 1) < 1e-9);
  assert.equal(clsGlobal(confidence(r)), 'ok');
});
test('match : le code postal départage deux rues identiques', () => {
  const r = match(parseAddr("3 rue de l'oublie 5100 Jambes"), ranges);
  assert.equal(r.e.tournee, '5');
});
test('match : faute d’OCR sur la rue, reste trouvé mais pas vert à 100 %', () => {
  const r = match(parseAddr("5 rue de l'oubliere 5500 Dinant"), ranges);
  assert.equal(r.e.tournee, '1');
  assert.ok(r.score < 1 && r.score > 0.9);
});
test('match : numéro hors plage sur une rue seule → −25 %', () => {
  const seul = parseTable("5500 rue de l'oublie de 1 a 5 -- tournée 1");
  const r = match(parseAddr("9 rue de l'oublie 5500 Dinant"), seul);
  assert.equal(r.n, 0);
  assert.ok(Math.abs(r.score - 0.75) < 1e-9);
  assert.equal(clsGlobal(confidence(r)), 'wa');
});
test('match : bornes de plage incluses', () => {
  const seul = parseTable("5500 rue de l'oublie de 1 a 5 -- tournée 1");
  assert.equal(match(parseAddr("1 rue de l'oublie 5500 Dinant"), seul).n, 1);
  assert.equal(match(parseAddr("5 rue de l'oublie 5500 Dinant"), seul).n, 1);
  assert.equal(match(parseAddr("6 rue de l'oublie 5500 Dinant"), seul).n, 0);
});
// Le numéro ne compte que si la rue ressemble : une rue voisine qui accepte le numéro ne l'emporte plus
// sur la bonne rue dont la plage ne contient pas le numéro (ancienne limite de la formule 50/25/25).
test('match : n° hors plage → reste sur la bonne rue, en orange', () => {
  const r = match(parseAddr("9 rue de l'oublie 5500 Dinant"), ranges);
  assert.equal(r.e.tournee, '1');
  assert.equal(r.n, 0);
  assert.ok(Math.abs(r.score - 0.75) < 0.01);
  assert.equal(clsGlobal(confidence(r)), 'wa'); // orange, pas vert : le facteur est averti
});
test('match : rue inconnue → introuvable (rouge)', () => {
  const r = match(parseAddr('4 rue des Zzzzzz 9999 Nulle'), ranges);
  assert.ok(!isFound(r) || clsGlobal(confidence(r)) === 'ko');
});
test('match : aucune plage → null, confiance 0', () => {
  const r = match(parseAddr('5 rue x 5500 Dinant'), []);
  assert.equal(r, null);
  assert.equal(isFound(r), false);
  assert.equal(confidence(r), 0);
});
test('match : une plage apprise passe avant une plage de base à égalité', () => {
  const learned = { cp: '5500', city: 'Dinant', street: "rue de l'oublie", from_n: 5, to_n: 5, tournee: '77', source: 'learned' };
  const r = match(parseAddr("5 rue de l'oublie 5500 Dinant"), [...ranges, learned]);
  assert.equal(r.e.tournee, '77');
  assert.ok(r.score > 1);
  assert.equal(confidence(r), 1);
});
test('match : adresse vide ne plante pas', () => {
  const r = match(parseAddr(''), ranges);
  assert.ok(r.score < 0.5);
});

/* ---------- seuils ---------- */
test('cls / clsGlobal : seuils', () => {
  assert.equal(clsGlobal(0.9), 'ok');
  assert.equal(clsGlobal(0.89), 'wa');
  assert.equal(clsGlobal(0.65), 'wa');
  assert.equal(clsGlobal(0.64), 'ko');
  assert.equal(cls(0.92), 'ok');
  assert.equal(cls(0.5), 'ko');
});

/* ---------- recherche par localité ---------- */
const locs = parseLocalities('5500 Dinant\n5100 Jambes');
const idx = localityIndex(locs, ranges);

test('searchLocality : par nom de ville', () => {
  const r = searchLocality('dinant', ranges, idx);
  assert.deepEqual(r.map(x => x.tournee), ['1', '13']);
  assert.equal(r[0].streets[0].key, "5500 rue de l'oublie");
  assert.deepEqual(r[0].streets[0].ranges, [[1, 5]]);
});
test('searchLocality : par code postal (préfixe)', () => {
  assert.deepEqual(searchLocality('51', ranges, idx).map(x => x.tournee), ['5']);
  assert.deepEqual(searchLocality('5500', ranges, idx).map(x => x.tournee), ['1', '13']);
});
test('searchLocality : tolère une faute de frappe', () => {
  assert.deepEqual(searchLocality('Jambs', ranges, idx).map(x => x.tournee), ['5']);
});
test('searchLocality : accents et casse ignorés', () => {
  const i = localityIndex([{ cp: '5500', city: 'Hastière' }], ranges);
  assert.deepEqual(searchLocality('HASTIERE', ranges, i).map(x => x.tournee), ['1', '13']);
});
test('searchLocality : aucun résultat / requête vide', () => {
  assert.deepEqual(searchLocality('Bruxelles', ranges, idx), []);
  assert.deepEqual(searchLocality('   ', ranges, idx), []);
});
test('searchLocality : tri numérique des tournées et regroupement des plages', () => {
  const rs = parseTable('5500 rue a de 1 a 2 -- tournée 10\n5500 rue a de 5 a 6 -- tournée 10\n5500 rue b de 1 a 2 -- tournée 2');
  const r = searchLocality('5500', rs, localityIndex(parseLocalities('5500 Dinant'), rs));
  assert.deepEqual(r.map(x => x.tournee), ['2', '10']);
  assert.deepEqual(r[1].streets[0].ranges, [[1, 2], [5, 6]]);
});
test('localityIndex : inclut localités des plages apprises', () => {
  const l = [{ cp: '5000', city: 'Namur', street: 'rue q', from_n: 1, to_n: 1, tournee: '3', source: 'learned' }];
  assert.deepEqual(searchLocality('namur', l, localityIndex([], l)).map(x => x.tournee), ['3']);
});
test('fmtRange', () => {
  assert.equal(fmtRange([3, 3]), '3');
  assert.equal(fmtRange([1, 5]), '1–5');
});

test('checkCity : exacte → ok, tronquée ou proche → orange avec le nom officiel, inconnue → rouge', () => {
  const idx = localityIndex([{ cp: '5500', city: 'Dinant' }, { cp: '5000', city: 'Namur' }]);
  assert.deepEqual(checkCity('DINANT', '5500', idx), { cls: 'ok', best: 'Dinant' });
  assert.deepEqual(checkCity('Dina', '5500', idx), { cls: 'wa', best: 'Dinant' });
  assert.deepEqual(checkCity('Dinan', '5500', idx), { cls: 'wa', best: 'Dinant' });
  assert.equal(checkCity('Liège', '5500', idx).cls, 'ko');
  assert.equal(checkCity('', '5500', idx).cls, 'ko');
  assert.deepEqual(checkCity('Namr', '9999', idx), { cls: 'wa', best: 'Namur' }); // CP inconnu : toutes les localités
  assert.equal(checkCity('Dinant', '5500', new Map()).cls, 'ok');                // rien à comparer
});
