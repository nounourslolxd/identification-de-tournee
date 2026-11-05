import { $, esc } from './util.js';
import { state, setHist, effectiveRanges } from './store.js';
import { parseAddr, match, isFound, confidence, cls, clsGlobal } from './match.js';
import { createScanner, SHARP } from './scanner.js';
import { warmup } from './ocr.js';
import { readAddress } from './reader.js';
import * as backend from './backend.js';

/** Affichage d'un résultat : chaque champ en vert/orange/rouge, tournée en grand, confiance. */
export function viewHtml(a, r) {
  const found = isFound(r), sc = Math.round(confidence(r) * 100), g = found ? clsGlobal(confidence(r)) : 'ko';
  const F = (l, v, c) => `<span class="f ${c}">${l} : ${esc(v ?? '') || '?'}</span>`;
  return `<div>${F('N°', a.num, found && r.n ? 'ok' : 'ko')}${F('Rue', a.street, found ? cls(r.s) : 'ko')}${F('CP', a.cp, found && r.p ? 'ok' : 'ko')}${F('Ville', a.city, a.city ? 'ok' : 'ko')}</div>
  <div class="big ${g}">${found ? 'Tournée ' + esc(r.e.tournee) : 'Introuvable'} <small class="${g}">· confiance ${sc}%</small></div>
  ${found && r.s < 0.92 ? `<small>Rue proche trouvée : « ${esc(r.e.street)} »</small>` : ''}`;
}

/** Détails de lecture : moteur, manuscrit, corrections apportées par les bases d'adresses. */
export function readInfoHtml(info = {}) {
  const bits = [];
  if (info.via) bits.push(`Lu par : ${esc(info.via)}${info.handwritten ? ' · manuscrit' : ''}`);
  if (info.warn) bits.push(`⚠ ${esc(info.warn)} : lecture sur le téléphone (imprimé seulement)`);
  for (const c of info.corrections ?? []) bits.push('✎ ' + esc(c));
  if (info.candidates?.length) bits.push('Rues possibles : ' + info.candidates.map(c => esc(c.street)).join(', '));
  if (info.numberInRange === false) bits.push('⚠ Ce numéro n\'existe pas dans les bases d\'adresses pour cette rue');
  return bits.length ? `<small class="ri">${bits.join('<br>')}</small>` : '';
}

/** Adresse renvoyée par le serveur → forme de parseAddr. */
const fromServer = d => ({ num: d.num ?? null, street: d.street || '', cp: d.cp || '', city: d.city || '', raw: d.raw || '' });

export const learnForm = id => `<div class="row"><input placeholder="Bonne tournée ?" data-l="${id}" aria-label="Bonne tournée"><button class="b s" data-learn="${id}">Apprendre</button></div>`;

/**
 * Traite une adresse lue : texte brut (Tesseract / saisie) ou adresse déjà analysée par le serveur.
 * `info` : { via, handwritten, corrections, candidates, numberInRange, warn } pour l'affichage.
 */
export function process(input, thumb = '', info = {}) {
  const a = typeof input === 'string' ? parseAddr(input) : fromServer(input);
  const r = match(a, effectiveRanges()), found = isFound(r), score = confidence(r);
  const it = { id: Date.now(), t: new Date().toLocaleTimeString('fr-BE'), a, tournee: found ? r.e.tournee : null, score, thumb, raw: a.raw, hand: !!info.handwritten };
  setHist([it, ...state.hist]);
  const html = viewHtml(a, r);
  $('#ov').innerHTML = html; $('#ov').classList.add('on');
  $('#res').innerHTML = `<div class="card">${html}${readInfoHtml(info)}${!found || score < 0.9 ? learnForm(it.id) : ''}</div>`;
  return it;
}

/** Le facteur confirme la bonne tournée : ajout à la base (seule l'adresse lue est envoyée, jamais la photo). */
export async function learn(id, tournee) {
  const it = state.hist.find(h => h.id == id);
  tournee = String(tournee ?? '').trim();
  if (!it || !tournee) return { ok: false, msg: 'Indiquez la tournée.' };
  if (it.a.num == null || !it.a.street || !it.a.cp) return { ok: false, msg: 'Adresse incomplète (n°, rue, code postal) : impossible d\'apprendre.' };
  const res = await backend.addLearned({ cp: it.a.cp, city: it.a.city, street: it.a.street, from_n: it.a.num, to_n: it.a.num, tournee });
  setHist(state.hist.map(h => (h.id == id ? { ...h, tournee, score: 1, fixed: 1 } : h)));
  return { ok: true, msg: `Appris : n°${it.a.num} ${it.a.street} → tournée ${tournee}` + (res === 'queued' ? ' (sera envoyé au retour du réseau)' : '') };
}

export function initLearnHandler(onDone) {
  document.addEventListener('click', async e => {
    const id = e.target.dataset?.learn; if (!id) return;
    const input = document.querySelector(`[data-l="${id}"]`);
    const r = await learn(id, input?.value);
    $('#res').innerHTML = `<div class="card ${r.ok ? 'ok' : 'ko'}">${esc(r.msg)}</div>`;
    onDone?.();
  });
}

let prefetched = false;
/** Précharge Tesseract + langue (utile au mode hors ligne), sauf en économie de données / réseau mobile. */
export function maybePrefetch() {
  const c = navigator.connection;
  if (prefetched || !navigator.onLine || c?.saveData || c?.type === 'cellular') return;
  prefetched = true;
  warmup().catch(e => { prefetched = false; console.warn('Préchargement OCR', e); });
}

export function initScan() {
  const v = $('#v');
  const scanner = createScanner({
    video: v,
    onStatus: t => { $('#st').textContent = t; },
    onSharp: s => { $('#sh').textContent = 'Netteté ' + Math.round(s); $('#shb').style.width = Math.min(100, s / SHARP * 60) + '%'; },
    onCapture: async canvas => {
      const t = document.createElement('canvas');
      t.width = 160; t.height = Math.round(160 * canvas.height / canvas.width);
      t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
      $('#st').textContent = 'Lecture…';
      try {
        const r = await readAddress(canvas);
        process(r.addr ?? r.text, t.toDataURL('image/jpeg', 0.5), { ...(r.addr ?? {}), via: r.via, warn: r.warn });
      } catch (e) { $('#res').innerHTML = `<div class="card ko">${esc(e.message)}</div>`; }
    },
  });
  $('#go').onclick = async () => {
    if (scanner.active) { scanner.stop(); $('#go').textContent = 'Démarrer la caméra'; return; }
    try { await scanner.start(); $('#go').textContent = 'Arrêter'; maybePrefetch(); }
    catch (e) { $('#st').textContent = e.message?.includes('HTTPS') ? e.message : 'Caméra refusée ou indisponible'; }
  };
  $('#snap').onclick = () => { if (scanner.active) scanner.capture(); else $('#st').textContent = 'Démarrez d\'abord la caméra'; };
  $('#mb').onclick = () => process($('#man').value);
}
