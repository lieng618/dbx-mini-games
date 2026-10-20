package app

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// profileFile is the persisted profile name inside the plugin data directory.
const profileFile = "profile.json"

// loadProfile reads the stored profile, falling back to defaults on any problem.
// A malformed profile is not worth failing the plugin over.
func loadProfile(dir string) (Profile, error) {
	if dir == "" {
		return Profile{Nickname: "棋友"}, nil
	}
	raw, err := os.ReadFile(filepath.Join(dir, profileFile))
	if err != nil {
		return Profile{Nickname: "棋友"}, nil
	}
	var p Profile
	if err := json.Unmarshal(raw, &p); err != nil {
		return Profile{Nickname: "棋友"}, nil
	}
	if p.Nickname == "" {
		p.Nickname = "棋友"
	}
	return p, nil
}

// saveProfile writes the profile atomically so a crash cannot truncate it.
func saveProfile(dir string, p Profile) error {
	if dir == "" {
		return nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(dir, profileFile+".tmp")
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, profileFile))
}

// randomID returns a stable-width random identifier for players, rooms, and tickets.
func randomID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		// A failing CSPRNG is fatal for identity; fall back to a time-based id so the
		// plugin degrades instead of panicking.
		return fmt.Sprintf("t%d", time.Now().UnixNano())
	}
	return fmt.Sprintf("%x", buf)
}

// localAddresses lists the machine's usable LAN addresses for manual joining, which is
// the fallback when mDNS is blocked.
//
// Only addresses another machine on the same network could actually reach are kept. A
// VPN or proxy client typically creates a tunnelled interface with a synthetic address
// (Clash uses 198.18.0.0/15, for example); advertising that address means a peer copies it
// and never connects.
// addressCandidate is one advertised address plus the reasons it might be the right one.
type addressCandidate struct {
	addr string
	// score orders the list: 0 is the address a neighbour on the same WiFi should use.
	score int
}

// outboundIPv4 reports the address the kernel would use to reach the internet.
//
// Dialing UDP sends no packets, so this is a free way to ask the routing table which local
// address is actually on the default route. That address is the best guess for "the network
// my colleagues are on": a machine with a corporate 10.x adapter and a 192.168.x WiFi
// adapter answers here with the WiFi one, because that is where its default route points.
func outboundIPv4() net.IP {
	conn, err := net.Dial("udp", "203.0.113.1:53") // TEST-NET-3
	if err != nil {
		return nil
	}
	defer conn.Close()
	if addr, ok := conn.LocalAddr().(*net.UDPAddr); ok {
		return addr.IP.To4()
	}
	return nil
}

// orderAddresses ranks candidates so the first entry is the one most likely to work for
// someone on the same WiFi. Addresses are never dropped: a peer on the corporate network
// still needs the 10.x one, and hiding it would strand them.
func orderAddresses(candidates []addressCandidate) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(candidates))
	for _, c := range candidates {
		if seen[c.addr] {
			continue
		}
		seen[c.addr] = true
		out = append(out, c.addr)
	}
	// Stable sort by score, preserving interface order within a tier.
	sort.SliceStable(out, func(i, j int) bool {
		return scoreOf(candidates, out[i]) < scoreOf(candidates, out[j])
	})
	return out
}

func scoreOf(candidates []addressCandidate, addr string) int {
	for _, c := range candidates {
		if c.addr == addr {
			return c.score
		}
	}
	return 9
}

// localAddresses lists the addresses a neighbour could dial, best first.
func localAddresses(port int) []string {
	preferred := outboundIPv4()
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}

	var candidates []addressCandidate
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		// A point-to-point interface is a tunnel. Its address is reachable from the other
		// end of the tunnel and nowhere else, which is exactly how a room ends up handing
		// out a 10.x address nobody on the WiFi can dial.
		tunnel := iface.Flags&net.FlagPointToPoint != 0
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			v4 := ipNet.IP.To4()
			if v4 == nil || !reachableOnLan(v4) {
				continue
			}
			score := 3
			switch {
			case tunnel:
				score = 6
			case preferred != nil && v4.Equal(preferred):
				score = 0
			case v4[0] == 192 && v4[1] == 168:
				score = 1
			case v4[0] == 172 && v4[1] >= 16 && v4[1] < 32:
				score = 2
			}
			candidates = append(candidates, addressCandidate{
				addr:  fmt.Sprintf("%s:%d", v4.String(), port),
				score: score,
			})
		}
	}
	return orderAddresses(candidates)
}

// lanBlocks are ranges that never identify a host reachable by a neighbour: loopback,
// link-local, the benchmarking range that proxy clients borrow for fake IPs, and the
// CGNAT range used inside tunnels.
var lanBlocks = []net.IPNet{
	{IP: net.IPv4(127, 0, 0, 0), Mask: net.CIDRMask(8, 32)},
	{IP: net.IPv4(169, 254, 0, 0), Mask: net.CIDRMask(16, 32)},
	{IP: net.IPv4(198, 18, 0, 0), Mask: net.CIDRMask(15, 32)},
	{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)},
	{IP: net.IPv4(0, 0, 0, 0), Mask: net.CIDRMask(8, 32)},
}

// reachableOnLan reports whether a peer on the same physical network could dial this
// address.
func reachableOnLan(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() {
		return false
	}
	for _, block := range lanBlocks {
		if block.Contains(ip) {
			return false
		}
	}
	return ip.IsPrivate()
}

// Clock is the host-authoritative match clock. The host alone decides a timeout; guests
// only render the countdown, so two machines with drifting clocks cannot disagree.
//
// Two limits can end a seat's game: a total budget for the whole match, and a per-move
// limit. Either is optional — a zero duration means that limit is not in play.
type Clock struct {
	mu        sync.Mutex
	remaining [2]time.Duration
	running   int // seat whose clock is running, or -1
	// since marks the start of the current turn, which is what the per-move limit measures.
	// consumed marks how far the budget has been deducted; the two cannot be the same field,
	// or deducting time would also reset the move timer.
	since    time.Time
	consumed time.Time
	budget   time.Duration
	perMove  time.Duration
}

// DefaultBudget is the total time each seat receives when the host does not choose one.
const DefaultBudget = 10 * time.Minute

func newClock(budget, perMove time.Duration) *Clock {
	return &Clock{
		remaining: [2]time.Duration{budget, budget},
		running:   -1,
		budget:    budget,
		perMove:   perMove,
	}
}

// reset gives both seats a fresh budget and starts seat zero's clock.
func (c *Clock) reset(now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.remaining = [2]time.Duration{c.budget, c.budget}
	c.running = 0
	c.since = now
	c.consumed = now
}

// switchTurn hands the clock to the other seat, and restarts the per-move limit.
func (c *Clock) switchTurn(now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.consumeLocked(now)
	if c.running < 0 || c.running >= len(c.remaining) {
		// An unstarted clock has no turn to hand over; adopt seat zero instead of
		// computing an out-of-range seat.
		c.running = 0
	} else {
		c.running = 1 - c.running
	}
	c.since = now
	c.consumed = now
}

// consumeLocked deducts elapsed time from the running seat.
//
// The index is bounds-checked: a clock that was never reset has running == -1, and an
// out-of-range value here would panic inside a snapshot rather than degrade.
func (c *Clock) consumeLocked(now time.Time) {
	if c.running < 0 || c.running >= len(c.remaining) || c.consumed.IsZero() {
		return
	}
	elapsed := now.Sub(c.consumed)
	// Advance the deduction cursor. Without this every call re-deducts the whole span since
	// the turn began, so the clock drains faster the more often anyone looks at it — a
	// client polling twice a second burned a ten-minute budget in seconds and then lost on
	// a timeout that never happened.
	c.consumed = now
	if elapsed <= 0 {
		return
	}
	// An unlimited budget is not decremented: subtracting from it would turn "no limit"
	// into "a very large limit" and eventually expire.
	if c.budget > 0 {
		c.remaining[c.running] -= elapsed
		if c.remaining[c.running] < 0 {
			c.remaining[c.running] = 0
		}
	}
}

// view reports the clock for a snapshot. TimedOut names the seat that has run out, if any.
func (c *Clock) view() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	c.consumeLocked(now)

	moveLeft := int64(-1)
	if c.perMove > 0 && c.running >= 0 && !c.since.IsZero() {
		moveLeft = int64((c.perMove - now.Sub(c.since)).Milliseconds())
		if moveLeft < 0 {
			moveLeft = 0
		}
	}
	return map[string]any{
		"remaining":     [2]int64{int64(c.remaining[0].Milliseconds()), int64(c.remaining[1].Milliseconds())},
		"running":       c.running,
		"budget":        int64(c.budget.Milliseconds()),
		"perMove":       int64(c.perMove.Milliseconds()),
		"moveRemaining": moveLeft,
	}
}

// TimeoutSeat reports the seat whose clock has expired, or -1. Either limit can expire.
func (c *Clock) TimeoutSeat() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	c.consumeLocked(now)
	if c.running < 0 || c.running >= len(c.remaining) {
		return -1
	}
	if c.budget > 0 && c.remaining[c.running] <= 0 {
		return c.running
	}
	if c.perMove > 0 && !c.since.IsZero() && now.Sub(c.since) >= c.perMove {
		return c.running
	}
	return -1
}
