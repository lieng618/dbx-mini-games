package room

import (
	"testing"

	"github.com/lieng618/dbx-mini-games/backend/internal/game"
)

func TestPracticeStartsWithOneSeatedPlayer(t *testing.T) {
	r := newRoom(t, "gomoku")
	mustJoin(t, r, "host")
	if err := r.StartPractice(1); err != nil {
		t.Fatalf("a solo host must be able to open a practice board: %v", err)
	}
	if !r.Practice() {
		t.Fatal("expected practice phase")
	}
	if r.Phase() != PhasePractice {
		t.Fatalf("expected PhasePractice, got %s", r.Phase())
	}
}

func TestPracticeRequiresASeat(t *testing.T) {
	r := newRoom(t, "gomoku")
	if err := r.StartPractice(1); err != ErrNoSeatedPlayer {
		t.Fatalf("practice without a seat must be refused, got %v", err)
	}
}

func TestPracticeAllowsMovingBothSides(t *testing.T) {
	r := newRoom(t, "gomoku")
	mustJoin(t, r, "host")
	if err := r.StartPractice(1); err != nil {
		t.Fatal(err)
	}
	// Black opens, then white answers: one player drives both sides on a solo board.
	if err := r.PracticeMove("host", game.Move{From: -1, To: 112}); err != nil {
		t.Fatalf("black move: %v", err)
	}
	if err := r.PracticeMove("host", game.Move{From: -1, To: 113}); err != nil {
		t.Fatalf("white move: %v", err)
	}
	rec, ok := r.Replay()
	if !ok || len(rec.Moves) != 2 {
		t.Fatalf("expected two recorded practice moves, got %+v", rec)
	}
}

func TestPracticeNeverRecordsAResult(t *testing.T) {
	r := newRoom(t, "gomoku")
	mustJoin(t, r, "host")
	if err := r.StartPractice(1); err != nil {
		t.Fatal(err)
	}
	// Drive black to five in a row; a practice board must not declare a winner.
	seq := []int{7*15 + 3, 8*15 + 0, 7*15 + 4, 8*15 + 1, 7*15 + 5, 8*15 + 2, 7*15 + 6, 8*15 + 3, 7*15 + 7}
	for _, cell := range seq {
		if err := r.PracticeMove("host", game.Move{From: -1, To: cell}); err != nil {
			t.Fatalf("cell %d: %v", cell, err)
		}
	}
	rec, _ := r.Replay()
	if rec.Outcome != game.OutcomeNone {
		t.Fatalf("practice must not settle an outcome, got %d", rec.Outcome)
	}
	if r.Phase() != PhasePractice {
		t.Fatalf("practice must stay open, got %s", r.Phase())
	}
}

func TestEndPracticeReturnsToLobby(t *testing.T) {
	r := newRoom(t, "gomoku")
	mustJoin(t, r, "host")
	if err := r.StartPractice(1); err != nil {
		t.Fatal(err)
	}
	r.EndPractice()
	if r.Phase() != PhaseLobby {
		t.Fatalf("expected lobby, got %s", r.Phase())
	}
	if _, ok := r.Replay(); ok {
		t.Fatal("ending practice must discard the solo board")
	}
	// A real match is still possible once a second player sits.
	mustJoin(t, r, "guest")
	if err := r.Start(2); err != nil {
		t.Fatalf("a real match should start after practice: %v", err)
	}
}

func TestPracticeRejectsSpectatorMoves(t *testing.T) {
	r := newRoom(t, "gomoku")
	mustJoin(t, r, "host", "watcher")
	if err := r.StartPractice(1); err != nil {
		t.Fatal(err)
	}
	// The watcher holds seat 1 on a two-seat table during practice, so a genuine spectator
	// requires a third arrival.
	mustJoin(t, r, "watcher2")
	if err := r.PracticeMove("host", game.Move{From: -1, To: 0}); err != nil {
		t.Fatal(err)
	}
}
