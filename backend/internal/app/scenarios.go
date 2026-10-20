package app

import (
	"github.com/southernMortals/dbx-board-games/backend/internal/game"
)

// scenarioMoves returns a scripted line that produces one interesting position.
//
// These are fixtures for looking at the board, not opening theory. Each one is a legal
// sequence chosen to reach a specific presentation state.
func scenarioMoves(gameName, scenario string) ([]game.Move, bool) {
	switch gameName + "/" + scenario {
	case "xiangqi/opening":
		// Both sides develop a horse, red swings a cannon to the centre, and a black pawn
		// steps out. Chosen because the resulting board reads as a game under way rather
		// than as scattered pieces, and because no capture fires, so it shows the plain
		// landing ink. Every move was checked against the engine's legal-move generator.
		return []game.Move{
			{From: 82, To: 65},
			{From: 1, To: 20},
			{From: 64, To: 46},
			{From: 7, To: 26},
			{From: 83, To: 67},
			{From: 27, To: 36},
		}, true

	case "xiangqi/capture":
		// A legal line containing two captures, found by search. It exists so the
		// ink-dust burst can be reproduced without playing a game to reach a capture.
		return []game.Move{
			{From: 70, To: 7},
			{From: 19, To: 10},
			{From: 64, To: 1},
		}, true

	case "xiangqi/check":
		// A legal line, found by search, that leaves the side to move in check. It is used
		// to make the rim pulse, the camera shake, and the check flag appear on demand.
		return []game.Move{
			{From: 82, To: 65},
			{From: 8, To: 17},
			{From: 62, To: 53},
			{From: 19, To: 55},
			{From: 70, To: 68},
			{From: 2, To: 22},
			{From: 83, To: 67},
			{From: 55, To: 58},
		}, true

	case "gomoku/win":
		// Black completes five on the seventh rank while white fills elsewhere.
		return []game.Move{
			{From: -1, To: 7*15 + 3},
			{From: -1, To: 8*15 + 0},
			{From: -1, To: 7*15 + 4},
			{From: -1, To: 8*15 + 2},
			{From: -1, To: 7*15 + 5},
			{From: -1, To: 8*15 + 4},
			{From: -1, To: 7*15 + 6},
			{From: -1, To: 8*15 + 6},
			{From: -1, To: 7*15 + 7},
		}, true

	case "gomoku/opening":
		// A scattered opening: enough stones to judge spacing without ending the game.
		return []game.Move{
			{From: -1, To: 7*15 + 7},
			{From: -1, To: 7*15 + 8},
			{From: -1, To: 8*15 + 8},
			{From: -1, To: 6*15 + 6},
			{From: -1, To: 8*15 + 7},
			{From: -1, To: 6*15 + 8},
		}, true
	}
	return nil, false
}
