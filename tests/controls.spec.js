import { test, expect } from '@playwright/test';
import { person, createRoom, joinFromHome, joinFromLink, playingVideos, poll, expectClean } from './helpers.js';

// Where things are on screen right now.
const view = page => page.evaluate(() => {
  const self = document.getElementById('self');
  const grid = document.getElementById('grid');
  const pip = document.querySelector('#call > .tile.as-pip');
  return {
    selfInGrid: !!self.closest('#grid'),
    selfPlaying: !self.paused && self.videoWidth > 0,
    gridNames: [...grid.querySelectorAll(':scope > .tile .tag span')].map(s => s.textContent),
    pip: pip ? pip.querySelector('.tag span').textContent : null,
    pipPlaying: pip ? pip.querySelector('video').videoWidth > 0 && !pip.querySelector('video').paused : null,
    swapped: document.getElementById('call').classList.contains('swapped')
  };
});

async function call(browser, names) {
  const ps = [];
  for (const _ of names) ps.push(await person(browser));
  const link = await createRoom(ps[0].page, 'family');
  await joinFromHome(ps[0].page, 'family', names[0]);
  for (let i = 1; i < names.length; i++) await joinFromLink(ps[i].page, link, names[i]);
  for (const p of ps) await playingVideos(p.page).toBe(names.length - 1);
  return { ps, link };
}

test('1-on-1: tapping your own video swaps it with theirs, and tapping again swaps back', async ({ browser }) => {
  const { ps: [a, b] } = await call(browser, ['Yianni', 'Sarra']);
  expect(await view(a.page)).toMatchObject({ selfInGrid: false, gridNames: ['Sarra'], pip: null, swapped: false });

  for (let round = 0; round < 3; round++) {
    await a.page.click('#self');
    await poll(a.page, () => document.getElementById('self').videoWidth > 0 && !document.getElementById('self').paused).toBe(true);
    expect(await view(a.page)).toMatchObject({ selfInGrid: true, selfPlaying: true, gridNames: ['You'], pip: 'Sarra', pipPlaying: true, swapped: true });

    await a.page.click('#call > .tile.as-pip');
    expect(await view(a.page)).toMatchObject({ selfInGrid: false, selfPlaying: true, gridNames: ['Sarra'], pip: null, swapped: false });
  }
  // The other side never notices.
  await playingVideos(b.page).toBe(1);

  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

test('group: your video takes the big spot, the big one goes small, everything else stays', async ({ browser }) => {
  const { ps: [a, b, c] } = await call(browser, ['Yianni', 'Sarra', 'Mama']);
  const before = (await view(a.page)).gridNames;
  expect(before.length).toBe(2);

  await a.page.click('#self');
  const v = await view(a.page);
  expect(v.gridNames).toEqual(['You', before[1]]);
  expect(v.pip).toBe(before[0]);
  expect(v.pipPlaying).toBe(true);

  // Tapping your own (now big) video swaps back too, in the original order.
  await a.page.click('#grid .tile.me');
  expect(await view(a.page)).toMatchObject({ selfInGrid: false, gridNames: before, pip: null });

  expectClean(a, b, c);
  for (const p of [a, b, c]) await p.context.close();
});

test('someone joining or leaving while swapped returns to the normal view cleanly', async ({ browser }) => {
  const { ps: [a, b], link } = await call(browser, ['Yianni', 'Sarra']);
  await a.page.click('#self');
  expect((await view(a.page)).swapped).toBe(true);

  const c = await person(browser);
  await joinFromLink(c.page, link, 'Mama');
  await playingVideos(a.page).toBe(2);
  const v = await view(a.page);
  expect(v).toMatchObject({ selfInGrid: false, pip: null, swapped: false });
  expect(v.gridNames.sort()).toEqual(['Mama', 'Sarra']);
  expect(await a.page.locator('#call .tile').count()).toBe(2);   // no leftover tiles

  // Swapped again, and the person shown small leaves.
  await a.page.click('#self');
  const small = (await view(a.page)).pip;
  await (small === 'Mama' ? c : b).page.click('#cLeave');
  await poll(a.page, () => document.querySelectorAll('#call .tile').length).toBe(1);
  const after = await view(a.page);
  expect(after).toMatchObject({ selfInGrid: false, pip: null, swapped: false, selfPlaying: true });
  expect(after.gridNames).toEqual([small === 'Mama' ? 'Sarra' : 'Mama']);

  expectClean(a, b, c);
  for (const p of [a, b, c]) await p.context.close();
});

test('leaving while swapped, then joining again, starts with the normal view', async ({ browser }) => {
  const { ps: [a, b] } = await call(browser, ['Yianni', 'Sarra']);
  await a.page.click('#self');
  await a.page.click('#cLeave');
  await expect(a.page.locator('#home')).toBeVisible();
  expect(await a.page.evaluate(() => !!document.querySelector('#call > #self') && !document.querySelector('.tile.me'))).toBe(true);

  await a.page.locator('.room .main').click();
  await a.page.click('#joinBtn');
  await playingVideos(a.page).toBe(1);
  expect(await view(a.page)).toMatchObject({ selfInGrid: false, gridNames: ['Sarra'], swapped: false });

  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

test('keyboard: M mutes, V camera, S swaps, I invites, D details, Esc closes', async ({ browser }) => {
  const a = await person(browser, { isMobile: false, hasTouch: false, viewport: { width: 1280, height: 800 } });
  const b = await person(browser);
  const link = await createRoom(a.page, 'family');
  await joinFromHome(a.page, 'family', 'Yianni');
  await joinFromLink(b.page, link, 'Sarra');
  await playingVideos(a.page).toBe(1);
  const tileOnB = () => b.page.evaluate(() => {
    const t = document.querySelector('#grid .tile');
    return { muted: t.classList.contains('muted'), status: t.querySelector('.ph-status').textContent };
  });

  await a.page.keyboard.press('m');
  await expect(a.page.locator('#cMic .lb')).toHaveText('Unmute');
  await poll(b.page, () => document.querySelector('#grid .tile').classList.contains('muted')).toBe(true);
  await a.page.keyboard.press('M');
  await expect(a.page.locator('#cMic .lb')).toHaveText('Mute');

  await a.page.keyboard.press('v');
  await poll(b.page, () => document.querySelector('#grid .tile .ph-status').textContent).toBe('Camera off');
  await a.page.keyboard.press('v');
  await poll(b.page, () => document.querySelector('#grid .tile .ph').hidden).toBe(true);
  expect(await tileOnB()).toEqual({ muted: false, status: '' });

  await a.page.keyboard.press('s');
  expect((await view(a.page)).swapped).toBe(true);
  await a.page.keyboard.press('s');
  expect((await view(a.page)).swapped).toBe(false);

  await a.page.keyboard.press('d');
  await expect(a.page.locator('#details')).toBeVisible();
  await expect(a.page.locator('#detailsKeys')).toBeVisible();   // shortcuts listed on computers
  await a.page.keyboard.press('Escape');
  await expect(a.page.locator('#details')).toBeHidden();

  await a.page.keyboard.press('i');
  await expect(a.page.locator('#sheet')).toBeVisible();
  expect(await a.page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  await a.page.keyboard.press('m');                                // ignored while the invite panel is open
  await expect(a.page.locator('#cMic .lb')).toHaveText('Mute');
  await a.page.keyboard.press('Escape');
  await expect(a.page.locator('#sheet')).toBeHidden();

  // Shortcuts with Ctrl/Cmd (copy, paste, browser keys) are left alone.
  await a.page.keyboard.press('Control+m');
  await a.page.keyboard.press('Meta+v');
  await expect(a.page.locator('#cMic .lb')).toHaveText('Mute');
  expect(await tileOnB()).toEqual({ muted: false, status: '' });

  expectClean(a, b);
  await a.context.close(); await b.context.close();
});

test('keys do nothing outside a call or while typing', async ({ browser }) => {
  const a = await person(browser, { isMobile: false, hasTouch: false });
  await createRoom(a.page, 'family');
  await a.page.keyboard.press('i');
  await a.page.keyboard.press('s');
  await expect(a.page.locator('#sheet')).toBeHidden();
  await expect(a.page.locator('#home')).toBeVisible();

  // Typing a name with m, v, s, i, d in it before joining.
  await a.page.locator('.room .main').click();
  await a.page.fill('#nameInput', '');
  await a.page.type('#nameInput', 'Maria Davis');
  await expect(a.page.locator('#nameInput')).toHaveValue('Maria Davis');
  await expect(a.page.locator('#pMic')).not.toHaveClass(/is-off/);
  await expect(a.page.locator('#lobby')).toBeVisible();

  expectClean(a);
  await a.context.close();
});

test('buttons say what they do and their key', async ({ browser }) => {
  const a = await person(browser);
  await a.page.goto('/current/');
  for (const [id, title] of [['cMic', 'Mute or unmute (M)'], ['cCam', 'Camera on or off (V)'], ['topInvite', 'Invite people (I)'], ['whoBtn', 'Connection details (D)'], ['self', 'Swap views (S)']]) {
    await expect(a.page.locator('#' + id)).toHaveAttribute('title', title);
  }
  await a.context.close();
});
