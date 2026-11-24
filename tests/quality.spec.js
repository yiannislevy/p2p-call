import { test, expect } from '@playwright/test';
import { person, createRoom, joinFromHome, joinFromLink, playingVideos, poll, expectClean } from './helpers.js';

// Test-only: keep a handle on every peer connection to read what is being sent.
const track = () => {
  const Original = window.RTCPeerConnection;
  window.__pcs = [];
  window.RTCPeerConnection = function (...args) { const pc = new Original(...args); window.__pcs.push(pc); return pc; };
  window.RTCPeerConnection.prototype = Original.prototype;
  Object.setPrototypeOf(window.RTCPeerConnection, Original);
};

// Encoding settings of every live sender: [{ kind, maxBitrate, scale }]
const senders = page => page.evaluate(() => window.__pcs
  .filter(pc => pc.connectionState === 'connected')
  .flatMap(pc => pc.getSenders().filter(s => s.track).map(s => {
    const e = (s.getParameters().encodings || [])[0] || {};
    return { kind: s.track.kind, maxBitrate: e.maxBitrate || 0, scale: e.scaleResolutionDownBy || 1 };
  })));

const allMatch = (page, kind, want) => poll(page, ([k, w]) => {
  const list = window.__pcs.filter(pc => pc.connectionState === 'connected')
    .flatMap(pc => pc.getSenders().filter(s => s.track && s.track.kind === k).map(s => (s.getParameters().encodings || [])[0] || {}));
  return list.length > 0 && list.every(e => e.maxBitrate === w.maxBitrate && (e.scaleResolutionDownBy || 1) === w.scale);
}, [kind, want], 20000);

async function people(browser, n) {
  const list = [];
  for (let i = 0; i < n; i++) { const p = await person(browser); await p.page.addInitScript(track); list.push(p); }
  return list;
}

test('1-on-1: camera in Full HD, up to 4 Mbps of video and clearer voice', async ({ browser }) => {
  const [a, b] = await people(browser, 2);
  const link = await createRoom(a.page, 'alpha');
  await joinFromHome(a.page, 'alpha', 'Peer C');
  await joinFromLink(b.page, link, 'Peer B');
  await playingVideos(a.page).toBe(1);

  // The camera is asked for 1080p.
  const h = await a.page.evaluate(() => document.getElementById('self').srcObject.getVideoTracks()[0].getSettings().height);
  expect(h).toBe(1080);

  await allMatch(a.page, 'video', { maxBitrate: 4000000, scale: 1 }).toBe(true);
  await allMatch(a.page, 'audio', { maxBitrate: 64000, scale: 1 }).toBe(true);
  await allMatch(b.page, 'video', { maxBitrate: 4000000, scale: 1 }).toBe(true);

  // Connection details show what is actually arriving.
  await a.page.click('#whoBtn');
  await expect(a.page.locator('#detailsList li:not(.you) .d-fmt', { hasText: /^\d+p · / })).toHaveCount(1, { timeout: 15000 });
  await a.page.click('#detailsClose');

  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

test('groups share upload fairly, and it goes back up when people leave', async ({ browser }) => {
  const [a, b, c, d] = await people(browser, 4);
  const link = await createRoom(a.page, 'alpha');
  await joinFromHome(a.page, 'alpha', 'Peer C');
  await joinFromLink(b.page, link, 'Peer B');
  await joinFromLink(c.page, link, 'Peer A');
  for (const p of [a, b, c]) await playingVideos(p.page).toBe(2);
  // Three people: 720p at up to 2.5 Mbps to each.
  for (const p of [a, b, c]) await allMatch(p.page, 'video', { maxBitrate: 2500000, scale: 1.5 }).toBe(true);

  await joinFromLink(d.page, link, 'Nikos');
  for (const p of [a, b, c, d]) await playingVideos(p.page).toBe(3);
  // Four people: 720p at up to 1.6 Mbps to each.
  for (const p of [a, b, c, d]) await allMatch(p.page, 'video', { maxBitrate: 1600000, scale: 1.5 }).toBe(true);
  for (const p of [a, b, c, d]) await allMatch(p.page, 'audio', { maxBitrate: 64000, scale: 1 }).toBe(true);

  // Back to two people: Full HD at up to 4 Mbps again.
  await c.page.click('#cLeave');
  await d.page.click('#cLeave');
  await playingVideos(a.page).toBe(1);
  await allMatch(a.page, 'video', { maxBitrate: 4000000, scale: 1 }).toBe(true);

  expect((await senders(a.page)).length).toBeGreaterThan(0);
  expectClean(a, b, c, d);
  for (const p of [a, b, c, d]) await p.context.close();
});

test('flipping the camera keeps the quality settings', async ({ browser }) => {
  const [a, b] = await people(browser, 2);
  const link = await createRoom(a.page, 'alpha');
  await joinFromHome(a.page, 'alpha', 'Peer C');
  await joinFromLink(b.page, link, 'Peer B');
  await playingVideos(b.page).toBe(1);
  await allMatch(a.page, 'video', { maxBitrate: 4000000, scale: 1 }).toBe(true);

  // Fake browsers have one camera, so drive the same path the Flip button uses.
  await a.page.evaluate(() => { document.getElementById('cFlip').hidden = false; });
  await a.page.click('#cFlip');
  await a.page.waitForTimeout(1500);
  await allMatch(a.page, 'video', { maxBitrate: 4000000, scale: 1 }).toBe(true);
  await playingVideos(b.page).toBe(1);

  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

test('voice is sent with redundancy, so a lost packet does not cut a word', async ({ browser }) => {
  const [a, b] = await people(browser, 2);
  const link = await createRoom(a.page, 'alpha');
  await joinFromHome(a.page, 'alpha', 'Peer C');
  await joinFromLink(b.page, link, 'Peer B');
  await playingVideos(a.page).toBe(1);
  // The voice format both sides agreed on: redundancy first (the browser's statistics name
  // only the inner format, so read the agreement itself).
  const agreed = page => page.evaluate(() => window.__pcs.filter(p => p.connectionState === 'connected').map(pc => {
    const sdp = (pc.currentRemoteDescription || {}).sdp || '';
    const m = sdp.match(/^m=audio \S+ \S+ (\d+)/m);
    const red = sdp.match(/^a=rtpmap:(\d+) red\/48000/m);
    return !!(m && red && m[1] === red[1]);
  }));
  await expect.poll(() => agreed(a.page), { timeout: 15000 }).toEqual([true]);
  await expect.poll(() => agreed(b.page), { timeout: 15000 }).toEqual([true]);
  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

test('connection details show the video format and how much data it takes', async ({ browser }) => {
  const [a, b] = await people(browser, 2);
  const link = await createRoom(a.page, 'alpha');
  await joinFromHome(a.page, 'alpha', 'Peer C');
  await joinFromLink(b.page, link, 'Peer B');
  await playingVideos(a.page).toBe(1);
  await a.page.click('#whoBtn');
  await expect(a.page.locator('#detailsList li', { hasText: 'Peer B' })).toContainText(/\d+p · (VP8|VP9|H\.264|H\.265|AV1)/, { timeout: 15000 });
  await expect(a.page.locator('#detailsList li', { hasText: 'Peer B' }).locator('.d-mbps')).toHaveText(/^[\d.]+ (kbps|Mbps)$/, { timeout: 15000 });
  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

test('where the device has H.265, it is preferred for video', async ({ browser }) => {
  const [a, b] = await people(browser, 2);
  // Stand in for a device whose browser offers H.265 (test browsers here have no hardware for it).
  await a.page.addInitScript(() => {
    const caps = RTCRtpReceiver.getCapabilities.bind(RTCRtpReceiver);
    RTCRtpReceiver.getCapabilities = kind => {
      const c = caps(kind);
      if (kind === 'video') c.codecs = [...c.codecs, { mimeType: 'video/H265', clockRate: 90000, sdpFmtpLine: 'level-id=93;profile-id=1;tier-flag=0;tx-mode=SRST' }];
      return c;
    };
    window.__firstVideoPref = '';
    const set = RTCRtpTransceiver.prototype.setCodecPreferences;
    RTCRtpTransceiver.prototype.setCodecPreferences = function (codecs) {
      if (codecs[0] && codecs[0].mimeType.startsWith('video/') && !window.__firstVideoPref) window.__firstVideoPref = codecs[0].mimeType;
      return set.call(this, codecs);
    };
  });
  const link = await createRoom(a.page, 'alpha');
  await joinFromHome(a.page, 'alpha', 'Peer C');
  await joinFromLink(b.page, link, 'Peer B');
  await playingVideos(a.page).toBe(1);   // the call works as before
  await playingVideos(b.page).toBe(1);
  expect(await a.page.evaluate(() => window.__firstVideoPref)).toBe('video/H265');
  expectClean(a, b);
  await a.context.close(); await b.context.close();
});
