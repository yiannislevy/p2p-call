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

let local = null;

/* 1. camera and microphone, sent through a loopback call connection */
$('start').addEventListener('click', async () => {
  try {
    local = await navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode: 'user' } });
    $('local').srcObject = local;
    const a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.onicecandidate = e => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = e => e.candidate && a.addIceCandidate(e.candidate);
    b.ontrack = e => { $('remote').srcObject = e.streams[0]; $('remote').play().catch(() => {}); };
    for (const t of local.getTracks()) a.addTrack(t, local);
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);
    results.camera = 'ok';
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

$('pip').addEventListener('click', async () => {
  const v = $('remote');
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
  const timer = setInterval(() => { ticks++; }, 1000);
  bgTest = { rec, chunks, timer, ticksAt: () => ticks, hiddenAt: 0, hiddenTicks: 0, videoFrames: 0 };
  const v = $('remote');
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
    return;
  }
  if (!bgTest.hiddenAt) return;
  const away = (Date.now() - bgTest.hiddenAt) / 1000;
  const ticksAway = bgTest.ticksAt() - bgTest.hiddenTicks;
  clearInterval(bgTest.timer);
  let micSeconds = null;
  if (bgTest.rec) {
    await new Promise(r => { bgTest.rec.onstop = r; bgTest.rec.stop(); });
    try {
      const blob = new Blob(bgTest.chunks, { type: bgTest.rec.mimeType });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
      micSeconds = buf.duration;
    } catch (e) { results.decode = `${e.name}: ${e.message}`; }
  }
  const tracks = local.getTracks().map(t => `${t.kind}: ${t.readyState}${t.muted ? ', muted' : ''}`);
  results.background = {
    secondsAway: Math.round(away),
    pageTimersRanSeconds: ticksAway,
    microphoneRecordedSeconds: micSeconds == null ? 'unknown' : Math.round(micSeconds),
    callVideoFramesWhileAway: bgTest.videoFrames,
    tracksAfterReturn: tracks
  };
  const keptPage = ticksAway >= away * 0.8;
  say('bgResult',
    `Away ${Math.round(away)} s. Page kept running: ${keptPage ? 'yes' : 'no'} (${ticksAway} s). ` +
    `Microphone recorded: ${micSeconds == null ? 'unknown' : Math.round(micSeconds) + ' s'}. ` +
    `Video frames while away: ${bgTest.videoFrames}.`, keptPage);
  bgTest = null;
  report();
});

$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('report').textContent); $('copy').textContent = 'Copied'; }
  catch { $('copy').textContent = 'Select the text above and copy it'; }
});
