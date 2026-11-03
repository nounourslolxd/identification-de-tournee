// État de l'application + cache local (localStorage ; mémoire hors navigateur, ce qui permet les tests).
import { parseTable, parseLocalities } from './match.js';

const mem = new Map();
const ls = {
  get(k, d) {
    try {
      const raw = globalThis.localStorage ? localStorage.getItem(k) : mem.get(k);
      return raw ? JSON.parse(raw) : d;
    } catch { return d; }
  },
  set(k, v) {
    try {
      const raw = JSON.stringify(v);
      if (globalThis.localStorage) localStorage.setItem(k, raw); else mem.set(k, raw);
    } catch (e) { console.warn('Stockage local plein ou indisponible', e); }
  },
};

const listeners = {};
export const on = (ev, fn) => ((listeners[ev] ??= []).push(fn), fn);
export const emit = ev => (listeners[ev] ?? []).forEach(f => f());

export const DEMO_TABLE = `5500 rue de l'avie de 1 a 16 -- tournée 13
5100 rue de l'oublie de 1 a 4 -- tournée 5
5500 rue de l'oublie de 1 a 5 -- tournée 1`;

export const state = {
  ranges: ls.get('ranges', null) ?? parseTable(DEMO_TABLE).map((r, i) => ({ ...r, id: 'demo-' + i })),
  localities: ls.get('localities', null) ?? parseLocalities('5500 Dinant\n5100 Dinant'),
  pending: ls.get('pending', []),   // opérations en attente d'envoi : { cid, op:'add', range }
  hist: ls.get('hist', []),
  user: null,                        // { id, email } une fois connecté
  role: 'local',                     // 'local' (sans serveur) | 'anon' | 'contributor' | 'admin'
  online: globalThis.navigator?.onLine ?? true,
};

export const isAdmin = () => state.role === 'admin' || state.role === 'local';
export const canDelete = r => isAdmin() || (!!state.user && r.created_by === state.user.id) || r.pending || r.local;

/** Plages utilisables pour la correspondance : serveur/cache + ajouts en attente de synchronisation. */
export const effectiveRanges = () => [
  ...state.ranges,
  ...state.pending.filter(p => p.op === 'add').map(p => ({ ...p.range, source: 'learned', pending: true, id: p.cid })),
];

export function setRanges(list) { state.ranges = list; ls.set('ranges', list); emit('ranges'); }
export function setLocalities(list) { state.localities = list; ls.set('localities', list); emit('ranges'); }
export function setPending(list) { state.pending = list; ls.set('pending', list); emit('ranges'); }
export function setHist(list) { state.hist = list.slice(0, 80); ls.set('hist', state.hist); emit('hist'); }
export function setSession(user, role) { state.user = user; state.role = role; emit('session'); }
