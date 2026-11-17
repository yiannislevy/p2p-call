// Presence: shows on the rooms screen who is in each room's call right now.
//
// No server and no direct connection needed. People in a call post a small note
// ("here", every 25 s, and "bye" when they leave) through the same public relays the
// calls use, and anyone opening the rooms screen asks "anyone here?".
// The relays cannot read any of it: each room gets its own channel id and its own
// encryption key, both derived on the device from the room name and password
// (PBKDF2-SHA256), and every note is encrypted with AES-256-GCM. Each session signs
// its notes with a throwaway key, so nothing links one session to another.

import { schnorr } from './vendor/noble-secp256k1-3.2.0.js';

export const HEARTBEAT_MS = 25000;   // how often someone in a call says "still here"
export const EXPIRE_MS = 70000;      // forget someone who has gone quiet this long
const MAX_SKEW_S = 120;              // ignore notes older (or newer) than this
const REPLY_GAP_MS = 2000;           // answer "anyone here?" at most this often

const enc = new TextEncoder();
const dec = new TextDecoder();
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const b64 = bytes => btoa(String.fromCharCode(...bytes));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const now = () => Math.floor(Date.now() / 1000);

// Ephemeral event kinds (20000-29999) are forwarded by relays but never stored.
const kindFor = topic => {
  let h = 2166136261;
  for (let i = 0; i < topic.length; i++) h = Math.imul(h ^ topic.charCodeAt(i), 16777619);
  return 20000 + ((h >>> 0) % 10000);
};

export const roomKeyOf = r => r.name.toLowerCase() + '\n' + r.key;

export function createPresence({ relays, appId }) {
  const session = hex(crypto.getRandomValues(new Uint8Array(12)));
  const { secretKey, publicKey } = schnorr.keygen();
  const pubkey = hex(publicKey);
  const subId = 'p' + hex(crypto.getRandomValues(new Uint8Array(8)));

  const sockets = new Map();      // url -> { ws, open, queue, retry, timer }
  const channels = new Map();     // roomKey -> channel
  const byTopic = new Map();      // topic -> channel
  const seen = new Set();         // event ids already handled
  const derived = new Map();      // roomKey -> derivation (slow on purpose, so done once)
  let watchHandler = null;        // (roomKey, members[]) => void
  let sweeper = 0;

  /* ---------- channels ---------- */

  async function derive(room) {
    const base = await crypto.subtle.importKey('raw', enc.encode(room.key), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(appId + '|presence|' + room.name.toLowerCase()), iterations: 300000 },
      base, 512));
    const topic = hex(bits.slice(0, 32));
    const key = await crypto.subtle.importKey('raw', bits.slice(32, 64), 'AES-GCM', false, ['encrypt', 'decrypt']);
    return { topic, key, kind: kindFor(topic) };
  }

  function channel(room) {
    const rk = roomKeyOf(room);
    let ch = channels.get(rk);
    if (!ch) {
      ch = { rk, ready: null, topic: '', key: null, kind: 0, members: new Map(), watched: false, announcing: null, lastReply: 0, bye: '', beat: 0 };
      if (!derived.has(rk)) derived.set(rk, derive(room));
      ch.ready = derived.get(rk).then(d => { Object.assign(ch, d); byTopic.set(d.topic, ch); return ch; });
      channels.set(rk, ch);
    }
    return ch;
  }

  function release(ch) {
    if (ch.watched || ch.announcing) return;
    channels.delete(ch.rk);
    if (ch.topic) byTopic.delete(ch.topic);
    resubscribe();
    if (!channels.size) closeAll();
  }

  /* ---------- relays ---------- */

  function connect(url) {
    let s = sockets.get(url);
    if (!s) { s = { ws: null, open: false, queue: [], retry: 1000, timer: 0 }; sockets.set(url, s); }
    if (s.ws) return s;
    let ws;
    try { ws = new WebSocket(url); } catch { return s; }
    s.ws = ws;
    ws.onopen = () => {
      s.open = true; s.retry = 1000;
      sendTo(s, subscription());
      for (const m of s.queue.splice(0)) ws.send(m);
    };
    ws.onmessage = e => onRelay(e.data);
    ws.onerror = () => {};
    ws.onclose = () => {
      s.open = false; s.ws = null;
      if (channels.size) { clearTimeout(s.timer); s.timer = setTimeout(() => connect(url), s.retry); s.retry = Math.min(s.retry * 2, 30000); }
    };
    return s;
  }

  function ensureSockets() { for (const url of relays) connect(url); }

  function closeAll() {
    for (const s of sockets.values()) { clearTimeout(s.timer); try { s.ws && s.ws.close(); } catch {} }
    sockets.clear();
    clearInterval(sweeper); sweeper = 0;
  }

  function sendTo(s, msg) {
    if (!msg) return;
    if (s.open && s.ws && s.ws.readyState === 1) s.ws.send(msg);
    else if (s.queue.length < 50) s.queue.push(msg);
  }
  function broadcast(msg) { ensureSockets(); for (const s of sockets.values()) sendTo(s, msg); }

  function subscription() {
    const live = [...channels.values()].filter(c => c.topic);
    if (!live.length) return JSON.stringify(['CLOSE', subId]);
    return JSON.stringify(['REQ', subId, {
      kinds: [...new Set(live.map(c => c.kind))],
      '#x': live.map(c => c.topic),
      since: now() - 30
    }]);
  }
  function resubscribe() { const m = subscription(); for (const s of sockets.values()) if (s.open) sendTo(s, m); }

  /* ---------- notes ---------- */

  async function seal(ch, note) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const body = { v: 1, id: session, ts: now(), ...note };
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, ch.key, enc.encode(JSON.stringify(body))));
    const ev = { kind: ch.kind, tags: [['x', ch.topic]], created_at: now(), content: b64(iv) + '.' + b64(ct), pubkey };
    const id = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]))));
    const sig = await schnorr.signAsync(id, secretKey);
    return JSON.stringify(['EVENT', { ...ev, id: hex(id), sig: hex(sig) }]);
  }

  async function open(ch, content) {
    const [ivs, cts] = String(content).split('.');
    if (!ivs || !cts) return null;
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivs) }, ch.key, unb64(cts));
      return JSON.parse(dec.decode(pt));
    } catch { return null; }   // not ours, wrong password, or tampered
  }

  async function onRelay(raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(m) || m[0] !== 'EVENT' || m[1] !== subId || !m[2]) return;
    const ev = m[2];
    if (typeof ev.id !== 'string' || seen.has(ev.id)) return;
    seen.add(ev.id);
    if (seen.size > 2000) seen.clear();
    const tag = Array.isArray(ev.tags) && ev.tags.find(t => Array.isArray(t) && t[0] === 'x');
    const ch = tag && byTopic.get(tag[1]);
    if (!ch) return;
    const note = await open(ch, ev.content);
    if (!note || note.v !== 1 || typeof note.id !== 'string' || note.id.length > 32 || note.id === session) return;
    if (typeof note.ts !== 'number' || Math.abs(now() - note.ts) > MAX_SKEW_S) return;

    if (note.t === 'ping') {
      if (ch.announcing && Date.now() - ch.lastReply > REPLY_GAP_MS) { ch.lastReply = Date.now(); sayHere(ch); }
    } else if (note.t === 'here') {
      const name = typeof note.n === 'string' ? note.n.trim().replace(/\s+/g, ' ').slice(0, 30) : '';
      const cs = typeof note.cs === 'string' && /^[0-9a-f]{8,32}$/.test(note.cs) ? note.cs : '';
      const had = ch.members.get(note.id);
      ch.members.set(note.id, { name: name || 'Someone', cs, last: Date.now() });
      if (!had || had.name !== name || had.cs !== cs) changed(ch);
      else if (cs && watchHandler) changed(ch);   // keep "still alive" fresh for the call screen
    } else if (note.t === 'bye') {
      if (ch.members.delete(note.id)) changed(ch);
    }
  }

  function changed(ch) {
    if (ch.watched && watchHandler) watchHandler(ch.rk, members(ch), new Set([...ch.members.values()].map(m => m.cs).filter(Boolean)));
  }
  const members = ch => [...ch.members.values()].map(m => m.name).sort((a, b) => a.localeCompare(b));

  function startSweeper() {
    if (sweeper) return;
    sweeper = setInterval(() => {
      const cutoff = Date.now() - EXPIRE_MS;
      for (const ch of channels.values()) {
        let gone = false;
        for (const [id, m] of ch.members) if (m.last < cutoff) { ch.members.delete(id); gone = true; }
        if (gone) changed(ch);
      }
    }, 5000);
  }

  async function sayHere(ch) {
    const who = ch.announcing;
    if (!who) return;
    const here = await seal(ch, { t: 'here', n: who(), cs: ch.callSession ? ch.callSession() : undefined });
    const bye = await seal(ch, { t: 'bye' });   // kept ready so leaving can be announced instantly
    if (ch.announcing !== who) return;          // left while this note was being prepared
    ch.bye = bye;
    broadcast(here);
  }

  /* ---------- public API ---------- */

  // Watch these rooms; onChange(roomKey, names[]) fires whenever who is in changes.
  async function watch(rooms, onChange) {
    watchHandler = onChange;
    const wanted = new Set(rooms.map(roomKeyOf));
    for (const ch of [...channels.values()]) if (ch.watched && !wanted.has(ch.rk)) { ch.watched = false; ch.members.clear(); release(ch); }
    const fresh = [];
    for (const r of rooms) {
      const ch = channel(r);
      if (!ch.watched) { ch.watched = true; fresh.push(ch); }
      else changed(ch);   // already watching: report what we know right away
    }
    if (!fresh.length) return;
    ensureSockets();
    startSweeper();
    await Promise.all(fresh.map(c => c.ready));
    resubscribe();
    for (const ch of fresh) if (ch.watched) broadcast(await seal(ch, { t: 'ping' }));
  }

  function unwatch() {
    watchHandler = null;
    for (const ch of [...channels.values()]) if (ch.watched) { ch.watched = false; ch.members.clear(); release(ch); }
  }

  // While in a call: tell watchers of this room that we are here.
  // getCallSession tells others in the call which person this is, so they can tell a
  // dropped link (person still here) from a person who is gone.
  async function announce(room, getName, getCallSession) {
    const ch = channel(room);
    ch.announcing = getName;
    ch.callSession = getCallSession || null;
    ensureSockets();
    startSweeper();
    await ch.ready;
    if (ch.announcing !== getName) return;
    resubscribe();
    await sayHere(ch);
    clearInterval(ch.beat);
    ch.beat = setInterval(() => sayHere(ch), HEARTBEAT_MS);
  }

  function leave(room) {
    const ch = channels.get(roomKeyOf(room));
    if (!ch || !ch.announcing) return;
    clearInterval(ch.beat);
    ch.announcing = null;
    if (ch.bye) broadcast(ch.bye);   // sent synchronously, so it also works when the page is closing
    ch.bye = '';
    setTimeout(() => release(ch), 500);
  }

  // Page is closing: say goodbye everywhere right now.
  function leaveAll() {
    for (const ch of channels.values()) if (ch.announcing && ch.bye) broadcast(ch.bye);
  }

  return { watch, unwatch, announce, leave, leaveAll };
}
