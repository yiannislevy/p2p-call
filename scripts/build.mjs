// Builds the deployable site into a folder.
//
//   node scripts/build.mjs --out _site                 the current files, for production
//   node scripts/build.mjs --ref v1.0.0 --out _site    an earlier release (used for rollback)
//   node scripts/build.mjs --out dir --relay ws://...  a test build that talks to a local relay
//
// Every file reference gets ?v=<version> so a phone never mixes files from two releases.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
);
const out = args.out || '_site';
const ref = args.ref || '';
const relay = args.relay || '';

// Everything the site needs: top-level page files plus vendor/. Tooling is left out.
const isSiteFile = f => /\.(html|js|css|webmanifest|png)$/.test(f) && !/^(playwright\.config)\.js$/.test(f);

let src = '.';
let tmp = '';
if (ref) {
  if (!/^v\d+\.\d+\.\d+$/.test(ref)) throw new Error(`Not a release tag: ${ref}`);
  tmp = mkdtempSync(join(tmpdir(), 'call-build-'));
  const tar = execFileSync('git', ['archive', '--format=tar', ref]);
  execFileSync('tar', ['-x', '-C', tmp], { input: tar });
  src = tmp;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const files = [...readdirSync(src).filter(isSiteFile), 'vendor'];
for (const f of ['index.html', 'app.js', 'style.css', 'vendor']) if (!files.includes(f) || !existsSync(join(src, f))) throw new Error(`Missing ${f}`);
for (const f of files) cpSync(join(src, f), join(out, f), { recursive: true });

let app = readFileSync(join(out, 'app.js'), 'utf8');
let html = readFileSync(join(out, 'index.html'), 'utf8');
const version = (app.match(/const VERSION = '([^']+)'/) || [])[1] || (ref ? ref.slice(1) : '0.0.0');

// Cache busting: tie every file to this release.
html = html
  .replace('href="style.css"', `href="style.css?v=${version}"`)
  .replace('src="app.js"', `src="app.js?v=${version}"`)
  .replace('href="manifest.webmanifest"', `href="manifest.webmanifest?v=${version}"`);
if (!html.includes(`app.js?v=${version}`)) throw new Error('Could not version app.js in index.html');

// Our own modules imported by app.js are versioned the same way.
const modules = files.filter(f => f.endsWith('.js') && f !== 'app.js');
app = app.replace(/from '\.\/([\w-]+\.js)'/g, (m, f) => (modules.includes(f) ? `from './${f}?v=${version}'` : m));

if (relay) {
  if (!/^wss?:\/\/[\w.:-]+$/.test(relay)) throw new Error(`Bad relay URL: ${relay}`);
  app = app.replace(/const RELAYS = \[[^\]]*\];/s, `const RELAYS = [${JSON.stringify(relay)}];`);
  html = html.replace(/connect-src [^;]*;/, `connect-src ${relay};`);
  if (!app.includes(JSON.stringify(relay)) || !html.includes(`connect-src ${relay};`)) throw new Error('Could not point the build at the test relay');
}

writeFileSync(join(out, 'app.js'), app);
writeFileSync(join(out, 'index.html'), html);
if (tmp) rmSync(tmp, { recursive: true, force: true });
console.log(`Built version ${version}${ref ? ` from ${ref}` : ''} into ${out}${relay ? ` (test relay ${relay})` : ''}`);
