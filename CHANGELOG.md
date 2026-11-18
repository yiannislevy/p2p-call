# Changelog

Every release is tagged and can be put live again from the Actions tab
("Deploy a version (rollback)").

## v1.7.0

Floating video, for doing other things during a call (iPhone first):

- A Float button in the call puts the video in a small window that stays over other apps,
  like FaceTime. It shows whoever is talking and switches calmly between talkers; someone
  with their camera off is shown as a card with their initial. P on a keyboard.
- While you are in another app you stay heard and keep hearing everyone (checked on an
  iPhone with iOS 26). The phone pauses your own camera; the others see "In another app".

## v1.6.3

Two causes of black video and missing sound, found in the code and fixed at the source:

- The connection library could skip the update that offers your camera and microphone to
  someone, when it came in while the previous update was still finishing. Your own app now
  checks that everything it sends was really offered, and offers it again if not.
- Video could arrive and be decoded while the screen stayed black (Safari can do this when
  a camera is added to a stream it is already showing). The app now counts the frames each
  tile actually shows, and points the tile at the video again when they stop.

## v1.6.2

Fixes for black video and missing sound:

- If video or sound from someone never arrives, or stops, while the connection is up, the
  app asks their app to send it again (spaced out, at most three times).
- A camera or microphone that stops on its own (an iPhone interruption, another app taking
  the camera) is replaced with a fresh one automatically; the others keep seeing you.
- Someone in another app whose phone paused their camera is shown as "In another app"
  instead of a frozen or black picture, and comes back on their own.
- A video the browser paused is restarted, or "Tap to turn on sound" is offered.

Also: tests run four times faster in CI (parallel jobs, short timers in test builds).

## v1.6.1

Fixes:

- Refreshing the page no longer loses the room. Before joining, you stay on that room's
  screen (invites included). In a call, the app rejoins on its own with your mute and camera
  state, and the others see "Reconnecting…" for a moment instead of you leaving and joining.
  The room is remembered in that browser tab only, and forgotten when the tab closes.
- Closing the tab mid-call: the others now drop you within about 20 seconds (it can't be told
  apart from a refresh, so they wait briefly first).
- Someone in the room for a while could miss people who joined later. The app now notices
  people whose phones say they are in the room but who are not connected, rejoins to pick
  them up (at most twice), and otherwise says once who can't connect and why. Connection
  details list them.

## v1.6.0

- Tap your own small video to swap it with the big one (in a group, you take the big spot);
  tap again to swap back. Someone joining or leaving returns to the normal view.
- Keyboard on computers: M mute, V camera, S swap, I invite (copies the link), D connection
  details, Esc closes. Ignored while typing and with Ctrl/Cmd. Buttons show their key on hover.
- Fixed: leaving a call and joining the same room again straight away could fail with
  "Could not join" (since v1.3.0). Joining now waits for the previous call to finish leaving.

## v1.5.0

- See who is talking: the tile of whoever is speaking gets a thin blue outline, and your own
  small video does when you speak. Muted people are never outlined.
- Uses the voice level the browser already measures, averaged between checks so short
  words count; nothing extra is sent.

## v1.4.0

- Sharper video: the camera now captures in Full HD (1080p). Ceilings per person you send to:
  2 people 4 Mbps at 1080p, 3 people 2.5 Mbps at 720p, 4 people 1.6 Mbps at 720p,
  5-6 people 1 Mbps at 540p. Total upload stays around 4-5 Mbps. These are ceilings; on a
  weak connection the browser lowers them by itself.
- Clearer voice: 64 kbps for audio, about twice the usual default (measured 25 -> 50 kbps).
- Connection details now show the video actually arriving from each person, e.g. "1080p, 30 fps".

## v1.3.0

- Auto-reconnect. Switching from wifi to mobile data, a tunnel or a weak signal no longer
  ends the call: the app repairs broken links on its own and, if every link stays dead,
  quietly rejoins the room. Your screen shows "Reconnecting…", then "Reconnected".
- The others keep your tile with "Reconnecting…" instead of seeing you leave and join again.
  If your phone is gone for good, you are removed once it stops saying "here" in the room.
- If a link between two people cannot come back while both are still in the room, one of
  them quietly re-establishes it, so nobody ends up unable to see someone.
- Leaving with the button is still shown to everyone straight away.

## v1.2.0

- See who is in a call before joining: rooms with people in them show their initials,
  a blue dot and "Peer B and Peer A are in the call", live, on the rooms screen and on the
  screen before joining.
- Works without any server or direct connection: people in a call post small notes through
  the same relays, encrypted with the room password, so relays cannot read who is in.
- Someone whose phone loses signal disappears from the list on their own within about a minute.

## v1.1.0

- Invite now copies the link at once. A small panel shows the link, with a separate
  "Share via…" button for sending it through apps.
- Network check: before joining, the app warns if the network blocks direct calls.
  If someone cannot connect, the message says which side is blocked and what to do.
- Connection details: tap the people count during a call to see each person's
  connection (same network or over the internet) and your network type.
- Version number shown at the bottom of the rooms screen.
- Every file is tied to its release, so a phone never mixes old and new files.
- Kept out of search engines.
- Automated tests, versioned releases, test-gated deploys and one-click rollback.

## v1.0.0

- First release: password-protected rooms, invite links, peer-to-peer encrypted video
  for up to 6 people, mute, camera, flip, home-screen app on iPhone.
