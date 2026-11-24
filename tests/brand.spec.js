import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { person } from './helpers.js';

// The design tokens, as written in style.css: light first, then the dark overrides.
function tokens() {
  const css = readFileSync('style.css', 'utf8');
  const light = css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)'));
  const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
  const dark = css.slice(darkStart, css.indexOf('}\n}', darkStart));
  const read = block => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map(m => [m[1], m[2]]));
  const l = read(light);
  return { light: l, dark: { ...l, ...read(dark) } };
}
const lum = hex => {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(x => x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('every text colour meets WCAG AA on what it sits on, in light and dark', () => {
  const t = tokens();
  const pairs = [
    ['text', 'bg', 4.5], ['text', 'surface', 4.5],
    ['text-secondary', 'bg', 4.5], ['text-secondary', 'surface', 4.5],
    ['text-muted', 'bg', 4.5], ['text-muted', 'surface', 4.5],
    ['on-brand', 'brand', 4.5],
    ['accent', 'bg', 4.5], ['accent', 'surface', 4.5], ['accent', 'accent-tint', 4.5], ['on-accent', 'accent', 4.5],
    ['danger', 'bg', 4.5], ['danger', 'surface', 4.5], ['danger', 'danger-tint', 4.5],
    ['live', 'video', 4.5], ['danger-on-video', 'video', 4.5],
    ['control', 'bg', 3], ['control', 'surface', 3]   // outlines of fields and switches
  ];
  const fails = [];
  for (const mode of ['light', 'dark']) for (const [fg, bg, min] of pairs) {
    const a = t[mode][fg], b = t[mode][bg];
    expect(a, `${mode} --${fg}`).toBeTruthy();
    expect(b, `${mode} --${bg}`).toBeTruthy();
    const r = ratio(a, b);
    if (r < min) fails.push(`${mode}: --${fg} on --${bg} is ${r.toFixed(2)}, needs ${min}`);
  }
  expect(fails).toEqual([]);
});

test('the page follows light and dark, with the brand colours on the main button', async ({ browser }) => {
  for (const [scheme, bg, brand] of [['light', 'rgb(244, 245, 246)', 'rgb(37, 40, 44)'], ['dark', 'rgb(14, 15, 17)', 'rgb(230, 231, 233)']]) {
    const a = await person(browser, { colorScheme: scheme });
    await a.page.goto('/current/');
    await expect(a.page.locator('#home')).toBeVisible();
    expect(await a.page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(bg);
    expect(await a.page.evaluate(() => getComputedStyle(document.getElementById('addBtn')).backgroundColor)).toBe(brand);
    expect(await a.page.evaluate(() => getComputedStyle(document.querySelector('h1 .mark')).width)).toBe('22px');
    expect(a.problems).toEqual([]);
    await a.context.close();
  }
});

test('every icon the app uses exists, and the favicon, app icons and manifest load', async ({ browser }) => {
  const a = await person(browser);
  await a.page.goto('/current/');
  const missing = await a.page.evaluate(() => [...document.querySelectorAll('use')]
    .map(u => u.getAttribute('href')).filter(h => !document.querySelector(h)));
  expect(missing).toEqual([]);
  // icons that app.js creates at run time
  const names = [...readFileSync('app.js', 'utf8').matchAll(/icon\('([a-z-]+)'/g)].map(m => m[1]);
  expect(names.length).toBeGreaterThan(2);
  const lost = await a.page.evaluate(n => n.filter(x => !document.getElementById('i-' + x)), [...names, 'up', 'down']);
  expect(lost).toEqual([]);

  for (const f of ['favicon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png']) {
    const r = await a.page.request.get('/current/' + f);
    expect(r.status(), f).toBe(200);
  }
  const m = await (await a.page.request.get('/current/manifest.webmanifest')).json();
  expect(m.theme_color).toBe('#F4F5F6');
  expect(m.icons.every(i => /maskable/.test(i.purpose || ''))).toBe(true);
  expect(await a.page.locator('meta[name="theme-color"]').evaluateAll(els => els.map(e => e.content))).toEqual(['#F4F5F6', '#0E0F11']);
  expect(await a.page.locator('link[rel="apple-touch-icon"]').getAttribute('href')).toContain('icon-180.png');
  await a.context.close();
});

test('the restyle adds no requests: only the page\'s own files, and no fonts', async ({ browser }) => {
  const a = await person(browser);
  await a.page.goto('/current/');
  await expect(a.page.locator('#home')).toBeVisible();
  await a.page.waitForLoadState('networkidle');
  const own = a.requests.filter(u => !u.startsWith('ws'));
  expect(own.every(u => new URL(u).origin === new URL(a.page.url()).origin)).toBe(true);
  expect(own.some(u => /\.(woff2?|ttf|otf)\b/.test(u))).toBe(false);
  await a.context.close();
});
