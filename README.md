# Call

Private video calls for family and friends, straight from browser to browser.
No accounts, no app store, no server in between. Video and audio are encrypted end to end.

**Live:** https://yiannislevy.github.io/p2p-call/

This is a personal project, built for one family and a few friends. It is public so the
code can be read and checked, not for reuse (see [License](#license)).

## Try it

You need two devices, or a friend.

1. Open the site, tap **Add a room**, give it any name, keep the generated password, **Save room**.
2. Tap the share icon next to the room. The invite link is copied; send it to the other device.
3. Both sides open the room, type a name and tap **Join call**.

Rooms are private: without the exact name and password nobody can find or join them,
so trying it out never puts you in someone else's call.

On iPhone, open it in Safari, then Share, then **Add to Home Screen** to use it like an app.

## How it works

```
   your phone                                        their phone
  ┌──────────┐   1. "anyone in room a91f3c…?"   ┌──────────┐
  │          │ ──────► public relays ◄───────── │          │
  │   Call   │       (encrypted handshake)      │   Call   │
  │          │                                  │          │
  │          │ ◄══════════════════════════════► │          │
  └──────────┘   2. video + audio, direct,      └──────────┘
                    encrypted end to end
```

1. **Finding each other.** The room name and password are turned into a random-looking
   meeting point on the device (PBKDF2-SHA256, 300,000 rounds). Both phones announce
   themselves there through a few public Nostr relays. The handshake they exchange is
   encrypted with the room password (AES-256-GCM), so the relays see only noise.
2. **Talking.** The browsers then connect directly with WebRTC. Video and audio flow
   between the devices only, encrypted with DTLS-SRTP, which browsers do not allow
   to be switched off. Nothing passes through, or is stored on, any server.

3. **Who is in.** While someone is in a call, their phone posts a small "here" note every
   25 seconds (and "bye" when leaving) through the same relays, on a second channel derived
   from the room password and encrypted with it. The rooms screen asks "anyone here?" and
   shows the answers as initials with a blue dot. Relays see only scrambled notes; only
   people with the room's link can read who is in.

The site itself is a handful of static files on GitHub Pages. GitHub only hands out the
page; it never sees a call.

## Privacy and security

- The room name and password never leave the device in readable form.
- Invite links carry the password after the `#`, a part of the address that browsers never
  send to any server. The app removes it from the address bar as soon as it is read.
- No accounts, no tracking, no analytics, nothing loaded from other websites. The one
  library ([Trystero](https://github.com/dmotz/trystero) 0.27.0, MIT) is copied into
  `vendor/` and pinned.
- A strict Content Security Policy blocks injected scripts, and the page refuses to run
  inside other websites' frames.
- Names and room names are always shown as plain text.
- "Who is in" notes are encrypted with the room password and signed with a throwaway key
  per session, so they cannot be read or linked to a person by the relays.
- Rooms and your name are stored only on your device; "Forget all rooms" removes them.
- Kept out of search engines.

What to know:

- **The invite link is the key.** Anyone holding it can join that room. If it leaks,
  make a new room and send the new link.
- **People in a call can see each other's IP address**, as with any direct connection.

## Limits

- Up to 6 people per call; 2 to 4 is the sweet spot, since each phone sends its video to every other phone.
- Quality: 1080p at up to 4 Mbps in a 1-on-1, 720p in groups of 3-4, 540p for 5-6, and 64 kbps
  voice. The browser lowers this on its own when a connection is weak. Tap the people count in a
  call to see what is actually arriving.
- A direct connection is needed. It works on almost all home networks and most mobile
  data, but some office, hotel or public wifi blocks it. The app tells you when your
  network blocks calls and which side to switch to mobile data or another wifi.
- There is no ringing or notifications: people join when they open the room. The rooms
  screen shows who is already in.
- Dropped connections (switching wifi to mobile data, a tunnel) reconnect on their own; the
  others see "Reconnecting…" rather than you leaving.

## Development

Everything runs as static files; there is no build framework.

| File | What it is |
| --- | --- |
| `index.html`, `style.css`, `app.js` | The app |
| `presence.js` | Who is in each room, over encrypted relay notes |
| `vendor/` | Pinned copies of Trystero (connections) and its signing library |
| `scripts/build.mjs` | Builds the deployable site, ties every file to its version |
| `tests/` | Browser tests with fake cameras and a local relay |
| `.github/workflows/` | Test, deploy and rollback |

```sh
npm ci
npx playwright install chromium
npm test          # builds, starts a local relay, runs every test
```

**Tests** cover a three-person call (video, names, mute and camera state, leaving and
the back gesture), invite links, a wrong password never meeting the room, names and room
names never running as code, reconnecting after a dropped connection (two and three people,
without duplicate tiles or false "left" messages, and removing someone who never comes back),
swapping views and keyboard shortcuts (and that they stay out of the way while typing),
leaving and rejoining straight away, who is talking (and never a muted person), quality settings per group size (and kept after flipping the camera), who-is-in showing and clearing live (and staying unreadable
to the relays and invisible to other passwords), the app only talking to its own site and the relays,
refusing to run inside a frame, and the new version still calling the previous release.

**Releases.** Every change to the app raises `VERSION` in `app.js` and adds a section to
`CHANGELOG.md` (a pull request without both fails). Pull requests run all tests; merging
to `main` runs them again, publishes the site only if they pass, and tags the release.
The version is shown at the bottom of the rooms screen.

**Rollback.** Actions tab, then **Deploy a version (rollback)**, then **Run workflow**,
then type a release such as `v1.0.0`. It is live again within a minute; the next merge
to `main` deploys `main` again.

## License

Copyright (c) 2026 yiannislevy. All rights reserved. The source is visible for reading
only; no permission is granted to use, copy, modify or redistribute it. See [LICENSE](LICENSE).
Third-party code in `vendor/` keeps its MIT license.
