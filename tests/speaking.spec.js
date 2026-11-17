import { test, expect } from '@playwright/test';
import { person, createRoom, joinFromHome, joinFromLink, playingVideos, expectClean } from './helpers.js';

// The fake test microphone plays a beep about once a second, which counts as talking.

// Watch a tile for a while and report whether it was ever outlined.
const sampleSpeaking = (page, name, ms) => page.evaluate(async ([n, duration]) => {
  const tile = () => [...document.querySelectorAll('#grid .tile')].find(t => t.querySelector('.tag span').textContent === n);
  let seen = false;
  const end = Date.now() + duration;
  while (Date.now() < end) {
    if (tile() && tile().classList.contains('speaking')) seen = true;
    await new Promise(r => setTimeout(r, 50));
  }
  return seen;
}, [name, ms]);

const sampleSelf = (page, ms) => page.evaluate(async duration => {
  let seen = false;
  const end = Date.now() + duration;
  while (Date.now() < end) {
    if (document.getElementById('self').classList.contains('speaking')) seen = true;
    await new Promise(r => setTimeout(r, 50));
  }
  return seen;
}, ms);

test("the person talking gets an outline, and a muted person never does", async ({ browser }) => {
  const a = await person(browser), b = await person(browser);
  const link = await createRoom(a.page, 'family');
  await joinFromHome(a.page, 'family', 'Yianni');
  await joinFromLink(b.page, link, 'Sarra');
  await playingVideos(a.page).toBe(1);

  expect(await sampleSpeaking(a.page, 'Sarra', 5000)).toBe(true);
  expect(await sampleSelf(b.page, 5000)).toBe(true);       // her own small video shows it too

  await b.page.click('#cMic');
  expect(await b.page.evaluate(() => document.getElementById('self').classList.contains('speaking'))).toBe(false);   // instantly
  await a.page.waitForTimeout(1500);
  expect(await sampleSpeaking(a.page, 'Sarra', 4000)).toBe(false);
  expect(await sampleSelf(b.page, 3000)).toBe(false);

  await b.page.click('#cMic');
  expect(await sampleSpeaking(a.page, 'Sarra', 6000)).toBe(true);

  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

test('in a group, only the people actually talking are outlined', async ({ browser }) => {
  const a = await person(browser), b = await person(browser), c = await person(browser);
  const link = await createRoom(a.page, 'family');
  await joinFromHome(a.page, 'family', 'Yianni');
  await joinFromLink(b.page, link, 'Sarra');
  await joinFromLink(c.page, link, 'Mama');
  for (const p of [a, b, c]) await playingVideos(p.page).toBe(2);

  // Yianni and Mama mute; only Sarra is talking.
  await a.page.click('#cMic');
  await c.page.click('#cMic');
  await a.page.waitForTimeout(1500);
  const [aSeesSarra, aSeesMama, cSeesSarra, cSeesYianni] = await Promise.all([
    sampleSpeaking(a.page, 'Sarra', 5000), sampleSpeaking(a.page, 'Mama', 5000),
    sampleSpeaking(c.page, 'Sarra', 5000), sampleSpeaking(c.page, 'Yianni', 5000)
  ]);
  expect({ aSeesSarra, aSeesMama, cSeesSarra, cSeesYianni }).toEqual({ aSeesSarra: true, aSeesMama: false, cSeesSarra: true, cSeesYianni: false });

  expectClean(a, b, c);
  for (const p of [a, b, c]) await p.context.close();
});

test('nobody is outlined when you are alone in the call', async ({ browser }) => {
  const a = await person(browser);
  await createRoom(a.page, 'family');
  await joinFromHome(a.page, 'family', 'Yianni');
  expect(await sampleSelf(a.page, 3000)).toBe(false);
  expectClean(a);
  await a.context.close();
});
