package cloud

import (
	"testing"
	"time"
)

func TestMatchClockPauseExcludesUndoDecisionTime(t *testing.T) {
	c := newMatchClock(10*time.Minute, 30*time.Second)
	base := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	c.start(base)
	c.since = base.Add(-6 * time.Second)
	c.consumed = base.Add(-6 * time.Second)

	c.pause(base)
	if !c.paused || c.running != -1 {
		t.Fatal("an undo request must pause the active clock")
	}
	paused := c.snapshot(base.Add(20 * time.Second))
	if paused["paused"] != true || paused["moveRemaining"] != int64(24_000) {
		t.Fatalf("paused snapshot = %#v", paused)
	}

	c.resume(base.Add(20*time.Second), 0, false)
	if c.paused || c.running != 0 {
		t.Fatal("a declined undo must resume the active seat")
	}
	if got := base.Add(20 * time.Second).Sub(c.since); got != 6*time.Second {
		t.Fatalf("move elapsed after resume = %v, want 6s", got)
	}
}
