import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGazetteer, loadGazetteer, correctAddress, normStreet } from '../server/gazetteer.mjs';
import { parseModelJson, toAddress, createVision, fixPostcode } from '../server/vision.mjs';
import { readLetter, hintsFrom } from '../server/pipeline.mjs';
import { splitCsv, bestEntries, bpostEntry } from '../server/import.mjs';

function gaz() {
  const g = createGazetteer();
  g.addLocality('5500', 'Dinant');
  g.addLocality('5500', 'Anseremme');
  g.addLocality('5000', 'Namur');
  for (const [street, num] of [['Rue Grande', 1], ['Rue Grande', 140], ['Rue Saint-Jacques', 2], ['Rue Sax', 10], ['Avenue Churchill', 5], ['Rue des Rivages', 3], ['Rue du Moulin', 4], ['Rue du Moulin Neuf', 2]])
    g.addStreet({ cp: '5500', street, city: 'Dinant', num, src: 'BeST' });
  g.addStreet({ cp: '5000', street: 'Rue de Fer', city: 'Namur', num: 20, src: 'OSM' });
  return g;
}

test('normStreet : développe les abréviations', () => {
  assert.equal(normStreet('Av. Churchill'), normStreet('Avenue Churchill'));
  assert.equal(normStreet('Bd de la Sauvenière'), 'boulevard sauveniere');
});

test('correctAddress : corrige une rue mal lue vers le nom officiel', () => {
  const r = correctAddress({ num: 12, street: 'rue grnade', cp: '5500', city: 'dinant' }, gaz());
  assert.equal(r.addr.street, 'Rue Grande');
  assert.equal(r.addr.city, 'Dinant');
  assert.equal(r.numberInRange, true);
  assert.ok(r.corrections.length >= 1);
});

test('correctAddress : abréviation « Av. » reconnue', () => {
  assert.equal(correctAddress({ num: 5, street: 'Av. Churchil', cp: '5500', city: 'Dinant' }, gaz()).addr.street, 'Avenue Churchill');
});

test('correctAddress : code postal illisible retrouvé par la localité', () => {
  const r = correctAddress({ num: 20, street: 'rue de fer', cp: '5O00', city: 'Namur' }, gaz());
  assert.equal(r.addr.cp, '5000');
  assert.equal(r.addr.street, 'Rue de Fer');
});

test('fixPostcode : répare O/I/S lus à la place de chiffres', () => {
  assert.equal(fixPostcode('55OO'), '5500');
  assert.equal(fixPostcode('B-5OOO Namur'), '5000');
  assert.equal(fixPostcode('I000'), '1000');
  assert.equal(fixPostcode('Dinant'), '');
  assert.equal(fixPostcode('ABCD'), '');
});

test('correctAddress : localité mal orthographiée → code postal et nom officiels', () => {
  const r = correctAddress({ num: 5, street: 'Rue Grande', cp: '', city: 'Dinan' }, gaz());
  assert.equal(r.addr.cp, '5500');
  assert.equal(r.addr.city, 'Dinant');
});

test('correctAddress : numéro hors des numéros connus signalé', () => {
  assert.equal(correctAddress({ num: 999, street: 'Rue Grande', cp: '5500', city: 'Dinant' }, gaz()).numberInRange, false);
});

test('correctAddress : rues proches → ambiguïté (pas de correction forcée)', () => {
  const r = correctAddress({ num: 1, street: 'Rue du Moulin N', cp: '5500', city: 'Dinant' }, gaz());
  assert.equal(r.addr.street, 'Rue du Moulin N');
  assert.deepEqual(r.ambiguous.slice(0, 2).map(c => c.street).sort(), ['Rue du Moulin', 'Rue du Moulin Neuf']);
});

test('correctAddress : rue inconnue laissée telle quelle', () => {
  const r = correctAddress({ num: 1, street: 'Chemin du Zzyzx', cp: '5500', city: 'Dinant' }, gaz());
  assert.equal(r.addr.street, 'Chemin du Zzyzx');
  assert.equal(r.ambiguous, null);
});

test('setTable : les rues du tableau des tournées servent aussi à corriger', () => {
  const g = gaz();
  g.setTable([{ cp: '5500', street: "rue de l'oubliere", city: 'Dinant', from_n: 1, to_n: 5, source: 'table' }]);
  assert.equal(correctAddress({ num: 3, street: 'rue de loubliere', cp: '5500', city: 'Dinant' }, g).addr.street, "rue de l'oubliere");
  g.setTable([]);
  assert.equal(g.streetCandidates("rue de l'oubliere", ['5500'])[0].street !== "rue de l'oubliere", true);
});

test('toJSON / loadGazetteer : aller-retour', () => {
  const g = loadGazetteer(JSON.parse(JSON.stringify(gaz().toJSON())));
  assert.deepEqual(g.size(), gaz().size());
  assert.equal(g.streetCandidates('rue grande', ['5500'])[0].max, 140);
});

test('parseModelJson : tolère le texte et les blocs ```json', () => {
  assert.deepEqual(parseModelJson('Voici :\n```json\n{"cp":"5500","rue":"a } b"}\n```'), { cp: '5500', rue: 'a } b' });
  assert.deepEqual(parseModelJson('ok {"a":{"b":1}} fin'), { a: { b: 1 } });
  assert.equal(parseModelJson('rien'), null);
});

test('toAddress : normalise la réponse du modèle', () => {
  const a = toAddress({ numero: '12b', rue: ' Rue Grande ', cp: 'B-5500', ville: 'Dinant', manuscrit: true });
  assert.deepEqual([a.num, a.street, a.cp, a.city, a.handwritten], [12, 'Rue Grande', '5500', 'Dinant', true]);
  const b = toAddress({ n: 30, b: 2, r: 'Rue Saint-Gilles', cp: '4000', v: 'Liège', m: false });   // clés courtes
  assert.deepEqual([b.num, b.box, b.street, b.cp, b.city, b.handwritten], [30, '2', 'Rue Saint-Gilles', '4000', 'Liège', false]);
  assert.equal(toAddress({}).num, null);
});

test('createVision : appelle /chat/completions et lit le JSON', async () => {
  let body;
  const fetchImpl = async (url, opt) => {
    assert.equal(url, 'http://m/v1/chat/completions');
    body = JSON.parse(opt.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"numero":3,"rue":"Rue Sax","cp":"5500","ville":"Dinant","manuscrit":true}' } }] }) };
  };
  const v = createVision({ url: 'http://m/v1/', model: 'test', fetchImpl });
  const a = await v.read(Buffer.from([1, 2]), 'image/jpeg', ['5500 Dinant']);
  assert.equal(a.street, 'Rue Sax');
  assert.match(body.messages[1].content[0].image_url.url, /^data:image\/jpeg;base64,/);
  assert.match(body.messages[1].content[1].text, /5500 Dinant/);
});

test('readLetter : second passage du modèle quand la rue est ambiguë', async () => {
  const vision = {
    model: 'faux',
    read: async () => ({ num: 2, street: 'Rue du Moulin N', cp: '5500', city: 'Dinant', raw: '', handwritten: true }),
    choose: async (img, mime, read, cands) => cands.findIndex(c => c.street === 'Rue du Moulin Neuf'),
  };
  const r = await readLetter({ image: Buffer.alloc(1), mime: 'image/jpeg', vision, gaz: gaz() });
  assert.equal(r.street, 'Rue du Moulin Neuf');
  assert.equal(r.numberInRange, true);
  assert.equal(r.read.street, 'Rue du Moulin N');
  assert.equal(r.handwritten, true);
  assert.deepEqual(r.candidates, []);
});

test('hintsFrom : liste des communes, vide si trop nombreuses', () => {
  assert.deepEqual(hintsFrom(gaz()), ['5000 Namur', '5500 Dinant/Anseremme']);
  assert.deepEqual(hintsFrom(gaz(), 1), []);
});

test('import : CSV BeST et bpost', () => {
  assert.deepEqual(splitCsv('a,"b, c","d ""e"""', ','), ['a', 'b, c', 'd "e"']);
  const e = bestEntries({ postcode: '5500', streetname_fr: 'Rue Grande', streetname_nl: '', postname_fr: 'Dinant', house_number: '12', status: 'current' });
  assert.deepEqual(e, [{ cp: '5500', street: 'Rue Grande', city: 'Dinant', num: '12', src: 'BeST' }]);
  assert.deepEqual(bestEntries({ postcode: '5500', streetname_fr: 'X', status: 'retired' }), []);
  assert.deepEqual(bpostEntry({ 'code postal': '5500', 'localité': 'Dinant' }), { cp: '5500', city: 'Dinant' });
});

test('createVision : sortie par schéma, repli sur json_object si le serveur répond 400', async () => {
  const formats = [];
  const fetchImpl = async (url, opt) => {
    const body = JSON.parse(opt.body);
    formats.push(body.response_format.type);
    if (body.response_format.type === 'json_schema') return { ok: false, status: 400, text: async () => 'unsupported' };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"n":3,"b":null,"r":"Rue Sax","cp":"5500","v":"Dinant","m":true}' } }], usage: { prompt_tokens: 100, completion_tokens: 40 } }) };
  };
  const v = createVision({ url: 'http://m/v1', model: 'test', fetchImpl });
  const a = await v.read(Buffer.from([1]), 'image/jpeg', []);
  assert.deepEqual([a.num, a.street, a.tokens], [3, 'Rue Sax', { in: 100, out: 40 }]);
  await v.read(Buffer.from([1]), 'image/jpeg', []);
  assert.deepEqual(formats, ['json_schema', 'json_object', 'json_object']);   // le refus est mémorisé
});

test('createVision.warm : appel minuscule sans image', async () => {
  let body;
  const v = createVision({ url: 'http://m/v1', model: 'test', fetchImpl: async (u, o) => { body = JSON.parse(o.body); return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }; } });
  assert.ok(await v.warm() >= 0);
  assert.equal(body.max_tokens, 1);
  assert.equal(typeof body.messages[0].content, 'string');
});

test('hintsFrom : seulement les codes postaux du tableau des tournées, même avec la liste nationale chargée', () => {
  const g = gaz();
  for (let cp = 1000; cp < 1200; cp++) g.addLocality(String(cp), 'Ville ' + cp);   // liste nationale : trop pour un indice
  assert.deepEqual(hintsFrom(g), []);
  g.setTable([{ cp: '5500', street: 'Rue Grande', city: 'Dinant', from_n: 1, to_n: 9, source: 'table' }]);
  assert.deepEqual(hintsFrom(g), ['5500 Dinant/Anseremme']);
});

test('readLetter : renvoie le détail des temps et le texte lu', async () => {
  const vision = { model: 'faux', read: async () => ({ num: 12, street: 'Rue Grande', cp: '5500', city: 'Dinant', handwritten: false, tokens: { in: 9, out: 3 } }) };
  const r = await readLetter({ image: Buffer.alloc(1), mime: 'image/jpeg', vision, gaz: gaz() });
  assert.equal(r.raw, '12 Rue Grande\n5500 Dinant');
  assert.deepEqual(r.timing.tokens, { in: 9, out: 3 });
  assert.ok(r.timing.read >= 0 && r.timing.choose === 0);
});
