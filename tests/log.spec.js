import { test, expect } from '@playwright/test';
import { person, createRoom, joinFromHome, joinFromLink, playingVideos, poll, expectClean } from './helpers.js';

// "Copy connection log" in the details: the timeline of connections and of every reason the
// app reconnected, to send when calls misbehave. Only states, types and reasons: no addresses.

const track = () => {
  const O = window.RTCPeerConnection; window.__pcs = [];
  window.RTCPeerConnection = function (...x) { const pc = new O(...x); window.__pcs.push(pc); return pc; };
  window.RTCPeerConnection.prototype = O.prototype; Object.setPrototypeOf(window.RTCPeerConnection, O);
};
const copiedLog = async page => {
  await page.click('#whoBtn');
  await page.click('#copyLog');
  await page.click('#detailsClose');
  return page.evaluate(() => navigator.clipboard.readText());
};

test('the connection log records links, their path, and why a link went down', async ({ browser }) => {
  const a = await person(browser), b = await person(browser);
  await a.page.addInitScript(track);
  const link = await createRoom(a.page, 'alpha');
  await joinFromHome(a.page, 'alpha', 'Peer C');
  await joinFromLink(b.page, link, 'Peer B');
  await playingVideos(a.page).toBe(1);
  await a.page.waitForTimeout(3000);

  let text = await copiedLog(a.page);
  expect(text).toMatch(/^Call \d+\.\d+\.\d+ · /);
  for (const line of ['JOIN call room', 'LINK UP', 'STATE', 'connected/', 'PATH Peer B']) expect(text).toContain(line);
  for (const part of ['Network: ', 'Public address: ', 'Running in: the browser', '- Peer B[', ': linked', '\nLog:\n']) expect(text).toContain(part);
  // The timeline itself holds no addresses (only this device's public address is listed, above it).
  expect(text.split('\nLog:\n')[1]).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  expect(text).not.toContain(link.split('key=')[1]);                    // no room password

  // The link breaks: the log says it went down and that the app is reconnecting.
  await a.page.evaluate(() => window.__pcs.forEach(pc => pc.close()));
  await poll(a.page, () => document.querySelector('#grid .tile') && document.querySelector('#grid .tile').classList.contains('reconnecting'), undefined, 15000).toBe(true);
  text = await copiedLog(a.page);
  expect(text).toContain('LINK DOWN Peer B');
  expect(text).toContain('RECONNECTING Peer B');
  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

// Mobile networks often drop out for a few seconds; the browser reports the connection as
// "disconnected" and usually recovers by itself. That must not tear the call down.
test('a connection that wobbles for 15 seconds is kept, not rebuilt', async ({ browser }) => {
  test.setTimeout(90000);
  const a = await person(browser), b = await person(browser);
  await a.page.addInitScript(track);
  const link = await createRoom(a.page, 'alpha');
  await joinFromHome(a.page, 'alpha', 'Peer C');
  await joinFromLink(b.page, link, 'Peer B');
  await playingVideos(a.page).toBe(1);

  // Peer C's browser reports the link as disconnected for 15 s, then connected again.
  const setWobble = on => a.page.evaluate(on => {
    for (const pc of window.__pcs.filter(p => p.connectionState !== 'closed' || p.__wobble)) {
      if (on) {
        pc.__wobble = true;
        Object.defineProperty(pc, 'connectionState', { configurable: true, get: () => 'disconnected' });
        Object.defineProperty(pc, 'iceConnectionState', { configurable: true, get: () => 'disconnected' });
      } else {
        delete pc.connectionState; delete pc.iceConnectionState;
      }
      pc.dispatchEvent(new Event('iceconnectionstatechange'));
      pc.onconnectionstatechange && pc.onconnectionstatechange(new Event('connectionstatechange'));
    }
  }, on);
  await a.page.waitForTimeout(3000);
  await setWobble(true);
  await expect(a.page.locator('#grid .tile .weak-badge')).toBeVisible({ timeout: 5000 });   // says why the picture may freeze
  await a.page.waitForTimeout(13000);
  await setWobble(false);
  await expect(a.page.locator('#grid .tile .weak-badge')).toBeHidden({ timeout: 5000 });
  await a.page.waitForTimeout(3000);

  const text = await copiedLog(a.page);
  expect(text).toContain('connected/connected/stable -> disconnected/disconnected/stable');
  expect(text).toContain('disconnected/disconnected/stable -> connected/connected/stable');
  expect(text).not.toContain('LINK DOWN');
  expect(text).not.toContain('REJOIN');
  expect(await a.page.locator('#grid .tile.reconnecting').count()).toBe(0);
  await playingVideos(a.page).toBe(1);
  expectClean(a, b);
  await a.context.close(); await b.context.close();
});
