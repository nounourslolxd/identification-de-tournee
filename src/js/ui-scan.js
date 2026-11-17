import { $, esc } from './util.js';
import { state, setHist, effectiveRanges } from './store.js';
import { parseAddr, match, isFound, confidence, cls, clsGlobal, checkCity, localityIndex } from './match.js';
import { createScanner, SHARP } from './scanner.js';
import { warmup } from './ocr.js';
import { readAddress, cancelled } from './reader.js';
import { fullIndex } from './postcodes.js';
import * as backend from './backend.js';

/** Affichage d'un résultat : tournée en grand, confiance, puis chaque champ avec une pastille verte/orange/rouge. */
export function viewHtml(a, r) {
  const found = isFound(r), sc = Math.round(confidence(r) * 100), g = found ? clsGlobal(confidence(r)) : 'ko';
  const chip = (l, v, c, fix) => `<span class="chip ${c}"><small>${l}</small>${esc(v ?? '') || '?'}${fix ? ` → ${esc(fix)}` : ''}</span>`;
  const ranges = effectiveRanges();
  const city = checkCity(a.city, a.cp, fullIndex(() => localityIndex(state.localities, ranges)));
  const streetFix = found && r.s < 0.92 ? r.e.street : null;
  const abroad = a.foreign || /^\d{5}$/.test(a.cp);
  return `<div class="res-t"><span class="lbl">Tournée</span>${found ? `<b class="${g}">${esc(r.e.tournee)}</b>` : abroad ? '<b class="none wa">étranger</b>' : '<b class="none ko">introuvable</b>'}
    ${found ? `<span class="pct ${g}">${sc} %</span>` : ''}</div>
  <div class="chips">${chip('N°', a.num, found && r.n ? 'ok' : 'ko')}${chip('Rue', a.street, found ? cls(r.s) : 'ko', streetFix)}${chip('CP', a.cp, found && r.p ? 'ok' : 'ko')}${chip('Ville', a.city, city.cls, city.cls === 'wa' ? city.best : null)}</div>`;
}

/** Détails de lecture (repliés) : moteur, manuscrit, corrections apportées par les bases d'adresses. */
export function readInfoHtml(info = {}) {
  const bits = [];
  if (info.warn) bits.push(`⚠ ${esc(info.warn)}. Lecture sur le téléphone (imprimé seulement).`);
  for (const c of info.corrections ?? []) bits.push('✎ ' + esc(c));
  if (info.candidates?.length) bits.push('Rues possibles : ' + info.candidates.map(c => esc(c.street)).join(', '));
  if (info.numberInRange === false) bits.push('⚠ Numéro inconnu dans les bases d\'adresses pour cette rue');
  if (!info.via && !bits.length) return '';
  const title = info.via ? `Lu par le ${esc(info.via)}${info.handwritten ? ' · manuscrit' : ''}${bits.length ? ` · ${bits.length} remarque${bits.length > 1 ? 's' : ''}` : ''}` : 'Remarques';
  return bits.length ? `<details class="info"><summary>${title}</summary><ul class="ri">${bits.map(b => `<li>${b}</li>`).join('')}</ul></details>`
    : `<p class="near">${title}</p>`;
}

/** Adresse renvoyée par le serveur → forme de parseAddr. */
const fromServer = d => ({ num: d.num ?? null, street: d.street || '', cp: d.cp || '', city: d.city || '', raw: d.raw || '', foreign: !!d.foreign });

export const learnForm = id => `<div class="row learn"><input placeholder="Bonne tournée ?" data-l="${id}" aria-label="Bonne tournée" inputmode="numeric"><button class="btn sm" data-learn="${id}">Apprendre</button></div>`;

const cam = () => document.querySelector('.cam');

/** Retour par vibration, pour ne pas devoir regarder l'écran : court = sûr, double = doute, long = introuvable. */
function feedback(it) {
  const k = it.tournee ? clsGlobal(it.score) : 'ko';
  try { navigator.vibrate?.(k === 'ok' ? 60 : k === 'wa' ? [60, 80, 60] : 250); } catch { /* non pris en charge */ }
}

export const msgHtml = (text, kind = '') => `<div class="msg ${kind}">${esc(text)}</div>`;

/**
 * Traite une adresse lue : texte brut (Tesseract / saisie) ou adresse déjà analysée par le serveur.
 * `info` : { via, handwritten, corrections, candidates, numberInRange, warn } pour l'affichage.
 */
export function process(input, thumb = '', info = {}) {
  const ranges = effectiveRanges();
  let a = typeof input === 'string' ? parseAddr(input) : fromServer(input);
  let r = match(a, ranges);
  // Le répertoire du serveur peut « corriger » vers une rue absente du tableau : si la lecture brute
  // correspond mieux au tableau des tournées, c'est elle qu'on garde.
  if (typeof input !== 'string' && input.read?.street && input.read.street !== a.street) {
    const a0 = { ...a, street: input.read.street, num: input.read.num ?? a.num }, r0 = match(a0, ranges);
    if (r0 && (!r || r0.score > r.score)) {
      a = a0; r = r0;
      info = { ...info, corrections: [...(info.corrections ?? []).filter(c => !c.startsWith('Rue')), 'Correction de rue annulée : la lecture correspond mieux au tableau'] };
    }
  }
  if (a.foreign || /^\d{5}$/.test(a.cp)) r = null;                 // adresse à l'étranger : aucune tournée
  const found = isFound(r), score = confidence(r);
  const it = { id: Date.now(), t: new Date().toLocaleTimeString('fr-BE'), a, tournee: found ? r.e.tournee : null, score, thumb, raw: a.raw, hand: !!info.handwritten };
  setHist([it, ...state.hist]);
  const html = viewHtml(a, r);
  $('#ov').innerHTML = html; $('#ov').classList.add('on');
  cam().dataset.result = found ? clsGlobal(score) : 'ko';
  $('#res').innerHTML = `<div class="result ${found ? clsGlobal(score) : 'ko'}">${html}${readInfoHtml(info)}${!found || score < 0.9 ? learnForm(it.id) : ''}</div>`;
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
    $('#res').innerHTML = msgHtml(r.msg, r.ok ? 'ok' : 'ko');
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

let current = null;   // lecture en cours, annulable par le bouton « Arrêter la lecture »

/**
 * Lit une image (capture caméra ou photo choisie) : serveur de vision si possible, sinon Tesseract.
 * `signal` : annulation venant du scanner ; sinon (photo choisie) la lecture a sa propre annulation.
 */
async function readCanvas(canvas, signal) {
  const own = new AbortController();
  signal?.addEventListener('abort', () => own.abort());
  current = own;
  const t = document.createElement('canvas');
  t.width = 160; t.height = Math.round(160 * canvas.height / canvas.width);
  t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
  const before = $('#st').textContent;
  $('#st').textContent = 'Lecture…';
  $('#stopread').disabled = false;
  $('#res').innerHTML = msgHtml('Lecture en cours…', 'loading');
  try {
    const r = await readAddress(canvas, { signal: own.signal });
    if (own.signal.aborted) throw cancelled();
    feedback(process(r.addr ?? r.text, t.toDataURL('image/jpeg', 0.5), { ...(r.addr ?? {}), via: r.via, warn: r.warn }));
  } catch (e) {
    $('#res').innerHTML = e.name === 'Cancelled' ? msgHtml('Lecture annulée.', '') : msgHtml(e.message, 'ko');
    if (e.name === 'Cancelled' && signal) throw e;     // le scanner sait alors qu'il ne doit pas verrouiller cette lettre
  } finally { if (current === own) current = null; if (!current && cam().dataset.state !== 'reading') $('#stopread').disabled = true; }
  if ($('#st').textContent === 'Lecture…') $('#st').textContent = before;
}

/** Bouton « Arrêter la lecture » (sous la caméra). */
function stopReading(scanner) {
  if (current) current.abort();
  scanner.cancel();
}

export function initScan() {
  const v = $('#v'), box = cam(), steps = [...document.querySelectorAll('.steps i')];
  const scanner = createScanner({
    video: v,
    onStatus: t => { $('#st').textContent = t; },
    // Jauge de netteté : le repère (60 %) marque le seuil à partir duquel la lecture se déclenche.
    onSharp: s => { $('#shb').style.width = Math.min(100, s / SHARP * 60) + '%'; $('#meter').classList.toggle('ok', s >= SHARP); },
    onState: ({ state, progress }) => {
      box.dataset.state = state;
      $('#stopread').disabled = state !== 'reading' && !current;
      steps.forEach((el, i) => el.classList.toggle('on', progress >= (i + 1) / steps.length - 1e-9));
      // Nouvelle lettre : on efface le résultat précédent pour ne pas le confondre avec le suivant.
      if (state === 'new' || state === 'search' || state === 'idle' || state === 'cancelled') { $('#ov').classList.remove('on'); delete box.dataset.result; }
    },
    onCapture: readCanvas,
  });
  // Toucher n'importe où sur l'image (cadre, bandeau, résultat affiché) = lire tout de suite, sans attendre la stabilité.
  // Pendant une lecture, toucher l'image ne relance rien : le bouton « Arrêter » l'annule.
  box.addEventListener('pointerdown', e => {
    if (e.target.closest('#torch, #lens, #go')) return;
    if (!scanner.active) { e.preventDefault(); startCam(); return; }     // caméra éteinte : toucher l'image la démarre
    e.preventDefault();
    if (box.dataset.state !== 'reading') scanner.capture();
  });
  $('#stopread').addEventListener('click', () => stopReading(scanner));
  $('#lens').onclick = async () => { $('#lens').textContent = await scanner.nextLens(); };

  // Quitter l'application puis y revenir : la caméra est coupée en arrière-plan (batterie, vie privée)
  // et rouverte au retour, au lieu de rester figée.
  let wasOn = false;
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) {
      if (scanner.active) { wasOn = true; stopReading(scanner); scanner.stop(); box.classList.remove('live'); }
      return;
    }
    if (!wasOn) return;
    wasOn = false;
    try { await scanner.start(); box.classList.add('live'); camButtons(); }
    catch { box.classList.remove('live'); $('#st').textContent = 'Caméra indisponible : touchez ici'; }
  });
  window.addEventListener('pageshow', () => { if (scanner.active) scanner.resume(); });
  v.onloadedmetadata = () => { if (v.videoWidth) box.style.setProperty('--cam-ar', v.videoWidth + '/' + v.videoHeight); };
  $('#torch').onclick = async () => $('#torch').setAttribute('aria-pressed', String(await scanner.setTorch(!scanner.torch)));
  $('#pick').onclick = () => $('#pf').click();
  $('#pf').onchange = async e => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    try {
      const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      await readCanvas(c);
    } catch (err) { $('#res').innerHTML = msgHtml('Image illisible : ' + err.message, 'ko'); }
  };
  function camButtons() {
    $('#torch').hidden = !scanner.torchAvailable();
    const lens = scanner.lensLabel();
    $('#lens').hidden = !lens; $('#lens').textContent = lens || '1x';
  }
  async function startCam() {
    try { await scanner.start(); box.classList.add('live'); camButtons(); maybePrefetch(); }
    catch (e) { $('#st').textContent = e.message?.includes('HTTPS') ? e.message : 'Caméra refusée ou indisponible'; }
  }
  // Petit bouton en haut à gauche de l'image : démarre ou arrête la caméra.
  $('#go').onclick = async () => {
    if (!scanner.active) return startCam();
    stopReading(scanner);
    scanner.stop(); box.classList.remove('live');
    $('#st').textContent = 'Démarrer la caméra';
    $('#torch').hidden = $('#lens').hidden = true; $('#torch').setAttribute('aria-pressed', 'false');
  };
  $('#snap').onclick = () => { if (scanner.active) scanner.capture(); else $('#st').textContent = 'Démarrez d\'abord la caméra'; };
  $('#mb').onclick = () => process($('#man').value);
}
