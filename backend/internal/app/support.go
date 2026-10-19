package app

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
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
func localAddresses(port int) []string {
	var out []string
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return out
	}
	for _, addr := range addrs {
		ipNet, ok := addr.(*net.IPNet)
		if !ok || ipNet.IP.IsLoopback() {
			continue
		}
		if v4 := ipNet.IP.To4(); v4 != nil {
			out = append(out, fmt.Sprintf("%s:%d", v4.String(), port))
		}
	}
	return out
}

// Clock is the host-authoritative match clock. The host alone decides a timeout; guests
// only render the countdown, so two machines with drifting clocks cannot disagree.
type Clock struct {
	mu       sync.Mutex
	remaining [2]time.Duration
	running  int // seat whose clock is running, or -1
	since    time.Time
	budget   time.Duration
}

// DefaultBudget is the fixed time each seat receives per match.
const DefaultBudget = 10 * time.Minute

func newClock() *Clock {
	return &Clock{remaining: [2]time.Duration{DefaultBudget, DefaultBudget}, running: -1, budget: DefaultBudget}
}

// reset gives both seats a fresh budget and starts seat zero's clock.
func (c *Clock) reset(now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.remaining = [2]time.Duration{c.budget, c.budget}
	c.running = 0
	c.since = now
}

// switchTurn hands the clock to the other seat.
func (c *Clock) switchTurn(now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.consumeLocked(now)
	c.running = 1 - c.running
	c.since = now
}

// consumeLocked deducts elapsed time from the running seat.
func (c *Clock) consumeLocked(now time.Time) {
	if c.running < 0 || c.since.IsZero() {
		return
	}
	elapsed := now.Sub(c.since)
	c.remaining[c.running] -= elapsed
	if c.remaining[c.running] < 0 {
		c.remaining[c.running] = 0
	}
}

// view reports the clock for a snapshot. TimedOut names the seat that has run out, if any.
func (c *Clock) view() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.consumeLocked(time.Now())
	return map[string]any{
		"remaining": [2]int64{int64(c.remaining[0].Milliseconds()), int64(c.remaining[1].Milliseconds())},
		"running":   c.running,
		"budget":    int64(c.budget.Milliseconds()),
	}
}

// TimeoutSeat reports the seat whose clock has expired, or -1.
func (c *Clock) TimeoutSeat() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.consumeLocked(time.Now())
	for seat, left := range c.remaining {
		if left <= 0 {
			return seat
		}
	}
	return -1
}
