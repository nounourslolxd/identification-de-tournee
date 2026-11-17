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
 * opts: { video, onStatus(txt), onSharp(value), onState({ state, progress }), onCapture(canvas) → Promise }
 */
export function createScanner({ video, onStatus, onSharp, onCapture, onState = () => {} }) {
  const gc = document.createElement('canvas');
  gc.width = W; gc.height = H;
  const gx = gc.getContext('2d', { willReadFrequently: true });
  const tracker = createTracker();
  let stream = null, timer = null, prev = null, ref = null, busy = false, wake = null, torch = false, reading = null;
  let session = 0;   // change à chaque ouverture / fermeture de la caméra : une lecture d'avant ne touche plus à l'affichage

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Caméra non disponible (HTTPS requis).');
    const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, ...size }, audio: false });
    // Objectif principal (1x) plutôt que le téléobjectif, puis zoom 1x et mise au point continue si possible.
    try {
      const main = pickMainBack(await navigator.mediaDevices.enumerateDevices());
      if (main && main.deviceId !== stream.getVideoTracks()[0].getSettings().deviceId) {
        stream.getTracks().forEach(t => t.stop());
        stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: main.deviceId }, ...size }, audio: false });
      }
      const tr = stream.getVideoTracks()[0], caps = tr.getCapabilities?.() ?? {}, adv = {};
      if (caps.zoom) adv.zoom = Math.max(caps.zoom.min, Math.min(1, caps.zoom.max));
      if (caps.focusMode?.includes('continuous')) adv.focusMode = 'continuous';
      if (Object.keys(adv).length) await tr.applyConstraints({ advanced: [adv] }).catch(() => {});
    } catch { /* on garde la caméra ouverte par défaut */ }
    video.srcObject = stream;
    await video.play();
    session++; busy = false;
    prev = ref = null; tracker.reset();
    onStatus("Touchez l'image pour lire"); onState({ state: 'search', progress: 0 });
    timer = setInterval(tick, 150);
    // L'écran reste allumé pendant le tri (si le navigateur le permet).
    navigator.wakeLock?.request('screen').then(w => { wake = w; }).catch(() => {});
  }

  function stop() {
    reading?.abort();
    session++;
    clearInterval(timer); timer = null;
    stream?.getTracks().forEach(t => t.stop());
    stream = null; video.srcObject = null; prev = ref = null; torch = false;
    wake?.release().catch(() => {}); wake = null;
    onStatus('Caméra éteinte'); onState({ state: 'idle', progress: 0 });
  }

  /** La lampe du téléphone est-elle pilotable ? (Chrome Android ; pas Safari.) */
  const track = () => stream?.getVideoTracks()[0];
  const torchAvailable = () => !!track()?.getCapabilities?.().torch;
  async function setTorch(on) {
    try { await track().applyConstraints({ advanced: [{ torch: !!on }] }); torch = !!on; } catch { torch = false; }
    return torch;
  }

  function tick() {
    if (busy || !video.videoWidth) return;
    gx.drawImage(video, 0, 0, W, H);
    const g = toGray(gx.getImageData(0, 0, W, H).data);
    const sharp = sharpness(g), move = frameDiff(g, prev), fromRef = frameDiff(g, ref);
    prev = g;
    onSharp(sharp);
    const { action, status, state, progress } = tracker.step({ sharp, move, fromRef });
    onStatus(status); onState({ state, progress });
    if (action === 'capture') capture();
  }

  /**
   * Capture l'image pleine résolution et la confie à onCapture. Appelée aussi au toucher de l'image : la lecture part
   * tout de suite, sans attendre que l'image soit stable. L'image se fige pendant la lecture (on voit ce qui est lu).
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
    let cancelledNow = false;
    try {
      await onCapture(c, mine.signal);
      if (mine.signal.aborted) throw Object.assign(new Error('Lecture annulée'), { name: 'Cancelled' });
      if (here === session) { onStatus('Lu ✓ — retirez la lettre'); onState({ state: 'done', progress: 1 }); }
    } catch (e) {
      if (here === session) {
        if (e.name === 'Cancelled') { cancelledNow = true; onStatus("Lecture annulée · touchez l'image pour lire"); onState({ state: 'cancelled', progress: 0 }); }
        else { onStatus(e.message || 'Lecture impossible'); onState({ state: 'error', progress: 0 }); }
      }
    } finally {
      if (reading === mine) reading = null;
      // Caméra fermée ou rouverte entre-temps (application quittée) : cette lecture ne touche plus à rien.
      if (here === session) {
        ref = prev;            // image de référence : la lettre actuellement sous la caméra
        // pas de relecture automatique de cette lettre, même après « Arrêter » ;
        tracker.lock(cancelledNow ? { action: null, status: "Lecture annulée · touchez l'image pour lire", state: 'cancelled', progress: 0 } : null);
        if (stream) video.play().catch(() => {});   // on la relit en touchant l'image, ou en posant une autre lettre
        busy = false;
      }
    }
  }

  /** Arrête la lecture en cours (appui involontaire) : la caméra repart aussitôt. */
  const cancel = () => { reading?.abort(); };

  /**
   * Retour dans l'application (elle était en arrière-plan) : Android coupe la caméra et fige la vidéo.
   * On rouvre la caméra si son flux est terminé, sinon on relance simplement la vidéo.
   */
  async function resume() {
    if (!stream) return;
    const tr = stream.getVideoTracks()[0];
    if (!tr || tr.readyState === 'ended' || tr.muted) { stop(); await start(); return; }
    if (video.paused && !busy) await video.play().catch(async () => { stop(); await start(); });
  }

  return { start, stop, capture, cancel, resume, setTorch, torchAvailable, get torch() { return torch; }, get active() { return !!stream; } };
}
