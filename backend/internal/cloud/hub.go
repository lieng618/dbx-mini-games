package cloud

import (
	"crypto/rand"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/lieng618/dbx-mini-games/backend/internal/game"
	"github.com/lieng618/dbx-mini-games/backend/internal/replay"
	"github.com/lieng618/dbx-mini-games/backend/internal/room"
)

const (
	defaultBudget       = 10 * time.Minute
	maxBudget           = 180 * time.Minute
	maxMoveTime         = 10 * time.Minute
	undoDecisionTimeout = 20 * time.Second
	maxNameRunes        = 32
	maxRooms            = 250
	lobbyEventName      = "lobby.updated"
	roomEventName       = "room.state"
	emoteEventName      = "room.emote"
	emoteCooldown       = 3 * time.Second
)

var roomEmoteIDs = map[string]struct{}{
	"smug":   {},
	"hurry":  {},
	"tea":    {},
	"praise": {},
	"crack":  {},
	"next":   {},
}

type clientState struct {
	id              string
	nickname        string
	lobby           bool
	roomID          string
	send            func(method string, params any)
	timer           *time.Timer
	connectionToken string
	lastEmote       time.Time
}

type cloudRoom struct {
	room         *room.Room
	ownerID      string
	createdAt    time.Time
	startedAt    time.Time
	finished     time.Time
	undoDeadline time.Time
	swapDeadline time.Time
	clock        *matchClock
}

// Hub is the in-memory public lobby. No user, room, or match data is persisted.
type Hub struct {
	mu        sync.Mutex
	clients   map[string]*clientState
	rooms     map[string]*cloudRoom
	clockOnce sync.Once
}

func NewHub() *Hub {
	return &Hub{
		clients: map[string]*clientState{},
		rooms:   map[string]*cloudRoom{},
	}
}

// AddClient registers one live WebSocket session and returns its ephemeral identity.
func (h *Hub) AddClient(requestedID, nickname string, send func(string, any)) (string, string) {
	id, resolvedNickname, _ := h.AddClientSession(requestedID, nickname, send)
	return id, resolvedNickname
}

// AddClientSession also returns a connection generation. A late cleanup from an older
// socket or poll request must not detach the replacement session that reused the same id.
func (h *Hub) AddClientSession(requestedID, nickname string, send func(string, any)) (string, string, string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	id := sanitizeID(requestedID)
	if id == "" {
		id = randomID()
	}
	nickname, nicknameErr := validateNickname(nickname)
	if nicknameErr != nil {
		nickname = "棋友-" + id[:4]
	}
	connectionToken := randomID()
	if existing := h.clients[id]; existing != nil {
		if existing.timer != nil {
			existing.timer.Stop()
			existing.timer = nil
		}
		existing.send = send
		existing.nickname = nickname
		existing.connectionToken = connectionToken
		if record := h.rooms[existing.roomID]; record != nil {
			record.room.SetConnected(id, true)
			h.notifyRoomLocked(record)
		}
		return id, nickname, connectionToken
	}
	h.clients[id] = &clientState{
		id:              id,
		nickname:        nickname,
		lobby:           true,
		send:            send,
		connectionToken: connectionToken,
	}
	return id, nickname, connectionToken
}

// RemoveClient keeps the seat for a short reconnect window. The public network is less
// stable than a LAN socket, so a brief drop should not forfeit a live game immediately.
func (h *Hub) RemoveClient(clientID string) {
	h.RemoveClientSession(clientID, "")
}

// RemoveClientSession only detaches the connection generation that stopped. A reconnect
// can legitimately replace it while an old socket is still unwinding.
func (h *Hub) RemoveClientSession(clientID, connectionToken string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	client := h.clients[clientID]
	if client == nil || client.timer != nil {
		return
	}
	if connectionToken != "" && client.connectionToken != connectionToken {
		return
	}
	client.send = nil
	if record := h.rooms[client.roomID]; record != nil {
		record.room.SetConnected(clientID, false)
		h.notifyRoomLocked(record)
	}
	h.notifyLobbyLocked()
	client.timer = time.AfterFunc(25*time.Second, func() {
		h.expireClientSession(clientID, connectionToken)
	})
}

func (h *Hub) expireClient(clientID string) {
	h.expireClientSession(clientID, "")
}

func (h *Hub) expireClientSession(clientID, connectionToken string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	client := h.clients[clientID]
	if client == nil || client.send != nil {
		return
	}
	if connectionToken != "" && client.connectionToken != connectionToken {
		return
	}
	h.leaveRoomLocked(client)
	delete(h.clients, clientID)
	h.notifyLobbyLocked()
}

func (h *Hub) Call(clientID, method string, params map[string]any) (any, error) {
	return h.CallSession(clientID, "", method, params)
}

// CallSession accepts a request only from the current connection generation. Replacing
// an old socket or poll session must also revoke its authority to act for the seat.
func (h *Hub) CallSession(clientID, connectionToken, method string, params map[string]any) (any, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.expireClocksLocked(time.Now())

	client := h.clients[clientID]
	if client == nil {
		return nil, errors.New("session is not connected")
	}
	if connectionToken != "" && client.connectionToken != connectionToken {
		return nil, errors.New("session was replaced by a newer connection")
	}

	switch method {
	case "profile.get":
		return map[string]any{"id": client.id, "nickname": client.nickname}, nil
	case "profile.save":
		nickname, err := validateNickname(stringParam(params, "nickname"))
		if err != nil {
			return nil, err
		}
		client.nickname = nickname
		if record := h.rooms[client.roomID]; record != nil {
			record.room.SetNickname(client.id, nickname)
			if record.ownerID == client.id {
				suffix := "的象棋室"
				if record.room.GameName() == "gomoku" {
					suffix = "的五子棋室"
				}
				record.room.SetName(nickname + suffix)
				h.notifyLobbyLocked()
			}
			h.notifyRoomLocked(record)
		}
		return map[string]any{"id": client.id, "nickname": client.nickname}, nil
	case "lobby.subscribe":
		client.lobby = true
		h.notifyLobbyLocked()
		return map[string]any{"ok": true, "online": h.lobbyClientCountLocked()}, nil
	case "lobby.list", "lobby.scan":
		return h.lobbyPayloadLocked(time.Now()), nil
	case "room.snapshot":
		if record := h.rooms[client.roomID]; record != nil {
			return h.snapshotLocked(record, client.id, time.Now()), nil
		}
		return map[string]any{
			"role":     "idle",
			"selfId":   client.id,
			"nickname": client.nickname,
			"serverAt": time.Now().UnixMilli(),
		}, nil
	case "room.create":
		return h.createRoomLocked(client, params)
	case "room.join":
		return h.joinRoomLocked(client, params)
	case "room.leave":
		h.leaveRoomLocked(client)
		h.notifyLobbyLocked()
		return map[string]any{"role": "idle"}, nil
	case "room.emote":
		return h.emoteLocked(client, params, time.Now())
	case "room.start", "room.seat", "room.release",
		"room.swap.request", "room.swap.consent", "room.swap.decline", "room.practice.start",
		"room.practice.end", "room.ai.start", "room.ai.move",
		"game.move", "game.undo.request", "game.undo.consent", "game.undo.decline",
		"game.resign", "game.rematch":
		return h.actLocked(client, method, params)
	case "game.legal":
		return h.legalLocked(client, params)
	default:
		return nil, fmt.Errorf("unknown method %q", method)
	}
}

// startClockLoop makes room clocks authoritative even when nobody sends another request.
// A turn that runs out of time must end the match without waiting for a move attempt.
func (h *Hub) startClockLoop() {
	h.clockOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(500 * time.Millisecond)
			defer ticker.Stop()
			for now := range ticker.C {
				h.expireClocks(now)
			}
		}()
	})
}

func (h *Hub) expireClocks(now time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.expireClocksLocked(now)
}

func (h *Hub) expireClocksLocked(now time.Time) {
	var undoExpired []*cloudRoom
	var swapExpired []*cloudRoom
	var clockExpired []*cloudRoom
	for _, record := range h.rooms {
		if !record.undoDeadline.IsZero() && !now.Before(record.undoDeadline) {
			proposer, _ := record.room.UndoRequest()
			if proposer != "" {
				for _, member := range record.room.Members() {
					if member.IsSeated() && member.ID != proposer {
						if err := record.room.DeclineUndo(member.ID); err == nil {
							record.undoDeadline = time.Time{}
							record.clock.resume(now, record.room.TurnSeat(), false)
							undoExpired = append(undoExpired, record)
						}
						break
					}
				}
			} else {
				record.undoDeadline = time.Time{}
			}
		}
		if !record.swapDeadline.IsZero() && !now.Before(record.swapDeadline) {
			proposer, _ := record.room.SwapRequest()
			if proposer != "" {
				for _, member := range record.room.Members() {
					if member.IsSeated() && member.ID != proposer {
						if err := record.room.DeclineSwap(member.ID); err == nil {
							record.swapDeadline = time.Time{}
							swapExpired = append(swapExpired, record)
						}
						break
					}
				}
			} else {
				record.swapDeadline = time.Time{}
			}
		}
		if record.room.Phase() != room.PhasePlaying {
			continue
		}
		seat := record.clock.expiredSeat(now)
		if seat < 0 {
			continue
		}
		if err := record.room.Timeout(seat); err != nil {
			continue
		}
		record.finished = now
		record.clock.stop(now)
		record.undoDeadline = time.Time{}
		clockExpired = append(clockExpired, record)
	}
	if len(undoExpired) == 0 && len(swapExpired) == 0 && len(clockExpired) == 0 {
		return
	}
	for _, record := range undoExpired {
		h.notifyRoomLocked(record)
	}
	for _, record := range swapExpired {
		h.notifyRoomLocked(record)
	}
	for _, record := range clockExpired {
		h.notifyRoomLocked(record)
	}
	if len(clockExpired) > 0 {
		h.notifyLobbyLocked()
	}
}

func (h *Hub) Stats() map[string]any {
	h.mu.Lock()
	defer h.mu.Unlock()
	playing := 0
	for _, record := range h.rooms {
		if record.room.Phase() == room.PhasePlaying {
			playing++
		}
	}
	return map[string]any{
		"clients": len(h.clients),
		"rooms":   len(h.rooms),
		"playing": playing,
	}
}

// LobbySnapshot is the public read-only room index used by /api/lobby.
func (h *Hub) LobbySnapshot() map[string]any {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.lobbyPayloadLocked(time.Now())
}

func (h *Hub) createRoomLocked(client *clientState, params map[string]any) (any, error) {
	if client.roomID != "" {
		return nil, errors.New("leave the current room before creating another")
	}
	if len(h.rooms) >= maxRooms {
		return nil, errors.New("server room capacity reached")
	}

	name := sanitizeName(stringParam(params, "name"))
	gameName := stringParam(params, "game")
	if gameName == "" {
		gameName = "xiangqi"
	}
	if name == "" {
		if gameName == "xiangqi" {
			name = client.nickname + "象棋室"
		} else {
			name = client.nickname + "五子棋室"
		}
	}
	hostSeat := intParam(params, "seat", -1)
	if hostSeat != 0 && hostSeat != 1 {
		hostSeat = -1
	}

	record := &cloudRoom{
		ownerID:   client.id,
		createdAt: time.Now(),
	}
	record.clock = newMatchClock(parseBudget(params), parseMoveTime(params))

	created, err := room.New(room.Options{
		ID:         randomID(),
		Name:       name,
		Game:       gameName,
		HostID:     client.id,
		Password:   stringParam(params, "password"),
		HostSeat:   hostSeat,
		TrackScore: boolParam(params, "trackScore"),
	})
	if err != nil {
		return nil, err
	}
	if _, err := created.Join(client.id, client.nickname); err != nil {
		return nil, err
	}
	record.room = created
	h.rooms[created.ID()] = record
	client.roomID = created.ID()
	client.lobby = false
	h.notifyLobbyLocked()
	return h.snapshotLocked(record, client.id, time.Now()), nil
}

func (h *Hub) joinRoomLocked(client *clientState, params map[string]any) (any, error) {
	if client.roomID != "" {
		return nil, errors.New("you are already in a room")
	}
	roomID := stringParam(params, "roomId")
	record := h.rooms[roomID]
	if record == nil {
		return nil, errors.New("room no longer exists")
	}
	role := stringParam(params, "role")
	if (role == "spectator" || role == "watch") && record.room.Phase() != room.PhasePlaying {
		return nil, errors.New("spectating is only available while a match is in progress")
	}
	if record.room.Locked() && !record.room.CheckPassword(stringParam(params, "password")) {
		return nil, errors.New("wrong room password")
	}

	var (
		member room.Member
		err    error
	)
	if role == "spectator" || role == "watch" {
		member, err = record.room.JoinSpectator(client.id, client.nickname)
	} else if role == "auto" && !roomHasOpenLobbySeat(record.room) {
		// A shared room link should still get the visitor into the room when both seats
		// are occupied. The explicit spectator action remains limited to live matches.
		member, err = record.room.JoinSpectator(client.id, client.nickname)
	} else {
		member, err = record.room.Join(client.id, client.nickname)
	}
	if err != nil {
		return nil, err
	}
	client.roomID = roomID
	client.lobby = false
	h.notifyLobbyLocked()
	h.notifyRoomLocked(record)
	return h.snapshotForMemberLocked(record, client.id, member, time.Now()), nil
}

func roomHasOpenLobbySeat(r *room.Room) bool {
	if r.Phase() != room.PhaseLobby {
		return false
	}
	for _, seat := range r.Seats() {
		if seat == "" {
			return true
		}
	}
	return false
}

func (h *Hub) leaveRoomLocked(client *clientState) {
	record := h.rooms[client.roomID]
	if record == nil {
		client.roomID = ""
		client.lobby = true
		return
	}
	wasPlaying := record.room.Phase() == room.PhasePlaying
	_ = record.room.LeaveForCloud(client.id)
	record.undoDeadline = time.Time{}
	record.swapDeadline = time.Time{}
	if wasPlaying && record.room.Phase() == room.PhaseFinished {
		now := time.Now()
		record.finished = now
		record.clock.stop(now)
	}
	client.roomID = ""
	client.lobby = true

	members := record.room.Members()
	nextOwner := room.Member{}
	for _, member := range members {
		if member.IsSeated() {
			nextOwner = member
			break
		}
	}
	// Spectators do not keep an empty table alive. If no player remains seated, close the
	// room and return everyone still watching to the public lobby.
	if nextOwner.ID == "" {
		h.closeRoomLocked(record)
		return
	}
	if record.ownerID == client.id {
		record.ownerID = nextOwner.ID
		record.room.SetHostID(record.ownerID)
	}
	h.notifyRoomLocked(record)
	h.notifyLobbyLocked()
}

// closeRoomLocked removes a room that no longer has a seated player. Any spectators are
// detached explicitly; otherwise their clients would keep a room id that no longer exists.
func (h *Hub) closeRoomLocked(record *cloudRoom) {
	roomID := record.room.ID()
	now := time.Now().UnixMilli()
	for _, client := range h.clients {
		if client.roomID != roomID {
			continue
		}
		client.roomID = ""
		client.lobby = true
		if client.send != nil {
			client.send(roomEventName, map[string]any{
				"role":     "idle",
				"selfId":   client.id,
				"nickname": client.nickname,
				"serverAt": now,
			})
		}
	}
	delete(h.rooms, roomID)
	h.notifyLobbyLocked()
}

func (h *Hub) actLocked(client *clientState, method string, params map[string]any) (any, error) {
	record := h.rooms[client.roomID]
	if record == nil {
		return nil, errors.New("join a room first")
	}
	now := time.Now()

	switch method {
	case "room.start":
		if client.id != record.ownerID {
			return nil, errors.New("only the room creator can start the match")
		}
		if err := record.room.Start(now.UnixMilli()); err != nil {
			return nil, err
		}
		record.startedAt = now
		record.finished = time.Time{}
		record.undoDeadline = time.Time{}
		record.swapDeadline = time.Time{}
		record.clock.start(now)
	case "room.seat":
		seat := intParam(params, "seat", -1)
		if err := record.room.TakeSeat(client.id, seat); err != nil {
			return nil, err
		}
		record.swapDeadline = time.Time{}
	case "room.release":
		if err := record.room.ReleaseSeat(client.id); err != nil {
			return nil, err
		}
		record.swapDeadline = time.Time{}
	case "room.swap.request":
		if err := record.room.RequestSwap(client.id); err != nil {
			return nil, err
		}
		record.swapDeadline = now.Add(undoDecisionTimeout)
	case "room.swap.consent":
		if err := record.room.ConsentSwap(client.id); err != nil {
			return nil, err
		}
		record.swapDeadline = time.Time{}
	case "room.swap.decline":
		if err := record.room.DeclineSwap(client.id); err != nil {
			return nil, err
		}
		record.swapDeadline = time.Time{}
	case "game.move":
		move := game.Move{
			From: intParam(params, "from", -1),
			To:   intParam(params, "to", -1),
		}
		if err := record.room.Move(client.id, move, now.UnixMilli()); err != nil {
			return nil, err
		}
		if record.room.Phase() == room.PhaseFinished {
			record.finished = now
			record.clock.stop(now)
		} else {
			record.clock.switchTurn(now)
		}
	case "game.undo.request":
		if err := record.room.RequestUndo(client.id); err != nil {
			return nil, err
		}
		record.clock.pause(now)
		record.undoDeadline = now.Add(undoDecisionTimeout)
	case "game.undo.consent":
		if err := record.room.ConsentUndo(client.id); err != nil {
			return nil, err
		}
		record.undoDeadline = time.Time{}
		record.clock.resume(now, record.room.TurnSeat(), true)
	case "game.undo.decline":
		if err := record.room.DeclineUndo(client.id); err != nil {
			return nil, err
		}
		record.undoDeadline = time.Time{}
		record.clock.resume(now, record.room.TurnSeat(), false)
	case "game.resign":
		if err := record.room.Resign(client.id); err != nil {
			return nil, err
		}
		record.finished = now
		record.undoDeadline = time.Time{}
		record.clock.stop(now)
	case "game.rematch":
		if client.id != record.ownerID {
			return nil, errors.New("only the room creator can rematch")
		}
		if err := record.room.Rematch(); err != nil {
			return nil, err
		}
		record.startedAt = time.Time{}
		record.finished = time.Time{}
		record.undoDeadline = time.Time{}
		record.swapDeadline = time.Time{}
	case "room.practice.start", "room.practice.end", "room.ai.start", "room.ai.move":
		return nil, errors.New("practice tools are not available in cloud rooms")
	default:
		return nil, fmt.Errorf("unknown action %q", method)
	}

	h.notifyRoomLocked(record)
	h.notifyLobbyLocked()
	return h.snapshotLocked(record, client.id, now), nil
}

// emoteLocked broadcasts one short-lived match reaction without making it part of the
// authoritative room snapshot. Only a seated player in a running match may send, and the
// server controls both the vocabulary and the cooldown.
func (h *Hub) emoteLocked(client *clientState, params map[string]any, now time.Time) (any, error) {
	record := h.rooms[client.roomID]
	if record == nil {
		return nil, errors.New("join a room first")
	}
	if record.room.Phase() != room.PhasePlaying {
		return nil, errors.New("emotes are only available during a match")
	}
	seat := -1
	for index, id := range record.room.Seats() {
		if id == client.id {
			seat = index
			break
		}
	}
	if seat < 0 {
		return nil, errors.New("only seated players may send emotes")
	}
	emoteID := stringParam(params, "id")
	if _, ok := roomEmoteIDs[emoteID]; !ok {
		return nil, errors.New("unknown emote")
	}
	if !client.lastEmote.IsZero() && now.Sub(client.lastEmote) < emoteCooldown {
		return nil, errors.New("emote is cooling down")
	}
	client.lastEmote = now

	payload := map[string]any{
		"id":     emoteID,
		"seat":   seat,
		"sentAt": now.UnixMilli(),
	}
	for _, recipient := range h.clients {
		if recipient.id == client.id || recipient.roomID != client.roomID || recipient.send == nil {
			continue
		}
		recipient.send(emoteEventName, payload)
	}
	return map[string]any{"ok": true, "seat": seat}, nil
}

func (h *Hub) legalLocked(client *clientState, params map[string]any) (any, error) {
	record := h.rooms[client.roomID]
	if record == nil {
		return map[string]any{"destinations": []int{}}, nil
	}
	rec, ok := record.room.Replay()
	if !ok {
		return map[string]any{"destinations": []int{}}, nil
	}
	engine, err := replay.NewEngine(rec.Game)
	if err != nil {
		return nil, err
	}
	for _, move := range rec.Moves {
		if err := engine.Apply(move); err != nil {
			return nil, err
		}
	}
	return map[string]any{"destinations": engine.LegalFrom(intParam(params, "from", -1))}, nil
}

func (h *Hub) snapshotLocked(record *cloudRoom, clientID string, now time.Time) map[string]any {
	var member room.Member
	for _, candidate := range record.room.Members() {
		if candidate.ID == clientID {
			member = candidate
			break
		}
	}
	return h.snapshotForMemberLocked(record, clientID, member, now)
}

func (h *Hub) snapshotForMemberLocked(record *cloudRoom, clientID string, member room.Member, now time.Time) map[string]any {
	role := "guest"
	if clientID == record.ownerID {
		role = "host"
	}
	view := map[string]any{
		"role":           role,
		"selfId":         clientID,
		"roomId":         record.room.ID(),
		"name":           record.room.Name(),
		"game":           record.room.GameName(),
		"phase":          string(record.room.Phase()),
		"locked":         record.room.Locked(),
		"seats":          record.room.Seats(),
		"members":        record.room.Members(),
		"selfSeat":       member.Seat,
		"serverAt":       now.UnixMilli(),
		"roomCreatedAt":  record.createdAt.UnixMilli(),
		"roomStartedAt":  unixMilli(record.startedAt),
		"roomFinishedAt": unixMilli(record.finished),
		"clock":          record.clock.snapshot(now),
	}
	score := record.room.Scoreboard()
	view["trackScore"] = score.Tracked
	view["score"] = score.Wins
	if requestedBy, requestedSeat := record.room.SwapRequest(); requestedBy != "" {
		view["swapRequestedBy"] = requestedBy
		view["swapRequestedSeat"] = requestedSeat
	}
	if !record.swapDeadline.IsZero() {
		remaining := record.swapDeadline.Sub(now).Milliseconds()
		if remaining < 0 {
			remaining = 0
		}
		view["swapRemainingMs"] = remaining
	}
	moveCount := 0
	if rec, ok := record.room.Replay(); ok {
		moveCount = len(rec.Moves)
	}
	view["moveCount"] = moveCount
	if !record.undoDeadline.IsZero() {
		remaining := record.undoDeadline.Sub(now).Milliseconds()
		if remaining < 0 {
			remaining = 0
		}
		view["undoRemainingMs"] = remaining
	}
	for key, value := range boardView(record.room) {
		view[key] = value
	}
	return view
}

func (h *Hub) roomSummariesLocked(now time.Time) []map[string]any {
	out := make([]map[string]any, 0, len(h.rooms))
	for _, record := range h.rooms {
		members := record.room.Members()
		seats := record.room.Seats()
		players := 0
		for _, seat := range seats {
			if seat != "" {
				players++
			}
		}
		elapsed := now.Sub(record.createdAt)
		switch record.room.Phase() {
		case room.PhasePlaying:
			if !record.startedAt.IsZero() {
				elapsed = now.Sub(record.startedAt)
			}
		case room.PhaseFinished:
			if !record.startedAt.IsZero() {
				end := record.finished
				if end.IsZero() {
					end = now
				}
				elapsed = end.Sub(record.startedAt)
			}
		}
		out = append(out, map[string]any{
			"roomId":       record.room.ID(),
			"name":         record.room.Name(),
			"game":         record.room.GameName(),
			"phase":        string(record.room.Phase()),
			"players":      players,
			"capacity":     room.SeatCount,
			"participants": len(members),
			"spectators":   len(members) - players,
			"spectatorCap": room.MaxParticipants - room.SeatCount,
			"locked":       record.room.Locked(),
			"createdAt":    record.createdAt.UnixMilli(),
			"startedAt":    unixMilli(record.startedAt),
			"elapsedMs":    maxInt64(0, elapsed.Milliseconds()),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i]["createdAt"].(int64) > out[j]["createdAt"].(int64)
	})
	return out
}

func (h *Hub) notifyRoomLocked(record *cloudRoom) {
	now := time.Now()
	for _, client := range h.clients {
		if client.roomID == record.room.ID() {
			if client.send != nil {
				client.send(roomEventName, h.snapshotLocked(record, client.id, now))
			}
		}
	}
}

func (h *Hub) notifyLobbyLocked() {
	payload := h.lobbyPayloadLocked(time.Now())
	for _, client := range h.clients {
		if client.lobby {
			if client.send != nil {
				client.send(lobbyEventName, payload)
			}
		}
	}
}

func (h *Hub) lobbyClientCountLocked() int {
	count := 0
	for _, client := range h.clients {
		if client.lobby && client.send != nil {
			count++
		}
	}
	return count
}

func (h *Hub) lobbyPayloadLocked(now time.Time) map[string]any {
	return map[string]any{
		"rooms":  h.roomSummariesLocked(now),
		"online": h.lobbyClientCountLocked(),
	}
}

func boardView(r *room.Room) map[string]any {
	engine, err := replay.NewEngine(r.GameName())
	if err != nil {
		return map[string]any{}
	}
	var lastMove *game.Move
	rec, hasRecord := r.Replay()
	if hasRecord {
		for index, move := range rec.Moves {
			if err := engine.Apply(move); err != nil {
				break
			}
			if index == len(rec.Moves)-1 {
				applied := move
				lastMove = &applied
			}
		}
	}
	view := map[string]any{
		"cells":    engine.Cells(),
		"turnSeat": int(engine.Turn()),
	}
	if requestedBy, requestedSeat := r.UndoRequest(); requestedBy != "" {
		view["undoRequestedBy"] = requestedBy
		view["undoRequestedSeat"] = requestedSeat
	}
	if lastMove != nil {
		view["lastMove"] = map[string]any{"from": lastMove.From, "to": lastMove.To}
	}
	if r.Phase() == room.PhasePlaying {
		if reporter, ok := engine.(game.CheckReporter); ok {
			seat := engine.Turn()
			if reporter.InCheck(seat) {
				view["inCheck"] = true
				view["checkFocus"] = reporter.KingSquare(seat)
			}
		}
	}
	if r.Phase() != room.PhaseLobby {
		result := engine.Result()
		// Resignation, timeout and abandonment are room-level results: the board
		// engine never sees them as a terminal position. They are recorded on the
		// replay, so the snapshot must fall back to that authoritative result.
		if !result.Finished && hasRecord && rec.Outcome != game.OutcomeNone {
			result = game.Result{
				Finished: true,
				Outcome:  rec.Outcome,
				Reason:   rec.Reason,
			}
		}
		if result.Finished {
			view["result"] = map[string]any{
				"finished": true,
				"outcome":  int(result.Outcome),
				"reason":   result.Reason,
			}
			if reporter, ok := engine.(game.WinLineReporter); ok {
				if line := reporter.WinLine(); len(line) > 0 {
					view["winLine"] = line
				}
			}
		}
	}
	return view
}

func parseBudget(params map[string]any) time.Duration {
	if _, exists := params["minutes"]; !exists {
		return defaultBudget
	}
	minutes := intParam(params, "minutes", 10)
	if minutes < 0 {
		minutes = 0
	}
	if minutes > int(maxBudget/time.Minute) {
		minutes = int(maxBudget / time.Minute)
	}
	return time.Duration(minutes) * time.Minute
}

func parseMoveTime(params map[string]any) time.Duration {
	seconds := intParam(params, "moveSeconds", 0)
	if seconds < 0 {
		seconds = 0
	}
	if seconds > int(maxMoveTime/time.Second) {
		seconds = int(maxMoveTime / time.Second)
	}
	return time.Duration(seconds) * time.Second
}

func stringParam(params map[string]any, key string) string {
	value, _ := params[key].(string)
	return strings.TrimSpace(value)
}

func intParam(params map[string]any, key string, fallback int) int {
	switch value := params[key].(type) {
	case float64:
		return int(value)
	case int:
		return value
	case int64:
		return int(value)
	default:
		return fallback
	}
}

func boolParam(params map[string]any, key string) bool {
	value, _ := params[key].(bool)
	return value
}

func sanitizeName(value string) string {
	value = strings.TrimSpace(strings.ReplaceAll(value, "\x00", ""))
	runes := []rune(value)
	if len(runes) > maxNameRunes {
		value = string(runes[:maxNameRunes])
	}
	return value
}

func sanitizeID(value string) string {
	value = strings.TrimSpace(value)
	if len(value) < 8 || len(value) > 64 {
		return ""
	}
	for _, character := range value {
		if (character < 'a' || character > 'z') &&
			(character < 'A' || character > 'Z') &&
			(character < '0' || character > '9') &&
			character != '-' && character != '_' {
			return ""
		}
	}
	return value
}

func randomID() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return fmt.Sprintf("%x", buffer)
}

func unixMilli(value time.Time) int64 {
	if value.IsZero() {
		return 0
	}
	return value.UnixMilli()
}

func maxInt64(left, right int64) int64 {
	if left > right {
		return left
	}
	return right
}
