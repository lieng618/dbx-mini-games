// Package app wires the transport-free Room and LAN layers into the RPC surface the DBX
// host calls. Every method is one participant action or one query; the app owns the
// process-wide session (whether this instance hosts, guestss, or is idle).
package app

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/lieng618/dbx-mini-games/backend/internal/ai"
	"github.com/lieng618/dbx-mini-games/backend/internal/discovery"
	"github.com/lieng618/dbx-mini-games/backend/internal/lan"
	"github.com/lieng618/dbx-mini-games/backend/internal/replay"
	"github.com/lieng618/dbx-mini-games/backend/internal/room"

	"github.com/lieng618/dbx-mini-games/backend/internal/game"
)

// EmitFunc publishes an event to the host.
type EmitFunc func(method string, params any)

// App is the process-wide plugin session.
type App struct {
	mu      sync.RWMutex
	emit    EmitFunc
	dataDir string
	profile Profile
	room    *room.Room
	server  *lan.Server
	adv     *discovery.Advertisement
	client  *lan.Client
	ticket  string
	// localID is this machine's member id inside the room it hosts or joined.
	localID   string
	clock     *Clock
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

// enforceTimeout ends a match whose clock has run out.
//
// The host owns the clock, so this is the only place wall-clock time can end a game — the
// room itself never reads a clock, which is what keeps a match replayable from its moves.
// It runs before every call, so a client that is merely polling snapshots still gets the
// timeout applied; the UI polls once a second while a clock is running.
func (a *App) enforceTimeout() {
	a.mu.Lock()
	ended := false
	if a.room != nil && a.clock != nil && a.room.Phase() == room.PhasePlaying {
		if seat := a.clock.TimeoutSeat(); seat >= 0 {
			if err := a.room.Timeout(seat); err == nil {
				ended = true
			}
		}
	}
	a.mu.Unlock()
	// Broadcasting takes the lock again, so it cannot happen above.
	if ended {
		a.pushState()
	}
}

// Call dispatches one RPC method.
func (a *App) Call(method string, params map[string]any) (any, error) {
	a.enforceTimeout()
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
	case "room.start", "room.practice.start", "room.practice.end",
		"room.ai.start", "room.ai.move",
		"room.seat", "room.release",
		"game.move", "game.undo.request", "game.undo.consent", "game.resign", "game.rematch":
		return a.act(method, params)
	case "room.leave":
		return a.leaveRoom()
	case "game.legal":
		return a.legalMoves(params)
	case "replay.get":
		return a.replayRecord()
	case "replay.notation":
		return a.replayNotation()
	case "replay.state":
		return a.replayState(params)
	case "dev.scenario":
		return a.devScenario(params)
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
	minutes, _ := params["minutes"].(float64)
	moveSeconds, _ := params["moveSeconds"].(float64)
	hostSeat := -1
	if seat, ok := params["seat"].(float64); ok && (seat == 0 || seat == 1) {
		hostSeat = int(seat)
	}
	if name == "" {
		name = "我的棋室"
	}
	if gameName == "" {
		gameName = "xiangqi"
	}

	// Time control. A negative or absurd value is clamped rather than rejected: the host
	// is picking a number from a form, and a bad number should not cost them the room.
	if minutes < 0 {
		minutes = 0
	}
	if minutes > 180 {
		minutes = 180
	}
	if moveSeconds < 0 {
		moveSeconds = 0
	}
	if moveSeconds > 600 {
		moveSeconds = 600
	}
	// Zero means unlimited for both limits; the default total only applies when the caller
	// did not ask for time control at all.
	budget := time.Duration(minutes * float64(time.Minute))
	if _, given := params["minutes"]; !given {
		budget = DefaultBudget
	}
	perMove := time.Duration(moveSeconds * float64(time.Second))

	a.mu.Lock()
	if a.room != nil || a.server != nil {
		a.mu.Unlock()
		return nil, errors.New("already hosting or joined a room")
	}
	hostID := randomID()
	r, err := room.New(room.Options{
		ID: randomID(), Name: name, Game: gameName, HostID: hostID,
		Password: password, HostSeat: hostSeat,
	})
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
	// Guests hold no authority: every action they take is a request the host applies.
	srv.SetRequestHandler(func(memberID, method string, params json.RawMessage) (any, error) {
		return a.serveGuest(memberID, method, params)
	})
	// A guest joining or leaving changes the seats. The lobby only offers "start" once it
	// sees both seats filled, so without this push the host stares at an empty table while
	// a challenger who already sat down waits for a match that never opens.
	srv.SetMembershipHandler(a.notifyMembershipChanged)

	a.room, a.server, a.adv = r, srv, adv
	a.localID = hostID
	a.clock = newClock(budget, perMove)
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

	// The host pushes state on every change. Forward each push to this window: a guest that
	// is not itself acting — waiting for the host to start, or for the opponent to move —
	// would otherwise never repaint, because a guest never polls.
	client.OnState(func(map[string]any) {
		a.emitSafe("room.state", map[string]any{"reason": "push"})
	})
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
			"role":    "host",
			"selfId":  a.localID,
			"roomId":  a.room.ID(),
			"name":    a.room.Name(),
			"game":    a.room.GameName(),
			"phase":   string(a.room.Phase()),
			"locked":  a.room.Locked(),
			"seats":   a.room.Seats(),
			"members": a.room.Members(),
			// The partner's seat. There are three snapshot builders and all three have to
			// carry it, or the UI only learns about the partner on some code paths.
			"aiSeat":    a.room.AISeat(),
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
		for k, v := range a.client.Snapshot() {
			view[k] = v
		}
		return view
	}
	return map[string]any{"role": "idle", "lowMotion": a.lowMotion, "profile": a.profile}
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
	// A finished match still reports its result. The phase moves to finished inside the very
	// move that ends the match, so gating on "playing or practice" hid the win screen while
	// dragging the replay cursor — which reads the result from the record — still showed it.
	// Only the lobby has nothing to report.
	if a.room.Phase() != room.PhaseLobby {
		if res := engine.Result(); res.Finished {
			view["result"] = map[string]any{
				"finished": true,
				"outcome":  int(res.Outcome),
				"reason":   res.Reason,
			}
			// A winning line lets the presentation draw through the stones that ended the
			// match instead of guessing where the seal belongs.
			if reporter, ok := engine.(game.WinLineReporter); ok {
				if line := reporter.WinLine(); len(line) > 0 {
					view["winLine"] = line
				}
			}
		}
	}
	return view
}

// devScenario applies a named sequence of moves to the practice board.
//
// This exists so the presentation layer can be exercised without someone playing a real
// match to reach a capture, a check, or a five-in-a-row. It is only reachable on a
// practice board: a live match is never scripted.
func (a *App) devScenario(params map[string]any) (map[string]any, error) {
	name, _ := params["name"].(string)
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.room == nil {
		return nil, errors.New("not hosting a room")
	}
	if !a.room.Practice() {
		return nil, errors.New("scenarios only run on a practice board")
	}
	moves, ok := scenarioMoves(a.room.GameName(), name)
	if !ok {
		return nil, fmt.Errorf("unknown scenario %q for %s", name, a.room.GameName())
	}
	// Restart the practice board first: a scenario describes a position from the opening,
	// so replaying it on top of an existing line would be illegal and confusing.
	a.room.EndPractice()
	if err := a.room.StartPractice(time.Now().UnixMilli()); err != nil {
		return nil, err
	}
	for _, m := range moves {
		if err := a.room.PracticeMove(a.localID, m); err != nil {
			return nil, err
		}
	}
	if a.clock != nil {
		a.clock.switchTurn(time.Now())
	}
	return a.snapshotLocked(), nil
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

// act performs one state-changing action on the authoritative room.
//
// A host applies it locally; a guest forwards it to the host and adopts the returned
// snapshot. Guests hold no authority, so there is exactly one implementation of every
// rule and it lives on the host.
func (a *App) act(method string, params map[string]any) (map[string]any, error) {
	a.mu.RLock()
	client := a.client
	a.mu.RUnlock()

	if client != nil {
		result, err := client.Call(method, params)
		if err != nil {
			return nil, err
		}
		return a.snapshot(), nilHelper(result)
	}

	a.mu.Lock()
	if a.room == nil {
		a.mu.Unlock()
		return nil, errors.New("not hosting a room")
	}
	err := a.applyHostAction(method, params)
	view := a.snapshotLocked()
	a.mu.Unlock()
	if err != nil {
		return nil, err
	}
	// Guests are told about the change after the host's own state is settled, so a push
	// never arrives describing a half-applied action.
	a.pushState()
	return view, nil
}

// nilHelper exists only to keep act's return shape uniform; it always returns nil.
func nilHelper(any) error { return nil }

// applyHostAction mutates the room for one action. The caller holds the lock.
func (a *App) applyHostAction(method string, params map[string]any) error {
	seatOf := func() int {
		for index, id := range a.room.Seats() {
			if id == a.localID {
				return index
			}
		}
		return -1
	}
	needSeat := func() error {
		if seatOf() < 0 {
			return errors.New("only seated players may do that")
		}
		return nil
	}

	switch method {
	case "room.seat":
		seat := -1
		if v, ok := params["seat"].(float64); ok {
			seat = int(v)
		}
		return a.room.TakeSeat(a.localID, seat)
	case "room.release":
		return a.room.ReleaseSeat(a.localID)
	case "room.start":
		if err := needSeat(); err != nil {
			return err
		}
		if err := a.room.Start(time.Now().UnixMilli()); err != nil {
			return err
		}
		if a.clock != nil {
			a.clock.reset(time.Now())
		}
		return nil
	case "room.practice.start":
		if err := needSeat(); err != nil {
			return err
		}
		return a.room.StartPractice(time.Now().UnixMilli())
	case "room.practice.end":
		a.room.EndPractice()
		return nil
	case "room.ai.start":
		if err := needSeat(); err != nil {
			return err
		}
		return a.room.StartPracticeVsAI(time.Now().UnixMilli())
	case "room.ai.move":
		// The partner answers in its own call, not inside the player's move. One snapshot
		// carrying both moves diffs as a rebuild, and the pair would teleport instead of
		// animating — the same trap that used to hide capture effects.
		if a.room.AISeat() < 0 {
			return room.ErrNoSeatedPlayer
		}
		engine := a.room.EngineForThinking()
		if engine == nil {
			return room.ErrNoSeatedPlayer
		}
		move, ok := ai.BestMove(engine)
		if !ok {
			return nil
		}
		return a.room.AIMove(move)
	case "game.move":
		if err := needSeat(); err != nil {
			return err
		}
		m := game.Move{From: -1, To: -1}
		if v, ok := params["from"].(float64); ok {
			m.From = int(v)
		}
		if v, ok := params["to"].(float64); ok {
			m.To = int(v)
		}
		if a.room.Practice() {
			if err := a.room.PracticeMove(a.localID, m); err != nil {
				return err
			}
			return nil
		}
		if err := a.room.Move(a.localID, m, time.Now().UnixMilli()); err != nil {
			return err
		}
		if a.clock != nil && a.room.Phase() == room.PhasePlaying {
			a.clock.switchTurn(time.Now())
		}
		return nil
	case "game.undo.request":
		if err := needSeat(); err != nil {
			return err
		}
		return a.room.RequestUndo(a.localID)
	case "game.undo.consent":
		if err := needSeat(); err != nil {
			return err
		}
		return a.room.ConsentUndo(a.localID)
	case "game.resign":
		if err := needSeat(); err != nil {
			return err
		}
		return a.room.Resign(a.localID)
	case "game.rematch":
		return a.room.Rematch()
	default:
		return fmt.Errorf("unknown action %q", method)
	}
}

// serveGuest applies one request that arrived from a guest over the LAN connection.
//
// The member id comes from the authenticated connection, never from the payload, so a
// guest cannot act as somebody else.
func (a *App) serveGuest(memberID, method string, params json.RawMessage) (any, error) {
	decoded := map[string]any{}
	if len(params) > 0 {
		if err := json.Unmarshal(params, &decoded); err != nil {
			return nil, errors.New("request parameters are not valid JSON")
		}
	}

	a.mu.Lock()
	if a.room == nil {
		a.mu.Unlock()
		return nil, errors.New("the host has no open room")
	}
	// Act on behalf of the requesting guest, then restore the host's own identity.
	previous := a.localID
	a.localID = memberID
	err := a.applyHostAction(method, decoded)
	a.localID = previous
	a.mu.Unlock()

	if err != nil {
		return nil, err
	}

	a.pushState()
	return map[string]any{"ok": true}, nil
}

// pushState sends the current snapshot to every connected guest.
func (a *App) pushState() {
	a.mu.RLock()
	server := a.server
	a.mu.RUnlock()
	if server == nil {
		return
	}
	server.Broadcast(func(memberID string) any {
		return a.snapshotForMember(memberID)
	})
}

// notifyMembershipChanged refreshes both sides after somebody joins or leaves.
//
// Guests are told through a state push; the host's own window is told through an event,
// because it only folds snapshots that come back from its own calls. Seat occupancy is
// the one room fact that changes with no local action to ride along with, so it needs an
// explicit wake-up on both pathways.
func (a *App) notifyMembershipChanged() {
	a.pushState()
	a.emitSafe("room.members", map[string]any{"reason": "membership"})
}

// snapshotForMember renders the room view as seen by one participant.
func (a *App) snapshotForMember(memberID string) map[string]any {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if a.room == nil {
		return map[string]any{"role": "guest"}
	}
	view := map[string]any{
		"role":    "guest",
		"selfId":  memberID,
		"roomId":  a.room.ID(),
		"name":    a.room.Name(),
		"game":    a.room.GameName(),
		"phase":   string(a.room.Phase()),
		"locked":  a.room.Locked(),
		"seats":   a.room.Seats(),
		"members": a.room.Members(),
		// The partner's seat, so the UI can label it and refuse moves made on its behalf.
		"aiSeat":    a.room.AISeat(),
		"lowMotion": a.lowMotion,
	}
	if rec, ok := a.room.Replay(); ok {
		view["record"] = rec
	}
	// Guests see the same countdown the host does. Without it the seat clocks never tick on
	// their side and their win panel has no clock to report.
	if a.clock != nil {
		view["clock"] = a.clock.view()
	}
	for k, v := range a.boardViewLocked() {
		view[k] = v
	}
	return view
}

// snapshotLocked renders a snapshot while the caller already holds the lock.
func (a *App) snapshotLocked() map[string]any {
	view := map[string]any{
		"role":    "host",
		"selfId":  a.localID,
		"roomId":  a.room.ID(),
		"name":    a.room.Name(),
		"game":    a.room.GameName(),
		"phase":   string(a.room.Phase()),
		"locked":  a.room.Locked(),
		"seats":   a.room.Seats(),
		"members": a.room.Members(),
		// The partner's seat, so the UI can label it and refuse moves made on its behalf.
		"aiSeat":    a.room.AISeat(),
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
