// Construit server/data/gazetteer.json à partir de bases ouvertes :
//   --best  <fichier.csv>…   BeST Address (BOSA, licence CC-BY 4.0) : openaddress-bewal.csv, -bevlg.csv, -bebru.csv
//   --bpost <fichier.csv>    codes postaux bpost exportés en CSV (colonnes : code postal ; localité)
//   --osm                    OpenStreetMap (ODbL) via l'API Overpass : rues portant addr:postcode
//   --cp 5500,5501,…         codes postaux à garder (fortement conseillé : vos tournées seulement)
//   --out <fichier.json>     défaut : server/data/gazetteer.json
// Le tableau des tournées (Supabase) est ajouté en direct par le serveur, inutile de l'importer.
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGazetteer } from './gazetteer.mjs';

/** Découpe une ligne CSV (guillemets doubles, séparateur donné). */
export function splitCsv(line, sep) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === sep) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
const detectSep = header => [';', ',', '\t'].sort((a, b) => header.split(b).length - header.split(a).length)[0];

async function* rows(file) {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let head = null, sep = ',';
  for await (let line of rl) {
    if (!head) { line = line.replace(/^﻿/, ''); sep = detectSep(line); head = splitCsv(line, sep).map(h => h.trim().toLowerCase()); continue; }
    if (!line.trim()) continue;
    const v = splitCsv(line, sep), o = {};
    head.forEach((h, i) => { o[h] = (v[i] ?? '').trim(); });
    yield o;
  }
}
const pick = (o, ...names) => { for (const n of names) if (o[n]) return o[n]; return ''; };

/** Une ligne BeST → entrées de rue (une par langue disponible). */
export function bestEntries(o) {
  const cp = pick(o, 'postcode', 'postal_code', 'postalcode', 'zipcode');
  const city = pick(o, 'postname_fr', 'municipality_name_fr', 'postname_nl', 'municipality_name_nl', 'postname_de', 'municipality_name_de');
  const num = pick(o, 'house_number', 'housenumber');
  const status = pick(o, 'status');
  if (status && !/current|actuel/i.test(status)) return [];
  return [...new Set(['streetname_fr', 'streetname_nl', 'streetname_de', 'streetname'].map(k => o[k]).filter(Boolean))]
    .map(street => ({ cp, street, city, num, src: 'BeST' }));
}

/** Une ligne bpost (ou « cp;localité ») → { cp, city }. */
export function bpostEntry(o) {
  const vals = Object.values(o);
  const cp = pick(o, 'code postal', 'postcode', 'cp', 'zipcode') || vals.find(v => /^\d{4}$/.test(v)) || '';
  const city = pick(o, 'localité', 'localite', 'plaatsnaam', 'ortschaft', 'ville', 'city') || vals.find(v => v && !/^\d+$/.test(v)) || '';
  return { cp, city };
}

async function overpass(cps) {
  const q = `[out:json][timeout:300];
area["ISO3166-1"="BE"][admin_level=2]->.be;
nwr["addr:postcode"~"^(${cps.join('|')})$"]["addr:street"](area.be);
out tags;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'identification-de-tournee/1.0 (import)' },
    body: 'data=' + encodeURIComponent(q),
  });
  if (!res.ok) throw new Error('Overpass HTTP ' + res.status);
  return (await res.json()).elements ?? [];
}

async function main() {
  const args = process.argv.slice(2), opt = { best: [], bpost: [], osm: false, cp: null, out: join(dirname(fileURLToPath(import.meta.url)), 'data', 'gazetteer.json') };
  for (let i = 0; i < args.length; i++) {
    const a = args[i], next = () => args[++i];
    if (a === '--best') { while (args[i + 1] && !args[i + 1].startsWith('--')) opt.best.push(next()); }
    else if (a === '--bpost') { while (args[i + 1] && !args[i + 1].startsWith('--')) opt.bpost.push(next()); }
    else if (a === '--osm') opt.osm = true;
    else if (a === '--cp') opt.cp = new Set(next().split(/[,\s]+/).filter(Boolean));
    else if (a === '--out') opt.out = next();
    else { console.error('Option inconnue : ' + a); process.exit(1); }
  }
  if (!opt.best.length && !opt.bpost.length && !opt.osm) {
    console.error('Rien à importer. Exemple :\n  node server/import.mjs --cp 5500,5501 --best openaddress-bewal.csv --bpost zipcodes.csv --osm');
    process.exit(1);
  }
  if (opt.osm && !opt.cp) { console.error('--osm exige --cp (une requête sur toute la Belgique serait trop lourde).'); process.exit(1); }
  const keep = cp => !opt.cp || opt.cp.has(cp);
  const g = createGazetteer();

  for (const f of opt.bpost) {
    let n = 0;
    for await (const o of rows(f)) { const e = bpostEntry(o); if (keep(e.cp)) { g.addLocality(e.cp, e.city); n++; } }
    console.log(`bpost ${f} : ${n} localités`);
  }
  for (const f of opt.best) {
    let n = 0;
    for await (const o of rows(f)) for (const e of bestEntries(o)) if (keep(e.cp)) { g.addStreet(e); n++; }
    console.log(`BeST ${f} : ${n} adresses retenues`);
  }
  if (opt.osm) {
    const cps = [...opt.cp];
    for (let i = 0; i < cps.length; i += 20) {
      const els = await overpass(cps.slice(i, i + 20));
      for (const el of els) {
        const t = el.tags ?? {};
        g.addStreet({ cp: t['addr:postcode'], street: t['addr:street'], city: t['addr:city'] || '', num: t['addr:housenumber'], src: 'OSM' });
      }
      console.log(`OSM ${cps.slice(i, i + 20).join(',')} : ${els.length} objets`);
    }
  }
  mkdirSync(dirname(opt.out), { recursive: true });
  writeFileSync(opt.out, JSON.stringify(g.toJSON()));
  console.log(`✔ ${opt.out} :`, g.size());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main().catch(e => { console.error(e); process.exit(1); });
