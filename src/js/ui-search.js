// Onglet Localités : une ville, un village ou un code postal → les tournées qui le desservent, avec leurs rues.
import { $, esc } from './util.js';
import { state, on, effectiveRanges } from './store.js';
import { localityIndex, searchLocality, fmtRange, norm, sim } from './match.js';
import { fullIndex } from './postcodes.js';
import { villageOf, villageNames } from './villages.js';

/** Villages connus (rues du tableau) qui correspondent à la recherche : nom identique, début du nom, ou faute légère. */
export function matchVillages(q, names) {
  const nq = norm(q);
  if (nq.length < 2) return [];
  const exact = names.filter(n => norm(n) === nq);
  if (exact.length) return exact;
  return names.filter(n => (nq.length >= 3 && norm(n).startsWith(nq)) || sim(n, q) >= 0.8);
}

const tourHtml = res => res.map(t => `<div class="tour"><h4>Tournée <b>${esc(t.tournee)}</b></h4>` +
  t.streets.map(s => `<div class="st"><span>${esc(s.key.replace(/^\d{4} /, ''))}</span><small>${s.ranges.some(r => r[0] > 0 || r[1] < 99999) ? 'n° ' : ''}${s.ranges.map(fmtRange).join(', ')}</small></div>`).join('') + '</div>').join('');

export function renderSearch() {
  const q = $('#q').value.trim(), out = $('#qr');
  if (!q) { out.innerHTML = '<p class="empty">Cherchez une ville, un village ou un code postal pour voir ses tournées et ses rues.</p>'; return; }
  const ranges = effectiveRanges();

  // 1. Village précis (« Sautour », « Neuville ») : seulement les rues de ce village, grâce au village de chaque rue.
  if (!/^\d+$/.test(q)) {
    const found = matchVillages(q, [...villageNames().keys()]);
    if (found.length) {
      const keep = new Set(found.map(n => n.toLowerCase()));
      const rs = ranges.filter(r => keep.has(villageOf(r).toLowerCase()));
      if (rs.length) {
        const res = searchLocality(q, rs, new Map([...new Set(rs.map(r => r.cp))].map(cp => [cp, new Set([q])])));
        const cps = [...new Set(rs.map(r => r.cp))].join(', ');
        out.innerHTML = `<p class="hint"><b>${esc(found.slice(0, 4).join(', '))}</b>${found.length > 4 ? '…' : ''} (${esc(cps)}) · ${res.length} tournée${res.length > 1 ? 's' : ''}, ${new Set(rs.map(r => r.street)).size} rue${rs.length > 1 ? 's' : ''}</p>` + tourHtml(res);
        return;
      }
    }
  }

  // 2. Sinon : tout le code postal de la localité (liste nationale), ou le code postal tapé.
  const res = searchLocality(q, ranges, fullIndex(() => localityIndex(state.localities, ranges)));
  if (!res.length) { out.innerHTML = '<p class="empty">Aucune tournée pour cette localité.</p>'; return; }
  out.innerHTML = `<p class="hint">${res.length} tournée${res.length > 1 ? 's' : ''} pour tout le code postal${villageNames().size ? '' : ' (réglez le serveur pour chercher aussi par village)'}</p>` + tourHtml(res);
}

export function initSearch() {
  $('#q').oninput = renderSearch;
  on('ranges', renderSearch);
  renderSearch();
}
