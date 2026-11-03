// Point d'entrée : onglets, service worker, modules d'écran.
import { $ } from './util.js';
import { initTable } from './ui-table.js';
import { initSearch } from './ui-search.js';
import { initScan, initLearnHandler } from './ui-scan.js';
import { initHistory } from './ui-history.js';

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

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service worker :', e));
}
