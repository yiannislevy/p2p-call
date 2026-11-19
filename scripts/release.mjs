// After a successful deploy from main: if this version has no release yet,
// tag the deployed commit and publish a GitHub Release with its changelog section.
// Needs GH_TOKEN and GITHUB_SHA (both set inside GitHub Actions).

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const version = (readFileSync('app.js', 'utf8').match(/const VERSION = '(\d+\.\d+\.\d+)'/) || [])[1];
if (!version) throw new Error('No VERSION in app.js');
const tag = `v${version}`;

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();

// Keep every release tag on the commit that shipped it on main ("vX.Y.Z: ..." in the subject;
// v1.0.0 is the first commit). Repairs tags if main's history is ever rewritten.
const shipped = new Map([['v1.0.0', git('rev-list', '--max-parents=0', 'HEAD').split('\n')[0]]]);
for (const line of git('log', '--format=%H %s', 'HEAD').split('\n')) {
  const m = line.match(/^([0-9a-f]{40}) (v\d+\.\d+\.\d+):/);
  if (m && !shipped.has(m[2])) shipped.set(m[2], m[1]);
}
for (const [name, sha] of shipped) {
  let now = '';
  try { now = git('rev-list', '-n', '1', name); } catch {}
  if (!now || now === sha) continue;
  git('tag', '-f', name, sha);
  execFileSync('git', ['push', '--force', 'origin', `refs/tags/${name}`], { stdio: 'inherit' });
  console.log(`Moved ${name} to ${sha.slice(0, 7)}`);
}

// One-time backfill: v1.0.0 is the first upload, which was never tagged.
if (!git('tag', '--list', 'v1.0.0')) {
  const first = git('rev-list', '--max-parents=0', 'HEAD').split('\n')[0];
  execFileSync('gh', ['release', 'create', 'v1.0.0', '--title', 'v1.0.0', '--notes', 'First release.', '--target', first], { stdio: 'inherit' });
}

const log = readFileSync('CHANGELOG.md', 'utf8');
const notesFor = name => {
  const start = log.indexOf(`## ${name}\n`);
  if (start < 0) return '';
  const rest = log.slice(start).split('\n').slice(1);
  const end = rest.findIndex(l => l.startsWith('## '));
  return rest.slice(0, end < 0 ? undefined : end).join('\n').trim();
};

// Keep the notes of earlier releases the same as their changelog sections (the changelog is
// the source; if it is ever edited, the releases follow).
for (const name of git('tag', '--list', 'v*').split('\n').filter(Boolean)) {
  const want = notesFor(name);
  if (!want) continue;
  let have = '';
  try { have = execFileSync('gh', ['release', 'view', name, '--json', 'body', '--jq', '.body'], { encoding: 'utf8' }).trim(); } catch { continue; }
  if (have === want) continue;
  writeFileSync('release-notes.md', want + '\n');
  execFileSync('gh', ['release', 'edit', name, '--notes-file', 'release-notes.md'], { stdio: 'inherit' });
  console.log(`Updated the notes of ${name}`);
}

const tags = git('tag', '--list', tag);
if (tags) {
  console.log(`${tag} already released; nothing to do.`);
  process.exit(0);
}

const notes = notesFor(tag) || 'See CHANGELOG.md.';
writeFileSync('release-notes.md', notes + '\n');

execFileSync('gh', ['release', 'create', tag, '--title', tag, '--notes-file', 'release-notes.md', '--target', process.env.GITHUB_SHA], { stdio: 'inherit' });
console.log(`Released ${tag}`);
