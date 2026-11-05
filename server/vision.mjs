// Client du modèle de vision auto-hébergé, via l'API « OpenAI compatible » (/v1/chat/completions)
// proposée par Ollama, vLLM, llama.cpp server, LM Studio… Aucune image n'est conservée.

const SYSTEM = `Tu lis des adresses postales belges sur des lettres et enveloppes photographiées, imprimées ou écrites à la main.
Tu recopies fidèlement ce qui est écrit. Tu n'inventes jamais un élément illisible : tu mets null.`;

/** Consigne de lecture. `hints` : liste « CP Localité » des communes desservies, pour aider à déchiffrer. */
export function readPrompt(hints = []) {
  return `Lis l'adresse du DESTINATAIRE sur cette image (ignore l'expéditeur, les tampons, les codes-barres et le logo).
${hints.length ? `Les lettres sont normalement destinées à l'une de ces localités : ${hints.join(', ')}.\n` : ''}Réponds uniquement avec un objet JSON :
{"texte": "les lignes de l'adresse telles qu'écrites, séparées par \\n",
 "numero": nombre ou null, "boite": "texte" ou null, "rue": "nom complet de la rue sans le numéro" ou null,
 "cp": "code postal à 4 chiffres" ou null, "ville": "localité" ou null,
 "manuscrit": true si l'adresse est écrite à la main, sinon false,
 "lisibilite": nombre entre 0 et 1}`;
}

/** Consigne de second passage : choisir parmi des rues réelles proches de la lecture. */
export function choosePrompt(read, candidates) {
  const list = candidates.map((c, i) => `${i + 1}. ${c.street} (${c.cp}${c.city ? ' ' + c.city : ''})`).join('\n');
  return `Sur cette image, tu as lu la rue « ${read} ». Voici des rues qui existent réellement dans le secteur :
${list}
Regarde à nouveau l'écriture. Laquelle est écrite sur la lettre ? Réponds uniquement en JSON : {"choix": numéro de la liste, ou 0 si aucune ne correspond}`;
}

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

/** Réponse du modèle → { num, box, street, cp, city, raw, handwritten, legibility } (forme de parseAddr). */
export function toAddress(j) {
  const str = v => (v == null ? '' : String(v).trim());
  const n = parseInt(str(j?.numero).match(/\d+/)?.[0] ?? '', 10);
  const cp = fixPostcode(str(j?.cp));
  const leg = Number(j?.lisibilite);
  return {
    num: Number.isFinite(n) ? n : null,
    box: str(j?.boite) || null,
    street: str(j?.rue),
    cp,
    city: str(j?.ville),
    raw: str(j?.texte),
    handwritten: j?.manuscrit === true,
    legibility: Number.isFinite(leg) ? Math.max(0, Math.min(1, leg)) : null,
  };
}

export function createVision({ url, model, apiKey = '', timeoutMs = 60000, fetchImpl = fetch }) {
  const endpoint = url.replace(/\/+$/, '') + '/chat/completions';

  async function ask(image, mime, prompt, maxTokens) {
    const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: [
              { type: 'image_url', image_url: { url: `data:${mime};base64,${image.toString('base64')}` } },
              { type: 'text', text: prompt },
            ] },
          ],
        }),
      });
      if (!res.ok) throw new Error(`Modèle de vision : HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      const j = parseModelJson(data?.choices?.[0]?.message?.content);
      if (!j) throw new Error('Modèle de vision : réponse non JSON');
      return j;
    } finally { clearTimeout(t); }
  }

  return {
    model,
    /** Lecture de l'adresse. */
    read: async (image, mime, hints) => toAddress(await ask(image, mime, readPrompt(hints), 400)),
    /** Second passage : index (0-based) de la rue choisie parmi `candidates`, ou -1. */
    choose: async (image, mime, read, candidates) => {
      const j = await ask(image, mime, choosePrompt(read, candidates), 40);
      const i = parseInt(j?.choix, 10);
      return Number.isFinite(i) && i >= 1 && i <= candidates.length ? i - 1 : -1;
    },
    /** Vérifie que le serveur du modèle répond. */
    ping: async () => {
      const res = await fetchImpl(url.replace(/\/+$/, '') + '/models', { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
      return res.ok;
    },
  };
}
