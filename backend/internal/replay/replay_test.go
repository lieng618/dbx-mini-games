package replay

import (
	"strings"
	"testing"

	"github.com/southernMortals/dbx-board-games/backend/internal/game"
	"github.com/southernMortals/dbx-board-games/backend/internal/game/gomoku"
	"github.com/southernMortals/dbx-board-games/backend/internal/game/xiangqi"
)

func xq(rank, file int) int { return rank*9 + file }

// openingCannonRecord is a legal three-ply xiangqi opening: red centre cannon, black
// horse, red other cannon to the centre file.
func openingCannonRecord() Record {
	return Record{
		Game: "xiangqi",
		Moves: []game.Move{
			{From: xq(7, 1), To: xq(7, 4)},
			{From: xq(0, 1), To: xq(2, 2)},
			{From: xq(7, 7), To: xq(7, 6)},
		},
	}
}

func TestNewRejectsIllegalRecord(t *testing.T) {
	bad := Record{
		Game:  "xiangqi",
		Moves: []game.Move{{From: xq(9, 0), To: xq(0, 0)}},
	}
	if _, err := New(bad); err == nil {
		t.Fatal("an impossible rook move must be rejected")
	}
}

func TestNewRejectsUnknownGame(t *testing.T) {
	if _, err := New(Record{Game: "draughts"}); err == nil {
		t.Fatal("unknown game must be rejected")
	}
}

func TestCursorStartsAtOpening(t *testing.T) {
	r, err := New(openingCannonRecord())
	if err != nil {
		t.Fatal(err)
	}
	if r.Cursor() != 0 {
		t.Fatalf("cursor must start at 0, got %d", r.Cursor())
	}
	if r.Total() != 3 {
		t.Fatalf("expected 3 moves, got %d", r.Total())
	}
	st := r.State()
	if st.Seat != game.SeatOne {
		t.Fatalf("red moves first, got seat %d", st.Seat)
	}
	if st.LastMove != nil {
		t.Fatal("opening position has no last move")
	}
}

func TestStepForwardAndBack(t *testing.T) {
	r, err := New(openingCannonRecord())
	if err != nil {
		t.Fatal(err)
	}
	if !r.Next() {
		t.Fatal("first step must advance")
	}
	if r.Cursor() != 1 {
		t.Fatalf("expected cursor 1, got %d", r.Cursor())
	}
	if r.State().LastMove == nil {
		t.Fatal("cursor 1 must report a last move")
	}
	if !r.Next() || !r.Next() {
		t.Fatal("expected to reach the end")
	}
	if r.Next() {
		t.Fatal("stepping past the end must report false")
	}
	if !r.Prev() {
		t.Fatal("expected to step back from 3 to 2")
	}
	if r.Cursor() != 2 {
		t.Fatalf("expected cursor 2, got %d", r.Cursor())
	}
	if !r.Prev() {
		t.Fatal("expected to step back from 2 to 1")
	}
	if !r.Prev() {
		t.Fatal("expected to step back from 1 to 0")
	}
	if r.Prev() {
		t.Fatal("stepping before the start must report false")
	}
	if r.Cursor() != 0 {
		t.Fatalf("expected cursor 0, got %d", r.Cursor())
	}
}

func TestSeekClampsAndRestoresPosition(t *testing.T) {
	r, err := New(openingCannonRecord())
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Seek(99); err != nil {
		t.Fatal(err)
	}
	if r.Cursor() != 3 {
		t.Fatalf("seek past end must clamp to 3, got %d", r.Cursor())
	}
	atEnd := r.State().Cells
	if err := r.Seek(-5); err != nil {
		t.Fatal(err)
	}
	if r.Cursor() != 0 {
		t.Fatalf("seek before start must clamp to 0, got %d", r.Cursor())
	}
	if err := r.Seek(3); err != nil {
		t.Fatal(err)
	}
	for i, v := range r.State().Cells {
		if atEnd[i] != v {
			t.Fatalf("seeking back to the end must reproduce the same position at %d", i)
		}
	}
}

func TestSeekIsDeterministic(t *testing.T) {
	r, err := New(openingCannonRecord())
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Seek(2); err != nil {
		t.Fatal(err)
	}
	first := r.State().Cells
	if err := r.Seek(0); err != nil {
		t.Fatal(err)
	}
	if err := r.Seek(2); err != nil {
		t.Fatal(err)
	}
	second := r.State().Cells
	for i := range first {
		if first[i] != second[i] {
			t.Fatalf("position at ply 2 must be stable, differs at %d", i)
		}
	}
}

func TestRecordCopyIsIsolated(t *testing.T) {
	r, err := New(openingCannonRecord())
	if err != nil {
		t.Fatal(err)
	}
	rec := r.Record()
	rec.Moves[0] = game.Move{From: 0, To: 1}
	if r.Record().Moves[0] == (game.Move{From: 0, To: 1}) {
		t.Fatal("Record must return a copy")
	}
}

func TestXiangqiNotationOpeningPlays(t *testing.T) {
	r, err := New(openingCannonRecord())
	if err != nil {
		t.Fatal(err)
	}
	notes, err := r.Notation()
	if err != nil {
		t.Fatal(err)
	}
	// Red numbers files from its own right, so the cannon on grid file 1 is 炮八.
	// It slides to the centre file, which is 五: 炮八平五.
	if notes[0] != "炮八平五" {
		t.Fatalf("expected 炮八平五, got %q", notes[0])
	}
	if len(notes) != 3 {
		t.Fatalf("expected 3 notation entries, got %d", len(notes))
	}
}

func TestXiangqiNotationForwardMove(t *testing.T) {
	// Red pawn from (6,0) advances one rank to (5,0).
	cells := make([]int8, 90)
	cells[xq(6, 0)] = xiangqi.Pawn
	got := XiangqiNotation(cells, game.SeatOne, game.Move{From: xq(6, 0), To: xq(5, 0)})
	if got != "兵九进一" {
		t.Fatalf("expected 兵九进一, got %q", got)
	}
}

func TestXiangqiNotationBackwardMove(t *testing.T) {
	cells := make([]int8, 90)
	cells[xq(3, 0)] = xiangqi.Rook
	got := XiangqiNotation(cells, game.SeatOne, game.Move{From: xq(3, 0), To: xq(5, 0)})
	if got != "车九退二" {
		t.Fatalf("expected 车九退二, got %q", got)
	}
}

func TestXiangqiNotationFrontBackDisambiguation(t *testing.T) {
	// Two red rooks on the same file: the one nearer black is 前.
	cells := make([]int8, 90)
	cells[xq(2, 0)] = xiangqi.Rook
	cells[xq(6, 0)] = xiangqi.Rook
	front := XiangqiNotation(cells, game.SeatOne, game.Move{From: xq(2, 0), To: xq(2, 1)})
	if !strings.HasPrefix(front, "前车") {
		t.Fatalf("nearer rook must be labelled 前车, got %q", front)
	}
	back := XiangqiNotation(cells, game.SeatOne, game.Move{From: xq(6, 0), To: xq(6, 1)})
	if !strings.HasPrefix(back, "后车") {
		t.Fatalf("farther rook must be labelled 后车, got %q", back)
	}
}

func TestGomokuNotationCoordinates(t *testing.T) {
	// Top-left corner of the grid is A15.
	if got := GomokuNotation(game.Move{To: 0}); got != "A15" {
		t.Fatalf("expected A15, got %q", got)
	}
	// Bottom-right corner is O1.
	if got := GomokuNotation(game.Move{To: 224}); got != "O1" {
		t.Fatalf("expected O1, got %q", got)
	}
	// Centre point H8.
	if got := GomokuNotation(game.Move{To: 7*15 + 7}); got != "H8" {
		t.Fatalf("expected H8, got %q", got)
	}
}

func TestGomokuRecordReplay(t *testing.T) {
	rec := Record{
		Game: "gomoku",
		Moves: []game.Move{
			{From: -1, To: 0},
			{From: -1, To: 1},
			{From: -1, To: 15},
		},
	}
	r, err := New(rec)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Seek(1); err != nil {
		t.Fatal(err)
	}
	if r.State().Cells[15] != gomoku.Empty {
		t.Fatal("ply 1 must not include the third stone")
	}
	if err := r.End(); err != nil {
		t.Fatal(err)
	}
	if r.State().Cells[15] != gomoku.Black {
		t.Fatal("the final position must include the third stone")
	}
}

func TestReplayOfFinishedMatchReportsResult(t *testing.T) {
	// Build a real gomoku win through the engine, then replay it.
	e := gomoku.New()
	moves := []game.Move{}
	seq := []int{7*15 + 3, 8*15 + 0, 7*15 + 4, 8*15 + 1, 7*15 + 5, 8*15 + 2, 7*15 + 6, 8*15 + 3, 7*15 + 7}
	for _, c := range seq {
		m := game.Move{From: -1, To: c}
		if err := e.Apply(m); err != nil {
			t.Fatalf("apply %d: %v", c, err)
		}
		moves = append(moves, m)
	}
	rec := Record{Game: "gomoku", Moves: moves, Outcome: e.Result().Outcome, Reason: e.Result().Reason}
	r, err := New(rec)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.End(); err != nil {
		t.Fatal(err)
	}
	st := r.State()
	if !st.Result.Finished || st.Result.Outcome != game.OutcomeSeatOneWin {
		t.Fatalf("expected a finished seat-one win, got %+v", st.Result)
	}
}
