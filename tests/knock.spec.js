import { test, expect } from '@playwright/test';
import { person, createRoom, expectClean } from './helpers.js';

// A connection that doesn't come up after a moment also checks the ports around the public
// port the other side reported (carriers often give each phone a small block of ports).

const tryConnection = (page, connectFirst) => page.evaluate(async connectFirst => {
  const a = new RTCPeerConnection(), b = new RTCPeerConnection();
  a.createDataChannel('x');
  if (connectFirst) {
    a.onicecandidate = e => e.candidate && b.addIceCandidate(e.candidate).catch(() => {});
    b.onicecandidate = e => e.candidate && a.addIceCandidate(e.candidate).catch(() => {});
  }
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription);
  // The other side reports two public ports from a carrier's block (a documentation address).
  for (const port of [51042, 51046]) {
    await b.addIceCandidate({ candidate: `candidate:9 1 udp 1686052607 203.0.113.9 ${port} typ srflx raddr 0.0.0.0 rport 0`, sdpMid: '0', sdpMLineIndex: 0 });
  }
  await new Promise(r => setTimeout(r, 4000));
  let tried = 0;
  (await b.getStats()).forEach(s => { if (s.type === 'remote-candidate' && s.address === '203.0.113.9') tried++; });
  const state = b.iceConnectionState;
  a.close(); b.close();
  return { tried, state };
}, connectFirst);

test('a link that does not come up checks the ports around the reported one', async ({ browser }) => {
  const p = await person(browser);
  await p.page.goto('/current/');
  const r = await tryConnection(p.page, false);
  expect(r.tried).toBe(85);   // every port from 51002 to 51086
  expectClean(p);
  await p.context.close();
});

test('a link that comes up normally sends no extra checks', async ({ browser }) => {
  const p = await person(browser);
  await p.page.goto('/current/');
  const r = await tryConnection(p.page, true);
  expect(r.state).toMatch(/connected|completed/);
  expect(r.tried).toBe(2);
  expectClean(p);
  await p.context.close();
});

test('a link opened inside Messenger says to open it in Safari or Chrome', async ({ browser }) => {
  const iab = await person(browser, { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/23G90 [FBAN/FBIOS;FBAV/588.0.0.20.106]' });
  const plain = await person(browser);
  const link = await createRoom(plain.page, 'alpha');
  await iab.page.goto(link);
  await expect(iab.page.locator('#appWarn')).toBeVisible();
  await expect(iab.page.locator('#appWarn')).toContainText('inside Messenger or Facebook');
  const other = await person(browser);   // the same link in a normal browser: no note
  await other.page.goto(link);
  await expect(other.page.locator('#lobby')).toBeVisible();
  await expect(other.page.locator('#appWarn')).toBeHidden();
  expectClean(iab, plain, other);
  for (const p of [iab, plain, other]) await p.context.close();
});
