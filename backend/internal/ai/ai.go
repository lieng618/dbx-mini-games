// Package ai provides a heuristic practice partner.
//
// It is deliberately not a search engine. A sparring partner has to answer at human speed
// on the host's own machine while a browser is rendering ink, and it has to be fun to lose
// to: it should punish a hung piece and take a free one, but it should not calculate twelve
// plies and never let you touch the ball.
//
// Xiangqi gets two plies of material search, because one ply happily walks a rook into a
// defended square — the single most annoying thing a weak opponent does. Gomoku gets a
// line-shape score, because there is no material to count and every threat is geometric.
package ai

import (
	"math"
	"math/rand"

	"github.com/southernMortals/dbx-board-games/backend/internal/game"
)

// xiangqi piece values, roughly in centipawns. The king is worth more than every other
// piece combined: losing it is not a material swing, it is the end of the game.
var pieceValue = map[int8]int{
	1: 12000, // king
	2: 220,   // advisor
	3: 220,   // elephant
	4: 450,   // horse
	5: 950,   // rook
	6: 480,   // cannon
	7: 110,   // pawn
}

// BestMove picks a move for the seat to move, or reports false when none exists.
func BestMove(e game.Engine) (game.Move, bool) {
	switch e.Name() {
	case "xiangqi":
		return bestXiangqi(e)
	case "gomoku":
		return bestGomoku(e)
	default:
		return game.Move{}, false
	}
}

// legalMoves enumerates every move the seat on turn may make. Candidates that the engine
// rejects are dropped rather than trusted: LegalFrom is documented as a UI convenience,
// not an authority, and a partner that proposes an illegal move is worse than none.
func legalMoves(e game.Engine) []game.Move {
	cells := e.Cells()
	moves := make([]game.Move, 0, 64)
	if e.Name() == "gomoku" {
		for to, code := range cells {
			if code == 0 {
				moves = append(moves, game.Move{From: -1, To: to})
			}
		}
		return moves
	}
	for from, code := range cells {
		if code == 0 {
			continue
		}
		for _, to := range e.LegalFrom(from) {
			moves = append(moves, game.Move{From: from, To: to})
		}
	}
	return moves
}

// material counts the board from one seat's point of view.
func material(cells []int8, seat game.Seat) int {
	sign := 1
	if seat == game.SeatTwo {
		sign = -1
	}
	total := 0
	for _, code := range cells {
		if code == 0 {
			continue
		}
		kind := code
		if kind < 0 {
			kind = -kind
		}
		value := pieceValue[kind]
		if code > 0 {
			total += value * sign
		} else {
			total -= value * sign
		}
	}
	return total
}

// pawnAdvance rewards pushing pawns toward the enemy back rank.
//
// Without it the partner shuffles its advisors forever: material is level, so every quiet
// move ties. Scored per side rather than "add both, then subtract" — the old form mixed the
// two seats' signs and was one edit away from rewarding the opponent.
func pawnAdvance(cells []int8, seat game.Seat) int {
	score := 0
	for index, code := range cells {
		if code == 0 {
			continue
		}
		kind := code
		if kind < 0 {
			kind = -kind
		}
		if kind != 7 {
			continue
		}
		rank := index / 9
		progress := rank
		if code > 0 {
			progress = 9 - rank // red advances toward rank 0
		}
		if (code > 0) == (seat == game.SeatOne) {
			score += progress * 6
		} else {
			score -= progress * 6
		}
	}
	return score
}

// aggression decides how much pressure is worth relative to material.
//
// At 0 this is the old opponent: correct, and completely passive, because with material
// level every quiet move ties and the first one in the list wins. Pressure is what makes
// it come at you instead of shuffling. It stays under a rook on purpose, so "attacking"
// never turns into "sacrificing": the two-ply material term still dominates a real blunder.
const aggression = 14 // per 10

func absInt(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// crossedRiver reports whether a pawn has left its own half.
func crossedRiver(rank int, red bool) bool {
	if red {
		return rank <= 4 // red starts at rank 9 and advances upward
	}
	return rank >= 5
}

// kingSquare finds a side's general, or -1.
func kingSquare(cells []int8, seat game.Seat) int {
	want := int8(1)
	if seat == game.SeatTwo {
		want = -1
	}
	for index, code := range cells {
		if code == want {
			return index
		}
	}
	return -1
}

// pressure scores how hard the given seat is leaning on the enemy general.
//
// Each attacking piece is worth more the closer it sits, and a pawn across the river counts
// outright: crossing is the clearest signal that a player has committed to an attack rather
// than to a tidy position.
func pressure(cells []int8, seat game.Seat) int {
	enemyKing := kingSquare(cells, seat.Other())
	if enemyKing < 0 {
		return 0
	}
	kingFile := enemyKing % 9
	kingRank := enemyKing / 9

	score := 0
	for index, code := range cells {
		if code == 0 {
			continue
		}
		mine := code > 0
		if mine != (seat == game.SeatOne) {
			continue
		}
		kind := code
		if kind < 0 {
			kind = -kind
		}
		file := index % 9
		rank := index / 9
		switch kind {
		case 1:
			// The general does not attack; it only has to survive.
		case 7:
			if crossedRiver(rank, mine) {
				score += 70
			}
		default:
			distance := absInt(file-kingFile) + absInt(rank-kingRank)
			if value := 110 - distance*7; value > 0 {
				score += value
			}
		}
	}
	return score
}

// evaluateFor scores the position from one specific seat's point of view.
func evaluateFor(e game.Engine, seat game.Seat) int {
	cells := e.Cells()
	return material(cells, seat) +
		pawnAdvance(cells, seat) +
		aggression*pressure(cells, seat)/10
}

// givesCheck reports whether the side now to move is in check, which is worth something on
// its own: it forces a reply and keeps the initiative.
func givesCheck(e game.Engine) bool {
	reporter, ok := e.(game.CheckReporter)
	if !ok {
		return false
	}
	return reporter.InCheck(e.Turn())
}

func bestXiangqi(e game.Engine) (game.Move, bool) {
	seat := e.Turn()
	candidates := legalMoves(e)
	if len(candidates) == 0 {
		return game.Move{}, false
	}

	type scored struct {
		move  game.Move
		score int
	}
	ranked := make([]scored, 0, len(candidates))

	for _, m := range candidates {
		after := e.Clone()
		if err := after.Apply(m); err != nil {
			continue
		}
		// Immediate win beats everything, and a drawn-by-rule position is never better
		// than continuing to play.
		if res := after.Result(); res.Finished {
			if res.Outcome == game.OutcomeDraw {
				ranked = append(ranked, scored{m, -5000})
				continue
			}
			return m, true
		}

		// Everything below is scored from OUR seat. After our own move it is the opponent's
		// turn, so reading the position with "whoever is to move" would silently evaluate
		// the opponent's advantage and prefer the moves that help them.
		ourScore := evaluateFor(after, seat)

		// Second ply: the opponent takes their single best reply. Anything less leaves
		// pieces hanging and reads as a broken opponent rather than a beatable one.
		worst := math.MaxInt
		for _, reply := range legalMoves(after) {
			twoPly := after.Clone()
			if err := twoPly.Apply(reply); err != nil {
				continue
			}
			if value := evaluateFor(twoPly, seat); value < worst {
				worst = value
			}
		}
		if worst == math.MaxInt {
			worst = ourScore
		}

		score := ourScore + worst/2
		// A check forces a reply and keeps the initiative, so it is worth something even
		// when it wins no material — this is what makes the partner keep coming at you
		// instead of trading down into a quiet endgame.
		if givesCheck(after) {
			score += 120
		}
		ranked = append(ranked, scored{m, score})
	}

	if len(ranked) == 0 {
		return game.Move{}, false
	}

	// Pick among the best few so repeated games are not identical. The window is wide
	// enough to vary the opening, narrow enough never to throw a piece away.
	best := math.MinInt
	for _, s := range ranked {
		if s.score > best {
			best = s.score
		}
	}
	window := 40
	pool := make([]game.Move, 0, 4)
	for _, s := range ranked {
		if s.score >= best-window {
			pool = append(pool, s.move)
		}
	}
	return pool[rand.Intn(len(pool))], true
}

const gomokuSize = 15

// Attack versus defence, per ten. Raising the first or lowering the second makes the
// partner more aggressive; the values are tuned so that a forced loss is still answered.
const (
	gomokuAttack  = 13
	gomokuDefence = 8
)

var gomokuDirections = [4][2]int{{1, 0}, {0, 1}, {1, 1}, {1, -1}}

// lineScore rates what a stone at (file, rank) would be worth for one colour.
//
// The shape table is what makes the partner feel like it is playing: an open four is a
// forced win, an open three must be answered, and a two is only worth building on.
func lineScore(board []int8, file, rank int, colour int8) int {
	total := 0
	for _, dir := range gomokuDirections {
		run := 1 // the stone being considered
		openEnds := 0

		for _, step := range [2]int{1, -1} {
			df := dir[0] * step
			dr := dir[1] * step
			f := file + df
			r := rank + dr
			for f >= 0 && f < gomokuSize && r >= 0 && r < gomokuSize && board[r*gomokuSize+f] == colour {
				run++
				f += df
				r += dr
			}
			// The square that stopped the run: an empty one keeps the line alive.
			if f >= 0 && f < gomokuSize && r >= 0 && r < gomokuSize && board[r*gomokuSize+f] == 0 {
				openEnds++
			}
		}

		switch {
		case run >= 5:
			return 1_000_000
		case run == 4 && openEnds == 2:
			total += 120_000
		case run == 4 && openEnds == 1:
			total += 12_000
		case run == 3 && openEnds == 2:
			total += 6_000
		case run == 3 && openEnds == 1:
			total += 700
		case run == 2 && openEnds == 2:
			total += 220
		case run == 2 && openEnds == 1:
			total += 40
		case run == 1 && openEnds == 2:
			total += 8
		}
	}
	return total
}

func bestGomoku(e game.Engine) (game.Move, bool) {
	board := append([]int8(nil), e.Cells()...)
	seat := e.Turn()
	mine := int8(1) // gomoku encodes 1 = black (seat one)
	if seat == game.SeatTwo {
		mine = 2
	}
	theirs := int8(3) - mine

	// Only squares near existing stones are worth considering: the first move is the only
	// one where the whole board is empty, and scanning 225 cells per candidate is wasted
	// work everywhere else.
	emptyBoard := true
	for _, code := range board {
		if code != 0 {
			emptyBoard = false
			break
		}
	}

	type scored struct {
		move  game.Move
		score int
	}
	ranked := make([]scored, 0, 32)

	for index, code := range board {
		if code != 0 {
			continue
		}
		file := index % gomokuSize
		rank := index / gomokuSize
		if !emptyBoard && !nearStone(board, file, rank) {
			continue
		}

		attack := lineScore(board, file, rank, mine)
		defence := lineScore(board, file, rank, theirs)
		// Attack outweighs defence by roughly three to two. The ladder is steep enough that
		// this never becomes reckless: stopping an open four is worth 120k before weighting,
		// while building a three is worth 6k, so a lethal threat is still answered. What
		// changes is the middle of the board — with both sides on an open three, the partner
		// now makes its own open four and forces the answer, instead of trading blocks.
		ranked = append(ranked, scored{
			game.Move{From: -1, To: index},
			attack*gomokuAttack/10 + defence*gomokuDefence/10,
		})
	}

	if len(ranked) == 0 {
		// Board is full; nothing to play.
		return game.Move{}, false
	}

	best := math.MinInt
	for _, s := range ranked {
		if s.score > best {
			best = s.score
		}
	}
	pool := make([]game.Move, 0, 4)
	for _, s := range ranked {
		if s.score >= best-best/20 {
			pool = append(pool, s.move)
		}
	}
	return pool[rand.Intn(len(pool))], true
}

// nearStone reports whether any of the surrounding two rings holds a stone.
func nearStone(board []int8, file, rank int) bool {
	for dr := -2; dr <= 2; dr++ {
		for df := -2; df <= 2; df++ {
			if dr == 0 && df == 0 {
				continue
			}
			f := file + df
			r := rank + dr
			if f < 0 || f >= gomokuSize || r < 0 || r >= gomokuSize {
				continue
			}
			if board[r*gomokuSize+f] != 0 {
				return true
			}
		}
	}
	return false
}
