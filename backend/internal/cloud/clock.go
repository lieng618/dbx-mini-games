package cloud

import (
	"sync"
	"time"
)

// matchClock owns the server-side time budget for one room. The room rule machine never
// reads the wall clock; this type is the only place where elapsed time can end a match.
type matchClock struct {
	mu sync.Mutex

	remaining         [2]time.Duration
	running           int
	since             time.Time
	consumed          time.Time
	budget            time.Duration
	perMove           time.Duration
	paused            bool
	pausedMoveElapsed time.Duration
}

func newMatchClock(budget, perMove time.Duration) *matchClock {
	return &matchClock{
		remaining: [2]time.Duration{budget, budget},
		running:   -1,
		budget:    budget,
		perMove:   perMove,
	}
}

func (c *matchClock) start(now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.remaining = [2]time.Duration{c.budget, c.budget}
	c.running = 0
	c.since = now
	c.consumed = now
	c.paused = false
	c.pausedMoveElapsed = 0
}

func (c *matchClock) switchTurn(now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.consumeLocked(now)
	if c.running < 0 {
		c.running = 0
	} else {
		c.running = 1 - c.running
	}
	c.since = now
	c.consumed = now
	c.paused = false
	c.pausedMoveElapsed = 0
}

func (c *matchClock) stop(now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.consumeLocked(now)
	c.running = -1
	c.paused = false
	c.pausedMoveElapsed = 0
}

func (c *matchClock) pause(now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.consumeLocked(now)
	if c.running < 0 {
		return
	}
	if c.perMove > 0 && !c.since.IsZero() {
		c.pausedMoveElapsed = now.Sub(c.since)
		if c.pausedMoveElapsed < 0 {
			c.pausedMoveElapsed = 0
		}
	}
	c.running = -1
	c.consumed = time.Time{}
	c.paused = true
}

func (c *matchClock) resume(now time.Time, seat int, freshMoveTimer bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.paused {
		return
	}
	if seat < 0 || seat >= len(c.remaining) {
		seat = 0
	}
	c.running = seat
	c.consumed = now
	if freshMoveTimer {
		c.since = now
	} else {
		c.since = now.Add(-c.pausedMoveElapsed)
	}
	c.paused = false
	c.pausedMoveElapsed = 0
}

func (c *matchClock) consumeLocked(now time.Time) {
	if c.running < 0 || c.running > 1 || c.consumed.IsZero() {
		return
	}
	elapsed := now.Sub(c.consumed)
	c.consumed = now
	if elapsed <= 0 || c.budget <= 0 {
		return
	}
	c.remaining[c.running] -= elapsed
	if c.remaining[c.running] < 0 {
		c.remaining[c.running] = 0
	}
}

func (c *matchClock) snapshot(now time.Time) map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.consumeLocked(now)

	moveRemaining := int64(-1)
	if c.perMove > 0 {
		elapsed := c.pausedMoveElapsed
		active := !c.paused && c.running >= 0 && !c.since.IsZero()
		if active {
			elapsed = now.Sub(c.since)
		}
		if c.paused || active {
			moveRemaining = (c.perMove - elapsed).Milliseconds()
			if moveRemaining < 0 {
				moveRemaining = 0
			}
		}
	}
	return map[string]any{
		"remaining":     [2]int64{c.remaining[0].Milliseconds(), c.remaining[1].Milliseconds()},
		"running":       c.running,
		"paused":        c.paused,
		"budget":        c.budget.Milliseconds(),
		"perMove":       c.perMove.Milliseconds(),
		"moveRemaining": moveRemaining,
	}
}
