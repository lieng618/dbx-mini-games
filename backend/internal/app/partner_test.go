package app

import (
	"testing"

	"github.com/southernMortals/dbx-board-games/backend/internal/game"
)

// TestSnapshotBuildersAgreeOnRoomFields guards a contract that is easy to break silently.
//
// There are three snapshot builders — snapshot(), snapshotForMember() and snapshotLocked()
// — and each lists the room fields by hand. Adding a field to two of them produces a client
// that sees it on some code paths and not others: the partner seat was missing from
// room.snapshot, so the UI only learned about the partner after the first action.
func TestSnapshotBuildersAgreeOnRoomFields(t *testing.T) {
	a := newTestApp(t)
	if _, err := a.Call("room.create", map[string]any{"name": "契约", "game": "xiangqi"}); err != nil {
		t.Fatalf("create room: %v", err)
	}

	// Room-level keys every builder must carry. Board keys (cells, turnSeat, result) are
	// layered on separately and are not part of this contract.
	required := []string{"role", "game", "phase", "seats", "members", "aiSeat", "lowMotion"}

	builders := map[string]map[string]any{
		"snapshot":          a.snapshot(),
		"snapshotLocked":    a.snapshotLocked(),
		"snapshotForMember": a.snapshotForMember(a.localID),
	}

	for name, view := range builders {
		for _, key := range required {
			if _, ok := view[key]; !ok {
				t.Errorf("%s is missing %q", name, key)
			}
		}
	}
}

// TestPartnerSeatLifecycle pins the meaning of the field: it is not a general "player two"
// slot, it exists only while a partner is actually sitting in.
func TestPartnerSeatLifecycle(t *testing.T) {
	a := newTestApp(t)
	if _, err := a.Call("room.create", map[string]any{"name": "陪练", "game": "xiangqi"}); err != nil {
		t.Fatalf("create room: %v", err)
	}

	if seat := a.room.AISeat(); seat != -1 {
		t.Fatalf("a fresh lobby must report no partner, got %d", seat)
	}

	if _, err := a.Call("room.ai.start", nil); err != nil {
		t.Fatalf("start partner: %v", err)
	}
	if seat := a.room.AISeat(); seat != 1 {
		t.Fatalf("expected the partner on seat 1, got %d", seat)
	}

	// Leaving the practice board must clear it, or the lobby would keep the partner seated.
	if _, err := a.Call("room.practice.end", nil); err != nil {
		t.Fatalf("end practice: %v", err)
	}
	if seat := a.room.AISeat(); seat != -1 {
		t.Fatalf("expected the partner seat cleared on leaving practice, got %d", seat)
	}
}

// TestPartnerMoveIsAppliedAndTurnReturns proves the round trip: the player's move and the
// partner's answer each land as their own move, which is what lets each one animate.
func TestPartnerMoveIsAppliedAndTurnReturns(t *testing.T) {
	a := newTestApp(t)
	if _, err := a.Call("room.create", map[string]any{"name": "陪练", "game": "xiangqi"}); err != nil {
		t.Fatalf("create room: %v", err)
	}
	if _, err := a.Call("room.ai.start", nil); err != nil {
		t.Fatalf("start partner: %v", err)
	}

	// Red pawn forward: a legal opening move for the human on seat 0.
	if _, err := a.Call("game.move", map[string]any{"from": float64(54), "to": float64(45)}); err != nil {
		t.Fatalf("human move: %v", err)
	}
	if got := recordedMoves(t, a); len(got) != 1 {
		t.Fatalf("expected one recorded move, got %d", len(got))
	}

	if _, err := a.Call("room.ai.move", nil); err != nil {
		t.Fatalf("partner move: %v", err)
	}
	moves := recordedMoves(t, a)
	if len(moves) != 2 {
		t.Fatalf("expected the partner to answer, got %d moves", len(moves))
	}
	engine := a.room.EngineForThinking()
	if engine == nil {
		t.Fatal("expected a live position")
	}
	if engine.Turn() != game.SeatOne {
		t.Fatalf("expected the turn back with the player (seat one), got seat %d", engine.Turn())
	}
}

// TestPlayerCannotMoveForThePartner: with a partner seated the board stops being a two-sided
// sandbox, otherwise the player can simply play both sides.
func TestPlayerCannotMoveForThePartner(t *testing.T) {
	a := newTestApp(t)
	if _, err := a.Call("room.create", map[string]any{"name": "陪练", "game": "xiangqi"}); err != nil {
		t.Fatalf("create room: %v", err)
	}
	if _, err := a.Call("room.ai.start", nil); err != nil {
		t.Fatalf("start partner: %v", err)
	}
	if _, err := a.Call("game.move", map[string]any{"from": float64(54), "to": float64(45)}); err != nil {
		t.Fatalf("human move: %v", err)
	}
	// The partner holds the turn now; a human move must be refused.
	if _, err := a.Call("game.move", map[string]any{"from": float64(27), "to": float64(36)}); err == nil {
		t.Fatal("expected the player to be refused while the partner holds the turn")
	}
}

// TestPartnerAnswersGomokuToo: the partner must work on both games, not just the one it was
// written against first.
func TestPartnerAnswersGomokuToo(t *testing.T) {
	a := newTestApp(t)
	if _, err := a.Call("room.create", map[string]any{"name": "五子", "game": "gomoku"}); err != nil {
		t.Fatalf("create room: %v", err)
	}
	if _, err := a.Call("room.ai.start", nil); err != nil {
		t.Fatalf("start partner: %v", err)
	}
	if _, err := a.Call("game.move", map[string]any{"to": float64(7*15 + 7)}); err != nil {
		t.Fatalf("human placement: %v", err)
	}
	if _, err := a.Call("room.ai.move", nil); err != nil {
		t.Fatalf("partner placement: %v", err)
	}
	if got := recordedMoves(t, a); len(got) != 2 {
		t.Fatalf("expected two placements, got %d", len(got))
	}
}

func recordedMoves(t *testing.T, a *App) []game.Move {
	t.Helper()
	rec, ok := a.room.Replay()
	if !ok {
		return nil
	}
	return rec.Moves
}
