// Photo d'un tableau de tri → morceaux à lire (une colonne du tableau à la fois, par tranches d'une trentaine de lignes).
// Le modèle de vision lit très bien UNE colonne ; devant deux colonnes il n'en lit qu'une. On repère donc les colonnes
// grâce aux traits verticaux du tableau : chaque colonne commence par trois traits rapprochés (bord | code postal | tournée |).

import { sim } from './match.js';

/* ------------------------------------------------------------------ */
/* Fonctions pures (testées sous Node)                                  */
/* ------------------------------------------------------------------ */

/** Seuil « sombre » : fraction de la médiane (le papier clair domine l'image). */
export function darkThreshold(gray, k = 0.68) {
  const hist = new Uint32Array(256);
  const step = Math.max(1, Math.floor(gray.length / 200000));
  let n = 0;
  for (let i = 0; i < gray.length; i += step) { hist[gray[i]]++; n++; }
  let acc = 0, med = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n / 2) { med = v; break; } }
  return med * k;
}

/**
 * Compte, pour chaque bande horizontale et chaque abscisse, les pixels appartenant à un long trait vertical.
 * Un pixel « de trait » est plus sombre que ses deux voisins à gauche et à droite (quelle que soit la couleur de la
 * ligne du tableau : blanche, rose, verte, orange). Un trait peut dériver d'un pixel par ligne (photo penchée) et
 * survivre à de petites coupures ; le texte, lui, ne forme jamais de longs traits (il s'efface entre deux lignes).
 * Retourne { bands: [Uint16Array(w)], bandH }.
 */
export function verticalRuleHist(gray, w, h, { bandH, minRun, delta = 6, leak = 4 }) {
  const nb = Math.ceil(h / bandH), d = Math.max(2, Math.round(w / 1500));
  const bands = Array.from({ length: nb }, () => new Uint16Array(w));
  // Deux passages (haut → bas, puis bas → haut) : un trait est reconnu dès son début comme jusqu'à sa fin.
  for (const dir of [1, -1]) {
    let prev = new Uint16Array(w), cur = new Uint16Array(w);
    for (let i = 0; i < h; i++) {
      const y = dir > 0 ? i : h - 1 - i, row = y * w, hist = bands[Math.floor(y / bandH)];
      for (let x = 0; x < w; x++) {
        const v = gray[row + x] + delta;
        if (x >= d && x < w - d && v < gray[row + x - d] && v < gray[row + x + d]) {
          let m = prev[x];
          if (prev[x - 1] > m) m = prev[x - 1];
          if (prev[x + 1] > m) m = prev[x + 1];
          const r = m < 60000 ? m + 1 : m;
          cur[x] = r;
          if (r >= minRun) hist[x]++;
        } else cur[x] = prev[x] > leak ? prev[x] - leak : 0;
      }
      [prev, cur] = [cur, prev];
    }
  }
  return { bands, bandH };
}

/**
 * Relie les traits d'une bande à l'autre et comble les trous : un trait manqué dans une bande est replacé
 * entre ses positions dans les bandes voisines. Retourne, par bande, la liste triée des abscisses.
 */
export function trackRules(perBand, tol, { maxSkip = 4, minLen = 4 } = {}) {
  const tracks = [];
  perBand.forEach((xs, b) => {
    for (const x of xs) {
      let best = null;
      for (const t of tracks) {
        const last = t.pts.at(-1);
        if (last.b === b || b - last.b > maxSkip) continue;
        const dx = Math.abs(last.x - x);
        if (dx <= tol && (!best || dx < Math.abs(best.pts.at(-1).x - x))) best = t;
      }
      if (best) best.pts.push({ b, x }); else tracks.push({ pts: [{ b, x }] });
    }
  });
  const out = perBand.map(() => []);
  for (const t of tracks) {
    if (t.pts.length < minLen) continue;
    for (let i = 0; i < t.pts.length; i++) {
      const p = t.pts[i], q = t.pts[i + 1];
      out[p.b].push(p.x);
      if (q) for (let b = p.b + 1; b < q.b; b++) out[b].push(Math.round(p.x + (q.x - p.x) * (b - p.b) / (q.b - p.b)));
    }
  }
  return out.map(xs => xs.sort((a, b) => a - b));
}

/** Abscisses des traits verticaux d'une bande : pics de l'histogramme, regroupés s'ils se touchent. */
export function rulePositions(hist, minCount, maxGap = 4) {
  const out = [];
  let start = -1, last = -1, wsum = 0, sum = 0;
  const flush = () => { if (start >= 0) out.push(Math.round(wsum / sum)); start = -1; wsum = sum = 0; };
  for (let x = 0; x < hist.length; x++) {
    if (hist[x] < minCount) continue;
    if (start >= 0 && x - last > maxGap) flush();
    if (start < 0) start = x;
    last = x; wsum += x * hist[x]; sum += hist[x];
  }
  flush();
  return out;
}

/**
 * Colonnes du tableau à partir des traits : trois traits rapprochés et régulièrement espacés (bord, code postal, tournée)
 * suivis d'un grand vide (le nom de la rue). Retourne [{ x0, x1 }] ; x1 = début de la colonne suivante ou bord droit.
 */
export function columnsFromRules(lines, w) {
  const minD = w * 0.004, maxD = w * 0.035, starts = [];
  for (let i = 0; i + 2 < lines.length; i++) {
    const d1 = lines[i + 1] - lines[i], d2 = lines[i + 2] - lines[i + 1];
    if (d1 < minD || d2 < minD || d1 > maxD || d2 > maxD) continue;
    if (d1 / d2 < 0.55 || d1 / d2 > 1.8) continue;
    const next = lines[i + 3] ?? Infinity;
    if (next - lines[i + 2] < 3 * Math.max(d1, d2)) continue;
    starts.push({ x: lines[i], cell: (d1 + d2) / 2, right: next });
    i += 2;
  }
  return starts.map((s, k) => {
    const nextStart = starts[k + 1]?.x ?? Infinity;
    const x1 = Math.min(nextStart, Number.isFinite(s.right) ? s.right + 4 : w, w);
    return { x0: s.x, x1, cell: s.cell };
  });
}

const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

/**
 * Découpe l'image en morceaux { x, y, w, h, col, row } : une colonne du tableau par morceau, ~28 lignes de haut,
 * avec un recouvrement vertical de ~3 lignes pour qu'aucune ligne ne soit perdue à la coupe.
 * Retourne { tiles, columns } ; tiles est vide si aucune colonne n'a été reconnue.
 */
export function planTiles(gray, w, h) {
  const bandH = Math.max(40, Math.round(h / 40));
  const { bands } = verticalRuleHist(gray, w, h, { bandH, minRun: Math.round(bandH * 1.2) });
  const rules = trackRules(bands.map(hist => rulePositions(hist, Math.round(bandH * 0.5))), Math.max(6, w * 0.003), { minLen: 5 });
  const perBand = rules.map(xs => columnsFromRules(xs, w));
  const widths = perBand.flat().map(c => c.x1 - c.x0).filter(x => x > w * 0.04);
  if (!widths.length) return { tiles: [], columns: 0 };
  const colW = median(widths), cell = median(perBand.flat().map(c => c.cell));
  const pitch = cell / 1.8;                                   // hauteur d'une ligne ≈ largeur d'une case / 1,8
  const tileH = Math.round(pitch * 28), step = Math.round(pitch * 25), pad = Math.round(cell * 0.25);

  // Chaque bord gauche de colonne est une droite (la photo est penchée et en perspective, les colonnes restent droites).
  // 1. Suivi de bande en bande pour mesurer la pente ; 2. pente modélisée en fonction de x (perspective) ;
  // 3. chaque repère est ramené à mi-hauteur puis regroupé par colonne ; 4. une droite par colonne, sur toute la hauteur.
  const samples = [];
  perBand.forEach((cols, b) => {
    for (const c of cols) if (c.x1 - c.x0 >= colW * 0.5 && c.x1 - c.x0 <= colW * 1.6) samples.push({ x: c.x0, y: (b + 0.5) * bandH, b });
  });
  const tracks = [];
  for (const s of samples) {
    let t = tracks.find(t => Math.abs(t.at(-1).x - s.x) < colW * 0.3 && s.b - t.at(-1).b <= 6 && s.b !== t.at(-1).b);
    if (!t) tracks.push(t = []);
    t.push(s);
  }
  const slopes = tracks.filter(t => t.length >= 3).map(t => ({ x: t.reduce((a, s) => a + s.x, 0) / t.length, s: fitLine(t).slope }));
  const model = slopes.length >= 2 ? fitLine(slopes.map(p => ({ y: p.x, x: p.s }))) : { slope: 0, at: () => slopes[0]?.s ?? 0 };
  const slopeAt = x => model.at(x);
  const yRef = h / 2;
  const proj = samples.map(s => ({ ...s, xr: s.x - slopeAt(s.x) * (s.y - yRef) })).sort((a, b) => a.xr - b.xr);
  const groups = [];
  for (const s of proj) {
    const g = groups.at(-1);
    if (g && s.xr - g.at(-1).xr < colW * 0.35) g.push(s); else groups.push([s]);
  }
  // Un seul modèle de perspective pour tout le tableau : la pente d'une colonne dépend de sa position, pente = a + b·x.
  // Chaque colonne n'a alors qu'une inconnue (sa position à mi-hauteur), ce qui reste juste même là où elle a été
  // peu repérée (par exemple le haut de la dernière colonne). a et b sont réajustés sur tous les repères à la fois.
  const kept = groups.filter(g => g.length >= 3);
  if (!kept.length) return { tiles: [], columns: 0 };
  let a = slopeAt(0), b = slopeAt(1) - slopeAt(0);
  let mid = kept.map(g => median(g.map(s => s.xr)));
  for (let it = 0; it < 3; it++) {
    let suu = 0, suv = 0, svv = 0, sur = 0, svr = 0;
    kept.forEach((g, k) => {
      for (const s of g) {
        const u = s.y - yRef, v = mid[k] * u, r = s.x - mid[k];
        suu += u * u; suv += u * v; svv += v * v; sur += u * r; svr += v * r;
      }
    });
    const det = suu * svv - suv * suv;
    if (kept.length >= 2 && Math.abs(det) > 1e-6) { a = (sur * svv - svr * suv) / det; b = (svr * suu - sur * suv) / det; }
    else if (suu) { a = sur / suu; b = 0; }
    mid = kept.map((g, k) => median(g.map(s => s.x - (a + b * mid[k]) * (s.y - yRef))));
  }
  const lines = mid.map(mx => ({ slope: a + b * mx, at: y => mx + (a + b * mx) * (y - yRef) }));

  // Hauteur du tableau : bandes où l'on voit des traits.
  const withRules = rules.map((xs, b) => (xs.length >= 6 ? b : -1)).filter(b => b >= 0);
  const yTop = Math.max(0, withRules[0] * bandH - Math.round(pitch * 2)), yBot = Math.min(h, (withRules.at(-1) + 1) * bandH + Math.round(pitch * 2));

  const tiles = [];
  lines.forEach((ln, col) => {
    const next = lines[col + 1];
    for (let y = yTop, row = 0; y < yBot - pitch * 3; y += step, row++) {
      const ye = Math.min(yBot, y + tileH);
      const x0 = Math.max(0, Math.round(Math.min(ln.at(y), ln.at(ye))) - pad);
      const right = next ? Math.max(next.at(y), next.at(ye)) : Math.max(ln.at(y), ln.at(ye)) + colW;
      const x1 = Math.min(w, Math.round(right) + Math.round(pad / 2));
      if (x1 - x0 > colW * 0.4) tiles.push({ x: x0, y, w: x1 - x0, h: ye - y, col, row });
    }
  });
  return { tiles, columns: lines.length, pitch };
}

/** Droite des moindres carrés x = f(y) sur des points { x, y }. Retourne { slope, at(y) }. */
export function fitLine(pts) {
  const n = pts.length, my = pts.reduce((a, p) => a + p.y, 0) / n, mx = pts.reduce((a, p) => a + p.x, 0) / n;
  let num = 0, den = 0;
  for (const p of pts) { num += (p.y - my) * (p.x - mx); den += (p.y - my) ** 2; }
  const slope = den ? num / den : 0;
  return { slope, at: y => mx + slope * (y - my) };
}

/* ------------------------------------------------------------------ */
/* Assemblage des lignes lues                                            */
/* ------------------------------------------------------------------ */

const segsText = segs => segs.map(s => `${s.from_n}-${s.to_n}`).join(' / ');
const rowKey = r => [r.cp, r.tournee, r.street, segsText(r.segs)].join('|');
const sameStreet = (a, b) => a.street === b.street || sim(a.street, b.street) >= 0.85;

/** Ligne lue → texte du tableau (« ? » devant si elle est à vérifier). */
export const rowLine = r =>
  `${r.check ? '? ' : ''}${r.cp || '????'} ${r.tournee || '???'} ${r.street}${r.segs.length ? ' ' + segsText(r.segs) : ''}`;

/**
 * Assemble les morceaux [{ col, row, rows }] dans l'ordre du tableau (colonne par colonne, de haut en bas).
 * Deux morceaux voisins se recouvrent de quelques lignes : la fin de l'un est alignée sur le début de l'autre,
 * chaque ligne n'est gardée qu'une fois, et si les deux lectures diffèrent on garde celle qui est la plus loin
 * du bord de son image (une ligne au bord peut être coupée) en la marquant « à vérifier ».
 */
export function mergeBoardRows(pieces) {
  const cols = new Map();
  for (const p of pieces) { if (!cols.has(p.col)) cols.set(p.col, []); cols.get(p.col).push(p); }
  const out = [];
  for (const col of [...cols.keys()].sort((a, b) => a - b)) {
    let acc = [], prevLen = 0;
    for (const p of cols.get(col).sort((a, b) => a.row - b.row)) {
      const rows = p.rows.map(r => ({ ...r }));
      // Plus grand recouvrement k tel que les k dernières lignes déjà lues correspondent aux k premières de ce morceau.
      let k = 0;
      for (let n = Math.min(10, prevLen, rows.length); n >= 1 && !k; n--) {
        let hit = 0;
        for (let i = 0; i < n; i++) if (sameStreet(acc[acc.length - n + i], rows[i])) hit++;
        if (hit === n || (n >= 4 && hit >= n - 1)) k = n;
      }
      for (let i = 0; i < k; i++) {
        const j = acc.length - k + i, a = acc[j], b = rows[i];
        if (rowKey(a) === rowKey(b)) continue;
        const keep = i > k - 1 - i ? b : a;                       // la lecture la plus éloignée de son bord
        acc[j] = { ...keep, check: true, why: [keep.why, 'deux lectures différentes'].filter(Boolean).join(' ; ') };
      }
      acc = acc.concat(rows.slice(k));
      prevLen = rows.length;
    }
    out.push(...acc);
  }
  // Une même ligne présente sur deux photos n'est gardée qu'une fois.
  const seen = new Set();
  const rows = out.filter(r => { const key = rowKey(r); if (seen.has(key)) return false; seen.add(key); return true; });
  // Un code postal ou une tournée qui n'apparaît presque jamais dans tout le tableau est sans doute une erreur de lecture.
  if (rows.length >= 100) {
    const count = k => { const m = new Map(); for (const r of rows) m.set(r[k], (m.get(r[k]) ?? 0) + 1); return m; };
    const cps = count('cp'), tours = count('tournee');
    const flag = (r, why) => { r.check = true; r.why = [r.why, why].filter(Boolean).join(' ; '); };
    for (const r of rows) {
      if (cps.get(r.cp) <= 3) flag(r, 'code postal presque absent du tableau');
      if (tours.get(r.tournee) <= 2) flag(r, 'tournée presque absente du tableau');
    }
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Canvas (navigateur)                                                   */
/* ------------------------------------------------------------------ */

/** Canvas → niveaux de gris (Uint8Array). */
export function grayOf(canvas) {
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
  const g = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  return g;
}

/** Morceau du canvas → JPEG. Agrandi si le texte est petit (colonne de moins de 480 px de large). */
export function tileJpeg(canvas, t, quality = 0.9) {
  const k = Math.min(3, Math.max(1, 480 / t.w));
  const c = document.createElement('canvas');
  c.width = Math.round(t.w * k); c.height = Math.round(t.h * k);
  const x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
  x.drawImage(canvas, t.x, t.y, t.w, t.h, 0, 0, c.width, c.height);
  return new Promise((ok, ko) => c.toBlob(b => (b ? ok(b) : ko(new Error('Encodage JPEG impossible'))), 'image/jpeg', quality));
}
