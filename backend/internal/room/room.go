// Package room owns membership, seating, and match lifecycle for one Room.
//
// The Room is transport-free: it takes participants in and returns snapshots out, with
// no sockets, clocks, or timers of its own. Callers supply the current time so the
// package stays deterministic and testable.
package room

import (
	"errors"
	"sync"

	"github.com/jzj2621899857/dbx-board-games/backend/internal/game"
	"github.com/jzj2621899857/dbx-board-games/backend/internal/replay"
)

// Capacity limits.
const (
	// SeatCount is fixed: a board is a two-player object regardless of Game.
	SeatCount = 2
	// MaxParticipants bounds occupants plus spectators.
	MaxParticipants = 8
)

// Errors callers may need to distinguish.
var (
	ErrRoomFull        = errors.New("room is full")
	ErrAlreadyJoined   = errors.New("already in this room")
	ErrNotMember       = errors.New("not a member of this room")
	ErrNoSeat          = errors.New("no free seat")
	ErrSeatOccupied    = errors.New("seat already occupied")
	ErrMatchInProgress = errors.New("a match is already in progress")
	ErrNotSeated       = errors.New("only seated players may do that")
	ErrNotYourTurn     = errors.New("not your turn")
	ErrUnknownMember   = errors.New("unknown member")
)

// Phase is the Room's lifecycle state.
type Phase string

const (
	// PhaseLobby has no running match; seats may be taken and released freely.
	PhaseLobby Phase = "lobby"
	// PhasePlaying has a running match; seats are frozen.
	PhasePlaying Phase = "playing"
	// PhaseFinished has a concluded match awaiting a rematch or seat changes.
	PhaseFinished Phase = "finished"
)

// Member is one connected participant.
type Member struct {
	ID        string    `json:"id"`
	Nickname  string    `json:"nickname"`
	Seat      int       `json:"seat"` // -1 for a spectator
	Connected bool      `json:"connected"`
	IsHost    bool      `json:"isHost"`
	JoinedSeq int       `json:"joinedSeq"`
}

// IsSeated reports whether the member holds a seat.
func (m Member) IsSeated() bool { return m.Seat >= 0 }

// Seats is the seating table: seat index to member id, or empty string.
type Seats [SeatCount]string

// Match is the state of a running or concluded match.
type Match struct {
	Engine    game.Engine
	Record    replay.Record
	Revision  int64
	StartedAt int64
	Finished  bool
	Result    game.Result
	// UndoRequestedBy is the member id proposing an undo, or empty.
	UndoRequestedBy string
}

// Room is the authoritative table. All exported methods are safe for concurrent use.
type Room struct {
	mu       sync.RWMutex
	id       string
	name     string
	gameName string
	hostID   string
	password string

	members map[string]*Member
	order   []string // join order, for "first to arrive sits"
	seats   Seats
	phase   Phase
	match   *Match
	replay  *replay.Replay
	seq     int
}

// Options configures a new Room.
type Options struct {
	ID       string
	Name     string
	Game     string
	HostID   string
	Password string
}

// New creates an empty Room with its host not yet joined.
func New(opts Options) (*Room, error) {
	if _, err := replay.NewEngine(opts.Game); err != nil {
		return nil, err
	}
	return &Room{
		id:       opts.ID,
		name:     opts.Name,
		gameName: opts.Game,
		hostID:   opts.HostID,
		password: opts.Password,
		members:  map[string]*Member{},
		phase:    PhaseLobby,
	}, nil
}

// ID returns the room id.
func (r *Room) ID() string { return r.id }

// Name returns the display name.
func (r *Room) Name() string { return r.name }

// GameName returns the game this room plays.
func (r *Room) GameName() string { return r.gameName }

// HostID returns the host member id.
func (r *Room) HostID() string { return r.hostID }

// Locked reports whether a join password is required.
func (r *Room) Locked() bool { return r.password != "" }

// CheckPassword reports whether a supplied password unlocks the room.
func (r *Room) CheckPassword(given string) bool { return r.password == given }

// Phase returns the lifecycle state.
func (r *Room) Phase() Phase {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.phase
}

// Count returns the number of connected members.
func (r *Room) Count() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.members)
}

// Join admits a member. An arriving member takes a free seat when the room is in the
// lobby and a seat is open; otherwise they spectate. This is arrival-order seating: who
// plays is decided by when you walked in, not by a challenge.
func (r *Room) Join(id, nickname string) (Member, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if _, exists := r.members[id]; exists {
		return Member{}, ErrAlreadyJoined
	}
	if len(r.members) >= MaxParticipants {
		return Member{}, ErrRoomFull
	}

	r.seq++
	m := &Member{
		ID:        id,
		Nickname:  nickname,
		Seat:      -1,
		Connected: true,
		IsHost:    id == r.hostID,
		JoinedSeq: r.seq,
	}
	r.members[id] = m
	r.order = append(r.order, id)

	// Lobby arrivals fill open seats. Mid-match arrivals always spectate, because
	// dropping a new player into a live board would change the position being played.
	if r.phase == PhaseLobby {
		for seat := 0; seat < SeatCount; seat++ {
			if r.seats[seat] == "" {
				r.seats[seat] = id
				m.Seat = seat
				break
			}
		}
	}
	return *m, nil
}

// Leave removes a member. Leaving a seat vacates it, which is the only event that makes
// a seat available to anyone else. If the host leaves, the room ends.
func (r *Room) Leave(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	m, ok := r.members[id]
	if !ok {
		return ErrNotMember
	}
	r.vacateLocked(m)
	delete(r.members, id)
	for i, existing := range r.order {
		if existing == id {
			r.order = append(r.order[:i], r.order[i+1:]...)
			break
		}
	}
	if id == r.hostID {
		r.phase = PhaseFinished
	}
	return nil
}

// vacateLocked clears a member's seat and abandons any match they were playing.
func (r *Room) vacateLocked(m *Member) {
	// Decide the forfeit before clearing the seat, because the remaining seated player
	// is identified by comparing the table against the leaver.
	if r.phase == PhasePlaying && r.match != nil && m.Seat >= 0 {
		if r.seats[m.Seat] == m.ID {
			r.seats[m.Seat] = ""
		}
		winnerSeat := 1 - m.Seat
		outcome := game.OutcomeSeatTwoWin
		if winnerSeat == 0 {
			outcome = game.OutcomeSeatOneWin
		}
		m.Seat = -1
		r.finishLocked(game.Result{Finished: true, Outcome: outcome, Reason: "forfeit"})
		return
	}
	if m.Seat >= 0 {
		if r.seats[m.Seat] == m.ID {
			r.seats[m.Seat] = ""
		}
		m.Seat = -1
	}
}

// TakeSeat moves a spectator into a specific free seat in the lobby.
func (r *Room) TakeSeat(id string, seat int) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if seat < 0 || seat >= SeatCount {
		return ErrNoSeat
	}
	m, ok := r.members[id]
	if !ok {
		return ErrNotMember
	}
	if r.phase == PhasePlaying {
		return ErrMatchInProgress
	}
	if r.seats[seat] != "" {
		return ErrSeatOccupied
	}
	if m.Seat >= 0 {
		r.seats[m.Seat] = ""
	}
	r.seats[seat] = id
	m.Seat = seat
	return nil
}

// ReleaseSeat returns a seated member to the spectator pool. This is the only way a
// seat changes hands after a match.
func (r *Room) ReleaseSeat(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	m, ok := r.members[id]
	if !ok {
		return ErrNotMember
	}
	if m.Seat < 0 {
		return ErrNotSeated
	}
	if r.phase == PhasePlaying {
		return ErrMatchInProgress
	}
	r.seats[m.Seat] = ""
	m.Seat = -1
	return nil
}

// Start begins a match between the two seat holders.
func (r *Room) Start(now int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.phase == PhasePlaying {
		return ErrMatchInProgress
	}
	if r.seats[0] == "" || r.seats[1] == "" {
		return ErrNoSeat
	}
	engine, err := replay.NewEngine(r.gameName)
	if err != nil {
		return err
	}
	r.match = &Match{
		Engine:    engine,
		Record:    replay.Record{Game: r.gameName},
		Revision:  1,
		StartedAt: now,
	}
	r.phase = PhasePlaying
	return nil
}

// Move applies a move for the given member. Only the seat holder on turn may move,
// and only while a match is running.
func (r *Room) Move(id string, m game.Move, now int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.phase != PhasePlaying || r.match == nil {
		return ErrMatchInProgress
	}
	member, ok := r.members[id]
	if !ok {
		return ErrNotMember
	}
	if member.Seat < 0 {
		return ErrNotSeated
	}
	seat := game.Seat(member.Seat)
	if r.match.Engine.Turn() != seat {
		return ErrNotYourTurn
	}
	if err := r.match.Engine.Apply(m); err != nil {
		return err
	}
	r.match.Record.Moves = append(r.match.Record.Moves, m)
	r.match.Revision++
	r.match.UndoRequestedBy = ""

	if res := r.match.Engine.Result(); res.Finished {
		r.finishLocked(res)
	}
	return nil
}

// finishLocked records the terminal result.
func (r *Room) finishLocked(res game.Result) {
	if r.match == nil {
		return
	}
	r.match.Result = res
	r.match.Finished = true
	r.match.Record.Outcome = res.Outcome
	r.match.Record.Reason = res.Reason
	r.phase = PhaseFinished
	if rep, err := replay.New(r.match.Record); err == nil {
		r.replay = rep
	}
}

// RequestUndo records an undo proposal from a seated player.
func (r *Room) RequestUndo(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.match == nil {
		return ErrMatchInProgress
	}
	m, ok := r.members[id]
	if !ok {
		return ErrNotMember
	}
	if m.Seat < 0 {
		return ErrNotSeated
	}
	if len(r.match.Record.Moves) == 0 {
		return game.ErrNoHistory
	}
	r.match.UndoRequestedBy = id
	return nil
}

// ConsentUndo applies a pending undo when the *other* seated player agrees. The
// proposer cannot approve their own request.
func (r *Room) ConsentUndo(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.match == nil || r.match.UndoRequestedBy == "" {
		return game.ErrNoHistory
	}
	if r.match.UndoRequestedBy == id {
		return errors.New("the proposer cannot consent to their own undo")
	}
	m, ok := r.members[id]
	if !ok {
		return ErrNotMember
	}
	if m.Seat < 0 {
		return ErrNotSeated
	}
	if !r.match.Engine.Undo() {
		return game.ErrNoHistory
	}
	r.match.Record.Moves = r.match.Record.Moves[:len(r.match.Record.Moves)-1]
	r.match.Revision++
	r.match.UndoRequestedBy = ""
	// An undo can revive a finished match, so return to playing.
	r.phase = PhasePlaying
	r.match.Finished = false
	r.match.Result = game.Result{}
	return nil
}

// Resign ends the match in the opponent's favour.
func (r *Room) Resign(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.phase != PhasePlaying || r.match == nil {
		return ErrMatchInProgress
	}
	m, ok := r.members[id]
	if !ok {
		return ErrNotMember
	}
	if m.Seat < 0 {
		return ErrNotSeated
	}
	outcome := game.OutcomeSeatOneWin
	if m.Seat == 0 {
		outcome = game.OutcomeSeatTwoWin
	}
	r.finishLocked(game.Result{Finished: true, Outcome: outcome, Reason: "resign"})
	return nil
}

// Rematch clears a concluded match so the same two players can start again. Seats are
// untouched: rotation happens on vacancy, never on a match ending.
func (r *Room) Rematch() error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.phase == PhasePlaying {
		return ErrMatchInProgress
	}
	r.match = nil
	r.replay = nil
	r.phase = PhaseLobby
	return nil
}

// Replay returns the record of the current or last match, if any. A match that ended
// before a single move (a forfeit or resignation at the opening) is still a record: it
// carries the result, which is what a spectator wants to see.
func (r *Room) Replay() (replay.Record, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.match == nil {
		return replay.Record{}, false
	}
	out := replay.Record{Game: r.match.Record.Game, Outcome: r.match.Record.Outcome, Reason: r.match.Record.Reason}
	out.Moves = make([]game.Move, len(r.match.Record.Moves))
	copy(out.Moves, r.match.Record.Moves)
	return out, true
}

// Seats returns a copy of the seating table.
func (r *Room) Seats() Seats {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.seats
}

// Members returns a snapshot of members in join order.
func (r *Room) Members() []Member {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Member, 0, len(r.order))
	for _, id := range r.order {
		if m, ok := r.members[id]; ok {
			out = append(out, *m)
		}
	}
	return out
}
