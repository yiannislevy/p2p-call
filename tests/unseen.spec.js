import { test, expect } from '@playwright/test';
import { person, createRoom, joinFromHome, joinFromLink, playingVideos, poll, expectClean } from './helpers.js';

// Test-only: lets a test make the call's relay connections go deaf (they stay open but
// nothing arriving on them gets through), while the separate who's-in notes keep working.
// This is the "in the room for a while, can't see people who join" situation.
const deafenable = () => {
  const Original = window.WebSocket;
  window.__sockets = [];
  class Watched extends Original {
    constructor(...args) { super(...args); window.__sockets.push(this); }
    send(data) { if (String(data).startsWith('["REQ","p')) this.__presence = true; return super.send(data); }
    set onmessage(fn) { super.onmessage = e => { if (this.__deaf) return; fn && fn(e); }; }
    get onmessage() { return super.onmessage; }
  }
  window.WebSocket = Watched;
};
const deafen = page => page.evaluate(() => { for (const s of window.__sockets) if (!s.__presence) s.__deaf = true; });

test('in the room for a while with dead introductions: people who join are still picked up', async ({ browser }) => {
  test.setTimeout(150000);
  const a = await person(browser), b = await person(browser), c = await person(browser);
  await a.page.addInitScript(deafenable);
  const link = await createRoom(a.page, 'alpha');
  await joinFromHome(a.page, 'alpha', 'Peer C');
  await a.page.waitForTimeout(3000);
  await deafen(a.page);                                   // Peer C's side stops hearing introductions

  await joinFromLink(b.page, link, 'Peer B');
  await joinFromLink(c.page, link, 'Peer A');
  await playingVideos(b.page).toBe(1);                    // Peer B and Peer A see each other at once

  // Peer C notices they are in the room without him and picks them up.
  await playingVideos(a.page, 90000).toBe(2);
  for (const p of [b, c]) await playingVideos(p.page, 30000).toBe(2);
  const names = await a.page.evaluate(() => [...document.querySelectorAll('#grid .tile .tag span')].map(s => s.textContent).sort());
  expect(names).toEqual(['Peer A', 'Peer B']);

  expectClean(a, b, c);
  for (const p of [a, b, c]) await p.context.close();
});

test('someone in the room who cannot connect is named in the details, without endless retries', async ({ browser }) => {
  test.setTimeout(150000);
  const a = await person(browser), b = await person(browser);
  await b.page.addInitScript(deafenable);
  const link = await createRoom(a.page, 'alpha');
  await joinFromHome(a.page, 'alpha', 'Peer C');
  // Peer B's introductions are always deaf, rejoining included: her network "can't connect".
  await b.page.addInitScript(() => {
    const W = window.WebSocket;
    window.WebSocket = class extends W { constructor(...a) { super(...a); queueMicrotask(() => { if (!this.__presence) this.__deaf = true; }); } };
  });
  await joinFromLink(b.page, link, 'Peer B');

  await a.page.click('#whoBtn');
  await expect(a.page.locator('#detailsList li', { hasText: 'Peer B' })).toContainText('In the room', { timeout: 30000 });
  await expect(a.page.locator('#detailsList li', { hasText: 'Peer B' })).toContainText("can't connect to you", { timeout: 90000 });
  await a.page.click('#detailsClose');

  // Said once, calmly: no repeated messages, and Peer C's call carries on as normal.
  await a.page.waitForTimeout(10000);
  expect(await a.page.evaluate(() => document.querySelectorAll('.toast').length)).toBeLessThanOrEqual(1);
  await expect(a.page.locator('#callMeta')).toHaveText('Just you');

  await a.context.close(); await b.context.close();
});
