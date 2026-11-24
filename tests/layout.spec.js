import { test, expect } from '@playwright/test';
import { person, createRoom, joinFromHome, joinFromLink, playingVideos, expectClean } from './helpers.js';

test('call layouts: alone, 1-on-1 and group, with four controls and flip on your own video', async ({ browser }) => {
  const a = await person(browser), b = await person(browser), c = await person(browser);
  const link = await createRoom(a.page, 'alpha');
  await joinFromHome(a.page, 'alpha', 'Peer A');
  await expect(a.page.locator('#call')).toHaveClass(/mode-alone/);
  await expect(a.page.locator('#bar .ctl')).toHaveCount(4);
  expect(await a.page.locator('#bar .ctl').evaluateAll(els => els.map(e => e.id))).toEqual(['cMic', 'cCam', 'cInvite', 'cLeave']);

  // 1-on-1: their name and the time top left, you small top right, flip next to you.
  await joinFromLink(b.page, link, 'Peer B');
  await playingVideos(a.page).toBe(1);
  await expect(a.page.locator('#call')).toHaveClass(/mode-one/);
  await expect(a.page.locator('#callMeta')).toHaveText(/^\d\d:\d\d$/);
  expect(await a.page.evaluate(() => document.getElementById('cFlip').parentElement.id)).toBe('call');
  const box = await a.page.locator('#self').boundingBox();
  expect(box.width).toBe(96);
  expect(box.y).toBeLessThan(100);                                   // at the top, not above the bar

  // Group: a header with how many and how long; you are a tile, last, with flip on it.
  await joinFromLink(c.page, link, 'Peer C');
  await playingVideos(a.page).toBe(2);
  await expect(a.page.locator('#call')).toHaveClass(/mode-group/);
  await expect(a.page.locator('#callMeta')).toHaveText(/^3 people · \d\d:\d\d/);
  expect(await a.page.evaluate(() => {
    const last = document.getElementById('grid').lastElementChild;
    return last.classList.contains('self-tile') && last.contains(document.getElementById('self')) && last.contains(document.getElementById('cFlip'));
  })).toBe(true);

  // Back to 1-on-1: everything returns to its place.
  await c.page.click('#cLeave');
  await expect(a.page.locator('#call')).toHaveClass(/mode-one/, { timeout: 10000 });
  expect(await a.page.evaluate(() => !document.querySelector('.self-tile') && document.getElementById('self').parentElement.id === 'call')).toBe(true);

  expectClean(a, b, c);
  for (const p of [a, b, c]) await p.context.close();
});
