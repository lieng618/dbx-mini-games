package app

import (
	"testing"
	"time"

	"github.com/lieng618/dbx-mini-games/backend/internal/game"
	"github.com/lieng618/dbx-mini-games/backend/internal/room"
)

// TestPerMoveLimitTimesOut covers the second kind of time limit: a seat can lose a move
// clock even while its total budget is healthy.
func TestPerMoveLimitTimesOut(t *testing.T) {
	c := newClock(10*time.Minute, 30*time.Second)
	c.reset(time.Now())
	// Pretend the seat has been thinking for 45 seconds.
	c.mu.Lock()
	c.since = time.Now().Add(-45 * time.Second)
	c.mu.Unlock()

	if seat := c.TimeoutSeat(); seat != 0 {
		t.Fatalf("expected the per-move limit to expire for seat 0, got %d", seat)
	}
}

// TestPerMoveLimitDoesNotFireEarly: a clock inside its limit must stay quiet.
func TestPerMoveLimitDoesNotFireEarly(t *testing.T) {
	c := newClock(10*time.Minute, 30*time.Second)
	c.reset(time.Now())
	c.mu.Lock()
	c.since = time.Now().Add(-5 * time.Second)
	c.mu.Unlock()

	if seat := c.TimeoutSeat(); seat != -1 {
		t.Fatalf("expected no timeout, got seat %d", seat)
	}
}

// TestUnlimitedBudgetNeverExpires: zero means "no limit", not "a very large limit".
func TestUnlimitedBudgetNeverExpires(t *testing.T) {
	c := newClock(0, 0)
	c.reset(time.Now())
	c.mu.Lock()
	c.running = 0
	c.since = time.Now().Add(-24 * time.Hour)
	c.remaining[0] = 0
	c.mu.Unlock()

	// A zero budget is not decremented, so the stored remaining is untouched and the seat
	// is not declared timed out.
	if seat := c.TimeoutSeat(); seat != -1 {
		t.Fatalf("an unlimited clock must never time out, got seat %d", seat)
	}
}

// TestHostChoosesItsSide: the host may take the second seat at creation, which is what lets
// a player pick 红 or 黑 before anyone else arrives.
func TestHostChoosesItsSide(t *testing.T) {
	a := newTestApp(t)
	if _, err := a.Call("room.create", map[string]any{
		"name": "选边", "game": "xiangqi", "seat": float64(1),
	}); err != nil {
		t.Fatalf("create room: %v", err)
	}
	seats := a.room.Seats()
	if seats[1] != a.localID {
		t.Fatalf("expected the host on seat 1, got seats=%v self=%s", seats, a.localID)
	}
	if seats[0] != "" {
		t.Fatalf("seat 0 should still be free, got %q", seats[0])
	}
}

// TestDefaultHostSeatIsFirstFree keeps the old behaviour when the host expresses no
// preference: no reservation means seat zero.
func TestDefaultHostSeatIsFirstFree(t *testing.T) {
	a := newTestApp(t)
	if _, err := a.Call("room.create", map[string]any{"name": "默认", "game": "xiangqi"}); err != nil {
		t.Fatalf("create room: %v", err)
	}
	if seats := a.room.Seats(); seats[0] != a.localID {
		t.Fatalf("expected the host on seat 0, got %v", seats)
	}
}

// TestTimeControlEndsTheMatch: an expired clock must actually finish the game, with the
// win going to the seat that still had time.
func TestTimeControlEndsTheMatch(t *testing.T) {
	a := newTestApp(t)
	if _, err := a.Call("room.create", map[string]any{
		"name": "限时", "game": "xiangqi", "minutes": float64(5),
	}); err != nil {
		t.Fatalf("create room: %v", err)
	}
	if _, err := a.room.Join("guest-1", "对手"); err != nil {
		t.Fatalf("join second player: %v", err)
	}
	if _, err := a.Call("room.start", nil); err != nil {
		t.Fatalf("start match: %v", err)
	}
	if a.room.Phase() != room.PhasePlaying {
		t.Fatalf("expected a running match, got %s", a.room.Phase())
	}

	// Seat zero (the host) runs out of time.
	a.clock.mu.Lock()
	a.clock.remaining[0] = 0
	a.clock.mu.Unlock()

	// Any call runs the timeout check first; a bare snapshot is enough, which is what a
	// client polling the clock does.
	if _, err := a.Call("room.snapshot", nil); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if a.room.Phase() != room.PhaseFinished {
		t.Fatalf("expected the match to end on time, got %s", a.room.Phase())
	}
	rec, ok := a.room.Replay()
	if !ok {
		t.Fatal("expected a recorded match")
	}
	if rec.Reason != "timeout" {
		t.Fatalf("expected reason timeout, got %q", rec.Reason)
	}
	if rec.Outcome != game.OutcomeSeatTwoWin {
		t.Fatalf("seat two should win when seat one flags, got %v", rec.Outcome)
	}
}

// TestRepeatedReadsDoNotDrainTheClock guards the deduction cursor.
//
// The clock used to subtract "time since the turn began" on every call without advancing
// that reference, so each read re-deducted the whole span. A client polling twice a second
// burned a ten-minute budget in seconds, and the match then ended on a timeout that had not
// happened. One second of real time must cost one second exactly, however often it is read.
func TestRepeatedReadsDoNotDrainTheClock(t *testing.T) {
	c := newClock(10*time.Minute, 0)
	base := time.Now()
	c.reset(base)

	// One second has really passed.
	c.mu.Lock()
	c.consumed = base.Add(-time.Second)
	c.mu.Unlock()

	// Ten reads at the same instant must not multiply that second by ten.
	for i := 0; i < 10; i++ {
		c.mu.Lock()
		c.consumeLocked(base)
		c.mu.Unlock()
	}

	spent := 10*time.Minute - c.remaining[0]
	if spent != time.Second {
		t.Fatalf("expected exactly one second spent, spent %v", spent)
	}
}

// TestReadingDoesNotResetThePerMoveTimer: the deduction cursor and the per-move reference
// are separate, so consuming budget must not hand the player a fresh move clock.
func TestReadingDoesNotResetThePerMoveTimer(t *testing.T) {
	c := newClock(10*time.Minute, 30*time.Second)
	base := time.Now()
	c.reset(base)

	c.mu.Lock()
	c.since = base.Add(-45 * time.Second)
	c.mu.Unlock()

	// Reading the clock consumes budget and advances the cursor, but the move clock still
	// counts from the turn's start.
	_ = c.view()

	if seat := c.TimeoutSeat(); seat != 0 {
		t.Fatalf("the per-move limit must still have expired, got %d", seat)
	}
}
