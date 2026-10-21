// Package discovery advertises and resolves hosted rooms over mDNS, so participants on
// the same network see each other without typing an address.
//
// The advertised record carries the host's Ed25519 public key. That is what makes the
// self-signed TLS certificate verifiable: the key arrives out of band from the
// certificate itself, over the same local network the user already trusts.
package discovery

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/grandcat/zeroconf"
)

// ServiceType is the DNS-SD service this plugin advertises.
const ServiceType = "_dbxbg._tcp"

// localDomain is the mDNS domain.
const localDomain = "local."

// TXT record keys.
const (
	txtRoomID   = "id"
	txtName     = "name"
	txtHostKey  = "key"
	txtGame     = "game"
	txtPlayers  = "players"
	txtSeats    = "seats"
	txtLocked   = "locked"
	txtProtocol = "proto"
)

// maxTXTValue is the longest value one mDNS TXT string can carry. A longer entry makes the
// whole registration fail, so a long room name is clipped rather than allowed to drop the
// room off the network.
const maxTXTValue = 200

// ErrAdvertise wraps a registration failure.
var ErrAdvertise = errors.New("could not advertise the room")

// RoomInfo is what a resolver learns about a room.
type RoomInfo struct {
	// These tags are part of the wire contract with the UI, which reads roomId/address and
	// friends by their lower-camel names. Without them Go emits the Go field names and every
	// field on the join list is undefined — the row renders blank and joining fails with
	// "an address is required".
	RoomID   string `json:"roomId"`
	Name     string `json:"name"`
	Game     string `json:"game"`
	HostKey  string `json:"hostKey"`
	Address  string `json:"address"`
	Players  int    `json:"players"`
	Seats    int    `json:"seats"`
	Locked   bool   `json:"locked"`
	Protocol int    `json:"protocol"`
}

// Advertisement is a live mDNS registration. Close it when the room ends.
type Advertisement struct {
	server *zeroconf.Server
}

// Advertise registers the room on the local network.
//
// instanceID must be unique and stable for the room; the room id works. If mDNS is
// unavailable on this machine the caller still has the port, so a manual address remains
// a valid fallback.
func Advertise(instanceID, roomName, game string, port int, hostKey []byte, players, seats int, locked bool) (*Advertisement, error) {
	if port < 1 || port > 65535 {
		return nil, fmt.Errorf("%w: bad port %d", ErrAdvertise, port)
	}
	txt := []string{
		txtRoomID + "=" + instanceID,
		// The mDNS instance name has to stay unique, so it carries the room id; the human
		// name rides in TXT instead. Without this the join list shows the id, which is the
		// one thing a player cannot recognise.
		txtName + "=" + clipTXT(roomName),
		txtHostKey + "=" + hex.EncodeToString(hostKey),
		txtGame + "=" + game,
		txtPlayers + "=" + itoa(players),
		txtSeats + "=" + itoa(seats),
		txtLocked + "=" + boolText(locked),
		txtProtocol + "=" + itoa(1),
	}
	server, err := zeroconf.Register(instanceID, ServiceType, localDomain, port, txt, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrAdvertise, err)
	}
	return &Advertisement{server: server}, nil
}

// Close withdraws the advertisement.
func (a *Advertisement) Close() {
	if a != nil && a.server != nil {
		a.server.Shutdown()
	}
}

// Resolve scans the local network for rooms, stopping at the deadline or when enough
// results arrive. A scan always costs the full window because mDNS is best-effort.
func Resolve(window time.Duration) ([]RoomInfo, error) {
	resolver, err := zeroconf.NewResolver(nil)
	if err != nil {
		return nil, err
	}
	entries := make(chan *zeroconf.ServiceEntry, 32)
	// Browse dereferences its context, so a nil context panics. Bound the browse by the
	// caller's window and always cancel it on the way out.
	ctx, cancel := context.WithTimeout(context.Background(), window)
	defer cancel()
	if err := resolver.Browse(ctx, ServiceType, localDomain, entries); err != nil {
		return nil, err
	}

	var (
		mu    sync.Mutex
		found []RoomInfo
		// seen maps a room id to its index in found, so repeats replace rather than append.
		seen = map[string]int{}
	)
	done := time.After(window)
	for {
		select {
		case entry, ok := <-entries:
			if !ok {
				return dedupe(found), nil
			}
			info, valid := parse(entry)
			if !valid {
				continue
			}
			mu.Lock()
			// mDNS answers arrive per interface, so one host can be reported once per
			// network adapter with a different address each time. A room is identified by
			// its id, not by the address it happened to be announced from.
			if index, already := seen[info.RoomID]; already {
				if preferred(info, found[index]) {
					found[index] = info
				}
			} else {
				seen[info.RoomID] = len(found)
				found = append(found, info)
			}
			mu.Unlock()
		case <-done:
			return dedupe(found), nil
		}
	}
}

// preferred reports whether candidate is a better address for the same room than current.
//
// A routable private address beats anything else, because that is the one a neighbouring
// machine can actually dial.
func preferred(candidate, current RoomInfo) bool {
	return addressRank(candidate.Address) > addressRank(current.Address)
}

// addressRank scores how dialable an address is.
func addressRank(address string) int {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return 0
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return 0
	}
	v4 := ip.To4()
	if v4 == nil {
		return 1
	}
	switch {
	case v4[0] == 192 && v4[1] == 168:
		return 4
	case v4[0] == 10:
		return 4
	case v4[0] == 172 && v4[1] >= 16 && v4[1] <= 31:
		return 4
	case v4[0] == 198 && v4[1] == 18:
		return 1
	case v4[0] == 169 && v4[1] == 254:
		return 1
	case v4[0] == 127:
		return 2
	default:
		return 3
	}
}

func dedupe(in []RoomInfo) []RoomInfo {
	out := make([]RoomInfo, len(in))
	copy(out, in)
	return out
}

// parse converts a DNS-SD entry into a RoomInfo, rejecting malformed records. A record
// missing the host key is unusable, because the TLS certificate could not be verified.
func parse(entry *zeroconf.ServiceEntry) (RoomInfo, bool) {
	if entry == nil || entry.Port < 1 || entry.Port > 65535 {
		return RoomInfo{}, false
	}
	values := map[string]string{}
	for _, field := range entry.Text {
		for i := 0; i < len(field); i++ {
			if field[i] == '=' {
				values[field[:i]] = field[i+1:]
				break
			}
		}
	}
	info := RoomInfo{
		RoomID:  values[txtRoomID],
		Name:    roomNameFrom(values, entry),
		Game:    values[txtGame],
		HostKey: values[txtHostKey],
		Players: atoi(values[txtPlayers]),
		Seats:   atoi(values[txtSeats]),
		Locked:  values[txtLocked] == "true",
	}
	info.Protocol = atoi(values[txtProtocol])
	if info.Protocol == 0 {
		info.Protocol = 1
	}
	if info.RoomID == "" || info.HostKey == "" || info.Game == "" {
		return RoomInfo{}, false
	}
	if _, err := hex.DecodeString(info.HostKey); err != nil {
		return RoomInfo{}, false
	}
	if len(entry.AddrIPv4) > 0 {
		info.Address = fmt.Sprintf("%s:%d", entry.AddrIPv4[0].String(), entry.Port)
	} else if len(entry.AddrIPv6) > 0 {
		info.Address = fmt.Sprintf("[%s]:%d", entry.AddrIPv6[0].String(), entry.Port)
	} else {
		return RoomInfo{}, false
	}
	return info, true
}

// roomNameFrom picks the name a player should see. A newer room advertises it in TXT
// because the mDNS instance has to stay a unique id; a room advertised by an older build
// has no such field, so its instance — the id — is the best available fallback.
func roomNameFrom(values map[string]string, entry *zeroconf.ServiceEntry) string {
	if name := values[txtName]; name != "" {
		return unescapeTXT(name)
	}
	return unescapeTXT(entry.Instance)
}

// unescapeTXT reverses the escaping the DNS library applies when it unpacks a TXT string:
// every byte outside printable ASCII comes back as \DDD (three decimal digits). A Chinese
// room name is entirely outside that range, so without this the join list shows
// "\232\128\129..." instead of 老 — which is worse than showing an id, because it looks
// like corruption rather than a missing name.
func unescapeTXT(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] != '\\' || i+1 >= len(s) {
			out = append(out, s[i])
			continue
		}
		// \DDD — one byte written as three decimal digits.
		if i+3 < len(s) && isDecimal(s[i+1]) && isDecimal(s[i+2]) && isDecimal(s[i+3]) {
			out = append(out, byte((s[i+1]-'0')*100+(s[i+2]-'0')*10+(s[i+3]-'0')))
			i += 3
			continue
		}
		// \c — an escaped backslash or quote.
		out = append(out, s[i+1])
		i++
	}
	return string(out)
}

func isDecimal(b byte) bool { return b >= '0' && b <= '9' }

// clipTXT shortens a value so the TXT entry stays within the mDNS string limit. The cut
// lands on a rune boundary: a half-written UTF-8 sequence would make the record malformed
// rather than merely shorter, and a malformed record drops the room entirely.
func clipTXT(s string) string {
	if len(s) <= maxTXTValue {
		return s
	}
	cut := maxTXTValue
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf []byte
	for n > 0 {
		buf = append([]byte{byte('0' + n%10)}, buf...)
		n /= 10
	}
	if neg {
		return "-" + string(buf)
	}
	return string(buf)
}

func atoi(s string) int {
	n := 0
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0
		}
		n = n*10 + int(s[i]-'0')
	}
	return n
}

func boolText(b bool) string {
	if b {
		return "true"
	}
	return "false"
}
