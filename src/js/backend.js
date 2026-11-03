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
export const remote = () => mode.remote;

function loadScript(src) {
  return new Promise((ok, ko) => {
    if (globalThis.supabase) return ok();
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => ko(new Error('Client Supabase introuvable'));
    document.head.appendChild(s);
  });
}

/** Active le mode partagé si config.js contient une URL et une clé anon. Retourne true si activé. */
export async function initRemote(config) {
  if (!config?.supabaseUrl || !config?.supabaseAnonKey) return false;
  await loadScript(new URL('vendor/supabase.js', document.baseURI).href);
  const { createRemote } = await import('./remote.js');
  const client = globalThis.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  const r = createRemote(client);
  useRemote(r);
  const { data } = await client.auth.getSession();
  await r.connect(data.session);
  client.auth.onAuthStateChange((event, session) => { if (event !== 'INITIAL_SESSION') r.connect(session); });
  return true;
}
export { effectiveRanges };
