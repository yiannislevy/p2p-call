// Pull-request guard: if the app itself changed, the version must go up and the
// changelog must describe it. Keeps every live release identifiable and revertible.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const base = process.argv[2] || 'origin/main';
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();

const APP_FILES = /^(?!playwright\.config\.js$)([\w-]+\.(html|js|css|webmanifest|png)|vendor\/)/;
const changed = git('diff', '--name-only', `${base}...HEAD`).split('\n').filter(Boolean);
const appChanged = changed.filter(f => APP_FILES.test(f));

const readVersion = text => (text.match(/const VERSION = '(\d+\.\d+\.\d+)'/) || [])[1] || '0.0.0';
const now = readVersion(readFileSync('app.js', 'utf8'));
let before = '0.0.0';
try { before = readVersion(git('show', `${base}:app.js`)); } catch {}

const cmp = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

if (!appChanged.length) {
  console.log('App files unchanged; no version bump needed.');
  process.exit(0);
}
console.log(`App files changed: ${appChanged.join(', ')}`);
if (cmp(now, before) <= 0) {
  console.error(`The app changed but VERSION is still ${now} (main has ${before}). Raise VERSION in app.js.`);
  process.exit(1);
}
if (!readFileSync('CHANGELOG.md', 'utf8').includes(`## v${now}`)) {
  console.error(`CHANGELOG.md has no "## v${now}" section.`);
  process.exit(1);
}
console.log(`Version ${before} -> ${now}, changelog entry present.`);
