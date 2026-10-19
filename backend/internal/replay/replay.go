// Package replay records a finished or in-progress Match as an ordered move list and
// replays it move by move without any transport, room, or clock involvement.
//
// A Record is the durable artifact: game name plus moves. A Replay is a cursor over
// that Record, backed by a live Engine so the caller can inspect any position.
package replay

import (
	"fmt"

	"github.com/southernMortals/dbx-board-games/backend/internal/game"
	"github.com/southernMortals/dbx-board-games/backend/internal/game/gomoku"
	"github.com/southernMortals/dbx-board-games/backend/internal/game/xiangqi"
)

// Record is a portable transcript of one Match.
type Record struct {
	Game  string      `json:"game"`
	Moves []game.Move `json:"moves"`
	// Outcome is the terminal outcome when the Match finished, otherwise OutcomeNone.
	Outcome game.Outcome `json:"outcome"`
	Reason  string       `json:"reason,omitempty"`
}

// NewEngine builds an engine for a known game name.
func NewEngine(name string) (game.Engine, error) {
	switch name {
	case "xiangqi":
		return xiangqi.New(), nil
	case "gomoku":
		return gomoku.New(), nil
	default:
		return nil, fmt.Errorf("unknown game %q", name)
	}
}

// Replay is a cursor over a Record.
type Replay struct {
	record Record
	engine game.Engine
	cursor int
	err    error
}

// New validates the record by replaying every move and returns a Replay positioned at
// the start of the Match.
//
// A record whose moves are illegal is rejected rather than partially loaded, because a
// replay that silently drops moves misrepresents the Match.
func New(record Record) (*Replay, error) {
	engine, err := NewEngine(record.Game)
	if err != nil {
		return nil, err
	}
	for i, m := range record.Moves {
		if err := engine.Apply(m); err != nil {
			return nil, fmt.Errorf("move %d is illegal: %w", i+1, err)
		}
	}
	return &Replay{record: record, engine: engine}, nil
}

// Total is the number of moves in the Match.
func (r *Replay) Total() int { return len(r.record.Moves) }

// Cursor is how many moves are currently applied, from 0 to Total.
func (r *Replay) Cursor() int { return r.cursor }

// Game is the record's game name.
func (r *Replay) Game() string { return r.record.Game }

// Record returns a copy of the underlying record.
func (r *Replay) Record() Record {
	out := Record{Game: r.record.Game, Outcome: r.record.Outcome, Reason: r.record.Reason}
	out.Moves = make([]game.Move, len(r.record.Moves))
	copy(out.Moves, r.record.Moves)
	return out
}

// Err reports any error raised while navigating. Navigation never panics on a cursor
// edge; it reports instead.
func (r *Replay) Err() error { return r.err }

// Next applies the following move. It reports whether the cursor advanced.
func (r *Replay) Next() bool {
	if r.cursor >= len(r.record.Moves) {
		return false
	}
	// The engine currently holds the final position; to step forward from an earlier
	// cursor we rebuild from the start. This keeps forward and backward stepping
	// symmetrical and avoids depending on a redo buffer.
	if err := r.seek(r.cursor + 1); err != nil {
		r.err = err
		return false
	}
	return true
}

// Prev reverts one move. It reports whether the cursor moved back.
func (r *Replay) Prev() bool {
	if r.cursor == 0 {
		return false
	}
	if err := r.seek(r.cursor - 1); err != nil {
		r.err = err
		return false
	}
	return true
}

// Seek moves the cursor to an absolute move count, clamped to the record bounds.
func (r *Replay) Seek(index int) error {
	if index < 0 {
		index = 0
	}
	if index > len(r.record.Moves) {
		index = len(r.record.Moves)
	}
	return r.seek(index)
}

// seek rebuilds the position at index from the opening position.
func (r *Replay) seek(index int) error {
	engine, err := NewEngine(r.record.Game)
	if err != nil {
		return err
	}
	for _, m := range r.record.Moves[:index] {
		if err := engine.Apply(m); err != nil {
			return err
		}
	}
	r.engine = engine
	r.cursor = index
	r.err = nil
	return nil
}

// Start rewinds to the opening position.
func (r *Replay) Start() error { return r.Seek(0) }

// End jumps to the final position.
func (r *Replay) End() error { return r.Seek(len(r.record.Moves)) }

// State is the position at the cursor. The engine must not be retained across
// navigation, because seeking replaces it.
type State struct {
	Cursor int         `json:"cursor"`
	Total  int         `json:"total"`
	Seat   game.Seat   `json:"seat"`
	Cells  []int8      `json:"cells"`
	Result game.Result `json:"result"`
	// LastMove is the move that produced this position, if any.
	LastMove *game.Move `json:"lastMove,omitempty"`
}

// State returns the current position.
func (r *Replay) State() State {
	st := State{
		Cursor: r.cursor,
		Total:  len(r.record.Moves),
		Cells:  r.engine.Cells(),
		Result: r.engine.Result(),
	}
	if r.cursor > 0 {
		m := r.record.Moves[r.cursor-1]
		st.LastMove = &m
		// The seat that moved is the one that does not hold the turn now. When the
		// Match is over the engine stops reporting a meaningful turn, so derive it
		// from the mover's parity instead.
		if !st.Result.Finished {
			st.Seat = r.engine.Turn()
		} else {
			st.Seat = turnAt(r.record.Game, r.cursor)
		}
	} else {
		st.Seat = turnAt(r.record.Game, 0)
	}
	return st
}

// turnAt reports who moves at a given ply, assuming the opening seat is seat one.
func turnAt(_ string, ply int) game.Seat {
	if ply%2 == 0 {
		return game.SeatOne
	}
	return game.SeatTwo
}

// Notation renders every move in the record, one entry per ply.
func (r *Replay) Notation() ([]string, error) {
	engine, err := NewEngine(r.record.Game)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(r.record.Moves))
	for i, m := range r.record.Moves {
		var text string
		switch r.record.Game {
		case "xiangqi":
			text = XiangqiNotation(engine.Cells(), engine.Turn(), m)
		case "gomoku":
			text = GomokuNotation(m)
		default:
			text = fmt.Sprintf("%d->%d", m.From, m.To)
		}
		out = append(out, text)
		if err := engine.Apply(m); err != nil {
			return nil, fmt.Errorf("move %d is illegal: %w", i+1, err)
		}
	}
	return out, nil
}
