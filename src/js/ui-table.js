// Onglet Tableau : le tableau de tri est importé depuis une photo, lu par le serveur de vision, puis corrigeable à la main.
import { $, esc } from './util.js';
import { state, on, isAdmin, canDelete } from './store.js';
import { formatTable, parseTable } from './match.js';
import * as backend from './backend.js';
import { hasReaderServer, readTablePiece } from './reader.js';
import { grayOf, planTiles, tileJpeg, mergeBoardRows, rowLine } from './board-scan.js';
import { mainName } from './postcodes.js';

/* Lignes « à vérifier » : gardées sur l'appareil (la base ne stocke que les plages). */
const FLAGS = 'tableChecks';
const loadFlags = () => { try { return new Set(JSON.parse(localStorage.getItem(FLAGS) || '[]')); } catch { return new Set(); } };
const saveFlags = set => { try { localStorage.setItem(FLAGS, JSON.stringify([...set])); } catch { /* stockage indisponible */ } };
/** Forme canonique d'une ligne (celle que produit formatTable), sans le « ? ». */
const canon = line => formatTable(parseTable(line.replace(/^\s*\?\s*/, '')));

/** Texte complet du tableau, les lignes à vérifier en tête et précédées de « ? ». */
function tableText() {
  const flags = loadFlags(), lines = formatTable(state.ranges).split('\n').filter(Boolean);
  const bad = lines.filter(l => flags.has(l)), good = lines.filter(l => !flags.has(l));
  return [...bad.map(l => '? ' + l), ...(bad.length && good.length ? [''] : []), ...good].join('\n');
}

export function renderTable() {
  const admin = isAdmin(), tt = $('#tt');
  if (document.activeElement !== tt) tt.value = tableText();   // ne pas écraser une saisie en cours
  tt.readOnly = !admin;
  $('#tadmin').hidden = $('#tadmin2').hidden = !admin;
  renderSummary();
  renderLearned();
}

function renderSummary() {
  const rows = state.ranges.filter(r => r.source !== 'learned');
  const lines = formatTable(rows).split('\n').filter(Boolean), flags = loadFlags();
  const bad = lines.filter(l => flags.has(l)).length;
  const tours = new Set(rows.map(r => r.tournee)).size, cps = new Set(rows.map(r => r.cp)).size;
  $('#tsum').innerHTML = lines.length
    ? `<b>${lines.length}</b> rue${lines.length > 1 ? 's' : ''} · <b>${tours}</b> tournée${tours > 1 ? 's' : ''} · <b>${cps}</b> ${cps > 1 ? 'codes postaux' : 'code postal'}`
      + (bad ? `<br><span class="wa">${bad} ligne${bad > 1 ? 's' : ''} à vérifier</span>` : '')
    : '<span class="empty">Aucun tableau pour l\'instant.</span>';
}

export function renderLearned() {
  const list = [...state.ranges.filter(r => r.source === 'learned'),
    ...state.pending.filter(p => p.op === 'add').map(p => ({ ...p.range, pending: true, id: p.cid }))];
  $('#learned').innerHTML = list.map(l => `<div class="item">
    <div class="main"><b>${esc(l.street)}</b><span class="sub">${esc(l.cp)} · n° ${l.from_n}${l.to_n !== l.from_n ? '–' + l.to_n : ''}${l.pending ? ' · en attente d\'envoi' : ''}</span></div>
    <span class="badge">${esc(l.tournee)}</span>
    ${canDelete(l) ? `<button class="del" data-del="${esc(l.id)}" aria-label="Supprimer">×</button>` : ''}</div>`).join('')
    || '<p class="empty">Aucun ajout pour l\'instant.</p>';
}

/** Enregistre le texte donné comme tableau (les lignes « ? » restent marquées à vérifier). */
async function save(text) {
  const lines = text.split('\n').filter(l => l.trim());
  const rows = parseTable(text);
  saveFlags(new Set(lines.filter(l => /^\s*\?/.test(l)).map(canon).filter(Boolean)));
  // Localités desservies : déduites des codes postaux du tableau (liste nationale).
  const localities = [...new Set(rows.map(r => r.cp))].sort().map(cp => ({ cp, city: mainName(cp) })).filter(l => l.city);
  await backend.saveTable(rows, localities);
  const read = new Set(rows.map(r => [r.cp, r.tournee, r.street].join('|'))).size;
  return { read, ignored: Math.max(0, lines.length - read) };
}

let stop = false;

/** Photo(s) du tableau → morceaux (une colonne à la fois) → lecture par le serveur → lignes ajoutées au tableau. */
async function importPhotos(files) {
  const msg = $('#tmsg'), prog = $('#tprog');
  if (!hasReaderServer()) { msg.textContent = 'L\'import par photo demande le serveur de lecture (OCR_SERVER_URL).'; return; }
  stop = false; msg.textContent = ''; prog.hidden = false; $('#tph').disabled = true;
  const setProg = (done, total, label) => { $('#tbar').style.width = (total ? Math.round(done / total * 100) : 0) + '%'; $('#tstep').textContent = label; };
  const pieces = [], zone = new Set(state.ranges.map(r => r.cp));
  let failed = 0, noColumns = 0, colBase = 0;
  try {
    for (const [fi, f] of [...files].entries()) {
      setProg(0, 1, `Photo ${fi + 1}/${files.length} : recherche des colonnes…`);
      const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      await new Promise(r => setTimeout(r));                     // laisse l'écran s'afficher avant le calcul
      const plan = planTiles(grayOf(c), c.width, c.height);
      if (!plan.tiles.length) { noColumns++; continue; }
      const t0 = Date.now();
      for (const [i, t] of plan.tiles.entries()) {
        if (stop) break;
        const left = i ? Math.round((Date.now() - t0) / i * (plan.tiles.length - i) / 1000) : null;
        setProg(i, plan.tiles.length, `Photo ${fi + 1}/${files.length} · morceau ${i + 1}/${plan.tiles.length}`
          + (left != null ? ` · encore ${left >= 90 ? Math.round(left / 60) + ' min' : left + ' s'}` : ''));
        try {
          const rows = await readTablePiece(await tileJpeg(c, t), [...zone]);
          rows.forEach(r => { if (/^\d{4}$/.test(r.cp) && !r.check) zone.add(r.cp); });
          pieces.push({ col: colBase + t.col, row: t.row, rows });
        } catch (e) { failed++; console.warn('Morceau non lu', e); if (failed >= 4 && !pieces.length) throw e; }
      }
      colBase += plan.columns;
      if (stop) break;
    }
    const rows = mergeBoardRows(pieces);
    if (!rows.length) {
      msg.textContent = noColumns ? 'Colonnes du tableau non reconnues : prenez la photo bien de face, nette, tout le tableau visible.' : 'Aucune ligne lue.';
      return;
    }
    // Les nouvelles lignes s'ajoutent au tableau existant (le tableau de démonstration est remplacé).
    const demo = state.ranges.some(r => String(r.id).startsWith('demo-'));
    const existing = demo ? '' : tableText();
    const have = new Set(existing.split('\n').map(canon));
    const fresh = rows.map(rowLine).filter(l => !have.has(canon(l)));
    setProg(1, 1, 'Enregistrement…');
    const { read } = await save([existing, ...fresh].filter(Boolean).join('\n'));
    const bad = rows.filter(r => r.check).length;
    msg.textContent = `${rows.length} lignes lues${stop ? ' (import arrêté avant la fin)' : ''}, ${fresh.length} ajoutées. Le tableau compte ${read} rues.`
      + (bad ? ` ${bad} à vérifier ci-dessous.` : '') + (failed ? ` ${failed} morceau(x) non lu(s).` : '')
      + (noColumns ? ` ${noColumns} photo(s) sans colonnes reconnues.` : '');
    if (bad) $('#tedit').open = true;
  } catch (e) {
    msg.textContent = 'Import interrompu : ' + (e.message || e);
  } finally { prog.hidden = true; $('#tph').disabled = false; }
}

export function initTable() {
  $('#tph').onclick = () => $('#tf').click();
  $('#tf').onchange = async e => { const files = [...e.target.files]; e.target.value = ''; if (files.length) await importPhotos(files); };
  $('#tstop').onclick = () => { stop = true; $('#tstep').textContent = 'Arrêt après ce morceau…'; };
  $('#tsave').onclick = async () => {
    const msg = $('#tmsg'); msg.textContent = 'Enregistrement…';
    try {
      const { read, ignored } = await save($('#tt').value);
      $('#tt').blur();
      msg.textContent = `${read} rue(s) enregistrée(s)` + (ignored ? ` — ${ignored} ligne(s) non reconnue(s), ignorée(s).` : '.')
        + (backend.isShared() ? ' Partagé avec tous les facteurs.' : '');
      renderTable();
    } catch (err) { msg.textContent = 'Échec : ' + (err.message || err); }
  };
  $('#tclear').onclick = async () => {
    if (!confirm('Vider tout le tableau des tournées ? Les ajouts appris par les facteurs sont conservés.')) return;
    try { await save(''); $('#tmsg').textContent = 'Tableau vidé.'; renderTable(); } catch (err) { $('#tmsg').textContent = 'Échec : ' + (err.message || err); }
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
