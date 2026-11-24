import { test, expect } from '@playwright/test';
import { person, createRoom, expectClean } from './helpers.js';

test('first open explains the app; adding a room with Save and join goes straight to it', async ({ browser }) => {
  const a = await person(browser);
  await a.page.goto('/current/');
  await expect(a.page.locator('#homeEmpty h2')).toHaveText('Private calls, no account');
  await expect(a.page.locator('#addFirstBtn')).toBeVisible();
  await expect(a.page.locator('#pasteLinksBtn')).toBeVisible();
  await expect(a.page.locator('#forgetBtn')).toBeHidden();
  await expect(a.page.locator('#homeRooms')).toBeHidden();

  await a.page.click('#addFirstBtn');
  await expect(a.page.locator('#segNew')).toHaveAttribute('aria-checked', 'true');
  // The generated password is hidden until asked for, and a new one shows itself.
  await expect(a.page.locator('#addKey')).toHaveAttribute('type', 'password');
  await a.page.click('#revealBtn');
  await expect(a.page.locator('#addKey')).toHaveAttribute('type', 'text');
  await expect(a.page.locator('#revealBtn')).toHaveAttribute('aria-pressed', 'true');
  await a.page.click('#revealBtn');
  await a.page.click('#genBtn');
  await expect(a.page.locator('#addKey')).toHaveAttribute('type', 'text');
  await a.page.fill('#addName', 'alpha');
  await a.page.click('#saveJoinBtn');
  await expect(a.page.locator('#lobbyTitle')).toHaveText('alpha');

  await a.page.click('[data-back]:visible');
  await expect(a.page.locator('.title')).toHaveText('Rooms');
  await expect(a.page.locator('#roomList .room .name')).toHaveText(['alpha']);
  await expect(a.page.locator('#roomList .room .initial')).toHaveText(['A']);
  await expect(a.page.locator('#addFirstBtn')).toBeHidden();
  await expect(a.page.locator('#savedTitle')).toBeHidden();      // no heading needed without live calls
  expectClean(a);
  await a.context.close();
});

test('forgetting all rooms asks first, in a sheet', async ({ browser }) => {
  const a = await person(browser);
  await createRoom(a.page, 'alpha');
  await a.page.click('#forgetBtn');
  await expect(a.page.locator('#confirm')).toBeVisible();
  await a.page.click('#confirmNo');
  await expect(a.page.locator('#confirm')).toBeHidden();
  await expect(a.page.locator('#roomList .room')).toHaveCount(1);
  await a.page.click('#forgetBtn');
  await a.page.click('#confirmYes');
  await expect(a.page.locator('#homeEmpty')).toBeVisible();
  expect(a.dialogs).toEqual([]);                                   // no browser pop-up
  expectClean(a);
  await a.context.close();
});

test('the invite panel names the room, copies at once and says so', async ({ browser }) => {
  const a = await person(browser);
  await createRoom(a.page, 'alpha');
  await a.page.locator('.room', { hasText: 'alpha' }).locator('.icon-btn').click();
  await expect(a.page.locator('#sheetTitle')).toHaveText('Invite to alpha');
  await expect(a.page.locator('#sheetCopyText')).toHaveText('Copied');
  await expect(a.page.locator('#sheetCopy')).toHaveClass(/primary/);   // no Share here, so Copy leads
  await expect(a.page.locator('#sheetCopyText')).toHaveText('Copy link', { timeout: 4000 });
  expect(await a.page.evaluate(() => navigator.clipboard.readText())).toContain('#room=alpha&key=');
  await a.page.click('#sheetDone');
  await expect(a.page.locator('#sheet')).toBeHidden();
  expectClean(a);
  await a.context.close();
});
