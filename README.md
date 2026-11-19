# Call

Private video calls that go straight from one browser to another. No accounts, no app to
install, no server in the middle. Video and sound are encrypted end to end.

## How it works

```
   phone A                                            phone B
  ┌──────────┐   1. "anyone in room a91f3c…?"   ┌──────────┐
  │          │ ──────► public relays ◄───────── │          │
  │   Call   │       (encrypted handshake)      │   Call   │
  │          │                                  │          │
  │          │ ◄══════════════════════════════► │          │
  └──────────┘   2. video + sound, direct,      └──────────┘
                    encrypted end to end
```

- **A room is a name and a password.** Both are turned on the device into a meeting point
  that looks random (PBKDF2-SHA256, 300,000 rounds). Nobody can find a room, or tell that
  it exists, without both.
- **Finding each other.** Phones announce themselves at that meeting point through a few
  public Nostr relays. What they exchange is encrypted with the room password
  (AES-256-GCM), so the relays carry only noise.
- **Talking.** The browsers then connect directly over WebRTC. Video and sound travel
  between the devices only, encrypted with DTLS-SRTP, and are never stored anywhere.
- **Who is in.** While someone is in a call, their phone posts a small encrypted "here"
  note to the same relays, signed with a throwaway key. The rooms screen shows who is in
  a call before you join, readable only with the room's password.
- **Staying up.** Connections that drop (wifi to mobile data, a tunnel) reconnect on their
  own. Video or sound that stops arriving is sent again, and a camera that stops is
  replaced. If two people in a group can't reach each other, someone connected to both
  passes their video along. That is still a person in the call, not a server.
- **Sound and picture.** Up to 1080p in a 1-on-1, shared fairly in groups, and voice
  with redundancy so a lost packet doesn't cut a word.
- **The site** is a few static files with no build framework, covered by browser tests
  that run before anything goes live.

## Limits

- Up to 6 people per call. Every phone sends its video to every other phone, so 2 to 4
  works best.
- A direct connection is needed. It works on most home networks and most mobile data,
  but some office, hotel and public wifi block it, as do some pairs of mobile networks.
  The app says when that happens. In a group, the people who can't reach each other are
  passed along by someone who can reach both.
- People in a call can see each other's IP address, as with any direct connection.
- There is no ringing: people join when they open the room.
- iPhones pause the camera while you are in another app. You stay heard, and the video
  can float in a small window.

## License

All rights reserved. The code is here to be read, not reused: no permission is given to
copy, modify or redistribute it. See [LICENSE](LICENSE). Third-party code in `vendor/`
keeps its own MIT license.
