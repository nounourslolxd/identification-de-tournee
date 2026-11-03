import { lev, norm, parseAddr, match, isFound } from './match.js';

/** Taux d'erreur de caractères (0 = parfait). */
export const cer = (got, want) => {
  const a = String(got ?? ''), b = String(want ?? '');
  return b.length ? lev(a, b) / b.length : (a.length ? 1 : 0);
};

/** Vérité terrain : « num;rue;cp;ville;tournée » (une par lettre). */
export function parseTruth(text) {
  return String(text ?? '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const [num, street, cp, city, tournee] = l.split(';').map(s => s.trim());
    return { num: num === '' ? null : +num, street, cp, city, tournee };
  });
}

/** Compare une adresse lue à la vérité : champs corrects + tournée trouvée. */
export function scoreLetter(text, truth, ranges) {
  const a = parseAddr(text), r = match(a, ranges);
  const ok = {
    num: a.num === truth.num,
    street: norm(a.street) === norm(truth.street),
    cp: a.cp === truth.cp,
    city: norm(a.city) === norm(truth.city),
    tournee: isFound(r) && String(r.e.tournee) === String(truth.tournee), // même seuil que l'application (« introuvable » < 50 %)
  };
  return { a, r, ok, cerStreet: cer(norm(a.street), norm(truth.street)) };
}

/** Agrège plusieurs lettres → { n, num, street, cp, city, tournee (taux 0–1), cerStreet (moyenne) }. */
export function summarize(items) {
  const n = items.length, rate = k => (n ? items.filter(i => i.ok[k]).length / n : 0);
  return { n, num: rate('num'), street: rate('street'), cp: rate('cp'), city: rate('city'), tournee: rate('tournee'),
    cerStreet: n ? items.reduce((s, i) => s + i.cerStreet, 0) / n : 0 };
}
