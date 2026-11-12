// Lecture de fichiers CSV en flux (BeST Address fait plusieurs centaines de Mo) : séparateur détecté, guillemets gérés.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

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

/** Séparateur le plus fréquent dans la ligne d'en-tête. */
export const detectSep = header => [';', ',', '\t'].sort((a, b) => header.split(b).length - header.split(a).length)[0];

/** Itère les lignes d'un CSV sous forme d'objets { en-tête en minuscules: valeur }. */
export async function* readCsv(file) {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let head = null, sep = ',';
  for await (let line of rl) {
    if (!head) {
      line = line.replace(/^﻿/, '');
      sep = detectSep(line);
      head = splitCsv(line, sep).map(h => h.trim().toLowerCase());
      continue;
    }
    if (!line.trim()) continue;
    const v = splitCsv(line, sep), o = {};
    head.forEach((h, i) => { o[h] = (v[i] ?? '').trim(); });
    yield o;
  }
}
