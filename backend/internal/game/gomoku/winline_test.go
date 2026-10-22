package gomoku

import (
	"testing"

	"github.com/lieng618/dbx-mini-games/backend/internal/game"
)

// playGomoku applies a sequence of placements on alternating seats.
func playGomoku(t *testing.T, cells []int) *Engine {
	t.Helper()
	e := New()
	for _, c := range cells {
		if err := e.Apply(game.Move{From: -1, To: c}); err != nil {
			t.Fatalf("place %d: %v", c, err)
		}
	}
	return e
}

func TestWinLineReportsFiveHorizontal(t *testing.T) {
	// Black fills row 7 columns 3..7, white answers elsewhere.
	e := playGomoku(t, []int{
		7*Cols + 3, 0,
		7*Cols + 4, 1,
		7*Cols + 5, 2,
		7*Cols + 6, 3,
		7*Cols + 7,
	})
	line := e.WinLine()
	if len(line) != 5 {
		t.Fatalf("expected five squares, got %d: %v", len(line), line)
	}
	for i := 1; i < len(line); i++ {
		if line[i]-line[i-1] != 1 {
			t.Fatalf("a horizontal line must step by one column: %v", line)
		}
	}
}

func TestWinLineEmptyBeforeResult(t *testing.T) {
	e := playGomoku(t, []int{7*Cols + 3, 0, 7*Cols + 4})
	if got := e.WinLine(); got != nil {
		t.Fatalf("an unfinished game must report no winning line, got %v", got)
	}
}

func TestWinLineVertical(t *testing.T) {
	e := playGomoku(t, []int{
		3*Cols + 3, 0,
		4*Cols + 3, 1,
		5*Cols + 3, 2,
		6*Cols + 3, 4,
		7*Cols + 3,
	})
	line := e.WinLine()
	if len(line) != 5 {
		t.Fatalf("expected five squares, got %v", line)
	}
	for i := 1; i < len(line); i++ {
		if line[i]-line[i-1] != Cols {
			t.Fatalf("a vertical line must step by one row: %v", line)
		}
	}
}

func TestWinLineStopsAtTheWinningMove(t *testing.T) {
	// The winning move is the sixth black stone but the fifth in its file segment, so the
	// match ends there and the line must be exactly the run that existed at that moment.
	e := playGomoku(t, []int{
		7*Cols + 3, 0,
		7*Cols + 4, 1,
		7*Cols + 5, 2,
		7*Cols + 6, 3,
		7*Cols + 7,
	})
	if err := e.Apply(game.Move{From: -1, To: 7*Cols + 8}); err != game.ErrGameFinished {
		t.Fatalf("a move after the win must be refused, got %v", err)
	}
	line := e.WinLine()
	if len(line) != 5 {
		t.Fatalf("expected exactly five squares, got %v", line)
	}
}
