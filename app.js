// Call: private peer-to-peer video rooms.
// Video and audio go directly between browsers (WebRTC, always encrypted).
// Public Nostr relays are only used to introduce browsers to each other, and
// that introduction is encrypted with the room password, so relays learn nothing useful.

import { joinRoom, getRelaySockets } from './vendor/trystero-0.27.0.js';
import { createPresence, roomKeyOf } from './presence.js';

// Refuse to run inside someone else's frame (clickjacking).
if (window.top !== window.self) {
  document.documentElement.replaceChildren();
  throw new Error('Call cannot run inside a frame.');
}

/* ------------------------------------------------------------------ config */

const VERSION = '1.17.0';
const APP_ID = 'plain-call/v1/k3q9w';      // changing this disconnects everyone from everyone
const RELAYS = [                            // must match connect-src in index.html
  'wss://relay.primal.net',
  'wss://relay.nostr.net',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.snort.social',
  'wss://relay.ditto.pub',
  'wss://nostr.azzamo.net'
];
const MAX_PEOPLE = 6;
const presence = createPresence({ relays: RELAYS, appId: APP_ID });
const STORE_KEY = 'plaincall.v1';
const SVG_NS = 'http://www.w3.org/2000/svg';

/* ----------------------------------------------------------------- helpers */

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const icon = (name, cls = '') => {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('class', ('ic ' + cls).trim());
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(SVG_NS, 'use');
  u.setAttribute('href', '#i-' + name);
  s.append(u);
  return s;
};
const clean = s => String(s || '').trim().replace(/\s+/g, ' ');
const sameRoom = (a, b) => a.name.toLowerCase() === b.name.toLowerCase() && a.key === b.key;
const validRoom = r => r && typeof r.name === 'string' && typeof r.key === 'string' &&
  r.name.length >= 1 && r.name.length <= 40 && r.key.length >= 8 && r.key.length <= 128;
const gum = c => navigator.mediaDevices.getUserMedia(c);

function toast(msg, ms = 2800) {
  const t = el('div', 'toast', msg);
  $('toasts').append(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const t = el('textarea'); t.value = text; t.setAttribute('readonly', '');
  document.body.append(t); t.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch {}
  t.remove();
  return ok;
}

// 16 random characters from an unambiguous alphabet, about 79 bits.
function newPassword() {
  const abc = '23456789abcdefghjkmnpqrstuvwxyz';
  const buf = new Uint32Array(16);
  crypto.getRandomValues(buf);
  let s = '';
  for (let i = 0; i < 16; i++) s += (i && i % 4 === 0 ? '-' : '') + abc[buf[i] % abc.length];
  return s;
}

// The public meeting point is derived from name + password with a slow hash,
// so the relays never see the room name and cannot cheaply guess passwords.
async function roomId(r) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(r.key), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(APP_ID + '|room|' + r.name.toLowerCase()), iterations: 300000 },
    base, 256);
  return Array.from(new Uint8Array(bits), b => b.toString(16).padStart(2, '0')).join('');
}

/* ----------------------------------------------------------------- storage */

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return {
      name: typeof d.name === 'string' ? d.name.slice(0, 30) : '',
      rooms: Array.isArray(d.rooms) ? d.rooms.filter(validRoom).map(r => {
        const room = { name: r.name, key: r.key };
        if (typeof r.label === 'string' && clean(r.label)) room.label = clean(r.label).slice(0, 40);
        return room;
      }) : [],
      saver: ['on', 'off'].includes(d.saver) ? d.saver : 'auto'
    };
  } catch { return { name: '', rooms: [], saver: 'auto' }; }
}
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch {} }
let data = load();

function addRoom(r) {
  if (!data.rooms.some(x => sameRoom(x, r))) {
    const room = { name: r.name, key: r.key };
    if (r.label && r.label !== r.name) room.label = r.label;
    data.rooms.push(room);
  }
  save();
}

// What this device calls a room: your own name for it if you gave one, else its real name.
const shownName = r => r.label || r.name;

// Rooms found in pasted text: invite links, one or many, in any surrounding text. A line like
// "Weekend crew: https://…#room=family&key=…" (as "Copy all rooms" makes) keeps "Weekend crew"
// as this device's own name for the room.
function roomsFromText(text) {
  const found = [];
  for (const line of String(text || '').split(/\n/)) {
    const re = /#room=([^&\s#]+)&key=([^\s&#]+)/g;
    let m, first = true;
    while ((m = re.exec(line))) {
      try {
        const r = { name: clean(decodeURIComponent(m[1])).slice(0, 40), key: decodeURIComponent(m[2]).trim() };
        if (!validRoom(r) || found.some(x => sameRoom(x, r))) continue;
        // Only the exact "name: link" lines that Copy all rooms makes carry a name of their own,
        // so a pasted message like "join us here https://…" doesn't become a room's name.
        const own = first && line.match(/^\s*([^:]{1,40}):\s+https?:\/\/\S+\s*$/);
        if (own && clean(own[1]).toLowerCase() !== r.name.toLowerCase()) r.label = clean(own[1]);
        first = false;
        found.push(r);
      } catch {}
    }
  }
  return found;
}

function exportText() {
  return data.rooms.map(r => `${shownName(r)}: ${inviteLink(r)}`).join('\n');
}

function inviteLink(r) {
  const base = location.origin + location.pathname;
  return base + '#room=' + encodeURIComponent(r.name) + '&key=' + encodeURIComponent(r.key);
}

// Tapping Invite copies the link straight away, then offers sharing through apps.
let sheetRoom = null;
async function invite(r) {
  const url = inviteLink(r);
  // On phones: the phone's own share sheet straight away (AirDrop, Messages, Copy…).
  if (navigator.share && (IS_IOS || IS_ANDROID)) {
    try { await navigator.share({ title: `${r.name} · video room`, url }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }   // closed it: nothing to do
  }
  const copied = await copyText(url);   // copied straight away: one tap and it's ready to paste
  openSheet({ room: r, title: `Invite to ${shownName(r)}`, label: 'Invite link', value: url, copy: 'Copy link', share: !!navigator.share,
    sub: 'Anyone with this link can join. Send it only to people you would call.' });
  if (copied) markCopied(); else { $('sheetLink').focus(); $('sheetLink').select(); }
}
// One sheet for anything to copy: an invite link, or (when copying was refused) rooms or diagnostics.
let copiedTimer = 0, copyLabel = 'Copy link';
function openSheet({ room = null, title, sub, label, value, copy = 'Copy', share = false }) {
  sheetRoom = room;
  $('sheetTitle').textContent = title;
  $('sheetSub').textContent = sub;
  $('sheetLabel').textContent = label;
  $('sheetLink').value = value;
  copyLabel = copy;
  clearTimeout(copiedTimer);
  $('sheetCopyText').textContent = copy;
  $('sheetCopy').querySelector('use').setAttribute('href', '#i-copy');
  $('sheetShare').hidden = !share;
  $('sheetCopy').classList.toggle('primary', !share);   // where Share isn't offered, Copy is the main action
  $('sheetBack').hidden = false;
  $('sheet').hidden = false;
}
function markCopied() {
  $('sheetCopyText').textContent = 'Copied';
  $('sheetCopy').querySelector('use').setAttribute('href', '#i-check');
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    $('sheetCopyText').textContent = copyLabel;
    $('sheetCopy').querySelector('use').setAttribute('href', '#i-copy');
  }, 1600);
}
$('sheetCopy').addEventListener('click', async () => {
  if (await copyText($('sheetLink').value)) markCopied();
  else { $('sheetLink').focus(); $('sheetLink').select(); }
});
function closeSheet() { $('sheet').hidden = true; $('sheetBack').hidden = true; sheetRoom = null; }
$('sheetDone').addEventListener('click', closeSheet);
$('sheetBack').addEventListener('click', closeSheet);
$('sheetLink').addEventListener('focus', e => e.target.select());
$('sheetShare').addEventListener('click', async () => {
  if (!sheetRoom) return;
  // The link itself, not a text containing it: AirDrop then opens the page on the other
  // phone instead of saving a note, and chat apps show it as a link.
  try { await navigator.share({ title: `${sheetRoom.name} · video room`, url: inviteLink(sheetRoom) }); closeSheet(); } catch {}
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('sheet').hidden) closeSheet(); });

/* -------------------------------------------------------------- navigation */

const SCREENS = ['home', 'add', 'lobby', 'call'];
let current = 'home';

function show(s) {
  if (s !== 'call' && location.hash) history.replaceState(history.state, '', location.pathname + location.search);
  for (const id of SCREENS) $(id).hidden = id !== s;
  current = s;
  document.body.dataset.screen = s;
  if (!$('sheet').hidden) closeSheet();
  window.scrollTo(0, 0);
  syncWatching();
}
function push(s) { history.pushState({ s }, ''); show(s); }
function back() {
  if (history.state && history.state.s && history.state.s !== 'home') history.back();
  else { teardown(); toHome(); }
}
function teardown() {
  if (inCall) leaveCall();
  else if (current === 'lobby') stopMedia();
}
addEventListener('popstate', e => {
  const s = e.state && e.state.s;
  teardown();
  if (s === 'add') { show('add'); return; }
  if (s && s !== 'home') history.replaceState({ s: 'home' }, '');
  toHome();
});
for (const b of document.querySelectorAll('[data-back]')) b.addEventListener('click', back);

/* -------------------------------------------------------------------- home */

let editing = false;
let pendingToast = '';

function toHome() {
  forgetActive();   // back on the rooms screen on purpose: a refresh should stay here
  renderHome();
  show('home');
  if (pendingToast) { toast(pendingToast); pendingToast = ''; }
}

function renderHome() {
  if (!data.rooms.length) editing = false;
  const first = !data.rooms.length;
  $('home').classList.toggle('first', first);
  $('homeEmpty').hidden = !first;
  $('homeRooms').hidden = first;
  $('editBtn').hidden = first;
  $('editBtn').textContent = editing ? 'Done' : 'Edit';
  $('moveBox').hidden = !editing;
  $('addFirstBtn').hidden = !first;
  $('addFirstBtn').parentElement.hidden = editing;
  $('forgetBtn').hidden = first;
  const list = $('roomList'), live = $('liveList');
  list.replaceChildren();
  live.replaceChildren();
  rowRefs.clear();
  data.rooms.forEach((r, i) => {
    const li = el('li', 'room');
    if (editing) { li.append(...editRow(r, i)); list.append(li); return; }
    const rk = roomKeyOf(r);
    const now = presenceNow.get(rk);
    if (now) { live.append(liveCard(r, rk, now)); return; }
    const main = el('button', 'main');
    main.type = 'button';
    main.append(el('span', 'initial', initialOf(shownName(r))), el('span', 'name', shownName(r)));   // invite sits where a chevron would: one trailing control, less clutter
    main.addEventListener('click', () => openLobby(r, false));
    const inv = el('button', 'icon-btn');
    inv.type = 'button';
    inv.setAttribute('aria-label', 'Invite people to ' + shownName(r));
    inv.append(icon('invite'));
    inv.addEventListener('click', () => invite(r));
    li.append(main, inv);
    list.append(li);
  });
  $('liveSec').hidden = !live.children.length;
  $('savedSec').hidden = !list.children.length;
  $('savedTitle').hidden = !live.children.length;   // a heading is only needed beside "In a call now"
  syncWatching();
}
const initialOf = name => (Array.from(String(name).trim())[0] || '?').toUpperCase();

// A room with a call going on: who is in it, for how long, and a Join button.
function liveCard(r, rk, now) {
  const li = el('li', 'room live');
  const main = el('button', 'main');
  main.type = 'button';
  const sub = el('span', 'sub', liveText(now));
  const text = el('span', 'text');
  text.append(el('span', 'name', shownName(r)), sub);
  main.append(el('span', 'initial', initialOf(shownName(r))), text);
  main.addEventListener('click', () => openLobby(r, false));
  const join = el('button', 'btn live', 'Join');
  join.type = 'button';
  join.setAttribute('aria-label', 'Join ' + shownName(r));
  join.addEventListener('click', () => openLobby(r, false));
  li.append(main, join);
  rowRefs.set(rk, { sub, li });
  return li;
}
function liveText({ names, since }) {
  const who = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}`
    : `${names[0]}, ${names[1]} and ${names.length - 2} more`;
  if (!since) return who;
  const min = Math.floor((Date.now() / 1000 - since) / 60);
  return `${who} · ${min < 1 ? 'just started' : min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`}`;
}
setInterval(() => {
  if (current !== 'home' || document.visibilityState !== 'visible') return;
  for (const [rk, ref] of rowRefs) { const now = presenceNow.get(rk); if (now) ref.sub.textContent = liveText(now); }
}, 30000);

// Editing: give a room your own name (only on this device; others keep its real name),
// move it up or down, or remove it.
function editRow(r, i) {
  const col = el('div', 'edit-col');
  const input = el('input', 'label');
  input.type = 'text';
  input.maxLength = 40;
  input.value = shownName(r);
  input.setAttribute('aria-label', 'Your name for ' + r.name);
  input.enterKeyHint = 'done';
  const real = el('span', 'real', r.label ? 'Room: ' + r.name : '');
  input.addEventListener('change', () => {
    const v = clean(input.value).slice(0, 40);
    if (!v || v.toLowerCase() === r.name.toLowerCase()) delete r.label; else r.label = v;
    input.value = shownName(r);
    real.textContent = r.label ? 'Room: ' + r.name : '';
    for (const b of buttons) b.setAttribute('aria-label', b.__what + ' ' + shownName(r));
    save();
  });
  const buttons = [];
  input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
  col.append(input, real);
  const move = (dir, name) => {
    const b = el('button', 'icon-btn small');
    b.type = 'button';
    b.__what = dir < 0 ? 'Move up' : 'Move down';
    b.setAttribute('aria-label', b.__what + ' ' + shownName(r));
    buttons.push(b);
    b.append(icon(name));
    b.disabled = dir < 0 ? i === 0 : i === data.rooms.length - 1;
    b.addEventListener('click', () => {
      const j = i + dir;
      [data.rooms[i], data.rooms[j]] = [data.rooms[j], data.rooms[i]];
      save(); renderHome();
    });
    return b;
  };
  const del = el('button', 'icon-btn del');
  del.type = 'button';
  del.__what = 'Remove';
  del.setAttribute('aria-label', 'Remove ' + shownName(r));
  buttons.push(del);
  del.append(icon('trash'));
  del.addEventListener('click', () => {
    if (!confirm(`Remove "${shownName(r)}" from this device?\nYou can add it again later with its invite link.`)) return;
    data.rooms = data.rooms.filter(x => !sameRoom(x, r));
    save(); renderHome();
  });
  return [col, move(-1, 'up'), move(1, 'down'), del];
}

$('editBtn').addEventListener('click', () => { editing = !editing; renderHome(); });
/* Diagnostics: everything useful for working out what went wrong, in one copy, to paste
   anywhere. It includes this device's public IP address (from the network check), so the
   button says what it copies. Other people's addresses are not included. */
const troubleAt = [];
function trouble(what, now) {
  troubleAt.push(Date.now());
  while (troubleAt.length && Date.now() - troubleAt[0] > 60000) troubleAt.shift();
  if (now || troubleAt.length >= 3) $('troubleBtn').classList.add('alert');
}
async function diagnostics() {
  const conn = navigator.connection;
  const lines = [
    `Call ${VERSION} · ${navigator.userAgent}`,
    `When: ${new Date().toString()}`,
    `Running in: ${inAppBrowser() ? 'an app\'s built-in browser' : STANDALONE ? 'the home screen app' : 'the browser'} · screen ${screen.width}x${screen.height} @${devicePixelRatio} · language ${navigator.language}`,
    `Network: ${NET_LABEL[netType] ? netType : 'unknown'}${netV6 ? ', IPv6' : ', no IPv6'}${conn ? ` · type ${conn.type || '?'}, effective ${conn.effectiveType || '?'}, ~${conn.downlink || '?'} Mbps, rtt ${conn.rtt || '?'} ms${conn.saveData ? ', save-data' : ''}` : ''} · data saver ${saverOn() ? 'on' : 'off'} (${data.saver})`,
    `Public address: ${netAddrs.join(', ') || 'unknown'}`,
    `Call: ${inCall ? 'in a call' : current} · people ${people.size} · rejoins ${rejoins} · since start ${Math.round((Date.now() - logStart) / 1000)} s`
  ];
  const v = local && local.getVideoTracks()[0], a = local && local.getAudioTracks()[0];
  let vs = {};
  try { vs = v ? v.getSettings() : {}; } catch {}
  lines.push(`Me: mic ${a ? (micOn ? 'on' : 'muted') : 'none'} · camera ${v ? (camOn ? `on ${vs.width || '?'}x${vs.height || '?'}@${Math.round(vs.frameRate || 0)}` : 'off') : 'none'}${zoomState.track ? ` · zoom ${fmtZoom(zoomState.value)}` : ''} · float ${canFloat() ? 'available' : 'not available'}${lastFloatError ? ` (last: ${lastFloatError})` : ''}`);
  for (const p of people.values()) {
    const state = p.reconnecting ? 'reconnecting' : p.relayVia ? 'passed along' : p.peerId ? 'linked' : 'no link';
    let rx = '';
    try { rx = p.peerId ? await receiving(p.peerId) : ''; } catch {}
    lines.push(`- ${who(p)}: ${state}${p.net ? ` · their network ${p.net}${p.v6 ? ', IPv6' : ''}` : ''}${p.path ? ` · path ${p.path}` : ''}${rx ? ` · receiving ${rx}` : ''}${p.ds ? ' · data saver' : ''}${p.weak ? ' · weak' : ''}`);
  }
  for (const m of roomMembers) if (m.cs && m.cs !== mySession && !people.has(m.cs)) lines.push(`- ${m.name || '?'}[${m.cs.slice(-6)}]: in the room, not connected`);
  lines.push('', 'Log:');
  return lines.concat(connLog).join('\n');
}
// Copy, also on iPhones, where copying must start straight from the tap: the text is handed
// over as a promise and filled in once gathered.
async function copyDiagnostics() {
  const text = diagnostics();
  try {
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then(t => new Blob([t], { type: 'text/plain' })) })]);
    } else if (!(await copyText(await text))) throw new Error('refused');
    toast('Diagnostics copied (includes your public IP address). Paste them to whoever asked.', 4500);
    $('troubleBtn').classList.remove('alert');
  } catch {
    if (await copyText(await text)) { toast('Diagnostics copied (includes your public IP address).', 4500); return; }
    openSheet({ title: 'Diagnostics', sub: 'Copying was refused. Select all of it and copy it.', label: 'Diagnostics',
      value: (await text).replace(/\n/g, '  ') });
  }
}
$('troubleBtn').addEventListener('click', copyDiagnostics);

function logText() {
  const head = [
    `Call ${VERSION} · ${navigator.userAgent}`,
    `Network: ${netType || 'unknown'}${netV6 ? ', IPv6' : ''} · in call: ${inCall ? 'yes' : 'no'} · people: ${people.size} · rejoins: ${rejoins}`,
    `Now: ${[...people.values()].map(p => `${who(p)} ${p.reconnecting ? 'reconnecting' : p.relayVia ? 'passed along' : p.peerId ? 'linked' : 'no link'}`).join('; ') || 'nobody'}`,
    `Since start: ${Math.round((Date.now() - logStart) / 1000)} s`,
    ''
  ];
  return head.concat(connLog).join('\n');
}
$('copyLog').addEventListener('click', copyDiagnostics);

$('copyAllBtn').addEventListener('click', async () => {
  const text = exportText();
  const n = data.rooms.length;
  if (await copyText(text)) { toast(`Copied ${n} room${n === 1 ? '' : 's'}. In the other browser or app: Paste an invite link.`, 4500); return; }
  // Copying was refused: show them to copy by hand.
  openSheet({ title: 'Copy your rooms', sub: 'Select all of it and copy it, then paste it in the other browser or app with Paste an invite link.',
    label: 'Your rooms', value: text.replace(/\n/g, '  ') });
  $('sheetLink').focus(); $('sheetLink').select();
});
$('pasteLinksBtn').addEventListener('click', () => { openAdd(true); $('importText').focus(); });
$('addBtn').addEventListener('click', () => openAdd(false));
$('addFirstBtn').addEventListener('click', () => openAdd(false));
function askForget(open) {
  $('confirm').hidden = $('confirmBack').hidden = !open;
  if (open) $('confirmNo').focus(); else $('forgetBtn').focus();
}
$('forgetBtn').addEventListener('click', () => askForget(true));
$('confirmNo').addEventListener('click', () => askForget(false));
$('confirmBack').addEventListener('click', () => askForget(false));
$('confirm').addEventListener('keydown', e => { if (e.key === 'Escape') askForget(false); });
$('confirmYes').addEventListener('click', () => {
  try { localStorage.removeItem(STORE_KEY); } catch {}
  data = { name: '', rooms: [] };
  askForget(false);
  renderHome();
  toast('Everything removed from this device');
});

/* ---------------------------------------------------------------- add room */

function addMode(pasting) {
  $('createPart').hidden = pasting;
  $('importPart').hidden = !pasting;
  $('segNew').setAttribute('aria-checked', String(!pasting));
  $('segPaste').setAttribute('aria-checked', String(pasting));
}
$('segNew').addEventListener('click', () => { addMode(false); $('addErr').textContent = ''; });
$('segPaste').addEventListener('click', () => { addMode(true); $('importErr').textContent = ''; showFound(); });
for (const id of ['segNew', 'segPaste']) $(id).addEventListener('keydown', e => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const other = id === 'segNew' ? 'segPaste' : 'segNew';
  $(other).click(); $(other).focus();
});
function showPassword(on) {
  $('addKey').type = on ? 'text' : 'password';
  $('revealBtn').setAttribute('aria-pressed', String(on));
  $('revealBtn').setAttribute('aria-label', on ? 'Hide password' : 'Show password');
}
$('revealBtn').addEventListener('click', () => showPassword($('addKey').type === 'password'));
let joinAfterSave = false;
function openAdd(pasting) {
  addMode(!!pasting);
  joinAfterSave = false;
  $('addTitle').textContent = 'Add a room';
  $('addSeg').hidden = false;
  $('createLead').hidden = true;
  $('saveBtn').hidden = false;
  $('saveJoinBtn').textContent = 'Save and join';
  showPassword(false);
  $('addName').value = '';
  $('addKey').value = newPassword();
  $('addErr').textContent = '';
  $('importText').value = '';
  $('importErr').textContent = '';
  const canRead = !!(navigator.clipboard && navigator.clipboard.readText);
  $('pasteBtn').hidden = !canRead;
  showFound();
  push('add');
}
// Opened from an address with only a room name: ask for that room's password, then go in.
function openAddForRoom(name) {
  openAdd(false);
  joinAfterSave = true;
  $('addTitle').textContent = `Join "${name}"`;
  $('addSeg').hidden = true;
  $('createLead').hidden = false;
  $('createLead').textContent = 'Enter the room\'s password. Ask whoever sent you the address for it, or for an invite link.';
  $('saveBtn').hidden = true;
  $('saveJoinBtn').textContent = 'Join';
  $('addName').value = name;
  $('addKey').value = '';
  setTimeout(() => $('addKey').focus(), 50);
}

// As soon as there is text in the box: which rooms it holds, and one clear button to add them.
function showFound() {
  const found = roomsFromText($('importText').value);
  const fresh = found.filter(r => !data.rooms.some(x => sameRoom(x, r)));
  const btn = $('importBtn');
  const box = $('importFound');
  box.replaceChildren();
  if (found.length) {
    box.append(el('span', '', `Found ${found.length} room${found.length === 1 ? '' : 's'}: `));
    found.forEach((r, i) => {
      const had = !fresh.includes(r);
      box.append(el('span', had ? 'have' : '', shownName(r) + (had ? ' (already here)' : '') + (i < found.length - 1 ? ', ' : '')));
    });
  } else if ($('importText').value.trim()) {
    box.append(el('span', '', 'No invite links in this text yet. They look like …#room=family&key=…'));
  }
  btn.disabled = !fresh.length;
  btn.classList.toggle('primary', fresh.length > 0);
  btn.textContent = fresh.length === 1 && found.length === 1 ? 'Join room'
    : fresh.length ? `Add ${fresh.length} rooms` : found.length ? 'You already have these' : 'Join room';
  return { found, fresh };
}
$('importText').addEventListener('input', () => { $('importErr').textContent = ''; showFound(); });

function importRooms() {
  const { found, fresh } = showFound();
  if (!fresh.length) return false;
  for (const r of fresh) addRoom(r);
  // One invite link: go straight to that room. Several (moving rooms over): back to the list.
  if (fresh.length === 1 && found.length === 1) { history.replaceState({ s: 'home' }, ''); openLobby(fresh[0], false); return true; }
  const had = found.length - fresh.length;
  pendingToast = `Added ${fresh.length} room${fresh.length === 1 ? '' : 's'}` + (had ? ` (${had} you already had)` : '');
  back();
  return true;
}
$('importBtn').addEventListener('click', importRooms);

// The main button: read the clipboard and add what's in it, in one tap.
$('pasteBtn').addEventListener('click', async () => {
  $('importErr').textContent = '';
  let text = '';
  try { text = await navigator.clipboard.readText(); }
  catch {
    $('importErr').textContent = 'Couldn\'t read the clipboard. Press and hold in the box below, then tap Paste.';
    $('importText').focus();
    return;
  }
  $('importText').value = text || '';
  const { found } = showFound();
  if (importRooms()) return;
  $('importErr').textContent = found.length ? 'You already have all of these rooms.'
    : 'Your clipboard has no invite links. Copy them first (in the other browser: Edit, Copy all rooms).';
});
$('genBtn').addEventListener('click', () => { $('addKey').value = newPassword(); showPassword(true); });
$('addName').addEventListener('keydown', e => { if (e.key === 'Enter') $('addKey').focus(); });
$('addKey').addEventListener('keydown', e => { if (e.key === 'Enter') $('saveJoinBtn').click(); });
function saveForm(join) {
  const r = { name: clean($('addName').value), key: $('addKey').value.trim() };
  if (!r.name) { $('addErr').textContent = 'Give the room a name, like family.'; $('addName').focus(); return; }
  if (r.key.length < 8) { $('addErr').textContent = 'Use a password of at least 8 characters. The generated one is best.'; return; }
  if (/\s/.test(r.key)) { $('addErr').textContent = 'The password cannot contain spaces.'; return; }
  const existed = data.rooms.some(x => sameRoom(x, r));
  addRoom(r);
  if (join || joinAfterSave) { joinAfterSave = false; history.replaceState({ s: 'home' }, ''); openLobby(r, false); return; }
  pendingToast = existed ? 'You already had this room' : 'Room saved. Use the invite button to send it.';
  back();
}
$('saveJoinBtn').addEventListener('click', () => saveForm(true));
$('saveBtn').addEventListener('click', () => saveForm(false));

/* ------------------------------------------------------------------- media */

let local = null;      // our MediaStream
let facing = 'user';
let micOn = true, camOn = true;

const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

// Voice that survives lost packets: each bit of sound also rides along in the next packet
// (audio redundancy, RED), where both phones support it. Otherwise plain Opus, as before.
const VOICE_CODECS = (() => {
  try {
    const all = RTCRtpReceiver.getCapabilities('audio').codecs;
    const red = all.filter(c => /^audio\/red$/i.test(c.mimeType));
    const opus = all.filter(c => /^audio\/opus$/i.test(c.mimeType));
    if (!red.length || !opus.length) return null;
    return [...red, ...opus, ...all.filter(c => !red.includes(c) && !opus.includes(c))];
  } catch { return null; }
})();
// Smaller video at the same quality: H.265 (HEVC) takes noticeably less data than H.264 or
// VP8 for the same picture. Safari and Chrome only offer it where the device encodes and
// decodes it in hardware, so preferring it costs no battery; with anyone who lacks it, the
// call simply uses the next format, as before. VP9 and AV1 are left alone: often software-only
// on phones, and browsers can't be trusted yet to say when they are efficient.
const VIDEO_CODECS = (() => {
  try {
    const all = RTCRtpReceiver.getCapabilities('video').codecs;
    const hevc = all.filter(c => /^video\/(H265|HEVC)$/i.test(c.mimeType));
    if (!hevc.length) return null;
    return [...hevc, ...all.filter(c => !hevc.includes(c))];
  } catch { return null; }
})();
if ((VOICE_CODECS || VIDEO_CODECS) && window.RTCPeerConnection && RTCRtpTransceiver.prototype.setCodecPreferences) {
  const addTrack = RTCPeerConnection.prototype.addTrack;
  RTCPeerConnection.prototype.addTrack = function (track, ...streams) {
    const sender = addTrack.call(this, track, ...streams);
    try {
      const prefs = track && (track.kind === 'audio' ? VOICE_CODECS : VIDEO_CODECS);
      if (sender && prefs) {
        const t = this.getTransceivers().find(x => x.sender === sender);
        if (t) t.setCodecPreferences(prefs);
      }
    } catch {}
    return sender;
  };
}
/* Knocking on a port block. Some mobile carriers give each phone a new public port for every
   destination, so the port a phone reports is not the one it will use towards us, and a home
   router drops packets from ports it hasn't sent to. But carriers usually hand each phone a
   small block of ports (about 64). So if a connection hasn't come up after a moment, we also
   check the ports around the one reported: that opens our router for all of them, and the
   phone's packets get through from whichever port it was given. A few dozen tiny checks,
   once, and only when the normal way didn't work. */
const KNOCK_AFTER_MS = 2500;
const KNOCK_SPAN = 40;            // ports either side of the reported ones
const KNOCK_MAX = 128;            // at most this many extra checks per connection
if (window.RTCPeerConnection) {
  const addIce = RTCPeerConnection.prototype.addIceCandidate;
  RTCPeerConnection.prototype.addIceCandidate = function (cand, ...rest) {
    const done = addIce.call(this, cand, ...rest);
    try { noteMapped(this, cand, addIce); } catch {}
    return done;
  };
}
function noteMapped(pc, cand, addIce) {
  const line = cand && (typeof cand === 'string' ? cand : cand.candidate);
  if (!line) return;
  const f = line.replace(/^a=/, '').split(' ');
  // candidate:<foundation> <component> <protocol> <priority> <address> <port> typ <type> ...
  if (f.length < 8 || String(f[2]).toLowerCase() !== 'udp' || f[7] !== 'srflx' || f[1] !== '1') return;
  const ip = f[4], port = Number(f[5]);
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || !(port > 0 && port < 65536)) return;
  const k = pc.__knock || (pc.__knock = { seen: new Map(), done: new Set(), timer: 0, tries: 0 });
  const t = k.seen.get(ip) || { ports: new Set(), cand };
  t.ports.add(port);
  k.seen.set(ip, t);
  if (!k.timer) k.timer = setTimeout(() => knock(pc, addIce), KNOCK_AFTER_MS);
}
function knock(pc, addIce) {
  const k = pc.__knock;
  k.timer = 0;
  if (['connected', 'completed', 'closed'].includes(pc.iceConnectionState) || pc.signalingState === 'closed') return;
  if (!pc.remoteDescription) { if (++k.tries < 5) k.timer = setTimeout(() => knock(pc, addIce), 1000); return; }
  let added = 0;
  for (const [ip, t] of k.seen) {
    const ports = [...t.ports];
    const lo = Math.max(1024, Math.min(...ports) - KNOCK_SPAN), hi = Math.min(65535, Math.max(...ports) + KNOCK_SPAN);
    for (let p = lo; p <= hi && k.done.size < KNOCK_MAX; p++) {
      if (t.ports.has(p) || k.done.has(ip + ':' + p)) continue;
      k.done.add(ip + ':' + p);
      added++;
      addIce.call(pc, {
        candidate: `candidate:k${p} 1 udp ${100 + (p % 50)} ${ip} ${p} typ srflx raddr 0.0.0.0 rport 0`,
        sdpMid: t.cand.sdpMid, sdpMLineIndex: t.cand.sdpMLineIndex, usernameFragment: t.cand.usernameFragment
      }).catch(() => {});
    }
    if (added) log('KNOCK', added, `ports around ${Math.min(...ports)}-${Math.max(...ports)}`, '(link not up yet)');
  }
}

const videoConstraints = f => ({ facingMode: f, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } });

async function startMedia() {
  $('mediaErr').textContent = '';
  $('retryMedia').hidden = true;
  if (local) { attachLocal(); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    $('mediaErr').textContent = 'This browser cannot use the camera on this page. Open the link in Safari or Chrome.';
    return;
  }
  let stream = null, note = '';
  try {
    stream = await gum({ audio: AUDIO, video: videoConstraints(facing) });
  } catch (e) {
    log('CAMERA', e && e.name);
    try {
      stream = await gum({ audio: AUDIO });
      note = cameraNote(e);
      if (e && e.name !== 'NotFoundError' && e.name !== 'OverconstrainedError') { $('retryMedia').textContent = 'Try the camera again'; $('retryMedia').hidden = false; }
    } catch (e2) {
      log('MICROPHONE', e2 && e2.name);
      note = mediaHelp(e2, 'the camera and microphone');
      $('retryMedia').textContent = 'Try again';
      $('retryMedia').hidden = false;
    }
  }
  // The person may have gone back while the permission prompt was open.
  if (current !== 'lobby' && !inCall) { if (stream) stream.getTracks().forEach(t => t.stop()); return; }
  local = stream;
  $('mediaErr').textContent = note;
  attachLocal();
  updateFlip();
}

/* When the camera or microphone is refused: say why, and exactly where to allow it on this
   phone or computer, instead of a generic error. */
const UA = navigator.userAgent;
const IS_IOS = /iPhone|iPad|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_ANDROID = /Android/.test(UA);
const IS_FIREFOX = /Firefox|FxiOS/.test(UA);
const IS_CHROME_IOS = /CriOS|EdgiOS/.test(UA);
const IS_MAC_SAFARI = !IS_IOS && /Macintosh/.test(UA) && /Safari/.test(UA) && !/Chrome|Chromium|Edg/.test(UA);
const IS_MAC = /Macintosh/.test(UA) && !IS_IOS;
const STANDALONE = navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
const inAppBrowser = () => /FBAN|FBAV|FB_IAB|FBIOS|Messenger|Instagram|\bLine\/|Snapchat|TikTok|musical_ly|BytedanceWebview/i.test(UA);

function allowSteps(what) {
  if (inAppBrowser()) return 'Open this link in Safari or Chrome instead: tap the ⋯ menu, then Open in browser.';
  if (IS_IOS && STANDALONE) return `Open Settings, then Apps, Safari, and set Camera and Microphone to Allow. Then close this app and open it again.`;
  if (IS_IOS && IS_CHROME_IOS) return `Open Settings, then Apps, Chrome, and turn on Camera and Microphone. Then reload this page.`;
  if (IS_IOS && IS_FIREFOX) return `Open Settings, then Apps, Firefox, and turn on Camera and Microphone. Then reload this page.`;
  if (IS_IOS) return `Tap "aA" in the address bar, then Website Settings, and set Camera and Microphone to Allow. If they are missing there: Settings, Apps, Safari, Camera and Microphone, Allow.`;
  if (IS_ANDROID && IS_FIREFOX) return `Tap the lock left of the web address, and allow ${what}. If that doesn't help: Android Settings, Apps, Firefox, Permissions.`;
  if (IS_ANDROID) return `Tap the icon left of the web address, then Permissions, and allow ${what}. If they are off for the browser itself: Android Settings, Apps, Chrome, Permissions.`;
  if (IS_MAC_SAFARI) return `In the Safari menu choose Settings for This Website, and set Camera and Microphone to Allow.`;
  if (IS_FIREFOX) return `Click the crossed-out camera or microphone in the address bar and remove the block.` + (IS_MAC ? ' On a Mac, also allow Firefox in System Settings, Privacy & Security, Camera and Microphone.' : '');
  return `Click the icon left of the web address and allow ${what}.` + (IS_MAC ? ' On a Mac, also allow the browser in System Settings, Privacy & Security, Camera and Microphone.' : ' On Windows, also check Settings, Privacy & security, Camera and Microphone.');
}
function mediaHelp(e, what) {
  const name = e && e.name;
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return `${what[0].toUpperCase() + what.slice(1)} ${what.includes(' and ') ? 'are' : 'is'} blocked. ${allowSteps(what)} Then tap Try again.`;
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return `Another app is using ${what} (a call, FaceTime, another browser tab). Close it, then tap Try again.`;
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return `No microphone found. Plug one in, then tap Try again.`;
  return `Could not start ${what}. Tap Try again, or reload the page.`;
}
// The camera failed but the microphone works: join with sound, and say what to do about the camera.
function cameraNote(e) {
  const name = e && e.name;
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera found. You can still join with sound.';
  if (name === 'NotAllowedError' || name === 'SecurityError') return `The camera is blocked, so you will join with sound only. ${allowSteps('the camera')} Then tap Try the camera again.`;
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'Another app is using the camera (a call, FaceTime, another browser tab), so you will join with sound only. Close it, then tap Try the camera again.';
  return 'The camera could not start, so you will join with sound only.';
}

function stopMedia() {
  if (local) local.getTracks().forEach(t => t.stop());
  local = null;
  $('preview').srcObject = null;
  $('self').srcObject = null;
}

function attachLocal() {
  for (const v of [$('preview'), $('self')]) {
    if (v.srcObject !== local) v.srcObject = local;
    v.classList.toggle('mirror', facing === 'user');
  }
  applyToggles();
}

function setToggle(btn, off, available, labels) {
  btn.classList.toggle('is-off', off);
  btn.disabled = !available;
  if (labels.aria) btn.setAttribute('aria-label', off ? labels.aria[1] : labels.aria[0]);
  const lb = btn.querySelector('.lb');
  if (lb && labels.text) lb.textContent = off ? labels.text[1] : labels.text[0];
}

function applyToggles() {
  const a = local && local.getAudioTracks()[0];
  const v = local && local.getVideoTracks()[0];
  if (a) a.enabled = micOn;
  if (v) v.enabled = camOn;
  const micL = { aria: ['Turn microphone off', 'Turn microphone on'], text: ['Mute', 'Unmute'] };
  const camL = { aria: ['Turn camera off', 'Turn camera on'], text: ['Camera', 'Camera'] };
  setToggle($('pMic'), !micOn || !a, !!a, micL);
  setToggle($('cMic'), !micOn || !a, !!a, micL);
  setToggle($('pCam'), !camOn || !v, !!v, camL);
  setToggle($('cCam'), !camOn || !v, !!v, camL);
  refreshZoom();
  $('previewOff').hidden = !!(v && camOn);
  $('previewOffText').textContent = v ? 'Camera is off' : (local ? 'No camera' : 'Starting camera…');
  $('pFlip').hidden = $('cFlip').hidden || !camOn;
  $('self').classList.toggle('cam-off', !(v && camOn));
  if (!micOn) $('self').classList.remove('speaking');   // never show ourselves talking while muted
  if (swapped) { swapped.me.classList.toggle('muted', !micOn); if (!micOn) swapped.me.classList.remove('speaking'); }
}

async function updateFlip() {
  let n = 0;
  try { n = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput').length; } catch {}
  $('cFlip').hidden = n < 2 || !(local && local.getVideoTracks()[0]);
  $('pFlip').hidden = $('cFlip').hidden || !camOn;
}

// Swap a track for a fresh one (camera flip, or recovering after iOS suspends the camera).
let swapping = false;
async function swapTrack(kind, nextFacing) {
  if (!local || swapping) return;
  swapping = true;
  const old = kind === 'video' ? local.getVideoTracks()[0] : local.getAudioTracks()[0];
  try {
    if (old) old.stop();   // iPhones cannot open two cameras at once
    let s;
    if (kind === 'video') {
      try { s = await gum({ video: { ...videoConstraints(nextFacing), facingMode: { exact: nextFacing } } }); }
      catch { s = await gum({ video: videoConstraints(nextFacing) }); }
    } else {
      s = await gum({ audio: AUDIO });
    }
    const nt = kind === 'video' ? s.getVideoTracks()[0] : s.getAudioTracks()[0];
    if (old) {
      if (room) await room.replaceTrack(old, nt).catch(() => {});
      local.removeTrack(old);
    }
    local.addTrack(nt);
    if (kind === 'video') facing = nextFacing;
    $('self').srcObject = null; $('preview').srcObject = null;
    attachLocal();
  } catch {
    toast(kind === 'video' ? 'Could not switch the camera' : 'Could not restart the microphone');
  } finally {
    swapping = false;
  }
}

$('pMic').addEventListener('click', () => { micOn = !micOn; applyToggles(); });
$('pCam').addEventListener('click', () => { camOn = !camOn; applyToggles(); });
$('cMic').addEventListener('click', () => { micOn = !micOn; applyToggles(); sendState(); });
$('cCam').addEventListener('click', () => { camOn = !camOn; applyToggles(); sendState(); });
$('cFlip').addEventListener('click', () => swapTrack('video', facing === 'user' ? 'environment' : 'user'));
$('pFlip').addEventListener('click', () => swapTrack('video', facing === 'user' ? 'environment' : 'user'));
// Trying again also retries the camera when only the microphone started.
$('retryMedia').addEventListener('click', () => {
  if (local && !local.getVideoTracks().length && !inCall) stopMedia();
  startMedia();
});

// iOS stops (or silences) the camera and microphone when the app goes to the background.
// Tell the others, and bring our tracks back when we return.
document.addEventListener('visibilitychange', async () => {
  if (inCall) sendState();
  if (document.visibilityState !== 'visible' || !local) return;
  await recoverLocalTracks(true);
});

// A track that ended, or has delivered nothing for a while although we are visible, is
// replaced with a fresh one from the camera or microphone (the others get it seamlessly).
async function recoverLocalTracks(now) {
  if (!local || swapping || document.visibilityState !== 'visible') return;
  for (const t of local.getTracks()) {
    if (t.readyState === 'ended') { await swapTrack(t.kind, facing); continue; }
    if (t.muted) {
      t.__mutedSince = t.__mutedSince || Date.now();
      if (now ? Date.now() - t.__mutedSince > 1500 : Date.now() - t.__mutedSince > 4000) await swapTrack(t.kind, facing);
    } else t.__mutedSince = 0;
  }
}

/* ------------------------------------------------------------------- lobby */

let lobbyRoom = null;

/* Surviving a page refresh: the room being joined (or the call we are in) is remembered in
   this browser tab only (sessionStorage), and forgotten when the tab closes or we go back. */
const ACTIVE_KEY = 'plaincall.active';
function rememberActive(stage) {
  if (!lobbyRoom) return;
  try {
    sessionStorage.setItem(ACTIVE_KEY, JSON.stringify({
      name: lobbyRoom.name, key: lobbyRoom.key, invited: !!lobbyRoom.invited, stage,
      session: stage === 'call' ? mySession : '', mic: micOn, cam: camOn
    }));
  } catch {}
}
function forgetActive() { try { sessionStorage.removeItem(ACTIVE_KEY); } catch {} }
function recallActive() {
  try {
    const a = JSON.parse(sessionStorage.getItem(ACTIVE_KEY) || 'null');
    if (!a || !validRoom(a) || (a.stage !== 'lobby' && a.stage !== 'call')) return null;
    if (a.session && !/^[0-9a-f]{8,32}$/.test(a.session)) a.session = '';
    return a;
  } catch { return null; }
}

// resume: a call we were in before a refresh; rejoin it straight away.
// Links opened inside Messenger, Facebook, Instagram and the like open in that app's own
// browser, which handles calls worse than Safari or Chrome.
const IN_APP = (() => {
  const ua = navigator.userAgent;
  if (/FBAN|FBAV|FB_IAB|FBIOS|Messenger/i.test(ua)) return 'Messenger or Facebook';
  if (/Instagram/i.test(ua)) return 'Instagram';
  if (/\bLine\//i.test(ua)) return 'LINE';
  if (/Snapchat|TikTok|musical_ly|BytedanceWebview/i.test(ua)) return 'this app';
  return '';
})();

function openLobby(r, invited, resume) {
  lobbyRoom = { name: r.name, key: r.key, invited };
  $('appWarn').hidden = !IN_APP;
  $('appWarn').textContent = IN_APP ? `You opened this inside ${IN_APP}. Calls work better in Safari or Chrome: tap the ⋯ menu and choose Open in browser.` : '';
  const saved = data.rooms.find(x => sameRoom(x, r));
  $('lobbyTitle').textContent = saved ? shownName(saved) : r.name;
  $('lobbyWho').hidden = true;
  $('lobbyLive').hidden = true;
  $('lobbyLead').hidden = !invited;
  $('lobbyLead').textContent = invited ? 'You have been invited to this room. Check your camera and sound, then join.' : '';
  $('saveInviteRow').hidden = !(invited && !data.rooms.some(x => sameRoom(x, r)));
  $('saveInvite').checked = true;
  $('nameInput').value = data.name;
  showInitial();
  $('lobbyErr').textContent = '';
  $('joinBtn').disabled = false;
  $('joinBtn').textContent = 'Join';
  micOn = resume ? resume.mic !== false : true;
  camOn = resume ? resume.cam !== false : true;
  push('lobby');
  rememberActive('lobby');
  applyToggles();
  const media = startMedia();
  checkNetwork().then(showNetWarning);
  if (resume && data.name) {
    $('lobbyLead').hidden = false;
    $('lobbyLead').textContent = 'Rejoining the call…';
    $('joinBtn').disabled = true;
    $('joinBtn').textContent = 'Rejoining…';
    media.then(() => { if (current === 'lobby') join(resume.session); });
  }
}

$('nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.target.blur(); $('joinBtn').click(); } });
// With the camera off, the preview shows your initial, as the others will see it.
function showInitial() { $('previewInitial').textContent = initials(clean($('nameInput').value) || '?'); }
$('nameInput').addEventListener('input', showInitial);
$('joinBtn').addEventListener('click', () => join(''));
// iPhones only let a video start by itself once it has been started from a tap: do that for the
// floating video now, from the tap on Join, so it can float later.
function unlockFloat() {
  try {
    if (!floatVideo.srcObject) { const t = cardTrack(null); if (t) floatVideo.srcObject = new MediaStream([t]); }
    floatVideo.play().catch(() => {});
  } catch {}
}
async function join(resumeSession) {
  unlockFloat();
  const name = clean($('nameInput').value).slice(0, 30);
  if (!name) { $('lobbyErr').textContent = 'Add your name so the others know who joined.'; $('nameInput').focus(); return; }
  $('lobbyErr').textContent = '';
  data.name = name;
  if (lobbyRoom.invited && !$('saveInviteRow').hidden && $('saveInvite').checked) addRoom(lobbyRoom);
  save();
  $('joinBtn').disabled = true;
  $('joinBtn').textContent = 'Joining…';
  try {
    await startCall(lobbyRoom, resumeSession);
  } catch {
    $('lobbyErr').textContent = 'Could not join. Check your connection and try again.';
    $('joinBtn').disabled = false;
    $('joinBtn').textContent = 'Join';
  }
}

/* -------------------------------------------------------------------- call */

// People are tracked by a per-call session id, not by connection, so someone whose
// connection drops and comes back (network switch, tunnel, lift) keeps their tile.
const GRACE_MS = 30000;          // how long a dropped person shows as "Reconnecting…"
const REPAIR_MS = 10000;         // dropped but still in the room after this long: repair the link
const MAX_WAIT_MS = 180000;      // never keep a "Reconnecting…" tile longer than this
const AWAY_GRACE_MS = 20000;     // closed or refreshed their page: this long to come back
const DOWN_MS = 12000;           // all our links dead this long (the library's own repair had its chance): rejoin
const RECHECK_MS = 15000;        // while someone dropped is still in the room, look again this often
const REJOIN_GAP_MS = 8000;      // spacing between our own rejoins (grows with each one, up to 30 s)
let room = null, stateAction = null, callRoom = null, callId = '', inCall = false;
let t0 = 0, timer = 0, wakeLock = null, relayTimer = 0, healthTimer = 0, speakTimer = 0;
let mySession = '', selfReconnecting = false, rejoining = false, downSince = 0, rejoinAt = 0, rejoins = 0;
let pendingLeave = Promise.resolve();
let resendAction = null, relayAction = null, relayStateAction = null;
let aliveInCall = new Set();     // call sessions the room's presence notes say are still here
let roomMembers = [];            // [{ name, cs }] from those notes
const unseen = new Map();        // call session -> { name, since, tries, told }: in the room, not connected to us
const UNSEEN_MS = 15000;         // in the room but not connected this long: try to pick them up
const MAX_TRIES = 2;
const TEST_HOOKS = 0;

/* Connection log: what happened to each connection, and why the app reconnected, kept in
   memory only (gone when the page closes) for "Copy connection log" in the details. No
   addresses or keys in it: only states, candidate types, names and reasons. */
const LOG_MAX = 500;
const connLog = [];
const logStart = Date.now();
function log(...parts) {
  const d = new Date();
  const ts = d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  connLog.push(ts + ' ' + parts.join(' '));
  if (connLog.length > LOG_MAX) connLog.splice(0, connLog.length - LOG_MAX);
}
const who = p => p ? `${p.name || '?'}[${(p.sess || p.key || '').slice(-6)}]` : '?';            // test builds only: lets tests block a direct connection between two people             // rejoins per such person, so a network that can't connect never makes us flap
const people = new Map();        // session id (or 'peer:<id>' for older versions) -> person
const byPeer = new Map();        // connection (peer id) -> person

async function startCall(r, resumeSession) {
  const id = await roomId(r);
  await pendingLeave;                 // a call we just left is still saying goodbye
  if (current !== 'lobby') return;   // went back while hashing
  callRoom = r;
  callId = id;
  // Same session as before a refresh, so the others keep our tile instead of seeing us leave.
  mySession = resumeSession || Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
  selfReconnecting = false; rejoins = 0; downSince = 0; rejoinAt = 0;
  joinCallRoom();

  inCall = true;
  presence.announce(r, () => data.name, () => mySession);
  // The address bar shows the room's name (never its password), so the address can be shared
  // or bookmarked: people who have the room go straight in, others are asked for the password.
  history.replaceState({ s: 'call' }, '', location.pathname + location.search + '#room=' + encodeURIComponent(r.name));
  show('call');
  rememberActive('call');
  const saved = data.rooms.find(x => sameRoom(x, r));
  $('callRoom').textContent = saved ? shownName(saved) : r.name;
  t0 = Date.now();
  timer = setInterval(updateMeta, 1000);
  healthTimer = setInterval(checkHealth, 2000);
  speakTimer = setInterval(watchSpeaking, 250);
  layout();
  watchRelays();
  checkNetwork(true).then(() => { sendState(); renderDetails(); });
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}

function joinCallRoom() {
  const me = joinRoom({
    appId: APP_ID,
    password: callRoom.key,
    identity: 'none',
    maxUsers: MAX_PEOPLE,
    relayConfig: { urls: RELAYS, redundancy: RELAYS.length, warnOnRelayFailure: false }
  }, callId);
  room = me;
  log('JOIN call room', 'as', mySession.slice(-6), `(${VERSION}, network ${netType || 'unchecked'})`);
  const live = () => room === me && inCall;   // ignore late events from a room we already left
  stateAction = me.makeAction('st');
  stateAction.onReceive(ctx => ctx.byteLength <= 512);
  stateAction.onMessage((msg, { peerId }) => { if (live()) onPeerState(peerId, msg); });
  resendAction = me.makeAction('rs');
  resendAction.onReceive(ctx => ctx.byteLength <= 64);
  resendAction.onMessage((msg, { peerId }) => { if (live()) resendTo(peerId); });
  relayAction = me.makeAction('rl');
  relayAction.onReceive(ctx => ctx.byteLength <= 128);
  relayAction.onMessage((msg, { peerId }) => { if (live()) onRelayAsk(peerId, msg); });
  relayStateAction = me.makeAction('rx');
  relayStateAction.onReceive(ctx => ctx.byteLength <= 512);
  relayStateAction.onMessage((msg, { peerId }) => { if (live()) onRelayState(peerId, msg); });
  me.onPeerJoin(({ peerId }) => { if (live()) onPeerJoin(peerId); });
  me.onPeerLeave(({ peerId }) => { if (live()) onPeerLeave(peerId); });
  me.onPeerStream((stream, { peerId, metadata }) => {
    if (!live()) return;
    if (metadata && typeof metadata === 'object' && typeof metadata.via === 'string') onRelayedStream(peerId, metadata.via, stream);
    else onPeerStream(peerId, stream);
  });
  me.onError(err => { if (live()) onRoomError(err); });
}

function leaveCall() {
  if (!inCall) return;
  forgetActive();
  unswap();
  endFloat();
  inCall = false;
  const old = room, st = stateAction;
  // Tell the others this is a real goodbye, not a dropped connection, then leave.
  if (st) st.send({ n: data.name, m: micOn, c: camOn, s: mySession, bye: true }).catch(() => {});
  // Joining the same room again waits for this to finish (it would otherwise collide).
  pendingLeave = new Promise(res => setTimeout(res, 300)).then(() => old && old.leave()).catch(() => {});
  if (callRoom) presence.leave(callRoom);
  room = null; stateAction = null; callRoom = null;
  failures.clear();
  $('details').hidden = true;
  for (const p of people.values()) { clearTimeout(p.grace); clearTimeout(p.repair); p.ui.video.srcObject = null; p.ui.root.remove(); }
  people.clear();
  aliveInCall = new Set();
  roomMembers = [];
  unseen.clear();
  byPeer.clear();
  relaysOut.clear();
  relayAsk.clear();
  clearInterval(timer); clearInterval(relayTimer); clearInterval(healthTimer); clearInterval(speakTimer);
  $('self').classList.remove('speaking');
  try { wakeLock && wakeLock.release(); } catch {}
  wakeLock = null;
  selfReconnecting = false;
  $('tapAudio').hidden = true;
  $('toasts').replaceChildren();
  stopMedia();
  layout();
}

$('cLeave').addEventListener('click', back);
$('aloneInvite').addEventListener('click', () => callRoom && invite(callRoom));
$('topInvite').addEventListener('click', () => callRoom && invite(callRoom));
// Closing or refreshing the page. We can't tell which, so we say "away" rather than "bye":
// the others show "Reconnecting…" briefly, and drop us after AWAY_GRACE_MS unless we are back.
addEventListener('pagehide', () => {
  if (inCall) rememberActive('call');   // keeps the latest mute and camera state for a refresh
  presence.leaveAll();
  try { stateAction && stateAction.send({ n: data.name, m: micOn, c: camOn, s: mySession, away: true }).catch(() => {}); } catch {}
  try { room && room.leave(); } catch {}
});
addEventListener('offline', () => log('NETWORK offline'));
document.addEventListener('visibilitychange', () => { if (inCall) log('APP', document.visibilityState === 'hidden' ? 'in another app' : 'back'); });
addEventListener('online', () => { log('NETWORK online'); if (inCall) { rejoinAt = 0; if (people.size) downSince = Date.now() - DOWN_MS; checkHealth(); } });
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && inCall && !wakeLock) {
    try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch {}
  }
});

function sendState(target) {
  if (!stateAction) return;
  const msg = {
    n: data.name, m: micOn, c: camOn, nt: netType || undefined, v6: netV6 || undefined, ds: saverOn() || undefined, s: mySession,
    hv: !!(local && local.getVideoTracks()[0]),   // we have a camera to send
    ha: !!(local && local.getAudioTracks()[0]),   // we have a microphone to send
    bg: document.visibilityState === 'hidden',    // in another app (iPhone pauses the camera then)
    l: linkedSessions(),                          // who we have a direct connection with
    r: 1                                          // we can pass someone's video along to others
  };
  stateAction.send(msg, target ? { target } : undefined).catch(() => {});
}

function newPerson(key) {
  const p = { key, sess: '', name: '', mic: true, cam: true, stream: null, ui: makeTile(), announced: false,
    net: '', peerId: null, reconnecting: false, leaving: false, grace: 0, repair: 0, since: 0 };
  people.set(key, p);
  $('grid').append(p.ui.root);
  renderTile(p);
  layout();
  return p;
}

function removePerson(p, quietly) {
  clearTimeout(p.grace); clearTimeout(p.repair);
  if (p.sess) endRelaysOf(p.sess);
  if (p.relayVia) stopRelay(p);
  if (p.peerId) byPeer.delete(p.peerId);
  p.ui.video.srcObject = null;
  p.ui.root.remove();
  if (people.get(p.key) === p) people.delete(p.key);
  if (!quietly && p.announced) toast((p.name || 'Someone') + ' left');
  layout();
  tuneBitrate();
}

function markReconnecting(p) {
  if (p.reconnecting) return;   // keep the original deadline
  log('RECONNECTING', who(p), p.away ? '(said: refreshing)' : '');
  if (!p.away) trouble('reconnecting');
  p.reconnecting = true;
  p.since = Date.now();
  renderTile(p);
  clearTimeout(p.grace); clearTimeout(p.repair);
  // Still announcing in the room after a while, but our link to them is gone: repair it.
  // Exactly one side does this (the lower session id), so the two don't keep crossing.
  p.repair = setTimeout(() => {
    if (p.reconnecting && people.get(p.key) === p && aliveInCall.has(p.sess) && mySession < p.sess) rejoin(true, 'link to ' + who(p) + ' did not come back');
  }, REPAIR_MS);
  const decide = () => {
    if (!p.reconnecting || people.get(p.key) !== p) return;
    // Their phone still says "here": keep waiting (and keep repairing), up to a limit.
    if (aliveInCall.has(p.sess) && Date.now() - p.since < MAX_WAIT_MS) {
      if (mySession < p.sess && !rejoining && (p.repairs || 0) < MAX_TRIES) { p.repairs = (p.repairs || 0) + 1; rejoin(true, 'still no link to ' + who(p)); }
      p.grace = setTimeout(decide, RECHECK_MS);
      return;
    }
    log('GAVE UP on', who(p), aliveInCall.has(p.sess) ? '(waited too long)' : '(no longer in the room)');
    removePerson(p, false);
  };
  p.grace = setTimeout(decide, p.away ? AWAY_GRACE_MS : GRACE_MS);
}

function setStream(p, stream) {
  if (p.stream && p.stream !== stream && p.sess) refreshRelaysOf(p.sess, stream);
  p.stream = stream;
  const v = p.ui.video;
  if (v.srcObject !== stream) v.srcObject = stream;
  v.play().catch(() => { $('tapAudio').hidden = false; });
  if (!stream.__watched) {
    stream.__watched = true;
    const changed = () => { if (p.stream === stream && p.ui.video.srcObject === stream) reattach(p.ui.video, stream); renderTile(p); };
    stream.addEventListener('addtrack', changed);
    stream.addEventListener('removetrack', changed);
  }
  renderTile(p);
}

function onPeerJoin(peerId) {
  if (!inCall || byPeer.has(peerId)) return;
  if (TEST_HOOKS && blockedPeers.has(peerId)) { closePeer(peerId); return; }
  const p = newPerson('peer:' + peerId);
  p.peerId = peerId;
  p.linkedAt = Date.now();
  log('LINK UP', 'peer', peerId.slice(0, 6));
  watchLinks();
  byPeer.set(peerId, p);
  if (local) room.addStream(local, { target: peerId }).catch(() => {});
  sendState(peerId);
  setTimeout(() => { if (people.get(p.key) === p && !p.announced) { p.announced = true; toast('Someone joined'); } }, 4000);
  setTimeout(tuneBitrate, 2000);
  setTimeout(tuneBitrate, 7000);
}

function onPeerLeave(peerId) {
  relayerGone(peerId);
  const p = byPeer.get(peerId);
  log('LINK DOWN', p ? who(p) : 'peer ' + peerId.slice(0, 6), p && p.leaving ? '(said bye)' : '', lastState.get(peerId) || '');
  byPeer.delete(peerId);
  if (p && p.sess) endRelaysOf(p.sess);
  if (!p || p.peerId !== peerId) return;   // already back on a newer connection
  p.peerId = null;
  if (p.leaving || !p.sess) removePerson(p, false);   // said goodbye, or an older version
  else markReconnecting(p);
}

function onPeerStream(peerId, stream) {
  if (!byPeer.has(peerId)) onPeerJoin(peerId);
  const p = byPeer.get(peerId);
  if (p) setStream(p, stream);
}

function onPeerState(peerId, msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.n !== 'string') return;
  if (TEST_HOOKS && window.__block && msg.n === window.__block) { blockPeer(peerId); return; }
  if (!byPeer.has(peerId)) onPeerJoin(peerId);
  let p = byPeer.get(peerId);
  if (!p) return;
  const sess = typeof msg.s === 'string' && /^[0-9a-f]{8,32}$/.test(msg.s) ? msg.s : '';
  if (sess && p.key !== sess) {
    const known = people.get(sess);
    if (known && known !== p) {
      // The same person on a new connection: keep their tile, drop the temporary one.
      if (known.peerId && known.peerId !== peerId) byPeer.delete(known.peerId);
      if (known.relayVia) stopRelay(known);   // a direct connection now: no need to pass it along
      log('BACK', who(known), 'on a new link', known.reconnecting ? `after ${Math.round((Date.now() - known.since) / 1000)} s` : '');
      known.peerId = peerId;
      known.linkedAt = Date.now();
      known.rx = null; known.starvedSince = 0; known.asks = 0;
      byPeer.set(peerId, known);
      const stream = p.stream;
      p.peerId = null;
      removePerson(p, true);
      if (stream) setStream(known, stream);
      p = known;
    } else {
      people.delete(p.key);
      p.key = sess;
      people.set(sess, p);
    }
    p.sess = sess;
  }
  if (p.reconnecting) { p.reconnecting = false; clearTimeout(p.grace); clearTimeout(p.repair); }
  applyState(p, msg);
  if (Array.isArray(msg.l)) p.links = new Set(msg.l.filter(x => typeof x === 'string' && /^[0-9a-f]{8,32}$/.test(x)).slice(0, MAX_PEOPLE));
  p.canRelay = msg.r === 1;
  forwardState(p);
  if (!p.announced && !p.leaving) { p.announced = true; toast(p.name + ' joined'); }
  renderTile(p);
  layout();
}

// Name, microphone, camera and so on, from a state message (direct, or passed along).
function applyState(p, msg) {
  p.name = clean(msg.n).slice(0, 30) || 'Someone';
  p.mic = msg.m !== false;
  p.cam = msg.c !== false;
  p.leaving = msg.bye === true;
  p.away = msg.away === true;
  if (typeof msg.nt === 'string' && Object.prototype.hasOwnProperty.call(NET_LABEL, msg.nt)) p.net = msg.nt;
  p.hasVideo = msg.hv !== false;
  p.hasAudio = msg.ha !== false;
  p.bg = msg.bg === true;
  p.v6 = msg.v6 === true;
  const ds = msg.ds === true;
  if (ds !== !!p.ds) { p.ds = ds; setTimeout(tuneBitrate, 0); }
}

// Media watchdog: a connection can be up while someone's video or sound never arrives (or
// stops). If nothing comes in for a while from someone who is sending it, ask them to send
// their camera and microphone to us again. Spaced out and limited, so it never loops.
const STARVED_MS = 6000;
const ASK_GAP_MS = 12000;
let mediaBusy = false;

async function watchMedia() {
  if (mediaBusy || !room) return;
  mediaBusy = true;
  try {
    let all = {};
    try { all = room.getPeers(); } catch {}
    const now = Date.now();
    for (const p of people.values()) {
      const pc = p.peerId && all[p.peerId] && all[p.peerId].connection;
      if (!pc || pc.connectionState !== 'connected' || p.reconnecting) { p.starvedSince = 0; continue; }
      // A video that the browser paused (sound blocked until a tap) would look black and silent.
      if (p.ui.video.paused && p.ui.video.srcObject) p.ui.video.play().catch(() => { $('tapAudio').hidden = false; });
      if (now - (p.linkedAt || 0) < STARVED_MS) continue;
      const rx = { v: 0, a: 0, d: 0 };
      (await pc.getStats()).forEach(s => {
        if (s.type === 'inbound-rtp' && s.kind === 'video') { rx.v += s.bytesReceived || 0; rx.d += s.framesDecoded || 0; }
        if (s.type === 'inbound-rtp' && s.kind === 'audio') rx.a += s.bytesReceived || 0;
      });
      const prev = p.rx || { v: -1, a: -1, d: -1 };
      p.rx = rx;
      checkShown(p, rx.d > prev.d && prev.d >= 0, now);
      const videoStuck = p.hasVideo !== false && p.cam && rx.v <= prev.v;
      const audioStuck = p.hasAudio !== false && rx.a <= prev.a;   // sound keeps flowing even when muted
      // Their app is in the background and its camera paused (iPhone): show that, don't ask.
      const stalled = videoStuck && prev.v >= 0;
      if (stalled !== !!p.videoStalled) { p.videoStalled = stalled; renderTile(p); }
      if (p.bg) { p.starvedSince = 0; continue; }
      if (!videoStuck && !audioStuck) { p.starvedSince = 0; p.asks = 0; continue; }
      p.starvedSince = p.starvedSince || now;
      if (now - p.starvedSince < STARVED_MS || now - (p.askedAt || 0) < ASK_GAP_MS || (p.asks || 0) >= 3) continue;
      p.askedAt = now;
      p.asks = (p.asks || 0) + 1;
      if (resendAction) resendAction.send({ k: 1 }, { target: p.peerId }).catch(() => {});
      const v = p.ui.video;
      if (v.paused && v.srcObject) v.play().catch(() => { $('tapAudio').hidden = false; });
    }
  } catch {} finally {
    mediaBusy = false;
  }
}

// Video arrives and is decoded, but the element puts nothing on screen: show it again.
const SHOWN_STUCK_CHECKS = 2;   // consecutive health checks (2 s apart)
function checkShown(p, decoding, now) {
  const v = p.ui.video;
  const shown = v.__shown || 0;
  const prevShown = p.shownAt;
  p.shownAt = shown;
  const watchable = v.requestVideoFrameCallback && document.visibilityState === 'visible' &&
    p.stream && v.srcObject === p.stream && p.ui.ph.hidden && v.offsetWidth > 0;
  if (!watchable || !decoding || prevShown == null || shown > prevShown) { p.shownStuck = 0; return; }
  if (++p.shownStuck < SHOWN_STUCK_CHECKS || now - (p.reattachedAt || 0) < 10000) return;
  p.shownStuck = 0;
  p.reattachedAt = now;
  log('REDRAW', who(p), '(video arriving but not shown)');
  reattach(v, p.stream);
}

// Our own side: a camera or microphone added to a connection that the connection library
// never offered to the other side (it can skip an update that comes in while it is busy
// finishing the previous one). Offer it again; the other side then gets it within a second.
const UNOFFERED_MS = 3000;
function checkOffered() {
  let all = {};
  try { all = room ? room.getPeers() : {}; } catch {}
  const now = Date.now();
  for (const info of Object.values(all)) {
    const pc = info && info.connection;
    if (!pc || pc.connectionState !== 'connected' || pc.signalingState !== 'stable' || !pc.getTransceivers) continue;
    const pending = pc.getTransceivers().some(t => !t.stopped && t.sender.track &&
      /send/.test(t.direction) && !/send/.test(t.currentDirection || ''));
    if (!pending) { pc.__pendingSince = 0; continue; }
    pc.__pendingSince = pc.__pendingSince || now;
    if (now - pc.__pendingSince < UNOFFERED_MS || now - (pc.__offeredAt || 0) < UNOFFERED_MS) continue;
    pc.__offeredAt = now;
    log('RE-OFFER our media (an update was skipped)');
    try { pc.onnegotiationneeded && pc.onnegotiationneeded(new Event('negotiationneeded')); } catch {}
  }
}

// Someone isn't getting our camera or microphone: send them again, to that person only.
const lastResend = new Map();
async function resendTo(peerId) {
  log('RESEND our media to', who(byPeer.get(peerId)), '(they asked)');
  if (!room || !local) return;
  if (Date.now() - (lastResend.get(peerId) || 0) < 5000) return;
  lastResend.set(peerId, Date.now());
  try { room.removeStream(local, { target: peerId }); } catch {}
  try { await room.addStream(local, { target: peerId }); } catch {}
  setTimeout(tuneBitrate, 1500);
}

// Our own connection. The connection library repairs a single broken link by itself within
// a few seconds. If every link stays dead longer than that (switched wifi to mobile data,
// lost signal for a while), quietly join the room again from scratch.
// "disconnected" is often a short dropout on mobile networks that the browser recovers from
// by itself; it only counts as down once it has lasted WOBBLE_MS (the connection library
// waits 25 s too, and browsers declare a dead link failed after about 30 s).
const WOBBLE_MS = 20000;
const wobblingSince = new Map();
function linkStates() {
  let all = {};
  try { all = room ? room.getPeers() : {}; } catch {}
  const now = Date.now();
  return [...byPeer.keys()].map(id => {
    const pc = all[id] && all[id].connection;
    if (!pc) return 'gone';
    const st = pc.connectionState;
    if (st !== 'disconnected' && pc.iceConnectionState !== 'disconnected') { wobblingSince.delete(id); return st; }
    if (!wobblingSince.has(id)) wobblingSince.set(id, now);
    return now - wobblingSince.get(id) >= WOBBLE_MS ? 'disconnected' : 'wobbling';
  });
}

// Every connection's states as they change, and how it is connected once it is.
const lastState = new Map();
function watchLinks() {
  let all = {};
  try { all = room ? room.getPeers() : {}; } catch {}
  for (const [id, info] of Object.entries(all)) {
    const pc = info && info.connection;
    if (!pc) continue;
    if (!pc.__watched) {
      pc.__watched = true;
      for (const ev of ['connectionstatechange', 'iceconnectionstatechange', 'signalingstatechange']) pc.addEventListener(ev, () => { if (inCall) watchLinks(); });
    }
    const st = `${pc.connectionState}/${pc.iceConnectionState}/${pc.signalingState}`;
    const p = byPeer.get(id);
    const weak = pc.connectionState === 'disconnected' || pc.iceConnectionState === 'disconnected';
    if (p && !!p.weak !== weak) { p.weak = weak; renderTile(p); log(weak ? 'WEAK' : 'STEADY', who(p)); }
    if (lastState.get(id) === st) continue;
    const before = lastState.get(id);
    lastState.set(id, st);
    log('STATE', who(byPeer.get(id)) === '?' ? 'peer ' + id.slice(0, 6) : who(byPeer.get(id)), before ? before + ' -> ' + st : st);
    if (pc.connectionState === 'connected') describeLink(id, pc);
  }
  for (const id of [...lastState.keys()]) if (!all[id]) lastState.delete(id);
}
async function describeLink(id, pc) {
  try {
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach(s => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId); });
    if (!pair) stats.forEach(s => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = pair || s; });
    if (!pair) return;
    const l = stats.get(pair.localCandidateId) || {}, r = stats.get(pair.remoteCandidateId) || {};
    const rtt = pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) + ' ms' : '?';
    const path = `${l.candidateType || '?'}/${l.protocol || '?'}${l.networkType ? '/' + l.networkType : ''} -> ${r.candidateType || '?'}/${r.protocol || '?'}`;
    const p = byPeer.get(id);
    if (p) p.path = path + ', rtt ' + rtt;
    log('PATH', who(p), path, 'rtt', rtt);
  } catch {}
}

function checkHealth() {
  if (!inCall || !room || rejoining) return;
  watchLinks();
  watchMedia();
  checkOffered();
  recoverLocalTracks(false);
  checkUnseen();
  checkRelays();
  renderDetails();   // keeps the connection details current while they are open
  const states = linkStates();
  const anyUp = states.some(s => s === 'connected');
  const allDown = people.size > 0 && states.every(s => s === 'disconnected' || s === 'failed' || s === 'closed' || s === 'gone');
  if (anyUp || !people.size) {
    downSince = 0;
    if (![...people.values()].some(p => p.reconnecting)) rejoins = 0;
    if (selfReconnecting && (anyUp || !people.size)) { selfReconnecting = false; rejoins = 0; if (anyUp) toast('Reconnected'); updateMeta(); }
    return;
  }
  if (!allDown) { downSince = 0; return; }
  if (!downSince) downSince = Date.now();
  if (Date.now() - downSince >= DOWN_MS && Date.now() >= rejoinAt) rejoin(false, 'links: ' + states.join(','));
}

// repairing: we are fine, but a link to someone still in the room could not come back.
async function rejoin(repairing, why = '') {
  if (!inCall || rejoining) return;
  if (repairing && Date.now() < rejoinAt) return;
  log('REJOIN', repairing ? '(repair)' : '(all links down)', why, `#${rejoins + 1}`);
  rejoining = true;
  rejoins++;
  if (!repairing && !selfReconnecting) { selfReconnecting = true; toast('Connection lost. Reconnecting…', 4000); }
  updateMeta();
  const old = room;
  room = null; stateAction = null;
  relaysOut.clear();
  for (const p of [...people.values()]) {
    if (p.peerId) byPeer.delete(p.peerId);
    p.peerId = null;
    p.relayVia = null;
    if (p.sess) markReconnecting(p); else removePerson(p, true);   // older versions rejoin as new tiles
  }
  byPeer.clear();
  try { await old.leave(); } catch {}
  if (inCall) joinCallRoom();
  downSince = 0;
  rejoinAt = Date.now() + Math.min(30000, REJOIN_GAP_MS * rejoins);
  rejoining = false;
}

// Who is talking: outline their tile. Uses the audio energy the browser already measures
// for every incoming voice stream, averaged since the last check, so short words between
// checks still count and nothing extra is sent or processed.
const SPEAK_LEVEL = 0.02;        // average level about -34 dB: speech, not room noise
const SPEAK_HOLD_MS = 700;       // keep the outline through short pauses between words
let selfSpokeAt = 0, selfEnergy = null, speakBusy = false;

// Average level since the previous reading, from cumulative energy and duration.
function levelSince(prev, energy, duration) {
  if (!prev || duration <= prev.d) return 0;
  return Math.sqrt(Math.max(0, energy - prev.e) / (duration - prev.d));
}

async function watchSpeaking() {
  if (!inCall || !room || speakBusy) return;
  speakBusy = true;
  try {
    let all = {};
    try { all = room.getPeers(); } catch {}
    const now = Date.now();
    let selfPc = null;
    // Every incoming voice, by track (a connection can carry someone passed along, too).
    const byTrack = new Map(), byLink = new Map();
    for (const [id, info] of Object.entries(all)) {
      const pc = info && info.connection;
      if (!pc || pc.connectionState !== 'connected') continue;
      selfPc = selfPc || pc;
      const sum = { e: 0, d: 0 };
      (await pc.getStats()).forEach(s => {
        if (s.type !== 'inbound-rtp' || s.kind !== 'audio' || s.totalSamplesDuration == null) return;
        const v = { e: s.totalAudioEnergy || 0, d: s.totalSamplesDuration };
        if (s.trackIdentifier) byTrack.set(s.trackIdentifier, v);
        sum.e += v.e; sum.d += v.d;
      });
      byLink.set(id, sum);
    }
    for (const p of people.values()) {
      let e = 0, d = 0, found = false;
      for (const t of p.stream ? p.stream.getAudioTracks() : []) {
        const v = byTrack.get(t.id);
        if (v) { e += v.e; d += v.d; found = true; }
      }
      if (!found && p.peerId && byLink.has(p.peerId) && !relayedThrough(p.peerId)) { const v = byLink.get(p.peerId); e = v.e; d = v.d; found = v.d > 0; }
      if (!found) continue;
      const level = levelSince(p.energy, e, d);
      p.energy = { e, d };
      if (level > SPEAK_LEVEL && p.mic && !p.reconnecting) p.spokeAt = now;
    }
    for (const p of people.values()) {
      const speaking = p.mic && !p.reconnecting && now - (p.spokeAt || 0) < SPEAK_HOLD_MS;
      if (speaking !== !!p.speaking) { p.speaking = speaking; p.ui.root.classList.toggle('speaking', speaking); }
    }
    // Ourselves: what our microphone picks up, only while unmuted and with someone to hear it.
    if (selfPc && micOn) {
      let e = 0, d = 0, found = false;
      (await selfPc.getStats()).forEach(s => {
        if (s.type === 'media-source' && s.kind === 'audio' && s.totalSamplesDuration != null) { e = s.totalAudioEnergy || 0; d = s.totalSamplesDuration; found = true; }
      });
      if (found) {
        if (levelSince(selfEnergy, e, d) > SPEAK_LEVEL) selfSpokeAt = Date.now();
        selfEnergy = { e, d };
      }
    } else selfEnergy = null;
    const selfTalking = inCall && micOn && people.size > 0 && Date.now() - selfSpokeAt < SPEAK_HOLD_MS;
    $('self').classList.toggle('speaking', selfTalking);
    if (swapped) swapped.me.classList.toggle('speaking', selfTalking);
    updateFloat();
  } catch {} finally {
    speakBusy = false;
  }
}

// Someone's phone says they are in this room, but we have no connection to them at all,
// e.g. we missed their arrival, or our side of the introductions went quiet. Rejoin to pick
// them up (the lower session first, the other side later, a couple of times at most); if
// that doesn't work, it is the networks, so say so once and list them in the details.
function checkUnseen() {
  if (!inCall || rejoining) return;
  const now = Date.now();
  const linked = new Set([...people.values()].map(p => p.sess).filter(Boolean));
  const here = new Map(roomMembers.filter(m => m.cs && m.cs !== mySession).map(m => [m.cs, m.name]));
  let gone = false;
  for (const cs of [...unseen.keys()]) if (!here.has(cs) || linked.has(cs)) { unseen.delete(cs); gone = true; }
  if (gone) renderDetails();
  for (const [cs, name] of here) {
    if (linked.has(cs)) continue;
    let u = unseen.get(cs);
    if (!u) { u = { name, first: now, since: now, tries: 0, told: false }; unseen.set(cs, u); }
    u.name = name;
    // Still not connected after a while: say so once (retries may still pick them up).
    if (!u.told && now - u.first >= UNSEEN_MS * 2) {
      u.told = true;
      log('CANNOT CONNECT to', name, '-', netType || 'network unknown');
      trouble('cannot connect', true);
      toast(`${name} is in the room but can't connect to you. ${failureReason()}`, 8000);
      renderDetails();
    }
    const wait = mySession < cs ? UNSEEN_MS : UNSEEN_MS * 2;
    if (now - u.since < wait) continue;
    if (u.tries < MAX_TRIES && now >= rejoinAt) {
      u.tries++;
      u.since = now;
      rejoin(true, `${name} in the room but not connected (try ${u.tries})`);
      return;
    }
  }
}

/* Passing video along. When two people in a call can't connect directly (both on networks
   that block it) but both are connected to a third person, that person's phone passes each
   one's video and sound to the other. Nobody sees anything they wouldn't see in the call
   anyway, and there is still no server: it's one of the people in the call. */

const RELAY_AFTER_MS = 15000;    // in the room but not connected this long: ask someone to pass them along
const RELAY_WAIT_MS = 12000;     // asked, but nothing came this long: ask someone else
const MAX_RELAYS_OUT = 2;        // pass along at most this many video streams (it costs the phone)
const relaysOut = new Map();     // `${peerId}|${session}` -> { peerId, sess, stream }: we pass sess along to peerId
const relayAsk = new Map();      // session -> { since, via, at, tried }: someone we'd like passed along to us

const relayedThrough = peerId => [...people.values()].some(p => p.relayVia === peerId);

function linkedSessions() {
  return [...people.values()].filter(p => p.peerId && p.sess && !p.reconnecting).map(p => p.sess);
}

// We were asked to pass someone along (or to stop).
function onRelayAsk(peerId, msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.s !== 'string') return;
  const key = peerId + '|' + msg.s;
  if (msg.on !== true) { endRelayOut(key, false); return; }
  const them = people.get(msg.s), asker = byPeer.get(peerId);
  if (!them || !them.peerId || !them.stream || !asker || them === asker || !room) return;
  if (relaysOut.has(key) || relaysOut.size >= MAX_RELAYS_OUT) return;
  relaysOut.set(key, { peerId, sess: msg.s, stream: them.stream });
  room.addStream(them.stream, { target: peerId, metadata: { via: msg.s } }).catch(() => {});
  relayStateAction.send(relayedState(them), { target: peerId }).catch(() => {});
  setTimeout(tuneBitrate, 1500);
}

function relayedState(p) {
  return { s: p.sess, n: p.name, m: p.mic, c: p.cam, hv: p.hasVideo !== false, ha: p.hasAudio !== false, bg: !!p.bg };
}
function forwardState(p) {
  if (!p.sess || !relayStateAction) return;
  for (const r of relaysOut.values()) if (r.sess === p.sess) relayStateAction.send(relayedState(p), { target: r.peerId }).catch(() => {});
}
function endRelayOut(key, tell) {
  const r = relaysOut.get(key);
  if (!r) return;
  relaysOut.delete(key);
  try { room && room.removeStream(r.stream, { target: r.peerId }); } catch {}
  if (tell && relayStateAction) relayStateAction.send({ s: r.sess, gone: true }, { target: r.peerId }).catch(() => {});
}
function endRelaysOf(sess) {
  for (const [key, r] of [...relaysOut]) if (r.sess === sess) endRelayOut(key, true);
}
function refreshRelaysOf(sess, stream) {
  for (const r of relaysOut.values()) {
    if (r.sess !== sess || r.stream === stream) continue;
    try { room.removeStream(r.stream, { target: r.peerId }); } catch {}
    r.stream = stream;
    room.addStream(stream, { target: r.peerId, metadata: { via: sess } }).catch(() => {});
  }
}

// Someone is in the room but we have no connection to them: ask a person connected to both
// of us to pass them along. One at a time, a few seconds each, then the next.
function checkRelays() {
  if (!inCall || rejoining || !relayAction) return;
  const now = Date.now();
  for (const m of roomMembers) {
    if (!m.cs || m.cs === mySession) continue;
    const p = people.get(m.cs);
    if (p && p.peerId) { if (relayAsk.has(m.cs)) relayAsk.delete(m.cs); continue; }
    let ask = relayAsk.get(m.cs);
    if (!ask) { ask = { since: now, via: null, at: 0, tried: new Set() }; relayAsk.set(m.cs, ask); }
    if (p && p.relayVia) {
      // Passed along, but nothing comes any more (the helper stopped, or lost them): ask again.
      const alive = p.stream && p.stream.getTracks().some(t => t.readyState === 'live' && !t.muted);
      if (alive) { p.relayDeadSince = 0; continue; }
      p.relayDeadSince = p.relayDeadSince || now;
      if (now - p.relayDeadSince < 4000) continue;
      p.relayDeadSince = 0;
      const via = p.relayVia;
      relayEnded(p);
      relayAction.send({ s: m.cs, on: false }, { target: via }).catch(() => {});
      continue;
    }
    if (ask.via) {
      if (now - ask.at < RELAY_WAIT_MS) continue;
      ask.tried.add(ask.via);
      relayAction.send({ s: m.cs, on: false }, { target: ask.via }).catch(() => {});
      ask.via = null;
    }
    if (now - ask.since < RELAY_AFTER_MS || now < (ask.next || 0)) continue;
    const helpers = [...people.values()].filter(h => h.peerId && !h.reconnecting && h.canRelay && h.links && h.links.has(m.cs));
    let helper = helpers.find(h => !ask.tried.has(h.peerId));
    // Everyone was tried: start over after a pause (their own connections may have settled).
    if (!helper && helpers.length && now - ask.at >= RELAY_WAIT_MS) { ask.tried.clear(); helper = helpers[0]; }
    if (!helper) continue;
    ask.via = helper.peerId;
    ask.at = now;
    relayAction.send({ s: m.cs, on: true }, { target: helper.peerId }).catch(() => {});
  }
  for (const cs of [...relayAsk.keys()]) if (!roomMembers.some(m => m.cs === cs)) relayAsk.delete(cs);
}

function onRelayedStream(peerId, sess, stream) {
  const ask = relayAsk.get(sess);
  if (!ask || ask.via !== peerId || !/^[0-9a-f]{8,32}$/.test(sess)) return;   // only what we asked for
  let p = people.get(sess);
  if (p && p.peerId) return;            // connected directly in the meantime
  if (!p) {
    p = newPerson(sess);
    p.sess = sess;
    const m = roomMembers.find(x => x.cs === sess);
    p.name = m ? clean(m.name).slice(0, 30) : 'Someone';
  }
  p.relayVia = peerId;
  if (p.reconnecting) { p.reconnecting = false; clearTimeout(p.grace); clearTimeout(p.repair); }
  setStream(p, stream);
  const helper = byPeer.get(peerId);
  if (!p.relayTold) {
    p.relayTold = true;
    toast(`${p.name} can't connect to you directly, so ${helper && helper.name ? helper.name + '\'s' : 'another'} phone passes them along`, 6000);
  }
  p.announced = true;
  renderTile(p);
  layout();
}

function onRelayState(peerId, msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.s !== 'string') return;
  const p = people.get(msg.s);
  if (!p || p.relayVia !== peerId || p.peerId) return;
  if (msg.gone) { relayEnded(p); return; }
  if (typeof msg.n !== 'string') return;
  applyState(p, msg);
  renderTile(p);
}

function stopRelay(p) {
  const via = p.relayVia;
  p.relayVia = null;
  relayAsk.delete(p.sess);
  if (via && relayAction) relayAction.send({ s: p.sess, on: false }, { target: via }).catch(() => {});
}
function relayEnded(p) {
  const ask = relayAsk.get(p.sess);
  if (ask) { ask.via = null; ask.next = Date.now() + 2000; }   // ask again shortly (them or someone else)
  p.relayVia = null;
  if (!p.peerId) { if (p.sess) markReconnecting(p); else removePerson(p, true); }
}
// The person passing others along to us left or dropped.
function relayerGone(peerId) {
  for (const p of [...people.values()]) if (p.relayVia === peerId) relayEnded(p);
  for (const [key, r] of [...relaysOut]) if (r.peerId === peerId) endRelayOut(key, false);
}

// Test builds only: refuse a direct connection with someone, as two blocking networks would.
const blockedPeers = new Set();
if (TEST_HOOKS) window.__debugRelay = () => JSON.stringify({
  people: [...people.values()].map(p => ({ n: p.name, s: p.sess.slice(0, 6), peer: !!p.peerId, via: !!p.relayVia, rec: p.reconnecting, links: p.links ? [...p.links].map(x => x.slice(0, 6)) : null, canRelay: p.canRelay })),
  members: roomMembers.map(m => m.name + ':' + (m.cs || '').slice(0, 6)),
  ask: [...relayAsk].map(([k, v]) => ({ s: k.slice(0, 6), via: !!v.via, tried: v.tried.size, age: Date.now() - v.since })),
  out: [...relaysOut.values()].map(r => r.sess.slice(0, 6)), me: mySession.slice(0, 6), blocked: blockedPeers.size
});
function closePeer(peerId) {
  try { const info = room && room.getPeers()[peerId]; info && info.connection && info.connection.close(); } catch {}
}
function blockPeer(peerId) {
  blockedPeers.add(peerId);
  const p = byPeer.get(peerId);
  if (p) { p.peerId = null; byPeer.delete(peerId); removePerson(p, true); }
  closePeer(peerId);
}

function onRoomError(err) {
  log('ROOM ERROR', String((err && (err.error || err.message)) || err).slice(0, 120));
  if (!inCall || !err) return;
  if (err.code === 'room-full' && people.size === 0) {
    toast(`This room is full (${MAX_PEOPLE} people at most)`);
  } else if (err.code === 'peer-connect-failed') {
    const key = err.peerId || String(Date.now());
    if (failures.has(key)) return;
    const why = failureReason();
    failures.set(key, why);
    toast('Someone could not connect. ' + why, 7000);
    renderDetails();
  }
}

$('tapAudio').addEventListener('click', () => {
  $('tapAudio').hidden = true;
  for (const p of people.values()) p.ui.video.play().catch(() => {});
});

/* tiles */

// Frames this video element actually put on screen (not just received and decoded).
function countShownFrames(video) {
  video.__shown = 0;
  if (!video.requestVideoFrameCallback) return;
  const tick = () => { video.__shown++; video.requestVideoFrameCallback(tick); };
  video.requestVideoFrameCallback(tick);
}

// Point a video element at a stream again from scratch (Safari can keep showing black for a
// track that was added to a stream it is already playing).
function reattach(v, stream) {
  v.srcObject = null;
  v.srcObject = stream;
  v.play().catch(() => { $('tapAudio').hidden = false; });
}

function makeTile() {
  const root = el('div', 'tile');
  const video = el('video');
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  countShownFrames(video);
  const ph = el('div', 'ph');
  const avatar = el('div', 'avatar');
  const status = el('div', 'ph-status');
  ph.append(avatar, status);
  const tag = el('div', 'tag');
  const name = el('span');
  tag.append(icon('mic-off'), name);
  const weak = el('div', 'weak-badge', 'Weak connection');
  weak.hidden = true;
  root.append(video, ph, tag, weak);
  root.addEventListener('click', () => { if (root.classList.contains('as-pip')) unswap(); });
  // Double tap: switch between filling the tile and showing the whole picture.
  let last = 0;
  root.addEventListener('pointerup', () => {
    const now = Date.now();
    if (now - last < 320) { root.classList.toggle('fit'); last = 0; } else last = now;
  });
  return { root, video, ph, avatar, status, name, weak };
}

function renderTile(p) {
  const vt = p.stream && p.stream.getVideoTracks()[0];
  const away = p.bg && p.videoStalled;   // in another app and its camera paused
  const showVideo = !!(vt && p.cam) && !p.reconnecting && !away;
  p.ui.ph.hidden = showVideo;
  p.ui.avatar.textContent = (p.name || '?').charAt(0).toUpperCase();
  p.ui.status.textContent = p.reconnecting ? 'Reconnecting…' : !p.stream ? 'Connecting…'
    : away ? 'In another app' : (!p.cam || !vt ? 'Camera off' : '');
  p.ui.name.textContent = p.name || '…';
  p.ui.root.classList.toggle('muted', !p.mic);
  p.ui.root.classList.toggle('reconnecting', p.reconnecting);
  p.ui.weak.hidden = !(p.weak && !p.reconnecting && p.peerId);
  if (inCall) updateFloat();
}

function layout() {
  const n = people.size;
  if (swapped && n !== swapped.count) unswap();   // someone joined or left: back to the normal view
  $('grid').dataset.n = String(Math.min(n, 5));
  $('self').classList.toggle('full', n === 0);
  $('alone').hidden = n > 0 || !inCall;
  if (inCall) { updateFloat(); refreshZoom(); }
  floatVideo.style.visibility = n || isFloating() ? '' : 'hidden';   // tucked behind the first tile
  updateMeta();
  renderDetails();
}

/* swap: tap your own small video to swap it with the big one, tap again to swap back */

let swapped = null;   // { me: your tile in the grid, other: their tile shown small, count }

function swapView() {
  if (!inCall || !people.size) return;
  if (swapped) { unswap(); return; }
  const grid = $('grid');
  const other = grid.firstElementChild;   // the biggest tile
  if (!other) return;
  const me = el('div', 'tile me');
  const tag = el('div', 'tag');
  tag.append(icon('mic-off'), el('span', '', 'You'));
  me.classList.toggle('muted', !micOn);
  grid.insertBefore(me, other);
  me.append($('self'), tag);              // the live video moves and keeps playing
  other.classList.add('as-pip');
  $('call').insertBefore(other, $('alone'));
  swapped = { me, other, count: people.size };
  $('call').classList.add('swapped');
}

function unswap() {
  if (!swapped) return;
  const { me, other } = swapped;
  swapped = null;
  $('call').classList.remove('swapped');
  other.classList.remove('as-pip');
  const stillHere = [...people.values()].some(p => p.ui.root === other);
  if (stillHere) $('grid').insertBefore(other, me.parentNode === $('grid') ? me : $('grid').firstElementChild);
  else other.remove();
  $('call').insertBefore($('self'), $('alone'));
  me.remove();
}

$('self').addEventListener('click', swapView);

/* Camera zoom, like FaceTime and the iPhone camera: a button above the bar shows the zoom
   (1×); tapping it opens a wheel to turn with one finger, with the usual stops (1×, 2×, 5×…)
   to tap. It zooms the camera itself, so the others see it too. Only where the camera can
   zoom (phones; most laptop cameras can't), always within the range the camera reports. */
const ZOOM_DEG = 22;          // degrees of wheel per doubling of the zoom
const ZOOM_R = 420;           // radius of the wheel, in its own units
const zoomState = { min: 1, max: 1, step: 0.1, value: 1, track: null, pending: 0, hideAt: 0 };
const zoomAngle = z => ZOOM_DEG * Math.log2(z / zoomState.min);
const zoomFromAngle = a => zoomState.min * Math.pow(2, a / ZOOM_DEG);
const fmtZoom = z => (Math.abs(z - Math.round(z)) < 0.05 ? String(Math.round(z)) : z.toFixed(1)) + '×';

function refreshZoom() {
  const t = local && local.getVideoTracks()[0];
  let caps = null;
  try { caps = t && t.getCapabilities ? t.getCapabilities() : null; } catch {}
  const z = caps && caps.zoom;
  const ok = !!(inCall && camOn && t && t.readyState === 'live' && z && z.max > z.min);
  $('zoomCtl').hidden = !ok;
  if (!ok) { $('zoomDial').hidden = true; return; }
  if (zoomState.track === t) return;
  zoomState.track = t;
  zoomState.min = z.min; zoomState.max = z.max; zoomState.step = z.step || 0.1;
  let now = z.min;
  try { now = t.getSettings().zoom || z.min; } catch {}
  zoomState.value = Math.min(z.max, Math.max(z.min, now));
  drawZoomArc();
  showZoom();
}
function drawZoomArc() {
  const svg = $('zoomArc');
  const ns = 'http://www.w3.org/2000/svg';
  const g = document.createElementNS(ns, 'g');
  g.id = 'zoomTicks';
  const at = (a, r) => [r * Math.sin(a * Math.PI / 180), ZOOM_R - r * Math.cos(a * Math.PI / 180)];
  const end = zoomAngle(zoomState.max);
  for (let a = 0; a <= end + 0.01; a += ZOOM_DEG / 8) {
    const [x1, y1] = at(a, ZOOM_R), [x2, y2] = at(a, ZOOM_R - 7);
    const l = document.createElementNS(ns, 'line');
    l.setAttribute('x1', x1); l.setAttribute('y1', y1); l.setAttribute('x2', x2); l.setAttribute('y2', y2);
    g.append(l);
  }
  for (const stop of [0.5, 1, 2, 3, 5, 10, 15, 20]) {
    if (stop < zoomState.min - 1e-6 || stop > zoomState.max + 1e-6) continue;
    const a = zoomAngle(stop);
    const [x1, y1] = at(a, ZOOM_R), [x2, y2] = at(a, ZOOM_R - 12);
    const l = document.createElementNS(ns, 'line');
    l.setAttribute('class', 'big');
    l.setAttribute('x1', x1); l.setAttribute('y1', y1); l.setAttribute('x2', x2); l.setAttribute('y2', y2);
    const [tx, ty] = at(a, ZOOM_R - 28);
    const tl = document.createElementNS(ns, 'text');
    tl.setAttribute('x', tx); tl.setAttribute('y', ty + 4);
    tl.setAttribute('transform', `rotate(${a} ${tx} ${ty})`);
    tl.textContent = fmtZoom(stop);
    tl.addEventListener('click', e => { e.stopPropagation(); setZoom(stop); });
    g.append(l, tl);
  }
  svg.replaceChildren(g);
}
function showZoom() {
  $('zoomBtn').textContent = fmtZoom(zoomState.value);
  const g = $('zoomTicks');
  if (g) g.setAttribute('transform', `rotate(${-zoomAngle(zoomState.value)} 0 ${ZOOM_R})`);
}
function setZoom(z) {
  zoomState.value = Math.min(zoomState.max, Math.max(zoomState.min, Math.round(z / zoomState.step) * zoomState.step));
  showZoom();
  keepZoomOpen();
  if (zoomState.pending) return;
  zoomState.pending = setTimeout(() => {
    zoomState.pending = 0;
    const t = zoomState.track;
    // Never outside the reported range (an out-of-range zoom has crashed Safari's camera).
    const v = Math.min(zoomState.max, Math.max(zoomState.min, zoomState.value));
    if (t && t.readyState === 'live') t.applyConstraints({ advanced: [{ zoom: v }] }).catch(() => {});
  }, 80);
}
function keepZoomOpen() { zoomState.hideAt = Date.now() + 3500; }
setInterval(() => { if (!$('zoomDial').hidden && Date.now() > zoomState.hideAt) $('zoomDial').hidden = true; }, 500);
$('zoomBtn').addEventListener('click', () => {
  const d = $('zoomDial');
  d.hidden = !d.hidden;
  if (!d.hidden) { keepZoomOpen(); showZoom(); }
});
{
  // Turning the wheel: the ticks follow the finger.
  let drag = null;
  const dial = $('zoomDial');
  dial.addEventListener('pointerdown', e => {
    if (e.target.tagName === 'text') return;
    drag = { x: e.clientX, a: zoomAngle(zoomState.value), scale: 340 / dial.clientWidth };
    try { dial.setPointerCapture(e.pointerId); } catch {}
    keepZoomOpen();
  });
  dial.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = (e.clientX - drag.x) * drag.scale;            // in the wheel's own units
    setZoom(zoomFromAngle(drag.a - dx * 180 / (Math.PI * ZOOM_R)));
  });
  const stop = () => { drag = null; };
  dial.addEventListener('pointerup', stop);
  dial.addEventListener('pointercancel', stop);
}

/* floating video (picture-in-picture): the person talking, in a small window that stays over
   other apps, like FaceTime. One video element is kept playing for it during the call (iOS
   only floats a video that is already playing); it shows whoever is talking, switching
   calmly, and a card with their initial when their camera is off. */

const FLOAT_SWITCH_MS = 1500;    // show someone at least this long before switching to another talker
const floatVideo = $('floatVideo');
let floatTarget = null, floatSince = 0;

const canFloat = () => !!(floatVideo.requestPictureInPicture && document.pictureInPictureEnabled) ||
  typeof floatVideo.webkitSetPresentationMode === 'function';
const isFloating = () => !!document.pictureInPictureElement || floatVideo.webkitPresentationMode === 'picture-in-picture' ||
  [...document.querySelectorAll('#grid video')].some(v => v.webkitPresentationMode === 'picture-in-picture');

function pickFloatTarget() {
  const list = [...people.values()].filter(p => !p.leaving);
  if (!list.length) return null;
  const cur = list.includes(floatTarget) ? floatTarget : null;
  const talker = list.filter(p => p.speaking).sort((x, y) => (y.spokeAt || 0) - (x.spokeAt || 0))[0];
  if (talker && talker !== cur && (!cur || (!cur.speaking && Date.now() - floatSince >= FLOAT_SWITCH_MS))) return talker;
  return cur || list.find(p => p.ui.ph.hidden) || list[0];
}

// A still card for someone whose camera is off (or nobody yet): their initial and name.
const card = { canvas: null, track: null, key: '', drawnAt: 0 };
function cardTrack(p) {
  if (!card.canvas) {
    card.canvas = document.createElement('canvas');
    card.canvas.width = 360; card.canvas.height = 480;
    try { card.track = card.canvas.captureStream(5).getVideoTracks()[0]; } catch { card.track = null; }
  }
  const name = p ? (p.name || 'Someone') : 'Waiting for others';
  const note = p ? p.ui.status.textContent : '';
  const key = name + '|' + note;
  if (key !== card.key || Date.now() - card.drawnAt > 1000) {   // redraw now and then so the video keeps going
    card.key = key; card.drawnAt = Date.now();
    const g = card.canvas.getContext('2d');
    g.fillStyle = '#26251f'; g.fillRect(0, 0, 360, 480);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    if (p) {
      g.fillStyle = '#4a4943'; g.beginPath(); g.arc(180, 205, 70, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#f2f1ed'; g.font = '600 64px -apple-system, system-ui, sans-serif';
      g.fillText(name.charAt(0).toUpperCase(), 180, 208);
    }
    g.fillStyle = '#f2f1ed'; g.font = '500 28px -apple-system, system-ui, sans-serif';
    g.fillText(name.slice(0, 22), 180, p ? 320 : 240);
    if (note) { g.fillStyle = 'rgba(242,241,237,.7)'; g.font = '22px -apple-system, system-ui, sans-serif'; g.fillText(note, 180, 360); }
  }
  return card.track;
}

function updateFloat() {
  $('cFloat').hidden = !inCall || !canFloat();
  if (!inCall) return;
  $('cFloat').disabled = !people.size && !isFloating();
  const t = pickFloatTarget();
  if (t !== floatTarget) { floatTarget = t; floatSince = Date.now(); }
  const vt = t && t.ui.ph.hidden && t.stream && t.stream.getVideoTracks()[0];
  const track = (vt && vt.readyState === 'live') ? vt : cardTrack(t);
  if (!track) return;
  const current = floatVideo.srcObject && floatVideo.srcObject.getVideoTracks()[0];
  if (current !== track) {
    // A new stream for each person: an open floating window stays open and switches
    // (checked on an iPhone with iOS 26.5: 10 switches, the window never closed).
    floatVideo.srcObject = new MediaStream([track]);
    floatVideo.play().catch(() => {});
  } else if (floatVideo.paused) floatVideo.play().catch(() => {});
}

let lastFloatError = '';
// On iPhone and iPad, floating works in Safari but not in home screen web apps (an Apple
// limitation), so say so instead of failing.
const FLOAT_BLOCKED = IS_IOS && STANDALONE;

async function toggleFloat() {
  if (!inCall) return;
  if (FLOAT_BLOCKED) {
    toast('On iPhone, floating works in Safari but not in the home screen app (an Apple limitation). Open the room in Safari to float.', 6000);
    return;
  }
  try {
    if (isFloating()) {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else for (const v of [floatVideo, ...document.querySelectorAll('#grid video')]) if (v.webkitPresentationMode === 'picture-in-picture') v.webkitSetPresentationMode('inline');
      return;
    }
    updateFloat();
    floatVideo.play().catch(() => {});
    // The hidden video isn't ready (iPhones may hold it back): float the person's own tile.
    const target = floatVideo.readyState >= 2 ? floatVideo
      : (floatTarget && floatTarget.ui.video.readyState >= 2 ? floatTarget.ui.video : floatVideo);
    log('FLOAT', target === floatVideo ? 'following the talker' : 'their own video', `(ready ${floatVideo.readyState}, paused ${floatVideo.paused}, tile ready ${floatTarget ? floatTarget.ui.video.readyState : '-'})`);
    // No waiting before this call: iOS only allows it straight from the tap.
    if (target.requestPictureInPicture && document.pictureInPictureEnabled) await target.requestPictureInPicture();
    else target.webkitSetPresentationMode('picture-in-picture');
  } catch (e) {
    lastFloatError = `${e && e.name}: ${e && e.message ? String(e.message).slice(0, 80) : ''}`;
    log('FLOAT failed', lastFloatError);
    trouble('float', true);
    toast(`The video can't float right now (${(e && e.name) || 'refused'}). Try again in a moment.`);
  }
}

function endFloat() {
  try { if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {}); } catch {}
  try { if (floatVideo.webkitPresentationMode === 'picture-in-picture') floatVideo.webkitSetPresentationMode('inline'); } catch {}
  floatVideo.srcObject = null;
  floatTarget = null;
  $('zoomCtl').hidden = true;
  $('zoomDial').hidden = true;
  zoomState.track = null;
  $('cFloat').hidden = true;
  $('cFloat').classList.remove('active');
}

const floatChanged = () => {
  const on = isFloating();
  $('cFloat').classList.toggle('active', on);
  $('cFloat').querySelector('.lb').textContent = on ? 'Floating' : 'Float';
  $('cFloat').setAttribute('aria-pressed', String(on));
};
for (const ev of ['enterpictureinpicture', 'leavepictureinpicture', 'webkitpresentationmodechanged']) {
  document.addEventListener(ev, floatChanged, true);   // the hidden video or a tile's
}
$('cFloat').addEventListener('click', toggleFloat);

/* keyboard (computers): M mute, V camera, P float, S swap, I invite, D details, Esc close */

document.addEventListener('keydown', e => {
  if (!inCall || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const k = e.key.toLowerCase();
  if (k === 'escape') { if (!$('details').hidden) $('details').hidden = true; return; }
  if (!$('sheet').hidden) return;   // the invite panel is open
  if (k === 'm') $('cMic').click();
  else if (k === 'v') $('cCam').click();
  else if (k === 'p') { if (!$('cFloat').hidden) toggleFloat(); }
  else if (k === 's') swapView();
  else if (k === 'i') $('topInvite').click();
  else if (k === 'd') { if ($('details').hidden) $('whoBtn').click(); else $('details').hidden = true; }
  else return;
  e.preventDefault();
});
$('detailsKeys').hidden = !matchMedia('(hover: hover) and (pointer: fine)').matches;

function updateMeta() {
  if (!inCall) return;
  if (selfReconnecting) { $('callMeta').textContent = 'Reconnecting…'; return; }
  const n = people.size;
  if (!n) { $('callMeta').textContent = 'Just you'; return; }
  const s = Math.floor((Date.now() - t0) / 1000);
  const time = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  $('callMeta').textContent = `${n + 1} people · ${time}` + (saverOn() ? ' · Data saver' : '');
}

// Show whether we can reach the relays that introduce people to each other.
function watchRelays() {
  const started = Date.now();
  const check = () => {
    if (!inCall) return;
    let open = 0;
    try { for (const s of Object.values(getRelaySockets())) if (s && s.readyState === 1) open++; } catch {}
    if (open > 0) {
      $('aloneTitle').textContent = 'Waiting for others';
      $('aloneSub').textContent = 'They join by opening the room\'s invite link.';
    } else if (Date.now() - started > 12000) {
      $('aloneTitle').textContent = 'Still connecting…';
      $('aloneSub').textContent = 'Check your internet connection. This usually takes a few seconds.';
    } else {
      $('aloneTitle').textContent = 'Connecting…';
      $('aloneSub').textContent = '';
    }
  };
  check();
  relayTimer = setInterval(check, 1000);
}

// Quality: capture in Full HD, then give each person a fair share of upload.
// These are ceilings; the browser still lowers them on its own when a link is weak,
// so a poor connection gets smooth video instead of stalls.
//   people in call  per-person video      resolution sent   your total upload
//   2               4.0 Mbps              1080p             4 Mbps
//   3               2.5 Mbps              720p              5 Mbps
//   4               1.6 Mbps              720p              4.8 Mbps
//   5-6             1.0 Mbps              540p              4-5 Mbps
// Voice gets 64 kbps (about twice the usual default) for clearer speech.
const AUDIO_BITRATE = 64000;
function sendProfile(others) {
  if (others <= 1) return { bitrate: 4000000, scale: 1 };
  if (others === 2) return { bitrate: 2500000, scale: 1.5 };
  if (others === 3) return { bitrate: 1600000, scale: 1.5 };
  return { bitrate: 1000000, scale: 2 };
}

/* Data saver: much lighter video (about 480p) for people on mobile data. Auto turns it on
   where the phone says it is on mobile data or asks to save data (Android Chrome); iPhones
   don't say, so there it is a switch. It also asks the others to send us lighter video, so it
   saves on what we receive, not only on what we send. */
const SAVER_AUDIO = 32000;
function saverProfile(others) {
  if (others <= 1) return { bitrate: 600000, scale: 2.25 };
  if (others === 2) return { bitrate: 400000, scale: 3 };
  return { bitrate: 300000, scale: 3 };
}
const conn = navigator.connection || null;
const onMobileData = () => !!conn && (conn.type === 'cellular' || conn.saveData === true);
const saverOn = () => data.saver === 'on' || (data.saver === 'auto' && onMobileData());
if (conn && conn.addEventListener) conn.addEventListener('change', () => { if (inCall) saverChanged(); });

function saverChanged() {
  renderSaver();
  if (!inCall) return;
  log('DATA SAVER', saverOn() ? 'on' : 'off', `(${data.saver})`);
  sendState();
  tuneBitrate();
  updateMeta();
}
// What the data saver setting means right now, in megabytes a minute (sent and received).
function renderSaver() {
  for (const b of document.querySelectorAll('#saverSeg button')) b.setAttribute('aria-checked', String(b.dataset.saver === data.saver));
  const others = Math.max(1, people.size);
  const mb = p => Math.round(p.bitrate * others * 2 / 8 / 1e6 * 60);   // to and from each person
  const on = saverOn();
  const why = data.saver === 'auto' ? (on ? 'On, because this phone is on mobile data.' : (conn ? 'Off: not on mobile data.' : 'Off: this phone doesn\'t say when it is on mobile data, so choose On there.')) : (on ? 'On.' : 'Off.');
  $('saverNote').textContent = `${why} Video uses up to about ${mb(on ? saverProfile(others) : sendProfile(others))} MB a minute${on ? ` (instead of ${mb(sendProfile(others))})` : ''}.`;
}
for (const b of document.querySelectorAll('#saverSeg button')) {
  b.addEventListener('click', () => { data.saver = b.dataset.saver; save(); saverChanged(); });
}

function tuneBitrate() {
  if (!room) return;
  const n = people.size;
  if (!n) return;
  const mine = saverOn();
  let all = {};
  try { all = room.getPeers(); } catch {}
  for (const id of Object.keys(all)) {
    const pc = all[id] && all[id].connection;
    if (!pc) continue;
    const them = byPeer.get(id);
    const light = mine || !!(them && them.ds);   // we save data, or they asked us to
    const video = light ? saverProfile(n) : sendProfile(n);
    const audio = light ? SAVER_AUDIO : AUDIO_BITRATE;
    for (const sender of pc.getSenders()) {
      if (!sender.track) continue;
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) continue;
      const e = params.encodings[0];
      if (sender.track.kind === 'video') {
        if (e.maxBitrate === video.bitrate && (e.scaleResolutionDownBy || 1) === video.scale) continue;
        e.maxBitrate = video.bitrate;
        e.scaleResolutionDownBy = video.scale;
      } else {
        if (e.maxBitrate === audio) continue;
        e.maxBitrate = audio;
      }
      sender.setParameters(params).catch(() => {});
    }
  }
}

/* ------------------------------------------------------- network check */

// Classify this network the way it matters for direct calls, using the same
// public STUN servers the calls use (they only tell a device its public address).
//   open:    the router keeps one public address per device; direct calls work with almost anyone
//   strict:  the public address changes per destination (common on mobile data and offices);
//            works with open networks, usually fails with another strict one
//   blocked: no public address at all; this network blocks direct calls
const NET_LABEL = {
  open: 'Open: direct calls work with almost anyone.',
  strict: 'Strict: calls work with people on normal home networks, but can fail with another strict network (some mobile data, offices).',
  blocked: 'Blocked: direct calls only work with people on this same network. For anyone else, switch to mobile data or another wifi.'
};
let netType = '', netChecked = 0, netCheck = null, netV6 = false, netAddrs = [];

function checkNetwork(force) {
  if (netCheck) return netCheck;
  if (!force && netType && Date.now() - netChecked < 60000) return Promise.resolve(netType);
  netCheck = probe().then(t => { netType = t; netChecked = Date.now(); netCheck = null; return t; });
  return netCheck;
}

async function probe() {
  let pc;
  try {
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }] });
    pc.createDataChannel('probe');
    const found = [];
    let finished = false;
    const done = new Promise(res => {
      const t = setTimeout(res, 6000);
      pc.onicecandidate = e => { if (!e.candidate) { finished = true; clearTimeout(t); res(); } else found.push(e.candidate); };
    });
    await pc.setLocalDescription(await pc.createOffer());
    await done;
    // A public IPv6 address: no address sharing, so two phones with one usually connect directly.
    netV6 = found.some(c => {
      const addr = c.address || c.candidate.split(' ')[4] || '';
      return addr.includes(':') && !/^(fe80|fc|fd)/i.test(addr);
    });
    const mapped = found.filter(c => (c.type || (c.candidate.match(/ typ (\w+)/) || [])[1]) === 'srflx');
    netAddrs = [...new Set(found.filter(c => /srflx/.test(c.candidate)).map(c => (c.address || c.candidate.split(' ')[4]) + ':' + (c.port || c.candidate.split(' ')[5])))];
    // No public address: blocked only if the check really finished (a slow mobile connection
    // can simply run out of time, which says nothing about the network).
    if (!mapped.length) return finished ? 'blocked' : '';
    const ports = {};
    for (const c of mapped) {
      const addr = c.address || c.candidate.split(' ')[4];
      const port = c.port || c.candidate.split(' ')[5];
      (ports[addr] = ports[addr] || new Set()).add(String(port));
    }
    return Object.values(ports).some(p => p.size > 1) ? 'strict' : 'open';
  } catch {
    return '';
  } finally {
    try { pc && pc.close(); } catch {}
  }
}

function showNetWarning(t) {
  const w = $('netWarn');
  w.hidden = !(t === 'blocked' && current === 'lobby');
  w.textContent = 'This network blocks direct calls, so you may not be able to connect. Mobile data or another wifi usually works.';
}

const failures = new Map();   // peerId -> reason

function failureReason() {
  if (netType === 'blocked') return 'Your network blocks direct calls. Switch to mobile data or another wifi.';
  if (netType === 'strict') return 'Both networks are strict. One of you should switch to home wifi or another network.';
  if (netType === 'open') return 'Their network blocks direct calls. They should switch to mobile data or another wifi.';
  return 'One of the networks blocks direct calls. Try mobile data or another wifi.';
}

// Which path a working connection uses: inside the same network, or across the internet.
async function connectionPath(peerId) {
  let pc = null;
  try { const info = room && room.getPeers()[peerId]; pc = info && info.connection; } catch {}
  if (!pc) return '';
  try {
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach(s => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId); });
    if (!pair) stats.forEach(s => { if (s.type === 'candidate-pair' && (s.selected || (s.nominated && s.state === 'succeeded'))) pair = pair || s; });
    if (!pair) return '';
    const l = stats.get(pair.localCandidateId), r = stats.get(pair.remoteCandidateId);
    if (!l || !r) return '';
    if (l.candidateType === 'relay' || r.candidateType === 'relay') return 'relayed';
    return l.candidateType === 'host' && r.candidateType === 'host' ? 'same network' : 'over the internet';
  } catch { return ''; }
}

// What we are actually receiving from someone right now, e.g. "1080p, 30 fps".
const rates = new Map();   // peerId -> last { bytes, t }, for the data rate in the details
async function receiving(peerId) {
  let pc = null;
  try { const info = room && room.getPeers()[peerId]; pc = info && info.connection; } catch {}
  if (!pc) return '';
  try {
    let line = '';
    const stats = await pc.getStats();
    stats.forEach(s => {
      if (s.type === 'inbound-rtp' && s.kind === 'video' && s.frameHeight) {
        line = `${s.frameHeight}p` + (s.framesPerSecond ? `, ${Math.round(s.framesPerSecond)} fps` : '');
        // Which video format, and how much data it takes right now.
        const codec = s.codecId && stats.get(s.codecId);
        if (codec && codec.mimeType) line += ', ' + codec.mimeType.replace(/^video\//i, '').replace(/^H265$/i, 'H.265').replace(/^H264$/i, 'H.264');
        const prev = rates.get(peerId), now = Date.now();
        rates.set(peerId, { bytes: s.bytesReceived, t: now });
        if (prev && now > prev.t && s.bytesReceived >= prev.bytes) {
          const kbps = (s.bytesReceived - prev.bytes) * 8 / (now - prev.t);   // bits per ms = kbit/s
          line += ', ' + (kbps >= 1000 ? (kbps / 1000).toFixed(1) + ' Mbps' : Math.round(kbps) + ' kbps');
        }
      }
    });
    return line;
  } catch { return ''; }
}

async function renderDetails() {
  renderSaver();
  if ($('details').hidden) return;
  $('detailsNet').textContent = 'Your network: ' + (NET_LABEL[netType] || 'checking…') +
    (netType ? (netV6 ? ' Has IPv6, which helps reach other phones on mobile data.' : ' No IPv6.') : '');
  const list = $('detailsList');
  const items = [];
  for (const p of people.values()) {
    const path = p.peerId ? await connectionPath(p.peerId) : '';
    const video = p.peerId && !p.reconnecting ? await receiving(p.peerId) : '';
    const li = el('li', '', p.name || 'Someone');
    const helper = p.relayVia && byPeer.get(p.relayVia);
    const sub = p.reconnecting ? 'Reconnecting…'
      : p.relayVia ? `No direct connection: passed along by ${helper && helper.name ? helper.name + '\'s' : 'another'} phone`
      : path ? 'Direct connection, ' + path : (p.stream ? 'Connected' : 'Connecting…');
    const theirs = p.net ? ' · their network: ' + p.net + (p.v6 ? ', IPv6' : '') : '';
    li.append(el('span', 'd-sub', sub + theirs));
    if (video) li.append(el('span', 'd-sub', 'Video: ' + video));
    items.push(li);
  }
  const linked = new Set([...people.values()].map(p => p.sess).filter(Boolean));
  for (const [cs, u] of unseen) {
    // Only once it lasts: someone just arriving is briefly in the room before connecting.
    if (linked.has(cs) || Date.now() - u.first < 5000) continue;
    const li = el('li', '', u.name);
    li.append(el('span', 'd-sub', u.told ? 'In the room, but can\'t connect to you. ' + failureReason() : 'In the room, connecting…'));
    items.push(li);
  }
  for (const why of failures.values()) {
    const li = el('li', '', 'Someone could not connect');
    li.append(el('span', 'd-sub', why));
    items.push(li);
  }
  if (!items.length) items.push(el('li', '', 'Nobody else is here yet.'));
  list.replaceChildren(...items);
}

$('whoBtn').addEventListener('click', () => { $('details').hidden = false; renderDetails(); });
$('detailsClose').addEventListener('click', () => { $('details').hidden = true; });
$('details').addEventListener('click', e => { if (e.target === $('details')) $('details').hidden = true; });

/* ---------------------------------------------------------------- presence */

// Who is in each room's call right now, shown on the rooms screen and before joining.
const presenceNow = new Map();   // roomKey -> { names, since }: who is in that call, and since when (s)
const rowRefs = new Map();       // roomKey -> elements of that room's live card

function initials(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  return (words.slice(0, 2).map(w => Array.from(w)[0]).join('') || '?').toUpperCase();
}

function whoText(names) {
  if (names.length === 1) return `${names[0]} is in the call`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are in the call`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more are in the call`;
}

function showPresence(rk, names) {
  if (lobbyRoom && current === 'lobby' && roomKeyOf(lobbyRoom) === rk) {
    $('lobbyWho').hidden = !names.length;
    $('lobbyWho').textContent = names.length ? whoText(names) : '';
    $('lobbyLive').hidden = !names.length;
    $('lobbyLive').textContent = `${names.length} in call`;
  }
}

function onPresence(rk, names, sessions, members, since) {
  if (inCall && callRoom && rk === roomKeyOf(callRoom)) {
    aliveInCall = sessions || new Set();
    roomMembers = members || [];
    checkUnseen();
  }
  const was = presenceNow.get(rk);
  if (names.length) presenceNow.set(rk, { names, since: since || 0 }); else presenceNow.delete(rk);
  showPresence(rk, names);
  if (current === 'home' && !editing) {
    const ref = rowRefs.get(rk);
    if (!!was !== !!names.length) renderHome();            // moves between "In a call now" and the saved rooms
    else if (ref && names.length) ref.sub.textContent = liveText(presenceNow.get(rk));
  }
}

// Only watch while the rooms screen (or the screen before joining) is open and visible.
function syncWatching() {
  const visible = document.visibilityState === 'visible';
  let rooms = [];
  if (visible && current === 'home') rooms = data.rooms;
  else if (visible && current === 'lobby' && lobbyRoom) rooms = [lobbyRoom];
  else if (current === 'call' && callRoom) rooms = [callRoom];   // tells dropped links from people who left
  if (!rooms.length) { presence.unwatch(); presenceNow.clear(); return; }
  const keep = new Set(rooms.map(roomKeyOf));
  for (const rk of [...presenceNow.keys()]) if (!keep.has(rk)) presenceNow.delete(rk);
  presence.watch(rooms, onPresence).catch(() => {});
}
document.addEventListener('visibilitychange', syncWatching);

/* -------------------------------------------------------------------- boot */

history.replaceState({ s: 'home' }, '');
$('ver').textContent = 'Version ' + VERSION;
renderHome();

// Opened from an invite link (#room=…&key=…): read it, then wipe it from the address bar.
// Opened from a room's address (#room=… only, as shown during a call): go into that room if
// it is saved here, otherwise ask for its password. A refresh during a call rejoins it.
const hashParams = location.hash.startsWith('#room=') ? new URLSearchParams(location.hash.slice(1)) : null;
const hashName = hashParams ? clean(hashParams.get('room') || '').slice(0, 40) : '';
const hashKey = hashParams ? (hashParams.get('key') || '').trim() : '';
const resume = !hashKey && recallActive();
if (resume) openLobby(resume, resume.invited, resume.stage === 'call' ? resume : null);
else if (hashParams) {
  history.replaceState({ s: 'home' }, '', location.pathname + location.search);
  if (hashKey) {
    const r = { name: hashName, key: hashKey };
    if (validRoom(r)) openLobby(r, true);
    else toast('That invite link is incomplete. Ask for it again.');
  } else if (hashName) {
    const saved = data.rooms.filter(x => x.name === hashName);
    if (saved.length === 1) openLobby(saved[0], false);
    else if (saved.length > 1) toast(`You have more than one room called "${hashName}". Pick it below.`, 5000);
    else openAddForRoom(hashName);
  }
}
