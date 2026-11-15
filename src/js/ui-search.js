import { $, esc } from './util.js';
import { state, on, effectiveRanges } from './store.js';
import { localityIndex, searchLocality, fmtRange } from './match.js';
import { fullIndex } from './postcodes.js';

export function renderSearch() {
  const q = $('#q').value.trim(), out = $('#qr');
  if (!q) { out.innerHTML = '<p class="empty">Cherchez une localité pour voir ses tournées et ses rues.</p>'; return; }
  const ranges = effectiveRanges();
  const res = searchLocality(q, ranges, fullIndex(() => localityIndex(state.localities, ranges)));
  if (!res.length) { out.innerHTML = '<p class="empty">Aucune tournée pour cette localité.</p>'; return; }
  out.innerHTML = res.map(t => `<div class="tour"><h4>Tournée <b>${esc(t.tournee)}</b></h4>` +
    t.streets.map(s => `<div class="st"><span>${esc(s.key)}</span><small>${s.ranges.some(r => r[0] > 0 || r[1] < 99999) ? 'n° ' : ''}${s.ranges.map(fmtRange).join(', ')}</small></div>`).join('') + '</div>').join('');
}

export function initSearch() {
  $('#q').oninput = renderSearch;
  on('ranges', renderSearch);
  renderSearch();
}
