import { test, expect } from '@playwright/test';
import { person, createRoom, expectClean } from './helpers.js';

// When the camera or microphone is refused, the room says why and where to allow it on that
// device. (The browser's own refusal is simulated.)

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';

const refuse = ({ camera, microphone }) => {
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = c => {
    if (c.video && camera) return Promise.reject(new DOMException('refused', camera));
    if (c.audio && microphone) return Promise.reject(new DOMException('refused', microphone));
    return real(c);
  };
};

async function lobbyWith(browser, ua, refusal) {
  const owner = await person(browser);
  const link = await createRoom(owner.page, 'alpha');
  const p = await person(browser, ua ? { userAgent: ua } : {});
  await p.page.addInitScript(refuse, refusal);
  await p.page.goto(link);
  await expect(p.page.locator('#lobby')).toBeVisible();
  await expect(p.page.locator('#mediaErr')).not.toHaveText('', { timeout: 10000 });
  return { owner, p };
}

for (const [device, ua, where] of [['iPhone Safari', IPHONE, 'Website Settings'], ['Android Chrome', ANDROID, 'Permissions']]) {
  test(`both refused on ${device}: says where to allow them`, async ({ browser }) => {
    const { owner, p } = await lobbyWith(browser, ua, { camera: 'NotAllowedError', microphone: 'NotAllowedError' });
    await expect(p.page.locator('#mediaErr')).toContainText('The camera and microphone are blocked');
    await expect(p.page.locator('#mediaErr')).toContainText(where);
    await expect(p.page.locator('#retryMedia')).toHaveText('Try again');
    await expect(p.page.locator('#mediaTitle')).toHaveText('Camera and microphone aren\'t allowed yet');
    await expect(p.page.locator('#audioOnlyBtn')).toBeHidden();      // no sound either: nothing to join with
    expectClean(owner);
    await owner.context.close(); await p.context.close();
  });
}

test('only the camera refused: joins with sound, says the camera is blocked (not missing)', async ({ browser }) => {
  const { owner, p } = await lobbyWith(browser, IPHONE, { camera: 'NotAllowedError' });
  await expect(p.page.locator('#mediaErr')).toContainText('The camera is blocked, so you will join with sound only');
  await expect(p.page.locator('#mediaErr')).not.toContainText('No camera found');
  await expect(p.page.locator('#retryMedia')).toHaveText('Try the camera again');
  await expect(p.page.locator('#mediaTitle')).toHaveText('Camera isn\'t allowed yet');
  await expect(p.page.locator('#audioOnlyBtn')).toBeVisible();
  // Allowed now: trying again brings the camera back.
  await p.page.evaluate(() => { delete navigator.mediaDevices.getUserMedia; });
  await p.page.click('#retryMedia');
  await expect.poll(() => p.page.evaluate(() => document.getElementById('preview').srcObject?.getVideoTracks().length || 0), { timeout: 10000 }).toBe(1);
  expectClean(owner);
  await owner.context.close(); await p.context.close();
});

test('camera busy in another app: says so', async ({ browser }) => {
  const { owner, p } = await lobbyWith(browser, null, { camera: 'NotReadableError' });
  await expect(p.page.locator('#mediaErr')).toContainText('Another app is using the camera');
  await expect(p.page.locator('#mediaTitle')).toHaveText('The camera is in use');
  // Join with audio only goes straight in.
  await p.page.fill('#nameInput', 'Peer B');
  await p.page.click('#audioOnlyBtn');
  await expect(p.page.locator('#call')).toBeVisible({ timeout: 15000 });
  expectClean(owner);
  await owner.context.close(); await p.context.close();
});
