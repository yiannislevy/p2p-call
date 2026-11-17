import { test, expect } from '@playwright/test';
import { person, createRoom, joinFromHome, joinFromLink, playingVideos, poll, expectClean } from './helpers.js';

// Test-only instrumentation: keep a handle on every peer connection (to cut them, like a
// network switch would) and record every message the app shows.
const instrument = () => {
  const Original = window.RTCPeerConnection;
  window.__pcs = [];
  window.__failUntil = 0;
  window.RTCPeerConnection = function (...args) {
    const pc = new Original(...args);
    window.__pcs.push(pc);
    if (Date.now() < window.__failUntil) Object.defineProperty(pc, 'connectionState', { get: () => 'failed' });
    return pc;
  };
  window.RTCPeerConnection.prototype = Original.prototype;
  Object.setPrototypeOf(window.RTCPeerConnection, Original);
  window.__toasts = [];
  document.addEventListener('DOMContentLoaded', () => {
    // A simulated outage lasts until the app reacts to it by rejoining.
    new MutationObserver(list => list.forEach(m => m.addedNodes.forEach(n => {
      if (!n.classList || !n.classList.contains('toast')) return;
      window.__toasts.push(n.textContent);
      if (n.textContent.startsWith('Connection lost')) window.__failUntil = 0;
    })))
      .observe(document.getElementById('toasts'), { childList: true });
  });
};

async function twoInCall(browser) {
  const a = await person(browser), b = await person(browser);
  await a.page.addInitScript(instrument);
  await b.page.addInitScript(instrument);
  const link = await createRoom(a.page, 'family');
  await joinFromHome(a.page, 'family', 'Yianni');
  await joinFromLink(b.page, link, 'Sarra');
  await playingVideos(a.page).toBe(1);
  await playingVideos(b.page).toBe(1);
  return { a, b };
}

const cutConnections = page => page.evaluate(() => { for (const pc of window.__pcs) pc.close(); });
const toasts = page => page.evaluate(() => window.__toasts);
const tileStatus = page => page.evaluate(() => [...document.querySelectorAll('#grid .tile')].map(t => t.querySelector('.ph-status').textContent));

test('when every link dies, the app rejoins on its own, without "left" or duplicate tiles', async ({ browser }) => {
  const { a, b } = await twoInCall(browser);
  const before = await b.page.evaluate(() => window.__pcs.length);

  // Sarra's links all fail and stay failed (the library's own repair fails too) until the app
  // rejoins: what a wifi-to-5G switch or a long tunnel looks like to the browser.
  await b.page.evaluate(() => {
    window.__failUntil = Date.now() + 120000;
    for (const pc of window.__pcs) Object.defineProperty(pc, 'connectionState', { get: () => 'failed' });
  });

  // Her app notices, says so, rejoins the room and is connected again on a fresh link.
  await poll(b.page, () => window.__toasts.includes('Connection lost. Reconnecting…'), undefined, 30000).toBe(true);
  await expect(b.page.locator('#callMeta')).toHaveText('Reconnecting…');
  await poll(b.page, n => window.__pcs.slice(n).some(pc => pc.connectionState === 'connected'), before, 60000).toBe(true);
  await poll(b.page, () => window.__toasts.includes('Reconnected'), undefined, 20000).toBe(true);
  await poll(b.page, () => document.getElementById('callMeta').textContent.includes('people'), undefined, 10000).toBe(true);
  await playingVideos(b.page).toBe(1);

  // Yianni keeps exactly one tile for Sarra, live again, and was never told she left or joined again.
  await poll(a.page, () => {
    const tiles = [...document.querySelectorAll('#grid .tile')];
    return tiles.length === 1 && tiles[0].querySelector('.ph').hidden && tiles[0].querySelector('video').videoWidth > 0;
  }, undefined, 40000).toBe(true);
  expect(await a.page.locator('#grid .tag span').textContent()).toBe('Sarra');
  const seen = await toasts(a.page);
  expect(seen).not.toContain('Sarra left');
  expect(seen.filter(t => t === 'Sarra joined').length).toBe(1);

  // The call still works both ways.
  await b.page.click('#cMic');
  await poll(a.page, () => document.querySelector('#grid .tile').classList.contains('muted')).toBe(true);
  await a.page.click('#cCam');
  await poll(b.page, () => document.querySelector('#grid .tile .ph-status').textContent).toBe('Camera off');

  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

test('connections torn down underneath recover with the same tiles', async ({ browser }) => {
  const { a, b } = await twoInCall(browser);
  await b.page.evaluate(() => { for (const pc of window.__pcs) pc.close(); });

  for (const p of [a, b]) {
    await poll(p.page, () => {
      const tiles = [...document.querySelectorAll('#grid .tile')];
      return tiles.length === 1 && tiles[0].querySelector('.ph').hidden && tiles[0].querySelector('video').videoWidth > 0;
    }, undefined, 40000).toBe(true);
  }
  await a.page.waitForTimeout(2000);
  expect(await a.page.locator('#grid .tile').count()).toBe(1);
  expect(await b.page.locator('#grid .tile').count()).toBe(1);
  expect(await toasts(a.page)).not.toContain('Sarra left');
  expect(await toasts(b.page)).not.toContain('Yianni left');

  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

test('someone who never comes back shows as reconnecting, then is removed', async ({ browser }) => {
  test.setTimeout(180000);
  const { a, b } = await twoInCall(browser);

  // Sarra's phone goes dark for good: connections cut and nothing can be sent any more.
  await b.page.evaluate(() => { WebSocket.prototype.send = () => {}; for (const pc of window.__pcs) pc.close(); });

  await poll(a.page, () => document.querySelector('#grid .tile .ph-status')?.textContent, undefined, 40000).toBe('Reconnecting…');
  expect(await toasts(a.page)).not.toContain('Sarra left');
  // Removed once their phone has also stopped saying "here" in the room (within ~70 s).
  await poll(a.page, () => document.querySelectorAll('#grid .tile').length, undefined, 110000).toBe(0);
  expect(await toasts(a.page)).toContain('Sarra left');
  await expect(a.page.locator('#alone')).toBeVisible();

  await a.context.close(); await b.context.close();
});

test('leaving on purpose is still shown straight away', async ({ browser }) => {
  const { a, b } = await twoInCall(browser);
  await b.page.click('#cLeave');
  await poll(a.page, () => document.querySelectorAll('#grid .tile').length, undefined, 4000).toBe(0);
  expect(await toasts(a.page)).toContain('Sarra left');
  expect(await tileStatus(a.page)).toEqual([]);
  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

test('in a three-person call, one person dropping and coming back leaves everyone with the right tiles', async ({ browser }) => {
  const { a, b } = await twoInCall(browser);
  const c = await person(browser);
  await c.page.addInitScript(instrument);
  const link = await a.page.inputValue('#sheetLink').catch(() => '');
  const invite = link || await (async () => { await a.page.click('#topInvite'); const l = await a.page.inputValue('#sheetLink'); await a.page.click('#sheetDone'); return l; })();
  await joinFromLink(c.page, invite, 'Mama');
  for (const p of [a, b, c]) await playingVideos(p.page).toBe(2);

  await b.page.evaluate(() => {
    window.__failUntil = Date.now() + 120000;
    for (const pc of window.__pcs) Object.defineProperty(pc, 'connectionState', { get: () => 'failed' });
  });
  await poll(b.page, () => window.__toasts.includes('Reconnected'), undefined, 60000).toBe(true);

  const names = page => page.evaluate(() => [...document.querySelectorAll('#grid .tag span')].map(s => s.textContent).sort());
  for (const p of [a, b, c]) await playingVideos(p.page, 40000).toBe(2);
  expect(await names(a.page)).toEqual(['Mama', 'Sarra']);
  expect(await names(b.page)).toEqual(['Mama', 'Yianni']);
  expect(await names(c.page)).toEqual(['Sarra', 'Yianni']);
  for (const p of [a, c]) expect(await toasts(p.page)).not.toContain('Sarra left');

  expectClean(a, b, c);
  for (const p of [a, b, c]) await p.context.close();
});
