import { test, expect } from '@playwright/test';
import { person, meta, createRoom, joinFromHome, joinFromLink, playingVideos, tiles, expectClean } from './helpers.js';

// Phones update at different times, so a new release must still call the previous one.
test('the new version and the previous release can call each other', async ({ browser }) => {
  const { previous } = meta();
  test.skip(!previous, 'no earlier release to compare with');

  const fresh = await person(browser), old = await person(browser);
  const link = await createRoom(fresh.page, 'family');
  await joinFromHome(fresh.page, 'family', 'New');
  await joinFromLink(old.page, link.replace('/current/', '/previous/'), 'Old');

  await playingVideos(fresh.page).toBe(1);
  await playingVideos(old.page).toBe(1);
  expect((await tiles(fresh.page))[0].name).toBe('Old');
  expect((await tiles(old.page))[0].name).toBe('New');

  expectClean(fresh, old);
  await fresh.context.close(); await old.context.close();
});
