// Serveur de lecture d'adresses (manuscrites et imprimées) — à héberger soi-même.
//   POST /read   corps = image JPEG/PNG/WebP, en-tête Authorization: Bearer <jeton Supabase du facteur>
//   POST /table  corps = morceau d'une photo du tableau de tri (une colonne) → lignes « code postal, tournée, rue, plages »
//   GET  /health état du modèle et du répertoire
// Les images sont traitées en mémoire puis oubliées : rien n'est écrit sur disque ni dans les journaux.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createGazetteer, loadGazetteer } from './gazetteer.mjs';
import { createVision } from './vision.mjs';
import { readLetter } from './pipeline.mjs';
import { TABLE_PROMPT, parseModelRows, resolveRows } from './board.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/* ----- configuration : variables d'environnement, sinon server/.env ----- */
const env = { ...process.env };
if (existsSync(join(here, '.env'))) {
  for (const l of readFileSync(join(here, '.env'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in env)) env[m[1]] = m[2];
  }
}
const cfg = {
  port: +(env.PORT || 8787),
  origins: (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  supabaseUrl: (env.SUPABASE_URL || '').replace(/\/+$/, ''),
  supabaseAnon: env.SUPABASE_ANON_KEY || '',
  allowAnonymous: env.ALLOW_ANONYMOUS === '1',
  visionUrl: env.VISION_URL || 'http://localhost:11434/v1',
  visionModel: env.VISION_MODEL || 'qwen2.5vl:7b',
  visionKey: env.VISION_API_KEY || '',
  visionTimeout: +(env.VISION_TIMEOUT_MS || 60000),
  secondPass: env.SECOND_PASS !== '0',
  keepAliveMin: +(env.VISION_KEEPALIVE_MIN ?? 4),   // 0 = ne pas garder le modèle en mémoire
  gazetteer: env.GAZETTEER_PATH || join(here, 'data', 'gazetteer.json'),
  maxBytes: +(env.MAX_IMAGE_BYTES || 6 * 1024 * 1024),
  perMinute: +(env.RATE_PER_MINUTE || 30),
};
if (!cfg.supabaseUrl && !cfg.allowAnonymous) {
  console.error('✘ SUPABASE_URL absent : définissez-le (comptes des facteurs) ou ALLOW_ANONYMOUS=1 pour un essai en réseau local.');
  process.exit(1);
}

/* ----- répertoire ----- */
let gaz = createGazetteer();
if (existsSync(cfg.gazetteer)) {
  gaz = loadGazetteer(JSON.parse(readFileSync(cfg.gazetteer, 'utf8')));
  console.log('Répertoire chargé :', gaz.size());
} else {
  console.warn(`⚠ ${cfg.gazetteer} absent : seule la base des tournées servira à corriger (voir « npm run gazetteer »).`);
}

// Liste nationale des codes postaux (bpost + BeST), partagée avec l'application.
const pcFile = join(here, '..', 'src', 'data', 'postcodes.json');
if (existsSync(pcFile)) {
  const pc = JSON.parse(readFileSync(pcFile, 'utf8'));
  for (const [cp, names] of Object.entries(pc)) for (const n of names) gaz.addLocality(cp, n);
  console.log(`Codes postaux belges : ${Object.keys(pc).length}`);
}

const vision = createVision({ url: cfg.visionUrl, model: cfg.visionModel, apiKey: cfg.visionKey, timeoutMs: cfg.visionTimeout });

/* ----- authentification : le jeton Supabase du facteur est vérifié auprès de Supabase (cache 5 min) ----- */
const authCache = new Map();
const hash = s => createHash('sha256').update(s).digest('hex');
async function authenticate(req) {
  if (!cfg.supabaseUrl) return cfg.allowAnonymous ? { id: 'anonyme' } : null;
  const token = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return null;
  const k = hash(token), hit = authCache.get(k);
  if (hit && hit.exp > Date.now()) return hit.user;
  const res = await fetch(`${cfg.supabaseUrl}/auth/v1/user`, { headers: { apikey: cfg.supabaseAnon, Authorization: `Bearer ${token}` } }).catch(() => null);
  if (!res?.ok) return null;
  const u = await res.json();
  const user = { id: u.id, token };
  authCache.set(k, { user, exp: Date.now() + 5 * 60_000 });
  if (authCache.size > 1000) for (const [key, v] of authCache) if (v.exp < Date.now()) authCache.delete(key);
  return user;
}

/* ----- tableau des tournées (rues + plages apprises) relu dans Supabase avec le jeton du facteur ----- */
let tableAt = 0, tableLoading = null;
async function refreshTable(token) {
  if (!cfg.supabaseUrl || !token || Date.now() - tableAt < 10 * 60_000 || tableLoading) return;
  tableLoading = (async () => {
    const h = { apikey: cfg.supabaseAnon, Authorization: `Bearer ${token}` };
    const ranges = [];
    for (let from = 0; ; from += 1000) {
      const r = await fetch(`${cfg.supabaseUrl}/rest/v1/ranges?select=cp,city,street,from_n,to_n,source&order=id`, { headers: { ...h, Range: `${from}-${from + 999}` } });
      if (!r.ok) throw new Error('ranges HTTP ' + r.status);
      const page = await r.json(); ranges.push(...page);
      if (page.length < 1000) break;
    }
    const l = await fetch(`${cfg.supabaseUrl}/rest/v1/localities?select=cp,city`, { headers: h });
    gaz.setTable(ranges, l.ok ? await l.json() : []);
    tableAt = Date.now();
  })().catch(e => console.warn('Lecture du tableau impossible :', e.message)).finally(() => { tableLoading = null; });
  if (!tableAt) await tableLoading; // premier chargement : on attend, ensuite rafraîchissement en arrière-plan
}

/* ----- limite de débit par utilisateur ----- */
const hits = new Map();
function allowed(userId) {
  const now = Date.now(), w = (hits.get(userId) ?? []).filter(t => now - t < 60_000);
  if (w.length >= cfg.perMinute) { hits.set(userId, w); return false; }
  w.push(now); hits.set(userId, w); return true;
}

/* ----- HTTP ----- */
const MAGIC = [['image/jpeg', [0xff, 0xd8, 0xff]], ['image/png', [0x89, 0x50, 0x4e, 0x47]], ['image/webp', [0x52, 0x49, 0x46, 0x46]]];
const sniff = b => MAGIC.find(([, m]) => m.every((x, i) => b[i] === x))?.[0] ?? null;

function cors(req, res) {
  const o = req.headers.origin;
  if (o && (cfg.origins.includes(o) || cfg.origins.includes('*'))) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}
const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };

function readBody(req) {
  return new Promise((ok, ko) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > cfg.maxBytes) { ko(Object.assign(new Error('Image trop lourde'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', ko);
  });
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  const path = new URL(req.url, 'http://x').pathname;
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && path === '/health') {
      const model = await vision.ping().catch(() => false);
      return send(res, model ? 200 : 503, { ok: model, model: cfg.visionModel, gazetteer: gaz.size() });
    }
    const table = path === '/table';
    if (req.method !== 'POST' || (path !== '/read' && !table)) return send(res, 404, { error: 'Introuvable' });

    const user = await authenticate(req);
    if (!user) return send(res, 401, { error: 'Connexion requise' });
    if (!allowed(table ? user.id + ':tableau' : user.id)) return send(res, 429, { error: 'Trop de lectures, patientez une minute' });

    const image = await readBody(req), mime = sniff(image);
    if (!mime) return send(res, 415, { error: 'Image JPEG, PNG ou WebP attendue' });
    await refreshTable(user.token);

    if (table) {
      // Un morceau de tableau de tri (une colonne, ~28 lignes) → lignes vérifiées. `zone` : codes postaux déjà rencontrés.
      const zone = (new URL(req.url, 'http://x').searchParams.get('zone') || '').split(',').filter(s => /^\d{4}$/.test(s)).slice(0, 60);
      const t0 = Date.now();
      const { text, tokens } = await vision.transcribe(image, mime, TABLE_PROMPT, 1000);   // ~28 lignes ≈ 550 jetons
      const rows = resolveRows(parseModelRows(text), gaz, zone);
      console.log(`tableau ${Date.now() - t0} ms · jetons ${tokens.in}→${tokens.out} · ${rows.length} lignes, ${rows.filter(r => r.check).length} à vérifier`);
      return send(res, 200, { rows });
    }

    const out = await readLetter({ image, mime, vision, gaz, secondPass: cfg.secondPass });
    const { timing: t } = out;
    console.log(`lecture ${out.ms} ms (modèle ${t.read}, correction ${t.correct}, 2e passage ${t.choose}) · jetons ${t.tokens?.in ?? '?'}→${t.tokens?.out ?? '?'} · manuscrit=${out.handwritten} · corrections=${out.corrections.length}`); // jamais l'adresse ni l'image
    return send(res, 200, out);
  } catch (e) {
    console.error('Erreur :', e.message);
    return send(res, e.status || 502, { error: e.status ? e.message : 'Lecture impossible côté serveur' });
  }
});
server.requestTimeout = cfg.visionTimeout * 2 + 10_000;
server.listen(cfg.port, () => console.log(`Serveur de lecture sur :${cfg.port} · modèle ${cfg.visionModel} via ${cfg.visionUrl}`));

/* ----- modèle gardé en mémoire : la première lettre n'attend pas son chargement (plusieurs secondes) ----- */
const warm = first => vision.warm()
  .then(ms => { if (first || ms > 2000) console.log(`Modèle ${first ? 'chargé' : 'rechargé'} en ${ms} ms`); })
  .catch(e => { if (first) console.warn('⚠ Modèle de vision injoignable pour le moment :', e.message); });
if (cfg.keepAliveMin > 0) {
  warm(true);
  setInterval(() => warm(false), cfg.keepAliveMin * 60_000).unref();
}
