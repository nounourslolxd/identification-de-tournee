// Chaîne de lecture côté serveur : modèle de vision → correction par le répertoire → second passage si ambigu.
import { correctAddress, fixCity } from './gazetteer.mjs';

/**
 * Liste « CP Localité » donnée au modèle comme indice : les codes postaux desservis (ceux du tableau des tournées),
 * sinon tous ceux du répertoire. Vide au-delà de `max` : l'indice deviendrait du bruit (et des jetons à lire).
 */
export function hintsFrom(gaz, max = 60) {
  const served = gaz.servedCps?.() ?? new Set();
  const cps = [...(served.size ? served : gaz.cps())].sort();
  if (cps.length > max) return [];
  return cps.map(cp => {
    const c = gaz.citiesOf(cp).slice(0, 2);
    return c.length ? `${cp} ${c.join('/')}` : cp;
  });
}

/** Lit une image et renvoie l'adresse corrigée, prête pour match() côté application. */
export async function readLetter({ image, mime, vision, gaz, secondPass = true }) {
  const t0 = Date.now();
  const read = await vision.read(image, mime, hintsFrom(gaz));
  const t1 = Date.now();
  let { addr, corrections, ambiguous, numberInRange } = correctAddress(read, gaz);
  const t2 = Date.now();

  if (ambiguous?.length > 1 && secondPass) {
    const i = await vision.choose(image, mime, read.street, ambiguous).catch(() => -1);
    if (i >= 0) {
      const c = ambiguous[i];
      corrections.push(`Rue « ${read.street} » → « ${c.street} » (choisie par le modèle parmi ${ambiguous.length} rues réelles)`);
      if (c.cp !== addr.cp) corrections.push(`Code postal ${addr.cp || '(absent)'} → ${c.cp} (d'après la rue)`);
      addr = fixCity({ ...addr, street: c.street, cp: c.cp }, gaz, corrections);
      if (addr.num != null && c.min != null) numberInRange = addr.num >= c.min && addr.num <= c.max;
      ambiguous = null;
    }
  }
  const t3 = Date.now();

  return {
    ...addr,
    box: read.box,
    raw: [[read.num, read.street].filter(x => x != null && x !== '').join(' '), [read.cp, read.city].filter(Boolean).join(' ')].filter(Boolean).join('\n'),
    read: { num: read.num, street: read.street, cp: read.cp, city: read.city }, // lecture avant correction
    handwritten: read.handwritten,
    numberInRange,
    corrections,
    candidates: ambiguous?.map(c => ({ street: c.street, cp: c.cp, city: c.city })) ?? [],
    model: vision.model,
    ms: t3 - t0,
    timing: { read: t1 - t0, correct: t2 - t1, choose: t3 - t2, tokens: read.tokens ?? null },
  };
}
