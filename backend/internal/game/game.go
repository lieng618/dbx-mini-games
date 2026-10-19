// Package game defines the transport-free contracts shared by every board game in
// this plugin. A Game owns rules, geometry and win conditions. It owns no
// transport, no seating and no rendering.
package game

import "errors"

// Seat identifies a playing position. Seats are independent of Game.
type Seat int

const (
	SeatOne Seat = 0
	SeatTwo Seat = 1
)

// Other returns the opposing seat.
func (s Seat) Other() Seat { return 1 - s }

// Move is one state transition. A placement (gomoku) uses From < 0. A piece move
// (xiangqi) uses both endpoints.
type Move struct {
	From int `json:"from"`
	To   int `json:"to"`
}

// Outcome is a terminal result.
type Outcome int

const (
	OutcomeNone Outcome = iota
	OutcomeSeatOneWin
	OutcomeSeatTwoWin
	OutcomeDraw
)

// Result reports a terminal state. Finished is false while play continues.
type Result struct {
	Finished bool
	Outcome  Outcome
	Reason   string
}

// Errors a caller may need to distinguish.
var (
	ErrIllegalMove  = errors.New("illegal move")
	ErrNotYourTurn  = errors.New("not your turn")
	ErrGameFinished = errors.New("game already finished")
	ErrNoHistory    = errors.New("no move to undo")
)

// CheckReporter is implemented by games that can report a threatened king. It is optional:
// gomoku has no such concept.
type CheckReporter interface {
	// InCheck reports whether the given seat's king is currently attacked.
	InCheck(seat Seat) bool
	// KingSquare returns the square holding the seat's king, or -1.
	KingSquare(seat Seat) int
}

// WinLineReporter is implemented by games that can name the squares forming the winning
// line, so the presentation layer can draw through them. It is optional.
type WinLineReporter interface {
	// WinLine returns the squares of the winning line, in order, or nil.
	WinLine() []int
}

// Engine is one game's authoritative rule machine. Implementations must be pure:
// no clocks, no I/O, no locks. The Room serialises calls.
type Engine interface {
	// Name is the stable game identifier used in snapshots.
	Name() string

	// Cells returns a flat view of the board. Encoding is Game-specific.
	Cells() []int8

	// Turn is the seat that may move next.
	Turn() Seat

	// Apply validates and commits one move for the seat on turn.
	Apply(m Move) error

	// Undo reverts the most recent move. It reports whether a move was reverted.
	Undo() bool

	// Result reports the terminal state, if any.
	Result() Result

	// LegalFrom lists destination points reachable from a given point for the seat
	// on turn. An admission-time convenience for the UI; never authoritative.
	LegalFrom(from int) []int

	// History returns committed moves in order.
	History() []Move

	// Clone produces an independent engine with identical state.
	Clone() Engine
}
