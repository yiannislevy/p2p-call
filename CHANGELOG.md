# Changelog

Every release is tagged and can be put live again from the Actions tab
("Deploy a version (rollback)").

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
  a blue dot and "Sarra and Mama are in the call", live, on the rooms screen and on the
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
