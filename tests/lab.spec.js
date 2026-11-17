import { test, expect } from '@playwright/test';
import { person, expectClean } from './helpers.js';

test('the iPhone check page runs its three checks and reports them', async ({ browser }) => {
  const a = await person(browser);
  await a.page.goto('/current/lab/pip.html');
  await expect(a.page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);

  await a.page.click('#start');
  await expect(a.page.locator('#startResult')).toHaveText('Camera and microphone work.', { timeout: 15000 });
  await expect.poll(() => a.page.evaluate(() => document.getElementById('remote').videoWidth), { timeout: 15000 }).toBeGreaterThan(0);

  await a.page.click('#pip');
  await expect(a.page.locator('#pipResult')).not.toHaveText('');

  await a.page.click('#bg');
  await a.page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await a.page.waitForTimeout(3000);
  await a.page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(a.page.locator('#bgResult')).toContainText('Away 3 s', { timeout: 10000 });
  const report = JSON.parse(await a.page.locator('#report').textContent());
  expect(report.camera).toBe('ok');
  expect(report.background.secondsAway).toBe(3);
  expect(report.pip).toBeTruthy();
  expect(report.callVideo).toMatch(/^ok/);
  expect(report.background.callConnection).toBe('connected');
  expect(report.background.callAudioPacketsPerSecondWhileAway).toBeGreaterThan(20);

  expectClean(a);
  await a.context.close();
});
