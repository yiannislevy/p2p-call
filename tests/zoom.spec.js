import { test, expect } from '@playwright/test';
import { person, createRoom, joinFromHome, joinFromLink, playingVideos, expectClean } from './helpers.js';

// Camera zoom: a button above the bar and a wheel, zooming the camera itself (where the
// camera can zoom; the test camera can't, so a zoomable camera is simulated).

const zoomableCamera = () => {
  window.__zooms = [];
  const caps = MediaStreamTrack.prototype.getCapabilities;
  MediaStreamTrack.prototype.getCapabilities = function () {
    const c = caps ? caps.call(this) : {};
    return this.kind === 'video' ? { ...c, zoom: { min: 1, max: 10, step: 0.1 } } : c;
  };
  const apply = MediaStreamTrack.prototype.applyConstraints;
  MediaStreamTrack.prototype.applyConstraints = function (c) {
    const z = c && c.advanced && c.advanced[0] && c.advanced[0].zoom;
    if (z != null) { window.__zooms.push(z); return Promise.resolve(); }
    return apply.call(this, c);
  };
};

test('the zoom wheel zooms the camera, stays in range, and taps jump to a stop', async ({ browser }) => {
  const a = await person(browser), b = await person(browser);
  await a.page.addInitScript(zoomableCamera);
  const link = await createRoom(a.page, 'alpha');
  await joinFromHome(a.page, 'alpha', 'Peer C');
  await joinFromLink(b.page, link, 'Peer B');
  await playingVideos(a.page).toBe(1);

  await expect(a.page.locator('#zoomBtn')).toBeVisible();
  await expect(a.page.locator('#zoomBtn')).toHaveText('1×');
  await expect(b.page.locator('#zoomBtn')).toBeHidden();          // a camera that can't zoom: no button

  await a.page.click('#zoomBtn');
  await expect(a.page.locator('#zoomDial')).toBeVisible();
  // Turn the wheel: drag left to zoom in.
  const box = await a.page.locator('#zoomDial').boundingBox();
  const y = box.y + box.height / 2;
  await a.page.mouse.move(box.x + box.width * 0.8, y);
  await a.page.mouse.down();
  await a.page.mouse.move(box.x + box.width * 0.5, y, { steps: 8 });
  await a.page.mouse.up();
  await expect.poll(() => a.page.evaluate(() => window.__zooms.at(-1) || 0)).toBeGreaterThan(1.2);
  await expect(a.page.locator('#zoomBtn')).not.toHaveText('1×');

  // Way too far: stops at the camera's maximum.
  await a.page.mouse.move(box.x + box.width * 0.95, y);
  await a.page.mouse.down();
  await a.page.mouse.move(box.x - 2000, y, { steps: 10 });
  await a.page.mouse.up();
  await expect.poll(() => a.page.evaluate(() => window.__zooms.at(-1))).toBe(10);
  expect(await a.page.evaluate(() => Math.max(...window.__zooms))).toBeLessThanOrEqual(10);

  // Tapping a stop jumps there.
  await a.page.locator('#zoomArc text', { hasText: /^2×$/ }).dispatchEvent('click');
  await expect.poll(() => a.page.evaluate(() => window.__zooms.at(-1))).toBe(2);
  await expect(a.page.locator('#zoomBtn')).toHaveText('2×');

  // Leaving the call hides it.
  await a.page.click('#cLeave');
  await expect(a.page.locator('#zoomCtl')).toBeHidden();
  expectClean(a, b);
  await a.context.close(); await b.context.close();
});
