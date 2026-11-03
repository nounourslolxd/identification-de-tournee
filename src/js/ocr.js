// OCR : prétraitement d'image + Tesseract.js (langue « fra ») auto-hébergé dans vendor/. Aucun appel externe.

/* ------------------------------------------------------------------ */
/* Fonctions pures (testées sous Node)                                  */
/* ------------------------------------------------------------------ */

/** Étire le contraste entre les percentiles lo/hi (en %) et renvoie un Uint8ClampedArray 0–255. */
export function contrastStretch(gray, lo = 2, hi = 98) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[Math.max(0, Math.min(255, gray[i] | 0))]++;
  const at = p => { let acc = 0, t = gray.length * p / 100; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= t) return v; } return 255; };
  const a = at(lo), b = Math.max(at(hi), a + 1), out = new Uint8ClampedArray(gray.length);
  for (let i = 0; i < gray.length; i++) out[i] = ((gray[i] - a) * 255) / (b - a);
  return out;
}

/** Masque d'encre (1 = sombre) par seuil local (moyenne de voisinage via image intégrale). */
export function inkMask(gray, w, h, radius = 8, bias = 12) {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += gray[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; }
  }
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius), y1 = Math.min(h, y + radius + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius), x1 = Math.min(w, x + radius + 1);
      const sum = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
      m[y * w + x] = gray[y * w + x] < sum / ((x1 - x0) * (y1 - y0)) - bias ? 1 : 0;
    }
  }
  return m;
}

/**
 * Cherche le bloc de texte principal (l'adresse du destinataire) : bandes de lignes contenant de l'encre,
 * fusionnées si l'écart est petit ; on retient la bande la plus « massive » pondérée par sa proximité du centre.
 * Retourne { x, y, w, h } (fractions 0–1 de l'image) ou null si rien de convaincant.
 */
export function findTextBlock(mask, w, h) {
  const rowInk = new Float32Array(h), colInk = new Float32Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { rowInk[y]++; colInk[x]++; }
  const rowThr = Math.max(2, w * 0.01);
  const gapMax = Math.max(2, Math.round(h * 0.04));
  const bands = [];
  let start = -1, last = -1;
  for (let y = 0; y < h; y++) {
    if (rowInk[y] >= rowThr) { if (start < 0) start = y; else if (y - last > gapMax) { bands.push([start, last]); start = y; } last = y; }
  }
  if (start >= 0) bands.push([start, last]);
  if (!bands.length) return null;
  let best = null;
  for (const [y0, y1] of bands) {
    let mass = 0; for (let y = y0; y <= y1; y++) mass += rowInk[y];
    const centre = (y0 + y1) / 2 / h, weight = 1 - Math.min(0.5, Math.abs(centre - 0.5));
    const score = mass * weight;
    if (!best || score > best.score) best = { y0, y1, score };
  }
  // Étendue horizontale : colonnes avec de l'encre dans la bande retenue.
  const cols = new Float32Array(w);
  for (let y = best.y0; y <= best.y1; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) cols[x]++;
  let x0 = 0, x1 = w - 1;
  while (x0 < w && cols[x0] === 0) x0++;
  while (x1 > x0 && cols[x1] === 0) x1--;
  const padX = Math.round(w * 0.04), padY = Math.round(h * 0.03);
  const X0 = Math.max(0, x0 - padX), X1 = Math.min(w, x1 + padX + 1), Y0 = Math.max(0, best.y0 - padY), Y1 = Math.min(h, best.y1 + padY + 1);
  const box = { x: X0 / w, y: Y0 / h, w: (X1 - X0) / w, h: (Y1 - Y0) / h };
  return box.w * box.h < 0.04 ? null : box; // trop petit : probablement du bruit
}

/* ------------------------------------------------------------------ */
/* Prétraitement sur canvas                                              */
/* ------------------------------------------------------------------ */

const MAX_W = 1800;

/** Canvas → canvas en niveaux de gris contrasté, éventuellement recadré sur le bloc d'adresse. */
export function preprocess(src, { crop = true } = {}) {
  const scale = Math.min(1, MAX_W / src.width);
  const w = Math.round(src.width * scale), h = Math.round(src.height * scale);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(src, 0, 0, w, h);
  const img = x.getImageData(0, 0, w, h), d = img.data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = 0.3 * d[i * 4] + 0.59 * d[i * 4 + 1] + 0.11 * d[i * 4 + 2];
  const s = contrastStretch(g);
  for (let i = 0; i < s.length; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = s[i]; d[i * 4 + 3] = 255; }
  x.putImageData(img, 0, 0);
  if (!crop) return c;

  // Détection du bloc sur une version réduite (rapide).
  const sw = 240, sh = Math.max(1, Math.round(h * sw / w));
  const t = document.createElement('canvas'); t.width = sw; t.height = sh;
  const tx = t.getContext('2d', { willReadFrequently: true }); tx.drawImage(c, 0, 0, sw, sh);
  const td = tx.getImageData(0, 0, sw, sh).data, tg = new Float32Array(sw * sh);
  for (let i = 0; i < tg.length; i++) tg[i] = td[i * 4];
  const box = findTextBlock(inkMask(tg, sw, sh), sw, sh);
  if (!box) return c;
  const o = document.createElement('canvas');
  o.width = Math.round(box.w * w); o.height = Math.round(box.h * h);
  o.getContext('2d').drawImage(c, box.x * w, box.y * h, box.w * w, box.h * h, 0, 0, o.width, o.height);
  return o;
}

/* ------------------------------------------------------------------ */
/* Tesseract.js                                                          */
/* ------------------------------------------------------------------ */

const base = () => new URL('vendor/', document.baseURI).href;
let workerP = null;

function loadScript(src) {
  return new Promise((ok, ko) => {
    if (globalThis.Tesseract) return ok();
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => ko(new Error('Tesseract introuvable : ' + src));
    document.head.appendChild(s);
  });
}

async function makeWorker() {
  await loadScript(base() + 'tesseract/tesseract.min.js');
  const common = {
    workerPath: base() + 'tesseract/worker.min.js',
    langPath: base() + 'lang',          // contient fra.traineddata.gz
    gzip: true,
    workerBlobURL: false,               // pas de blob: URL (compatible CSP strictes)
  };
  // Tesseract.js ≥ 5 accepte un dossier pour le noyau wasm (il choisit SIMD/LSTM selon l'appareil).
  // Repli : fichier explicite si la version installée l'exige.
  const attempts = [base() + 'tesseract', base() + 'tesseract/tesseract-core-simd-lstm.wasm.js', base() + 'tesseract/tesseract-core-lstm.wasm.js'];
  let lastErr;
  for (const corePath of attempts) {
    try { return await Tesseract.createWorker('fra', 1, { ...common, corePath, cacheMethod: 'none' }); }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}

export function getWorker() {
  workerP ??= makeWorker().catch(e => { workerP = null; throw e; });
  return workerP;
}

/** Charge Tesseract + la langue en avance (met aussi les fichiers en cache pour le mode hors ligne). */
export async function warmup() {
  const w = await getWorker();
  const c = document.createElement('canvas'); c.width = 64; c.height = 32;
  c.getContext('2d').fillRect(0, 0, 64, 32);
  await w.recognize(c);
}

/** Lit un canvas. mode 'letter' : bloc d'adresse unique ; 'table' : texte en colonnes. Retourne { text, confidence }. */
export async function recognize(canvas, { mode = 'letter' } = {}) {
  const w = await getWorker();
  const prep = preprocess(canvas, { crop: mode === 'letter' });
  await w.setParameters({
    tessedit_pageseg_mode: mode === 'letter' ? '6' : '4', // 6 : bloc uniforme ; 4 : colonne de texte de tailles variables
    preserve_interword_spaces: '1',
    user_defined_dpi: '300',
  });
  const { data } = await w.recognize(prep);
  return { text: (data.text || '').trim(), confidence: data.confidence ?? 0 };
}

/** API simple utilisée par l'interface. Lève une erreur lisible en français si la lecture échoue. */
export async function ocr(canvas, tab = false) {
  try {
    const { text } = await recognize(canvas, { mode: tab ? 'table' : 'letter' });
    return text;
  } catch (e) {
    console.error('OCR', e);
    throw new Error('Lecture impossible (OCR indisponible). Utilisez le champ de test ou réessayez.');
  }
}
