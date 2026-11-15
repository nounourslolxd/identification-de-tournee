// Mode partagé : Supabase (Postgres + Auth + RLS + temps réel). Le client est injecté (testable sans réseau).
import { state, setRanges, setLocalities, setPending, setSession } from './store.js';
import { uid } from './util.js';

const PAGE = 1000; // limite PostgREST par requête

export const isNetworkError = err =>
  !!err && (globalThis.navigator?.onLine === false || /failed to fetch|networkerror|network request|load failed|fetch/i.test(String(err.message || err)));
const isDuplicate = err => err?.code === '23505';

export function createRemote(client) {
  let channel = null;

  /* ----- lecture ----- */
  async function fetchAll() {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await client.from('ranges').select('*').order('created_at', { ascending: true }).range(from, from + PAGE - 1);
      if (error) throw error;
      rows.push(...data);
      if (data.length < PAGE) break;
    }
    const loc = await client.from('localities').select('*').order('cp', { ascending: true });
    if (loc.error) throw loc.error;
    setRanges(rows);
    setLocalities(loc.data);
  }

  /* ----- écriture ----- */
  const sendAdd = async range => {
    const { error } = await client.from('ranges').insert({ ...range, source: 'learned' });
    return error && !isDuplicate(error) ? error : null; // un doublon = déjà présent = succès
  };

  /** Ajoute une plage apprise. 'ok' si envoyée ; 'queued' si mise en attente (hors ligne / non connecté). */
  async function addLearned(range) {
    const queue = () => { setPending([...state.pending, { cid: 'p-' + uid(), op: 'add', range }]); return 'queued'; };
    if (!state.user || !state.online) return queue();
    const err = await sendAdd(range);
    if (!err) return 'ok';
    if (isNetworkError(err)) return queue();
    throw Object.assign(new Error(err.message || 'Refusé par le serveur'), { code: err.code }); // refus serveur (RLS, contrainte)
  }

  /** Envoie les ajouts en attente. Retourne { sent, dropped, left }. */
  async function flushPending() {
    const res = { sent: 0, dropped: 0, left: state.pending.length };
    if (!state.user || !state.online) return res;
    let rest = [...state.pending];
    for (const p of [...rest]) {
      const err = p.op === 'add' ? await sendAdd(p.range) : null;
      if (err && isNetworkError(err)) break;       // on réessaiera plus tard
      rest = rest.filter(x => x.cid !== p.cid);
      if (err) res.dropped++; else res.sent++;      // refus définitif : on abandonne cette opération
    }
    setPending(rest);
    res.left = rest.length;
    return res;
  }

  async function deleteRange(range) {
    if (range.pending || String(range.id).startsWith('p-')) { setPending(state.pending.filter(p => p.cid !== range.id)); return; }
    const { error, count } = await client.from('ranges').delete({ count: 'exact' }).eq('id', range.id);
    if (error) throw Object.assign(new Error(error.message), { code: error.code });
    if (count === 0) throw new Error('Suppression refusée (droits insuffisants).');
    setRanges(state.ranges.filter(r => r.id !== range.id));
  }

  async function saveTable(rows, localities) {
    const { error } = await client.rpc('replace_table', {
      p_ranges: rows.map(({ cp, city, street, from_n, to_n, parity, tournee }) => ({ cp, city: city || '', street, from_n, to_n, parity: parity || '', tournee })),
      p_localities: localities,
    });
    if (error) throw new Error(error.code === '42501' ? 'Réservé aux administrateurs.' : error.message);
    await fetchAll();
  }

  /* ----- temps réel ----- */
  function subscribe() {
    if (channel) return;
    channel = client.channel('ranges-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ranges' }, p => {
        if (p.eventType === 'DELETE') setRanges(state.ranges.filter(r => r.id !== p.old.id));
        else setRanges([...state.ranges.filter(r => r.id !== p.new.id), p.new]);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'localities' }, () => fetchAll().catch(() => {}))
      .subscribe();
  }
  const unsubscribe = () => { if (channel) { client.removeChannel(channel); channel = null; } };

  /* ----- comptes ----- */
  async function loadRole(user) {
    const { data, error } = await client.from('profiles').select('role').eq('id', user.id).maybeSingle();
    if (error || !data) return state.role === 'admin' ? 'admin' : 'contributor'; // hors ligne : on garde le rôle connu
    return data.role;
  }

  async function applySession(session) {
    if (!session?.user) { unsubscribe(); setSession(null, 'anon'); return false; }
    const u = { id: session.user.id, email: session.user.email };
    setSession(u, await loadRole(u));
    return true;
  }

  async function connect(session) {
    if (!(await applySession(session))) return;
    try { await fetchAll(); } catch (e) { console.warn('Lecture serveur impossible (cache utilisé)', e); }
    subscribe();
    await flushPending().catch(() => {});
  }

  const sendLink = async email => {
    const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: true } });
    if (error) throw new Error(error.message);
  };
  const verifyCode = async (email, token) => {
    const { error } = await client.auth.verifyOtp({ email, token: String(token).trim(), type: 'email' });
    if (error) throw new Error(error.message);
  };
  const signOut = () => client.auth.signOut();

  return { fetchAll, addLearned, flushPending, deleteRange, saveTable, subscribe, unsubscribe, connect, applySession, sendLink, verifyCode, signOut, client };
}
