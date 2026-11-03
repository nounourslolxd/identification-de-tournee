import { $, esc } from './util.js';
import { state, on, effectiveRanges } from './store.js';
import { localityIndex, searchLocality, fmtRange } from './match.js';

export function renderSearch() {
  const q = $('#q').value.trim(), out = $('#qr');
  if (!q) { out.innerHTML = '<p class="mu">Tapez un nom de localité ou un code postal.</p>'; return; }
  const ranges = effectiveRanges();
  const extra = state.hist.map(h => ({ cp: h.a?.cp, city: h.a?.city }));
  const res = searchLocality(q, ranges, localityIndex(state.localities, ranges, extra));
  if (!res.length) { out.innerHTML = '<p class="mu">Aucune tournée trouvée pour cette localité.</p>'; return; }
  out.innerHTML = res.map(t => `<div class="card"><b class="big">Tournée ${esc(t.tournee)}</b>` +
    t.streets.map(s => `<div>${esc(s.key)} <small>n° ${s.ranges.map(fmtRange).join(', ')}</small></div>`).join('') + '</div>').join('');
}

export function initSearch() {
  $('#q').oninput = renderSearch;
  on('ranges', renderSearch);
  renderSearch();
}
