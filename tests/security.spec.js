import { test, expect } from '@playwright/test';
import { person, meta, createRoom, joinFromHome, joinFromLink, playingVideos, expectClean } from './helpers.js';

test('someone with the wrong password never meets the room', async ({ browser }) => {
  const a = await person(browser), eve = await person(browser);
  const link = await createRoom(a.page, 'family');
  await joinFromHome(a.page, 'family', 'Yianni');

  const wrong = link.replace(/key=[^&]+/, 'key=aaaa-bbbb-cccc-dddd');
  await joinFromLink(eve.page, wrong, 'Eve');
  await eve.page.waitForTimeout(8000);
  expect(await a.page.locator('#grid .tile').count()).toBe(0);
  expect(await eve.page.locator('#grid .tile').count()).toBe(0);

  expectClean(a, eve);
  await a.context.close(); await eve.context.close();
});

test('room names and people names are only ever shown as text', async ({ browser }) => {
  const a = await person(browser), b = await person(browser);
  const evilRoom = '<img src=x onerror=alert(1)>';
  const evilName = '<b onmouseover=alert(2)>x</b>';
  const link = `/current/#room=${encodeURIComponent(evilRoom)}&key=abcd-efgh-jkmn-pqrs`;

  await joinFromLink(a.page, link, evilName);
  await joinFromLink(b.page, link, 'Bob');
  await playingVideos(b.page).toBe(1);

  await expect(b.page.locator('#grid .tag span')).toHaveText(evilName);
  await expect(a.page.locator('#callRoom')).toHaveText(evilRoom);
  for (const p of [a, b]) expect(await p.page.locator('img, b').count()).toBe(0);

  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

test('the app only talks to its own site and the relays', async ({ browser }) => {
  const a = await person(browser), b = await person(browser);
  const link = await createRoom(a.page, 'family');
  await joinFromHome(a.page, 'family', 'Yianni');
  await joinFromLink(b.page, link, 'Sarra');
  await playingVideos(a.page).toBe(1);

  for (const p of [a, b]) {
    const foreign = p.requests.filter(u => !u.startsWith('http://localhost:8800/') && !u.startsWith('data:') && !u.startsWith('blob:'));
    expect(foreign).toEqual([]);
  }
  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

test('the app refuses to run inside another page (clickjacking)', async ({ browser }) => {
  const a = await person(browser);
  await a.page.goto('/frame.html');
  await a.page.waitForTimeout(1500);
  const frame = a.page.frameLocator('#f');
  await expect(frame.locator('#home')).toHaveCount(0);
  await a.context.close();
});

test('kept out of search engines and shows its version', async ({ browser }) => {
  const a = await person(browser);
  await a.page.goto('/current/');
  await expect(a.page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  await expect(a.page.locator('#ver')).toHaveText(`Version ${meta().current}`);
  // Every file is tied to this release so phones never mix versions.
  const html = await (await a.page.request.get('/current/')).text();
  expect(html).toContain(`app.js?v=${meta().current}`);
  expectClean(a);
  await a.context.close();
});
