import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { state, setPending, setRanges, setSession, setOnline, effectiveRanges } from '../src/js/store.js';
import { createRemote, isNetworkError } from '../src/js/remote.js';

/** Faux client Supabase : enregistre les appels, réponses programmables. */
function fake({ insertResults = [], deleteResult = { error: null, count: 1 }, rpcResult = { error: null }, pages = [[]], role = 'contributor' } = {}) {
  const log = [];
  let i = 0, p = 0;
  const client = {
    from(table) {
      return {
        insert: async row => { log.push(['insert', table, row]); return insertResults[i++] ?? { error: null }; },
        delete: opts => ({ eq: async (c, v) => { log.push(['delete', table, c, v, opts]); return deleteResult; } }),
        select: () => {
          const q = {
            order: () => q,
            range: async (a, b) => { log.push(['range', a, b]); return { data: pages[p++] ?? [], error: null }; },
            eq: () => q,
            maybeSingle: async () => ({ data: { role }, error: null }),
            then: res => res({ data: [], error: null }), // localities
          };
          return q;
        },
      };
    },
    rpc: async (name, args) => { log.push(['rpc', name, args]); return rpcResult; },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel() {},
    auth: {},
  };
  return { client, log };
}
const R = { cp: '5500', city: 'Dinant', street: 'rue neuve', from_n: 3, to_n: 3, tournee: '8' };
const signedIn = () => { setSession({ id: 'u1', email: 'a@b.be' }, 'contributor'); setOnline(true); };

beforeEach(() => { setPending([]); setRanges([]); setSession(null, 'anon'); setOnline(true); });

test('isNetworkError', () => {
  assert.ok(isNetworkError(new Error('TypeError: Failed to fetch')));
  assert.ok(!isNetworkError({ code: '42501', message: 'row-level security' }));
  assert.ok(!isNetworkError(null));
});

test('addLearned : connecté et en ligne → insert avec source=learned', async () => {
  signedIn(); const { client, log } = fake(); const r = createRemote(client);
  assert.equal(await r.addLearned(R), 'ok');
  assert.deepEqual(log[0], ['insert', 'ranges', { ...R, source: 'learned' }]);
  assert.equal(state.pending.length, 0);
});
test('addLearned : hors ligne → mis en file, utilisable tout de suite pour la correspondance', async () => {
  signedIn(); setOnline(false); const { client, log } = fake(); const r = createRemote(client);
  assert.equal(await r.addLearned(R), 'queued');
  assert.equal(log.length, 0);
  assert.equal(state.pending.length, 1);
  assert.equal(effectiveRanges()[0].tournee, '8');
});
test('addLearned : non connecté → mis en file', async () => {
  const { client } = fake(); assert.equal(await createRemote(client).addLearned(R), 'queued');
});
test('addLearned : erreur réseau pendant l’envoi → mis en file', async () => {
  signedIn(); const { client } = fake({ insertResults: [{ error: new Error('TypeError: Failed to fetch') }] });
  assert.equal(await createRemote(client).addLearned(R), 'queued');
  assert.equal(state.pending.length, 1);
});
test('addLearned : doublon (23505) = succès', async () => {
  signedIn(); const { client } = fake({ insertResults: [{ error: { code: '23505', message: 'dup' } }] });
  assert.equal(await createRemote(client).addLearned(R), 'ok');
});
test('addLearned : refus serveur (RLS) → erreur remontée, rien en file', async () => {
  signedIn(); const { client } = fake({ insertResults: [{ error: { code: '42501', message: 'row-level security' } }] });
  await assert.rejects(createRemote(client).addLearned(R), /row-level/);
  assert.equal(state.pending.length, 0);
});

test('flushPending : envoie tout et vide la file', async () => {
  signedIn(); setOnline(false); const { client, log } = fake(); const r = createRemote(client);
  await r.addLearned(R); await r.addLearned({ ...R, from_n: 4, to_n: 4 });
  setOnline(true);
  const res = await r.flushPending();
  assert.deepEqual(res, { sent: 2, dropped: 0, left: 0 });
  assert.equal(log.filter(l => l[0] === 'insert').length, 2);
  assert.equal(state.pending.length, 0);
});
test('flushPending : s’arrête sur erreur réseau et garde le reste', async () => {
  signedIn(); setOnline(false);
  const { client } = fake({ insertResults: [{ error: null }, { error: new Error('Failed to fetch') }] }); const r = createRemote(client);
  await r.addLearned(R); await r.addLearned({ ...R, from_n: 4, to_n: 4 }); await r.addLearned({ ...R, from_n: 5, to_n: 5 });
  setOnline(true);
  const res = await r.flushPending();
  assert.equal(res.sent, 1); assert.equal(res.left, 2);
});
test('flushPending : abandonne une opération refusée définitivement', async () => {
  signedIn(); setOnline(false);
  const { client } = fake({ insertResults: [{ error: { code: '23514', message: 'check' } }] }); const r = createRemote(client);
  await r.addLearned(R); setOnline(true);
  assert.deepEqual(await r.flushPending(), { sent: 0, dropped: 1, left: 0 });
});
test('flushPending : rien à faire si non connecté', async () => {
  const { client, log } = fake(); setPending([{ cid: 'p-1', op: 'add', range: R }]);
  const res = await createRemote(client).flushPending();
  assert.equal(res.left, 1); assert.equal(log.length, 0);
});

test('deleteRange : ajout en attente → retiré localement sans appel serveur', async () => {
  const { client, log } = fake(); setPending([{ cid: 'p-9', op: 'add', range: R }]);
  await createRemote(client).deleteRange({ id: 'p-9', pending: true });
  assert.equal(state.pending.length, 0); assert.equal(log.length, 0);
});
test('deleteRange : serveur → retiré du cache ; 0 ligne supprimée = droits insuffisants', async () => {
  setRanges([{ id: 'x1', ...R, source: 'learned' }]);
  await createRemote(fake().client).deleteRange({ id: 'x1' });
  assert.equal(state.ranges.length, 0);
  setRanges([{ id: 'x2', ...R, source: 'table' }]);
  await assert.rejects(createRemote(fake({ deleteResult: { error: null, count: 0 } }).client).deleteRange({ id: 'x2' }), /droits/);
  assert.equal(state.ranges.length, 1);
});

test('fetchAll : pagine au-delà de 1000 lignes', async () => {
  const page = n => Array.from({ length: n }, (_, k) => ({ id: 'r' + k, ...R }));
  const { client, log } = fake({ pages: [page(1000), page(250)] });
  await createRemote(client).fetchAll();
  assert.equal(state.ranges.length, 1250);
  assert.deepEqual(log.filter(l => l[0] === 'range').map(l => [l[1], l[2]]), [[0, 999], [1000, 1999]]);
});

test('saveTable : appelle replace_table avec le bon format', async () => {
  const { client, log } = fake();
  await createRemote(client).saveTable([{ cp: '5500', street: 'rue a', from_n: 1, to_n: 5, tournee: '1', source: 'table', id: 'zzz' }], [{ cp: '5500', city: 'Dinant' }]);
  const rpc = log.find(l => l[0] === 'rpc');
  assert.equal(rpc[1], 'replace_table');
  assert.deepEqual(rpc[2].p_ranges, [{ cp: '5500', city: '', street: 'rue a', from_n: 1, to_n: 5, tournee: '1' }]);
});
test('saveTable : non-admin → message clair', async () => {
  const { client } = fake({ rpcResult: { error: { code: '42501', message: 'x' } } });
  await assert.rejects(createRemote(client).saveTable([], []), /administrateurs/);
});

test('connect : charge le rôle depuis profiles', async () => {
  const { client } = fake({ role: 'admin' }); const r = createRemote(client);
  await r.connect({ user: { id: 'u9', email: 'x@y.be' } });
  assert.equal(state.role, 'admin'); assert.equal(state.user.email, 'x@y.be');
  await r.connect(null);
  assert.equal(state.role, 'anon'); assert.equal(state.user, null);
});
