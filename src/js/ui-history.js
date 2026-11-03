import { $, esc } from './util.js';
import { state, on, setHist } from './store.js';
import { clsGlobal } from './match.js';
import { learnForm } from './ui-scan.js';

export function renderHist() {
  const only = $('#onlyerr').checked;
  const list = state.hist.filter(h => !only || h.score < 0.9);
  $('#hl').innerHTML = list.map(h => `<div class="card"><div class="h">
    ${h.thumb ? `<img src="${esc(h.thumb)}" alt="">` : '<img alt="">'}
    <div style="flex:1"><b>${esc(h.a.num ?? '?')} ${esc(h.a.street) || '(rue non lue)'}</b><br><small>${esc(h.a.cp)} ${esc(h.a.city)} · ${esc(h.t)}</small></div>
    <div style="text-align:right"><b class="${clsGlobal(h.score)}">${h.tournee ? 'T' + esc(h.tournee) : '—'}</b><br><small>${Math.round(h.score * 100)}%${h.fixed ? ' ✎' : ''}</small></div></div>
    ${h.score < 0.9 ? learnForm(h.id) : ''}</div>`).join('') || '<p class="mu">Aucune lettre.</p>';
}

export function initHistory() {
  $('#onlyerr').onchange = renderHist;
  $('#hclr').onclick = () => { if (confirm('Vider l\'historique de cet appareil ?')) setHist([]); };
  on('hist', renderHist);
  renderHist();
}
