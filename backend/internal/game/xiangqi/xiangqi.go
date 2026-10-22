// Package xiangqi implements Chinese chess on a 9-file by 10-rank point grid.
//
// Board indices run 0..89 in rank-major order: index = rank*Cols + file, with
// rank 0 at the top (black's back rank) and rank 9 at the bottom (red's back rank).
// Seat one plays red and moves first.
package xiangqi

import "github.com/lieng618/dbx-mini-games/backend/internal/game"

// Piece codes. Sign marks the owner: positive is red (seat one), negative is black
// (seat two). Zero is an empty point.
const (
	King     int8 = 1
	Advisor  int8 = 2
	Elephant int8 = 3
	Horse    int8 = 4
	Rook     int8 = 5
	Cannon   int8 = 6
	Pawn     int8 = 7

	Rows  = 10
	Cols  = 9
	Cells = Rows * Cols

	// NoCaptureLimitDraw is the number of half-moves without a capture after which a
	// match is drawn by the sixty-move rule.
	NoCaptureLimitDraw = 120
)

// owner returns +1 for red pieces, -1 for black pieces, 0 for empty points.
func owner(code int8) int {
	switch {
	case code > 0:
		return 1
	case code < 0:
		return -1
	default:
		return 0
	}
}

func kind(code int8) int8 {
	if code < 0 {
		return -code
	}
	return code
}

// seatOf maps a board code to the seat that owns it.
func seatOf(code int8) game.Seat {
	if code > 0 {
		return game.SeatOne
	}
	return game.SeatTwo
}

// Engine is the authoritative xiangqi rule machine.
type Engine struct {
	board    [Cells]int8
	turn     game.Seat
	history  []game.Move
	captured []int8
	// noCaptureBefore stores the exact counter value preceding each move so Undo can restore
	// rule state, not just the board.
	noCaptureBefore []int
	result          game.Result
	noCapture       int
	// positions counts repeated board keys, used for the repetition guard.
	positions map[string]int
}

// New returns an engine in the opening position with red to move.
func New() *Engine {
	e := &Engine{turn: game.SeatOne, positions: map[string]int{}}
	e.reset()
	return e
}

// reset places the opening position.
func (e *Engine) reset() {
	e.board = [Cells]int8{}
	back := []int8{Rook, Horse, Elephant, Advisor, King, Advisor, Elephant, Horse, Rook}
	for f := 0; f < Cols; f++ {
		e.board[f] = -back[f]
		e.board[9*Cols+f] = back[f]
	}
	e.board[2*Cols+1] = -Cannon
	e.board[2*Cols+7] = -Cannon
	e.board[7*Cols+1] = Cannon
	e.board[7*Cols+7] = Cannon
	for _, f := range []int{0, 2, 4, 6, 8} {
		e.board[3*Cols+f] = -Pawn
		e.board[6*Cols+f] = Pawn
	}
	e.history = nil
	e.captured = nil
	e.noCaptureBefore = nil
	e.result = game.Result{}
	e.noCapture = 0
	e.positions = map[string]int{}
	e.positions[e.key()] = 1
}

func (e *Engine) Name() string { return "xiangqi" }

func (e *Engine) Cells() []int8 {
	out := make([]int8, Cells)
	copy(out, e.board[:])
	return out
}

func (e *Engine) Turn() game.Seat { return e.turn }

func (e *Engine) Result() game.Result { return e.result }

func (e *Engine) History() []game.Move {
	out := make([]game.Move, len(e.history))
	copy(out, e.history)
	return out
}

func (e *Engine) Clone() game.Engine {
	clone := &Engine{turn: e.turn, result: e.result, noCapture: e.noCapture}
	clone.board = e.board
	clone.history = make([]game.Move, len(e.history))
	copy(clone.history, e.history)
	clone.captured = make([]int8, len(e.captured))
	copy(clone.captured, e.captured)
	clone.noCaptureBefore = make([]int, len(e.noCaptureBefore))
	copy(clone.noCaptureBefore, e.noCaptureBefore)
	clone.positions = make(map[string]int, len(e.positions))
	for k, v := range e.positions {
		clone.positions[k] = v
	}
	return clone
}

// key is a compact board fingerprint plus side to move.
func (e *Engine) key() string {
	buf := make([]byte, 0, Cells+1)
	for _, c := range e.board {
		buf = append(buf, byte(c+8))
	}
	return string(append(buf, byte(e.turn)))
}

// inBoard reports whether rank/file identify a real point.
func inBoard(rank, file int) bool {
	return rank >= 0 && rank < Rows && file >= 0 && file < Cols
}

// inPalace reports whether a point is inside the given seat's palace.
func inPalace(rank, file int, seat game.Seat) bool {
	if file < 3 || file > 5 {
		return false
	}
	if seat == game.SeatOne {
		return rank >= 7 && rank <= 9
	}
	return rank >= 0 && rank <= 2
}

// isRed reports whether the given seat owns red pieces.
func isRed(seat game.Seat) bool { return seat == game.SeatOne }

// Apply validates and commits one move.
func (e *Engine) Apply(m game.Move) error {
	if e.result.Finished {
		return game.ErrGameFinished
	}
	if m.From < 0 || m.From >= Cells || m.To < 0 || m.To >= Cells {
		return game.ErrIllegalMove
	}
	code := e.board[m.From]
	if code == 0 || seatOf(code) != e.turn {
		return game.ErrIllegalMove
	}
	if !legalDestinations(e.board, m.From, e.turn)[m.To] {
		return game.ErrIllegalMove
	}

	target := e.board[m.To]
	e.board[m.To] = code
	e.board[m.From] = 0

	if e.generalsFacing() {
		e.board[m.From] = code
		e.board[m.To] = target
		return game.ErrIllegalMove
	}

	e.history = append(e.history, m)
	e.captured = append(e.captured, target)
	e.noCaptureBefore = append(e.noCaptureBefore, e.noCapture)

	if target != 0 {
		e.noCapture = 0
	} else {
		e.noCapture++
	}
	e.turn = e.turn.Other()
	e.positions[e.key()]++

	e.settle()
	return nil
}

// Undo reverts the last move.
func (e *Engine) Undo() bool {
	if len(e.history) == 0 {
		return false
	}
	last := e.history[len(e.history)-1]
	code := e.board[last.To]
	captured := e.captured[len(e.captured)-1]

	positionKey := e.key()
	if e.positions[positionKey] <= 1 {
		delete(e.positions, positionKey)
	} else {
		e.positions[positionKey]--
	}
	e.board[last.From] = code
	e.board[last.To] = captured
	e.history = e.history[:len(e.history)-1]
	e.captured = e.captured[:len(e.captured)-1]
	e.noCapture = e.noCaptureBefore[len(e.noCaptureBefore)-1]
	e.noCaptureBefore = e.noCaptureBefore[:len(e.noCaptureBefore)-1]
	e.turn = e.turn.Other()
	e.result = game.Result{}
	return true
}

// LegalFrom lists legal destinations for the point from, when that piece belongs to
// the seat on turn.
func (e *Engine) LegalFrom(from int) []int {
	if from < 0 || from >= Cells || e.result.Finished {
		return nil
	}
	code := e.board[from]
	if code == 0 || seatOf(code) != e.turn {
		return nil
	}
	dests := legalDestinations(e.board, from, e.turn)
	out := make([]int, 0, len(dests))
	for i := 0; i < Cells; i++ {
		if dests[i] {
			out = append(out, i)
		}
	}
	return out
}

// legalDestinations computes every pseudo-legal destination for the piece at from,
// then removes moves that would leave the mover's general facing the enemy or under
// attack. Both are hard constraints: exposing your general or walking into check is
// illegal, not a loss.
func legalDestinations(board [Cells]int8, from int, seat game.Seat) [Cells]bool {
	var out [Cells]bool
	code := board[from]
	pseudo := pseudoDestinations(board, from, code)
	for to := range pseudo {
		if !pseudo[to] {
			continue
		}
		probe := board
		probe[to] = code
		probe[from] = 0
		if generalsFacingOn(probe) {
			continue
		}
		if kingAttacked(probe, seat) {
			continue
		}
		out[to] = true
	}
	return out
}

// kingIndex locates a seat's general, or -1 when it is absent.
func kingIndex(board [Cells]int8, seat game.Seat) int {
	want := King
	if seat == game.SeatTwo {
		want = -King
	}
	for i, c := range board {
		if c == want {
			return i
		}
	}
	return -1
}

// kingAttacked reports whether the seat's general is under attack.
func kingAttacked(board [Cells]int8, seat game.Seat) bool {
	idx := kingIndex(board, seat)
	if idx < 0 {
		return true
	}
	return attacked(board, idx, seat.Other())
}

// pseudoDestinations ignores the generals-facing constraint.
func pseudoDestinations(board [Cells]int8, from int, code int8) [Cells]bool {
	var out [Cells]bool
	rank, file := from/Cols, from%Cols
	seat := seatOf(code)
	mine := owner(code)

	place := func(r, f int) bool {
		if !inBoard(r, f) {
			return false
		}
		other := board[r*Cols+f]
		if other != 0 && owner(other) == mine {
			return false
		}
		out[r*Cols+f] = true
		// A capture blocks any further travel along this ray.
		return other == 0
	}

	ray := func(dr, df int) {
		for r, f := rank+dr, file+df; inBoard(r, f); r, f = r+dr, f+df {
			if !place(r, f) {
				return
			}
		}
	}

	switch kind(code) {
	case King:
		for _, d := range [][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
			r, f := rank+d[0], file+d[1]
			if inPalace(r, f, seat) {
				place(r, f)
			}
		}
	case Advisor:
		for _, d := range [][2]int{{1, 1}, {1, -1}, {-1, 1}, {-1, -1}} {
			r, f := rank+d[0], file+d[1]
			if inPalace(r, f, seat) {
				place(r, f)
			}
		}
	case Elephant:
		for _, d := range [][2]int{{2, 2}, {2, -2}, {-2, 2}, {-2, -2}} {
			r, f := rank+d[0], file+d[1]
			if !inBoard(r, f) {
				continue
			}
			// An elephant never crosses the river.
			if seat == game.SeatOne && r < 5 {
				continue
			}
			if seat == game.SeatTwo && r > 4 {
				continue
			}
			// The eye must be clear.
			if board[(rank+d[0]/2)*Cols+file+d[1]/2] != 0 {
				continue
			}
			place(r, f)
		}
	case Horse:
		for _, d := range [][2]int{{2, 1}, {2, -1}, {-2, 1}, {-2, -1}, {1, 2}, {1, -2}, {-1, 2}, {-1, -2}} {
			r, f := rank+d[0], file+d[1]
			if !inBoard(r, f) {
				continue
			}
			// The leg must be clear: the orthogonal neighbour toward the move.
			legRank, legFile := rank, file
			if d[0] == 2 || d[0] == -2 {
				legRank = rank + d[0]/2
			} else {
				legFile = file + d[1]/2
			}
			if board[legRank*Cols+legFile] != 0 {
				continue
			}
			place(r, f)
		}
	case Rook:
		ray(1, 0)
		ray(-1, 0)
		ray(0, 1)
		ray(0, -1)
	case Cannon:
		for _, d := range [][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
			jumped := false
			for r, f := rank+d[0], file+d[1]; inBoard(r, f); r, f = r+d[0], f+d[1] {
				target := board[r*Cols+f]
				if !jumped {
					if target == 0 {
						out[r*Cols+f] = true
						continue
					}
					jumped = true
					continue
				}
				// Past the screen: the first piece encountered may be captured if it
				// belongs to the opponent.
				if target != 0 {
					if owner(target) != mine {
						out[r*Cols+f] = true
					}
					break
				}
			}
		}
	case Pawn:
		forward := -1
		if seat == game.SeatOne {
			forward = -1
		} else {
			forward = 1
		}
		// Red moves toward rank 0, black toward rank 9.
		dr := forward
		if seat == game.SeatOne {
			dr = -1
		}
		place(rank+dr, file)
		// Sideways movement only after crossing the river.
		crossed := (seat == game.SeatOne && rank <= 4) || (seat == game.SeatTwo && rank >= 5)
		if crossed {
			place(rank, file-1)
			place(rank, file+1)
		}
	}
	return out
}

// generalsFacing reports whether the two generals share a file with nothing between them.
func (e *Engine) generalsFacing() bool { return generalsFacingOn(e.board) }

func generalsFacingOn(board [Cells]int8) bool {
	redKing, blackKing := -1, -1
	for i, c := range board {
		if c == King {
			redKing = i
		} else if c == -King {
			blackKing = i
		}
	}
	if redKing < 0 || blackKing < 0 {
		return false
	}
	if redKing%Cols != blackKing%Cols {
		return false
	}
	file := redKing % Cols
	lo, hi := redKing/Cols, blackKing/Cols
	if lo > hi {
		lo, hi = hi, lo
	}
	for r := lo + 1; r < hi; r++ {
		if board[r*Cols+file] != 0 {
			return false
		}
	}
	return true
}

// settle updates the terminal result after a committed move.
func (e *Engine) settle() {
	mover := e.turn.Other()

	// No legal reply means mate or stalemate. Both are losses for the side that
	// cannot move, so the winner is the side that just moved.
	if !e.hasLegalMove(e.turn) {
		outcome := game.OutcomeSeatOneWin
		if mover == game.SeatTwo {
			outcome = game.OutcomeSeatTwoWin
		}
		reason := "checkmate"
		if !e.inCheck(e.turn) {
			reason = "stalemate"
		}
		e.result = game.Result{Finished: true, Outcome: outcome, Reason: reason}
		return
	}
	if e.noCapture >= NoCaptureLimitDraw {
		e.result = game.Result{Finished: true, Outcome: game.OutcomeDraw, Reason: "sixty-move rule"}
		return
	}
	// Threefold repetition of the position with the same side to move is a draw.
	if e.positions[e.key()] >= 3 {
		e.result = game.Result{Finished: true, Outcome: game.OutcomeDraw, Reason: "repetition"}
	}
}

// hasLegalMove reports whether the seat has any legal move.
func (e *Engine) hasLegalMove(seat game.Seat) bool {
	for i := 0; i < Cells; i++ {
		code := e.board[i]
		if code == 0 || seatOf(code) != seat {
			continue
		}
		dests := legalDestinations(e.board, i, seat)
		for _, ok := range dests {
			if ok {
				return true
			}
		}
	}
	return false
}

// inCheck reports whether the seat's general is attacked.
func (e *Engine) inCheck(seat game.Seat) bool { return kingAttacked(e.board, seat) }

// InCheck satisfies game.CheckReporter.
func (e *Engine) InCheck(seat game.Seat) bool { return e.inCheck(seat) }

// KingSquare satisfies game.CheckReporter.
func (e *Engine) KingSquare(seat game.Seat) int { return kingIndex(e.board, seat) }

// attacked reports whether any piece of by attacks the point idx. It ignores the
// generals-facing constraint, which is checked separately.
func attacked(board [Cells]int8, idx int, by game.Seat) bool {
	for i := 0; i < Cells; i++ {
		code := board[i]
		if code == 0 || seatOf(code) != by {
			continue
		}
		if pseudoDestinations(board, i, code)[idx] {
			return true
		}
	}
	return false
}
