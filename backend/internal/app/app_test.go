package app

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jzj2621899857/dbx-board-games/backend/internal/room"
)

func newTestApp(t *testing.T) *App {
	t.Helper()
	dir := t.TempDir()
	return New(dir, nil)
}

func TestProfilePersists(t *testing.T) {
	dir := t.TempDir()
	a := New(dir, nil)
	if _, err := a.Call("profile.save", map[string]any{"nickname": "老张", "lowMotion": true}); err != nil {
		t.Fatal(err)
	}

	again := New(dir, nil)
	got := again.getProfile()
	if got.Nickname != "老张" {
		t.Fatalf("nickname must persist, got %q", got.Nickname)
	}
	if !got.LowMotion {
		t.Fatal("lowMotion must persist")
	}
	if got.ID == "" {
		t.Fatal("a profile must carry a stable id")
	}
}

func TestProfileIDIsStableAcrossRestarts(t *testing.T) {
	dir := t.TempDir()
	first := New(dir, nil).getProfile().ID
	second := New(dir, nil).getProfile().ID
	if first != second {
		t.Fatalf("profile id must be stable, got %q then %q", first, second)
	}
}

func TestCreateRoomSnapshot(t *testing.T) {
	a := newTestApp(t)
	res, err := a.Call("room.create", map[string]any{"name": "棋室", "game": "xiangqi"})
	if err != nil {
		t.Fatal(err)
	}
	view := res.(map[string]any)
	if view["role"] != "host" {
		t.Fatalf("expected host role, got %v", view["role"])
	}
	if view["game"] != "xiangqi" {
		t.Fatalf("expected xiangqi, got %v", view["game"])
	}
	if view["hostKey"] == "" || view["hostKey"] == nil {
		t.Fatal("a hosted room must expose its pinned host key")
	}
	if view["port"] == nil {
		t.Fatal("a hosted room must expose its port")
	}
}

func TestCreateRoomIsExclusive(t *testing.T) {
	a := newTestApp(t)
	if _, err := a.Call("room.create", map[string]any{"game": "gomoku"}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Call("room.create", map[string]any{"game": "gomoku"}); err == nil {
		t.Fatal("a second room on the same instance must be refused")
	}
}

func TestUnknownGameRejected(t *testing.T) {
	a := newTestApp(t)
	if _, err := a.Call("room.create", map[string]any{"game": "go"}); err == nil {
		t.Fatal("an unsupported game must be refused")
	}
}

func TestMoveAndSnapshotFlow(t *testing.T) {
	a := newTestApp(t)
	if _, err := a.Call("room.create", map[string]any{"game": "gomoku"}); err != nil {
		t.Fatal(err)
	}
	// Only one participant exists, so seating needs a second member to start.
	if _, err := a.Call("room.start", nil); err == nil {
		t.Fatal("a solo room must not start a match")
	}
}

func TestLeaveRoomResetsSession(t *testing.T) {
	a := newTestApp(t)
	if _, err := a.Call("room.create", map[string]any{"game": "gomoku"}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Call("room.leave", nil); err != nil {
		t.Fatal(err)
	}
	view := a.snapshot()
	if view["role"] != "idle" {
		t.Fatalf("expected idle after leaving, got %v", view["role"])
	}
	// A fresh room may be created afterwards.
	if _, err := a.Call("room.create", map[string]any{"game": "gomoku"}); err != nil {
		t.Fatalf("a new room should be creatable after leaving: %v", err)
	}
}

func TestSnapshotIsIdleByDefault(t *testing.T) {
	a := newTestApp(t)
	view := a.snapshot()
	if view["role"] != "idle" {
		t.Fatalf("expected idle, got %v", view["role"])
	}
	if view["lowMotion"] != false {
		t.Fatal("lowMotion must default to false")
	}
}

func TestUnknownMethodErrors(t *testing.T) {
	a := newTestApp(t)
	if _, err := a.Call("nope", nil); err == nil {
		t.Fatal("an unknown method must error")
	}
}

func TestClockResetsAndCountsDown(t *testing.T) {
	c := newClock()
	now := time.Now()
	c.reset(now)
	v := c.view()
	remaining := v["remaining"].([2]int64)
	if remaining[0] > int64(DefaultBudget.Milliseconds()) {
		t.Fatal("the running seat must not exceed its budget")
	}
	if v["running"] != 0 {
		t.Fatalf("seat zero should start on the clock, got %v", v["running"])
	}

	// A turn switch moves the clock to the other seat.
	c.switchTurn(now.Add(time.Second))
	if c.view()["running"] != 1 {
		t.Fatal("the clock must follow the turn")
	}
}

func TestClockTimeoutDetection(t *testing.T) {
	c := newClock()
	c.reset(time.Now())
	c.mu.Lock()
	c.remaining[0] = 0
	c.mu.Unlock()
	if seat := c.TimeoutSeat(); seat != 0 {
		t.Fatalf("expected seat 0 to have timed out, got %d", seat)
	}
}

func TestClockDoesNotGoNegative(t *testing.T) {
	c := newClock()
	c.mu.Lock()
	c.running = 0
	c.since = time.Now().Add(-time.Hour)
	c.remaining[0] = 10 * time.Millisecond
	c.mu.Unlock()
	v := c.view()
	if v["remaining"].([2]int64)[0] != 0 {
		t.Fatal("a spent clock must clamp to zero, never negative")
	}
}

func TestSeatOperationsRequireHosting(t *testing.T) {
	a := newTestApp(t)
	if _, err := a.Call("room.seat", map[string]any{"seat": 0.0}); err == nil {
		t.Fatal("seating without a room must error")
	}
	if _, err := a.Call("room.release", nil); err == nil {
		t.Fatal("releasing without a room must error")
	}
}

func TestRoomCapacityConstant(t *testing.T) {
	if room.MaxParticipants != 8 {
		t.Fatalf("the room cap is part of the product contract, got %d", room.MaxParticipants)
	}
	if room.SeatCount != 2 {
		t.Fatalf("a board has two seats, got %d", room.SeatCount)
	}
}

func TestProfileFileIsWrittenAtomically(t *testing.T) {
	dir := t.TempDir()
	a := New(dir, nil)
	if _, err := a.Call("profile.save", map[string]any{"nickname": "小李"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "profile.json")); err != nil {
		t.Fatalf("profile.json must exist: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "profile.json.tmp")); !os.IsNotExist(err) {
		t.Fatal("the temporary file must be renamed away")
	}
}
