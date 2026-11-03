// Copie Tesseract.js (worker, noyau wasm, langue française) et le client Supabase depuis node_modules
// vers src/vendor/, pour tout servir depuis GitHub Pages sans appel à un CDN.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = p => join(root, 'node_modules', p);
const out = join(root, 'src', 'vendor');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'tesseract'), { recursive: true });
mkdirSync(join(out, 'lang'), { recursive: true });

function need(path) {
  if (!existsSync(path)) {
    console.error(`✘ Fichier introuvable : ${path}\n  Avez-vous lancé « npm ci » ? Sinon la structure du paquet a changé : adaptez scripts/vendor.mjs.`);
    process.exit(1);
  }
  return path;
}
const copy = (from, to) => { cpSync(need(from), join(out, to)); console.log('  ✓', to); };

copy(nm('tesseract.js/dist/tesseract.min.js'), 'tesseract/tesseract.min.js');
copy(nm('tesseract.js/dist/worker.min.js'), 'tesseract/worker.min.js');

const coreDir = need(nm('tesseract.js-core'));
const cores = readdirSync(coreDir).filter(f => /^tesseract-core.*\.(js|wasm)$/.test(f));
if (!cores.length) { console.error('✘ Aucun tesseract-core* dans tesseract.js-core'); process.exit(1); }
for (const f of cores) copy(join(coreDir, f), 'tesseract/' + f);

// Langue : on préfère le modèle « best_int » (meilleure précision), sinon le standard.
const langRoot = need(nm('@tesseract.js-data/fra'));
const variants = ['4.0.0_best_int', '4.0.0', '4.0.0_fast'];
const found = variants.map(v => join(langRoot, v, 'fra.traineddata.gz')).find(existsSync);
if (!found) { console.error('✘ fra.traineddata.gz introuvable dans @tesseract.js-data/fra'); process.exit(1); }
copy(found, 'lang/fra.traineddata.gz');

copy(nm('@supabase/supabase-js/dist/umd/supabase.js'), 'supabase.js');
console.log('Vendor OK');
