// Onglet Tableau : le tableau de tri est importé depuis une photo, lu par le serveur de vision, puis corrigeable à la main.
import { $, esc } from './util.js';
import { state, on, isAdmin, canDelete } from './store.js';
import { formatTable, parseTable } from './match.js';
import * as backend from './backend.js';
import { hasReaderServer, readTablePiece, getBoard, putBoard, getStreets } from './reader.js';
import { storeVillages, knownCps } from './villages.js';
import { grayOf, planTiles, tileJpeg, mergeBoardRows, rowLine } from './board-scan.js';
import { mainName } from './postcodes.js';

/* Lignes « à vérifier » : Map(ligne → raison), gardées sur le téléphone et sur le serveur avec le tableau. */
const FLAGS = 'tableChecks', UPDATED = 'boardUpdated';
function loadFlags() {
  try {
    const v = JSON.parse(localStorage.getItem(FLAGS) || '{}');
    return new Map(Array.isArray(v) ? v.map(l => [l, '']) : Object.entries(v));   // ancien format : liste
  } catch { return new Map(); }
}
const saveFlags = map => { try { localStorage.setItem(FLAGS, JSON.stringify(Object.fromEntries(map))); } catch { /* stockage indisponible */ } };
const ls = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* */ } } };
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
  renderChecks();
  renderLearned();
}

/* ----- Lignes à vérifier : une liste avec ✓ (valider), ✎ (corriger), × (supprimer), et « Tout valider » ----- */
function renderChecks() {
  const box = $('#tcheck'), flags = loadFlags();
  const lines = formatTable(state.ranges).split('\n').filter(l => flags.has(l));
  if (!lines.length || !isAdmin()) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="head-row"><h3>${lines.length} ligne${lines.length > 1 ? 's' : ''} à vérifier</h3>
      <button class="btn sm" data-allok type="button">Tout valider</button></div>
    <p class="hint">Comparez avec le tableau du bureau : ✓ si la ligne est juste, ✎ pour la corriger, × si elle n'existe pas.</p>
    <div class="list">${lines.map(l => {
      const [r] = parseTable(l), segs = parseTable(l).filter(x => x.from_n > 0 || x.to_n < 99999).map(x => x.from_n === x.to_n ? x.from_n : x.from_n + '–' + x.to_n);
      return `<div class="item wrap chk-item" data-line="${esc(l)}">
        <div class="main"><b>${esc(r?.street ?? l)}</b><span class="sub">${esc(r?.cp ?? '')} · tournée ${esc(r?.tournee ?? '?')}${segs.length ? ' · n° ' + esc(segs.join(', ')) : ''}${flags.get(l) ? '<br><span class="wa">' + esc(flags.get(l)) + '</span>' : ''}</span></div>
        <button class="icon-btn ok" data-ok aria-label="Valider">✓</button>
        <button class="icon-btn" data-edit aria-label="Corriger">✎</button>
        <button class="del" data-rm aria-label="Supprimer">×</button>
      </div>`;
    }).join('')}</div>`;
}

async function onCheckClick(e) {
  const b = e.target.closest('button'); if (!b) return;
  const flags = loadFlags();
  if (b.dataset.allok !== undefined) {
    const n = [...flags.keys()].length;
    if (!confirm(`Valider les ${n} lignes à vérifier ?`)) return;
    saveFlags(new Map()); renderTable(); pushBoard(); return;
  }
  const item = b.closest('[data-line]'); if (!item) return;
  const line = item.dataset.line;
  if (b.dataset.ok !== undefined) { flags.delete(line); saveFlags(flags); renderTable(); pushBoard(); return; }
  if (b.dataset.rm !== undefined) {
    if (!confirm('Supprimer cette ligne du tableau ?')) return;
    await save(tableText().split('\n').filter(l => canon(l) !== line).join('\n')); renderTable(); return;
  }
  if (b.dataset.edit !== undefined) {
    if (item.querySelector('.row')) return;
    item.insertAdjacentHTML('beforeend', `<div class="row learn"><input value="${esc(line)}" aria-label="Ligne corrigée" spellcheck="false"><button class="btn sm" data-fix type="button">OK</button></div>`);
    item.querySelector('input').focus();
    return;
  }
  if (b.dataset.fix !== undefined) {
    const fixed = item.querySelector('input').value.trim();
    if (!parseTable(fixed).length) { alert('Ligne non reconnue. Exemple : 5620 009 Rue d\'Anthée 2-146 / 1-147'); return; }
    flags.delete(line); saveFlags(flags);
    await save(tableText().split('\n').map(l => (canon(l) === line ? fixed : l)).join('\n'));
    renderTable();
  }
}

/* ----- Copie du tableau sur le serveur (il revient après une réinstallation, et est partagé entre téléphones) ----- */
let pushing = null;
export async function pushBoard() {
  if (!hasReaderServer()) return;
  const board = { text: formatTable(state.ranges), checks: Object.fromEntries(loadFlags()) };
  if (!board.text) return;
  pushing = putBoard(board).then(r => { ls.set(UPDATED, String(r.updated)); fetchVillages(); })
    .catch(e => console.warn('Copie du tableau sur le serveur impossible', e)).finally(() => { pushing = null; });
  return pushing;
}

/** Au démarrage ou après réglage du serveur : récupère le tableau du serveur s'il est plus récent (ou si le téléphone n'en a pas). */
export async function syncBoardFromServer() {
  if (!hasReaderServer()) return 'pas de serveur';
  try {
    const b = await getBoard();
    const local = +(ls.get(UPDATED) || 0), empty = !state.ranges.some(r => r.source !== 'learned' && !String(r.id).startsWith('demo-'));
    if (b?.text && (empty || b.updated > local)) {
      await save(b.text, { push: false, checks: b.checks });
      ls.set(UPDATED, String(b.updated));
      $('#tmsg').textContent = `Tableau récupéré sur le serveur (${formatTable(state.ranges).split('\n').filter(Boolean).length} rues).`;
    } else if (!b?.text && !empty) pushBoard();                // serveur vide : on lui donne le tableau du téléphone
    fetchVillages();
    return 'ok';
  } catch (e) { console.warn('Tableau du serveur indisponible', e); return 'erreur'; }
}

/** Villages des rues du tableau (recherche par localité), demandés pour les codes postaux pas encore connus. */
async function fetchVillages() {
  const cps = [...new Set(state.ranges.map(r => r.cp))].filter(cp => /^\d{4}$/.test(cp) && !knownCps().includes(cp));
  if (!cps.length || !hasReaderServer()) return;
  try { storeVillages(await getStreets(cps)); } catch (e) { console.warn('Villages indisponibles', e); }
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

/**
 * Enregistre le texte donné comme tableau. Les lignes « ? » restent à vérifier, avec leur raison si elle est connue
 * (`reasons` : Map(ligne → raison), ou `checks` venant du serveur). Le tableau est ensuite copié sur le serveur.
 */
async function save(text, { reasons = new Map(), checks = null, push = true } = {}) {
  const lines = text.split('\n').filter(l => l.trim());
  const rows = parseTable(text);
  const old = loadFlags();
  if (checks) saveFlags(new Map(Object.entries(checks)));
  else saveFlags(new Map(lines.filter(l => /^\s*\?/.test(l)).map(canon).filter(Boolean).map(l => [l, reasons.get(l) ?? old.get(l) ?? ''])));
  // Localités desservies : déduites des codes postaux du tableau (liste nationale).
  const localities = [...new Set(rows.map(r => r.cp))].sort().map(cp => ({ cp, city: mainName(cp) })).filter(l => l.city);
  await backend.saveTable(rows, localities);
  const read = new Set(rows.map(r => [r.cp, r.tournee, r.street].join('|'))).size;
  if (push) pushBoard();
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
    const reasons = new Map(rows.filter(r => r.check).map(r => [canon(rowLine(r)), r.why]));
    const { read } = await save([existing, ...fresh].filter(Boolean).join('\n'), { reasons });
    const bad = rows.filter(r => r.check).length;
    msg.textContent = `${rows.length} lignes lues${stop ? ' (import arrêté avant la fin)' : ''}, ${fresh.length} ajoutées. Le tableau compte ${read} rues.`
      + (bad ? ` ${bad} à vérifier ci-dessous.` : '') + (failed ? ` ${failed} morceau(x) non lu(s).` : '')
      + (noColumns ? ` ${noColumns} photo(s) sans colonnes reconnues.` : '');

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
  $('#tcheck').addEventListener('click', onCheckClick);
  $('#learned').addEventListener('click', async e => {
    const id = e.target.dataset?.del; if (!id) return;
    const r = state.ranges.find(x => x.id === id) ?? { id, pending: true };
    try { await backend.deleteRange(r); } catch (err) { $('#tmsg').textContent = 'Suppression refusée : ' + (err.message || err); }
  });
  on('ranges', renderTable);
  on('session', renderTable);
  renderTable();
}
