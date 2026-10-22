package xiangqi

import (
	"testing"

	"github.com/lieng618/dbx-mini-games/backend/internal/game"
)

func idx(rank, file int) int { return rank*Cols + file }

func TestOpeningPosition(t *testing.T) {
	e := New()
	if e.Turn() != game.SeatOne {
		t.Fatalf("red must open, got seat %d", e.Turn())
	}
	cells := e.Cells()
	if cells[idx(9, 4)] != King {
		t.Fatalf("red king must sit at (9,4), got %d", cells[idx(9, 4)])
	}
	if cells[idx(0, 4)] != -King {
		t.Fatalf("black king must sit at (0,4), got %d", cells[idx(0, 4)])
	}
	if cells[idx(7, 1)] != Cannon || cells[idx(2, 1)] != -Cannon {
		t.Fatal("cannons must start on their files")
	}
	if cells[idx(6, 0)] != Pawn || cells[idx(3, 0)] != -Pawn {
		t.Fatal("pawns must start on their rank")
	}
	if e.Result().Finished {
		t.Fatal("opening position is not terminal")
	}
}

func TestHorseLegIsBlocked(t *testing.T) {
	e := New()
	// At the opening the red horse at (9,1) has its forward legs clear.
	dests := e.LegalFrom(idx(9, 1))
	if !contains(dests, idx(7, 0)) || !contains(dests, idx(7, 2)) {
		t.Fatalf("horse should reach both forward points, got %v", dests)
	}

	// On a bare board a horse at (5,4) reaches (3,5) via the rank-4 leg.
	board := [Cells]int8{}
	board[idx(5, 4)] = Horse
	reached := pseudoDestinations(board, idx(5, 4), Horse)
	if !reached[idx(3, 5)] {
		t.Fatal("clear horse leg should reach (3,5)")
	}
	if !reached[idx(7, 5)] {
		t.Fatal("clear horse leg should reach (7,5)")
	}

	// Occupying the leg point (4,4) blocks both upward moves that need it.
	board[idx(4, 4)] = Pawn
	blocked := pseudoDestinations(board, idx(5, 4), Horse)
	if blocked[idx(3, 5)] || blocked[idx(3, 3)] {
		t.Fatal("occupied horse leg must block the move")
	}
	if !blocked[idx(7, 5)] {
		t.Fatal("moves whose leg stays clear must survive")
	}
}

func TestElephantCannotCrossRiverOrJumpEye(t *testing.T) {
	board := [Cells]int8{}
	board[idx(9, 2)] = Elephant
	dests := pseudoDestinations(board, idx(9, 2), Elephant)
	if !dests[idx(7, 0)] || !dests[idx(7, 4)] {
		t.Fatalf("red elephant should reach its own side, got %v", dests)
	}
	if dests[idx(5, 0)] {
		t.Fatal("elephant must not cross the river on one move")
	}
	board[idx(8, 1)] = Pawn
	blocked := pseudoDestinations(board, idx(9, 2), Elephant)
	if blocked[idx(7, 0)] {
		t.Fatal("elephant eye being occupied must block the move")
	}
}

func TestCannonNeedsScreenToCapture(t *testing.T) {
	board := [Cells]int8{}
	board[idx(7, 1)] = Cannon
	board[idx(3, 1)] = -Rook
	dests := pseudoDestinations(board, idx(7, 1), Cannon)
	if dests[idx(3, 1)] {
		t.Fatal("cannon must not capture without a screen")
	}
	board[idx(5, 1)] = Pawn
	screened := pseudoDestinations(board, idx(7, 1), Cannon)
	if !screened[idx(3, 1)] {
		t.Fatal("cannon should capture over exactly one screen")
	}
	if screened[idx(5, 1)] {
		t.Fatal("cannon must not capture the screen itself")
	}
	if !screened[idx(6, 1)] {
		t.Fatal("cannon should move freely before the screen")
	}
}

func TestPawnGainsSidewaysOnlyAfterRiver(t *testing.T) {
	board := [Cells]int8{}
	board[idx(6, 4)] = Pawn
	before := pseudoDestinations(board, idx(6, 4), Pawn)
	if before[idx(6, 3)] || before[idx(6, 5)] {
		t.Fatal("pawn must not move sideways before crossing the river")
	}
	if !before[idx(5, 4)] {
		t.Fatal("pawn should advance")
	}
	board = [Cells]int8{}
	board[idx(4, 4)] = Pawn
	after := pseudoDestinations(board, idx(4, 4), Pawn)
	if !after[idx(4, 3)] || !after[idx(4, 5)] {
		t.Fatal("pawn should move sideways after crossing the river")
	}
}

func TestBlackPawnDirection(t *testing.T) {
	board := [Cells]int8{}
	board[idx(3, 4)] = -Pawn
	dests := pseudoDestinations(board, idx(3, 4), -Pawn)
	if !dests[idx(4, 4)] {
		t.Fatal("black pawns advance toward higher ranks")
	}
	if dests[idx(2, 4)] {
		t.Fatal("black pawns must not move backwards")
	}
}

func TestKingStaysInPalace(t *testing.T) {
	board := [Cells]int8{}
	board[idx(9, 4)] = King
	dests := pseudoDestinations(board, idx(9, 4), King)
	for _, to := range []int{idx(9, 3), idx(9, 5), idx(8, 4)} {
		if !dests[to] {
			t.Fatalf("king should reach %d", to)
		}
	}
	if dests[idx(9, 6)] || dests[idx(8, 5)] {
		t.Fatal("king must not leave the palace")
	}
}

func TestGeneralsFacingIsIllegal(t *testing.T) {
	e := New()
	// Clear the file between the generals, then try to expose them.
	e.board = [Cells]int8{}
	e.board[idx(9, 4)] = King
	e.board[idx(0, 4)] = -King
	e.board[idx(7, 4)] = Rook
	e.board[idx(5, 0)] = -Rook
	e.board[idx(9, 0)] = -Rook

	move := game.Move{From: idx(7, 4), To: idx(7, 5)}
	if err := e.Apply(move); err != game.ErrIllegalMove {
		t.Fatalf("moving the screening rook must be rejected, got %v", err)
	}
}

func TestCaptureAndUndo(t *testing.T) {
	e := New()
	// Red cannon captures the black horse at (0,1) using the black cannon at (2,1)
	// as a screen after clearing the path.
	if err := e.Apply(game.Move{From: idx(7, 1), To: idx(7, 0)}); err != nil {
		t.Fatal(err)
	}
	if err := e.Apply(game.Move{From: idx(0, 0), To: idx(1, 0)}); err != nil {
		t.Fatal(err)
	}
	before, _ := e.board[idx(7, 1)], 0
	if !e.Undo() {
		t.Fatal("expected undo to succeed")
	}
	if e.Turn() != game.SeatTwo {
		t.Fatalf("expected black to move again after undoing red's move, got %d", e.Turn())
	}
	if e.board[idx(0, 0)] != -Rook {
		t.Fatal("undo must restore the moved piece")
	}
	_ = before
	if !e.Undo() {
		t.Fatal("expected second undo to succeed")
	}
	if e.Turn() != game.SeatOne {
		t.Fatalf("expected red to move again, got %d", e.Turn())
	}
	if e.board[idx(7, 1)] != Cannon {
		t.Fatal("undo must restore the cannon")
	}
}

func TestUndoRestoresNoCaptureCounter(t *testing.T) {
	e := New()
	e.noCapture = NoCaptureLimitDraw - 1
	move := game.Move{From: idx(7, 1), To: idx(7, 4)}
	if err := e.Apply(move); err != nil {
		t.Fatal(err)
	}
	if e.Result().Reason != "sixty-move rule" {
		t.Fatalf("expected the next non-capture to draw, got %+v", e.Result())
	}
	if !e.Undo() {
		t.Fatal("expected undo to succeed")
	}
	if e.noCapture != NoCaptureLimitDraw-1 {
		t.Fatalf("undo restored noCapture=%d, want %d", e.noCapture, NoCaptureLimitDraw-1)
	}
	if e.Result().Finished {
		t.Fatalf("undo must clear the draw, got %+v", e.Result())
	}
}

func TestUndoDecrementsRepetitionCount(t *testing.T) {
	e := New()
	if err := e.Apply(game.Move{From: idx(7, 1), To: idx(7, 4)}); err != nil {
		t.Fatal(err)
	}
	positionKey := e.key()
	e.positions[positionKey] = 2
	if !e.Undo() {
		t.Fatal("expected undo to succeed")
	}
	if got := e.positions[positionKey]; got != 1 {
		t.Fatalf("repetition count after undo = %d, want 1", got)
	}
}

func TestCheckmateIsTerminal(t *testing.T) {
	e := New()
	e.board = [Cells]int8{}
	// Black king boxed in its palace at (0,4).
	e.board[idx(0, 4)] = -King
	// Red king on another file, so no generals-facing veto.
	e.board[idx(9, 0)] = King
	// Checks along file 4 from a distance, so the king cannot capture it.
	e.board[idx(3, 4)] = Rook
	// Covers the two remaining escape points.
	e.board[idx(2, 3)] = Rook
	e.board[idx(2, 5)] = Rook

	e.turn = game.SeatTwo
	e.noCapture = 0
	e.positions = map[string]int{e.key(): 1}
	e.settle()

	if !e.Result().Finished {
		t.Fatal("expected a terminal result")
	}
	if e.Result().Outcome != game.OutcomeSeatOneWin {
		t.Fatalf("expected red to win, got %+v", e.Result())
	}
	if e.Result().Reason != "checkmate" {
		t.Fatalf("expected checkmate, got %q", e.Result().Reason)
	}
	if !e.inCheck(game.SeatTwo) {
		t.Fatal("fixture must actually put black in check")
	}
}

func TestStalemateLosesInXiangqi(t *testing.T) {
	e := New()
	e.board = [Cells]int8{}
	e.board[idx(0, 4)] = -King
	// Red king far away on another file, so no generals-facing veto.
	e.board[idx(9, 0)] = King
	// Both rooks cover rank 0 and rank 1 without attacking (0,4) itself, so black is
	// not in check yet has no legal move.
	e.board[idx(1, 3)] = Rook
	e.board[idx(1, 5)] = Rook

	e.turn = game.SeatTwo
	e.settle()

	if e.inCheck(game.SeatTwo) {
		t.Fatal("stalemate fixture must not be check")
	}
	if !e.Result().Finished {
		t.Fatal("expected stalemate to end the game")
	}
	if e.Result().Outcome != game.OutcomeSeatOneWin {
		t.Fatalf("stalemate must be a loss for the stalemated side, got %+v", e.Result())
	}
	if e.Result().Reason != "stalemate" {
		t.Fatalf("expected stalemate reason, got %q", e.Result().Reason)
	}
}

func TestNoCaptureLimitDraws(t *testing.T) {
	e := New()
	e.noCapture = NoCaptureLimitDraw
	e.turn = game.SeatOne
	e.settle()
	if e.Result().Outcome != game.OutcomeDraw {
		t.Fatalf("expected sixty-move draw, got %+v", e.Result())
	}
}

func TestHasLegalMoveAgreesWithLegalFrom(t *testing.T) {
	// Regression: legalDestinations returns a fixed-size array, so its len() is
	// always Cells. hasLegalMove must count set entries, never length. A bare board
	// with a lone king in its palace still has legal moves.
	e := New()
	e.board = [Cells]int8{}
	e.board[idx(0, 4)] = -King
	e.board[idx(9, 0)] = King
	e.turn = game.SeatTwo
	if !e.hasLegalMove(game.SeatTwo) {
		t.Fatal("a lone king in its palace always has legal moves")
	}

	// A fully boxed king must report no legal move.
	e.board = [Cells]int8{}
	e.board[idx(0, 4)] = -King
	e.board[idx(9, 0)] = King
	e.board[idx(1, 3)] = Rook
	e.board[idx(1, 5)] = Rook
	if e.hasLegalMove(game.SeatTwo) {
		t.Fatal("a boxed king must report no legal move")
	}
}

func TestCloneIsIndependent(t *testing.T) {
	e := New()
	clone := e.Clone()
	if err := clone.Apply(game.Move{From: idx(7, 1), To: idx(7, 4)}); err != nil {
		t.Fatal(err)
	}
	if e.board[idx(7, 1)] != Cannon {
		t.Fatal("clone must not mutate the original")
	}
}

func contains(xs []int, want int) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}
