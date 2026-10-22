# DBX Mini Games 0.3.0

Initial public release of the anonymous online board-game lobby.

## Highlights

- Chinese chess and free-style Gomoku;
- public and password-protected rooms;
- spectator support and server-authoritative matches;
- configurable match and per-move clocks;
- consent-based undo requests;
- rematch and departure feedback;
- traditional Chinese-ink board effects and sound;
- DBX sandbox connectivity over HTTPS long polling;
- browser connectivity over WebSocket.

## Network and data

The frontend-only plugin connects to the publisher-operated service at:

```text
https://1.92.64.227
```

Rooms and matches are held in memory and are not persisted. See `PRIVACY.md`
for the complete privacy disclosure.
