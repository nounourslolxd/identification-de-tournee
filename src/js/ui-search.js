// Onglet Localités : une ville, un village ou un code postal → les tournées qui le desservent, avec leurs rues.
import { $, esc } from './util.js';
import { state, on, effectiveRanges } from './store.js';
import { localityIndex, searchLocality, searchStreets, fmtRange, norm, sim } from './match.js';
import { fullIndex, mainName } from './postcodes.js';
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

const rangesText = rs => (rs.some(r => r[0] > 0 || r[1] < 99999) ? 'n° ' : '') + rs.map(fmtRange).join(', ');
const TYPED_STREET = /^(rue|ruelle|avenue|av|place|allee|allée|chemin|route|quartier|boulevard|bd|impasse|chaussee|chaussée|clos|sentier|cite|cité|tienne|square|quai|dreve|drève|cour)\b/i;

/** Une carte par rue trouvée : son nom, son village, puis chaque tournée qui la dessert avec ses numéros. */
const streetHtml = list => list.map(s => `<div class="tour"><h4 class="street-h"><b>${esc(s.street)}</b><small>${esc(s.cp)} ${esc(villageOf(s) || mainName(s.cp))}</small></h4>` +
  s.tours.map(t => `<div class="st"><span>Tournée <b>${esc(t.tournee)}</b></span><small>${esc(rangesText(t.ranges))}</small></div>`).join('') + '</div>').join('');

export function renderSearch() {
  const q = $('#q').value.trim(), out = $('#qr');
  if (!q) { out.innerHTML = '<p class="empty">Cherchez une ville, un village, un code postal ou une rue pour voir ses tournées.</p>'; return; }
  const ranges = effectiveRanges();

  // 0. Rues du tableau dont le nom correspond (« gueule du loup », « rue de namur », « namur 5620 »).
  const streets = /^\d+$/.test(q) ? [] : searchStreets(q, ranges);
  const streetBlock = streets.length
    ? `<h3>Rue${streets.length > 1 ? 's' : ''} (${streets.length}${streets.length >= 30 ? '+' : ''})</h3>` + streetHtml(streets) : '';
  // La rue passe avant la ville si on a tapé un type de voie, un code postal avec un nom, ou un nom de rue exact.
  const streetFirst = TYPED_STREET.test(norm(q)) || /\d{4}/.test(q) || streets[0]?.score === 1;

  // 1. Village précis (« Sautour », « Neuville ») : seulement les rues de ce village, grâce au village de chaque rue.
  if (!/^\d+$/.test(q)) {
    const found = matchVillages(q, [...villageNames().keys()]);
    if (found.length) {
      const keep = new Set(found.map(n => n.toLowerCase()));
      const rs = ranges.filter(r => keep.has(villageOf(r).toLowerCase()));
      if (rs.length) {
        const res = searchLocality(q, rs, new Map([...new Set(rs.map(r => r.cp))].map(cp => [cp, new Set([q])])));
        const cps = [...new Set(rs.map(r => r.cp))].join(', ');
        const villageBlock = `<h3>Localité</h3><p class="hint"><b>${esc(found.slice(0, 4).join(', '))}</b>${found.length > 4 ? '…' : ''} (${esc(cps)}) · ${res.length} tournée${res.length > 1 ? 's' : ''}, ${new Set(rs.map(r => r.street)).size} rue${rs.length > 1 ? 's' : ''}</p>` + tourHtml(res);
        out.innerHTML = streetFirst ? streetBlock + villageBlock : villageBlock + streetBlock;
        return;
      }
    }
  }

  // 2. Sinon : tout le code postal de la localité (liste nationale), ou le code postal tapé.
  const res = streetFirst && streets.length ? [] : searchLocality(q, ranges, fullIndex(() => localityIndex(state.localities, ranges)));
  if (!res.length && !streets.length) { out.innerHTML = '<p class="empty">Aucune tournée pour cette recherche.</p>'; return; }
  const cpBlock = res.length ? `<h3>Localité</h3><p class="hint">${res.length} tournée${res.length > 1 ? 's' : ''} pour tout le code postal${villageNames().size ? '' : ' (réglez le serveur pour chercher aussi par village)'}</p>` + tourHtml(res) : '';
  out.innerHTML = streetFirst ? streetBlock + cpBlock : cpBlock + streetBlock;
}

export function initSearch() {
  $('#q').oninput = renderSearch;
  on('ranges', renderSearch);
  renderSearch();
}
