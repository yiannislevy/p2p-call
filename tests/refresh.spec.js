import { test, expect } from '@playwright/test';
import { person, createRoom, joinFromHome, joinFromLink, playingVideos, poll, expectClean } from './helpers.js';

const recordToasts = () => {
  window.__toasts = [];
  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver(list => list.forEach(m => m.addedNodes.forEach(n => n.classList && n.classList.contains('toast') && window.__toasts.push(n.textContent))))
      .observe(document.getElementById('toasts'), { childList: true });
  });
};

test('an invitee who refreshes before joining stays on that room', async ({ browser }) => {
  const a = await person(browser), b = await person(browser);
  const link = await createRoom(a.page, 'family');
  await b.page.goto(link);
  await expect(b.page.locator('#lobbyTitle')).toHaveText('family');

  await b.page.reload();
  await expect(b.page.locator('#lobby')).toBeVisible();
  await expect(b.page.locator('#lobbyTitle')).toHaveText('family');
  await expect(b.page.locator('#saveInviteRow')).toBeVisible();
  expect(new URL(b.page.url()).hash).toBe('');                     // the secret stays out of the address bar

  await b.page.fill('#nameInput', 'Sarra');
  await b.page.click('#joinBtn');
  await joinFromHome(a.page, 'family', 'Yianni');
  await playingVideos(b.page).toBe(1);

  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

test('refreshing during a call rejoins it on its own, and the others keep the tile', async ({ browser }) => {
  const a = await person(browser), b = await person(browser);
  await a.page.addInitScript(recordToasts);
  const link = await createRoom(a.page, 'family');
  await joinFromHome(a.page, 'family', 'Yianni');
  await joinFromLink(b.page, link, 'Sarra');
  await playingVideos(a.page).toBe(1);
  await b.page.click('#cMic');                                      // muted before the refresh

  await b.page.reload();
  await expect(b.page.locator('#call')).toBeVisible({ timeout: 20000 });
  await playingVideos(b.page, 30000).toBe(1);
  await expect(b.page.locator('#cMic .lb')).toHaveText('Unmute');   // still muted afterwards

  await poll(a.page, () => {
    const t = [...document.querySelectorAll('#grid .tile')];
    return t.length === 1 && t[0].querySelector('.ph').hidden && t[0].classList.contains('muted') && t[0].querySelector('.tag span').textContent;
  }, undefined, 30000).toBe('Sarra');
  const seen = await a.page.evaluate(() => window.__toasts);
  expect(seen).not.toContain('Sarra left');
  expect(seen.filter(t => t === 'Sarra joined').length).toBe(1);

  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

test('closing the tab mid-call: the others see you leave within about 20 seconds', async ({ browser }) => {
  test.setTimeout(90000);
  const a = await person(browser), b = await person(browser);
  await a.page.addInitScript(recordToasts);
  const link = await createRoom(a.page, 'family');
  await joinFromHome(a.page, 'family', 'Yianni');
  await joinFromLink(b.page, link, 'Sarra');
  await playingVideos(a.page).toBe(1);

  await b.page.close();
  await poll(a.page, () => document.querySelectorAll('#grid .tile').length, undefined, 40000).toBe(0);
  expect(await a.page.evaluate(() => window.__toasts)).toContain('Sarra left');

  expectClean(a);
  await a.context.close(); await b.context.close();
});

test('after leaving with the button, a refresh stays on the rooms screen', async ({ browser }) => {
  const a = await person(browser), b = await person(browser);
  const link = await createRoom(a.page, 'family');
  await joinFromLink(b.page, link, 'Sarra');
  await b.page.click('#cLeave');
  await expect(b.page.locator('#home')).toBeVisible();
  await b.page.reload();
  await expect(b.page.locator('#home')).toBeVisible();
  await b.page.waitForTimeout(1500);
  await expect(b.page.locator('#call')).toBeHidden();
  await expect(b.page.locator('#lobby')).toBeHidden();
  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

test('a new tab does not pull you into the call you are in elsewhere', async ({ browser }) => {
  const a = await person(browser);
  await createRoom(a.page, 'family');
  await joinFromHome(a.page, 'family', 'Yianni');
  const second = await a.context.newPage();
  await second.goto('/current/');
  await expect(second.locator('#home')).toBeVisible();
  await second.waitForTimeout(1500);
  await expect(second.locator('#call')).toBeHidden();
  await a.context.close();
});
