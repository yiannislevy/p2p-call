import { test, expect } from '@playwright/test';
import { person, createRoom, joinFromHome, joinFromLink, playingVideos, tiles, poll, expectClean } from './helpers.js';

test('three people call: everyone sees everyone, names, mute and camera state, leaving', async ({ browser }) => {
  const a = await person(browser), b = await person(browser), c = await person(browser);

  const link = await createRoom(a.page, 'family');
  await joinFromHome(a.page, 'family', 'Yianni');
  await expect(a.page.locator('#aloneTitle')).toHaveText('Waiting for others', { timeout: 15000 });

  await joinFromLink(b.page, link, 'Sarra');
  await joinFromLink(c.page, link, 'Mama');

  for (const p of [a, b, c]) await playingVideos(p.page).toBe(2);
  expect((await tiles(a.page)).map(t => t.name)).toEqual(['Mama', 'Sarra']);
  expect((await tiles(b.page)).map(t => t.name)).toEqual(['Mama', 'Yianni']);
  expect((await tiles(c.page)).map(t => t.name)).toEqual(['Sarra', 'Yianni']);
  await expect(a.page.locator('#callMeta')).toContainText('3 people');

  // Mute and camera off are shown to the others.
  await a.page.click('#cMic');
  await a.page.click('#cCam');
  await expect(a.page.locator('#cMic .lb')).toHaveText('Unmute');
  await poll(b.page, () => {
    const t = [...document.querySelectorAll('#grid .tile')].find(x => x.querySelector('.tag span').textContent === 'Yianni');
    return t && t.classList.contains('muted') && t.querySelector('.ph-status').textContent;
  }).toBe('Camera off');
  await a.page.click('#cMic');
  await a.page.click('#cCam');
  await poll(b.page, () => {
    const t = [...document.querySelectorAll('#grid .tile')].find(x => x.querySelector('.tag span').textContent === 'Yianni');
    return t && !t.classList.contains('muted') && t.querySelector('.ph').hidden;
  }).toBe(true);

  // Connection details open and list both people.
  await a.page.click('#whoBtn');
  await expect(a.page.locator('#details')).toBeVisible();
  await expect(a.page.locator('#detailsList li')).toHaveCount(2);
  await a.page.click('#detailsClose');

  // Leave button: back home, camera released, the others are told.
  await c.page.click('#cLeave');
  await expect(c.page.locator('#home')).toBeVisible();
  expect(await c.page.evaluate(() => document.getElementById('self').srcObject)).toBeNull();
  await playingVideos(a.page).toBe(1);
  await expect(a.page.locator('.toast', { hasText: 'Mama left' })).toBeVisible();

  // Phone back gesture / browser back also leaves the call.
  await a.page.goBack();
  await expect(a.page.locator('#home')).toBeVisible();
  await poll(b.page, () => document.querySelectorAll('#grid .tile').length).toBe(0);
  await expect(b.page.locator('#alone')).toBeVisible();

  expectClean(a, b, c);
  for (const p of [a, b, c]) await p.context.close();
});

test('camera and microphone can be switched off before joining', async ({ browser }) => {
  const a = await person(browser), b = await person(browser);
  const link = await createRoom(a.page, 'quiet');
  await a.page.locator('.room .main').click();
  await a.page.click('#pMic');
  await a.page.click('#pCam');
  await expect(a.page.locator('#previewOff')).toBeVisible();
  await a.page.fill('#nameInput', 'Yianni');
  await a.page.click('#joinBtn');
  await expect(a.page.locator('#cMic .lb')).toHaveText('Unmute');

  await joinFromLink(b.page, link, 'Sarra');
  await poll(b.page, () => {
    const t = document.querySelector('#grid .tile');
    return t && t.classList.contains('muted') && t.querySelector('.ph-status').textContent;
  }).toBe('Camera off');

  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

test('leaving and joining the same room again straight away works', async ({ browser }) => {
  const a = await person(browser), b = await person(browser);
  const link = await createRoom(a.page, 'family');
  await joinFromLink(b.page, link, 'Sarra');
  for (let round = 0; round < 3; round++) {
    await joinFromHome(a.page, 'family', 'Yianni');
    await playingVideos(a.page).toBe(1);
    await a.page.click('#cLeave');
    await expect(a.page.locator('#home')).toBeVisible();
  }
  await expect(a.page.locator('#lobbyErr')).toHaveText('');
  expectClean(a, b);
  await a.context.close(); await b.context.close();
});
