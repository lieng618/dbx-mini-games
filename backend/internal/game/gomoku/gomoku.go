// Package gomoku implements free-style five-in-a-row on a 15x15 point grid.
//
// Free-style means no forbidden moves: three-three, four-four and overline are all
// legal, and five or more in a row wins.
package gomoku

import "github.com/jzj2621899857/dbx-board-games/backend/internal/game"

// Side identifies a stone colour on the board.
const (
	Empty   int8 = 0
	Black   int8 = 1
	White   int8 = 2
	Rows         = 15
	Cols         = 15
	Cells        = Rows * Cols
	WinLength    = 5
)

// Engine is the authoritative gomoku rule machine.
type Engine struct {
	board   [Cells]int8
	turn    game.Seat
	history []game.Move
	result  game.Result
}

// New returns an engine with Black (seat one) to move.
func New() *Engine {
	return &Engine{turn: game.SeatOne}
}

func (e *Engine) Name() string { return "gomoku" }

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
	clone := &Engine{turn: e.turn, result: e.result}
	clone.board = e.board
	clone.history = make([]game.Move, len(e.history))
	copy(clone.history, e.history)
	return clone
}

// stone maps a seat to its stone colour.
func stone(seat game.Seat) int8 {
	if seat == game.SeatOne {
		return Black
	}
	return White
}

// Apply places a stone for the seat on turn.
func (e *Engine) Apply(m game.Move) error {
	if e.result.Finished {
		return game.ErrGameFinished
	}
	if m.To < 0 || m.To >= Cells {
		return game.ErrIllegalMove
	}
	if e.board[m.To] != Empty {
		return game.ErrIllegalMove
	}

	colour := stone(e.turn)
	e.board[m.To] = colour
	e.history = append(e.history, m)

	if e.winsAt(m.To, colour) {
		if e.turn == game.SeatOne {
			e.result = game.Result{Finished: true, Outcome: game.OutcomeSeatOneWin, Reason: "five in a row"}
		} else {
			e.result = game.Result{Finished: true, Outcome: game.OutcomeSeatTwoWin, Reason: "five in a row"}
		}
		return nil
	}
	if len(e.history) == Cells {
		e.result = game.Result{Finished: true, Outcome: game.OutcomeDraw, Reason: "board full"}
		return nil
	}
	e.turn = e.turn.Other()
	return nil
}

// Undo reverts the last placement.
func (e *Engine) Undo() bool {
	if len(e.history) == 0 {
		return false
	}
	last := e.history[len(e.history)-1]
	e.history = e.history[:len(e.history)-1]
	e.board[last.To] = Empty
	e.turn = e.turn.Other()
	e.result = game.Result{}
	return true
}

// LegalFrom returns the point itself when it is empty and the game is live, because a
// placement only ever targets one cell.
func (e *Engine) LegalFrom(from int) []int {
	if e.result.Finished || from < 0 || from >= Cells || e.board[from] != Empty {
		return nil
	}
	return []int{from}
}

// winsAt reports whether the stone at idx completes a run of WinLength or more
// horizontally, vertically or on either diagonal.
func (e *Engine) winsAt(idx int, colour int8) bool {
	row, col := idx/Cols, idx%Cols
	for _, dir := range [4][2]int{{0, 1}, {1, 0}, {1, 1}, {1, -1}} {
		count := 1
		for sign := 1; sign >= -1; sign -= 2 {
			for step := 1; ; step++ {
				r := row + dir[0]*step*sign
				c := col + dir[1]*step*sign
				if r < 0 || r >= Rows || c < 0 || c >= Cols || e.board[r*Cols+c] != colour {
					break
				}
				count++
			}
		}
		if count >= WinLength {
			return true
		}
	}
	return false
}
