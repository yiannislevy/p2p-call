import { test, expect } from '@playwright/test';
import { person, createRoom, joinFromHome, joinFromLink, playingVideos, expectClean } from './helpers.js';

// During a call the address bar shows the room's name, never its password. That address
// opens the room for people who have it saved, and asks everyone else for the password.

test('in a call the address shows only the room name, and it opens the room', async ({ browser }) => {
  const a = await person(browser), b = await person(browser), c = await person(browser);
  const link = await createRoom(a.page, 'alpha');
  const key = new URLSearchParams(link.split('#')[1]).get('key');
  await joinFromHome(a.page, 'alpha', 'Peer C');
  expect(await a.page.evaluate(() => location.hash)).toBe('#room=alpha');
  expect(a.page.url()).not.toContain(key);
  const address = a.page.url();

  // Someone who has the room saved: straight to the room.
  await b.page.goto('/current/');                // saves it
  await b.page.click('#pasteLinksBtn');
  await b.page.fill('#importText', link);
  await b.page.click('#importBtn');
  await expect(b.page.locator('#home')).toBeVisible();
  await b.page.goto('about:blank');
  await b.page.goto(address);
  await expect(b.page.locator('#lobby')).toBeVisible();
  await expect(b.page.locator('#lobbyTitle')).toHaveText('alpha');
  expect(await b.page.evaluate(() => location.hash)).toBe('');   // gone again outside the call

  // Someone who doesn't: asked for the password, then in.
  await c.page.goto(address);
  await expect(c.page.locator('#addTitle')).toHaveText('Join "alpha"');
  await expect(c.page.locator('#addName')).toHaveValue('alpha');
  await expect(c.page.locator('#addKey')).toBeFocused();
  await c.page.fill('#addKey', key);
  await c.page.click('#saveBtn');
  await expect(c.page.locator('#lobby')).toBeVisible();
  await c.page.fill('#nameInput', 'Peer B');
  await c.page.click('#joinBtn');
  await playingVideos(a.page).toBe(1);

  // Leaving clears it.
  await a.page.click('#cLeave');
  expect(await a.page.evaluate(() => location.hash)).toBe('');
  expectClean(a, b, c);
  for (const p of [a, b, c]) await p.context.close();
});

test('sharing sends the link itself (AirDrop opens the page), not a text', async ({ browser }) => {
  const a = await person(browser);
  await a.page.addInitScript(() => { window.__shared = null; navigator.share = d => { window.__shared = d; return Promise.resolve(); }; });
  await createRoom(a.page, 'alpha');
  await a.page.locator('.room', { hasText: 'alpha' }).locator('.icon-btn').click();
  await a.page.click('#sheetShare');
  const shared = await a.page.evaluate(() => window.__shared);
  expect(shared.url).toMatch(/#room=alpha&key=/);
  expect(shared.text).toBeUndefined();
  expectClean(a);
  await a.context.close();
});
