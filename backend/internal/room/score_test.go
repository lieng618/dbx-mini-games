package room

import (
	"testing"

	"github.com/lieng618/dbx-mini-games/backend/internal/game"
)

func TestTrackedScorePersistsAcrossRematchAndResetsOnSeatChange(t *testing.T) {
	r, err := New(Options{
		ID: "score-room", Name: "计分房", Game: "gomoku",
		HostID: "host", HostSeat: 0, TrackScore: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	mustJoin(t, r, "host", "a")

	if score := r.Scoreboard(); !score.Tracked || score.Wins != [SeatCount]int{} {
		t.Fatalf("initial score = %#v", score)
	}

	startAndPlay := func(winner string) {
		t.Helper()
		if err := r.Start(1); err != nil {
			t.Fatal(err)
		}
		steps := []struct {
			id   string
			cell int
		}{
			{"host", 7*15 + 3}, {"a", 8*15 + 0},
			{"host", 7*15 + 4}, {"a", 8*15 + 1},
			{"host", 7*15 + 5}, {"a", 8*15 + 2},
			{"host", 7*15 + 6}, {"a", 8*15 + 3},
			{"host", 7*15 + 7},
		}
		if winner == "a" {
			steps = []struct {
				id   string
				cell int
			}{
				{"host", 0}, {"a", 100},
				{"host", 10}, {"a", 101},
				{"host", 20}, {"a", 102},
				{"host", 30}, {"a", 103},
				{"host", 40}, {"a", 104},
			}
		}
		for index, step := range steps {
			if err := r.Move(step.id, game.Move{From: -1, To: step.cell}, int64(index+2)); err != nil {
				t.Fatalf("move %d: %v", index, err)
			}
		}
		if r.Phase() != PhaseFinished {
			t.Fatalf("phase = %s, want finished", r.Phase())
		}
	}

	startAndPlay("host")
	if got := r.Scoreboard().Wins; got != [SeatCount]int{1, 0} {
		t.Fatalf("score after first match = %v", got)
	}

	if err := r.Rematch(); err != nil {
		t.Fatal(err)
	}
	if got := r.Scoreboard().Wins; got != [SeatCount]int{1, 0} {
		t.Fatalf("rematch cleared the series: %v", got)
	}

	startAndPlay("a")
	if got := r.Scoreboard().Wins; got != [SeatCount]int{1, 1} {
		t.Fatalf("score after second match = %v", got)
	}

	if err := r.ReleaseSeat("host"); err != nil {
		t.Fatal(err)
	}
	if got := r.Scoreboard().Wins; got != [SeatCount]int{} {
		t.Fatalf("seat change did not clear the score: %v", got)
	}
}

func TestUntrackedRoomNeverRecordsScore(t *testing.T) {
	r := newRoom(t, "gomoku")
	mustJoin(t, r, "host", "a")
	if err := r.Start(1); err != nil {
		t.Fatal(err)
	}
	if err := r.Resign("host"); err != nil {
		t.Fatal(err)
	}
	if score := r.Scoreboard(); score.Tracked || score.Wins != [SeatCount]int{} {
		t.Fatalf("untracked room score = %#v", score)
	}
}

func TestSwapSeatsMovesScoresWithPlayersAndOnlyWorksBeforeStart(t *testing.T) {
	r, err := New(Options{
		ID: "swap-room", Name: "换位房", Game: "gomoku",
		HostID: "host", HostSeat: 0, TrackScore: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	mustJoin(t, r, "host")
	if err := r.RequestSwap("host"); err != ErrNotEnoughPlayers {
		t.Fatalf("a lone player swapped seats: %v", err)
	}
	mustJoin(t, r, "a")
	if err := r.Start(1); err != nil {
		t.Fatal(err)
	}
	if err := r.Resign("a"); err != nil {
		t.Fatal(err)
	}
	if got := r.Scoreboard().Wins; got != [SeatCount]int{1, 0} {
		t.Fatalf("score before swap = %v", got)
	}
	if err := r.Rematch(); err != nil {
		t.Fatal(err)
	}
	if err := r.RequestSwap("host"); err != nil {
		t.Fatal(err)
	}
	if got := r.Seats(); got != (Seats{"host", "a"}) {
		t.Fatalf("request swapped seats without consent: %v", got)
	}
	if err := r.ConsentSwap("host"); err != ErrSwapNotOpponent {
		t.Fatalf("requester answered their own swap: %v", err)
	}
	if err := r.DeclineSwap("a"); err != nil {
		t.Fatal(err)
	}
	if _, seat := r.SwapRequest(); seat != -1 {
		t.Fatal("declined request remained pending")
	}
	if err := r.RequestSwap("host"); err != nil {
		t.Fatal(err)
	}
	if err := r.ConsentSwap("a"); err != nil {
		t.Fatal(err)
	}
	if got := r.Seats(); got != (Seats{"a", "host"}) {
		t.Fatalf("seats after swap = %v", got)
	}
	if got := r.Scoreboard().Wins; got != [SeatCount]int{0, 1} {
		t.Fatalf("score did not move with its player: %v", got)
	}
	if err := r.RequestSwap("a"); err != nil {
		t.Fatal(err)
	}
	if err := r.ConsentSwap("host"); err != nil {
		t.Fatal(err)
	}
	if err := r.Start(2); err != nil {
		t.Fatal(err)
	}
	if err := r.RequestSwap("host"); err != ErrMatchInProgress {
		t.Fatalf("swap during a match = %v", err)
	}
}
