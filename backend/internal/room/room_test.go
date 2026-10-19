package room

import (
	"testing"

	"github.com/jzj2621899857/dbx-board-games/backend/internal/game"
)

func newRoom(t *testing.T, gameName string) *Room {
	t.Helper()
	r, err := New(Options{ID: "r1", Name: "测试房", Game: gameName, HostID: "host"})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// seatOf returns the seat index of a member, or -1.
func seatOf(r *Room, id string) int {
	for _, m := range r.Members() {
		if m.ID == id {
			return m.Seat
		}
	}
	return -1
}

func TestArrivalOrderSeating(t *testing.T) {
	r := newRoom(t, "gomoku")
	if _, err := r.Join("host", "房主"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Join("a", "甲"); err != nil {
		t.Fatal(err)
	}
	// Third arrival finds both seats taken and becomes a spectator.
	if _, err := r.Join("b", "乙"); err != nil {
		t.Fatal(err)
	}

	if got := seatOf(r, "host"); got != 0 {
		t.Fatalf("first arrival must sit at seat 0, got %d", got)
	}
	if got := seatOf(r, "a"); got != 1 {
		t.Fatalf("second arrival must sit at seat 1, got %d", got)
	}
	if got := seatOf(r, "b"); got != -1 {
		t.Fatalf("third arrival must spectate, got seat %d", got)
	}
	if r.Count() != 3 {
		t.Fatalf("expected 3 members, got %d", r.Count())
	}
}

func TestRoomCapacity(t *testing.T) {
	r := newRoom(t, "gomoku")
	for i := 0; i < MaxParticipants; i++ {
		if _, err := r.Join(string(rune('a'+i)), "p"); err != nil {
			t.Fatalf("join %d: %v", i, err)
		}
	}
	if _, err := r.Join("overflow", "p"); err != ErrRoomFull {
		t.Fatalf("expected ErrRoomFull, got %v", err)
	}
}

func TestDuplicateJoinRejected(t *testing.T) {
	r := newRoom(t, "gomoku")
	if _, err := r.Join("host", "房主"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Join("host", "房主"); err != ErrAlreadyJoined {
		t.Fatalf("expected ErrAlreadyJoined, got %v", err)
	}
}

func TestMidMatchArrivalSpectates(t *testing.T) {
	r := newRoom(t, "gomoku")
	mustJoin(t, r, "host", "a")
	if err := r.Start(1); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Join("late", "丙"); err != nil {
		t.Fatal(err)
	}
	if got := seatOf(r, "late"); got != -1 {
		t.Fatalf("a mid-match arrival must spectate, got seat %d", got)
	}
}

func mustJoin(t *testing.T, r *Room, ids ...string) {
	t.Helper()
	for _, id := range ids {
		if _, err := r.Join(id, id); err != nil {
			t.Fatalf("join %s: %v", id, err)
		}
	}
}

func TestStartRequiresBothSeats(t *testing.T) {
	r := newRoom(t, "gomoku")
	mustJoin(t, r, "host")
	if err := r.Start(1); err != ErrNoSeat {
		t.Fatalf("expected ErrNoSeat with one player, got %v", err)
	}
	mustJoin(t, r, "a")
	if err := r.Start(1); err != nil {
		t.Fatalf("expected start to succeed: %v", err)
	}
	if r.Phase() != PhasePlaying {
		t.Fatalf("expected playing phase, got %s", r.Phase())
	}
}

func TestTurnEnforcementAndSpectatorCannotMove(t *testing.T) {
	r := newRoom(t, "gomoku")
	mustJoin(t, r, "host", "a", "watcher")
	if err := r.Start(1); err != nil {
		t.Fatal(err)
	}

	// Seat 1 cannot move first.
	if err := r.Move("a", game.Move{From: -1, To: 0}, 2); err != ErrNotYourTurn {
		t.Fatalf("expected ErrNotYourTurn for seat 1 opening, got %v", err)
	}
	// A spectator cannot move at all.
	if err := r.Move("watcher", game.Move{From: -1, To: 0}, 2); err != ErrNotSeated {
		t.Fatalf("expected ErrNotSeated for a spectator, got %v", err)
	}
	// Seat 0 may open.
	if err := r.Move("host", game.Move{From: -1, To: 112}, 2); err != nil {
		t.Fatalf("seat 0 should open: %v", err)
	}
}

func TestSeatFrozenDuringMatch(t *testing.T) {
	r := newRoom(t, "gomoku")
	mustJoin(t, r, "host", "a", "b")
	if err := r.Start(1); err != nil {
		t.Fatal(err)
	}
	if err := r.ReleaseSeat("host"); err != ErrMatchInProgress {
		t.Fatalf("expected seats frozen during a match, got %v", err)
	}
	if err := r.TakeSeat("b", 0); err != ErrMatchInProgress {
		t.Fatalf("expected seating frozen during a match, got %v", err)
	}
}

func TestSeatRotationOnVacancyOnly(t *testing.T) {
	r := newRoom(t, "gomoku")
	mustJoin(t, r, "host", "a", "b")
	if err := r.Start(1); err != nil {
		t.Fatal(err)
	}
	// Play a short match to a finish.
	if err := r.Move("host", game.Move{From: -1, To: 112}, 2); err != nil {
		t.Fatal(err)
	}
	if err := r.Resign("a"); err != nil {
		t.Fatal(err)
	}
	if r.Phase() != PhaseFinished {
		t.Fatalf("expected finished phase, got %s", r.Phase())
	}

	// A concluded match must NOT reshuffle the seats.
	if seatOf(r, "host") != 0 || seatOf(r, "a") != 1 {
		t.Fatal("seats must persist across a finished match")
	}
	if seatOf(r, "b") != -1 {
		t.Fatal("the spectator must not be seated by a match ending")
	}

	// Rematch keeps the same pair.
	if err := r.Rematch(); err != nil {
		t.Fatal(err)
	}
	if err := r.Start(10); err != nil {
		t.Fatalf("rematch should start with the same pair: %v", err)
	}
	if seatOf(r, "host") != 0 || seatOf(r, "a") != 1 {
		t.Fatal("rematch must not change seating")
	}
}

func TestVacancyLetsSpectatorSit(t *testing.T) {
	r := newRoom(t, "gomoku")
	mustJoin(t, r, "host", "a", "b")
	if err := r.ReleaseSeat("a"); err != nil {
		t.Fatal(err)
	}
	if seatOf(r, "a") != -1 {
		t.Fatal("releasing a seat must return the member to the spectator pool")
	}
	if err := r.TakeSeat("b", 1); err != nil {
		t.Fatalf("spectator should take the freed seat: %v", err)
	}
	if seatOf(r, "b") != 1 {
		t.Fatal("spectator must now hold seat 1")
	}
}

func TestLeavingPlayerForfeitsMatch(t *testing.T) {
	r := newRoom(t, "gomoku")
	mustJoin(t, r, "host", "a")
	if err := r.Start(1); err != nil {
		t.Fatal(err)
	}
	if err := r.Move("host", game.Move{From: -1, To: 112}, 2); err != nil {
		t.Fatal(err)
	}
	if err := r.Leave("a"); err != nil {
		t.Fatal(err)
	}
	if r.Phase() != PhaseFinished {
		t.Fatalf("expected the match to end on abandonment, got %s", r.Phase())
	}
	rec, ok := r.Replay()
	if !ok {
		t.Fatal("expected a record after forfeit")
	}
	if rec.Outcome != game.OutcomeSeatOneWin {
		t.Fatalf("absent player must lose, got outcome %d", rec.Outcome)
	}
	if rec.Reason != "forfeit" {
		t.Fatalf("expected forfeit reason, got %q", rec.Reason)
	}
}

func TestHostLeavingEndsRoom(t *testing.T) {
	r := newRoom(t, "gomoku")
	mustJoin(t, r, "host", "a")
	if err := r.Leave("host"); err != nil {
		t.Fatal(err)
	}
	if r.Phase() != PhaseFinished {
		t.Fatalf("expected the room to end when the host leaves, got %s", r.Phase())
	}
}

func TestUndoNeedsOpponentConsent(t *testing.T) {
	r := newRoom(t, "gomoku")
	mustJoin(t, r, "host", "a")
	if err := r.Start(1); err != nil {
		t.Fatal(err)
	}
	if err := r.Move("host", game.Move{From: -1, To: 112}, 2); err != nil {
		t.Fatal(err)
	}

	if err := r.RequestUndo("host"); err != nil {
		t.Fatal(err)
	}
	// The proposer cannot approve their own request.
	if err := r.ConsentUndo("host"); err == nil {
		t.Fatal("the proposer must not be able to consent to their own undo")
	}
	if err := r.ConsentUndo("a"); err != nil {
		t.Fatalf("the opponent's consent should apply the undo: %v", err)
	}
	rec, ok := r.Replay()
	if !ok {
		t.Fatal("expected a record")
	}
	if len(rec.Moves) != 0 {
		t.Fatalf("undo must remove the move, got %d moves", len(rec.Moves))
	}
}

func TestUndoWithoutRequestRejected(t *testing.T) {
	r := newRoom(t, "gomoku")
	mustJoin(t, r, "host", "a")
	if err := r.Start(1); err != nil {
		t.Fatal(err)
	}
	if err := r.ConsentUndo("a"); err == nil {
		t.Fatal("consent without a pending request must be rejected")
	}
}

func TestResignAwardsOpponent(t *testing.T) {
	r := newRoom(t, "gomoku")
	mustJoin(t, r, "host", "a")
	if err := r.Start(1); err != nil {
		t.Fatal(err)
	}
	if err := r.Resign("host"); err != nil {
		t.Fatal(err)
	}
	rec, _ := r.Replay()
	if rec.Outcome != game.OutcomeSeatTwoWin {
		t.Fatalf("seat 0 resigning must give the win to seat 1, got %d", rec.Outcome)
	}
}

func TestPasswordGate(t *testing.T) {
	r, err := New(Options{ID: "r", Name: "n", Game: "gomoku", HostID: "host", Password: "s3cret"})
	if err != nil {
		t.Fatal(err)
	}
	if !r.Locked() {
		t.Fatal("a room with a password must report locked")
	}
	if r.CheckPassword("wrong") {
		t.Fatal("a wrong password must not unlock")
	}
	if !r.CheckPassword("s3cret") {
		t.Fatal("the right password must unlock")
	}
}

func TestReplayPersistsConcludedMatch(t *testing.T) {
	r := newRoom(t, "gomoku")
	mustJoin(t, r, "host", "a")
	if err := r.Start(1); err != nil {
		t.Fatal(err)
	}
	// Black completes five in a row while white fills elsewhere.
	seq := []struct {
		id   string
		cell int
	}{
		{"host", 7*15 + 3}, {"a", 8*15 + 0},
		{"host", 7*15 + 4}, {"a", 8*15 + 1},
		{"host", 7*15 + 5}, {"a", 8*15 + 2},
		{"host", 7*15 + 6}, {"a", 8*15 + 3},
		{"host", 7*15 + 7},
	}
	for _, step := range seq {
		if err := r.Move(step.id, game.Move{From: -1, To: step.cell}, 2); err != nil {
			t.Fatalf("move %s at %d: %v", step.id, step.cell, err)
		}
	}
	if r.Phase() != PhaseFinished {
		t.Fatalf("expected finished, got %s", r.Phase())
	}
	rec, ok := r.Replay()
	if !ok {
		t.Fatal("expected a record")
	}
	if len(rec.Moves) != len(seq) {
		t.Fatalf("expected %d recorded moves, got %d", len(seq), len(rec.Moves))
	}
	if rec.Outcome != game.OutcomeSeatOneWin {
		t.Fatalf("expected seat one win, got %d", rec.Outcome)
	}
}

func TestMembersReflectJoinOrder(t *testing.T) {
	r := newRoom(t, "gomoku")
	mustJoin(t, r, "host", "a", "b")
	members := r.Members()
	want := []string{"host", "a", "b"}
	for i, id := range want {
		if members[i].ID != id {
			t.Fatalf("position %d should be %s, got %s", i, id, members[i].ID)
		}
	}
}
