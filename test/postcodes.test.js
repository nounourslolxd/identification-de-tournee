// Essais sur l'ensemble des codes postaux belges (src/data/postcodes.json, bpost + BeST Address).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAddr, checkCity, norm, sim } from '../src/js/match.js';
import { toIndex } from '../src/js/postcodes.js';
import { createGazetteer, correctAddress } from '../server/gazetteer.mjs';
import { fixPostcode } from '../server/vision.mjs';

const PC = JSON.parse(readFileSync(new URL('../src/data/postcodes.json', import.meta.url), 'utf8'));
const IDX = toIndex(PC);
const ALL = Object.entries(PC).flatMap(([cp, names]) => names.map(name => ({ cp, name })));
const fails = (list, max = 15) => `${list.length} échec(s) : ${list.slice(0, max).map(x => JSON.stringify(x)).join(', ')}`;

test('couverture : toute la Belgique, dans les trois langues', () => {
  assert.ok(Object.keys(PC).length >= 1100, `${Object.keys(PC).length} codes postaux`);
  const has = (cp, n) => assert.ok(PC[cp]?.some(x => norm(x) === norm(n)), `${cp} ${n} absent : ${PC[cp]}`);
  has('1000', 'Bruxelles'); has('1000', 'Brussel');
  has('1050', 'Ixelles'); has('1050', 'Elsene');
  has('9000', 'Gent'); has('2000', 'Antwerpen'); has('4000', 'Liège'); has('3000', 'Leuven');
  has('4700', 'Eupen'); has('4780', 'Sankt Vith');
  has('5500', 'Dinant'); has('5500', 'Anseremme'); has('7500', 'Tournai'); has('6700', 'Arlon');
  assert.equal(PC['5500'][0], 'Dinant', 'commune principale en premier');
  for (const cp of Object.keys(PC)) assert.match(cp, /^\d{4}$/);
});

test(`parseAddr : retrouve le code postal et la localité pour les ${ALL.length} couples`, () => {
  const bad = [];
  for (const { cp, name } of ALL) {
    const a = parseAddr(`M. Dupont\n12 Rue de la Station\n${cp} ${name}`);
    if (a.cp !== cp || norm(a.city) !== norm(name) || a.num !== 12) bad.push({ cp, name, lu: [a.cp, a.city, a.num] });
  }
  assert.equal(bad.length, 0, fails(bad));
});

test('parseAddr : code postal sur la même ligne que la rue, et préfixe « B- »', () => {
  const bad = [];
  for (const { cp, name } of ALL) {
    for (const t of [`Rue de la Station 12, ${cp} ${name}`, `12 rue de la Station\nB-${cp} ${name}`]) {
      const a = parseAddr(t);
      if (a.cp !== cp || norm(a.city) !== norm(name)) bad.push({ t, lu: [a.cp, a.city] });
    }
  }
  assert.equal(bad.length, 0, fails(bad));
});

test('checkCity : chaque localité officielle est verte, même en capitales ou sans accents', () => {
  const bad = [];
  for (const { cp, name } of ALL) {
    for (const v of [name, name.toUpperCase(), name.normalize('NFD').replace(/[̀-ͯ]/g, '')]) {
      if (checkCity(v, cp, IDX).cls !== 'ok') bad.push({ cp, v });
    }
  }
  assert.equal(bad.length, 0, fails(bad));
});

test('checkCity : localité tronquée ou avec une faute → orange avec le bon nom proposé', () => {
  const bad = [];
  for (const { cp, name } of ALL) {
    if (norm(name).length < 6) continue;
    const typo = name.slice(0, -1);                           // « Dinan »
    const r = checkCity(typo, cp, IDX);
    if (r.cls === 'ko' || (r.cls === 'wa' && !r.best)) bad.push({ cp, typo, r });
  }
  assert.equal(bad.length, 0, fails(bad));
});

test('checkCity : une localité d\'une autre région est rouge', () => {
  assert.equal(checkCity('Oostende', '5500', IDX).cls, 'ko');
  assert.equal(checkCity('Arlon', '9000', IDX).cls, 'ko');
});

test('fixPostcode : chaque code postal lu avec des O à la place des 0 est réparé', () => {
  const bad = [];
  for (const cp of Object.keys(PC)) {
    if (!cp.includes('0')) continue;
    const r = fixPostcode(cp.replace(/0/g, 'O'));
    if (r !== cp) bad.push({ cp, r });
  }
  assert.equal(bad.length, 0, fails(bad));
});

test('correctAddress (serveur) : code postal illisible retrouvé par la localité quand elle est univoque', () => {
  const g = createGazetteer();
  for (const { cp, name } of ALL) g.addLocality(cp, name);
  const bad = [];
  let recovered = 0;
  for (const { cp, name } of ALL) {
    const r = correctAddress({ num: 1, street: '', cp: '', city: name }, g);
    const owners = Object.entries(PC).filter(([, ns]) => ns.some(n => sim(n, name) >= 0.8)).map(([c]) => c);
    if (r.addr.cp) {
      if (!owners.includes(r.addr.cp)) bad.push({ name, got: r.addr.cp, owners });   // jamais un CP faux
      else recovered++;
    } else if (owners.length === 1) bad.push({ name, got: '', owners });           // univoque : doit être retrouvé
  }
  assert.equal(bad.length, 0, fails(bad));
  assert.ok(recovered > ALL.length * 0.5, `${recovered} / ${ALL.length} retrouvés`);
});
