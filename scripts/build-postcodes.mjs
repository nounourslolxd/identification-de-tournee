// Fusionne les listes officielles de codes postaux belges en src/data/postcodes.json :
//   { "5500": ["Dinant", "Anseremme", …], … }  — premier nom = nom principal (bpost FR si disponible).
// Sources (à télécharger, voir docs/SERVEUR-LECTURE.md) :
//   --bpost <csv>…  listes bpost (zipcodes_alpha_fr / _nl, enregistrées en CSV ;) : localité + commune principale
//   --best  <csv>…  BeST Address (openaddress-bevlg/bebru/bewal.csv) : postname_fr/nl/de, municipality_name_fr/nl/de
// Usage : node scripts/build-postcodes.mjs --bpost fr.csv nl.csv --best bevlg.csv bebru.csv bewal.csv
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCsv } from '../server/csv.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** « ERPE-MERE » → « Erpe-Mere », « LA LOUVIERE » → « La Louviere » (les communes principales bpost sont en capitales). */
export const titleCase = s => String(s).toLowerCase().replace(/(^|[\s\-'’(])(\p{L})/gu, (m, p, c) => p + c.toUpperCase());

/**
 * Nettoie un nom de localité : caractères Windows-1252 mal décodés (« Petit-R\x9Culx » → « Petit-Rœulx »),
 * précision entre parenthèses (« Cuesmes (7000) », « Domaine Miaflower (Anthée) »), soulignés parasites.
 */
export function cleanName(s) {
  return String(s ?? '')
    .replace(/\x9C/g, 'œ').replace(/\x8C/g, 'Œ').replace(/[\x80-\x9F]/g, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** Ajoute un nom à l'index en évitant les doublons (comparaison sans casse ni accents). */
export function addName(map, cp, name, pri = false) {
  cp = String(cp ?? '').trim(); name = cleanName(name);
  if (!/^\d{4}$/.test(cp) || !name) return;
  const key = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const list = map.get(cp) ?? [];
  const i = list.findIndex(n => key(n) === key(name));
  if (i < 0) pri ? list.unshift(name) : list.push(name);
  else if (/[a-z]/.test(name) && !/[a-z]/.test(list[i])) list[i] = name; // préfère « Dinant » à « DINANT »
  map.set(cp, list);
}

async function main() {
  const args = process.argv.slice(2), src = { bpost: [], best: [] };
  let cur = null, out = join(root, 'src', 'data', 'postcodes.json');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') out = args[++i];
    else if (args[i].startsWith('--')) cur = src[args[i].slice(2)] ?? (console.error('Option inconnue', args[i]), process.exit(1));
    else cur?.push(args[i]);
  }
  const map = new Map(), stats = {}, mainOf = new Map();

  for (const f of src.bpost) {
    let n = 0;
    for await (const o of readCsv(f)) {
      const cp = o['code postal'] ?? o.postcode;
      addName(map, cp, o['localité'] ?? o.plaatsnaam, false);
      const main = o['commune principale'] ?? o.hoofdgemeente;
      if (main) { addName(map, cp, titleCase(main)); if (!mainOf.has(cp)) mainOf.set(cp, titleCase(main)); }
      n++;
    }
    stats[f.split(/[\\/]/).pop()] = n;
  }
  for (const f of src.best) {
    let n = 0;
    const seen = new Set();
    for await (const o of readCsv(f)) {
      const cp = o.postcode ?? o.postal_code;
      const names = [o.postname_fr, o.postname_nl, o.postname_de, o.municipality_name_fr, o.municipality_name_nl, o.municipality_name_de].filter(Boolean);
      const k = cp + '|' + names.join('|');
      if (seen.has(k)) continue;
      seen.add(k);
      // BeST Flandre regroupe plusieurs localités : « ASSE/Bekkerzeel/Kobbegem/Mollem ».
      for (const nm of names.flatMap(x => x.split('/')).map(x => x.trim()).filter(Boolean))
        addName(map, cp, /^[^a-zà-ÿ]*$/.test(nm) ? titleCase(nm) : nm);
      n++;
    }
    stats[f.split(/[\\/]/).pop()] = n + ' combinaisons';
  }

  // Nom principal en tête : la commune principale bpost si elle figure parmi les noms du code postal.
  const key = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  for (const [cp, list] of map) {
    const m = mainOf.get(cp), i = m ? list.findIndex(n => key(n) === key(m)) : -1;
    if (i > 0) list.unshift(...list.splice(i, 1));
  }
  const obj = Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b)));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(obj));
  const names = Object.values(obj).reduce((a, l) => a + l.length, 0);
  console.log(stats);
  console.log(`✔ ${out} : ${Object.keys(obj).length} codes postaux, ${names} noms`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main().catch(e => { console.error(e); process.exit(1); });
