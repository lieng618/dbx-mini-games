package discovery

import (
	"encoding/hex"
	"net"
	"testing"

	"github.com/grandcat/zeroconf"
)

const validKey = "9f2a1c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9"

// entry builds a ServiceEntry the way the library does: through its constructor, then
// filling the fields a browse result would carry.
func entry(instance string, port int, txt []string, ip string) *zeroconf.ServiceEntry {
	e := zeroconf.NewServiceEntry(instance, ServiceType, localDomain)
	e.Port = port
	e.Text = txt
	if ip != "" {
		e.AddrIPv4 = []net.IP{net.ParseIP(ip)}
	}
	return e
}

func TestParseAcceptsCompleteRecord(t *testing.T) {
	e := entry("测试房", 51123, []string{
		"id=room-1",
		"key=" + validKey,
		"game=xiangqi",
		"players=3",
		"seats=2",
		"locked=true",
		"proto=1",
	}, "192.168.1.20")

	info, ok := parse(e)
	if !ok {
		t.Fatal("a complete record must parse")
	}
	if info.RoomID != "room-1" || info.Game != "xiangqi" {
		t.Fatalf("unexpected identity: %+v", info)
	}
	if info.Address != "192.168.1.20:51123" {
		t.Fatalf("unexpected address %q", info.Address)
	}
	if info.Players != 3 || info.Seats != 2 || !info.Locked {
		t.Fatalf("unexpected counters: %+v", info)
	}
	if info.Name != "测试房" {
		t.Fatalf("unexpected name %q", info.Name)
	}
}

func TestParseRejectsMissingHostKey(t *testing.T) {
	e := entry("room", 5000, []string{"id=room-1", "game=gomoku"}, "192.168.1.20")
	if _, ok := parse(e); ok {
		t.Fatal("a record without a host key is unusable and must be rejected")
	}
}

func TestParseRejectsBadKeyHex(t *testing.T) {
	e := entry("room", 5000, []string{"id=room-1", "game=gomoku", "key=zzzz"}, "192.168.1.20")
	if _, ok := parse(e); ok {
		t.Fatal("a non-hex key must be rejected")
	}
}

func TestParseRejectsMissingAddress(t *testing.T) {
	e := entry("room", 5000, []string{"id=room-1", "game=gomoku", "key=" + validKey}, "")
	if _, ok := parse(e); ok {
		t.Fatal("a record with no address must be rejected")
	}
}

func TestParseRejectsBadPort(t *testing.T) {
	e := entry("room", 0, []string{"id=room-1", "game=gomoku", "key=" + validKey}, "192.168.1.20")
	if _, ok := parse(e); ok {
		t.Fatal("port 0 must be rejected")
	}
}

func TestParseDefaultsProtocol(t *testing.T) {
	e := entry("room", 5000, []string{"id=room-1", "game=gomoku", "key=" + validKey}, "10.0.0.5")
	info, ok := parse(e)
	if !ok {
		t.Fatal("expected a parse")
	}
	if info.Protocol != 1 {
		t.Fatalf("a record without proto should default to 1, got %d", info.Protocol)
	}
}

func TestParseAcceptsIPv6Only(t *testing.T) {
	e := entry("room", 5000, []string{"id=room-1", "game=gomoku", "key=" + validKey}, "")
	e.AddrIPv6 = []net.IP{net.ParseIP("fe80::1")}
	info, ok := parse(e)
	if !ok {
		t.Fatal("an IPv6-only record must parse")
	}
	if info.Address == "" {
		t.Fatal("expected a bracketed IPv6 address")
	}
}

func TestHostKeyIs32Bytes(t *testing.T) {
	raw, err := hex.DecodeString(validKey)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) != 32 {
		t.Fatalf("an Ed25519 public key must be 32 bytes, got %d", len(raw))
	}
}

func TestAtoiAndItoa(t *testing.T) {
	for _, n := range []int{0, 1, 9, 10, 255, 65535} {
		if got := atoi(itoa(n)); got != n {
			t.Fatalf("round trip failed for %d: got %d", n, got)
		}
	}
	if atoi("12x") != 0 {
		t.Fatal("non-numeric text must parse to zero")
	}
}
