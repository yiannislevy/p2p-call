// Test environment: builds the current version (and the previous release, if any)
// pointed at a local relay, serves them on http://localhost:8800 and runs that relay
// on ws://localhost:7777. Nothing here reaches the internet.

import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, normalize, extname, resolve } from 'node:path';
import { WebSocketServer } from 'ws';

const ROOT = resolve('tests/.sites');
const RELAY = 'ws://localhost:7777';
mkdirSync(ROOT, { recursive: true });

const build = (...a) => execFileSync('node', ['scripts/build.mjs', ...a, '--relay', RELAY], { stdio: 'inherit' });
build('--out', join(ROOT, 'current'));

// Previous release, to prove the new version can still call people who haven't updated.
const current = (readFileSync('app.js', 'utf8').match(/const VERSION = '([^']+)'/) || [])[1];
const tags = execFileSync('git', ['tag', '--list', 'v*', '--sort=-v:refname'], { encoding: 'utf8' })
  .split('\n').filter(t => /^v\d+\.\d+\.\d+$/.test(t) && t !== `v${current}`);
const previous = tags[0] || null;
if (previous) build('--ref', previous, '--out', join(ROOT, 'previous'));
writeFileSync(join(ROOT, 'meta.json'), JSON.stringify({ current, previous }));

// A page that tries to embed the app, to check it refuses to run in a frame.
writeFileSync(join(ROOT, 'frame.html'), '<!doctype html><title>frame</title><iframe id="f" src="/current/" width="400" height="600"></iframe>');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };
createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
}).listen(8800, () => console.log('serving tests/.sites on http://localhost:8800'));

// Minimal Nostr relay: forwards each event to live subscriptions whose filters match.
const wss = new WebSocketServer({ port: 7777 });
const subs = new Map();
const matches = (f, ev) =>
  (!f.kinds || f.kinds.includes(ev.kind)) &&
  (!f.since || ev.created_at >= f.since) &&
  Object.keys(f).filter(k => k.startsWith('#')).every(k => ev.tags.some(t => t[0] === k.slice(1) && f[k].includes(t[1])));
wss.on('connection', ws => {
  subs.set(ws, new Map());
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m[0] === 'REQ') { subs.get(ws).set(m[1], m.slice(2)); ws.send(JSON.stringify(['EOSE', m[1]])); }
    else if (m[0] === 'CLOSE') subs.get(ws).delete(m[1]);
    else if (m[0] === 'EVENT') {
      const ev = m[1];
      ws.send(JSON.stringify(['OK', ev.id, true, '']));
      for (const [client, s] of subs) for (const [id, filters] of s) if (filters.some(f => matches(f, ev))) client.send(JSON.stringify(['EVENT', id, ev]));
    }
  });
  ws.on('close', () => subs.delete(ws));
});
console.log(`test relay on ${RELAY}`);
