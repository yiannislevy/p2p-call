import { test, expect } from '@playwright/test';
import { person, createRoom, joinFromHome, joinFromLink, playingVideos, expectClean } from './helpers.js';

test('Invite copies the link straight away, and the invitee can join and save the room', async ({ browser }) => {
  const a = await person(browser), b = await person(browser);
  const link = await createRoom(a.page, 'alpha');

  // Copied to the clipboard without any share dialog.
  expect(await a.page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  expect(link).toMatch(/\/current\/#room=alpha&key=[a-z0-9-]{19}$/);

  // Invitee: the secret is wiped from the address bar, room offered for saving.
  await b.page.goto(link);
  await expect(b.page.locator('#lobbyTitle')).toHaveText('alpha');
  expect(new URL(b.page.url()).hash).toBe('');
  await expect(b.page.locator('#saveInviteRow')).toBeVisible();
  await b.page.fill('#nameInput', 'Peer B');
  await b.page.click('#joinBtn');
  await expect(b.page.locator('#call')).toBeVisible();

  await joinFromHome(a.page, 'alpha', 'Peer C');
  await playingVideos(a.page).toBe(1);
  await playingVideos(b.page).toBe(1);

  // Inviting from inside a call works too.
  await a.page.click('#topInvite');
  await expect(a.page.locator('#sheet')).toBeVisible();
  expect(await a.page.inputValue('#sheetLink')).toBe(link);
  await a.page.click('#sheetDone');
  await expect(a.page.locator('#sheet')).toBeHidden();

  // The invitee now has the room on their device.
  await b.page.click('#cLeave');
  await expect(b.page.locator('.room .name')).toHaveText('alpha');

  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

test('a broken invite link is handled calmly', async ({ browser }) => {
  const a = await person(browser);
  await a.page.goto('/current/#room=alpha&key=short');
  await expect(a.page.locator('#home')).toBeVisible();
  await expect(a.page.locator('.toast')).toContainText('incomplete');
  expectClean(a);
  await a.context.close();
});

test('on a phone, Invite opens the phone\'s own share sheet with the link', async ({ browser }) => {
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1';
  const { person } = await import('./helpers.js');
  const a = await person(browser, { userAgent: ua });
  await a.page.addInitScript(() => { window.__shared = null; navigator.share = d => { window.__shared = d; return Promise.resolve(); }; });
  await a.page.goto('/current/');
  await a.page.click('#addBtn');
  await a.page.fill('#addName', 'alpha');
  await a.page.click('#saveBtn');
  await a.page.locator('.room', { hasText: 'alpha' }).locator('.icon-btn').click();
  await expect.poll(() => a.page.evaluate(() => window.__shared && window.__shared.url)).toMatch(/#room=alpha&key=/);
  await expect(a.page.locator('#sheet')).toBeHidden();
  await a.context.close();
});
