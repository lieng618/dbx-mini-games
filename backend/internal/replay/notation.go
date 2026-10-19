package replay

import (
	"fmt"

	"github.com/jzj2621899857/dbx-board-games/backend/internal/game"
)

// Chinese numerals used by conventional xiangqi notation.
var (
	redNumerals   = [...]string{"一", "二", "三", "四", "五", "六", "七", "八", "九"}
	blackNumerals = [...]string{"1", "2", "3", "4", "5", "6", "7", "8", "9"}
)

// pieceNames maps a signed piece code to its Chinese name.
func pieceName(code int8) string {
	switch code {
	case 1:
		return "帅"
	case -1:
		return "将"
	case 2:
		return "仕"
	case -2:
		return "士"
	case 3:
		return "相"
	case -3:
		return "象"
	case 4:
		return "马"
	case -4:
		return "马"
	case 5:
		return "车"
	case -5:
		return "车"
	case 6:
		return "炮"
	case -6:
		return "炮"
	case 7:
		return "兵"
	case -7:
		return "卒"
	}
	return "?"
}

// XiangqiNotation renders one move in conventional Chinese notation, for example
// 炮二平五. It reads the position before the move.
//
// Files are counted from the mover's own right, which is why red numbers files
// right-to-left and black numbers them left-to-right on the same grid.
func XiangqiNotation(cells []int8, seat game.Seat, m game.Move) string {
	const cols = 9
	if m.From < 0 || m.From >= len(cells) || m.To < 0 || m.To >= len(cells) {
		return "?"
	}
	code := cells[m.From]
	if code == 0 {
		return "?"
	}
	name := pieceName(code)
	fromRank, fromFile := m.From/cols, m.From%cols
	toRank, toFile := m.To/cols, m.To%cols

	fileLabel := func(file int) string {
		if seat == game.SeatOne {
			// Red counts files right-to-left: file 8 is 一, file 0 is 九.
			return redNumerals[8-file]
		}
		return blackNumerals[file]
	}

	// A piece sharing its file with another piece of the same kind is described with
	// 前/后 instead of a file number. The nearer-to-opponent piece is 前.
	sameFile := sameKindOnFile(cells, m.From, code)
	prefix := fileLabel(fromFile)
	if sameFile {
		if other := otherKindOnFile(cells, m.From, code); other >= 0 {
			nearer := fromRank < other/cols
			if seat == game.SeatTwo {
				nearer = fromRank > other/cols
			}
			if nearer {
				prefix = "前"
			} else {
				prefix = "后"
			}
		}
	}

	switch {
	case fromFile == toFile:
		// Vertical move: 进 or 退.
		forward := -1
		if seat == game.SeatTwo {
			forward = 1
		}
		steps := (toRank - fromRank) * forward
		verb := "进"
		if steps < 0 {
			verb = "退"
			steps = -steps
		}
		return label(name, prefix) + verb + countLabel(steps, seat)
	default:
		// Horizontal move: 平.
		return label(name, prefix) + "平" + fileLabel(toFile)
	}
}

// label joins a piece name with its 前/后 prefix. In conventional notation the
// positional prefix precedes the piece name (前车平八), while a file number follows it
// (车九平八).
func label(name, prefix string) string {
	if prefix == "前" || prefix == "后" {
		return prefix + name
	}
	return name + prefix
}

// countLabel renders a number of steps in the mover's counting system.
func countLabel(steps int, seat game.Seat) string {
	if steps <= 0 || steps > 9 {
		return fmt.Sprintf("%d", steps)
	}
	if seat == game.SeatOne {
		return redNumerals[steps-1]
	}
	return blackNumerals[steps-1]
}

// sameKindOnFile reports whether another piece of the same kind shares the file.
func sameKindOnFile(cells []int8, from int, code int8) bool {
	return otherKindOnFile(cells, from, code) >= 0
}

// otherKindOnFile returns the index of another friendly piece of the same kind on the
// same file, or -1.
func otherKindOnFile(cells []int8, from int, code int8) int {
	const cols = 9
	file := from % cols
	for rank := 0; rank < len(cells)/cols; rank++ {
		i := rank*cols + file
		if i == from {
			continue
		}
		if cells[i] == code {
			return i
		}
	}
	return -1
}

// GomokuNotation renders a placement using conventional column-letter, row-number
// coordinates, with columns running A..O left to right and rows 1..15 bottom up.
func GomokuNotation(m game.Move) string {
	const cols = 15
	if m.To < 0 || m.To >= 225 {
		return "?"
	}
	file := m.To % cols
	rank := m.To / cols
	letter := string(rune('A' + file))
	number := 15 - rank
	return fmt.Sprintf("%s%d", letter, number)
}
