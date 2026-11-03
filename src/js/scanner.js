// Caméra arrière, mesure de netteté (variance du laplacien), stabilité, auto-capture et réarmement.

export const W = 320, H = 240;
export const SHARP = 45;   // écart-type du laplacien minimal pour une image nette
export const MOVE = 10;    // différence moyenne (0–255) au-delà de laquelle l'image « bouge »
export const REARM = 18;   // écart avec l'image capturée au-delà duquel on considère la lettre retirée
export const STABLE_TICKS = 3;

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
 * Retourne { action: 'capture' | null, status }.
 */
export function createTracker() {
  let stable = 0, locked = false;
  return {
    get locked() { return locked; },
    /** À appeler quand une capture a réussi : on attend que la lettre soit retirée/remplacée. */
    lock() { locked = true; stable = 0; },
    reset() { locked = false; stable = 0; },
    step({ sharp, move, fromRef }) {
      if (locked) {
        if (fromRef > REARM) { locked = false; stable = 0; return { action: null, status: 'Nouvelle lettre…' }; }
        return { action: null, status: 'Lu ✓ — retirez la lettre' };
      }
      if (sharp >= SHARP && move < MOVE / 2) {
        stable++;
        if (stable >= STABLE_TICKS) { stable = 0; return { action: 'capture', status: 'Lecture…' }; }
        return { action: null, status: `Stable ${stable}/${STABLE_TICKS}` };
      }
      stable = 0;
      return { action: null, status: sharp < SHARP ? 'Image floue' : 'Ne bougez pas' };
    },
  };
}

/**
 * Contrôleur caméra.
 * opts: { video, onStatus(txt), onSharp(value), onCapture(canvas) → Promise }
 */
export function createScanner({ video, onStatus, onSharp, onCapture }) {
  const gc = document.createElement('canvas');
  gc.width = W; gc.height = H;
  const gx = gc.getContext('2d', { willReadFrequently: true });
  const tracker = createTracker();
  let stream = null, timer = null, prev = null, ref = null, busy = false;

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Caméra non disponible (HTTPS requis).');
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
    });
    video.srcObject = stream;
    await video.play();
    prev = ref = null; tracker.reset();
    onStatus('Présentez une lettre');
    timer = setInterval(tick, 350);
  }

  function stop() {
    clearInterval(timer); timer = null;
    stream?.getTracks().forEach(t => t.stop());
    stream = null; video.srcObject = null; prev = ref = null;
    onStatus('Caméra éteinte');
  }

  function tick() {
    if (busy || !video.videoWidth) return;
    gx.drawImage(video, 0, 0, W, H);
    const g = toGray(gx.getImageData(0, 0, W, H).data);
    const sharp = sharpness(g), move = frameDiff(g, prev), fromRef = frameDiff(g, ref);
    prev = g;
    onSharp(sharp);
    const { action, status } = tracker.step({ sharp, move, fromRef });
    onStatus(status);
    if (action === 'capture') capture();
  }

  /** Capture l'image pleine résolution et la confie à onCapture. Utilisable aussi manuellement. */
  async function capture() {
    if (busy || !video.videoWidth) return;
    busy = true;
    onStatus('Lecture…');
    const c = document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    try {
      await onCapture(c);
      onStatus('Lu ✓ — retirez la lettre');
    } catch (e) {
      onStatus(e.message || 'Lecture impossible');
    } finally {
      ref = prev;            // image de référence : la lettre actuellement sous la caméra
      tracker.lock();        // on ne relit pas la même lettre ; réarmement quand elle change
      busy = false;
    }
  }

  return { start, stop, capture, get active() { return !!stream; } };
}
