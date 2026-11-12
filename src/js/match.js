// Logique pure (aucun accès DOM / réseau) : testable sous Node et utilisable dans le navigateur.
// Une « plage » a la forme { cp, city?, street, from_n, to_n, tournee, source? } (source: 'table' | 'learned').

/** Minuscules, sans accents, sans ponctuation ni articles « de/du/des/la/le/les/l/d ». */
export const norm = s =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0153/g, 'oe').replace(/\u00e6/g, 'ae').replace(/\u00df/g, 'ss')
    .replace(/[’']/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(de|du|des|la|le|les|l|d)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Distance de Levenshtein. */
export function lev(a, b) {
  const m = a.length, n = b.length;
  let p = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const c = [i];
    for (let j = 1; j <= n; j++) {
      c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    p = c;
  }
  return p[n];
}

/** Similarité normalisée dans [0,1] entre deux libellés (après `norm`). */
export const sim = (a, b) => simNorm(norm(a), norm(b));

/** Similarité de deux libellés déjà normalisés. */
export const simNorm = (a, b) => {
  if (a === b) return a ? 1 : 0;
  const L = Math.max(a.length, b.length);
  return L ? 1 - lev(a, b) / L : 0;
};

const streetNorm = new WeakMap();
/** Rue normalisée d'une plage, mise en cache tant que la plage existe. */
const normOf = e => { let n = streetNorm.get(e); if (n === undefined) streetNorm.set(e, n = norm(e.street)); return n; };

const TABLE_LINE = /^\s*(\d{4,5})\s+(.+?)\s+(?:de\s+)?(\d+)\s*(?:a|à|-)\s*(\d+)\s*(?:--|—|–|-|:)\s*tourn[ée]e\s*(\w+)/i;

/** « 5500 rue de l'oublie de 1 a 5 -- tournée 1 » → plages. Les lignes non reconnues sont ignorées. */
export function parseTable(text, city = '') {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(TABLE_LINE);
    if (!m) continue;
    let from_n = +m[3], to_n = +m[4];
    if (from_n > to_n) [from_n, to_n] = [to_n, from_n];
    out.push({ cp: m[1], city, street: m[2].trim(), from_n, to_n, tournee: m[5], source: 'table' });
  }
  return out;
}

/** Lignes du tableau en texte (pour l'édition manuelle). */
export const formatTable = ranges =>
  ranges.filter(r => r.source !== 'learned')
    .map(r => `${r.cp} ${r.street} de ${r.from_n} a ${r.to_n} -- tournée ${r.tournee}`).join('\n');

/** « 5500 Dinant » (une par ligne) → [{cp, city}] */
export function parseLocalities(text) {
  const out = [];
  for (const l of String(text ?? '').split('\n')) {
    const x = l.match(/^\s*(\d{4,5})\s+(.+?)\s*$/);
    if (x) out.push({ cp: x[1], city: x[2] });
  }
  return out;
}

const ST = 'rue|avenue|av|chaussée|chaussee|chemin|place|boulevard|route|impasse|quai|allée|allee|square|clos|sentier|ruelle|rempart';

/** Texte OCR d'une adresse → { num, street, cp, city, raw }. */
export function parseAddr(t) {
  t = String(t ?? '');
  const a = { num: null, street: '', cp: '', city: '', raw: t.trim() };
  // « 5500 Dinant », « B-7090 Petit-Rœulx-lez-Braine », « 5020 P.A.E. de Rhisnes », « 7510 3 Suisses » :
  // lettres de toutes langues, points, apostrophes, tirets ; la localité doit contenir au moins une lettre.
  const cps = [...t.matchAll(/(?:^|[^\d])(\d{4,5})[ \t]+((?=[\p{L}\d'’.\- ]*\p{L})[\p{L}\d'’][\p{L}\d'’.\- ]+)/gmu)];
  if (cps.length) {
    const c = cps[cps.length - 1];
    a.cp = c[1];
    a.city = c[2].replace(/[\s.\-]+$/, '').trim();
  }
  let m = t.match(new RegExp('(\\d+)\\s*(?:bte\\s*\\w+)?[,\\s]+((?:' + ST + ')\\b[^\\n\\d]*)', 'i'));
  if (m) {
    a.num = +m[1];
    a.street = m[2].trim();
  } else if ((m = t.match(new RegExp('((?:' + ST + ')\\b[^\\n\\d]*?)[,\\s]+(\\d+)', 'i')))) {
    a.street = m[1].trim();
    a.num = +m[2];
  }
  return a;
}

/**
 * Meilleure plage pour une adresse lue.
 * score = 50 % rue + 25 % code postal + 25 % numéro dans la plage (+0,01 de priorité aux plages apprises).
 * Retourne { e, s, p, n, score } ou null si `ranges` est vide.
 */
export function match(a, ranges) {
  let best = null;
  const street = norm(a.street);
  for (const e of ranges) {
    const s = simNorm(street, normOf(e));
    const p = a.cp && a.cp === e.cp ? 1 : 0;
    const n = a.num != null && a.num >= e.from_n && a.num <= e.to_n ? 1 : 0;
    const learned = e.source === 'learned';
    const score = 0.5 * s + 0.25 * p + 0.25 * n + (learned && n && s > 0.8 ? 0.01 : 0);
    if (!best || score > best.score) best = { e, s, p, n, score };
  }
  return best;
}

/** Une correspondance est « trouvée » à partir de 50 %. Confiance affichée plafonnée à 100 %. */
export const FOUND_MIN = 0.5;
export const isFound = r => !!r && r.score >= FOUND_MIN;
export const confidence = r => (isFound(r) ? Math.min(r.score, 1) : 0);

/** Classe d'affichage : vert ≥ o, orange ≥ w, rouge sinon. */
export const cls = (v, o = 0.92, w = 0.7) => (v >= o ? 'ok' : v >= w ? 'wa' : 'ko');
/** Seuils de confiance globale : vert ≥ 90 %, orange 65–90 %, rouge sinon. */
export const clsGlobal = v => cls(v, 0.9, 0.65);

/** Index cp → Set(noms de localité) à partir des localités déclarées, des plages et de données annexes. */
export function localityIndex(localities = [], ranges = [], extra = []) {
  const m = new Map();
  const add = (cp, c) => {
    if (!cp || !c) return;
    if (!m.has(cp)) m.set(cp, new Set());
    m.get(cp).add(String(c).trim());
  };
  for (const l of localities) add(l.cp, l.city);
  for (const r of ranges) add(r.cp, r.city);
  for (const x of extra) add(x.cp, x.city);
  return m;
}

/**
 * Vérifie la localité lue par rapport aux localités connues (de préférence celles du code postal).
 * Retourne { cls: 'ok' | 'wa' | 'ko', best: nom officiel le plus proche ou null }.
 *  ok : nom identique (sans accents ni casse) ; wa : nom proche ou tronqué (« Dina » → Dinant) ; ko : inconnu.
 * Sans aucune localité connue, rien n'est vérifiable : une localité lue reste « ok ».
 */
export function checkCity(city, cp, index) {
  const c = norm(city);
  if (!c) return { cls: 'ko', best: null };
  const own = [...(index.get(cp) ?? [])];
  const names = own.length ? own : [...index.values()].flatMap(s => [...s]);
  if (!names.length) return { cls: 'ok', best: null };
  let best = null, bs = -1;
  for (const n of names) {
    const nn = norm(n);
    const s = nn === c ? 1 : Math.max(sim(n, city), nn.startsWith(c) && c.length >= 3 ? 0.75 : 0);
    if (s > bs) { bs = s; best = n; }
  }
  return { cls: bs === 1 ? 'ok' : bs >= 0.6 ? 'wa' : 'ko', best: bs === 1 ? best : bs >= 0.6 ? best : null };
}

/**
 * Recherche par ville / village / code postal.
 * Retourne [{ tournee, streets: [{ key: '5500 rue …', ranges: [[from,to], …] }] }] triées par tournée.
 */
export function searchLocality(q, ranges, index) {
  q = String(q ?? '').trim();
  if (!q) return [];
  const nq = norm(q), digits = /^\d+$/.test(q), cps = new Set();
  index.forEach((names, cp) => {
    const hit = digits
      ? cp.startsWith(q)
      : [...names].some(n => (nq && norm(n).includes(nq)) || sim(n, q) >= 0.8);
    if (hit) cps.add(cp);
  });
  const by = new Map();
  for (const e of ranges) {
    if (!cps.has(e.cp)) continue;
    const key = e.cp + ' ' + e.street;
    if (!by.has(e.tournee)) by.set(e.tournee, new Map());
    const st = by.get(e.tournee);
    if (!st.has(key)) st.set(key, []);
    st.get(key).push([e.from_n, e.to_n]);
  }
  return [...by.keys()]
    .sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }))
    .map(t => ({ tournee: t, streets: [...by.get(t)].map(([key, r]) => ({ key, ranges: r })) }));
}

export const fmtRange = ([a, b]) => (a === b ? String(a) : `${a}–${b}`);
