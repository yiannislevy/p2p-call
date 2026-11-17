import { test, expect } from '@playwright/test';
import { person, createRoom, joinFromLink, expectClean } from './helpers.js';

const row = (page, name) => page.locator('.room', { hasText: name });
const sub = (page, name) => row(page, name).locator('.sub');

test('the rooms screen shows live who is in each call', async ({ browser }) => {
  const a = await person(browser), b = await person(browser), c = await person(browser);
  const link = await createRoom(a.page, 'family');            // Yianni stays on the rooms screen
  await expect(sub(a.page, 'family')).toHaveText('Tap to join');

  await joinFromLink(b.page, link, 'Sarra Lee');
  await expect(sub(a.page, 'family')).toHaveText('Sarra Lee is in the call', { timeout: 15000 });
  await expect(row(a.page, 'family')).toHaveClass(/busy/);
  await expect(row(a.page, 'family').locator('.face')).toHaveText(['SL']);
  await expect(row(a.page, 'family').locator('.dot')).toBeVisible();

  await joinFromLink(c.page, link, 'Mama');
  await expect(sub(a.page, 'family')).toHaveText('Mama and Sarra Lee are in the call', { timeout: 15000 });
  await expect(row(a.page, 'family').locator('.face')).toHaveText(['M', 'SL']);

  // Leaving is shown within seconds, not after a timeout.
  await b.page.click('#cLeave');
  await expect(sub(a.page, 'family')).toHaveText('Mama is in the call', { timeout: 8000 });
  await c.page.click('#cLeave');
  await expect(sub(a.page, 'family')).toHaveText('Tap to join', { timeout: 8000 });
  await expect(row(a.page, 'family').locator('.faces')).toBeHidden();

  expectClean(a, b, c);
  for (const p of [a, b, c]) await p.context.close();
});

test('opening the rooms screen later shows who is already in, straight away', async ({ browser }) => {
  const a = await person(browser), b = await person(browser);
  const link = await createRoom(a.page, 'family');
  await a.page.goto('about:blank');

  await joinFromLink(b.page, link, 'Sarra');
  await b.page.waitForTimeout(2000);

  await a.page.goto('/current/');
  // Well under the 25 s heartbeat: the rooms screen asks and people in the call answer.
  await expect(sub(a.page, 'family')).toHaveText('Sarra is in the call', { timeout: 8000 });

  // The screen before joining says it too.
  await row(a.page, 'family').locator('.main').click();
  await expect(a.page.locator('#lobbyWho')).toHaveText('Sarra is in the call', { timeout: 8000 });

  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

test('a different password sees nothing, and the relays only see scrambled notes', async ({ browser }) => {
  const a = await person(browser), b = await person(browser), eve = await person(browser);
  const frames = [];
  b.page.on('websocket', ws => ws.on('framesent', f => frames.push(String(f.payload))));

  const link = await createRoom(a.page, 'family');
  await joinFromLink(b.page, link, 'Sarra');
  await expect(sub(a.page, 'family')).toHaveText('Sarra is in the call', { timeout: 15000 });

  // Same room name, different password.
  await eve.page.goto('/current/');
  await eve.page.click('#addBtn');
  await eve.page.fill('#addName', 'family');
  await eve.page.click('#saveBtn');
  await eve.page.waitForTimeout(8000);
  await expect(sub(eve.page, 'family')).toHaveText('Tap to join');

  expect(frames.length).toBeGreaterThan(0);
  for (const f of frames) {
    expect(f).not.toContain('Sarra');
    expect(f).not.toContain('family');
  }

  expectClean(a, b, eve);
  for (const p of [a, b, eve]) await p.context.close();
});

test('someone whose phone dies mid-call disappears on their own', async ({ browser }) => {
  test.setTimeout(150000);
  const a = await person(browser), b = await person(browser);
  const link = await createRoom(a.page, 'family');
  await joinFromLink(b.page, link, 'Sarra');
  await expect(sub(a.page, 'family')).toHaveText('Sarra is in the call', { timeout: 15000 });

  // No goodbye: everything Sarra sends from now on is lost, like a phone losing signal or battery.
  await b.page.evaluate(() => { WebSocket.prototype.send = () => {}; });
  await expect(sub(a.page, 'family')).toHaveText('Tap to join', { timeout: 90000 });

  expectClean(a);
  await a.context.close(); await b.context.close();
});
