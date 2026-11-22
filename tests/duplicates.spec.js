import { test, expect } from '@playwright/test';
import { person, playingVideos, expectClean } from './helpers.js';

// With several relays every handshake arrives more than once, and on a fast local network
// (two phones on one hotspot) each copy can finish connecting. A working connection must not
// be torn down and replaced by each newcomer ("Reconnecting" flicker every half second).

test('handshakes arriving twice do not keep replacing a working connection', async ({ browser }) => {
  test.setTimeout(90000);
  const a = await person(browser), b = await person(browser);
  // Both on the build that hears everything through two relays.
  await a.page.goto('/twice/');
  await a.page.click('#addBtn');
  await a.page.fill('#addName', 'alpha');
  const key = await a.page.inputValue('#addKey');
  await a.page.click('#saveBtn');
  const link = `/twice/#room=alpha&key=${key}`;
  await a.page.locator('.room', { hasText: 'alpha' }).locator('.main').click();
  await a.page.fill('#nameInput', 'Peer C');
  await a.page.click('#joinBtn');
  await b.page.goto(link);
  await b.page.fill('#nameInput', 'Peer B');
  await b.page.click('#joinBtn');
  await playingVideos(a.page, 20000).toBe(1);
  await a.page.waitForTimeout(12000);

  await a.page.click('#whoBtn');
  await a.page.click('#copyLog');
  const text = await a.page.evaluate(() => navigator.clipboard.readText());
  const downs = (text.match(/LINK DOWN/g) || []).length;
  expect(downs, text).toBe(0);
  expectClean(a, b);
  await a.context.close(); await b.context.close();
});
