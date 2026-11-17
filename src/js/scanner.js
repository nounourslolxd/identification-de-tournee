// Caméra arrière, mesure de netteté (variance du laplacien), stabilité, auto-capture et réarmement.

export const W = 320, H = 240;
export const SHARP = 45;   // écart-type du laplacien minimal pour une image nette
export const MOVE = 10;    // différence moyenne (0–255) au-delà de laquelle l'image « bouge »
export const REARM = 18;   // écart avec l'image capturée au-delà duquel on considère la lettre retirée
export const STABLE_TICKS = 2;   // 2 images stables à 150 ms d'intervalle : lecture ~0,3 s après que la lettre est posée

/**
 * Caméra principale (objectif 1x) parmi les caméras arrière : sur un téléphone à plusieurs objectifs, le navigateur
 * peut ouvrir le téléobjectif. Android les nomme « camera2 0, facing back », « camera2 2, facing back »… : la principale
 * a le plus petit numéro. Les objectifs nommés téléobjectif, ultra grand-angle, macro ou profondeur sont écartés.
 */
export function pickMainBack(devices) {
  const back = devices.filter(d => d.kind === 'videoinput' && /back|rear|arri[eè]re|environment/i.test(d.label || ''));
  const plain = back.filter(d => !/tele|ultra|macro|depth|zoom|wide/i.test(d.label));
  const list = plain.length ? plain : back;
  const num = d => +((d.label.match(/(\d+)\s*,/) || d.label.match(/(\d+)/) || [])[1] ?? 99);
  return list.sort((a, b) => num(a) - num(b))[0] ?? null;
}

/** RGBA → niveaux de gris (Float32Array). */
export function toGray(rgba, w = W, h = H) {
  const g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = 0.3 * rgba[i * 4] + 0.59 * rgba[i * 4 + 1] + 0.11 * rgba[i * 4 + 2];
  return g;
}

/** Netteté = écart-type du laplacien (4-voisinage) sur l'image en gris. Plus c'est élevé, plus c'est net. */
export function sharpness(g, w = W, h = H) {
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      s += l; s2 += l * l; n++;
    }
  }
  return n ? Math.sqrt(Math.max(s2 / n - (s / n) ** 2, 0)) : 0;
}

/** Différence absolue moyenne entre deux images (sous-échantillonnée). */
export function frameDiff(a, b, step = 7) {
  if (!a || !b || a.length !== b.length) return 0;
  let d = 0, n = 0;
  for (let i = 0; i < a.length; i += step) { d += Math.abs(a[i] - b[i]); n++; }
  return n ? d / n : 0;
}

/**
 * Machine à états pure : alimente-la avec (netteté, mouvement, écart à la référence) à chaque image.
 * Retourne { action: 'capture' | null, status, state, progress }.
 * state : 'blur' | 'move' | 'stable' | 'reading' | 'done' | 'new' (pour l'affichage) ; progress : 0–1 avant la capture.
 */
export function createTracker() {
  let stable = 0, locked = false, lockedAs = null;
  return {
    get locked() { return locked; },
    /** À appeler quand une capture a réussi : on attend que la lettre soit retirée/remplacée. */
    /** Après une lecture : on attend que la lettre soit retirée. `as` : ce qu'affiche le bandeau en attendant. */
    lock(as = null) { locked = true; stable = 0; lockedAs = as; },
    reset() { locked = false; stable = 0; },
    step({ sharp, move, fromRef }) {
      if (locked) {
        if (fromRef > REARM) { locked = false; stable = 0; return { action: null, status: 'Nouvelle lettre…', state: 'new', progress: 0 }; }
        return lockedAs ?? { action: null, status: 'Lu ✓ — retirez la lettre', state: 'done', progress: 1 };
      }
      if (sharp >= SHARP && move < MOVE / 2) {
        stable++;
        if (stable >= STABLE_TICKS) { stable = 0; return { action: 'capture', status: 'Lecture…', state: 'reading', progress: 1 }; }
        return { action: null, status: 'Ne bougez plus…', state: 'stable', progress: stable / STABLE_TICKS };
      }
      stable = 0;
      return sharp < SHARP ? { action: null, status: 'Image floue', state: 'blur', progress: 0 } : { action: null, status: 'Ne bougez pas', state: 'move', progress: 0 };
    },
  };
}

/**
 * Contrôleur caméra.
 * opts: { video, onStatus(txt), onSharp(value), onState({ state, progress }), onCapture(canvas, signal) → Promise }
 */
export function createScanner({ video, onStatus, onSharp, onCapture, onState = () => {} }) {
  const gc = document.createElement('canvas');
  gc.width = W; gc.height = H;
  const gx = gc.getContext('2d', { willReadFrequently: true });
  const tracker = createTracker();
  let stream = null, timer = null, prev = null, ref = null, busy = false, wake = null, torch = false, reading = null;
  let session = 0;          // change à chaque ouverture / fermeture : une lecture d'avant ne touche plus à l'affichage
  let backCams = [], lensIdx = 0, mainId = '';
  const SIZE = { width: { ideal: 1920 }, height: { ideal: 1080 } };

  /* ----- Ouverture d'une caméra : on ferme TOUJOURS la précédente avant (un téléphone n'en ouvre qu'une à la fois),
         et on vérifie qu'elle envoie vraiment des images (sinon : erreur, au lieu d'attendre indéfiniment). ----- */
  const release = () => { stream?.getTracks().forEach(t => t.stop()); stream = null; video.srcObject = null; };
  const timeout = (ms, msg) => new Promise((_, ko) => setTimeout(() => ko(new Error(msg)), ms));
  /** Attend une vraie image de la caméra (pas seulement un flux ouvert). */
  function firstFrame(ms = 4000) {
    return Promise.race([
      new Promise(ok => {
        const done = () => ok();
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(done);
        else video.addEventListener('timeupdate', done, { once: true });
      }),
      timeout(ms, 'La caméra n\'envoie pas d\'image'),
    ]);
  }
  async function open(constraints) {
    release();
    const s = await Promise.race([navigator.mediaDevices.getUserMedia({ video: constraints, audio: false }), timeout(60000, 'Caméra indisponible')]);
    stream = s;
    video.srcObject = s;
    try {
      await Promise.race([video.play(), timeout(4000, 'La caméra ne démarre pas')]);
      await firstFrame();
    } catch (e) { release(); throw e; }
  }
  const bad = new Set((() => { try { return JSON.parse(localStorage.getItem('badLenses') || '[]'); } catch { return []; } })());
  const markBad = id => { bad.add(id); try { localStorage.setItem('badLenses', JSON.stringify([...bad])); } catch { /* */ } };

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Caméra non disponible (HTTPS requis).');
    // Toujours l'objectif principal (1x) au démarrage, jamais un objectif choisi avant (il peut ne pas marcher).
    try { await open(mainId ? { deviceId: { exact: mainId }, ...SIZE } : { facingMode: { ideal: 'environment' }, ...SIZE }); }
    catch { await open({ facingMode: { ideal: 'environment' }, ...SIZE }); }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      backCams = devices.filter(d => d.kind === 'videoinput' && /back|rear|arri[eè]re|environment/i.test(d.label || ''));
      const main = pickMainBack(devices);
      if (main && !mainId && main.deviceId !== track()?.getSettings().deviceId) {
        try { await open({ deviceId: { exact: main.deviceId }, ...SIZE }); }
        catch { await open({ facingMode: { ideal: 'environment' }, ...SIZE }); }
      }
      mainId = track()?.getSettings().deviceId || main?.deviceId || '';
      lensIdx = Math.max(0, backCams.findIndex(d => d.deviceId === mainId));
      await tune();
    } catch { /* on garde la caméra ouverte */ }
    session++; busy = false;
    prev = ref = null; tracker.reset(); lastTime = -1; staleSince = 0; lastFrameAt = Date.now();
    onStatus("Touchez l'image pour lire"); onState({ state: 'search', progress: 0 });
    clearInterval(timer); timer = setInterval(tick, 150);
    navigator.wakeLock?.request('screen').then(w => { wake = w; }).catch(() => {});   // l'écran reste allumé
  }
  /** Zoom 1x et mise au point continue, si la caméra le permet. */
  async function tune() {
    const tr = track(), caps = tr?.getCapabilities?.() ?? {}, adv = {};
    if (caps.zoom) adv.zoom = Math.max(caps.zoom.min, Math.min(1, caps.zoom.max));
    if (caps.focusMode?.includes('continuous')) adv.focusMode = 'continuous';
    if (Object.keys(adv).length) await tr.applyConstraints({ advanced: [adv] }).catch(() => {});
  }

  function stop() {
    reading?.abort();
    session++;
    clearInterval(timer); timer = null;
    release(); prev = ref = null; torch = false; busy = false;
    wake?.release().catch(() => {}); wake = null;
    onStatus('Démarrer la caméra'); onState({ state: 'idle', progress: 0 });
  }

  /** La lampe du téléphone est-elle pilotable ? (Chrome Android ; pas Safari.) */
  const track = () => stream?.getVideoTracks()[0];
  const torchAvailable = () => !!track()?.getCapabilities?.().torch;
  async function setTorch(on) {
    try { await track().applyConstraints({ advanced: [{ torch: !!on }] }); torch = !!on; } catch { torch = false; }
    return torch;
  }

  /* ----- Surveillance : image figée (vidéo en pause, flux muet) → on relance, puis on rouvre la caméra ----- */
  // On compte les vraies images affichées : l'horloge de la vidéo, elle, avance même quand plus rien n'arrive.
  let lastTime = -1, staleSince = 0, reopening = false, lastFrameAt = Date.now();
  if (video.requestVideoFrameCallback) {
    const onFrame = () => { lastFrameAt = Date.now(); video.requestVideoFrameCallback(onFrame); };
    video.requestVideoFrameCallback(onFrame);
  }
  async function watchdog() {
    if (busy || !stream || reopening) return;
    if (video.paused) { video.play().catch(() => {}); lastFrameAt = Date.now(); return; }
    if (video.requestVideoFrameCallback) {
      if (Date.now() - lastFrameAt < 2500) return;
    } else {
      const t = video.currentTime;
      if (t !== lastTime) { lastTime = t; staleSince = 0; return; }
      staleSince ||= Date.now();
      if (Date.now() - staleSince < 2500) return;
    }
    reopening = true; staleSince = 0;                         // plus aucune image depuis 2,5 s : on rouvre la caméra
    try { await open({ deviceId: { exact: track()?.getSettings().deviceId || mainId }, ...SIZE }); }
    catch { try { await open({ facingMode: { ideal: 'environment' }, ...SIZE }); } catch { /* réessai au prochain tour */ } }
    finally { reopening = false; lastFrameAt = Date.now(); }
  }

  function tick() {
    watchdog();
    if (busy || !video.videoWidth || video.paused) return;
    gx.drawImage(video, 0, 0, W, H);
    const g = toGray(gx.getImageData(0, 0, W, H).data);
    const sharp = sharpness(g), move = frameDiff(g, prev), fromRef = frameDiff(g, ref);
    prev = g;
    onSharp(sharp);
    const { action, status, state, progress } = tracker.step({ sharp, move, fromRef });
    onStatus(status); onState({ state, progress });
    if (action === 'capture') capture();
  }

  const CANCELLED = "Lecture annulée · touchez l'image pour lire";
  /**
   * Capture l'image pleine résolution et la confie à onCapture. Appelée aussi au toucher de l'image : la lecture part
   * tout de suite, sans attendre que l'image soit stable. L'image se fige pendant la lecture (on voit ce qui est lu).
   * « Arrêter la lecture » rend la main IMMÉDIATEMENT : la lecture en cours continue en arrière-plan et son résultat est ignoré.
   */
  async function capture() {
    if (busy || !video.videoWidth) return;
    busy = true;
    const c = document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    video.pause();
    gx.drawImage(c, 0, 0, W, H);
    prev = toGray(gx.getImageData(0, 0, W, H).data);   // référence = l'image lue (même si on a touché en bougeant)
    onStatus('Lecture…'); onState({ state: 'reading', progress: 1 });
    const mine = reading = new AbortController(), here = session;
    const aborted = new Promise((_, ko) => mine.signal.addEventListener('abort', () => ko(Object.assign(new Error('Lecture annulée'), { name: 'Cancelled' }))));
    let cancelledNow = false;
    try {
      await Promise.race([onCapture(c, mine.signal), aborted]);
      if (here === session) { onStatus('Lu ✓ — retirez la lettre'); onState({ state: 'done', progress: 1 }); }
    } catch (e) {
      if (here === session) {
        if (e.name === 'Cancelled') { cancelledNow = true; onStatus(CANCELLED); onState({ state: 'cancelled', progress: 0 }); }
        else { onStatus(e.message || 'Lecture impossible'); onState({ state: 'error', progress: 0 }); }
      }
    } finally {
      if (reading === mine) reading = null;
      if (here === session) {
        ref = prev;            // la lettre actuellement sous la caméra : pas relue automatiquement, même après « Arrêter »
        tracker.lock(cancelledNow ? { action: null, status: CANCELLED, state: 'cancelled', progress: 0 } : null);
        busy = false;
        lastTime = -1; staleSince = 0; lastFrameAt = Date.now();
        if (stream) video.play().catch(() => {});
      }
    }
  }

  /* ----- Objectifs : zoom (0,6x, 1x, 2x…) si la caméra principale le permet, sinon les autres caméras arrière ;
         un objectif qui n'envoie pas d'image est retiré de la liste et on revient au précédent. ----- */
  const zoomSteps = () => {
    const z = track()?.getCapabilities?.().zoom;
    if (!z || !(z.max > z.min)) return [];
    return [...new Set([z.min, 1, 2, 3, 5, 10].filter(v => v >= z.min - 1e-6 && v <= z.max + 1e-6))].sort((a, b) => a - b);
  };
  const fmtZoom = v => (Math.round(v * 10) / 10).toString().replace('.', ',') + 'x';
  const usable = () => backCams.filter(d => d.deviceId === mainId || !bad.has(d.deviceId));
  /** Libellé de l'objectif en cours, ou '' s'il n'y a pas le choix. */
  function lensLabel() {
    const steps = zoomSteps();
    if (steps.length > 1) return fmtZoom(track().getSettings().zoom ?? 1);
    const list = usable();
    if (list.length < 2) return '';
    const i = list.findIndex(d => d.deviceId === track()?.getSettings().deviceId);
    return 'Obj. ' + (Math.max(0, i) + 1) + '/' + list.length;
  }
  /** Objectif suivant ; retourne le nouveau libellé. */
  async function nextLens() {
    if (busy || !stream) return lensLabel();
    const steps = zoomSteps();
    if (steps.length > 1) {
      const cur = track().getSettings().zoom ?? 1;
      const next = steps.find(v => v > cur + 0.05) ?? steps[0];
      await track().applyConstraints({ advanced: [{ zoom: next }] }).catch(() => {});
      return lensLabel();
    }
    const list = usable();
    if (list.length < 2) return lensLabel();
    const curId = track()?.getSettings().deviceId;
    const next = list[(Math.max(0, list.findIndex(d => d.deviceId === curId)) + 1) % list.length];
    busy = true;
    try {
      await open({ deviceId: { exact: next.deviceId }, ...SIZE });
      await tune();
    } catch {
      markBad(next.deviceId);                                // cet objectif ne marche pas sur ce téléphone : retiré
      try { await open({ deviceId: { exact: curId || mainId }, ...SIZE }); }
      catch { await open({ facingMode: { ideal: 'environment' }, ...SIZE }).catch(() => {}); }
      onStatus('Objectif indisponible sur ce téléphone');
    } finally {
      busy = false; prev = ref = null; tracker.reset(); lastTime = -1; staleSince = 0; lastFrameAt = Date.now();
    }
    return lensLabel();
  }

  /** « Arrêter la lecture » : la caméra repart aussitôt, sans attendre la fin de la lecture. */
  const cancel = () => { reading?.abort(); };

  /** Retour dans l'application : on relance la vidéo, ou on rouvre la caméra si son flux est terminé. */
  async function resume() {
    if (!stream) return;
    const tr = track();
    if (!tr || tr.readyState === 'ended' || tr.muted) { stop(); await start(); return; }
    if (video.paused && !busy) await video.play().catch(async () => { stop(); await start(); });
  }

  return { start, stop, capture, cancel, resume, nextLens, lensLabel, setTorch, torchAvailable, get torch() { return torch; }, get active() { return !!stream; } };
}
