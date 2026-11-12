import { $, esc } from './util.js';
import { state, on, setOnline } from './store.js';
import * as backend from './backend.js';

const ROLE = { admin: 'administrateur', contributor: 'contributeur', anon: 'non connecté', local: 'local' };

export function renderStatus(shared) {
  const m = $('#mode'), b = $('#banner'), a = $('#acct');
  a.hidden = !shared;
  const [label, s] = !shared ? ['Local', ''] : !state.online ? ['Hors ligne', 'wa'] : state.user ? ['Partagé', 'ok'] : ['Non connecté', 'wa'];
  m.textContent = label; m.dataset.s = s;
  m.title = !shared ? 'Mode local : données sur cet appareil uniquement' : '';
  a.setAttribute('aria-label', state.user ? 'Compte' : 'Connexion');

  const msgs = [];
  if (shared && !state.online) msgs.push('Hors ligne : lecture avec le tableau en cache.');
  if (state.pending.length) msgs.push(`${state.pending.length} ajout(s) en attente d'envoi${state.user ? '' : ' (connexion requise)'}.`);
  b.hidden = !msgs.length;
  b.textContent = msgs.join(' ');
}

export function initAuth(shared) {
  const dlg = $('#auth'), msg = $('#authmsg');
  const refresh = () => renderStatus(shared);
  on('session', refresh); on('ranges', refresh); on('status', refresh);
  refresh();

  window.addEventListener('online', async () => {
    setOnline(true);
    const r = backend.remote(); if (!r) return;
    await r.flushPending().catch(() => {}); await r.fetchAll().catch(() => {});
  });
  window.addEventListener('offline', () => setOnline(false));
  if (!shared) return;

  $('#acct').onclick = async () => {
    if (!state.user) { dlg.showModal(); return; }
    if (confirm(`Connecté : ${state.user.email}\nRôle : ${ROLE[state.role] ?? state.role}\n\nSe déconnecter ?`)) await backend.remote().signOut();
  };
  $('#authclose').onclick = () => dlg.close();
  $('#sendlink').onclick = async () => {
    const mail = $('#mail').value.trim();
    if (!$('#mail').checkValidity() || !mail) { msg.textContent = 'Adresse e-mail invalide.'; return; }
    msg.textContent = 'Envoi…';
    try { await backend.remote().sendLink(mail); msg.textContent = 'Message envoyé. Ouvrez le lien, ou saisissez le code reçu :'; $('#codebox').hidden = false; $('#code').focus(); }
    catch (e) { msg.textContent = 'Échec : ' + (e.message || e); }
  };
  $('#sendcode').onclick = async () => {
    msg.textContent = 'Vérification…';
    try { await backend.remote().verifyCode($('#mail').value.trim(), $('#code').value); msg.textContent = ''; dlg.close(); }
    catch (e) { msg.textContent = 'Code refusé : ' + (e.message || e); }
  };
  on('session', () => { if (state.user && dlg.open) dlg.close(); });
}

/** Ouvre la fenêtre de connexion au démarrage si le mode partagé est actif et qu'aucune session n'existe. */
export function promptIfSignedOut() {
  if (!state.user && !$('#auth').open) $('#auth').showModal();
}
