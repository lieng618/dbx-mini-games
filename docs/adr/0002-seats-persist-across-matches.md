# 0002 — Seats rotate on vacancy, not on match end

Status: accepted

## Context

A Room holds two Seats and up to six Spectators. Arriving participants take a free Seat
and otherwise spectate, so the leaderboard of who plays is arrival order. The open
question was what happens when a Match finishes.

Two behaviours were considered: reshuffle the table automatically after every Match, or
keep Seats until an Occupant leaves on purpose.

## Decision

Seats persist across Matches. A Seat becomes empty only when its Occupant leaves the
Seat deliberately or disconnects. Rotation is triggered by vacancy, never by a Match
ending.

## Consequences

- A pair that wants a rematch simply starts the next Match; no re-seating ritual.
- A Spectator may wait through several Matches if the Occupants never leave. This is
  accepted: the product is a table, not a fairness queue. Any Occupant can yield the
  Seat at any time, and a disconnected Occupant forfeits and therefore vacates.
- Seating state must survive a Match boundary and be part of the snapshot, because the
  UI needs to show who is seated while a Match is not running.

## Alternatives rejected

- **Automatic rotation after each Match.** Fairer to a crowd, but it ends a session that
  two people are enjoying and forces a re-seat handshake at every rematch.
- **Winner stays, loser yields.** Strong table-politics flavour, but it lets one strong
  player hold a Seat indefinitely and starves the queue.
