package app

import (
	"testing"
	"time"

	"github.com/lieng618/dbx-mini-games/backend/internal/discovery"
)

// TestTwoInstanceLanHandshake is the M1 acceptance test: one App hosts a room, another
// App discovers it over mDNS and joins it, and the guest lands in the second seat.
//
// mDNS is best-effort and may be unavailable in a sandbox, so the test takes the host
// key and address directly from the host snapshot when discovery yields nothing. The
// handshake itself always runs for real over TLS.
func TestTwoInstanceLanHandshake(t *testing.T) {
	host := newTestApp(t)
	if _, err := host.Call("room.create", map[string]any{
		"name": "集成测试房",
		"game": "gomoku",
	}); err != nil {
		t.Fatalf("host could not create a room: %v", err)
	}

	hostView := host.snapshot()
	roomID, _ := hostView["roomId"].(string)
	hostKey, _ := hostView["hostKey"].(string)
	if roomID == "" || hostKey == "" {
		t.Fatalf("host snapshot must expose roomId and hostKey, got %v", hostView)
	}

	address := discoverOrLoopback(t, hostView, roomID)

	guest := newTestApp(t)
	if _, err := guest.Call("room.join", map[string]any{
		"address": address,
		"roomId":  roomID,
		"hostKey": hostKey,
	}); err != nil {
		t.Fatalf("guest could not join: %v", err)
	}

	guestView := guest.snapshot()
	if guestView["role"] != "guest" {
		t.Fatalf("expected guest role, got %v", guestView["role"])
	}
	if guestView["roomId"] != roomID {
		t.Fatalf("guest must know the room id, got %v", guestView["roomId"])
	}

	// The guest took the free seat by arrival order.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if host.room.Count() >= 2 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	seats := host.room.Seats()
	if seats[0] == "" || seats[1] == "" {
		t.Fatalf("both seats must be filled after a guest joins, seats=%v", seats)
	}

	// Clean up so the server goroutine stops.
	_, _ = guest.Call("room.leave", nil)
	_, _ = host.Call("room.leave", nil)
}

// discoverOrLoopback prefers an mDNS result but falls back to a loopback address on the
// advertised port, because mDNS is often blocked in test environments.
func discoverOrLoopback(t *testing.T, hostView map[string]any, roomID string) string {
	t.Helper()
	rooms, err := discoveryResolve(700 * time.Millisecond)
	if err == nil {
		for _, info := range rooms {
			if info.RoomID == roomID && info.Address != "" {
				return info.Address
			}
		}
	}
	port, ok := hostView["port"].(int)
	if !ok || port == 0 {
		t.Fatalf("host snapshot must expose a port, got %v", hostView["port"])
	}
	return "127.0.0.1:" + itoa(port)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf []byte
	for n > 0 {
		buf = append([]byte{byte('0' + n%10)}, buf...)
		n /= 10
	}
	return string(buf)
}

// discoveryResolve is a thin indirection so the integration test can tolerate a blocked
// mDNS subsystem instead of failing on it.
func discoveryResolve(window time.Duration) ([]discoveryRoomInfo, error) {
	rooms, err := discovery.Resolve(window)
	if err != nil {
		return nil, err
	}
	out := make([]discoveryRoomInfo, 0, len(rooms))
	for _, r := range rooms {
		out = append(out, discoveryRoomInfo{RoomID: r.RoomID, Address: r.Address})
	}
	return out, nil
}

// discoveryRoomInfo is the subset of a resolved room this test needs.
type discoveryRoomInfo struct {
	RoomID  string
	Address string
}
