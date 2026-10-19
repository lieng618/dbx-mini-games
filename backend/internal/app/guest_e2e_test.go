package app

import (
	"testing"
	"time"
)

// TestGuestCanActuallyPlay is the acceptance test for guest authority: a second instance
// joins over the real TLS transport and must be able to sit down and move. Before the
// guest request channel existed, every one of these actions failed with "not hosting a
// room" because a guest holds no room of its own.
func TestGuestCanActuallyPlay(t *testing.T) {
	host := newTestApp(t)
	if _, err := host.Call("room.create", map[string]any{
		"name": "访客验收",
		"game": "gomoku",
	}); err != nil {
		t.Fatalf("host create: %v", err)
	}

	view := host.snapshot()
	roomID, _ := view["roomId"].(string)
	hostKey, _ := view["hostKey"].(string)
	port, _ := view["port"].(int)
	if roomID == "" || hostKey == "" || port == 0 {
		t.Fatalf("host snapshot incomplete: %v", view)
	}

	guest := newTestApp(t)
	if _, err := guest.Call("room.join", map[string]any{
		"address": "127.0.0.1:" + itoa(port),
		"roomId":  roomID,
		"hostKey": hostKey,
	}); err != nil {
		t.Fatalf("guest join: %v", err)
	}
	defer func() {
		_, _ = guest.Call("room.leave", nil)
		_, _ = host.Call("room.leave", nil)
	}()

	// Wait for the host to seat the guest by arrival order.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if host.room.Count() >= 2 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	seats := host.room.Seats()
	if seats[1] == "" {
		t.Fatalf("guest was not seated: %v", seats)
	}

	// The host starts the match, which requires both seats filled.
	if _, err := host.Call("room.start", nil); err != nil {
		t.Fatalf("host start: %v", err)
	}
	if host.room.Phase() != "playing" {
		t.Fatalf("expected playing, got %s", host.room.Phase())
	}

	// The guest moves first? No: seat zero (the host) moves first. The host opens.
	if _, err := host.Call("game.move", map[string]any{"from": -1.0, "to": 112.0}); err != nil {
		t.Fatalf("host move: %v", err)
	}

	// Now the guest must be able to answer. This is the action that used to fail.
	if _, err := guest.Call("game.move", map[string]any{"from": -1.0, "to": 113.0}); err != nil {
		t.Fatalf("guest move was rejected: %v", err)
	}

	// The guest's move must be visible in the host's authoritative board.
	rec, ok := host.room.Replay()
	if !ok {
		t.Fatal("host has no record")
	}
	if len(rec.Moves) != 2 {
		t.Fatalf("expected two moves on the host board, got %d", len(rec.Moves))
	}
	if rec.Moves[1].To != 113 {
		t.Fatalf("the host board must contain the guest's move, got %+v", rec.Moves[1])
	}

	// A guest asking to act as another member must not be possible: the id comes from the
	// authenticated connection.
	if _, err := guest.Call("game.move", map[string]any{"from": -1.0, "to": 114.0}); err == nil {
		t.Fatal("it must not be the guest's turn, so this move has to be refused")
	}
}
