## Plugin submission

- Plugin ID: `io.github.lieng618.dbx-mini-games`
- Version: `0.3.1`
- Publisher ID: `lieng618`

## Source repository and tag

https://github.com/lieng618/dbx-mini-games/tree/v0.3.1

The unsigned universal candidate is built from this tag and published under
the repository's `v0.3.1` GitHub Release.

## Capabilities and user workflow

DBX Mini Games opens a game-lobby workbench. Users can create or join a public
or password-protected room, play Chinese chess or Gomoku against another
player, request an undo with opponent consent, rematch, and spectate an active
match.

## Permissions, data access, and network access

Manifest permission:

```text
host.network:https://1.92.64.227
```

The plugin communicates only with the publisher-operated game service on that
HTTPS origin. Browser clients use WebSocket; DBX uses HTTPS long polling.

The service receives a generated client ID, a random nickname, room actions,
and match actions. Room and match state is held in memory and is discarded on
service restart. The reverse proxy may keep rotating operational access logs
containing standard connection metadata. No account, chat, analytics,
advertising, telemetry, or persistent replay data is used.

Privacy policy:

https://github.com/lieng618/dbx-mini-games/blob/v0.3.1/PRIVACY.md

Screenshots:

https://github.com/lieng618/dbx-mini-games/tree/v0.3.1/screenshots

## Native sidecar behavior

None. This is a frontend-only universal plugin. The separate Go game server is
not included in or started by the plugin package.

## License

Apache-2.0

## Homepage or support URL

Homepage: https://github.com/lieng618/dbx-mini-games

Support: https://github.com/lieng618/dbx-mini-games/issues

## Confirmation

- [x] The candidate package is unsigned and matches the disclosed source tag.
- [x] No private keys, tokens, credentials, or proprietary data are included.
- [x] The candidate is listed under `candidates/`; `plugins/` and `catalog/`
      were not edited manually.
