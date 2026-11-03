// Couche de données. Mode « local » (sans Supabase) ici ; le mode partagé est ajouté par initRemote().
import { state, setRanges, setLocalities, effectiveRanges } from './store.js';
import { uid } from './util.js';

const mode = { remote: null };
export const isShared = () => !!mode.remote;

/** Ajoute une plage apprise. Retourne 'ok' | 'queued'. */
export async function addLearned(range) {
  if (mode.remote) return mode.remote.addLearned(range);
  const r = { ...range, source: 'learned', id: 'loc-' + uid(), local: true, created_at: new Date().toISOString() };
  // Pas de doublon exact.
  const dup = state.ranges.some(x => x.source === 'learned' && x.cp === r.cp && x.street === r.street &&
    x.from_n === r.from_n && x.to_n === r.to_n && x.tournee === r.tournee);
  if (!dup) setRanges([...state.ranges, r]);
  return 'ok';
}

export async function deleteRange(range) {
  if (mode.remote) return mode.remote.deleteRange(range);
  setRanges(state.ranges.filter(x => x.id !== range.id));
}

/** Remplace tout le tableau de base (plages 'table') et la liste des localités. Les plages apprises sont conservées. */
export async function saveTable(tableRanges, localities) {
  if (mode.remote) return mode.remote.saveTable(tableRanges, localities);
  const learned = state.ranges.filter(r => r.source === 'learned');
  setRanges([...tableRanges.map((r, i) => ({ ...r, source: 'table', id: 'loc-t' + i })), ...learned]);
  setLocalities(localities);
}

export function useRemote(impl) { mode.remote = impl; }
export { effectiveRanges };
