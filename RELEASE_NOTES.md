# DBX Mini Games 0.4.2

## Highlights

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
