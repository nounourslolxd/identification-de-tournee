// Lecture d'une lettre : serveur de vision auto-hébergé (manuscrit + imprimé) si configuré et joignable,
// sinon Tesseract sur le téléphone (imprimé seulement, fonctionne hors ligne).
import { ocr } from './ocr.js';
import { accessToken } from './backend.js';

let serverUrl = '';
export const setReaderServer = url => { serverUrl = String(url || '').replace(/\/+$/, ''); };
export const hasReaderServer = () => !!serverUrl;

const MAX_SIDE = 1600, TIMEOUT = 45000;

/** Canvas → JPEG réduit (côté max 1600 px) : assez pour l'écriture manuscrite, léger sur réseau mobile. */
export function toJpeg(canvas, max = MAX_SIDE, quality = 0.85) {
  const k = Math.min(1, max / Math.max(canvas.width, canvas.height));
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * k); c.height = Math.round(canvas.height * k);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return new Promise((ok, ko) => c.toBlob(b => (b ? ok(b) : ko(new Error('Encodage JPEG impossible'))), 'image/jpeg', quality));
}

async function readOnServer(canvas) {
  const token = await accessToken();
  const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(serverUrl + '/read', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'image/jpeg', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: await toJpeg(canvas),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    return data;
  } finally { clearTimeout(t); }
}

/**
 * Lit un morceau de photo du tableau de tri (une colonne) sur le serveur.
 * `zone` : codes postaux déjà rencontrés, pour aider à corriger un code postal mal lu.
 * Retourne [{ cp, tournee, street, segs, note, check, why }]. Lève une erreur si le serveur ne répond pas.
 */
export async function readTablePiece(blob, zone = []) {
  if (!serverUrl) throw new Error('Serveur de lecture non configuré');
  const token = await accessToken();
  const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), 120000);
  try {
    const res = await fetch(serverUrl + '/table?zone=' + zone.slice(0, 60).join(','), {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'image/jpeg', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: blob,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    return data.rows ?? [];
  } finally { clearTimeout(t); }
}

/**
 * Retourne { addr, via: 'serveur' } (adresse déjà analysée et corrigée par le serveur)
 * ou { text, via: 'téléphone', warn? } (texte brut Tesseract, à passer à parseAddr).
 */
export async function readAddress(canvas) {
  let warn = '';
  if (serverUrl && navigator.onLine !== false) {
    try { return { addr: await readOnServer(canvas), via: 'serveur' }; }
    catch (e) {
      console.warn('Serveur de lecture', e);
      warn = e.name === 'AbortError' ? 'Serveur de lecture trop lent' : 'Serveur de lecture indisponible (' + e.message + ')';
    }
  }
  return { text: await ocr(canvas), via: 'téléphone', warn };
}
