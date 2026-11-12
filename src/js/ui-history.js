import { $, esc } from './util.js';
import { state, on, setHist } from './store.js';
import { clsGlobal } from './match.js';
import { learnForm } from './ui-scan.js';

export function renderHist() {
  const only = $('#onlyerr').checked;
  const list = state.hist.filter(h => !only || h.score < 0.9);
  $('#hl').innerHTML = list.map(h => `<div class="item${h.score < 0.9 ? ' wrap' : ''}">
    ${h.thumb ? `<img src="${esc(h.thumb)}" alt="">` : '<img alt="">'}
    <div class="main"><b>${esc(h.a.num ?? '?')} ${esc(h.a.street) || '(rue non lue)'}</b>
      <span class="sub">${esc(h.a.cp)} ${esc(h.a.city)} · ${esc(h.t)}${h.hand ? ' · manuscrit' : ''}${h.fixed ? ' · corrigé' : ''}</span></div>
    <span class="badge ${h.tournee ? clsGlobal(h.score) : 'ko'}" title="${Math.round(h.score * 100)} %">${h.tournee ? esc(h.tournee) : '—'}</span>
    ${h.score < 0.9 ? learnForm(h.id) : ''}</div>`).join('') || `<p class="empty">${only ? 'Aucun doute.' : 'Aucune lettre scannée.'}</p>`;
  $('#hclr').hidden = !state.hist.length;
}

export function initHistory() {
  $('#onlyerr').onchange = renderHist;
  $('#hclr').onclick = () => { if (confirm('Vider l\'historique de cet appareil ?')) setHist([]); };
  on('hist', renderHist);
  renderHist();
}
