// Point d'entrée : onglets, service worker, modules d'écran, mode partagé (Supabase).
import { $ } from './util.js';
import { initSharedMode } from './store.js';
import * as backend from './backend.js';
import { initTable } from './ui-table.js';
import { initSearch } from './ui-search.js';
import { initScan, initLearnHandler, maybePrefetch } from './ui-scan.js';
import { initHistory } from './ui-history.js';
import { initAuth, promptIfSignedOut } from './ui-auth.js';

let config = { supabaseUrl: '', supabaseAnonKey: '' };
try { ({ config } = await import('./config.js')); } catch { /* pas de config.js : mode local */ }
const shared = !!(config.supabaseUrl && config.supabaseAnonKey);
if (shared) initSharedMode();

document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#tabs button, main section').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  $('#' + b.dataset.t).classList.add('on');
});

initTable();
initSearch();
initScan();
initHistory();
initLearnHandler();
initAuth(shared);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service worker :', e));
}

if (shared) {
  try { await backend.initRemote(config); promptIfSignedOut(); maybePrefetch(); }
  catch (e) { console.error(e); $('#mode').textContent = '⚠ serveur injoignable (cache local)'; }
} else {
  maybePrefetch();
}
