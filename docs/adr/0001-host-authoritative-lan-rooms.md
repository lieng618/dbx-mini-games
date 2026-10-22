# 0001 — Host-authoritative LAN play with mDNS discovery

Status: superseded — the current plugin uses a hosted cloud service instead.

## Context

The plugin must let participants on the same local network play 象棋 and 五子棋 against
each other, with spectators, without any hosted service. The reference plugin in the
same store (`io.dbx.doudizhu`) already solves a comparable LAN problem with a Go sidecar.

Board games differ from card games in a way that matters here: they are strictly
turn-based, low-frequency state machines with small state (90 and 225 cells). There is
no real-time licence for peer consensus.

## Decision

The Host runs the authoritative listener in its own sidecar process. Every other
participant connects to the Host over TLS 1.3 and receives authoritative snapshots. The
Host is the referee: its board is the board. Discovery is mDNS (zeroconf), with manual
address entry as a fallback. The Host leaving ends the Room.

The transport and handshake follow the same shape as the reference plugin's: a
self-signed TLS certificate validated by pinned key, a `challenge` nonce, an Ed25519
signed `auth` message, then a `response` carrying the snapshot and a reconnect token.

## Consequences

- Cheating by editing the local board is meaningless: guests hold no authority.
- A Host crash or exit ends the Match; there is no host migration. Accepted because the
  intended use is a casual session among friends, where re-hosting is cheap.
- The sidecar needs its own listening socket. This is allowed: `host.network` only widens
  the UI's CSP `connect-src`; it is not a firewall over the native process.
- Reconnect after a transient drop works without re-hosting, because the token survives.

## Alternatives rejected

- **Peer-to-peer consensus.** Board state is small enough, but turn arbitration,
  reconnect, and spectator consistency under partition cost far more than they buy.
- **Host migration.** Multiplies state-transfer and re-negotiation work for a case
  (host leaves mid-match, everyone keeps playing) that is not worth the complexity here.
- **WebSocket / public relay.** The UI reaches the sidecar through the host bridge, not
  through the browser network, so a WebSocket adds a second protocol for nothing.
