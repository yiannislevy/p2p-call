import { test, expect } from '@playwright/test';
import { person, createRoom, joinFromHome, joinFromLink, playingVideos, expectClean } from './helpers.js';

// Pinch to zoom into someone's video, move around while zoomed, double tap to zoom out.

const touch = (page, type, id, x, y) => page.evaluate(({ type, id, x, y }) => {
  const tile = document.querySelector('#grid .tile');
  tile.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: id === 1 }));
}, { type, id, x, y });
const zoomOf = page => page.evaluate(() => document.querySelector('#grid .tile video').style.transform);

test('pinch zooms into a video, one finger moves it, double tap zooms back out', async ({ browser }) => {
  const a = await person(browser), b = await person(browser);
  const link = await createRoom(a.page, 'alpha');
  await joinFromHome(a.page, 'alpha', 'Peer C');
  await joinFromLink(b.page, link, 'Peer B');
  await playingVideos(a.page).toBe(1);

  // Two fingers 100 px apart spread to 200 px: twice as big.
  await touch(a.page, 'pointerdown', 1, 145, 400);
  await touch(a.page, 'pointerdown', 2, 245, 400);
  await touch(a.page, 'pointermove', 1, 95, 400);
  await touch(a.page, 'pointermove', 2, 295, 400);
  await touch(a.page, 'pointerup', 2, 295, 400);
  await touch(a.page, 'pointerup', 1, 95, 400);
  expect(await zoomOf(a.page)).toMatch(/scale\(2\)/);

  // Spreading further stops at 4x.
  await touch(a.page, 'pointerdown', 1, 145, 400);
  await touch(a.page, 'pointerdown', 2, 245, 400);
  await touch(a.page, 'pointermove', 2, 845, 400);
  await touch(a.page, 'pointerup', 2, 845, 400);
  await touch(a.page, 'pointerup', 1, 145, 400);
  expect(await zoomOf(a.page)).toMatch(/scale\(4\)/);

  // One finger moves the zoomed picture.
  const before = await zoomOf(a.page);
  await touch(a.page, 'pointerdown', 3, 200, 400);
  await touch(a.page, 'pointermove', 3, 260, 440);
  await touch(a.page, 'pointerup', 3, 260, 440);
  expect(await zoomOf(a.page)).not.toBe(before);

  // Double tap: back to normal, without switching to "fit".
  for (let i = 0; i < 2; i++) { await touch(a.page, 'pointerdown', 4, 200, 400); await touch(a.page, 'pointerup', 4, 200, 400); }
  expect(await zoomOf(a.page)).toBe('');
  expect(await a.page.evaluate(() => document.querySelector('#grid .tile').classList.contains('fit'))).toBe(false);

  // Not zoomed: double tap still switches between filling the tile and the whole picture.
  await a.page.waitForTimeout(400);
  for (let i = 0; i < 2; i++) { await touch(a.page, 'pointerdown', 5, 200, 400); await touch(a.page, 'pointerup', 5, 200, 400); }
  expect(await a.page.evaluate(() => document.querySelector('#grid .tile').classList.contains('fit'))).toBe(true);
  expectClean(a, b);
  await a.context.close(); await b.context.close();
});
