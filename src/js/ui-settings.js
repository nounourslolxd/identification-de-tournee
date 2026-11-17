// Réglages : adresse du serveur de lecture et code d'accès, enregistrés sur ce téléphone uniquement.
// Rien de secret n'est écrit dans le site ni dans l'APK : chaque téléphone est réglé une fois, à la main.
import { $ } from './util.js';
import { readerSettings, saveReaderSettings, testReaderServer, hasReaderServer } from './reader.js';
import { syncBoardFromServer } from './ui-table.js';

/** Pastille sur l'onglet Réglages : verte si le serveur de lecture est réglé. */
function showState() {
  const b = document.querySelector('[data-t=rg]');
  if (b) b.dataset.s = hasReaderServer() ? 'ok' : '';
}

export function initSettings() {
  const msg = $('#setmsg');
  const fill = () => { const s = readerSettings(); $('#seturl').value = s.url; $('#setcode').value = s.code; };
  fill();
  document.querySelector('[data-t=rg]').addEventListener('click', () => { fill(); msg.textContent = ''; msg.className = 'hint'; });
  const v = document.querySelector('meta[name=app-version]')?.content;
  $('#appver').textContent = v ? 'Version ' + v : '';
  $('#setsave').onclick = async () => {
    const url = $('#seturl').value.trim(), code = $('#setcode').value.trim();
    if (url && !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)\b/.test(url)) {
      msg.textContent = 'L\'adresse doit commencer par https://'; msg.className = 'hint ko'; return;
    }
    saveReaderSettings({ url, code });
    showState();
    if (!url) { msg.textContent = 'Serveur retiré : lecture sur le téléphone (imprimé seulement).'; msg.className = 'hint'; return; }
    msg.textContent = 'Vérification…'; msg.className = 'hint';
    const r = await testReaderServer();
    msg.textContent = r.ok ? `Connecté au serveur (modèle ${r.model}). Manuscrit et import du tableau disponibles.` : r.error;
    msg.className = 'hint ' + (r.ok ? 'ok' : 'ko');
    if (r.ok) syncBoardFromServer();                  // récupère le tableau gardé sur le PC (réinstallation, autre téléphone)
  };
  showState();
}
