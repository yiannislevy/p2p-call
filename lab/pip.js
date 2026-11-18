// iPhone check: what does this phone allow a web call to do?
// 1. camera and microphone, 2. floating (picture-in-picture) video of a stream that comes
// through a real WebRTC connection (two connections inside this page, so nothing leaves the
// phone), 3. what keeps running while the page is in another app.

const $ = id => document.getElementById(id);
const results = {
  page: location.pathname,
  userAgent: navigator.userAgent,
  standalone: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
};
const report = () => { $('report').textContent = JSON.stringify(results, null, 2); };
const say = (id, text, ok) => { $(id).textContent = text; $(id).className = 'result ' + (ok === true ? 'ok' : ok === false ? 'bad' : ''); };
report();

let local = null, rx = null;

/* 1. camera and microphone, sent through a loopback call connection */
$('start').addEventListener('click', async () => {
  try {
    local = await navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode: 'user' } });
    $('local').srcObject = local;
    const a = new RTCPeerConnection(), b = new RTCPeerConnection();
    rx = b;
    const gathered = pc => pc.iceGatheringState === 'complete' ? Promise.resolve() : new Promise(r => {
      const done = () => { if (pc.iceGatheringState === 'complete') r(); };
      pc.addEventListener('icegatheringstatechange', done);
      setTimeout(r, 4000);
    });
    const remote = new MediaStream();
    b.ontrack = e => { remote.addTrack(e.track); $('remote').srcObject = remote; $('remote').play().catch(() => {}); };
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

$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('report').textContent); $('copy').textContent = 'Copied'; }
  catch { $('copy').textContent = 'Select the text above and copy it'; }
});
