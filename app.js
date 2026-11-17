// Call: private peer-to-peer video rooms.
// Video and audio go directly between browsers (WebRTC, always encrypted).
// Public Nostr relays are only used to introduce browsers to each other, and
// that introduction is encrypted with the room password, so relays learn nothing useful.

import { joinRoom, getRelaySockets } from './vendor/trystero-0.27.0.js';

// Refuse to run inside someone else's frame (clickjacking).
if (window.top !== window.self) {
  document.documentElement.replaceChildren();
  throw new Error('Call cannot run inside a frame.');
}

/* ------------------------------------------------------------------ config */

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

function toast(msg) {
  const t = el('div', 'toast', msg);
  $('toasts').append(t);
  setTimeout(() => t.classList.add('out'), 2800);
  setTimeout(() => t.remove(), 3200);
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
      rooms: Array.isArray(d.rooms) ? d.rooms.filter(validRoom).map(r => ({ name: r.name, key: r.key })) : []
    };
  } catch { return { name: '', rooms: [] }; }
}
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch {} }
let data = load();

function addRoom(r) {
  if (!data.rooms.some(x => sameRoom(x, r))) data.rooms.push({ name: r.name, key: r.key });
  save();
}

function inviteLink(r) {
  const base = location.origin + location.pathname;
  return base + '#room=' + encodeURIComponent(r.name) + '&key=' + encodeURIComponent(r.key);
}

async function invite(r) {
  const url = inviteLink(r);
  const text = `Join my "${r.name}" video room:\n${url}\n\nAnyone with this link can join, so only share it with the people in the room.`;
  if (navigator.share) {
    try { await navigator.share({ text }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  toast(await copyText(url) ? 'Invite link copied' : 'Could not copy the link');
}

/* -------------------------------------------------------------- navigation */

const SCREENS = ['home', 'add', 'lobby', 'call'];
let current = 'home';

function show(s) {
  for (const id of SCREENS) $(id).hidden = id !== s;
  current = s;
  document.body.dataset.screen = s;
  window.scrollTo(0, 0);
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
  renderHome();
  show('home');
  if (pendingToast) { toast(pendingToast); pendingToast = ''; }
}

function renderHome() {
  if (!data.rooms.length) editing = false;
  const list = $('roomList');
  list.replaceChildren();
  $('homeEmpty').hidden = data.rooms.length > 0;
  $('editBtn').hidden = data.rooms.length === 0;
  $('editBtn').textContent = editing ? 'Done' : 'Edit';
  for (const r of data.rooms) {
    const li = el('li', 'room');
    const main = el('button', 'main');
    main.type = 'button';
    main.append(el('div', 'name', r.name), el('div', 'sub', editing ? '' : 'Tap to join'));
    main.addEventListener('click', () => { if (!editing) openLobby(r, false); });
    if (editing) {
      const del = el('button', 'icon-btn del');
      del.type = 'button';
      del.setAttribute('aria-label', 'Remove ' + r.name);
      del.append(icon('trash'));
      del.addEventListener('click', () => {
        if (!confirm(`Remove "${r.name}" from this device?\nYou can add it again later with its invite link.`)) return;
        data.rooms = data.rooms.filter(x => !sameRoom(x, r));
        save(); renderHome();
      });
      li.append(main, del);
    } else {
      const inv = el('button', 'icon-btn');
      inv.type = 'button';
      inv.setAttribute('aria-label', 'Invite people to ' + r.name);
      inv.append(icon('share'));
      inv.addEventListener('click', () => invite(r));
      li.append(main, inv);
    }
    list.append(li);
  }
}

$('editBtn').addEventListener('click', () => { editing = !editing; renderHome(); });
$('addBtn').addEventListener('click', openAdd);
$('forgetBtn').addEventListener('click', () => {
  if (!confirm('Remove all rooms and your name from this device?')) return;
  try { localStorage.removeItem(STORE_KEY); } catch {}
  data = { name: '', rooms: [] };
  renderHome();
  toast('Everything removed from this device');
});

/* ---------------------------------------------------------------- add room */

function openAdd() {
  $('addName').value = '';
  $('addKey').value = newPassword();
  $('addErr').textContent = '';
  push('add');
}
$('genBtn').addEventListener('click', () => { $('addKey').value = newPassword(); });
$('addName').addEventListener('keydown', e => { if (e.key === 'Enter') $('addKey').focus(); });
$('addKey').addEventListener('keydown', e => { if (e.key === 'Enter') $('saveBtn').click(); });
$('saveBtn').addEventListener('click', () => {
  const r = { name: clean($('addName').value), key: $('addKey').value.trim() };
  if (!r.name) { $('addErr').textContent = 'Give the room a name, like family.'; $('addName').focus(); return; }
  if (r.key.length < 8) { $('addErr').textContent = 'Use a password of at least 8 characters. The generated one is best.'; return; }
  if (/\s/.test(r.key)) { $('addErr').textContent = 'The password cannot contain spaces.'; return; }
  const existed = data.rooms.some(x => sameRoom(x, r));
  addRoom(r);
  pendingToast = existed ? 'You already had this room' : 'Room saved. Use the share button to invite people.';
  back();
});

/* ------------------------------------------------------------------- media */

let local = null;      // our MediaStream
let facing = 'user';
let micOn = true, camOn = true;

const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const videoConstraints = f => ({ facingMode: f, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } });

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
    try { stream = await gum({ audio: AUDIO }); note = 'No camera found. You can still join with sound.'; }
    catch (e2) {
      note = (e2 && e2.name === 'NotAllowedError')
        ? 'Camera and microphone are blocked. On iPhone: tap "aA" in the address bar, then Website Settings, and allow both. In the home screen app: Settings, Apps, Safari, Camera and Microphone.'
        : 'Could not start the camera or microphone. Another app may be using them.';
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
  $('previewOff').hidden = !!(v && camOn);
  $('previewOff').textContent = v ? 'Camera is off' : (local ? 'No camera' : 'Starting camera…');
  $('self').classList.toggle('cam-off', !(v && camOn));
}

async function updateFlip() {
  let n = 0;
  try { n = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput').length; } catch {}
  $('cFlip').hidden = n < 2 || !(local && local.getVideoTracks()[0]);
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
$('retryMedia').addEventListener('click', startMedia);

// iOS stops the camera when the app goes to the background. Bring it back.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !local) return;
  for (const t of local.getTracks()) if (t.readyState === 'ended') await swapTrack(t.kind, facing);
});

/* ------------------------------------------------------------------- lobby */

let lobbyRoom = null;

function openLobby(r, invited) {
  lobbyRoom = { name: r.name, key: r.key, invited };
  $('lobbyTitle').textContent = r.name;
  $('lobbyLead').textContent = invited
    ? 'You have been invited to this room. Check your camera and sound, then join.'
    : 'Check your camera and sound, then join.';
  $('saveInviteRow').hidden = !(invited && !data.rooms.some(x => sameRoom(x, r)));
  $('saveInvite').checked = true;
  $('nameInput').value = data.name;
  $('lobbyErr').textContent = '';
  $('joinBtn').disabled = false;
  $('joinBtn').textContent = 'Join call';
  micOn = true; camOn = true;
  push('lobby');
  applyToggles();
  startMedia();
}

$('nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.target.blur(); $('joinBtn').click(); } });
$('joinBtn').addEventListener('click', async () => {
  const name = clean($('nameInput').value).slice(0, 30);
  if (!name) { $('lobbyErr').textContent = 'Add your name so the others know who joined.'; $('nameInput').focus(); return; }
  $('lobbyErr').textContent = '';
  data.name = name;
  if (lobbyRoom.invited && !$('saveInviteRow').hidden && $('saveInvite').checked) addRoom(lobbyRoom);
  save();
  $('joinBtn').disabled = true;
  $('joinBtn').textContent = 'Joining…';
  try {
    await startCall(lobbyRoom);
  } catch {
    $('lobbyErr').textContent = 'Could not join. Check your connection and try again.';
    $('joinBtn').disabled = false;
    $('joinBtn').textContent = 'Join call';
  }
});

/* -------------------------------------------------------------------- call */

let room = null, stateAction = null, callRoom = null, inCall = false;
let t0 = 0, timer = 0, wakeLock = null, relayTimer = 0;
const peers = new Map();   // peerId -> { name, mic, cam, stream, ui, announced }

async function startCall(r) {
  const id = await roomId(r);
  if (current !== 'lobby') return;   // went back while hashing
  callRoom = r;
  room = joinRoom({
    appId: APP_ID,
    password: r.key,
    identity: 'none',
    maxUsers: MAX_PEOPLE,
    relayConfig: { urls: RELAYS, redundancy: RELAYS.length, warnOnRelayFailure: false }
  }, id);

  stateAction = room.makeAction('st');
  stateAction.onReceive(ctx => ctx.byteLength <= 512);
  stateAction.onMessage((msg, { peerId }) => onPeerState(peerId, msg));
  room.onPeerJoin(({ peerId }) => onPeerJoin(peerId));
  room.onPeerLeave(({ peerId }) => onPeerLeave(peerId));
  room.onPeerStream((stream, { peerId }) => onPeerStream(peerId, stream));
  room.onError(onRoomError);

  inCall = true;
  history.replaceState({ s: 'call' }, '');
  show('call');
  $('callRoom').textContent = r.name;
  t0 = Date.now();
  timer = setInterval(updateMeta, 1000);
  layout();
  watchRelays();
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}

function leaveCall() {
  if (!inCall) return;
  inCall = false;
  try { room && room.leave(); } catch {}
  room = null; stateAction = null; callRoom = null;
  for (const p of peers.values()) { p.ui.video.srcObject = null; p.ui.root.remove(); }
  peers.clear();
  clearInterval(timer); clearInterval(relayTimer);
  try { wakeLock && wakeLock.release(); } catch {}
  wakeLock = null;
  $('tapAudio').hidden = true;
  $('toasts').replaceChildren();
  stopMedia();
  layout();
}

$('cLeave').addEventListener('click', back);
$('aloneInvite').addEventListener('click', () => callRoom && invite(callRoom));
$('topInvite').addEventListener('click', () => callRoom && invite(callRoom));
addEventListener('pagehide', () => { try { room && room.leave(); } catch {} });
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && inCall && !wakeLock) {
    try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch {}
  }
});

function sendState(target) {
  if (!stateAction) return;
  const msg = { n: data.name, m: micOn, c: camOn };
  stateAction.send(msg, target ? { target } : undefined).catch(() => {});
}

function onPeerJoin(peerId) {
  if (!inCall || peers.has(peerId)) return;
  const p = { name: '', mic: true, cam: true, stream: null, ui: makeTile(), announced: false };
  peers.set(peerId, p);
  $('grid').append(p.ui.root);
  renderTile(p);
  layout();
  if (local) room.addStream(local, { target: peerId }).catch(() => {});
  sendState(peerId);
  setTimeout(() => { if (peers.get(peerId) === p && !p.announced) { p.announced = true; toast('Someone joined'); } }, 4000);
  setTimeout(tuneBitrate, 2000);
  setTimeout(tuneBitrate, 7000);
}

function onPeerLeave(peerId) {
  const p = peers.get(peerId);
  if (!p) return;
  p.ui.video.srcObject = null;
  p.ui.root.remove();
  peers.delete(peerId);
  toast((p.name || 'Someone') + ' left');
  layout();
  tuneBitrate();
}

function onPeerStream(peerId, stream) {
  if (!peers.has(peerId)) onPeerJoin(peerId);
  const p = peers.get(peerId);
  if (!p) return;
  p.stream = stream;
  const v = p.ui.video;
  v.srcObject = stream;
  v.play().catch(() => { $('tapAudio').hidden = false; });
  stream.addEventListener('addtrack', () => renderTile(p));
  renderTile(p);
}

function onPeerState(peerId, msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.n !== 'string') return;
  if (!peers.has(peerId)) onPeerJoin(peerId);
  const p = peers.get(peerId);
  if (!p) return;
  p.name = clean(msg.n).slice(0, 30) || 'Someone';
  p.mic = msg.m !== false;
  p.cam = msg.c !== false;
  if (!p.announced) { p.announced = true; toast(p.name + ' joined'); }
  renderTile(p);
}

function onRoomError(err) {
  if (!inCall || !err) return;
  if (err.code === 'room-full' && peers.size === 0) {
    toast(`This room is full (${MAX_PEOPLE} people at most)`);
  } else if (err.code === 'peer-connect-failed') {
    toast('Could not reach someone directly. One of you may be on a network that blocks calls; try other wifi or mobile data.');
  }
}

$('tapAudio').addEventListener('click', () => {
  $('tapAudio').hidden = true;
  for (const p of peers.values()) p.ui.video.play().catch(() => {});
});

/* tiles */

function makeTile() {
  const root = el('div', 'tile');
  const video = el('video');
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  const ph = el('div', 'ph');
  const avatar = el('div', 'avatar');
  const status = el('div', 'ph-status');
  ph.append(avatar, status);
  const tag = el('div', 'tag');
  const name = el('span');
  tag.append(icon('mic-off'), name);
  root.append(video, ph, tag);
  // Double tap: switch between filling the tile and showing the whole picture.
  let last = 0;
  root.addEventListener('pointerup', () => {
    const now = Date.now();
    if (now - last < 320) { root.classList.toggle('fit'); last = 0; } else last = now;
  });
  return { root, video, ph, avatar, status, name };
}

function renderTile(p) {
  const vt = p.stream && p.stream.getVideoTracks()[0];
  const showVideo = !!(vt && p.cam);
  p.ui.ph.hidden = showVideo;
  p.ui.avatar.textContent = (p.name || '?').charAt(0).toUpperCase();
  p.ui.status.textContent = !p.stream ? 'Connecting…' : (!p.cam || !vt ? 'Camera off' : '');
  p.ui.name.textContent = p.name || '…';
  p.ui.root.classList.toggle('muted', !p.mic);
}

function layout() {
  const n = peers.size;
  $('grid').dataset.n = String(Math.min(n, 5));
  $('self').classList.toggle('full', n === 0);
  $('alone').hidden = n > 0 || !inCall;
  updateMeta();
}

function updateMeta() {
  if (!inCall) return;
  const n = peers.size;
  if (!n) { $('callMeta').textContent = 'Just you'; return; }
  const s = Math.floor((Date.now() - t0) / 1000);
  const time = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  $('callMeta').textContent = `${n + 1} people · ${time}`;
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

// Give each person a fair share of upload: sharper 1-to-1, lighter in groups.
function tuneBitrate() {
  if (!room) return;
  const n = peers.size;
  if (!n) return;
  const max = n === 1 ? 2500000 : n === 2 ? 1500000 : n === 3 ? 1000000 : 700000;
  let all = {};
  try { all = room.getPeers(); } catch {}
  for (const id of Object.keys(all)) {
    const pc = all[id] && all[id].connection;
    if (!pc) continue;
    for (const sender of pc.getSenders()) {
      if (!sender.track || sender.track.kind !== 'video') continue;
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) continue;
      if (params.encodings[0].maxBitrate === max) continue;
      params.encodings[0].maxBitrate = max;
      sender.setParameters(params).catch(() => {});
    }
  }
}

/* -------------------------------------------------------------------- boot */

history.replaceState({ s: 'home' }, '');
renderHome();

// Opened from an invite link: read it, then wipe it from the address bar.
if (location.hash.startsWith('#room=')) {
  const params = new URLSearchParams(location.hash.slice(1));
  const r = { name: clean(params.get('room')).slice(0, 40), key: (params.get('key') || '').trim() };
  history.replaceState({ s: 'home' }, '', location.pathname + location.search);
  if (validRoom(r)) openLobby(r, true);
  else toast('That invite link is incomplete. Ask for it again.');
}
