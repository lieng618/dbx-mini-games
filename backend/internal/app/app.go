// Package app wires the transport-free Room and LAN layers into the RPC surface the DBX
// host calls. Every method is one participant action or one query; the app owns the
// process-wide session (whether this instance hosts, guestss, or is idle).
package app

import (
	"crypto/ed25519"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/jzj2621899857/dbx-board-games/backend/internal/discovery"
	"github.com/jzj2621899857/dbx-board-games/backend/internal/lan"
	"github.com/jzj2621899857/dbx-board-games/backend/internal/replay"
	"github.com/jzj2621899857/dbx-board-games/backend/internal/room"

	"github.com/jzj2621899857/dbx-board-games/backend/internal/game"
)

// EmitFunc publishes an event to the host.
type EmitFunc func(method string, params any)

// App is the process-wide plugin session.
type App struct {
	mu       sync.RWMutex
	emit     EmitFunc
	dataDir  string
	profile  Profile
	room     *room.Room
	server   *lan.Server
	adv      *discovery.Advertisement
	client   *lan.Client
	ticket   string
	// localID is this machine's member id inside the room it hosts or joined.
	localID  string
	clock    *Clock
	lowMotion bool
}

// Profile is the participant's local identity, persisted in the plugin data directory.
// ID is stable across sessions so reconnecting reclaims the same seat without a ticket
// round trip.
type Profile struct {
	ID        string `json:"id"`
	Nickname  string `json:"nickname"`
	LowMotion bool   `json:"lowMotion"`
}

// New creates the app.
func New(dataDir string, emit EmitFunc) *App {
	a := &App{dataDir: dataDir, emit: emit, profile: Profile{Nickname: "棋友"}}
	a.profile, _ = loadProfile(dataDir)
	if a.profile.ID == "" {
		a.profile.ID = randomID()
		_ = saveProfile(dataDir, a.profile)
	}
	a.lowMotion = a.profile.LowMotion
	return a
}

// Call dispatches one RPC method.
func (a *App) Call(method string, params map[string]any) (any, error) {
	switch method {
	case "profile.get":
		return a.getProfile(), nil
	case "profile.save":
		return a.saveProfile(params)
	case "lobby.scan":
		return a.scan(params)
	case "room.create":
		return a.createRoom(params)
	case "room.join":
		return a.joinRoom(params)
	case "room.snapshot":
		return a.snapshot(), nil
	case "room.start":
		return a.startMatch()
	case "room.practice.start":
		return a.startPractice()
	case "room.practice.end":
		return a.endPractice()
	case "room.seat":
		return a.takeSeat(params)
	case "room.release":
		return a.releaseSeat()
	case "room.leave":
		return a.leaveRoom()
	case "game.move":
		return a.move(params)
	case "game.legal":
		return a.legalMoves(params)
	case "game.undo.request":
		return a.requestUndo()
	case "game.undo.consent":
		return a.consentUndo()
	case "game.resign":
		return a.resign()
	case "game.rematch":
		return a.rematch()
	case "replay.get":
		return a.replayRecord()
	case "replay.notation":
		return a.replayNotation()
	case "replay.state":
		return a.replayState(params)
	default:
		return nil, fmt.Errorf("unknown method %q", method)
	}
}

func (a *App) getProfile() Profile {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.profile
}

func (a *App) saveProfile(params map[string]any) (Profile, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if v, ok := params["nickname"].(string); ok && v != "" {
		a.profile.Nickname = v
	}
	if v, ok := params["lowMotion"].(bool); ok {
		a.profile.LowMotion = v
		a.lowMotion = v
	}
	if err := saveProfile(a.dataDir, a.profile); err != nil {
		return a.profile, err
	}
	return a.profile, nil
}

// scan discovers rooms on the local network. A short window keeps the UI responsive;
// mDNS is best-effort so a missing room is not an error.
func (a *App) scan(params map[string]any) (map[string]any, error) {
	window := 1200 * time.Millisecond
	if v, ok := params["windowMs"].(float64); ok && v > 0 && v <= 5000 {
		window = time.Duration(v) * time.Millisecond
	}
	rooms, err := discovery.Resolve(window)
	if err != nil {
		return nil, err
	}
	sort.Slice(rooms, func(i, j int) bool { return rooms[i].Name < rooms[j].Name })
	return map[string]any{"rooms": rooms}, nil
}

// createRoom hosts a new Room on this machine and advertises it.
func (a *App) createRoom(params map[string]any) (map[string]any, error) {
	name, _ := params["name"].(string)
	gameName, _ := params["game"].(string)
	password, _ := params["password"].(string)
	if name == "" {
		name = "我的棋室"
	}
	if gameName == "" {
		gameName = "xiangqi"
	}

	a.mu.Lock()
	if a.room != nil || a.server != nil {
		a.mu.Unlock()
		return nil, errors.New("already hosting or joined a room")
	}
	hostID := randomID()
	r, err := room.New(room.Options{ID: randomID(), Name: name, Game: gameName, HostID: hostID, Password: password})
	if err != nil {
		a.mu.Unlock()
		return nil, err
	}
	if _, err := r.Join(hostID, a.profile.Nickname); err != nil {
		a.mu.Unlock()
		return nil, err
	}
	srv, err := lan.NewServer(r)
	if err != nil {
		a.mu.Unlock()
		return nil, err
	}
	adv, advErr := discovery.Advertise(r.ID(), name, gameName, srv.Port(), srv.PublicKey(), 1, room.SeatCount, password != "")
	a.room, a.server, a.adv = r, srv, adv
	a.localID = hostID
	a.clock = newClock()
	a.mu.Unlock()

	if advErr != nil {
		// mDNS may be blocked by the OS or the network. The room still works by address,
		// so this is a degraded state, not a failure.
		a.emitSafe("room.notice", map[string]any{"kind": "discovery-unavailable", "message": advErr.Error()})
	}
	return a.snapshot(), nil
}

// joinRoom connects this machine to a remote Room.
func (a *App) joinRoom(params map[string]any) (map[string]any, error) {
	address, _ := params["address"].(string)
	roomID, _ := params["roomId"].(string)
	password, _ := params["password"].(string)
	hostKeyHex, _ := params["hostKey"].(string)
	if address == "" {
		return nil, errors.New("an address is required")
	}

	key, err := hex.DecodeString(hostKeyHex)
	if err != nil || len(key) != ed25519.PublicKeySize {
		return nil, errors.New("a valid host key is required")
	}

	a.mu.Lock()
	if a.client != nil || a.server != nil {
		a.mu.Unlock()
		return nil, errors.New("already connected")
	}
	profile := Profile{ID: a.profile.ID, Nickname: a.profile.Nickname}
	a.mu.Unlock()

	client, err := lan.Join(lan.JoinOptions{
		Address:  address,
		HostKey:  key,
		RoomID:   roomID,
		Profile:  lan.Profile{ID: profile.ID, Nickname: profile.Nickname},
		Password: password,
	})
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	a.client = client
	a.ticket = client.Ticket()
	a.localID = profile.ID
	a.mu.Unlock()
	return a.snapshot(), nil
}

func (a *App) leaveRoom() (map[string]any, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.adv != nil {
		a.adv.Close()
		a.adv = nil
	}
	if a.server != nil {
		_ = a.server.Close()
		a.server = nil
	}
	if a.client != nil {
		_ = a.client.Close()
		a.client = nil
	}
	a.room = nil
	a.ticket = ""
	a.localID = ""
	a.clock = nil
	return map[string]any{"ok": true}, nil
}

// snapshot renders the current session view. A guest reads its own cached snapshot: the
// host is authoritative, so anything else would be a local guess.
func (a *App) snapshot() map[string]any {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if a.room != nil {
		view := map[string]any{
			"role":      "host",
			"selfId":    a.localID,
			"roomId":    a.room.ID(),
			"name":      a.room.Name(),
			"game":      a.room.GameName(),
			"phase":     string(a.room.Phase()),
			"locked":    a.room.Locked(),
			"seats":     a.room.Seats(),
			"members":   a.room.Members(),
			"lowMotion": a.lowMotion,
		}
		if a.server != nil {
			view["port"] = a.server.Port()
			view["hostKey"] = hex.EncodeToString(a.server.PublicKey())
			view["addresses"] = localAddresses(a.server.Port())
		}
		if rec, ok := a.room.Replay(); ok {
			view["record"] = rec
		}
		if a.clock != nil {
			view["clock"] = a.clock.view()
		}
		for k, v := range a.boardViewLocked() {
			view[k] = v
		}
		return view
	}
	if a.client != nil {
		view := map[string]any{"role": "guest", "lowMotion": a.lowMotion}
		for k, v := range a.client.Snapshot {
			view[k] = v
		}
		return view
	}
	return map[string]any{"role": "idle", "lowMotion": a.lowMotion, "profile": a.profile}
}

func (a *App) startMatch() (map[string]any, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.room == nil {
		return nil, errors.New("not hosting a room")
	}
	if err := a.room.Start(time.Now().UnixMilli()); err != nil {
		return nil, err
	}
	if a.clock != nil {
		a.clock.reset(time.Now())
	}
	return a.snapshotLocked(), nil
}

// startPractice opens a solo board so one player can inspect the table and its effects
// before anyone else arrives.
func (a *App) startPractice() (map[string]any, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.room == nil {
		return nil, errors.New("not hosting a room")
	}
	if err := a.room.StartPractice(time.Now().UnixMilli()); err != nil {
		return nil, err
	}
	return a.snapshotLocked(), nil
}

// endPractice discards the solo board and returns to the lobby.
func (a *App) endPractice() (map[string]any, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.room == nil {
		return nil, errors.New("not hosting a room")
	}
	a.room.EndPractice()
	return a.snapshotLocked(), nil
}

func (a *App) takeSeat(params map[string]any) (map[string]any, error) {
	seat := -1
	if v, ok := params["seat"].(float64); ok {
		seat = int(v)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.room == nil {
		return nil, errors.New("not hosting a room")
	}
	if err := a.room.TakeSeat(a.localID, seat); err != nil {
		return nil, err
	}
	return a.snapshotLocked(), nil
}

func (a *App) releaseSeat() (map[string]any, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.room == nil {
		return nil, errors.New("not hosting a room")
	}
	if err := a.room.ReleaseSeat(a.localID); err != nil {
		return nil, err
	}
	return a.snapshotLocked(), nil
}

func (a *App) move(params map[string]any) (map[string]any, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.room == nil {
		return nil, errors.New("not hosting a room")
	}
	m := game.Move{From: -1, To: -1}
	if v, ok := params["from"].(float64); ok {
		m.From = int(v)
	}
	if v, ok := params["to"].(float64); ok {
		m.To = int(v)
	}
	var err error
	if a.room.Practice() {
		err = a.room.PracticeMove(a.localID, m)
	} else {
		err = a.room.Move(a.localID, m, time.Now().UnixMilli())
	}
	if err != nil {
		return nil, err
	}
	if a.clock != nil && a.room.Phase() == room.PhasePlaying {
		a.clock.switchTurn(time.Now())
	}
	return a.snapshotLocked(), nil
}

func (a *App) legalMoves(params map[string]any) (map[string]any, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.room == nil {
		return nil, errors.New("not hosting a room")
	}
	from := -1
	if v, ok := params["from"].(float64); ok {
		from = int(v)
	}
	rec, ok := a.room.Replay()
	if !ok {
		return map[string]any{"destinations": []int{}}, nil
	}
	engine, err := replay.NewEngine(rec.Game)
	if err != nil {
		return nil, err
	}
	for _, m := range rec.Moves {
		if err := engine.Apply(m); err != nil {
			return nil, err
		}
	}
	return map[string]any{"destinations": engine.LegalFrom(from)}, nil
}

func (a *App) requestUndo() (map[string]any, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.room == nil {
		return nil, errors.New("not hosting a room")
	}
	if err := a.room.RequestUndo(a.localID); err != nil {
		return nil, err
	}
	return a.snapshotLocked(), nil
}

func (a *App) consentUndo() (map[string]any, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.room == nil {
		return nil, errors.New("not hosting a room")
	}
	if err := a.room.ConsentUndo(a.localID); err != nil {
		return nil, err
	}
	return a.snapshotLocked(), nil
}

func (a *App) resign() (map[string]any, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.room == nil {
		return nil, errors.New("not hosting a room")
	}
	if err := a.room.Resign(a.localID); err != nil {
		return nil, err
	}
	return a.snapshotLocked(), nil
}

func (a *App) rematch() (map[string]any, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.room == nil {
		return nil, errors.New("not hosting a room")
	}
	if err := a.room.Rematch(); err != nil {
		return nil, err
	}
	return a.snapshotLocked(), nil
}

func (a *App) replayRecord() (map[string]any, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if a.room == nil {
		return nil, errors.New("not hosting a room")
	}
	rec, ok := a.room.Replay()
	if !ok {
		return map[string]any{"record": nil}, nil
	}
	return map[string]any{"record": rec}, nil
}

func (a *App) replayNotation() (map[string]any, error) {
	a.mu.RLock()
	if a.room == nil {
		a.mu.RUnlock()
		return nil, errors.New("not hosting a room")
	}
	rec, ok := a.room.Replay()
	a.mu.RUnlock()
	if !ok {
		return map[string]any{"notation": []string{}}, nil
	}
	rp, err := replay.New(rec)
	if err != nil {
		return nil, err
	}
	notes, err := rp.Notation()
	if err != nil {
		return nil, err
	}
	return map[string]any{"notation": notes}, nil
}


// boardView renders the authoritative board for a snapshot.
//
// A room in the lobby still shows its opening position: the table should look ready before
// anyone starts, and a player needs to see where their pieces are.
func (a *App) boardViewLocked() map[string]any {
	engine, err := replay.NewEngine(a.room.GameName())
	if err != nil {
		return map[string]any{}
	}
	var lastMove *game.Move
	if rec, ok := a.room.Replay(); ok {
		for i, m := range rec.Moves {
			if err := engine.Apply(m); err != nil {
				break
			}
			if i == len(rec.Moves)-1 {
				applied := m
				lastMove = &applied
			}
		}
	}
	view := map[string]any{
		"cells":    engine.Cells(),
		"turnSeat": int(engine.Turn()),
	}
	// Last move and check state drive the presentation layer's effects. They are derived
	// from authoritative state, so a spectator sees the same ink as the player.
	if lastMove != nil {
		view["lastMove"] = map[string]any{"from": lastMove.From, "to": lastMove.To}
	}
	// Check is only meaningful once a match is under way, and only for games that have a
	// king to threaten.
	if a.room.Phase() == room.PhasePlaying || a.room.Phase() == room.PhasePractice {
		if reporter, ok := engine.(game.CheckReporter); ok {
			seat := engine.Turn()
			if reporter.InCheck(seat) {
				view["inCheck"] = true
				view["checkFocus"] = reporter.KingSquare(seat)
			}
		}
	}
	if a.room.Phase() == room.PhasePlaying || a.room.Phase() == room.PhasePractice {
		if res := engine.Result(); res.Finished {
			view["result"] = map[string]any{
				"finished": true,
				"outcome":  int(res.Outcome),
				"reason":   res.Reason,
			}
		}
	}
	return view
}

// replayState returns the position at a given ply of the recorded match.
//
// The client drives a scrubber, so each request is stateless: it rebuilds the position by
// replaying the prefix. That keeps the sidecar free of per-viewer cursor state.
func (a *App) replayState(params map[string]any) (map[string]any, error) {
	a.mu.RLock()
	roomRef := a.room
	a.mu.RUnlock()
	if roomRef == nil {
		return nil, errors.New("not hosting a room")
	}
	rec, ok := roomRef.Replay()
	if !ok {
		return nil, errors.New("no match has been played yet")
	}
	ply := 0
	if v, ok := params["ply"].(float64); ok {
		ply = int(v)
	}
	rp, err := replay.New(rec)
	if err != nil {
		return nil, err
	}
	if err := rp.Seek(ply); err != nil {
		return nil, err
	}
	state := rp.State()
	notes, _ := rp.Notation()
	return map[string]any{
		"ply":      state.Cursor,
		"total":    state.Total,
		"cells":    state.Cells,
		"turnSeat": int(state.Seat),
		"notation": notes,
		"lastMove": state.LastMove,
		"result":   state.Result,
	}, nil
}

// snapshotLocked renders a snapshot while the caller already holds the lock.
func (a *App) snapshotLocked() map[string]any {
	view := map[string]any{
		"role":      "host",
		"selfId":    a.localID,
		"roomId":    a.room.ID(),
		"name":      a.room.Name(),
		"game":      a.room.GameName(),
		"phase":     string(a.room.Phase()),
		"locked":    a.room.Locked(),
		"seats":     a.room.Seats(),
		"members":   a.room.Members(),
		"lowMotion": a.lowMotion,
	}
	if a.server != nil {
		view["port"] = a.server.Port()
		view["hostKey"] = hex.EncodeToString(a.server.PublicKey())
		view["addresses"] = localAddresses(a.server.Port())
	}
	if rec, ok := a.room.Replay(); ok {
		view["record"] = rec
	}
	if a.clock != nil {
		view["clock"] = a.clock.view()
	}
	for k, v := range a.boardViewLocked() {
		view[k] = v
	}
	return view
}

func (a *App) emitSafe(method string, params any) {
	a.mu.RLock()
	emit := a.emit
	a.mu.RUnlock()
	if emit != nil {
		emit(method, params)
	}
}
