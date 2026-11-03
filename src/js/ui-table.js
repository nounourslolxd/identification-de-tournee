import { $, esc } from './util.js';
import { state, on, isAdmin, canDelete } from './store.js';
import { formatTable, parseTable, parseLocalities } from './match.js';
import * as backend from './backend.js';
import { ocr } from './ocr.js';

export function renderTable() {
  const admin = isAdmin();
  const tt = $('#tt'), tl = $('#tl');
  // Ne pas écraser une saisie en cours.
  if (document.activeElement !== tt) tt.value = formatTable(state.ranges);
  if (document.activeElement !== tl) tl.value = state.localities.map(l => `${l.cp} ${l.city}`).join('\n');
  tt.readOnly = tl.readOnly = !admin;
  $('#tadmin').hidden = !admin;
  renderLearned();
}

export function renderLearned() {
  const list = [...state.ranges.filter(r => r.source === 'learned'),
    ...state.pending.filter(p => p.op === 'add').map(p => ({ ...p.range, pending: true, id: p.cid }))];
  $('#learned').innerHTML = list.map(l => `<div class="card">${esc(l.cp)} ${esc(l.street)} n°${l.from_n}${l.to_n !== l.from_n ? '–' + l.to_n : ''} → <b>T${esc(l.tournee)}</b>
    ${l.pending ? '<small>⏳ en attente d\'envoi</small>' : ''}
    ${canDelete(l) ? `<button class="b s" data-del="${esc(l.id)}" aria-label="Supprimer">×</button>` : ''}</div>`).join('')
    || '<p class="mu">Rien pour l\'instant.</p>';
}

export function initTable() {
  $('#tsave').onclick = async () => {
    const rows = parseTable($('#tt').value);
    const locs = parseLocalities($('#tl').value);
    const lines = $('#tt').value.split('\n').filter(l => l.trim()).length;
    const msg = $('#tmsg');
    msg.textContent = 'Enregistrement…';
    try {
      await backend.saveTable(rows, locs);
      msg.textContent = `${rows.length} plage(s) enregistrée(s)` + (lines > rows.length ? ` — ${lines - rows.length} ligne(s) non reconnue(s), ignorée(s).` : '.')
        + (backend.isShared() ? ' Partagé avec tous les facteurs.' : '');
    } catch (e) { msg.textContent = 'Échec : ' + (e.message || e); }
  };
  $('#tph').onclick = () => $('#tf').click();
  $('#tf').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    const msg = $('#tmsg'); msg.textContent = 'Lecture du tableau…';
    try {
      const im = await createImageBitmap(f), c = document.createElement('canvas');
      c.width = im.width; c.height = im.height; c.getContext('2d').drawImage(im, 0, 0);
      const tt = $('#tt'); tt.value += (tt.value ? '\n' : '') + await ocr(c, true);
      msg.textContent = 'Vérifiez et corrigez le texte, puis Enregistrer.';
    } catch (err) { msg.textContent = err.message; }
    e.target.value = '';
  };
  $('#learned').addEventListener('click', async e => {
    const id = e.target.dataset?.del; if (!id) return;
    const r = state.ranges.find(x => x.id === id) ?? { id, pending: true };
    try { await backend.deleteRange(r); } catch (err) { $('#tmsg').textContent = 'Suppression refusée : ' + (err.message || err); }
  });
  on('ranges', renderTable);
  on('session', renderTable);
  renderTable();
}
