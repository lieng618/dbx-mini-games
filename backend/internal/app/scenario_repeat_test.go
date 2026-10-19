package app

import "testing"

// TestScenarioIsRepeatable proves a scenario can be run twice in a row: each run starts
// from the opening, so the second must not be rejected as illegal.
func TestScenarioIsRepeatable(t *testing.T) {
	a := newTestApp(t)
	if _, err := a.Call("room.create", map[string]any{"game": "xiangqi"}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Call("room.practice.start", nil); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err := a.Call("dev.scenario", map[string]any{"name": "capture"}); err != nil {
			t.Fatalf("run %d: %v", i+1, err)
		}
	}
}

func TestScenarioSwitchesCleanly(t *testing.T) {
	a := newTestApp(t)
	if _, err := a.Call("room.create", map[string]any{"game": "xiangqi"}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Call("room.practice.start", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Call("dev.scenario", map[string]any{"name": "capture"}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Call("dev.scenario", map[string]any{"name": "check"}); err != nil {
		t.Fatalf("switching scenarios must start from the opening: %v", err)
	}
}
