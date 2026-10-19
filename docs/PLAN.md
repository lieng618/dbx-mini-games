# Delivery plan — `io.github.jzj2621899857.board-games`

Complete delivery, staged so that each milestone is independently verifiable. "Complete"
means both games, spectators, seating, effects, packaging, signing, and catalog — not a
demo.

## M0 — Repository scaffolding and host integration spike

Highest-risk link first: prove a packaged plugin actually installs and its sidecar
handshake works inside DBX.

- Two repositories initialized, LICENSE, README, `.gitignore`, issue templates.
- `manifest.json`, `dbx-plugin.toml`, `package.json`, `vite.config.ts`, `tsconfig.json`.
- Go backend skeleton against the official `dbx-plugin-sdk` (vendored via `third_party`,
  same as the reference plugin), `main.go` RPC glue, `DBX_PLUGIN_DATA_DIR` handling.
- One trivial workbench RPC round-trip proven on darwin-arm64.
- Exit criteria: `dbx-plugin package` produces a `.dbxp` that DBX installs and runs.

## M1 — LAN room core

Transport, discovery, membership, seating, spectating.

- TLS 1.3 self-signed listener on an ephemeral port; pinned-key client validation.
- `challenge` → `auth` (Ed25519 over nonce+roomID, optional password) → `response`
  (snapshot + reconnect token).
- mDNS registration/resolution (`_dbxbg._tcp`) plus manual address entry.
- Room membership: two Seats, up to eight participants, arrival-order seating,
  vacancy-only rotation, spectator snapshots.
- Reconnect within a window using the stored token; disconnect past the window forfeits.
- Exit criteria: three DBX instances on one LAN see the room, two sit, one spectates,
  and a disconnect-reconnect resumes without re-hosting.

## M2 — Rule engines

Pure, transport-free, independently testable.

- 象棋: move generation, legal-move filtering, generals-facing rule, check/checkmate,
  stalemate as loss, sixty-move no-capture draw, repetition guard.
- 五子棋: free-style placement, five-or-more detection, board-full draw.
- Shared interface: apply(move) → result, legal moves, terminal outcome, board hash.
- Perft-style move-generation tests for 象棋; win-detection property tests for 五子棋.
- Exit criteria: engines pass their suites with no dependency on room or network code.

## M3 — Presentation

PixiJS 8 canvas plus Vue HUD.

- Canvas contract fixed before visual work (responsive, logical 1600×900) so the effects
  layer never fights the layout later.
- Board scene interface: `update(snapshot, selection, lowMotion)`, `effect(...)`,
  `destroy()`, `stats()`.
- Effects: placement ripple, capture ink-dust burst, check red pulse + camera shake +
  calligraphic burst, last-move gold pulse and ink trail, win line growth + seal stamp,
  undo ink rewind.
- Every effect has a low-motion form; low-motion is a persisted participant setting.
- Spectator view hides interactive affordances but keeps all effects.
- Exit criteria: effects fire off snapshot deltas, not from local optimistic guesses.

## M4 — Match lifecycle

- Ready/start, turn enforcement, undo request + consent, resign, clock (fixed budget, no
  increments), rematch, leave-seat.
- Exit criteria: a full Match completes on both games; undo needs both Occupants; clock
  timeout forfeits.

## M5 — Release engineering

- GitHub Actions: multi-target unsigned candidate build (`darwin-arm64`, `darwin-x64`,
  `windows-x64`; linux added when a runner is wired).
- Catalog document with the plugin entry, checksums, sizes, and key ID; key generation and
  out-of-band public-key publication.
- Signing performed only in the distribution repository's protected environment.
- Exit criteria: a participant adds the catalog URL, installs the signed plugin, and DBX
  verifies manifest identity, checksum, and signature.

## Deferred, explicitly

- AI opponents (象棋 AI is a separate engineering effort; 五子棋 AI possible but out of
  scope for this delivery).
- Host migration, peer-to-peer modes, public relay.
- Linux targets, package signing automation beyond the manual protected workflow.
- 五子棋 forbidden moves (禁手), 象棋 long-chase (长捉) refinement.
- Spectator chat, emotes, profiles, cosmetics.

## Verification strategy

- Go unit tests for engines and room state machine.
- Integration test that drives two sidecars headlessly over loopback and asserts snapshot
  convergence, seat assignment, and reconnect.
- Playwright acceptance against the built UI with a mocked bridge, plus one manual
  two-machine LAN pass recorded in `docs/VALIDATION.md`.
