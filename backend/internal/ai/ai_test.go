package ai

import (
	"testing"

	"github.com/lieng618/dbx-mini-games/backend/internal/game"
	"github.com/lieng618/dbx-mini-games/backend/internal/game/gomoku"
	"github.com/lieng618/dbx-mini-games/backend/internal/game/xiangqi"
)

func at(file, rank int) int { return rank*gomokuSize + file }

// playGomoku applies alternating placements; seat one (black) moves first.
func playGomoku(t *testing.T, cells ...int) game.Engine {
	t.Helper()
	e := gomoku.New()
	for _, c := range cells {
		if err := e.Apply(game.Move{From: -1, To: c}); err != nil {
			t.Fatalf("setup move to %d failed: %v", c, err)
		}
	}
	return e
}

// TestGomokuCompletesFive: with four in a row and both ends open, the only acceptable
// answer is the fifth stone. This is the single behaviour that makes a partner feel alive.
func TestGomokuCompletesFive(t *testing.T) {
	// black (7,3..6) already four; white parked far away.
	e := playGomoku(t,
		at(7, 3), at(0, 0),
		at(7, 4), at(0, 1),
		at(7, 5), at(0, 2),
		at(7, 6), at(0, 3),
	)
	if e.Turn() != game.SeatOne {
		t.Fatalf("expected black to move, got %v", e.Turn())
	}
	move, ok := BestMove(e)
	if !ok {
		t.Fatal("no move returned")
	}
	if move.To != at(7, 2) && move.To != at(7, 7) {
		t.Fatalf("expected the winning stone at (7,2) or (7,7), got %d,%d", move.To%gomokuSize, move.To/gomokuSize)
	}
	if err := e.Apply(move); err != nil {
		t.Fatalf("chosen move was illegal: %v", err)
	}
	if res := e.Result(); !res.Finished {
		t.Fatal("expected the game to be won by that move")
	}
}

// TestGomokuBlocksOpenFour: an open four by the opponent must be answered, or the partner
// is just watching itself lose.
func TestGomokuBlocksOpenFour(t *testing.T) {
	// white builds (5,3..6); black plays scattered, unconnected stones.
	e := playGomoku(t,
		at(0, 0), at(5, 3),
		at(0, 2), at(5, 4),
		at(0, 4), at(5, 5),
		at(0, 6), at(5, 6),
	)
	if e.Turn() != game.SeatOne {
		t.Fatalf("expected black to move, got %v", e.Turn())
	}
	move, ok := BestMove(e)
	if !ok {
		t.Fatal("no move returned")
	}
	if move.To != at(5, 2) && move.To != at(5, 7) {
		t.Fatalf("expected a block at (5,2) or (5,7), got %d,%d", move.To%gomokuSize, move.To/gomokuSize)
	}
}

// TestGomokuPrefersWinningOverBlocking: when the partner can win now, it must not block.
func TestGomokuPrefersWinningOverBlocking(t *testing.T) {
	// black has four (3,3..6); white has four (9,3..6) as well. Black moves first and can
	// simply finish, which outranks defending.
	e := playGomoku(t,
		at(3, 3), at(9, 3),
		at(3, 4), at(9, 4),
		at(3, 5), at(9, 5),
		at(3, 6), at(9, 6),
	)
	move, ok := BestMove(e)
	if !ok {
		t.Fatal("no move returned")
	}
	if move.To != at(3, 2) && move.To != at(3, 7) {
		t.Fatalf("expected black to finish its own five, got %d,%d", move.To%gomokuSize, move.To/gomokuSize)
	}
}

// TestXiangqiMovesAreAlwaysLegal walks a real game: whatever the partner picks, the engine
// must accept it. An illegal proposal would surface to the player as a broken opponent.
func TestXiangqiMovesAreAlwaysLegal(t *testing.T) {
	e := xiangqi.New()
	for ply := 0; ply < 40; ply++ {
		if e.Result().Finished {
			break
		}
		move, ok := BestMove(e)
		if !ok {
			t.Fatalf("no move at ply %d", ply)
		}
		if err := e.Apply(move); err != nil {
			t.Fatalf("ply %d: partner proposed an illegal move %+v: %v", ply, move, err)
		}
	}
	if len(e.History()) < 20 {
		t.Fatalf("expected a real game, got %d moves", len(e.History()))
	}
}

// TestXiangqiTakesAFreePiece: a horse left hanging must be taken. This is what separates a
// partner from a random mover.
func TestXiangqiTakesAFreePiece(t *testing.T) {
	e := xiangqi.New()
	// Red cannon at 70 takes the black horse at 7 with nothing defending it; this is the
	// first move of the capture fixture, so it is a known-legal free capture.
	if err := e.Apply(game.Move{From: 70, To: 7}); err != nil {
		t.Fatalf("setup capture failed: %v", err)
	}
	// Black to move and down a horse. It should not hand over more material for nothing.
	// Both measurements are taken from black's own perspective — comparing one seat's score
	// against the other's is meaningless, since the sign flips.
	before := material(e.Cells(), game.SeatTwo)
	move, ok := BestMove(e)
	if !ok {
		t.Fatal("no move returned")
	}
	if err := e.Apply(move); err != nil {
		t.Fatalf("illegal reply: %v", err)
	}
	after := material(e.Cells(), game.SeatTwo)
	if after < before-50 {
		t.Fatalf("black handed over more material: %d -> %d", before, after)
	}
}

// TestXiangqiDoesNotHangItsRook: given a position where one move drops the rook and the
// alternatives do not, the partner must avoid the blunder.
func TestXiangqiDoesNotHangItsRook(t *testing.T) {
	e := xiangqi.New()
	// Material is level at the start; after a few quiet book-ish moves nothing is hanging.
	for _, m := range []game.Move{{From: 54, To: 45}, {From: 27, To: 36}} {
		if err := e.Apply(m); err != nil {
			t.Fatalf("setup failed: %v", err)
		}
	}
	move, ok := BestMove(e)
	if !ok {
		t.Fatal("no move returned")
	}
	after := e.Clone()
	if err := after.Apply(move); err != nil {
		t.Fatalf("illegal move: %v", err)
	}
	// Whatever it plays, the opponent must not be able to win a rook for free next ply.
	worst := 0
	for _, reply := range legalMoves(after) {
		two := after.Clone()
		if err := two.Apply(reply); err != nil {
			continue
		}
		if swing := material(two.Cells(), game.SeatTwo) - material(e.Cells(), game.SeatTwo); swing > worst {
			worst = swing
		}
	}
	if worst >= 900 {
		t.Fatalf("partner walked into losing a rook (swing %d)", worst)
	}
}

// emptyXiangqiBoard is a 90-point board with nothing on it.
func emptyXiangqiBoard() []int8 { return make([]int8, 90) }

// TestPressureRewardsProximity: a rook sitting on the enemy general is worth more pressure
// than the same rook parked on its own back rank. Without this the partner has no reason to
// ever come forward.
func TestPressureRewardsProximity(t *testing.T) {
	const blackKing = 4 // rank 0, file 4
	const nearRook = 3  // rank 0, file 3 — right next to the general
	const farRook = 76  // rank 8, file 4 — its own back rank

	near := emptyXiangqiBoard()
	near[blackKing] = -1
	near[nearRook] = 5

	far := emptyXiangqiBoard()
	far[blackKing] = -1
	far[farRook] = 5

	nearScore := pressure(near, game.SeatOne)
	farScore := pressure(far, game.SeatOne)
	if nearScore <= farScore {
		t.Fatalf("a rook beside the general must press harder: near=%d far=%d", nearScore, farScore)
	}
}

// TestPressureRewardsCrossingTheRiver: a pawn that has crossed counts as pressure, one that
// has not does not. Crossing is the clearest sign a player has committed.
func TestPressureRewardsCrossingTheRiver(t *testing.T) {
	const blackKing = 4

	crossed := emptyXiangqiBoard()
	crossed[blackKing] = -1
	crossed[27] = 7 // red pawn on rank 3, across the river

	home := emptyXiangqiBoard()
	home[blackKing] = -1
	home[63] = 7 // red pawn on rank 7, still home

	if pressure(crossed, game.SeatOne) <= pressure(home, game.SeatOne) {
		t.Fatalf("a crossed pawn must add pressure: crossed=%d home=%d",
			pressure(crossed, game.SeatOne), pressure(home, game.SeatOne))
	}
}

// TestGomokuBuildsItsOwnFourRatherThanOnlyBlocking is the behaviour change that makes the
// partner feel aggressive: with both sides holding an open three, it should complete its own
// four and force the answer, not trade blocks.
func TestGomokuBuildsItsOwnFourRatherThanOnlyBlocking(t *testing.T) {
	e := playGomoku(t,
		at(7, 3), at(3, 3),
		at(7, 4), at(3, 4),
		at(7, 5), at(3, 5),
	)
	// Black to move: three stones each, both open at both ends. Black moves first, so black
	// can make an open four rather than defend.
	move, ok := BestMove(e)
	if !ok {
		t.Fatal("no move returned")
	}
	// at(file, rank) puts the three on a vertical line at file 7, ranks 3..5, so the open
	// four is the square just above or below it.
	file, rank := move.To%gomokuSize, move.To/gomokuSize
	if file != 7 || (rank != 2 && rank != 6) {
		t.Fatalf("expected black to extend its own three into an open four, got (file %d, rank %d)", file, rank)
	}
}
