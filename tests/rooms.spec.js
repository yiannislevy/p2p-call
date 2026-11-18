import { test, expect } from '@playwright/test';
import { person, createRoom, expectClean } from './helpers.js';

// Rooms live per browser (Safari and the home screen app don't share them). They move by
// copying them all in one and pasting them in the other.

const shownRooms = page => page.locator('#roomList .room .name').allTextContents();

test('rooms move to another browser or the home screen app by copy and paste, with your own names', async ({ browser }) => {
  const a = await person(browser), b = await person(browser);
  await createRoom(a.page, 'family');
  await createRoom(a.page, 'friends');
  await createRoom(a.page, 'gf');

  // Yianni gives "friends" his own name and moves it to the top.
  await a.page.click('#editBtn');
  const row = a.page.locator('#roomList .room').nth(1);
  await row.locator('input.label').fill('Mates');
  await row.locator('input.label').press('Enter');
  await expect(row.locator('.real')).toHaveText('Room: friends');
  await row.getByRole('button', { name: 'Move up Mates' }).click();
  await a.page.click('#copyAllBtn');
  await a.page.click('#editBtn');
  expect(await shownRooms(a.page)).toEqual(['Mates', 'family', 'gf']);
  const copied = await a.page.evaluate(() => navigator.clipboard.readText());
  expect(copied.split('\n')).toHaveLength(3);

  // In the other browser: Paste invite links.
  await b.page.goto('/current/');
  await b.page.click('#pasteLinksBtn');
  await expect(b.page.locator('#importText')).toBeFocused();
  await b.page.fill('#importText', copied);
  await b.page.click('#importBtn');
  await expect(b.page.locator('#home')).toBeVisible();
  await expect(b.page.locator('#toasts')).toContainText('Added 3 rooms');
  expect(await shownRooms(b.page)).toEqual(['Mates', 'family', 'gf']);

  // Same rooms, not lookalikes: the invite links match, with the real room name in them.
  const linkOf = async (page, shown) => {
    await page.locator('.room', { hasText: shown }).locator('.icon-btn').click();
    await expect(page.locator('#sheet')).toBeVisible();
    const link = await page.inputValue('#sheetLink');
    await page.click('#sheetDone');
    return link.split('#')[1];
  };
  expect(await linkOf(b.page, 'Mates')).toBe(await linkOf(a.page, 'Mates'));
  expect(await linkOf(b.page, 'Mates')).toContain('room=friends');

  // Pasting again adds nothing twice.
  await b.page.click('#pasteLinksBtn');
  await b.page.fill('#importText', copied);
  await b.page.click('#importBtn');
  await expect(b.page.locator('#toasts')).toContainText('You already had these rooms');
  expect(await shownRooms(b.page)).toEqual(['Mates', 'family', 'gf']);

  // Your own names stay after a reload, and show before joining.
  await b.page.reload();
  expect(await shownRooms(b.page)).toEqual(['Mates', 'family', 'gf']);
  await b.page.locator('.room', { hasText: 'Mates' }).locator('.main').click();
  await expect(b.page.locator('#lobbyTitle')).toHaveText('Mates');

  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

test('a pasted message with an invite link adds the room, and the Paste button reads the clipboard', async ({ browser }) => {
  const a = await person(browser), b = await person(browser);
  const link = await createRoom(a.page, 'family');

  await b.page.goto('/current/');
  await b.page.evaluate(text => navigator.clipboard.writeText(text), `Join us tonight! ${link} see you`);
  await b.page.click('#pasteLinksBtn');
  await b.page.click('#pasteBtn');
  await expect(b.page.locator('#home')).toBeVisible();
  expect(await shownRooms(b.page)).toEqual(['family']);    // the message text is not taken as a name

  // Text without links says what to paste.
  await b.page.click('#pasteLinksBtn');
  await b.page.fill('#importText', 'hello there');
  await b.page.click('#importBtn');
  await expect(b.page.locator('#importErr')).toContainText('No invite links found');
  expectClean(a, b);
  await a.context.close(); await b.context.close();
});
