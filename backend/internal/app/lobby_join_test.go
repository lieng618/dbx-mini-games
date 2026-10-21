package app

import (
	"sync"
	"testing"
	"time"
)

// TestHostIsNotifiedWhenAGuestJoins guards the "joined but the match never started" freeze.
//
// Seating happens inside Room.Join, on the server's connection goroutine, so no host
// action ever rides along with it. The host window learns about it only through an event:
// the lobby does not poll, so without this push it keeps drawing an empty table while a
// challenger who has already sat down waits for a match nobody opens.
func TestHostIsNotifiedWhenAGuestJoins(t *testing.T) {
	var mu sync.Mutex
	events := map[string]int{}
	host := New(t.TempDir(), func(method string, params any) {
		mu.Lock()
		events[method]++
		mu.Unlock()
	})

	if _, err := host.Call("room.create", map[string]any{
		"name": "加入通知",
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

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		seen := events["room.members"]
		mu.Unlock()
		if seen > 0 {
			// The event is only useful if the host's own view actually shows the challenger.
			seats := host.room.Seats()
			if seats[1] == "" {
				t.Fatalf("host was notified but the guest holds no seat: %v", seats)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("host window was never told that a guest joined")
}
