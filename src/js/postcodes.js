// Liste nationale des codes postaux belges (bpost + BeST Address), embarquée : fonctionne hors ligne.
// Fichier généré par scripts/build-postcodes.mjs → data/postcodes.json : { "5500": ["Dinant", "Anseremme", …] }

let national = new Map();

/** Objet JSON → Map(cp → Set(noms)). */
export const toIndex = obj => new Map(Object.entries(obj ?? {}).map(([cp, names]) => [cp, new Set(names)]));

export async function loadPostcodes(url = new URL('data/postcodes.json', document.baseURI)) {
  try {
    const res = await fetch(url);
    if (res.ok) setNational(toIndex(await res.json()));
  } catch (e) { console.warn('Liste des codes postaux indisponible', e); }
  return national.size;
}

export function setNational(idx) { national = idx; merged = null; }
export const nationalIndex = () => national;

/** Index national complété par un index local (localités du tableau, des plages…). */
export function withNational(local) {
  const m = new Map([...national].map(([cp, s]) => [cp, new Set(s)]));
  for (const [cp, s] of local) {
    if (!m.has(cp)) m.set(cp, new Set());
    for (const n of s) m.get(cp).add(n);
  }
  return m;
}

let merged = null;
/** Index complet, mis en cache : `buildLocal` n'est appelé que si les données ont changé (voir invalidateIndex). */
export const fullIndex = buildLocal => (merged ??= withNational(buildLocal()));
export const invalidateIndex = () => { merged = null; };

/** Nom principal d'un code postal (premier de la liste), ou ''. */
export const mainName = cp => [...(national.get(cp) ?? [])][0] ?? '';
