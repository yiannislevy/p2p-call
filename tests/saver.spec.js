import { test, expect } from '@playwright/test';
import { person, createRoom, joinFromHome, joinFromLink, playingVideos, poll, expectClean } from './helpers.js';

// Data saver: lighter video for people on mobile data, both what they send and what they get.

const track = () => {
  const O = window.RTCPeerConnection; window.__pcs = [];
  window.RTCPeerConnection = function (...x) { const pc = new O(...x); window.__pcs.push(pc); return pc; };
  window.RTCPeerConnection.prototype = O.prototype; Object.setPrototypeOf(window.RTCPeerConnection, O);
};
// The video limit this side currently sends with.
const videoCap = page => page.evaluate(() => {
  for (const pc of window.__pcs.filter(p => p.connectionState === 'connected')) {
    for (const s of pc.getSenders()) if (s.track && s.track.kind === 'video') return s.getParameters().encodings[0].maxBitrate || 0;
  }
  return -1;
});

test('data saver lowers the video both ways, says so, and is remembered', async ({ browser }) => {
  const a = await person(browser), b = await person(browser);
  for (const p of [a, b]) await p.page.addInitScript(track);
  const link = await createRoom(a.page, 'alpha');
  await joinFromHome(a.page, 'alpha', 'Peer C');
  await joinFromLink(b.page, link, 'Peer B');
  await playingVideos(a.page).toBe(1);
  await expect.poll(() => videoCap(a.page), { timeout: 15000 }).toBe(4000000);

  await a.page.click('#whoBtn');
  await expect(a.page.locator('#saverSeg [data-saver="auto"]')).toHaveAttribute('aria-checked', 'true');
  await a.page.click('#saverSeg [data-saver="on"]');
  await expect(a.page.locator('#saverNote')).toContainText('instead of');
  await a.page.click('#detailsClose');
  await expect(a.page.locator('#callMeta')).toContainText('Data saver');
  await expect.poll(() => videoCap(a.page), { timeout: 10000 }).toBe(600000);   // what Peer C sends
  await expect.poll(() => videoCap(b.page), { timeout: 10000 }).toBe(600000);   // what Peer C gets

  await a.page.click('#whoBtn');
  await a.page.click('#saverSeg [data-saver="off"]');
  await a.page.click('#detailsClose');
  await expect.poll(() => videoCap(a.page), { timeout: 10000 }).toBe(4000000);
  await expect.poll(() => videoCap(b.page), { timeout: 10000 }).toBe(4000000);
  expect(await a.page.evaluate(() => JSON.parse(localStorage.getItem('plaincall.v1')).saver)).toBe('off');
  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

test('on a phone that says it is on mobile data, Auto turns data saver on', async ({ browser }) => {
  const a = await person(browser), b = await person(browser);
  await a.page.addInitScript(() => {
    const c = new EventTarget(); c.type = 'cellular'; c.saveData = false;
    Object.defineProperty(navigator, 'connection', { configurable: true, get: () => c });
  });
  const link = await createRoom(a.page, 'alpha');
  await joinFromHome(a.page, 'alpha', 'Peer C');
  await joinFromLink(b.page, link, 'Peer B');
  await playingVideos(a.page).toBe(1);
  await expect(a.page.locator('#callMeta')).toContainText('Data saver');
  await a.page.click('#whoBtn');
  await expect(a.page.locator('#saverNote')).toContainText('On, because this phone is on mobile data');
  expectClean(a, b);
  await a.context.close(); await b.context.close();
});
