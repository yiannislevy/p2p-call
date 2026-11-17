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
  const link = await createRoom(a.page, 'family');
  await joinFromHome(a.page, 'family', 'Yianni');
  await joinFromLink(b.page, link, 'Sarra');
  await playingVideos(a.page).toBe(1);

  // The camera is asked for 1080p.
  const h = await a.page.evaluate(() => document.getElementById('self').srcObject.getVideoTracks()[0].getSettings().height);
  expect(h).toBe(1080);

  await allMatch(a.page, 'video', { maxBitrate: 4000000, scale: 1 }).toBe(true);
  await allMatch(a.page, 'audio', { maxBitrate: 64000, scale: 1 }).toBe(true);
  await allMatch(b.page, 'video', { maxBitrate: 4000000, scale: 1 }).toBe(true);

  // Connection details show what is actually arriving.
  await a.page.click('#whoBtn');
  await expect(a.page.locator('#detailsList li .d-sub', { hasText: /^Video: \d+p/ })).toHaveCount(1, { timeout: 15000 });
  await a.page.click('#detailsClose');

  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

test('groups share upload fairly, and it goes back up when people leave', async ({ browser }) => {
  const [a, b, c, d] = await people(browser, 4);
  const link = await createRoom(a.page, 'family');
  await joinFromHome(a.page, 'family', 'Yianni');
  await joinFromLink(b.page, link, 'Sarra');
  await joinFromLink(c.page, link, 'Mama');
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
  const link = await createRoom(a.page, 'family');
  await joinFromHome(a.page, 'family', 'Yianni');
  await joinFromLink(b.page, link, 'Sarra');
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
