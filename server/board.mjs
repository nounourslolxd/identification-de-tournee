// Lecture d'un morceau de tableau de tri : texte du modèle → lignes vérifiées contre les bases d'adresses.
import { parseBoardText, sim } from '../src/js/match.js';
import { fixPostcode } from './vision.mjs';

/** Consigne de transcription d'un morceau (une colonne du tableau). */
export const TABLE_PROMPT = `Cette image est un extrait d'un tableau de tri postal belge.
Chaque ligne contient, de gauche à droite : un code postal à 4 chiffres, un numéro de tournée à 3 chiffres, puis le nom de la rue
(souvent suivi de RUE, PLACE, ALLÉE, CHEMIN… et d'un article), et parfois des plages de numéros comme « 2-146 / 1-147 ».
Transcris toutes les lignes de haut en bas, une par ligne, au format :
code postal;tournée;texte
Ignore les bandes orange (A A A) et les titres. Ignore les lignes coupées par le bord de l'image. N'invente rien.`;

/** Texte du modèle → [{ cp, tournee, text }] (lignes « cp;tournée;texte », le reste est ignoré). */
export function parseModelRows(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(/^\s*([0-9OoIlSB]{4})\s*[;|]\s*([0-9A-Za-z]{1,4})\s*[;|]\s*(\S.*?)\s*$/);
    if (m) out.push({ cp: m[1], tournee: m[2], text: m[3] });
  }
  return out;
}

/**
 * Retire les inventions du modèle : devant une zone vide, il lui arrive de répéter la même ligne en boucle
 * (« 1000;087;PAVIE RUE DE », « 1000;088;PAVIE RUE DE »…). Sur un vrai tableau, une même rue ne revient jamais
 * plus de trois fois de suite sans plage de numéros. Toute série plus longue est supprimée en entier.
 */
export function dropRuns(rows, max = 3) {
  const plain = r => r.text.replace(/\s+/g, ' ').trim().toLowerCase();
  const out = [];
  for (let i = 0; i < rows.length;) {
    let j = i + 1;
    while (j < rows.length && plain(rows[j]) === plain(rows[i])) j++;
    if (j - i <= max || /\d\s*-\s*\d/.test(rows[i].text)) out.push(...rows.slice(i, j));
    i = j;
  }
  return out;
}

/** Tournée à 3 chiffres ; répare les lettres lues à la place de chiffres (« A13 » → illisible, « O13 » → 013). */
export function fixTournee(s) {
  const t = String(s ?? '').trim().replace(/[Oo]/g, '0').replace(/[Il]/g, '1');
  return /^\d{3}$/.test(t) ? t : '';
}

const siblingsCache = new WeakMap();
/** Codes postaux de la même commune (ils partagent un nom de localité) : 5620 et 5621 pour Florennes. */
function siblings(gaz, cps) {
  let byName = siblingsCache.get(gaz);
  if (!byName) {
    byName = new Map();
    for (const cp of gaz.cps()) for (const n of gaz.citiesOf(cp)) {
      const k = n.toLowerCase();
      if (!byName.has(k)) byName.set(k, new Set());
      byName.get(k).add(cp);
    }
    siblingsCache.set(gaz, byName);
  }
  const out = new Set(cps);
  for (const cp of cps) for (const n of gaz.citiesOf(cp)) {
    const s = byName.get(n.toLowerCase());
    if (s && s.size <= 12) for (const x of s) out.add(x);      // un nom porté par trop de codes postaux n'aide pas
  }
  return out;
}

/**
 * Vérifie et corrige les lignes lues.
 *  - nom de rue remis dans l'ordre courant, puis remplacé par le nom officiel s'il est reconnu dans le code postal ;
 *  - code postal mal lu : retrouvé si la rue n'existe que dans un seul code postal de la zone du tableau ;
 *  - `check` : la ligne est à vérifier à la main (`why` dit pourquoi).
 * `zone` : codes postaux déjà rencontrés dans ce tableau (les morceaux précédents).
 * Retourne [{ cp, tournee, street, segs, note, check, why }].
 */
export function resolveRows(rows, gaz, zone = []) {
  const read = dropRuns(rows).map(r => ({ ...r, rawCp: r.cp, cp: fixPostcode(r.cp) }));
  const zoneCps = [...siblings(gaz, [...new Set([...zone, ...read.map(r => r.cp)])].filter(cp => gaz.hasCp(cp)))];
  const out = [];
  for (const r of read) {
    const { street, segs, note } = parseBoardText(r.text);
    if (!street) continue;
    const row = { cp: r.cp, tournee: fixTournee(r.tournee), street, segs, note, check: false, why: '' };
    const flag = why => { row.check = true; row.why = row.why ? row.why + ' ; ' + why : why; };
    if (!row.tournee) { row.tournee = String(r.tournee).trim(); flag('tournée illisible'); }

    // Le tableau fait foi : un code postal lisible n'est jamais changé, même si la base d'adresses ne connaît pas la rue.
    const cpOk = gaz.hasCp(row.cp);
    const own = cpOk ? gaz.streetCandidates(street, [row.cp], 1)[0] : null;
    if (own && own.score >= 0.88) row.street = own.street;                       // nom officiel
    else if (own && own.score >= 0.75) { row.street = own.street; flag(`rue lue « ${street} »`); }
    else {
      const c = zoneCps.length ? gaz.streetCandidates(street, zoneCps, 4).filter(x => x.score >= 0.9) : [];
      const cps = [...new Set(c.map(x => x.cp))];
      if (!cpOk && cps.length === 1) {                                            // code postal illisible, rue unique dans la zone
        flag(`code postal « ${r.rawCp} » illisible → ${cps[0]} d'après la rue`);
        row.cp = cps[0]; row.street = c[0].street;
      } else if (!cpOk) flag('code postal illisible');
      else if (!c.length) flag('rue absente de la base d\'adresses');             // nulle part dans la zone : lecture douteuse
    }
    out.push(row);
  }
  return out;
}

/** Deux lectures de la même ligne ? (même rue à peu près, mêmes plages) */
export const sameRow = (a, b) =>
  sim(a.street, b.street) >= 0.85 && JSON.stringify(a.segs) === JSON.stringify(b.segs);
