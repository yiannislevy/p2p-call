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

const VERSION = '1.7.0';
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

// Tapping Invite copies the link straight away, then offers sharing through apps.
let sheetRoom = null;
async function invite(r) {
  const url = inviteLink(r);
  const copied = await copyText(url);
  sheetRoom = r;
  $('sheetTitle').textContent = copied ? 'Invite link copied' : 'Copy this invite link';
  $('sheetSub').textContent = copied
    ? `Send it to the people in "${r.name}". Anyone with the link can join this room.`
    : `Select it and copy it, then send it to the people in "${r.name}".`;
  $('sheetLink').value = url;
  $('sheetShare').hidden = !navigator.share;
  $('sheetBack').hidden = false;
  $('sheet').hidden = false;
  if (!copied) { $('sheetLink').focus(); $('sheetLink').select(); }
}
function closeSheet() { $('sheet').hidden = true; $('sheetBack').hidden = true; sheetRoom = null; }
$('sheetDone').addEventListener('click', closeSheet);
$('sheetBack').addEventListener('click', closeSheet);
$('sheetLink').addEventListener('focus', e => e.target.select());
$('sheetShare').addEventListener('click', async () => {
  if (!sheetRoom) return;
  const text = `Join my "${sheetRoom.name}" video room:\n${inviteLink(sheetRoom)}`;
  try { await navigator.share({ text }); closeSheet(); } catch {}
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('sheet').hidden) closeSheet(); });

/* -------------------------------------------------------------- navigation */

const SCREENS = ['home', 'add', 'lobby', 'call'];
let current = 'home';

function show(s) {
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
  const list = $('roomList');
  list.replaceChildren();
  $('homeEmpty').hidden = data.rooms.length > 0;
  $('editBtn').hidden = data.rooms.length === 0;
  $('editBtn').textContent = editing ? 'Done' : 'Edit';
  rowRefs.clear();
  for (const r of data.rooms) {
    const li = el('li', 'room');
    const main = el('button', 'main');
    main.type = 'button';
    const sub = el('div', 'sub', editing ? '' : 'Tap to join');
    main.append(el('div', 'name', r.name), sub);
    const faces = el('span', 'faces');
    faces.hidden = true;
    if (!editing) rowRefs.set(roomKeyOf(r), { sub, faces, li });
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
      li.append(main, faces, inv);
    }
    list.append(li);
  }
  for (const [rk, names] of presenceNow) showPresence(rk, names);
  syncWatching();
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
  if (!micOn) $('self').classList.remove('speaking');   // never show ourselves talking while muted
  if (swapped) { swapped.me.classList.toggle('muted', !micOn); if (!micOn) swapped.me.classList.remove('speaking'); }
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
function openLobby(r, invited, resume) {
  lobbyRoom = { name: r.name, key: r.key, invited };
  $('lobbyTitle').textContent = r.name;
  $('lobbyWho').hidden = true;
  $('lobbyLead').textContent = invited
    ? 'You have been invited to this room. Check your camera and sound, then join.'
    : 'Check your camera and sound, then join.';
  $('saveInviteRow').hidden = !(invited && !data.rooms.some(x => sameRoom(x, r)));
  $('saveInvite').checked = true;
  $('nameInput').value = data.name;
  $('lobbyErr').textContent = '';
  $('joinBtn').disabled = false;
  $('joinBtn').textContent = 'Join call';
  micOn = resume ? resume.mic !== false : true;
  camOn = resume ? resume.cam !== false : true;
  push('lobby');
  rememberActive('lobby');
  applyToggles();
  const media = startMedia();
  checkNetwork().then(showNetWarning);
  if (resume && data.name) {
    $('lobbyLead').textContent = 'Rejoining the call…';
    $('joinBtn').disabled = true;
    $('joinBtn').textContent = 'Rejoining…';
    media.then(() => { if (current === 'lobby') join(resume.session); });
  }
}

$('nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.target.blur(); $('joinBtn').click(); } });
$('joinBtn').addEventListener('click', () => join(''));
async function join(resumeSession) {
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
    $('joinBtn').textContent = 'Join call';
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
let resendAction = null;
let aliveInCall = new Set();     // call sessions the room's presence notes say are still here
let roomMembers = [];            // [{ name, cs }] from those notes
const unseen = new Map();        // call session -> { name, since, tries, told }: in the room, not connected to us
const UNSEEN_MS = 15000;         // in the room but not connected this long: try to pick them up
const MAX_TRIES = 2;             // rejoins per such person, so a network that can't connect never makes us flap
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
  history.replaceState({ s: 'call' }, '');
  show('call');
  rememberActive('call');
  $('callRoom').textContent = r.name;
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
  const live = () => room === me && inCall;   // ignore late events from a room we already left
  stateAction = me.makeAction('st');
  stateAction.onReceive(ctx => ctx.byteLength <= 512);
  stateAction.onMessage((msg, { peerId }) => { if (live()) onPeerState(peerId, msg); });
  resendAction = me.makeAction('rs');
  resendAction.onReceive(ctx => ctx.byteLength <= 64);
  resendAction.onMessage((msg, { peerId }) => { if (live()) resendTo(peerId); });
  me.onPeerJoin(({ peerId }) => { if (live()) onPeerJoin(peerId); });
  me.onPeerLeave(({ peerId }) => { if (live()) onPeerLeave(peerId); });
  me.onPeerStream((stream, { peerId }) => { if (live()) onPeerStream(peerId, stream); });
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
addEventListener('online', () => { if (inCall) { rejoinAt = 0; if (people.size) downSince = Date.now() - DOWN_MS; checkHealth(); } });
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && inCall && !wakeLock) {
    try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch {}
  }
});

function sendState(target) {
  if (!stateAction) return;
  const msg = {
    n: data.name, m: micOn, c: camOn, nt: netType || undefined, s: mySession,
    hv: !!(local && local.getVideoTracks()[0]),   // we have a camera to send
    ha: !!(local && local.getAudioTracks()[0]),   // we have a microphone to send
    bg: document.visibilityState === 'hidden'     // in another app (iPhone pauses the camera then)
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
  p.reconnecting = true;
  p.since = Date.now();
  renderTile(p);
  clearTimeout(p.grace); clearTimeout(p.repair);
  // Still announcing in the room after a while, but our link to them is gone: repair it.
  // Exactly one side does this (the lower session id), so the two don't keep crossing.
  p.repair = setTimeout(() => {
    if (p.reconnecting && people.get(p.key) === p && aliveInCall.has(p.sess) && mySession < p.sess) rejoin(true);
  }, REPAIR_MS);
  const decide = () => {
    if (!p.reconnecting || people.get(p.key) !== p) return;
    // Their phone still says "here": keep waiting (and keep repairing), up to a limit.
    if (aliveInCall.has(p.sess) && Date.now() - p.since < MAX_WAIT_MS) {
      if (mySession < p.sess && !rejoining && (p.repairs || 0) < MAX_TRIES) { p.repairs = (p.repairs || 0) + 1; rejoin(true); }
      p.grace = setTimeout(decide, RECHECK_MS);
      return;
    }
    removePerson(p, false);
  };
  p.grace = setTimeout(decide, p.away ? AWAY_GRACE_MS : GRACE_MS);
}

function setStream(p, stream) {
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
  const p = newPerson('peer:' + peerId);
  p.peerId = peerId;
  p.linkedAt = Date.now();
  byPeer.set(peerId, p);
  if (local) room.addStream(local, { target: peerId }).catch(() => {});
  sendState(peerId);
  setTimeout(() => { if (people.get(p.key) === p && !p.announced) { p.announced = true; toast('Someone joined'); } }, 4000);
  setTimeout(tuneBitrate, 2000);
  setTimeout(tuneBitrate, 7000);
}

function onPeerLeave(peerId) {
  const p = byPeer.get(peerId);
  byPeer.delete(peerId);
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
  if (!byPeer.has(peerId)) onPeerJoin(peerId);
  let p = byPeer.get(peerId);
  if (!p) return;
  const sess = typeof msg.s === 'string' && /^[0-9a-f]{8,32}$/.test(msg.s) ? msg.s : '';
  if (sess && p.key !== sess) {
    const known = people.get(sess);
    if (known && known !== p) {
      // The same person on a new connection: keep their tile, drop the temporary one.
      if (known.peerId && known.peerId !== peerId) byPeer.delete(known.peerId);
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
  p.name = clean(msg.n).slice(0, 30) || 'Someone';
  p.mic = msg.m !== false;
  p.cam = msg.c !== false;
  p.leaving = msg.bye === true;
  p.away = msg.away === true;
  if (typeof msg.nt === 'string' && Object.prototype.hasOwnProperty.call(NET_LABEL, msg.nt)) p.net = msg.nt;
  p.hasVideo = msg.hv !== false;
  p.hasAudio = msg.ha !== false;
  p.bg = msg.bg === true;
  if (!p.announced && !p.leaving) { p.announced = true; toast(p.name + ' joined'); }
  renderTile(p);
  layout();
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
    try { pc.onnegotiationneeded && pc.onnegotiationneeded(new Event('negotiationneeded')); } catch {}
  }
}

// Someone isn't getting our camera or microphone: send them again, to that person only.
const lastResend = new Map();
async function resendTo(peerId) {
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
function linkStates() {
  let all = {};
  try { all = room ? room.getPeers() : {}; } catch {}
  return [...byPeer.keys()].map(id => { const pc = all[id] && all[id].connection; return pc ? pc.connectionState : 'gone'; });
}

function checkHealth() {
  if (!inCall || !room || rejoining) return;
  watchMedia();
  checkOffered();
  recoverLocalTracks(false);
  checkUnseen();
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
  if (Date.now() - downSince >= DOWN_MS && Date.now() >= rejoinAt) rejoin();
}

// repairing: we are fine, but a link to someone still in the room could not come back.
async function rejoin(repairing) {
  if (!inCall || rejoining) return;
  if (repairing && Date.now() < rejoinAt) return;
  rejoining = true;
  rejoins++;
  if (!repairing && !selfReconnecting) { selfReconnecting = true; toast('Connection lost. Reconnecting…', 4000); }
  updateMeta();
  const old = room;
  room = null; stateAction = null;
  for (const p of [...people.values()]) {
    if (p.peerId) byPeer.delete(p.peerId);
    p.peerId = null;
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
    for (const p of people.values()) {
      const pc = p.peerId && all[p.peerId] && all[p.peerId].connection;
      if (!pc || pc.connectionState !== 'connected') continue;
      selfPc = selfPc || pc;
      let e = 0, d = 0, found = false;
      (await pc.getStats()).forEach(s => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio' && s.totalSamplesDuration != null) { e += s.totalAudioEnergy || 0; d += s.totalSamplesDuration; found = true; }
      });
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
      toast(`${name} is in the room but can't connect to you. ${failureReason()}`, 8000);
      renderDetails();
    }
    const wait = mySession < cs ? UNSEEN_MS : UNSEEN_MS * 2;
    if (now - u.since < wait) continue;
    if (u.tries < MAX_TRIES && now >= rejoinAt) {
      u.tries++;
      u.since = now;
      rejoin(true);
      return;
    }
  }
}

function onRoomError(err) {
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
  root.append(video, ph, tag);
  root.addEventListener('click', () => { if (root.classList.contains('as-pip')) unswap(); });
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
  const away = p.bg && p.videoStalled;   // in another app and its camera paused
  const showVideo = !!(vt && p.cam) && !p.reconnecting && !away;
  p.ui.ph.hidden = showVideo;
  p.ui.avatar.textContent = (p.name || '?').charAt(0).toUpperCase();
  p.ui.status.textContent = p.reconnecting ? 'Reconnecting…' : !p.stream ? 'Connecting…'
    : away ? 'In another app' : (!p.cam || !vt ? 'Camera off' : '');
  p.ui.name.textContent = p.name || '…';
  p.ui.root.classList.toggle('muted', !p.mic);
  p.ui.root.classList.toggle('reconnecting', p.reconnecting);
  if (inCall) updateFloat();
}

function layout() {
  const n = people.size;
  if (swapped && n !== swapped.count) unswap();   // someone joined or left: back to the normal view
  $('grid').dataset.n = String(Math.min(n, 5));
  $('self').classList.toggle('full', n === 0);
  $('alone').hidden = n > 0 || !inCall;
  if (inCall) updateFloat();
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

/* floating video (picture-in-picture): the person talking, in a small window that stays over
   other apps, like FaceTime. One video element is kept playing for it during the call (iOS
   only floats a video that is already playing); it shows whoever is talking, switching
   calmly, and a card with their initial when their camera is off. */

const FLOAT_SWITCH_MS = 1500;    // show someone at least this long before switching to another talker
const floatVideo = $('floatVideo');
const floatStream = new MediaStream();
let floatTarget = null, floatSince = 0;

const canFloat = () => !!(floatVideo.requestPictureInPicture && document.pictureInPictureEnabled) ||
  typeof floatVideo.webkitSetPresentationMode === 'function';
const isFloating = () => document.pictureInPictureElement === floatVideo || floatVideo.webkitPresentationMode === 'picture-in-picture';

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
  const shown = floatStream.getVideoTracks();
  if (shown[0] !== track) {
    // Swap the track inside the same stream, so a floating window stays open and switches.
    floatStream.addTrack(track);
    for (const old of shown) floatStream.removeTrack(old);
  }
  if (floatVideo.srcObject !== floatStream) floatVideo.srcObject = floatStream;
  if (floatVideo.paused) floatVideo.play().catch(() => {});
}

async function toggleFloat() {
  if (!inCall) return;
  try {
    if (isFloating()) {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else floatVideo.webkitSetPresentationMode('inline');
      return;
    }
    updateFloat();
    // No waiting before this call: iOS only allows it straight from the tap.
    if (floatVideo.requestPictureInPicture && document.pictureInPictureEnabled) await floatVideo.requestPictureInPicture();
    else floatVideo.webkitSetPresentationMode('picture-in-picture');
  } catch {
    toast('The video can\'t float right now. Try again in a moment.');
  }
}

function endFloat() {
  try { if (document.pictureInPictureElement === floatVideo) document.exitPictureInPicture().catch(() => {}); } catch {}
  try { if (floatVideo.webkitPresentationMode === 'picture-in-picture') floatVideo.webkitSetPresentationMode('inline'); } catch {}
  for (const t of floatStream.getTracks()) floatStream.removeTrack(t);
  floatVideo.srcObject = null;
  floatTarget = null;
  $('cFloat').hidden = true;
  $('cFloat').classList.remove('active');
}

const floatChanged = () => {
  const on = isFloating();
  $('cFloat').classList.toggle('active', on);
  $('cFloat').querySelector('.lb').textContent = on ? 'Floating' : 'Float';
  $('cFloat').setAttribute('aria-pressed', String(on));
};
floatVideo.addEventListener('enterpictureinpicture', floatChanged);
floatVideo.addEventListener('leavepictureinpicture', floatChanged);
floatVideo.addEventListener('webkitpresentationmodechanged', floatChanged);
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

function tuneBitrate() {
  if (!room) return;
  const n = people.size;
  if (!n) return;
  const video = sendProfile(n);
  let all = {};
  try { all = room.getPeers(); } catch {}
  for (const id of Object.keys(all)) {
    const pc = all[id] && all[id].connection;
    if (!pc) continue;
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
        if (e.maxBitrate === AUDIO_BITRATE) continue;
        e.maxBitrate = AUDIO_BITRATE;
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
let netType = '', netChecked = 0, netCheck = null;

function checkNetwork(force) {
  if (netCheck) return netCheck;
  if (!force && netType && Date.now() - netChecked < 60000) return Promise.resolve(netType);
  netCheck = probe().then(t => { netType = t; netChecked = Date.now(); netCheck = null; return t; });
  return netCheck;
}

async function probe() {
  let pc;
  try {
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }] });
    pc.createDataChannel('probe');
    const found = [];
    const done = new Promise(res => {
      const t = setTimeout(res, 4000);
      pc.onicecandidate = e => { if (!e.candidate) { clearTimeout(t); res(); } else found.push(e.candidate); };
    });
    await pc.setLocalDescription(await pc.createOffer());
    await done;
    const mapped = found.filter(c => (c.type || (c.candidate.match(/ typ (\w+)/) || [])[1]) === 'srflx');
    if (!mapped.length) return 'blocked';
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
async function receiving(peerId) {
  let pc = null;
  try { const info = room && room.getPeers()[peerId]; pc = info && info.connection; } catch {}
  if (!pc) return '';
  try {
    let line = '';
    (await pc.getStats()).forEach(s => {
      if (s.type === 'inbound-rtp' && s.kind === 'video' && s.frameHeight) {
        line = `${s.frameHeight}p` + (s.framesPerSecond ? `, ${Math.round(s.framesPerSecond)} fps` : '');
      }
    });
    return line;
  } catch { return ''; }
}

async function renderDetails() {
  if ($('details').hidden) return;
  $('detailsNet').textContent = 'Your network: ' + (NET_LABEL[netType] || 'checking…');
  const list = $('detailsList');
  const items = [];
  for (const p of people.values()) {
    const path = p.peerId ? await connectionPath(p.peerId) : '';
    const video = p.peerId && !p.reconnecting ? await receiving(p.peerId) : '';
    const li = el('li', '', p.name || 'Someone');
    const sub = p.reconnecting ? 'Reconnecting…' : path ? 'Direct connection, ' + path : (p.stream ? 'Connected' : 'Connecting…');
    const theirs = p.net ? ' · their network: ' + p.net : '';
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
const presenceNow = new Map();   // roomKey -> names in that call
const rowRefs = new Map();       // roomKey -> elements of that room's row

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
  const row = rowRefs.get(rk);
  if (row) {
    row.li.classList.toggle('busy', names.length > 0);
    row.sub.textContent = names.length ? whoText(names) : 'Tap to join';
    row.faces.hidden = !names.length;
    row.faces.replaceChildren(
      ...names.slice(0, 3).map(n => el('span', 'face', initials(n))),
      ...(names.length > 3 ? [el('span', 'face more', '+' + (names.length - 3))] : []),
      el('span', 'dot')
    );
    row.faces.setAttribute('aria-label', names.length ? whoText(names) : '');
  }
  if (lobbyRoom && current === 'lobby' && roomKeyOf(lobbyRoom) === rk) {
    $('lobbyWho').hidden = !names.length;
    $('lobbyWho').textContent = names.length ? whoText(names) : '';
  }
}

function onPresence(rk, names, sessions, members) {
  if (inCall && callRoom && rk === roomKeyOf(callRoom)) {
    aliveInCall = sessions || new Set();
    roomMembers = members || [];
    checkUnseen();
  }
  if (names.length) presenceNow.set(rk, names); else presenceNow.delete(rk);
  showPresence(rk, names);
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

// Opened from an invite link: read it, then wipe it from the address bar.
const resume = !location.hash.startsWith('#room=') && recallActive();
if (resume) openLobby(resume, resume.invited, resume.stage === 'call' ? resume : null);

if (location.hash.startsWith('#room=')) {
  const params = new URLSearchParams(location.hash.slice(1));
  const r = { name: clean(params.get('room')).slice(0, 40), key: (params.get('key') || '').trim() };
  history.replaceState({ s: 'home' }, '', location.pathname + location.search);
  if (validRoom(r)) openLobby(r, true);
  else toast('That invite link is incomplete. Ask for it again.');
}
