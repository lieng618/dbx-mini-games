# DBX Mini Games 0.4.3

## Highlights

- a rebuilt room interface: lobby room cards, a dedicated create-room panel, a
  settings drawer, and a result summary card, each split out of the workbench;
- Gomoku victory stroke drawn as an ink dragon, with a calm variant that keeps
  the spine and drops the motion;
- one dynamic-effects toggle replacing the earlier three-tier setting; existing
  choices migrate, and with no stored choice the system motion preference decides;
- the final Xiangqi move now stays on screen for a full second, so the winning
  move is readable no matter how decorative effects are configured;
- connection status distinguishes connecting, online, reconnecting, and offline,
  and a reconnect that heals within a second no longer shows an error banner;
- player-facing error wording moved into a unit-tested table, so a wrong phrase
  is a test failure rather than a style choice;
- Chinese chess and free-style Gomoku;
- public and password-protected rooms;
- spectator support and server-authoritative matches;
- configurable match and per-move clocks;
- consent-based undo requests;
- rematch and departure feedback;
- responsive lobby, mobile board, and wide-screen layouts;
- last-move replay control and animated active-turn indicators;
- corrected Gomoku landing effects for both seats;
- cinematic Xiangqi cannon blasts, river surges, piece-specific capture
  accents, glyph shattering, escalating checks, victory fractures, and undo
  rewind effects;
- room scoring and confirmed seat swaps;
- Xiangqi key-piece shatter effects and enhanced Gomoku cinematic effects;
- in-match emote reactions with visual and sound feedback;
- match-start announcements and consistent player strips across desktop and
  mobile layouts;
- traditional Chinese-ink board effects and sound;
- DBX sandbox connectivity over HTTPS long polling;
- browser connectivity over WebSocket;
- production bundles contain only the configured public endpoint, with no
  local development loopback fallback;
- nickname and password controls work correctly inside the DBX sandbox.

## Network and data

The frontend-only plugin connects to the publisher-operated service at:

```text
https://1.92.64.227
```

Rooms and matches are held in memory and are not persisted. See `PRIVACY.md`
for the complete privacy disclosure.
