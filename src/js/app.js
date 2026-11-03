// Point d'entrée : onglets + enregistrement du service worker. Les écrans sont ajoutés par modules.
const $ = s => document.querySelector(s);

document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#tabs button, main section').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  $('#' + b.dataset.t).classList.add('on');
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service worker :', e));
}
