// Village de chaque rue du tableau (BeST : « Sautour », « Neuville »… dans le code postal 5600 Philippeville).
// Demandé une fois au serveur puis gardé sur le téléphone : la recherche par localité marche ensuite hors ligne.
import { norm } from './match.js';

const KEY = 'villages';
let cache = null;   // { cp: { rue normalisée: village } }

const load = () => { if (!cache) { try { cache = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { cache = {}; } } return cache; };

/** Enregistre [{ cp, street, city }] reçu du serveur (remplace les codes postaux concernés). */
export function storeVillages(list) {
  const c = load();
  for (const cp of new Set(list.map(s => s.cp))) c[cp] = {};
  for (const s of list) if (s.city) c[s.cp][norm(s.street)] = s.city;
  try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* stockage plein : la recherche se fera par code postal */ }
}

/** Village d'une plage du tableau, ou '' s'il est inconnu. */
export const villageOf = r => load()[r.cp]?.[norm(r.street)] ?? '';

/** Codes postaux déjà connus (pour ne redemander que les nouveaux). */
export const knownCps = () => Object.keys(load());

/** Noms de villages connus (pour la recherche) : Map(nom → Set(cp)). */
export function villageNames() {
  const m = new Map();
  for (const [cp, streets] of Object.entries(load())) for (const v of Object.values(streets)) {
    if (!m.has(v)) m.set(v, new Set());
    m.get(v).add(cp);
  }
  return m;
}
