import { test, expect } from '@playwright/test';
import { person, createRoom, joinFromLink, expectClean } from './helpers.js';

const row = (page, name) => page.locator('.room', { hasText: name });
const sub = (page, name) => row(page, name).locator('.sub');

test('the rooms screen shows live who is in each call, and for how long', async ({ browser }) => {
  const a = await person(browser), b = await person(browser), c = await person(browser);
  const link = await createRoom(a.page, 'alpha');            // Peer C stays on the rooms screen
  await expect(a.page.locator('#roomList .room', { hasText: 'alpha' })).toBeVisible();
  await expect(a.page.locator('#liveSec')).toBeHidden();

  await joinFromLink(b.page, link, 'Peer B');
  await expect(sub(a.page, 'alpha')).toHaveText('Peer B · just started', { timeout: 15000 });
  await expect(a.page.locator('#liveList .room')).toHaveClass(/live/);
  await expect(a.page.locator('#liveList .room .initial')).toHaveText('A');
  await expect(a.page.locator('#liveList .btn.live')).toHaveText('Join');
  await expect(a.page.locator('#roomList .room', { hasText: 'alpha' })).toHaveCount(0);   // not listed twice

  await joinFromLink(c.page, link, 'Peer A');
  await expect(sub(a.page, 'alpha')).toHaveText('Peer A and Peer B · just started', { timeout: 15000 });

  // Leaving is shown within seconds, not after a timeout.
  await b.page.click('#cLeave');
  await expect(sub(a.page, 'alpha')).toHaveText('Peer A · just started', { timeout: 8000 });
  await c.page.click('#cLeave');
  await expect(a.page.locator('#liveSec')).toBeHidden({ timeout: 8000 });
  await expect(a.page.locator('#roomList .room', { hasText: 'alpha' })).toBeVisible();

  expectClean(a, b, c);
  for (const p of [a, b, c]) await p.context.close();
});

test('opening the rooms screen later shows who is already in, straight away', async ({ browser }) => {
  const a = await person(browser), b = await person(browser);
  const link = await createRoom(a.page, 'alpha');
  await a.page.goto('about:blank');

  await joinFromLink(b.page, link, 'Peer B');
  await b.page.waitForTimeout(2000);

  await a.page.goto('/current/');
  // Well under the 25 s heartbeat: the rooms screen asks and people in the call answer.
  await expect(sub(a.page, 'alpha')).toHaveText(/^Peer B · /, { timeout: 8000 });

  // The screen before joining says it too.
  await row(a.page, 'alpha').locator('.main').click();
  await expect(a.page.locator('#lobbyWho')).toHaveText('Peer B is in the call', { timeout: 8000 });
  await expect(a.page.locator('#lobbyLive')).toHaveText('1 in call');

  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

test('a different password sees nothing, and the relays only see scrambled notes', async ({ browser }) => {
  const a = await person(browser), b = await person(browser), eve = await person(browser);
  const frames = [];
  b.page.on('websocket', ws => ws.on('framesent', f => frames.push(String(f.payload))));

  const link = await createRoom(a.page, 'alpha');
  await joinFromLink(b.page, link, 'Peer B');
  await expect(sub(a.page, 'alpha')).toHaveText(/^Peer B · /, { timeout: 15000 });

  // Same room name, different password.
  await eve.page.goto('/current/');
  await eve.page.click('#addBtn');
  await eve.page.fill('#addName', 'alpha');
  await eve.page.click('#saveBtn');
  await eve.page.waitForTimeout(8000);
  await expect(eve.page.locator('#liveSec')).toBeHidden({ timeout: 5000 });

  expect(frames.length).toBeGreaterThan(0);
  for (const f of frames) {
    expect(f).not.toContain('Peer B');
    expect(f).not.toContain('alpha');
  }

  expectClean(a, b, eve);
  for (const p of [a, b, eve]) await p.context.close();
});

test('someone whose phone dies mid-call disappears on their own', async ({ browser }) => {
  test.setTimeout(150000);
  const a = await person(browser), b = await person(browser);
  const link = await createRoom(a.page, 'alpha');
  await joinFromLink(b.page, link, 'Peer B');
  await expect(sub(a.page, 'alpha')).toHaveText(/^Peer B · /, { timeout: 15000 });

  // No goodbye: everything Peer B sends from now on is lost, like a phone losing signal or battery.
  await b.page.evaluate(() => { WebSocket.prototype.send = () => {}; });
  await expect(a.page.locator('#liveSec')).toBeHidden({ timeout: 90000 });

  expectClean(a);
  await a.context.close(); await b.context.close();
});
