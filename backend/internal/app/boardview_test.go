package app

import (
	"testing"

	"github.com/lieng618/dbx-mini-games/backend/internal/room"
)

func TestLobbySnapshotShowsOpeningPosition(t *testing.T) {
	for _, game := range []string{"xiangqi", "gomoku"} {
		a := newTestApp(t)
		if _, err := a.Call("room.create", map[string]any{"game": game}); err != nil {
			t.Fatalf("%s: create: %v", game, err)
		}
		view := a.snapshot()
		cells, ok := view["cells"].([]int8)
		if !ok || len(cells) == 0 {
			t.Fatalf("%s: lobby snapshot must carry the board, got %T", game, view["cells"])
		}
		if game == "xiangqi" {
			// The red king and the black king are both on the board at the opening.
			var red, black int
			for _, c := range cells {
				if c == 1 {
					red++
				}
				if c == -1 {
					black++
				}
			}
			if red != 1 || black != 1 {
				t.Fatalf("xiangqi opening must place both generals, got red=%d black=%d", red, black)
			}
		}
		if view["selfId"] == "" || view["selfId"] == nil {
			t.Fatalf("%s: a host snapshot must identify the receiver", game)
		}
		if got := view["turnSeat"]; got != 0 {
			t.Fatalf("%s: seat zero moves first, got %v", game, got)
		}
	}
}

func TestHostKnowsItsOwnSeat(t *testing.T) {
	a := newTestApp(t)
	if _, err := a.Call("room.create", map[string]any{"game": "gomoku"}); err != nil {
		t.Fatal(err)
	}
	view := a.snapshot()
	self, _ := view["selfId"].(string)
	seats, ok := view["seats"].(room.Seats)
	if !ok {
		t.Fatalf("seats must be room.Seats, got %T", view["seats"])
	}
	if self == "" {
		t.Fatal("snapshot must carry selfId")
	}
	if seats[0] != self {
		t.Fatalf("the host must occupy seat 0, seats=%v self=%q", seats, self)
	}
}
