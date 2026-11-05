// src/ → dist/ : copie, génère js/config.js depuis l'environnement, versionne le service worker.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src'), dist = join(root, 'dist');

// Variables : environnement, sinon fichier .env local.
const env = { ...process.env };
const envFile = join(root, '.env');
if (existsSync(envFile)) {
  for (const l of readFileSync(envFile, 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in env)) env[m[1]] = m[2];
  }
}

rmSync(dist, { recursive: true, force: true });
cpSync(src, dist, { recursive: true });
rmSync(join(dist, 'js', 'config.example.js'), { force: true });

const url = env.SUPABASE_URL || '', key = env.SUPABASE_ANON_KEY || '';
if (key.startsWith('eyJ') && JSON.parse(Buffer.from(key.split('.')[1] || '', 'base64url').toString() || '{}').role === 'service_role') {
  console.error('✘ SUPABASE_ANON_KEY est une clé service_role : refusé. Utilisez la clé « anon ».');
  process.exit(1);
}
writeFileSync(join(dist, 'js', 'config.js'),
  `export const config = ${JSON.stringify({ supabaseUrl: url, supabaseAnonKey: key, ocrServerUrl: env.OCR_SERVER_URL || '' }, null, 2)};\n`);
if (env.OCR_SERVER_URL && !/^https:\/\/|^http:\/\/localhost\b/.test(env.OCR_SERVER_URL)) {
  console.error('✘ OCR_SERVER_URL doit être en HTTPS (le téléphone refuse d\'envoyer vers HTTP depuis une page HTTPS).');
  process.exit(1);
}
if (!url || !key) console.warn('⚠ SUPABASE_URL / SUPABASE_ANON_KEY absents : l\'application fonctionnera en mode local.');

// Service worker : liste de la coquille + version = empreinte du contenu.
const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) { if (f !== 'vendor') walk(p); }
    else if (f !== 'sw.js') files.push(p);
  }
})(dist);
const shell = ['./', ...files.map(p => relative(dist, p).split('\\').join('/'))].sort();
const h = createHash('sha256');
for (const f of files.sort()) h.update(f).update(readFileSync(f));
const swPath = join(dist, 'sw.js');
writeFileSync(swPath, readFileSync(swPath, 'utf8')
  .replace("const VERSION = '__VERSION__';", `const VERSION = '${h.digest('hex').slice(0, 12)}';`)
  .replace('const SHELL = __SHELL__;', () => `const SHELL = ${JSON.stringify(shell)};`));
console.log(`Build OK : ${shell.length} fichiers dans la coquille`);
