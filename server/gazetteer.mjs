// Répertoire des rues et localités (BeST Address, bpost, OpenStreetMap, tableau des tournées)
// et correction d'une adresse lue. Logique pure : testable sous Node sans réseau.
import { norm, sim } from '../src/js/match.js';

const ABBR = [
  [/\bav\b/g, 'avenue'], [/\bbd\b/g, 'boulevard'], [/\bbld\b/g, 'boulevard'], [/\bpl\b/g, 'place'],
  [/\bchee\b/g, 'chaussee'], [/\bimp\b/g, 'impasse'], [/\bst\b/g, 'saint'], [/\bste\b/g, 'sainte'],
];
const TYPES = /^(rue|avenue|chaussee|chemin|place|boulevard|route|impasse|quai|allee|square|clos|sentier|ruelle|rempart|drève|dreve|straat|laan|steenweg|weg|plein)\s+/;

/** Normalisation des noms de rue : celle de match.js + abréviations courantes développées. */
export const normStreet = s => ABBR.reduce((x, [re, to]) => x.replace(re, to), norm(s));
const core = s => s.replace(TYPES, '');

/** Similarité de deux noms de rue déjà normalisés : nom complet, ou nom sans le type de voie (légèrement pénalisé). */
export function streetSim(a, b) {
  if (!a || !b) return 0;
  const full = sim(a, b), ca = core(a), cb = core(b);
  return ca !== a || cb !== b ? Math.max(full, sim(ca, cb) * 0.95) : full;
}

export function createGazetteer() {
  const streets = new Map();   // cp → Map(clé normalisée → { cp, street, city, min, max, src:Set })
  const table = new Map();     // idem, pour le tableau des tournées (remplacé à chaque rafraîchissement)
  const names = new Map();     // cp → Set(noms de localité)
  const served = new Set();    // codes postaux réellement desservis (ceux du tableau des tournées)

  const put = (store, { cp, street, city = '', num = null, min = null, max = null, src }) => {
    cp = String(cp ?? '').trim(); street = String(street ?? '').trim();
    if (!/^\d{4}$/.test(cp) || !street) return;
    const k = normStreet(street); if (!k) return;
    if (!store.has(cp)) store.set(cp, new Map());
    const m = store.get(cp);
    const e = m.get(k) ?? { cp, street, city, min: null, max: null, src: new Set() };
    for (const n of [num, min, max]) {
      const v = parseInt(n, 10);
      if (Number.isFinite(v) && v > 0) { e.min = e.min == null ? v : Math.min(e.min, v); e.max = e.max == null ? v : Math.max(e.max, v); }
    }
    if (!e.city && city) e.city = city;
    if (src) e.src.add(src);
    m.set(k, e);
    if (city) addLocality(cp, city);
  };

  function addLocality(cp, city) {
    cp = String(cp ?? '').trim(); city = String(city ?? '').trim();
    if (!/^\d{4}$/.test(cp) || !city) return;
    if (!names.has(cp)) names.set(cp, new Set());
    names.get(cp).add(city);
  }

  const addStreet = s => put(streets, s);

  /** Remplace les rues issues du tableau (plages 'table' et 'learned' de Supabase). */
  function setTable(ranges = [], localities = []) {
    table.clear();
    served.clear();
    for (const x of [...ranges, ...localities]) if (/^\d{4}$/.test(String(x.cp ?? '').trim())) served.add(String(x.cp).trim());
    for (const r of ranges) put(table, { cp: r.cp, street: r.street, city: r.city, min: r.from_n, max: r.to_n, src: r.source === 'learned' ? 'appris' : 'tableau' });
    for (const l of localities) addLocality(l.cp, l.city);
  }

  const cps = () => new Set([...streets.keys(), ...table.keys(), ...names.keys()]);
  const hasCp = cp => streets.has(cp) || table.has(cp) || names.has(cp);
  const citiesOf = cp => [...(names.get(cp) ?? [])];

  /** Codes postaux dont un nom de localité ressemble à `city` (≥ 0,85). */
  function cpsForCity(city) {
    const out = [];
    if (!norm(city)) return out;
    for (const [cp, set] of names) {
      const s = Math.max(...[...set].map(n => sim(n, city)));
      if (s >= 0.8) out.push({ cp, s });
    }
    return out.sort((a, b) => b.s - a.s).map(x => x.cp);
  }

  /** Meilleures rues pour `street` dans les codes postaux donnés (tous si vide). Le tableau prime à score égal. */
  function streetCandidates(street, inCps = [], k = 5) {
    const q = normStreet(street);
    if (!q) return [];
    const list = inCps.length ? inCps : [...cps()];
    const best = new Map();
    for (const cp of list) {
      for (const [store, bonus] of [[table, 0.005], [streets, 0]]) {
        for (const [key, e] of store.get(cp) ?? []) {
          const score = streetSim(q, key) + bonus, id = cp + '|' + key;
          const prev = best.get(id);
          if (!prev || score > prev.score) best.set(id, { ...e, src: [...new Set([...(prev?.src ?? []), ...e.src])], score });
          else prev.src = [...new Set([...prev.src, ...e.src])];
        }
      }
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, k);
  }

  const size = () => {
    let n = 0;
    for (const m of streets.values()) n += m.size;
    return { streets: n, table: [...table.values()].reduce((a, m) => a + m.size, 0), cps: cps().size };
  };

  /** Export sérialisable (fichier produit par server/import.mjs). */
  const toJSON = () => ({
    version: 1,
    streets: [...streets.values()].flatMap(m => [...m.values()].map(e => ({ cp: e.cp, street: e.street, city: e.city, min: e.min, max: e.max, src: [...e.src] }))),
    localities: [...names].flatMap(([cp, set]) => [...set].map(city => ({ cp, city }))),
  });

  return { addStreet, addLocality, setTable, hasCp, citiesOf, cpsForCity, streetCandidates, size, toJSON, cps, servedCps: () => new Set(served) };
}

/** Recharge un répertoire depuis l'objet produit par toJSON(). */
export function loadGazetteer(data) {
  const g = createGazetteer();
  for (const l of data?.localities ?? []) g.addLocality(l.cp, l.city);
  for (const s of data?.streets ?? []) for (const src of s.src?.length ? s.src : [undefined]) g.addStreet({ ...s, src });
  return g;
}

/** Seuils de correction de la rue. */
export const STREET_SURE = 0.9, STREET_OK = 0.72, STREET_GAP = 0.08;

/**
 * Corrige une adresse lue { num, street, cp, city } à l'aide du répertoire.
 * Retourne { addr, corrections: [texte], ambiguous: [candidats] | null, numberInRange: bool | null }.
 * `ambiguous` n'est rempli que si plusieurs rues plausibles restent proches : le serveur peut alors
 * redemander au modèle de vision de choisir en regardant l'image.
 */
export function correctAddress(a, gaz) {
  const addr = { num: a.num ?? null, street: a.street ?? '', cp: a.cp ?? '', city: a.city ?? '' };
  const corrections = [];
  let ambiguous = null, numberInRange = null;

  // 1. Code postal : inconnu ou absent → déduit de la localité si elle est univoque ; sinon la rue
  //    sera cherchée seulement dans les codes postaux de cette localité (Bruxelles, Namur, Gent…).
  let searchCps = [];
  if (!gaz.hasCp(addr.cp)) {
    const byCity = gaz.cpsForCity(addr.city);
    if (byCity.length === 1) { corrections.push(`Code postal ${addr.cp || '(absent)'} → ${byCity[0]} (d'après « ${addr.city} »)`); addr.cp = byCity[0]; }
    else searchCps = byCity;
  }
  if (gaz.hasCp(addr.cp)) searchCps = [addr.cp];

  // 2. Rue : la plus proche dans le code postal (ou partout si le code postal est inconnu).
  if (addr.street) {
    const c = gaz.streetCandidates(addr.street, searchCps, 8);
    const [b, s2] = c;
    // Même nom de rue dans plusieurs codes postaux candidats : la rue est sûre, mais pas le code postal.
    const sameName = s2 && normStreet(b.street) === normStreet(s2.street);
    const clear = b && (!s2 || b.score - s2.score >= STREET_GAP || (sameName && b.cp === s2.cp));
    if (b && (b.score >= STREET_SURE || (b.score >= STREET_OK && clear))) {
      if (normStreet(b.street) !== normStreet(addr.street)) corrections.push(`Rue « ${addr.street} » → « ${b.street} » (${Math.round(b.score * 100)} %, ${b.src.join('/') || 'répertoire'})`);
      addr.street = b.street;
      // Le code postal n'est déduit de la rue que s'il est univoque : une seule rue de ce nom parmi les
      // candidats, ou une seule dont les numéros connus contiennent le numéro lu.
      const twins = c.filter(x => normStreet(x.street) === normStreet(b.street));
      const inRange = addr.num == null ? [] : twins.filter(x => x.min != null && addr.num >= x.min && addr.num <= x.max);
      const pick = twins.length === 1 ? b : inRange.length === 1 ? inRange[0] : null;
      if (pick && pick.cp !== addr.cp) { corrections.push(`Code postal ${addr.cp || '(absent)'} → ${pick.cp} (d'après la rue)`); addr.cp = pick.cp; }
      else if (!pick && !gaz.hasCp(addr.cp)) corrections.push(`Rue présente dans plusieurs codes postaux (${twins.map(x => x.cp).join(', ')}) : code postal à vérifier`);
      const ref = pick ?? b;
      if (addr.num != null && ref.min != null) numberInRange = addr.num >= ref.min && addr.num <= ref.max;
    } else if (b && b.score >= 0.5) {
      ambiguous = c.filter(x => x.score >= 0.5);
    }
  }

  // 3. Localité : nom canonique du code postal retenu.
  fixCity(addr, gaz, corrections);
  return { addr, corrections, ambiguous, numberInRange };
}

/** Remplace la localité par le nom officiel le plus proche pour le code postal (ou l'ajoute si absente). */
export function fixCity(addr, gaz, corrections) {
  const known = gaz.citiesOf(addr.cp);
  if (!known.length) return addr;
  const ranked = known.map(n => ({ n, s: addr.city ? sim(n, addr.city) : 0 })).sort((x, y) => y.s - x.s);
  if (!addr.city) { addr.city = ranked[0].n; corrections.push(`Localité ajoutée : ${addr.city}`); }
  else if (ranked[0].s >= 0.6 && ranked[0].n !== addr.city) { corrections.push(`Localité « ${addr.city} » → « ${ranked[0].n} »`); addr.city = ranked[0].n; }
  return addr;
}
