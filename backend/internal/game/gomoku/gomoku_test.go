package gomoku

import (
	"testing"

	"github.com/southernMortals/dbx-board-games/backend/internal/game"
)

func place(t *testing.T, e *Engine, seats []game.Seat, cells ...int) {
	t.Helper()
	for i, c := range cells {
		if got := e.Turn(); got != seats[i] {
			t.Fatalf("expected turn %d before placing at %d, got %d", seats[i], c, got)
		}
		if err := e.Apply(game.Move{From: -1, To: c}); err != nil {
			t.Fatalf("place %d: %v", c, err)
		}
	}
}

func TestFirstMoveIsBlack(t *testing.T) {
	e := New()
	if e.Turn() != game.SeatOne {
		t.Fatalf("expected seat one to open, got %d", e.Turn())
	}
	if err := e.Apply(game.Move{From: -1, To: 0}); err != nil {
		t.Fatal(err)
	}
	if e.Turn() != game.SeatTwo {
		t.Fatalf("expected turn to pass, got %d", e.Turn())
	}
}

func TestRejectsOccupiedAndOutOfRange(t *testing.T) {
	e := New()
	if err := e.Apply(game.Move{From: -1, To: 5}); err != nil {
		t.Fatal(err)
	}
	if err := e.Apply(game.Move{From: -1, To: 5}); err != game.ErrIllegalMove {
		t.Fatalf("expected ErrIllegalMove on occupied cell, got %v", err)
	}
	if err := e.Apply(game.Move{From: -1, To: Cells}); err != game.ErrIllegalMove {
		t.Fatalf("expected ErrIllegalMove on out-of-range cell, got %v", err)
	}
}

func TestHorizontalWin(t *testing.T) {
	e := New()
	// Black at row 7 cols 3..7, white filling row 8.
	place(t, e, []game.Seat{
		game.SeatOne, game.SeatTwo,
		game.SeatOne, game.SeatTwo,
		game.SeatOne, game.SeatTwo,
		game.SeatOne, game.SeatTwo,
		game.SeatOne,
	}, 7*Cols+3, 8*Cols+0, 7*Cols+4, 8*Cols+1, 7*Cols+5, 8*Cols+2, 7*Cols+6, 8*Cols+3, 7*Cols+7)

	got := e.Result()
	if !got.Finished || got.Outcome != game.OutcomeSeatOneWin {
		t.Fatalf("expected seat one win, got %+v", got)
	}
}

func TestVerticalAndDiagonalWin(t *testing.T) {
	e := New()
	place(t, e, []game.Seat{
		game.SeatOne, game.SeatTwo,
		game.SeatOne, game.SeatTwo,
		game.SeatOne, game.SeatTwo,
		game.SeatOne, game.SeatTwo,
		game.SeatOne,
	}, 3*Cols+3, 0, 4*Cols+3, 1, 5*Cols+3, 2, 6*Cols+3, 4, 7*Cols+3)
	if e.Result().Outcome != game.OutcomeSeatOneWin {
		t.Fatalf("expected vertical win, got %+v", e.Result())
	}

	d := New()
	place(t, d, []game.Seat{
		game.SeatOne, game.SeatTwo,
		game.SeatOne, game.SeatTwo,
		game.SeatOne, game.SeatTwo,
		game.SeatOne, game.SeatTwo,
		game.SeatOne,
	}, 0, 14, Cols+1, 13, 2*Cols+2, 12, 3*Cols+3, 11, 4*Cols+4)
	if d.Result().Outcome != game.OutcomeSeatOneWin {
		t.Fatalf("expected diagonal win, got %+v", d.Result())
	}
}

func TestOverlineWinsUnderFreeStyle(t *testing.T) {
	e := New()
	place(t, e, []game.Seat{
		game.SeatOne, game.SeatTwo,
		game.SeatOne, game.SeatTwo,
		game.SeatOne, game.SeatTwo,
		game.SeatOne, game.SeatTwo,
		game.SeatOne, game.SeatTwo,
		game.SeatOne,
		// White fillers stay on row 1 with gaps, so only Black can complete a run.
	}, 7*Cols+2, Cols+0, 7*Cols+3, Cols+2, 7*Cols+5, Cols+4, 7*Cols+6, Cols+6, 7*Cols+7, Cols+8, 7*Cols+4)
	if e.Result().Outcome != game.OutcomeSeatOneWin {
		t.Fatalf("expected six in a row to win under free-style, got %+v", e.Result())
	}
}

func TestFourIsNotAWin(t *testing.T) {
	e := New()
	place(t, e, []game.Seat{
		game.SeatOne, game.SeatTwo,
		game.SeatOne, game.SeatTwo,
		game.SeatOne, game.SeatTwo,
		game.SeatOne,
	}, 7*Cols+3, 0, 7*Cols+4, 1, 7*Cols+5, 2, 7*Cols+6)
	if e.Result().Finished {
		t.Fatalf("four in a row must not finish the game, got %+v", e.Result())
	}
}

func TestUndoRestoresTurnAndCell(t *testing.T) {
	e := New()
	if err := e.Apply(game.Move{From: -1, To: 42}); err != nil {
		t.Fatal(err)
	}
	if !e.Undo() {
		t.Fatal("expected undo to revert a move")
	}
	if e.Turn() != game.SeatOne {
		t.Fatalf("expected seat one to move again, got %d", e.Turn())
	}
	if e.Cells()[42] != Empty {
		t.Fatal("expected cell to be cleared")
	}
	if e.Undo() {
		t.Fatal("expected undo on empty history to report false")
	}
}

func TestUndoClearsWinResult(t *testing.T) {
	e := New()
	place(t, e, []game.Seat{
		game.SeatOne, game.SeatTwo,
		game.SeatOne, game.SeatTwo,
		game.SeatOne, game.SeatTwo,
		game.SeatOne, game.SeatTwo,
		game.SeatOne,
	}, 7*Cols+3, 8*Cols+0, 7*Cols+4, 8*Cols+1, 7*Cols+5, 8*Cols+2, 7*Cols+6, 8*Cols+3, 7*Cols+7)
	if !e.Result().Finished {
		t.Fatal("expected a win before undo")
	}
	if !e.Undo() {
		t.Fatal("expected undo to succeed")
	}
	if e.Result().Finished {
		t.Fatalf("expected undo to clear the terminal result, got %+v", e.Result())
	}
}

func TestFinishedGameRejectsMoves(t *testing.T) {
	e := New()
	place(t, e, []game.Seat{
		game.SeatOne, game.SeatTwo,
		game.SeatOne, game.SeatTwo,
		game.SeatOne, game.SeatTwo,
		game.SeatOne, game.SeatTwo,
		game.SeatOne,
	}, 7*Cols+3, 8*Cols+0, 7*Cols+4, 8*Cols+1, 7*Cols+5, 8*Cols+2, 7*Cols+6, 8*Cols+3, 7*Cols+7)
	if err := e.Apply(game.Move{From: -1, To: 0}); err != game.ErrGameFinished {
		t.Fatalf("expected ErrGameFinished, got %v", err)
	}
}

func TestCloneIsIndependent(t *testing.T) {
	e := New()
	if err := e.Apply(game.Move{From: -1, To: 0}); err != nil {
		t.Fatal(err)
	}
	clone := e.Clone()
	if err := clone.Apply(game.Move{From: -1, To: 1}); err != nil {
		t.Fatal(err)
	}
	if e.Cells()[1] != Empty {
		t.Fatal("clone must not mutate the original board")
	}
}
