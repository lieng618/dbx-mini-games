package app

import "testing"

// TestScenariosArePlayable proves every fixture is a legal line. A broken fixture would
// silently do nothing on the practice board.
func TestScenariosArePlayable(t *testing.T) {
	cases := []struct{ game, scenario string }{
		{"xiangqi", "capture"},
		{"xiangqi", "check"},
		{"gomoku", "win"},
		{"gomoku", "opening"},
	}
	for _, c := range cases {
		a := newTestApp(t)
		if _, err := a.Call("room.create", map[string]any{"game": c.game}); err != nil {
			t.Fatalf("%s/%s: create: %v", c.game, c.scenario, err)
		}
		if _, err := a.Call("room.practice.start", nil); err != nil {
			t.Fatalf("%s/%s: practice: %v", c.game, c.scenario, err)
		}
		if _, err := a.Call("dev.scenario", map[string]any{"name": c.scenario}); err != nil {
			t.Fatalf("%s/%s: scenario rejected: %v", c.game, c.scenario, err)
		}
	}
}

func TestScenarioRejectedOutsidePractice(t *testing.T) {
	a := newTestApp(t)
	if _, err := a.Call("room.create", map[string]any{"game": "gomoku"}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Call("dev.scenario", map[string]any{"name": "win"}); err == nil {
		t.Fatal("a scenario must not run on a live match")
	}
}

func TestGomokuWinScenarioFinishesTheBoard(t *testing.T) {
	a := newTestApp(t)
	if _, err := a.Call("room.create", map[string]any{"game": "gomoku"}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Call("room.practice.start", nil); err != nil {
		t.Fatal(err)
	}
	res, err := a.Call("dev.scenario", map[string]any{"name": "win"})
	if err != nil {
		t.Fatal(err)
	}
	view := res.(map[string]any)
	if view["winLine"] == nil {
		t.Fatal("a five-in-a-row scenario must report the winning line")
	}
	line, ok := view["winLine"].([]int)
	if !ok || len(line) < 5 {
		t.Fatalf("expected a winning line of at least five squares, got %v", view["winLine"])
	}
}
