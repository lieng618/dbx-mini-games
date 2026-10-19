package app

import (
	"testing"

	"github.com/southernMortals/dbx-board-games/backend/internal/game"
	"github.com/southernMortals/dbx-board-games/backend/internal/game/xiangqi"
)

// TestCheckScenarioActuallyChecks guards the fixture: if the line ever drifts, the effect
// it exists to demonstrate would silently stop appearing.
func TestCheckScenarioActuallyChecks(t *testing.T) {
	moves, ok := scenarioMoves("xiangqi", "check")
	if !ok {
		t.Fatal("check scenario missing")
	}
	e := xiangqi.New()
	for i, m := range moves {
		if err := e.Apply(m); err != nil {
			t.Fatalf("ply %d (%d->%d) illegal: %v", i+1, m.From, m.To, err)
		}
	}
	if !e.InCheck(e.Turn()) {
		t.Fatal("the check scenario must leave the side to move in check")
	}
}

// TestCaptureScenarioCaptures guards the capture fixture the same way.
func TestCaptureScenarioCaptures(t *testing.T) {
	moves, ok := scenarioMoves("xiangqi", "capture")
	if !ok {
		t.Fatal("capture scenario missing")
	}
	e := xiangqi.New()
	captures := 0
	for i, m := range moves {
		before := e.Cells()[m.To]
		if err := e.Apply(m); err != nil {
			t.Fatalf("ply %d (%d->%d) illegal: %v", i+1, m.From, m.To, err)
		}
		if before != 0 {
			captures++
		}
	}
	if captures == 0 {
		t.Fatal("the capture scenario must contain at least one capture")
	}
	_ = game.SeatOne
}
