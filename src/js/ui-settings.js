// Réglages : adresse du serveur de lecture et code d'accès, enregistrés sur ce téléphone uniquement.
// Rien de secret n'est écrit dans le site ni dans l'APK : chaque téléphone est réglé une fois, à la main.
import { $ } from './util.js';
import { readerSettings, saveReaderSettings, testReaderServer, hasReaderServer } from './reader.js';
import { syncBoardFromServer } from './ui-table.js';

function showState() {
  const b = $('#gear');
  b.dataset.s = hasReaderServer() ? 'ok' : '';
  b.title = hasReaderServer() ? 'Serveur de lecture réglé' : 'Serveur de lecture non réglé';
}

export function initSettings() {
  const dlg = $('#settings'), msg = $('#setmsg');
  $('#gear').onclick = () => {
    const s = readerSettings();
    $('#seturl').value = s.url; $('#setcode').value = s.code; msg.textContent = ''; msg.className = 'hint';
    dlg.showModal();
  };
  $('#setclose').onclick = () => dlg.close();
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
