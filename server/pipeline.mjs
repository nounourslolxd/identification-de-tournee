// Chaîne de lecture côté serveur : modèle de vision → correction par le répertoire → second passage si ambigu.
import { correctAddress, fixCity } from './gazetteer.mjs';

/** Liste « CP Localité » donnée au modèle comme indice (limitée pour garder une consigne courte). */
export function hintsFrom(gaz, max = 60) {
  const out = [];
  for (const cp of [...gaz.cps()].sort()) {
    const c = gaz.citiesOf(cp);
    out.push(c.length ? `${cp} ${c.join('/')}` : cp);
    if (out.length > max) return [];  // trop de communes : l'indice deviendrait du bruit
  }
  return out;
}

/** Lit une image et renvoie l'adresse corrigée, prête pour match() côté application. */
export async function readLetter({ image, mime, vision, gaz, secondPass = true }) {
  const t0 = Date.now();
  const read = await vision.read(image, mime, hintsFrom(gaz));
  let { addr, corrections, ambiguous, numberInRange } = correctAddress(read, gaz);

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

  return {
    ...addr,
    box: read.box,
    raw: read.raw,
    handwritten: read.handwritten,
    legibility: read.legibility,
    numberInRange,
    corrections,
    candidates: ambiguous?.map(c => ({ street: c.street, cp: c.cp, city: c.city })) ?? [],
    model: vision.model,
    ms: Date.now() - t0,
  };
}
