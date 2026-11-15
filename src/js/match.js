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

/* ------------------------------------------------------------------ */
/* Tableau de tri                                                       */
/* ------------------------------------------------------------------ */
// Une ligne du tableau affiché au bureau : « 5620 009 ANTHÉE RUE D' 2-146 / 1-147 »
//   code postal · tournée (3 chiffres) · nom de la rue, type et article À LA FIN · plages de numéros (facultatif).
// Plages : « 2-146 » = numéros pairs de 2 à 146, « 1-147 » = impairs (les deux bornes ont la même parité) ;
// bornes de parités différentes (« 2-5 ») = tous les numéros ; sans plage = toute la rue.
// Lignes spéciales : « METTET RUE DE 127 ATELIER 85 ASBL » = le seul numéro 127.

/** Toute la rue. */
export const WHOLE = [0, 99999];
export const isWhole = r => r.from_n <= WHOLE[0] && r.to_n >= WHOLE[1];

const TYPES = new Set(['rue', 'ruelle', 'avenue', 'place', 'allee', 'chemin', 'route', 'quartier', 'boulevard', 'impasse', 'chaussee',
  'clos', 'sentier', 'cite', 'residence', 'tienne', 'square', 'quai', 'dreve', 'voie', 'zoning', 'parc', 'hameau', 'faubourg',
  'thier', 'tige', 'venelle', 'cour', 'passage', 'rampe', 'esplanade', 'domaine', 'lotissement', 'rempart', 'carrefour']);
const ARTICLES = new Set(['de', 'du', 'des', 'la', 'le', 'les', "l'", "d'", 'aux', 'au', 'a', 'en']);
const NO_ROTATE = new Set(['grand', "grand'", 'grande', 'petite', 'vieille', 'nouvelle']); // « Grand Route », « Petite Rue »
const key = w => w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/’/g, "'");

const SEG = String.raw`\d+\s?[A-Za-z]?\s*-\s*\d+\s?[A-Za-z]?`;
const TRAIL = new RegExp(`((?:${SEG})(?:\\s*/\\s*(?:${SEG}))*)\\s*(tous)?\\s*$`, 'i');

/** « 2-146 » → { from_n: 2, to_n: 146, parity: 'even' } ; `all` force « tous les numéros ». */
export function parseSegment(s, all = false) {
  const m = String(s).match(/(\d+)\D*?-\s*(\d+)/);
  if (!m) return null;
  let a = +m[1], b = +m[2];
  if (a > b) [a, b] = [b, a];
  const parity = all || a === b || a % 2 !== b % 2 ? '' : a % 2 ? 'odd' : 'even';
  return { from_n: a, to_n: b, parity };
}

const titleCase = s => s.toLowerCase()
  .replace(/(^|[\s\-'’.])(\p{L})/gu, (m, p, c) => p + c.toUpperCase())
  .replace(/(?<=\s)(De|Du|Des|La|Le|Les|Aux|Au|En|Et|Sur|Sous|Lez)(?=\s)/g, m => m.toLowerCase())
  .replace(/(?<=\s)([LD])['’]\s*/g, (m, c) => c.toLowerCase() + "'");

/**
 * Texte d'une ligne (sans code postal ni tournée) → { street, segs, note }.
 * « COURTILAS RUE DES » → « Rue des Courtilas » ; un nom déjà dans l'ordre courant est conservé tel quel.
 */
export function parseBoardText(text) {
  let t = String(text ?? '').replace(/\s+/g, ' ').trim(), segs = [], note = '';
  const tr = t.match(TRAIL);
  if (tr) {
    segs = tr[1].split('/').map(s => parseSegment(s, !!tr[2])).filter(Boolean);
    t = t.slice(0, tr.index).trim();
  }
  // « RUE D'EN » : l'article élidé est séparé du mot suivant pour être reconnu (« D' » + « EN »).
  const tok = t.replace(/(^|\s)([DdLl])['’]\s*(?=\S)/g, "$1$2' ").split(' ').filter(Boolean);
  // Dernier mot « type de voie » suivi uniquement d'articles (puis, pour les lignes spéciales, d'un numéro).
  for (let i = tok.length - 1; i > 0; i--) {
    if (!TYPES.has(key(tok[i]))) continue;
    let j = i + 1;
    while (j < tok.length && ARTICLES.has(key(tok[j]))) j++;
    const special = j < tok.length && /^\d+[A-Za-z]?$/.test(tok[j]);
    if (j < tok.length && !special) continue;
    if (i === 1 && NO_ROTATE.has(key(tok[0]))) break;
    if (special) {                                   // « … RUE DE 127 ATELIER 85 ASBL » : ce numéro seulement
      const n = parseInt(tok[j], 10);
      segs = [{ from_n: n, to_n: n, parity: '' }];
      note = tok.slice(j + 1).join(' ');
    }
    t = titleCase([tok[i], ...tok.slice(i + 1, j), ...tok.slice(0, i)].join(' '));
    return { street: t, segs, note };
  }
  // Pas de type à la fin : nom conservé (mis en casse courante s'il est tout en capitales).
  return { street: /\p{Ll}/u.test(t) ? t : titleCase(t), segs, note };
}

const OLD_LINE = /^\s*(\d{4,5})\s+(.+?)\s+(?:de\s+)?(\d+)\s*(?:a|à|-)\s*(\d+)\s*(?:--|—|–|-|:)\s*tourn[ée]e\s*(\w+)/i;
const BOARD_LINE = /^\s*\??\s*(\d{4})\s*[;|,\s]\s*(\d{1,3}[A-Za-z]?)\s*[;|,\s]\s*(\S.*)$/;

/**
 * Texte du tableau → plages { cp, city, street, from_n, to_n, parity, tournee, source }.
 * Accepte les lignes du tableau de tri (« 5620 009 ANTHÉE RUE D' 2-146 / 1-147 ») et l'ancien format
 * (« 5500 rue de l'oublie de 1 a 5 -- tournée 1 »). Un « ? » en début de ligne (ligne à vérifier) est ignoré.
 * Les lignes non reconnues sont ignorées.
 */
export function parseTable(text, city = '') {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    let m = line.match(OLD_LINE);
    if (m) {
      let from_n = +m[3], to_n = +m[4];
      if (from_n > to_n) [from_n, to_n] = [to_n, from_n];
      out.push({ cp: m[1], city, street: m[2].trim(), from_n, to_n, parity: '', tournee: m[5], source: 'table' });
      continue;
    }
    if (!(m = line.match(BOARD_LINE))) continue;
    const { street, segs } = parseBoardText(m[3]);
    if (!street) continue;
    for (const s of segs.length ? segs : [{ from_n: WHOLE[0], to_n: WHOLE[1], parity: '' }])
      out.push({ cp: m[1], city, street, ...s, tournee: m[2], source: 'table' });
  }
  return out;
}

/** Plages → lignes de texte au format du tableau de tri (une ligne par rue et par tournée). Sans les plages apprises. */
export function formatTable(ranges) {
  const lines = new Map();
  for (const r of ranges) {
    if (r.source === 'learned') continue;
    // « tous » : plage de tous les numéros dont les bornes ont la même parité (sinon elle serait relue paire ou impaire).
    const all = !r.parity && !isWhole(r) && r.from_n !== r.to_n && r.from_n % 2 === r.to_n % 2;
    const k = [r.cp, r.tournee, r.street, all].join('|');
    if (!lines.has(k)) lines.set(k, { head: `${r.cp} ${r.tournee} ${r.street}`, segs: [], all });
    if (!isWhole(r)) lines.get(k).segs.push(`${r.from_n}-${r.to_n}`);
  }
  return [...lines.values()].map(l => l.head + (l.segs.length ? ' ' + l.segs.join(' / ') + (l.all ? ' tous' : '') : '')).join('\n');
}

/** Le numéro est-il dans la plage (bornes et parité) ? */
export const inRange = (num, r) =>
  num != null && num >= r.from_n && num <= r.to_n && (!r.parity || (num % 2 === 0) === (r.parity === 'even'));

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
 * Le numéro ne compte que si la rue ressemble (≥ 0,8) : sur un grand tableau, un numéro « dans la plage » d'une
 * autre rue ne doit pas l'emporter sur la bonne rue. À égalité, la plage la plus étroite gagne
 * (« 63-63 », numéro isolé, passe avant « 1-123 »).
 * Retourne { e, s, p, n, score } ou null si `ranges` est vide.
 */
export function match(a, ranges) {
  let best = null, bestTie = 0;
  const street = norm(a.street);
  for (const e of ranges) {
    const s = simNorm(street, normOf(e));
    const p = a.cp && a.cp === e.cp ? 1 : 0;
    const n = inRange(a.num, e) ? 1 : 0;
    const learned = e.source === 'learned';
    const score = 0.5 * s + 0.25 * p + (s >= 0.8 ? 0.25 * n : 0) + (learned && n && s > 0.8 ? 0.01 : 0);
    const tie = n ? 1 / (1 + e.to_n - e.from_n) : 0;
    if (!best || score > best.score + 1e-9 || (score > best.score - 1e-9 && tie > bestTie)) { best = { e, s, p, n, score }; bestTie = tie; }
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
    st.get(key).push(e.parity ? [e.from_n, e.to_n, e.parity] : [e.from_n, e.to_n]);
  }
  return [...by.keys()]
    .sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }))
    .map(t => ({ tournee: t, streets: [...by.get(t)].map(([key, r]) => ({ key, ranges: r })) }));
}

const STREET_TYPE = /^(rue|ruelle|avenue|av|place|allee|chemin|route|quartier|boulevard|bd|impasse|chaussee|clos|sentier|cite|residence|tienne|square|quai|dreve|voie|cour|passage|straat|laan|steenweg|weg|plein)\s+/;
const streetCore = s => s.replace(STREET_TYPE, '');

/**
 * Recherche de rues dans le tableau : « gueule du loup », « rue de namur », « namur 5600 », avec une faute légère.
 * Retourne [{ cp, street, score, tours: [{ tournee, ranges: [[from, to, parité?], …] }] }], les meilleures d'abord.
 */
export function searchStreets(q, ranges, limit = 30) {
  const cp = String(q ?? '').match(/\b\d{4}\b/)?.[0] ?? '';
  const nq = norm(String(q ?? '').replace(/\b\d{4}\b/, ''));
  if (nq.length < 3 || !streetCore(nq + ' ').trim()) return [];   // « rue » seul : trop vague
  const cq = streetCore(nq), byStreet = new Map();
  for (const r of ranges) {
    if (cp && r.cp !== cp) continue;
    const key = r.cp + '|' + r.street;
    let hit = byStreet.get(key);
    if (!hit) {
      const ns = norm(r.street), cs = streetCore(ns);
      // Nom contenu dans la rue (« namur » dans « rue de namur »), ou ressemblant (faute de frappe), avec ou sans le type.
      const score = ns === nq || cs === cq ? 1
        : ns.includes(nq) || (cq.length >= 3 && cs.includes(cq)) ? 0.9
          : Math.max(simNorm(ns, nq), simNorm(cs, cq) * 0.97);
      if (score < 0.75) { byStreet.set(key, null); continue; }
      byStreet.set(key, hit = { cp: r.cp, street: r.street, score, tours: new Map() });
    }
    if (!hit) continue;
    if (!hit.tours.has(r.tournee)) hit.tours.set(r.tournee, []);
    hit.tours.get(r.tournee).push(r.parity ? [r.from_n, r.to_n, r.parity] : [r.from_n, r.to_n]);
  }
  return [...byStreet.values()].filter(Boolean)
    .sort((a, b) => b.score - a.score || a.street.localeCompare(b.street, 'fr') || a.cp.localeCompare(b.cp))
    .slice(0, limit)
    .map(h => ({ ...h, tours: [...h.tours].sort((a, b) => a[0].localeCompare(b[0], 'fr', { numeric: true })).map(([tournee, rs]) => ({ tournee, ranges: rs })) }));
}

/** [from, to, parité?] → « 3 », « 1–5 », « 2–146 pairs », « toute la rue ». */
export const fmtRange = ([a, b, parity]) =>
  a <= WHOLE[0] && b >= WHOLE[1] ? 'toute la rue'
    : a === b ? String(a)
      : `${a}–${b}${parity === 'even' ? ' pairs' : parity === 'odd' ? ' impairs' : ''}`;
