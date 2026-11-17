# Call

Private video rooms for family and friends. Video and audio go directly between
phones, encrypted end to end. There is no server: GitHub only hands out these files.

## Put it online (once, about 5 minutes)

1. Create a free GitHub account if you don't have one.
2. New repository, name it e.g. `call`, Public, then "uploading an existing file":
   drag in everything from this folder (keep the `vendor` folder as it is).
3. Repository Settings → Pages → Source: "Deploy from a branch", branch `main`, folder `/ (root)`, Save.
4. After a minute the site is at `https://<your-username>.github.io/call/`.

## Use it

- Open the site, tap **Add a room**, name it (`family`), keep the generated password, Save.
- Tap the share icon next to the room and send the link to the people in that room.
- They open the link, type their name, tap **Join call**. The room is saved on their phone too.
- To call: open the app, tap the room. Whoever else opens it at the same time is in the call.

**On iPhone, make it an app:** open the site in Safari → Share → Add to Home Screen.
It then opens full screen with its own icon. Allow camera and microphone the first time.

## How safe is it

- The room name and password never leave the phone. The page turns them into a
  random-looking meeting point with a slow hash (PBKDF2), so the public relays that
  introduce phones to each other never learn the room name, and people without the
  password never find the room.
- The introduction itself is encrypted with the password (AES-256-GCM), so a relay
  cannot read it or slip in between you.
- Video and audio use WebRTC encryption (DTLS-SRTP). It cannot be turned off.
- No accounts, no analytics, nothing loaded from other websites. The connection
  library (Trystero 0.27.0, MIT) is copied into `vendor/` and pinned.
- A strict Content-Security-Policy blocks injected scripts, and the page refuses to
  run inside other websites' frames. Names and room names are only ever shown as text.
- Rooms and your name are stored only on your device. "Forget all rooms on this
  device" removes them.

Things to know:

- The invite link contains the password. Anyone who has it can join that room. If a
  link leaks, make a new room and send the new link.
- People in a call can see each other's IP address, as with any direct connection.
- Use the generated passwords. A short one like `123` could collide with a stranger's room.

## Limits

- Up to 6 people per room. Each phone sends its video to every other phone, so 2–4 is the sweet spot.
- On some strict networks (some mobile carriers, office or hotel wifi) two phones cannot
  reach each other directly. The app says so; switching one side to other wifi or mobile
  data usually fixes it.
- Calls only ring if the other person has the app open. There are no notifications.

## Changing relays

The six public relays are listed at the top of `app.js` (`RELAYS`) and must also be
listed in `connect-src` in `index.html`. Only a few kilobytes pass through them when someone joins.
If several stop working, swap in others from the same Nostr relay family and update both places.
