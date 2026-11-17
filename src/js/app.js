// Point d'entrée : onglets, service worker, modules d'écran, mode partagé (Supabase).
import { $ } from './util.js';
import { initSharedMode, on } from './store.js';
import * as backend from './backend.js';
import { initTable } from './ui-table.js';
import { initSearch, renderSearch } from './ui-search.js';
import { initScan, initLearnHandler, maybePrefetch } from './ui-scan.js';
import { initHistory } from './ui-history.js';
import { initAuth, promptIfSignedOut } from './ui-auth.js';
import { setReaderServer } from './reader.js';
import { initSettings } from './ui-settings.js';
import { syncBoardFromServer } from './ui-table.js';
import { loadPostcodes, invalidateIndex } from './postcodes.js';

on('ranges', invalidateIndex);          // avant les écrans : ils relisent l'index dans le même événement
loadPostcodes().then(renderSearch);

let config = { supabaseUrl: '', supabaseAnonKey: '' };
try { ({ config } = await import('./config.js')); } catch { /* pas de config.js : mode local */ }
const shared = !!(config.supabaseUrl && config.supabaseAnonKey);
if (shared) initSharedMode();
setReaderServer(config.ocrServerUrl);
initSettings();

document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#tabs button, main section').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  $('#' + b.dataset.t).classList.add('on');
  window.scrollTo(0, 0);
});

initTable();
initSearch();
initScan();
initHistory();
initLearnHandler();
initAuth(shared);

// Application Android (APK) : les fichiers sont déjà dans l'application, le cache hors ligne est inutile et, après une
// mise à jour, il continuait d'afficher l'ancienne version. On le retire (une seule fois) puis on recharge.
const native = !!window.Capacitor?.isNativePlatform?.() || (location.protocol === 'https:' && location.hostname === 'localhost');
if (native) {
  navigator.serviceWorker?.getRegistrations().then(async regs => {
    if (!regs.length) return;
    for (const r of regs) await r.unregister();
    for (const k of await caches.keys()) await caches.delete(k);
    location.reload();
  }).catch(() => {});
} else if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service worker :', e));
}

if (shared) {
  try { await backend.initRemote(config); promptIfSignedOut(); maybePrefetch(); }
  catch (e) { console.error(e); $('#mode').textContent = '⚠ serveur injoignable (cache local)'; }
} else {
  maybePrefetch();
}
// Tableau gardé sur le serveur : récupéré s'il est plus récent, ou si ce téléphone n'en a pas (réinstallation).
syncBoardFromServer();
