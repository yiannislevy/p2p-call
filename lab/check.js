// Call check: what this phone and network allow a web call to do.
// 1. the network: how it hands out public ports (asks public STUN helpers, like any call),
// 2. camera and microphone through a call connection inside this page (nothing leaves the phone),
// 3-5 (iPhone): floating video, what keeps running in another app, switching while floating.
// Nothing is saved or sent: people copy the results and send them themselves.

const $ = id => document.getElementById(id);
const results = {
  who: '', on: '', carrier: '',
  page: location.pathname,
  userAgent: navigator.userAgent,
  standalone: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
};
const report = () => { $('report').textContent = JSON.stringify(results, null, 2); };
const say = (id, text, ok) => { $(id).textContent = text; $(id).className = 'result ' + (ok === true ? 'ok' : ok === false ? 'bad' : ''); };
report();

for (const id of ['who', 'carrier']) $(id).addEventListener('input', () => { results[id] = $(id).value.trim().slice(0, 40); report(); });
for (const chip of document.querySelectorAll('#netChoice .chip')) {
  chip.addEventListener('click', () => {
    for (const c of document.querySelectorAll('#netChoice .chip')) c.classList.toggle('on', c === chip);
    results.on = chip.dataset.net;
    report();
  });
}

/* 1. network: how does it hand out public ports? Each call connection asks public helpers
   which address and port the network gave it. Ports that stay the same for every helper are
   easy; ports that change per helper need the other side to be easy, unless they change in a
   predictable order (that's what port guessing would use). */
const HELPERS = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302',
  'stun:stun3.l.google.com:19302', 'stun:stun4.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];

async function askHelpers() {
  const pc = new RTCPeerConnection({ iceServers: HELPERS.map(urls => ({ urls })) });
  pc.createDataChannel('check');
  const found = [];
  const done = new Promise(res => {
    const t = setTimeout(res, 5000);
    pc.onicecandidate = e => { if (!e.candidate) { clearTimeout(t); res(); } else found.push(e.candidate); };
  });
  await pc.setLocalDescription(await pc.createOffer());
  await done;
  pc.close();
  return found.map(c => {
    const f = c.candidate.split(' ');
    const r = f.indexOf('rport');
    return { type: c.type || f[7], addr: c.address || f[4] || '', port: Number(c.port || f[5]),
      base: Number(c.relatedPort || (r > 0 ? f[r + 1] : 0)) || 0, proto: String(c.protocol || f[2]).toLowerCase() };
  });
}

function judge(rounds) {
  const all = rounds.flat();
  if (!all.length) return { verdict: 'blocked' };
  const same = rounds.every(r => new Set(r).size <= 1);
  if (same) return { verdict: 'same port for everyone' };
  const sorted = [...all].sort((a, b) => a - b);
  const span = sorted[sorted.length - 1] - sorted[0];
  const steps = sorted.slice(1).map((p, i) => p - sorted[i]).filter(d => d > 0);
  const step = steps.length ? Math.min(...steps) : 0;
  if (span <= all.length * 8) return { verdict: 'changes, in order', step };
  return { verdict: 'changes, at random' };
}

const VERDICT = {
  'same port for everyone': ['Good: your network keeps one address for everyone, so direct calls work with almost anyone.', true],
  'changes, in order': ['Your network gives each destination a new port, but in order. Calls with another network like this fail today; this is the case port guessing could fix.', null],
  'changes, at random': ['Your network gives each destination a random port. Calls work with people on normal wifi, but not with another network like this.', false],
  blocked: ['Your network blocks this kind of connection. Calls only work from another network (mobile data or other wifi).', false]
};

$('net').addEventListener('click', async () => {
  $('net').disabled = true;
  say('netResult', 'Testing…');
  try {
    const t0 = Date.now();
    const rounds = [];
    let preserves = false, ipv6 = false;
    for (let i = 0; i < 3; i++) {
      const cands = await askHelpers();
      const mapped = cands.filter(c => c.type === 'srflx' && c.proto === 'udp' && !c.addr.includes(':'));
      rounds.push(mapped.map(c => c.port));
      if (mapped.some(c => c.base && c.port === c.base)) preserves = true;
      if (cands.some(c => c.addr.includes(':') && !/^(fe80|fc|fd)/i.test(c.addr) && !c.addr.endsWith('.local'))) ipv6 = true;
    }
    const j = judge(rounds);
    const run = { on: results.on || 'not said', ...j, ports: rounds.map(r => r.join(' ')), keepsPhonePort: preserves, ipv6, seconds: Math.round((Date.now() - t0) / 1000) };
    (results.network = results.network || []).push(run);
    const [text, ok] = VERDICT[j.verdict];
    say('netResult', text + (ipv6 ? ' It also has IPv6, which helps.' : ' No IPv6.'), ok);
  } catch (e) {
    (results.network = results.network || []).push({ on: results.on || 'not said', error: `${e.name}: ${e.message}` });
    say('netResult', 'The test could not run: ' + e.name, false);
  }
  $('net').disabled = false;
  report();
});

let local = null, rx = null;

/* 1. camera and microphone, sent through a loopback call connection */
$('start').addEventListener('click', async () => {
  try {
    local = await navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode: 'user' } });
    $('local').srcObject = local;
    $('local').classList.add('live');
    const a = new RTCPeerConnection(), b = new RTCPeerConnection();
    rx = b;
    const gathered = pc => pc.iceGatheringState === 'complete' ? Promise.resolve() : new Promise(r => {
      const done = () => { if (pc.iceGatheringState === 'complete') r(); };
      pc.addEventListener('icegatheringstatechange', done);
      setTimeout(r, 4000);
    });
    const remote = new MediaStream();
    b.ontrack = e => { remote.addTrack(e.track); $('remote').srcObject = remote; $('remote').classList.add('live'); $('remote').play().catch(() => {}); };
    for (const t of local.getTracks()) a.addTrack(t, local);
    await a.setLocalDescription(await a.createOffer());
    await gathered(a);
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await gathered(b);
    await a.setRemoteDescription(b.localDescription);
    results.camera = 'ok';
    const v = $('remote');
    const t0 = Date.now();
    while (v.readyState < 2 && Date.now() - t0 < 10000) await new Promise(r => setTimeout(r, 200));
    results.callVideo = v.readyState >= 2 ? `ok, ${v.videoWidth}x${v.videoHeight}` : `no picture (connection ${b.connectionState})`;
    if (v.readyState < 2) { say('startResult', 'Camera works, but the call video did not arrive.', false); report(); return; }
    say('startResult', 'Camera and microphone work.', true);
    $('pip').disabled = false;
    $('bg').disabled = false;
    $('swB').disabled = false;
    prepareSwitch();
  } catch (e) {
    results.camera = `${e.name}: ${e.message}`;
    say('startResult', 'Could not start: ' + e.name, false);
  }
  report();
});

/* 2. floating video */
results.pipApi = {
  standard: 'pictureInPictureEnabled' in document ? document.pictureInPictureEnabled : 'missing',
  webkit: typeof HTMLVideoElement.prototype.webkitSetPresentationMode === 'function'
};
report();

async function float(v) {
  try {
    if (v.requestPictureInPicture && document.pictureInPictureEnabled) {
      await v.requestPictureInPicture();
      results.pip = 'ok (standard)';
    } else if (v.webkitSupportsPresentationMode && v.webkitSupportsPresentationMode('picture-in-picture')) {
      v.webkitSetPresentationMode('picture-in-picture');
      await new Promise(r => setTimeout(r, 800));
      results.pip = v.webkitPresentationMode === 'picture-in-picture' ? 'ok (webkit)' : 'no window appeared (webkit)';
    } else {
      results.pip = 'not offered for this video';
    }
  } catch (e) {
    results.pip = `${e.name}: ${e.message}`;
  }
  results.pip += ` (video ready ${v.readyState}, ${v.videoWidth}x${v.videoHeight})`;
}
$('pip').addEventListener('click', async () => {
  await float($('remote'));
  results.pipCallVideo = results.pip;
  if (!results.pip.startsWith('ok')) {
    await float($('local'));
    results.pipCameraVideo = results.pip;
    results.pip = results.pipCallVideo;
  }
  say('pipResult', results.pip.startsWith('ok') ? 'The video floats. Now switch to another app: does it keep moving?' : 'Not allowed: ' + results.pip, results.pip.startsWith('ok'));
  report();
});

/* 3. another app: did the microphone, camera, page timers and the call connection keep going? */
let bgTest = null;
$('bg').addEventListener('click', () => {
  if (!local) return;
  const audio = new MediaStream(local.getAudioTracks());
  const chunks = [];
  let rec = null;
  try {
    rec = new MediaRecorder(audio);
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    rec.start(1000);
  } catch (e) { results.recorder = `${e.name}: ${e.message}`; }
  let ticks = 0;
  const tickTimes = [];
  const timer = setInterval(() => { ticks++; if (bgTest && bgTest.hiddenAt) tickTimes.push(Math.round((Date.now() - bgTest.hiddenAt) / 1000)); }, 1000);
  bgTest = { rec, chunks, timer, tickTimes, ticksAt: () => ticks, hiddenAt: 0, hiddenTicks: 0, videoFrames: 0, recStart: Date.now(), audioIn: null };
  const v = $('remote');
  // let iOS float the call video by itself when leaving, like FaceTime
  v.autoPictureInPicture = true;
  v.setAttribute('autopictureinpicture', '');
  bgTest.floatingWhenLeft = null;
  if (v.requestVideoFrameCallback) {
    const count = () => { if (document.visibilityState === 'hidden') bgTest.videoFrames++; v.requestVideoFrameCallback(count); };
    v.requestVideoFrameCallback(count);
  }
  say('bgResult', 'Now switch to another app for about 20 seconds, then come back.');
});

document.addEventListener('visibilitychange', async () => {
  if (!bgTest) return;
  if (document.visibilityState === 'hidden') {
    bgTest.hiddenAt = Date.now();
    bgTest.hiddenTicks = bgTest.ticksAt();
    bgTest.tappedFloat = !!document.pictureInPictureElement;
    setTimeout(() => { if (bgTest) bgTest.floatingWhenLeft = !!document.pictureInPictureElement || $('remote').webkitPresentationMode === 'picture-in-picture'; }, 1500);
    bgTest.audioIn = await withTimeout(audioPackets(), 2000, null);
    return;
  }
  if (!bgTest.hiddenAt) return;
  const t = bgTest;
  bgTest = null;
  try { await finishBackground(t); }
  catch (e) { results.backgroundError = `${e.name}: ${e.message}`; say('bgResult', 'The test hit an error: ' + e.name, false); }
  report();
});

const withTimeout = (p, ms, fallback) => Promise.race([p, new Promise(r => setTimeout(() => r(fallback), ms))]);

async function finishBackground(bgTest) {
  const away = (Date.now() - bgTest.hiddenAt) / 1000;
  const ticksAway = bgTest.ticksAt() - bgTest.hiddenTicks;
  const audioInAfter = await withTimeout(audioPackets(), 2000, null);
  const callAudioPerSecond = bgTest.audioIn == null || audioInAfter == null ? 'unknown' : Math.round((audioInAfter - bgTest.audioIn) / away);
  clearInterval(bgTest.timer);
  let micSeconds = null;
  if (bgTest.rec) {
    results.recorderStateOnReturn = bgTest.rec.state;
    if (bgTest.rec.state !== 'inactive') await withTimeout(new Promise(r => { bgTest.rec.onstop = r; bgTest.rec.stop(); }), 3000);
    try {
      const blob = new Blob(bgTest.chunks, { type: bgTest.rec.mimeType });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const buf = await withTimeout(ctx.decodeAudioData(await blob.arrayBuffer()), 5000, null);
      if (!buf) throw new Error('could not read the recording');
      micSeconds = buf.duration;
      // which seconds while away were pure digital silence (a paused microphone), not room sound
      const data = buf.getChannelData(0), sr = buf.sampleRate;
      const from = Math.max(0, (bgTest.hiddenAt - bgTest.recStart) / 1000);
      let silent = 0, total = 0;
      for (let s = Math.floor(from); s < Math.min(buf.duration, from + away); s++) {
        let peak = 0;
        for (let i = s * sr; i < (s + 1) * sr && i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
        total++; if (peak < 1e-5) silent++;
      }
      results.micSecondsSilentWhileAway = `${silent} of ${total}`;
    } catch (e) { results.decode = `${e.name}: ${e.message}`; }
  }
  const tracks = local.getTracks().map(t => `${t.kind}: ${t.readyState}${t.muted ? ', muted' : ''}`);
  results.background = {
    secondsAway: Math.round(away),
    pageTimersRanSeconds: ticksAway,
    microphoneRecordedSeconds: micSeconds == null ? 'unknown' : Math.round(micSeconds),
    pageTickedAtSeconds: bgTest.tickTimes.join(' '),
    callAudioPacketsPerSecondWhileAway: callAudioPerSecond,
    callVideoFramesWhileAway: bgTest.videoFrames,
    callConnection: rx ? rx.connectionState : 'none',
    floatedByItself: bgTest.tappedFloat ? 'was already floating' : bgTest.floatingWhenLeft,
    tracksAfterReturn: tracks
  };
  const keptPage = ticksAway >= away * 0.8;
  say('bgResult',
    `Away ${Math.round(away)} s. Page kept running: ${keptPage ? 'yes' : 'no'} (${ticksAway} s). ` +
    `Microphone recorded: ${micSeconds == null ? 'unknown' : Math.round(micSeconds) + ' s'}. ` +
    `Video frames while away: ${bgTest.videoFrames}.`, keptPage);
}

async function audioPackets() {
  if (!rx) return null;
  try {
    let n = 0;
    (await rx.getStats()).forEach(r => { if (r.type === 'inbound-rtp' && r.kind === 'audio') n += r.packetsReceived || 0; });
    return n;
  } catch { return null; }
}

/* 4. switching while floating: the app swaps who is shown inside one floating video.
   A: swap the track inside the same stream (what the app does). B: give the video a new stream. */
let card = null, swTimer = 0;
function cardTrack() {
  if (card) return card.track;
  const c = document.createElement('canvas');
  c.width = 360; c.height = 480;
  const g = c.getContext('2d');
  let n = 0;
  const draw = () => {
    g.fillStyle = n++ % 2 ? '#2f5d8a' : '#2f6b4a'; g.fillRect(0, 0, 360, 480);
    g.fillStyle = '#fff'; g.font = '600 64px -apple-system, sans-serif'; g.textAlign = 'center';
    g.fillText('S', 180, 260); g.font = '24px -apple-system, sans-serif'; g.fillText(new Date().toLocaleTimeString(), 180, 330);
  };
  draw();
  setInterval(draw, 500);
  card = { track: c.captureStream(10).getVideoTracks()[0] };
  return card.track;
}
const swStream = new MediaStream();
function prepareSwitch() {
  const v = $('sw');
  const cam = $('remote').srcObject && $('remote').srcObject.getVideoTracks()[0];
  if (!cam) return;
  swStream.addTrack(cam);
  v.srcObject = swStream;
  v.play().catch(() => {});
  cardTrack();
}
function startSwitching(mode) {
  const v = $('sw');
  const cam = $('remote').srcObject.getVideoTracks()[0];
  const sw = results.switching = { mode, switches: 0, windowClosedBySwitch: 0, framesWhileFloating: 0 };
  let shown = 0;
  const count = () => { if (document.pictureInPictureElement === v) shown++; v.requestVideoFrameCallback && v.requestVideoFrameCallback(count); };
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(count);
  let switching = false;
  v.onleavepictureinpicture = () => { if (switching) sw.windowClosedBySwitch++; };
  clearInterval(swTimer);
  swTimer = setInterval(() => {
    if (document.pictureInPictureElement !== v) {
      if (sw.switches) { clearInterval(swTimer); sw.framesWhileFloating = shown; finish(); }
      return;
    }
    switching = true;
    const next = (v.srcObject.getVideoTracks()[0] === cam) ? cardTrack() : cam;
    if (mode === 'picture') {
      const old = swStream.getVideoTracks();
      swStream.addTrack(next);
      for (const t of old) swStream.removeTrack(t);
    } else {
      v.srcObject = new MediaStream([next]);
      v.play().catch(() => {});
    }
    sw.switches++;
    setTimeout(() => { switching = false; sw.framesWhileFloating = shown; report(); }, 1500);
  }, 3000);
  const finish = () => say('swResult', `Switched ${sw.switches} times. The floating window closed on a switch ${sw.windowClosedBySwitch} times. Did the picture change in the window?`, sw.windowClosedBySwitch === 0);
  say('swResult', 'Floating. Go to another app and watch it switch, then come back and close it.');
  report();
}
for (const [id, mode] of [['swB', 'video']]) {
  $(id).addEventListener('click', async () => {
    const v = $('sw');
    if (mode === 'picture' && v.srcObject !== swStream) { v.srcObject = swStream; }
    try { await v.requestPictureInPicture(); startSwitching(mode); }
    catch (e) { results.switching = { mode, error: `${e.name}: ${e.message}` }; say('swResult', 'Could not float: ' + e.name, false); report(); }
  });
}

$('share').hidden = !navigator.share;
$('share').addEventListener('click', () => { navigator.share({ title: 'Call check results', text: $('report').textContent }).catch(() => {}); });

$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('report').textContent); $('copy').textContent = 'Copied'; }
  catch { $('copy').textContent = 'Select the text above and copy it'; }
});
