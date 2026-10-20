package app

import (
	"testing"

	"github.com/southernMortals/dbx-board-games/backend/internal/game"
	"github.com/southernMortals/dbx-board-games/backend/internal/game/gomoku"
	"github.com/southernMortals/dbx-board-games/backend/internal/game/xiangqi"
)

// offeredScenarios mirrors the 特效预演 buttons in src/App.vue. The opening button is
// rendered for both games, which is exactly how "unknown scenario \"opening\" for xiangqi"
// reached a player: the button existed for a pair the fixture table had never defined.
var offeredScenarios = map[string][]string{
	"xiangqi": {"opening", "capture", "check"},
	"gomoku":  {"opening", "win"},
}

func TestEveryOfferedScenarioExistsAndIsLegal(t *testing.T) {
	for gameName, names := range offeredScenarios {
		for _, name := range names {
			moves, ok := scenarioMoves(gameName, name)
			if !ok {
				t.Errorf("%s/%s is offered by the UI but has no fixture", gameName, name)
				continue
			}
			if len(moves) == 0 {
				t.Errorf("%s/%s is empty", gameName, name)
				continue
			}
			engine := newEngineFor(t, gameName)
			for i, m := range moves {
				if err := engine.Apply(m); err != nil {
					t.Errorf("%s/%s step %d (%d->%d) is illegal: %v", gameName, name, i+1, m.From, m.To, err)
					break
				}
			}
		}
	}
}

func newEngineFor(t *testing.T, gameName string) game.Engine {
	t.Helper()
	switch gameName {
	case "xiangqi":
		return xiangqi.New()
	case "gomoku":
		return gomoku.New()
	default:
		t.Fatalf("no engine for %q", gameName)
		return nil
	}
}
