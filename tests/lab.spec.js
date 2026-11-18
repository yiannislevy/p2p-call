import { test, expect } from '@playwright/test';
import { person, expectClean } from './helpers.js';

test('the check page runs its checks and reports them, and the old address still works', async ({ browser }) => {
  const a = await person(browser);
  await a.page.goto('/current/lab/pip.html');
  await expect(a.page).toHaveURL(/\/lab\/check\.html$/);
  await expect(a.page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  await a.page.fill('#who', 'Sarra');
  await a.page.click('#netChoice .chip[data-net="wifi"]');
  await a.page.click('details summary');

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
  expect(report.who).toBe('Sarra');
  expect(report.on).toBe('wifi');
  expect(report.callVideo).toMatch(/^ok/);
  expect(report.background.callConnection).toBe('connected');
  expect(report.background.callAudioPacketsPerSecondWhileAway).toBeGreaterThan(20);

  expectClean(a);
  await a.context.close();
});

// Stand-in for a network: the public helpers report these ports, in this order, per round.
const fakeNetwork = rounds => {
  let round = 0;
  window.RTCPeerConnection = class {
    createDataChannel() { return {}; }
    async createOffer() { return { type: 'offer', sdp: '' }; }
    async setLocalDescription() {
      const ports = rounds[round++] || [];
      setTimeout(() => {
        ports.forEach((port, i) => this.onicecandidate && this.onicecandidate({ candidate: {
          candidate: `candidate:${i} 1 udp 1 203.0.113.7 ${port} typ srflx raddr 0.0.0.0 rport 50000`,
          type: 'srflx', address: '203.0.113.7', port, relatedPort: 50000, protocol: 'udp' } }));
        this.onicecandidate && this.onicecandidate({ candidate: null });
      }, 10);
    }
    close() {}
  };
};

for (const [name, rounds, verdict] of [
  ['one port for everyone', [[40001], [40002], [40003]], 'same port for everyone'],
  ['new ports in order', [[40001, 40002, 40003, 40004, 40005, 40006], [40007, 40008, 40009, 40010, 40011, 40012], [40013, 40014, 40015, 40016, 40017, 40018]], 'changes, in order'],
  ['random ports', [[40001, 52847, 19432, 61203, 8847, 33000], [12000, 41000, 27000, 9000, 60000, 1500], [30000, 2000, 45000, 15000, 50000, 22000]], 'changes, at random'],
  ['nothing at all', [[], [], []], 'blocked']
]) {
  test(`the network check tells ${name}`, async ({ browser }) => {
    const a = await person(browser);
    await a.page.addInitScript(fakeNetwork, rounds);
    await a.page.goto('/current/lab/check.html');
    await a.page.click('#net');
    await expect(a.page.locator('#netResult')).not.toHaveText(/Testing|^$/, { timeout: 10000 });
    const report = JSON.parse(await a.page.locator('#report').textContent());
    expect(report.network[0].verdict).toBe(verdict);
    expectClean(a);
    await a.context.close();
  });
}
