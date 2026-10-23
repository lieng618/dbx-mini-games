# CONTEXT — DBX Mini Games plugin

Glossary for the DBX board-games plugin. Terms only; no implementation detail.

## Games

**Game** — one playable rule set. This plugin ships exactly two: 象棋 and 五子棋.
A Game owns its rules, its board geometry, and its win condition. A Game never
owns transport, seating, or rendering.

**象棋 / Xiangqi** — Chinese chess on a 9×10 point grid. The Game in play when the
room's `game` field is `xiangqi`.

**五子棋 / Gomoku** — five-in-a-row on a 15×15 point grid, free-style rules.
The Game in play when the room's `game` field is `gomoku`.

**Free-style rules** — 五子棋 without forbidden-move (禁手) restrictions. Five or
more in a row wins. There is deliberately no 三三 / 四四 / 长连 referee.

## Room and seating

**Room** — one in-memory match table on the cloud game service. A Room has one Host, up to
two Seats, and zero or more Spectators. A Room is tied to one Game: 象棋 and 五子棋
never share a Room.

**Room score** — an optional pair of win totals scoped to one Room. It is enabled when
the Room is created, follows Rematches, and resets when either Seat changes hands. It is
not a persistent player record.

**Seat swap** — a Room action shared by both Occupants while the Room is in its lobby.
It exchanges the two Seats and the players' running score totals; it is unavailable once
the Match starts.

**Host** — the participant who created the Room. The Host controls room actions such as
starting the Match, but the cloud service is the referee. Host status transfers to a
remaining seated player when the creator leaves.

**Seat** — an authoritative playing position. A Room has exactly two Seats
(`seat 0` and `seat 1`), independent of Game. A Seat is either occupied or empty.

**Occupant** — the participant currently holding a Seat.

**Spectator** — a participant connected to the Room who holds no Seat. A Spectator
receives the same authoritative state as an Occupant but cannot move.

**Occupancy rule** — a participant joining as a player takes an empty Seat. A Room with
both Seats occupied rejects another player; joining as a spectator is an explicit
choice and is available while a Match is in progress.

**Vacating** — a Seat becomes empty when its Occupant leaves on purpose. A transient
disconnect keeps the Seat reserved for the reconnect window. Seats are never rotated
automatically between Games, so completion does not reshuffle the table.

**Rotation** — the act of a vacated Seat being taken by a later player. Rotation is
triggered by Vacating, never by a Game ending.

## Match

**Match** — one Game played from the opening position to a terminal result between
the two Occupants of a Room.

**Move** — one Occupant's single state transition: placing a stone (五子棋) or moving
one piece (象棋). A Move is the only way board state changes.

**Turn** — the right to make the next Move. Exactly one Seat holds the Turn at any
time. A Move by the Seat that does not hold the Turn is rejected, not queued.

**Spectating** — reading a Match without holding a Seat. A Spectator's view is the
same authoritative snapshot an Occupant sees, minus that Occupant's private affordances.

**Undo request** — a proposal from one Occupant to revert the last Move. It takes
effect only on the other Occupant's agreement. There is no unconditional Undo.

**Resign** — an Occupant conceding the Match. The Match ends immediately with the
opponent as winner.

**Forfeit** — the result recorded when an Occupant disconnects and does not return
before the cloud reconnect window closes, or when their clock expires.

## Clock

**Match clock** — a per-Seat countdown of remaining thinking time. The clock of the
Seat holding the Turn runs; the other is stopped.

**Budget** — the fixed time each Seat receives for one Match. The clock is a budget,
not a per-move increment: there are no increments and no byo-yomi.

**Timeout** — a Seat whose clock reaches zero loses the Match by Forfeit.

## Terminal results

**Win** — decided by the Game's own win condition, by Resign, or by Forfeit.

**Draw** — a Match with no winner. In 象棋 this includes stalemate (困毙 is a loss,
not a draw) and the sixty-move no-capture rule.

**仕/帅 constraint** — 象棋 forbids leaving the two generals facing each other on an
open file. A Move that would expose them is illegal, not a loss.

## Presentation

**Board scene** — the canvas surface that draws the board, the pieces, and the
effects for one Room.

**Effect** — a short-lived visual response to a state transition (a placed stone, a
captured piece, a check, a won Match). Effects read state; they never decide it.

**Low-motion mode** — the participant's setting that suppresses camera shake, particle
bursts, and long animations. Every Effect must have a low-motion form.

**Spectator view** — the same Board scene rendered for a participant who holds no
Seat, with the interactive affordances hidden.
