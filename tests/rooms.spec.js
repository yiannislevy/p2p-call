import { test, expect } from '@playwright/test';
import { person, createRoom, expectClean } from './helpers.js';

// Rooms live per browser (Safari and the home screen app don't share them). They move by
// copying them all in one and pasting them in the other.

const shownRooms = page => page.locator('#roomList .room .name').allTextContents();

test('rooms move to another browser or the home screen app by copy and paste, with your own names', async ({ browser }) => {
  const a = await person(browser), b = await person(browser);
  await createRoom(a.page, 'alpha');
  await createRoom(a.page, 'beta');
  await createRoom(a.page, 'gamma');

  // Peer C gives "beta" his own name and moves it to the top.
  await a.page.click('#editBtn');
  const row = a.page.locator('#roomList .room').nth(1);
  await row.locator('input.label').fill('Crew');
  await row.locator('input.label').press('Enter');
  await expect(row.locator('.real')).toHaveText('Room: beta');
  await row.getByRole('button', { name: 'Move up Crew' }).click();
  await a.page.click('#copyAllBtn');
  await a.page.click('#editBtn');
  expect(await shownRooms(a.page)).toEqual(['Crew', 'alpha', 'gamma']);
  const copied = await a.page.evaluate(() => navigator.clipboard.readText());
  expect(copied.split('\n')).toHaveLength(3);

  // In the other browser: Paste invite links.
  await b.page.goto('/current/');
  // Typed or pasted into the box: it says what it found, and the button says how many it adds.
  await b.page.click('#pasteLinksBtn');
  await expect(b.page.locator('#importBtn')).toBeDisabled();
  await b.page.fill('#importText', copied);
  await expect(b.page.locator('#importFound')).toHaveText('Found 3 rooms: Crew, alpha, gamma');
  await expect(b.page.locator('#importBtn')).toHaveText('Add 3 rooms');
  await expect(b.page.locator('#pasteBtn')).not.toHaveClass(/primary/);   // one black button at a time
  await b.page.click('#importBtn');
  await expect(b.page.locator('#home')).toBeVisible();
  await expect(b.page.locator('#toasts')).toContainText('Added 3 rooms');
  expect(await shownRooms(b.page)).toEqual(['Crew', 'alpha', 'gamma']);

  // Same rooms, not lookalikes: the invite links match, with the real room name in them.
  const linkOf = async (page, shown) => {
    await page.locator('.room', { hasText: shown }).locator('.icon-btn').click();
    await expect(page.locator('#sheet')).toBeVisible();
    const link = await page.inputValue('#sheetLink');
    await page.click('#sheetDone');
    return link.split('#')[1];
  };
  expect(await linkOf(b.page, 'Crew')).toBe(await linkOf(a.page, 'Crew'));
  expect(await linkOf(b.page, 'Crew')).toContain('room=beta');

  // Pasting again adds nothing twice, and says so.
  await b.page.click('#pasteLinksBtn');
  await b.page.fill('#importText', copied);
  await expect(b.page.locator('#importFound')).toContainText('Crew (already here)');
  await expect(b.page.locator('#importBtn')).toBeDisabled();
  await expect(b.page.locator('#importBtn')).toHaveText('You already have these');
  await b.page.click('[data-back]:visible');
  expect(await shownRooms(b.page)).toEqual(['Crew', 'alpha', 'gamma']);

  // Your own names stay after a reload, and show before joining.
  await b.page.reload();
  expect(await shownRooms(b.page)).toEqual(['Crew', 'alpha', 'gamma']);
  await b.page.locator('.room', { hasText: 'Crew' }).locator('.main').click();
  await expect(b.page.locator('#lobbyTitle')).toHaveText('Crew');

  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

test('a pasted message with an invite link adds the room, and the Paste button reads the clipboard', async ({ browser }) => {
  const a = await person(browser), b = await person(browser);
  const link = await createRoom(a.page, 'alpha');

  await b.page.goto('/current/');
  await b.page.evaluate(text => navigator.clipboard.writeText(text), `Join us tonight! ${link} see you`);
  await b.page.click('#pasteLinksBtn');
  await b.page.click('#pasteBtn');
  await expect(b.page.locator('#home')).toBeVisible();
  expect(await shownRooms(b.page)).toEqual(['alpha']);    // the message text is not taken as a name

  // Text without links says what to paste; a clipboard without links says how to get them.
  await b.page.click('#pasteLinksBtn');
  await b.page.fill('#importText', 'hello there');
  await expect(b.page.locator('#importFound')).toContainText('No invite links in this text yet');
  await expect(b.page.locator('#importBtn')).toBeDisabled();
  await b.page.evaluate(() => navigator.clipboard.writeText('nothing useful'));
  await b.page.click('#pasteBtn');
  await expect(b.page.locator('#importErr')).toContainText('Your clipboard has no invite links');

  // From the create screen there is a way to the paste screen too.
  await b.page.click('[data-back]:visible');
  await b.page.click('#addBtn');
  await b.page.click('#toPaste');
  await expect(b.page.locator('#pasteBtn')).toBeVisible();
  await expect(b.page.locator('#addName')).toBeHidden();
  expectClean(a, b);
  await a.context.close(); await b.context.close();
});
