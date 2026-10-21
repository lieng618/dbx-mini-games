package app

import (
	"testing"

	"github.com/southernMortals/dbx-board-games/backend/internal/game"
	"github.com/southernMortals/dbx-board-games/backend/internal/room"
)

// TestFinishedMatchKeepsResultInSnapshot guards the win screen.
//
// The phase moves to finished inside the very move that ends the match, and the board view
// only used to emit a result while the phase was playing or practice. So the snapshot a
// finishing move returned carried no result, and the banner that keys off it never
// appeared — while the same result was still reachable by dragging the replay cursor.
func TestFinishedMatchKeepsResultInSnapshot(t *testing.T) {
	a := newTestApp(t)
	if _, err := a.Call("room.create", map[string]any{
		"name": "结算",
		"game": "gomoku",
	}); err != nil {
		t.Fatalf("create: %v", err)
	}

	host := a.localID
	if _, err := a.room.Join("guest-1", "对手"); err != nil {
		t.Fatalf("seat the opponent: %v", err)
	}
	if err := a.room.Start(1); err != nil {
		t.Fatalf("start: %v", err)
	}

	// Seat zero completes a row along the top edge while seat one wastes moves far away.
	script := []struct {
		id string
		to int
	}{
		{host, 0}, {"guest-1", 100},
		{host, 1}, {"guest-1", 101},
		{host, 2}, {"guest-1", 102},
		{host, 3}, {"guest-1", 103},
		{host, 4},
	}
	for _, mv := range script {
		if err := a.room.Move(mv.id, game.Move{From: -1, To: mv.to}, 1); err != nil {
			t.Fatalf("move to %d: %v", mv.to, err)
		}
	}
	if a.room.Phase() != room.PhaseFinished {
		t.Fatalf("expected a finished match, got %s", a.room.Phase())
	}

	view := a.snapshot()
	res, ok := view["result"].(map[string]any)
	if !ok {
		t.Fatalf("a finished match must still report its result, got %#v", view["result"])
	}
	if res["finished"] != true {
		t.Fatalf("result must be marked finished: %#v", res)
	}

	// The winning line drives the presentation, so it has to survive the same transition.
	if line, ok := view["winLine"]; !ok || line == nil {
		t.Fatalf("a won match must carry its winning line, got %#v", view["winLine"])
	}
}
