// After a successful deploy from main: if this version has no release yet,
// tag the deployed commit and publish a GitHub Release with its changelog section.
// Needs GH_TOKEN and GITHUB_SHA (both set inside GitHub Actions).

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const version = (readFileSync('app.js', 'utf8').match(/const VERSION = '(\d+\.\d+\.\d+)'/) || [])[1];
if (!version) throw new Error('No VERSION in app.js');
const tag = `v${version}`;

// One-time backfill: v1.0.0 is the first upload, which was never tagged.
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
if (!git('tag', '--list', 'v1.0.0')) {
  const first = git('rev-list', '--max-parents=0', 'HEAD').split('\n')[0];
  execFileSync('gh', ['release', 'create', 'v1.0.0', '--title', 'v1.0.0', '--notes', 'First release.', '--target', first], { stdio: 'inherit' });
}

const tags = git('tag', '--list', tag);
if (tags) {
  console.log(`${tag} already released; nothing to do.`);
  process.exit(0);
}

const log = readFileSync('CHANGELOG.md', 'utf8');
const start = log.indexOf(`## ${tag}`);
let notes = 'See CHANGELOG.md.';
if (start >= 0) {
  const rest = log.slice(start).split('\n').slice(1);
  const end = rest.findIndex(l => l.startsWith('## '));
  notes = rest.slice(0, end < 0 ? undefined : end).join('\n').trim() || notes;
}
writeFileSync('release-notes.md', notes + '\n');

execFileSync('gh', ['release', 'create', tag, '--title', tag, '--notes-file', 'release-notes.md', '--target', process.env.GITHUB_SHA], { stdio: 'inherit' });
console.log(`Released ${tag}`);
