// Client du modèle de vision auto-hébergé, via l'API « OpenAI compatible » (/v1/chat/completions)
// proposée par Ollama, vLLM, llama.cpp server, LM Studio… Aucune image n'est conservée.

const SYSTEM = `Tu lis des adresses postales belges sur des lettres et enveloppes photographiées, imprimées ou écrites à la main.
Tu recopies fidèlement ce qui est écrit. Tu n'inventes jamais un élément illisible : tu mets null.`;

/**
 * Consigne de lecture. `hints` : liste « CP Localité » des communes desservies, pour aider à déchiffrer.
 * Réponse volontairement courte (clés d'une lettre, pas de transcription) : le temps de lecture dépend surtout
 * du nombre de jetons produits. Mesuré sur qwen2.5vl:7b : ~370 ms par lettre contre ~700 ms avec l'ancienne
 * consigne, et le numéro de maison n'est plus perdu (« numéro de maison (nombre) » au lieu de « nombre ou null »).
 */
export function readPrompt(hints = []) {
  return `Lis l'adresse du DESTINATAIRE sur cette image (ignore l'expéditeur, les tampons, les codes-barres et le logo).
${hints.length ? `Les lettres sont normalement destinées à l'une de ces localités : ${hints.join(', ')}.\n` : ''}Réponds uniquement en JSON : {"n": numéro de maison (nombre) ou null, "b": boîte ou null, "r": nom complet de la rue sans le numéro ou null, "cp": code postal à 4 chiffres ou null, "v": localité ou null, "m": true si écrit à la main sinon false}`;
}

/** Consigne de second passage : choisir parmi des rues réelles proches de la lecture. */
export function choosePrompt(read, candidates) {
  const list = candidates.map((c, i) => `${i + 1}. ${c.street} (${c.cp}${c.city ? ' ' + c.city : ''})`).join('\n');
  return `Sur cette image, tu as lu la rue « ${read} ». Voici des rues qui existent réellement dans le secteur :
${list}
Regarde à nouveau l'écriture. Laquelle est écrite sur la lettre ? Réponds uniquement en JSON : {"choix": numéro de la liste, ou 0 si aucune ne correspond}`;
}

const nullable = t => ({ type: [t, 'null'] });
const schema = (name, properties) => ({
  type: 'json_schema',
  json_schema: { name, strict: true, schema: { type: 'object', additionalProperties: false, required: Object.keys(properties), properties } },
});
/** Sorties contraintes par schéma (JSON toujours valide) ; repli automatique sur « json_object » si le serveur refuse. */
export const READ_FORMAT = schema('adresse', {
  n: nullable('integer'), b: nullable('string'), r: nullable('string'), cp: nullable('string'), v: nullable('string'), m: { type: 'boolean' },
});
export const CHOOSE_FORMAT = schema('choix', { choix: { type: 'integer' } });

/** Extrait le premier objet JSON d'une réponse de modèle (tolère les blocs ```json et le texte autour). */
export function parseModelJson(text) {
  const s = String(text ?? '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try { return JSON.parse(body.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

/** Code postal à 4 chiffres, en réparant les confusions de lecture courantes (O→0, I/l→1, S→5, B→8, Z→2). */
export function fixPostcode(s) {
  const map = { O: '0', o: '0', Q: '0', D: '0', I: '1', l: '1', '|': '1', S: '5', s: '5', B: '8', Z: '2', z: '2' };
  for (const tok of String(s ?? '').replace(/^\s*B\s*-\s*/i, '').split(/[^0-9A-Za-z|]+/)) {
    if (tok.length !== 4 || !/\d/.test(tok)) continue;
    const t = tok.replace(/[OoQDIl|SsBZz]/g, c => map[c]);
    if (/^\d{4}$/.test(t)) return t;
  }
  return '';
}

/** Réponse du modèle → { num, box, street, cp, city, handwritten }. Accepte les clés courtes (n, b, r, v, m) ou longues. */
export function toAddress(j) {
  const str = v => (v == null ? '' : String(v).trim());
  const n = parseInt(str(j?.n ?? j?.numero).match(/\d+/)?.[0] ?? '', 10);
  return {
    num: Number.isFinite(n) ? n : null,
    box: str(j?.b ?? j?.boite) || null,
    street: str(j?.r ?? j?.rue),
    cp: fixPostcode(str(j?.cp)),
    city: str(j?.v ?? j?.ville),
    handwritten: (j?.m ?? j?.manuscrit) === true,
  };
}

export function createVision({ url, model, apiKey = '', timeoutMs = 60000, fetchImpl = fetch }) {
  const base = url.replace(/\/+$/, ''), endpoint = base + '/chat/completions';
  const headers = { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
  let schemaOk = true; // passe à false si le serveur du modèle ne connaît pas response_format json_schema

  async function post(body) {
    const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), timeoutMs);
    try { return await fetchImpl(endpoint, { method: 'POST', signal: ctrl.signal, headers, body: JSON.stringify(body) }); }
    finally { clearTimeout(t); }
  }

  /** Retourne { json, tokens: { in, out } }. */
  async function ask(image, mime, prompt, maxTokens, format) {
    const body = fmt => ({
      model, temperature: 0, max_tokens: maxTokens, response_format: fmt,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:${mime};base64,${image.toString('base64')}` } },
          { type: 'text', text: prompt },
        ] },
      ],
    });
    let res = await post(body(schemaOk ? format : { type: 'json_object' }));
    if (res.status === 400 && schemaOk) { schemaOk = false; res = await post(body({ type: 'json_object' })); }
    if (!res.ok) throw new Error(`Modèle de vision : HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const json = parseModelJson(data?.choices?.[0]?.message?.content);
    if (!json) throw new Error('Modèle de vision : réponse non JSON');
    return { json, tokens: { in: data?.usage?.prompt_tokens ?? 0, out: data?.usage?.completion_tokens ?? 0 } };
  }

  return {
    model,
    /** Lecture de l'adresse. */
    read: async (image, mime, hints) => {
      const { json, tokens } = await ask(image, mime, readPrompt(hints), 120, READ_FORMAT);
      return { ...toAddress(json), tokens };
    },
    /** Second passage : index (0-based) de la rue choisie parmi `candidates`, ou -1. */
    choose: async (image, mime, read, candidates) => {
      const { json } = await ask(image, mime, choosePrompt(read, candidates), 20, CHOOSE_FORMAT);
      const i = parseInt(json?.choix, 10);
      return Number.isFinite(i) && i >= 1 && i <= candidates.length ? i - 1 : -1;
    },
    /** Charge le modèle en mémoire (appel minuscule, sans image). À répéter pour qu'il y reste. Retourne la durée en ms. */
    warm: async () => {
      const t0 = Date.now();
      const res = await post({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      await res.arrayBuffer();
      return Date.now() - t0;
    },
    /** Vérifie que le serveur du modèle répond. */
    ping: async () => (await fetchImpl(base + '/models', { headers })).ok,
  };
}
