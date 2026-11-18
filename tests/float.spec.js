import { test, expect } from '@playwright/test';
import { person, createRoom, joinFromHome, joinFromLink, playingVideos, poll, expectClean } from './helpers.js';

// The floating video: one video element kept playing during the call, showing whoever is
// talking. (Headless test browsers can't open a real floating window, so the tests check
// what that element shows; the floating window itself is checked on an iPhone.)

const floatShows = page => page.evaluate(() => {
  const v = document.getElementById('floatVideo');
  const t = v.srcObject && v.srcObject.getVideoTracks()[0];
  if (!t) return 'nothing';
  for (const tile of document.querySelectorAll('#grid .tile')) {
    const s = tile.querySelector('video').srcObject;
    if (s && s.getVideoTracks()[0] === t) return tile.querySelector('.tag span').textContent;
  }
  return 'card';
});

test('the floating video shows whoever is talking, and a card when their camera is off', async ({ browser }) => {
  const a = await person(browser), b = await person(browser), c = await person(browser);
  const link = await createRoom(a.page, 'family');
  await joinFromHome(a.page, 'family', 'Yianni');
  await joinFromLink(b.page, link, 'Sarra');
  await joinFromLink(c.page, link, 'Mama');
  for (const p of [a, b, c]) await playingVideos(p.page).toBe(2);

  // Only Mama talks: Yianni's floating video follows her.
  await b.page.click('#cMic');
  await a.page.click('#cMic');
  await poll(a.page, () => document.getElementById('floatVideo').paused, undefined, 10000).toBe(false);
  await expect.poll(() => floatShows(a.page), { timeout: 15000 }).toBe('Mama');

  // Mama goes quiet and Sarra talks: it switches to Sarra.
  await c.page.click('#cMic');
  await b.page.click('#cMic');
  await expect.poll(() => floatShows(a.page), { timeout: 15000 }).toBe('Sarra');

  // Sarra turns her camera off: a card with her initial instead of a frozen picture.
  await b.page.click('#cCam');
  await expect.poll(() => floatShows(a.page), { timeout: 15000 }).toBe('card');
  await b.page.click('#cCam');
  await expect.poll(() => floatShows(a.page), { timeout: 15000 }).toBe('Sarra');

  // Leaving the call stops it.
  await a.page.click('#cLeave');
  expect(await a.page.evaluate(() => document.getElementById('floatVideo').srcObject)).toBe(null);
  expectClean(a, b, c);
  await a.context.close(); await b.context.close(); await c.context.close();
});

test('the Float button floats the video where the browser can, and P does the same', async ({ browser }) => {
  const a = await person(browser), b = await person(browser);
  // Stand in for a browser with floating windows (headless ones have none).
  await a.page.addInitScript(() => {
    window.__floated = 0;
    Object.defineProperty(Document.prototype, 'pictureInPictureEnabled', { configurable: true, get: () => true });
    let el = null;
    Object.defineProperty(Document.prototype, 'pictureInPictureElement', { configurable: true, get: () => el });
    HTMLVideoElement.prototype.requestPictureInPicture = function () {
      if (this.readyState < 1) return Promise.reject(new DOMException('not ready', 'InvalidStateError'));
      el = this; window.__floated++; this.dispatchEvent(new Event('enterpictureinpicture')); return Promise.resolve({});
    };
    Document.prototype.exitPictureInPicture = function () { const v = el; el = null; v && v.dispatchEvent(new Event('leavepictureinpicture')); return Promise.resolve(); };
  });
  const link = await createRoom(a.page, 'family');
  await joinFromHome(a.page, 'family', 'Yianni');
  await expect(a.page.locator('#cFloat')).toBeVisible();
  await expect(a.page.locator('#cFloat')).toBeDisabled();          // nobody to float yet
  await joinFromLink(b.page, link, 'Sarra');
  await playingVideos(a.page).toBe(1);
  await expect(a.page.locator('#cFloat')).toBeEnabled();
  await poll(a.page, () => document.getElementById('floatVideo').readyState, undefined, 10000).toBeGreaterThan(0);

  await a.page.click('#cFloat');
  await expect(a.page.locator('#cFloat .lb')).toHaveText('Floating');
  expect(await a.page.evaluate(() => window.__floated)).toBe(1);
  await a.page.click('#cFloat');
  await expect(a.page.locator('#cFloat .lb')).toHaveText('Float');

  await a.page.keyboard.press('p');
  await expect(a.page.locator('#cFloat .lb')).toHaveText('Floating');
  await a.page.click('#cLeave');
  expect(await a.page.evaluate(() => document.pictureInPictureElement)).toBe(null);
  expectClean(a, b);
  await a.context.close(); await b.context.close();
});
