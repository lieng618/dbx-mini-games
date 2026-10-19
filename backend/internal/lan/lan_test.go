package lan

import (
	"crypto/ed25519"
	"errors"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/southernMortals/dbx-board-games/backend/internal/room"
)

// newHostedRoom starts a Room and its Server on loopback.
func newHostedRoom(t *testing.T, gameName, password string) (*room.Room, *Server) {
	t.Helper()
	r, err := room.New(room.Options{ID: "room-1", Name: "测试房", Game: gameName, HostID: "host", Password: password})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.Join("host", "房主"); err != nil {
		t.Fatal(err)
	}
	srv, err := NewServer(r)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = srv.Close() })
	return r, srv
}

func addrOf(srv *Server) string {
	return "127.0.0.1:" + itoa(srv.Port())
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

func TestHandshakeAndWelcome(t *testing.T) {
	r, srv := newHostedRoom(t, "gomoku", "")
	client, err := Join(JoinOptions{
		Address: addrOf(srv),
		HostKey: srv.PublicKey(),
		RoomID:  r.ID(),
		Profile: Profile{ID: "guest", Nickname: "客人"},
	})
	if err != nil {
		t.Fatalf("join failed: %v", err)
	}
	defer client.Close()

	if client.Ticket() == "" {
		t.Fatal("a successful join must return a reconnect ticket")
	}
	if client.Snapshot["roomId"] != "room-1" {
		t.Fatalf("snapshot must carry the room id, got %v", client.Snapshot["roomId"])
	}
	if client.Snapshot["selfId"] != "guest" {
		t.Fatalf("snapshot must name the receiver, got %v", client.Snapshot["selfId"])
	}

	// The guest took the second seat by arrival order.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if r.Count() >= 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	seats := r.Seats()
	if seats[1] != "guest" {
		t.Fatalf("the guest must take the free seat, seats=%v", seats)
	}
}

func TestWrongHostKeyIsRefused(t *testing.T) {
	r, srv := newHostedRoom(t, "gomoku", "")
	_, wrong, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = Join(JoinOptions{
		Address: addrOf(srv),
		HostKey: wrong.Public().(ed25519.PublicKey),
		RoomID:  r.ID(),
		Profile: Profile{ID: "guest", Nickname: "客人"},
	})
	if err == nil {
		t.Fatal("a mismatched host key must refuse the connection")
	}
}

func TestWrongRoomIDIsRefused(t *testing.T) {
	_, srv := newHostedRoom(t, "gomoku", "")
	_, err := Join(JoinOptions{
		Address: addrOf(srv),
		HostKey: srv.PublicKey(),
		RoomID:  "some-other-room",
		Profile: Profile{ID: "guest", Nickname: "客人"},
	})
	if err != nil && !errors.Is(err, ErrBadChallenge) {
		t.Fatalf("expected ErrBadChallenge for a foreign room, got %v", err)
	}
	if err == nil {
		t.Fatal("a different room id must not be accepted")
	}
}

func TestPasswordGateOverWire(t *testing.T) {
	r, srv := newHostedRoom(t, "gomoku", "s3cret")
	_, err := Join(JoinOptions{
		Address:  addrOf(srv),
		HostKey:  srv.PublicKey(),
		RoomID:   r.ID(),
		Profile:  Profile{ID: "guest", Nickname: "客人"},
		Password: "nope",
	})
	if !errors.Is(err, ErrBadPassword) {
		t.Fatalf("expected ErrBadPassword, got %v", err)
	}

	ok, err := Join(JoinOptions{
		Address:  addrOf(srv),
		HostKey:  srv.PublicKey(),
		RoomID:   r.ID(),
		Profile:  Profile{ID: "guest2", Nickname: "客人2"},
		Password: "s3cret",
	})
	if err != nil {
		t.Fatalf("the right password must be accepted: %v", err)
	}
	defer ok.Close()
}

func TestReconnectWithTicket(t *testing.T) {
	r, srv := newHostedRoom(t, "gomoku", "")
	first, err := Join(JoinOptions{
		Address: addrOf(srv),
		HostKey: srv.PublicKey(),
		RoomID:  r.ID(),
		Profile: Profile{ID: "guest", Nickname: "客人"},
	})
	if err != nil {
		t.Fatal(err)
	}
	ticket := first.Ticket()
	_ = first.Close()

	// Wait for the server to notice the drop.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if r.Count() == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	second, err := Join(JoinOptions{
		Address: addrOf(srv),
		HostKey: srv.PublicKey(),
		RoomID:  r.ID(),
		Profile: Profile{ID: "guest", Nickname: "客人"},
		Ticket:  ticket,
	})
	if err != nil {
		t.Fatalf("reconnect with a ticket must succeed: %v", err)
	}
	defer second.Close()
	if second.Ticket() == "" {
		t.Fatal("reconnect must issue a fresh ticket")
	}
}

func TestConcurrentJoins(t *testing.T) {
	r, srv := newHostedRoom(t, "gomoku", "")
	var wg sync.WaitGroup
	errs := make(chan error, 5)
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			c, err := Join(JoinOptions{
				Address: addrOf(srv),
				HostKey: srv.PublicKey(),
				RoomID:  r.ID(),
				Profile: Profile{ID: "guest" + string(rune('a'+n)), Nickname: "g"},
			})
			if err != nil {
				errs <- err
				return
			}
			errs <- nil
			_ = c
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent join failed: %v", err)
		}
	}
}

func TestFrameLimitRejectsOversize(t *testing.T) {
	payload := make([]byte, MaxFrameBytes+1)
	conn, peer := netPipe()
	defer conn.Close()
	defer peer.Close()
	if err := writeFrame(conn, payload); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("expected ErrFrameTooLarge, got %v", err)
	}
}

// netPipe returns a connected in-memory pair for frame-level tests.
func netPipe() (net.Conn, net.Conn) {
	return net.Pipe()
}
