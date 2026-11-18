import { test, expect } from '@playwright/test';
import { person, createRoom, joinFromHome, joinFromLink, playingVideos, poll, expectClean } from './helpers.js';

// Two people whose networks can't connect to each other, in a call with a third person who
// can reach both: that person's phone passes each one's video and sound to the other.
// (Test builds can refuse a direct connection with a named person, like blocking networks.)

const tileNames = page => page.evaluate(() => [...document.querySelectorAll('#grid .tile .tag span')].map(s => s.textContent).sort());

test('two people who cannot connect directly see each other through a third', async ({ browser }) => {
  test.setTimeout(150000);
  const a = await person(browser), b = await person(browser), c = await person(browser);
  await a.page.addInitScript(() => { window.__block = 'Sarra'; });
  await b.page.addInitScript(() => { window.__block = 'Yianni'; });
  const link = await createRoom(a.page, 'family');
  await joinFromHome(a.page, 'family', 'Yianni');
  await joinFromLink(c.page, link, 'Mama');
  await playingVideos(a.page).toBe(1);
  await joinFromLink(b.page, link, 'Sarra');

  // Mama sees both directly; Yianni and Sarra see each other passed along by Mama's phone.
  await playingVideos(c.page, 30000).toBe(2);
  await playingVideos(a.page, 60000).toBe(2);
  await playingVideos(b.page, 60000).toBe(2);
  expect(await tileNames(a.page)).toEqual(['Mama', 'Sarra']);
  expect(await tileNames(b.page)).toEqual(['Mama', 'Yianni']);
  await a.page.click('#whoBtn');
  await expect(a.page.locator('#detailsList li', { hasText: 'Sarra' })).toContainText("passed along by Mama's phone");
  await a.page.click('#detailsClose');

  // Sarra mutes: Yianni sees it, although nothing comes to him from her directly.
  await b.page.click('#cMic');
  await poll(a.page, () => [...document.querySelectorAll('#grid .tile')].find(t => t.querySelector('.tag span').textContent === 'Sarra').classList.contains('muted'), undefined, 15000).toBe(true);

  // Sarra talks again: Yianni sees her outlined, although her voice comes through Mama.
  await b.page.click('#cMic');
  await poll(a.page, async () => {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      const t = [...document.querySelectorAll('#grid .tile')].find(x => x.querySelector('.tag span').textContent === 'Sarra');
      if (t && t.classList.contains('speaking')) return true;
      await new Promise(r => setTimeout(r, 50));
    }
    return false;
  }, undefined, 20000).toBe(true);

  // Mama leaves: nobody can pass Sarra along any more, and Yianni's tile says so.
  await c.page.click('#cLeave');
  await poll(a.page, () => {
    const t = [...document.querySelectorAll('#grid .tile')].find(x => x.querySelector('.tag span').textContent === 'Sarra');
    return !t || t.classList.contains('reconnecting');
  }, undefined, 20000).toBe(true);

  expectClean(a, b, c);
  for (const p of [a, b, c]) await p.context.close();
});
