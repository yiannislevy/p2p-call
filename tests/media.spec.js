import { test, expect } from '@playwright/test';
import { person, createRoom, joinFromHome, joinFromLink, playingVideos, poll, expectClean } from './helpers.js';

// Test-only: keep a handle on peer connections; optionally lose the first N tracks added
// to a connection (as if media never made it onto the link while the link itself is up).
const instrument = drop => {
  const Original = window.RTCPeerConnection;
  window.__pcs = [];
  window.__dropTracks = drop || 0;
  const addTrack = Original.prototype.addTrack;
  Original.prototype.addTrack = function (...args) {
    if (window.__dropTracks > 0) { window.__dropTracks--; return null; }
    return addTrack.apply(this, args);
  };
  window.RTCPeerConnection = function (...args) { const pc = new Original(...args); window.__pcs.push(pc); return pc; };
  window.RTCPeerConnection.prototype = Original.prototype;
  Object.setPrototypeOf(window.RTCPeerConnection, Original);
};

// Bytes of video and sound received so far, over all live connections.
const received = page => page.evaluate(async () => {
  let v = 0, a = 0;
  for (const pc of window.__pcs.filter(p => p.connectionState === 'connected')) {
    (await pc.getStats()).forEach(s => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') v += s.bytesReceived || 0;
      if (s.type === 'inbound-rtp' && s.kind === 'audio') a += s.bytesReceived || 0;
    });
  }
  return { v, a };
});
const flowing = async page => {
  const x = await received(page);
  await page.waitForTimeout(2500);
  const y = await received(page);
  return { video: y.v > x.v, audio: y.a > x.a };
};

test('video and sound that never arrive are sent again automatically', async ({ browser }) => {
  const a = await person(browser), b = await person(browser);
  await a.page.addInitScript(instrument, 0);
  await b.page.addInitScript(instrument, 2);           // Sarra's camera and mic never reach Yianni at first
  const link = await createRoom(a.page, 'family');
  await joinFromHome(a.page, 'family', 'Yianni');
  await joinFromLink(b.page, link, 'Sarra');
  await playingVideos(b.page).toBe(1);                 // Sarra sees Yianni fine
  expect(await a.page.evaluate(() => document.querySelector('#grid .tile .ph-status').textContent)).toBe('Connecting…');

  // Yianni's app notices nothing arrives and asks Sarra's app to send again.
  await playingVideos(a.page, 40000).toBe(1);
  expect(await flowing(a.page)).toEqual({ video: true, audio: true });

  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

test('a camera that stops on its own is replaced, and the others keep seeing you', async ({ browser }) => {
  const a = await person(browser), b = await person(browser);
  await a.page.addInitScript(instrument, 0);
  const link = await createRoom(a.page, 'family');
  await joinFromHome(a.page, 'family', 'Yianni');
  await joinFromLink(b.page, link, 'Sarra');
  await playingVideos(a.page).toBe(1);

  // Sarra's camera stops (iPhone interruption, another app taking the camera).
  await b.page.evaluate(() => document.getElementById('self').srcObject.getVideoTracks()[0].stop());
  await poll(b.page, () => document.getElementById('self').srcObject.getVideoTracks()[0]?.readyState, undefined, 10000).toBe('live');
  await a.page.waitForTimeout(2000);
  expect((await flowing(a.page)).video).toBe(true);
  await playingVideos(a.page).toBe(1);

  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

test('someone in another app with their camera paused is shown as such, then comes back', async ({ browser }) => {
  const a = await person(browser), b = await person(browser);
  await b.page.addInitScript(instrument, 0);
  const link = await createRoom(a.page, 'family');
  await joinFromHome(a.page, 'family', 'Yianni');
  await joinFromLink(b.page, link, 'Sarra');
  await playingVideos(a.page).toBe(1);

  // Sarra switches app: the page is hidden and the phone stops sending her camera.
  await b.page.evaluate(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.__paused = [];
    for (const pc of window.__pcs) for (const s of pc.getSenders()) if (s.track && s.track.kind === 'video') { window.__paused.push([s, s.track]); await s.replaceTrack(null); }
  });
  await poll(a.page, () => document.querySelector('#grid .tile .ph-status').textContent, undefined, 20000).toBe('In another app');

  // She comes back.
  await b.page.evaluate(async () => {
    for (const [s, t] of window.__paused) await s.replaceTrack(t);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await playingVideos(a.page, 20000).toBe(1);

  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

test('a muted person or a camera that is off never sets off resends', async ({ browser }) => {
  const a = await person(browser), b = await person(browser);
  await a.page.addInitScript(instrument, 0);
  await b.page.addInitScript(instrument, 0);
  const link = await createRoom(a.page, 'family');
  await joinFromHome(a.page, 'family', 'Yianni');
  await joinFromLink(b.page, link, 'Sarra');
  await playingVideos(a.page).toBe(1);
  const before = await b.page.evaluate(() => window.__pcs.length);
  await b.page.click('#cMic');
  await b.page.click('#cCam');
  await a.page.waitForTimeout(20000);
  // No new connections or renegotiations were needed, and the tile simply says camera off.
  expect(await b.page.evaluate(() => window.__pcs.length)).toBe(before);
  expect(await a.page.evaluate(() => document.querySelector('#grid .tile .ph-status').textContent)).toBe('Camera off');
  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

// Test-only: the connection library skips one update offering our camera and microphone,
// as it can when the update comes while it is still finishing the previous one.
const skipOneUpdate = () => {
  window.__resends = 0;
  window.__skipUpdates = 0;
  const P = window.RTCPeerConnection.prototype;
  const desc = Object.getOwnPropertyDescriptor(P, 'onnegotiationneeded');
  Object.defineProperty(P, 'onnegotiationneeded', {
    configurable: true,
    get() { return desc.get.call(this); },
    set(h) {
      desc.set.call(this, h && function (e) {
        if (this.connectionState === 'connected' && window.__skipUpdates > 0) { window.__skipUpdates--; return; }
        return h.call(this, e);
      });
    }
  });
  const removeTrack = P.removeTrack;
  P.removeTrack = function (...a) { window.__resends++; return removeTrack.apply(this, a); };
};

test('an update the connection library skipped is offered again by the sender', async ({ browser }) => {
  const a = await person(browser), b = await person(browser);
  // Yianni sends nothing himself, so only Sarra's own update can carry her camera to him.
  await a.page.addInitScript(instrument, 1000);
  await b.page.addInitScript(skipOneUpdate);
  await b.page.addInitScript(() => { window.__skipUpdates = 1; });
  const link = await createRoom(a.page, 'family');
  await joinFromHome(a.page, 'family', 'Yianni');
  await joinFromLink(b.page, link, 'Sarra');
  await playingVideos(a.page, 20000).toBe(1);
  expect(await flowing(a.page)).toEqual({ video: true, audio: true });
  // Sarra's own app fixed it: nobody had to ask her to send again.
  expect(await b.page.evaluate(() => [window.__skipUpdates, window.__resends])).toEqual([0, 0]);
  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

test('video that arrives but is not shown on screen is shown again', async ({ browser }) => {
  const a = await person(browser), b = await person(browser);
  const link = await createRoom(a.page, 'family');
  await joinFromHome(a.page, 'family', 'Yianni');
  await joinFromLink(b.page, link, 'Sarra');
  await playingVideos(a.page).toBe(1);
  // Yianni's phone stops drawing Sarra's video although it keeps arriving (black tile),
  // and playing it again doesn't help; only pointing the element at the stream again does.
  await a.page.evaluate(() => {
    const v = document.querySelector('#grid .tile video');
    const real = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
    v.pause();
    v.play = () => Promise.resolve();
    Object.defineProperty(v, 'srcObject', {
      configurable: true,
      get() { return real.get.call(v); },
      set(s) { real.set.call(v, s); if (s) { window.__fixed = true; delete v.play; delete v.srcObject; } }
    });
  });
  await poll(a.page, () => window.__fixed === true, undefined, 20000).toBe(true);
  const shown = () => a.page.evaluate(() => document.querySelector('#grid .tile video').__shown);
  const before = await shown();
  await a.page.waitForTimeout(1500);
  expect(await shown()).toBeGreaterThan(before + 5);
  expectClean(a, b);
  await a.context.close(); await b.context.close();
});
