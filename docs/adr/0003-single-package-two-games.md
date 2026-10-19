# 0003 — One plugin package, two games

Status: accepted

## Context

象棋 and 五子棋 share almost everything that is expensive: LAN discovery, the TLS
handshake, room membership, seating, spectating, snapshot broadcast, reconnect, the
canvas pipeline, and the Chinese-ink visual language. They differ in the rule engine and
board geometry.

DBX installs one package per plugin, and a package has one manifest identity and one
workbench entry. Splitting them produces two independent plugins.

## Decision

Ship both games in a single package, `io.github.jzj2621899857.board-games`, with the games as
internal modules behind one workbench. The Room's `game` field selects which module
arbitrates.

## Consequences

- The LAN and presentation infrastructure is written once.
- The plugin appears in the Plugin Center as one entry; choosing 象棋 or 五子棋 happens
  inside the workbench, per Room. A Room is tied to one game.
- Adding a third game later means adding a module, not a package.
- The two games cannot be versioned or installed independently. Accepted: they are
  developed together and neither has a release cadence of its own.

## Alternatives rejected

- **Two packages.** Independent versioning, but two copies of the discovery/handshake/
  membership layer, and rooms of one game would be invisible to the other plugin.
- **Two workbenches in one package.** Would let each game keep its own entry point, but
  duplicates the lobby, which is where most of the UI complexity sits.
