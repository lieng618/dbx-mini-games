package discovery

import (
	"encoding/hex"
	"encoding/json"
	"net"
	"strings"
	"testing"
	"unicode/utf8"

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

// TestRoomInfoWireNames pins the JSON keys the UI reads. The Go field names are not the
// contract: the join list looks up roomId/address/hostKey, and a struct without tags
// silently produces RoomID/Address instead, which renders a blank row and breaks joining.
func TestRoomInfoWireNames(t *testing.T) {
	raw, err := json.Marshal(RoomInfo{
		RoomID: "r1", Name: "棋室", Game: "xiangqi",
		HostKey: "abc", Address: "192.168.1.5:5000",
		Players: 2, Seats: 2, Locked: false, Protocol: 1,
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"roomId", "name", "game", "hostKey", "address", "players", "seats", "locked", "protocol"} {
		if _, ok := got[key]; !ok {
			t.Errorf("wire form is missing %q (got %s)", key, raw)
		}
	}
}

// TestParsePrefersTXTNameOverInstance covers the join list showing a room id instead of a
// name. The mDNS instance has to stay unique, so it carries the id; the human name is
// advertised in TXT and must win when both are present.
func TestParsePrefersTXTNameOverInstance(t *testing.T) {
	e := entry("room-1", 51123, []string{
		"id=room-1",
		"name=老张的棋桌",
		"key=" + validKey,
		"game=xiangqi",
	}, "192.168.1.20")

	info, ok := parse(e)
	if !ok {
		t.Fatal("a record carrying a name must parse")
	}
	if info.Name != "老张的棋桌" {
		t.Fatalf("expected the advertised name, got %q", info.Name)
	}
}

// TestParseFallsBackToInstanceWhenNameMissing keeps rooms advertised by older builds
// joinable: they carry no name field, and the instance is all the resolver has.
func TestParseFallsBackToInstanceWhenNameMissing(t *testing.T) {
	e := entry("房间甲", 51123, []string{
		"id=room-1",
		"key=" + validKey,
		"game=xiangqi",
	}, "192.168.1.20")

	info, ok := parse(e)
	if !ok {
		t.Fatal("a record without a name must still parse")
	}
	if info.Name != "房间甲" {
		t.Fatalf("expected the instance fallback, got %q", info.Name)
	}
}

// TestClipTXTKeepsRecordLegal guards the registration: an over-long TXT string makes the
// whole advertisement fail, which would drop the room off the network entirely.
func TestClipTXTKeepsRecordLegal(t *testing.T) {
	long := strings.Repeat("棋", 200)
	clipped := clipTXT(long)
	if len(clipped) > maxTXTValue {
		t.Fatalf("clipped value is %d bytes, over the %d limit", len(clipped), maxTXTValue)
	}
	if !utf8.ValidString(clipped) {
		t.Fatal("clipping cut a multi-byte character in half")
	}
	if got := clipTXT("短名字"); got != "短名字" {
		t.Fatalf("a short name must pass through untouched, got %q", got)
	}
}

// TestUnescapeTXTDecodesUTF8 covers the shape the DNS library actually hands back: every
// non-ASCII byte arrives as \DDD. Left undecoded, a Chinese room name reaches the join list
// as "\232\128\129..." — corruption, not a name.
func TestUnescapeTXTDecodesUTF8(t *testing.T) {
	escaped := `\232\128\129\229\188\160\231\154\132\230\163\139\230\161\140`
	if got := unescapeTXT(escaped); got != "老张的棋桌" {
		t.Fatalf("expected 老张的棋桌, got %q", got)
	}
	if got := unescapeTXT("my room"); got != "my room" {
		t.Fatalf("plain ascii must pass through, got %q", got)
	}
	if got := unescapeTXT(`a\\b`); got != `a\b` {
		t.Fatalf("an escaped backslash must not swallow the next byte, got %q", got)
	}
}

// TestParseDecodesEscapedRoomName is the end-to-end shape of the same bug: a record whose
// name field is escaped must still surface as the readable name.
func TestParseDecodesEscapedRoomName(t *testing.T) {
	e := entry("room-1", 51123, []string{
		"id=room-1",
		`name=\232\128\129\229\188\160\231\154\132\230\163\139\230\161\140`,
		"key=" + validKey,
		"game=xiangqi",
	}, "192.168.1.20")

	info, ok := parse(e)
	if !ok {
		t.Fatal("a record with an escaped name must parse")
	}
	if info.Name != "老张的棋桌" {
		t.Fatalf("expected the decoded name, got %q", info.Name)
	}
}
