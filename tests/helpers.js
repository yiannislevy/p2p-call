import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

export const meta = () => JSON.parse(readFileSync('tests/.sites/meta.json', 'utf8'));

// One person = one separate browser profile on an iPhone-sized screen with a fake camera.
export async function person(browser, opts = {}) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'],
    ...opts
  });
  const page = await context.newPage();
  const problems = [];
  const requests = [];
  const dialogs = [];
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', e => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`));
  });
  page.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', e => problems.push(`page error: ${e.message}`));
  page.on('request', r => requests.push(r.url()));
  page.on('dialog', d => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  return { context, page, problems, requests, dialogs };
}

// The page forbids eval, so poll with evaluate() instead of waitForFunction().
export const poll = (page, fn, arg, timeout = 30000) => expect.poll(() => page.evaluate(fn, arg).catch(() => undefined), { timeout });

export async function createRoom(page, name, base = '/current/') {
  await page.goto(base);
  await page.click('#addBtn');
  await page.fill('#addName', name);
  await page.click('#saveBtn');
  await expect(page.locator('#home')).toBeVisible();
  await page.locator('.room', { hasText: name }).locator('.icon-btn').click();
  await expect(page.locator('#sheet')).toBeVisible();
  const link = await page.inputValue('#sheetLink');
  await page.click('#sheetDone');
  return link;
}

export async function joinFromHome(page, roomName, myName) {
  await page.locator('.room', { hasText: roomName }).locator('.main').click();
  await page.fill('#nameInput', myName);
  await page.click('#joinBtn');
  await expect(page.locator('#call')).toBeVisible({ timeout: 15000 });
}

export async function joinFromLink(page, link, myName) {
  await page.goto(link);
  await expect(page.locator('#lobby')).toBeVisible();
  await page.fill('#nameInput', myName);
  await page.click('#joinBtn');
  await expect(page.locator('#call')).toBeVisible({ timeout: 15000 });
}

export const playingVideos = (page, timeout) => poll(page, () =>
  [...document.querySelectorAll('#grid .tile video')].filter(v => v.videoWidth > 0 && v.closest('.tile').querySelector('.ph').hidden).length, undefined, timeout);

export const tiles = page => page.evaluate(() => [...document.querySelectorAll('#grid .tile')].map(t => ({
  name: t.querySelector('.tag span').textContent,
  muted: t.classList.contains('muted'),
  placeholder: !t.querySelector('.ph').hidden,
  status: t.querySelector('.ph-status').textContent
})).sort((a, b) => a.name.localeCompare(b.name)));

export function expectClean(...people) {
  for (const p of people) {
    expect(p.problems, 'console errors, security-policy violations or page errors').toEqual([]);
    expect(p.dialogs, 'unexpected dialogs').toEqual([]);
  }
}
