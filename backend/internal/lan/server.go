package lan

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"encoding/json"
	"errors"
	"net"
	"sync"
	"time"

	"github.com/lieng618/dbx-mini-games/backend/internal/room"
)

// Message is the single wire envelope for every frame in both directions.
type Message struct {
	Type      string          `json:"type"`
	Protocol  int             `json:"protocol"`
	RoomID    string          `json:"roomId,omitempty"`
	Nonce     []byte          `json:"nonce,omitempty"`
	PublicKey []byte          `json:"publicKey,omitempty"`
	Signature []byte          `json:"signature,omitempty"`
	Password  string          `json:"password,omitempty"`
	Ticket    string          `json:"ticket,omitempty"`
	Profile   *Profile        `json:"profile,omitempty"`
	Snapshot  json.RawMessage `json:"snapshot,omitempty"`
	Error     string          `json:"error,omitempty"`
	// Request lets a guest ask the host to perform an action on its behalf. The host is the
	// only authority, so a guest never mutates state locally.
	RequestID string          `json:"requestId,omitempty"`
	Method    string          `json:"method,omitempty"`
	Params    json.RawMessage `json:"params,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
}

// Profile is the participant identity sent during the handshake.
type Profile struct {
	ID       string `json:"id"`
	Nickname string `json:"nickname"`
}

// hostConn tracks one accepted peer.
type hostConn struct {
	conn      net.Conn
	publicKey ed25519.PublicKey
	ticket    string
	memberID  string
}

type ticketState struct {
	memberID   string
	timer      *time.Timer
	generation uint64
}

var lanReconnectGrace = 25 * time.Second

// RequestHandler applies one guest request against the authoritative room.
//
// It is supplied by the app layer so the transport stays free of game and seat rules.
type RequestHandler func(memberID, method string, params json.RawMessage) (any, error)

// Server hosts a Room over TLS on the local network.
type Server struct {
	identity ed25519.PrivateKey
	listener net.Listener
	room     *room.Room

	mu      sync.Mutex
	peers   map[string]*hostConn
	tickets map[string]*ticketState
	handler RequestHandler
	// onChange fires after a peer joins or leaves. Seating is decided inside Room.Join, so
	// the host's own view is stale until it re-reads the room; without this the lobby never
	// learns that a challenger arrived and the match cannot be started.
	onChange func()
	// broadcasts keeps every live connection so state changes reach all guests.
	broadcasts map[string]*hostConn
}

// SetRequestHandler installs the handler used for guest requests.
func (s *Server) SetRequestHandler(handler RequestHandler) {
	s.mu.Lock()
	s.handler = handler
	s.mu.Unlock()
}

// SetMembershipHandler installs the callback fired when a peer joins or leaves.
//
// It is called without the server lock held, so the handler may broadcast or take the app
// lock. A nil handler simply means membership changes stay silent.
func (s *Server) SetMembershipHandler(handler func()) {
	s.mu.Lock()
	s.onChange = handler
	s.mu.Unlock()
}

// notifyMembership fires the membership callback, if one is installed.
func (s *Server) notifyMembership() {
	s.mu.Lock()
	handler := s.onChange
	s.mu.Unlock()
	if handler != nil {
		handler()
	}
}

// Broadcast sends the current snapshot to every connected guest.
//
// Guests are passive: they receive state and ask the host for actions, so the host pushes
// after every change rather than answering a poll.
func (s *Server) Broadcast(snapshotFor func(memberID string) any) {
	s.mu.Lock()
	peers := make([]*hostConn, 0, len(s.peers))
	for _, peer := range s.peers {
		peers = append(peers, peer)
	}
	s.mu.Unlock()

	for _, peer := range peers {
		payload, err := json.Marshal(snapshotFor(peer.memberID))
		if err != nil {
			continue
		}
		_ = s.write(peer.conn, Message{
			Type:     "state",
			Protocol: Protocol,
			RoomID:   s.room.ID(),
			Snapshot: payload,
		})
	}
}

// NewServer starts listening and returns the running server. The caller must Close it.
func NewServer(r *room.Room) (*Server, error) {
	_, identity, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	cfg, err := serverTLSConfig(identity)
	if err != nil {
		return nil, err
	}
	// Port 0 asks the OS for an ephemeral port; the actual port is advertised over mDNS.
	listener, err := tls.Listen("tcp", "0.0.0.0:0", cfg)
	if err != nil {
		return nil, err
	}
	s := &Server{
		identity: identity,
		listener: listener,
		room:     r,
		peers:    map[string]*hostConn{},
		tickets:  map[string]*ticketState{},
	}
	go s.acceptLoop()
	return s, nil
}

// Port is the bound TCP port.
func (s *Server) Port() int { return s.listener.Addr().(*net.TCPAddr).Port }

// PublicKey is the key clients must pin.
func (s *Server) PublicKey() ed25519.PublicKey { return s.identity.Public().(ed25519.PublicKey) }

// Close stops the listener and drops live peers.
func (s *Server) Close() error {
	err := s.listener.Close()
	s.mu.Lock()
	for _, p := range s.peers {
		_ = p.conn.Close()
	}
	for _, state := range s.tickets {
		if state.timer != nil {
			state.timer.Stop()
		}
	}
	s.peers = map[string]*hostConn{}
	s.tickets = map[string]*ticketState{}
	s.mu.Unlock()
	return err
}

func (s *Server) acceptLoop() {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		go s.handle(conn)
	}
}

// handle runs the server half of the handshake: send a challenge, verify the peer's
// signature over (nonce, roomID), check the password or ticket, then admit to the Room.
func (s *Server) handle(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))

	nonce, err := newNonce()
	if err != nil {
		return
	}
	challenge := Message{Type: "challenge", Protocol: Protocol, RoomID: s.room.ID(), Nonce: nonce}
	if err := s.write(conn, challenge); err != nil {
		return
	}
	auth, err := s.read(conn)
	if err != nil {
		return
	}
	if auth.Protocol != Protocol || auth.Type != "auth" || auth.Profile == nil {
		_ = s.write(conn, Message{Type: "reject", Protocol: Protocol, Error: ErrProtocolMismatch.Error()})
		return
	}
	if len(auth.PublicKey) != ed25519.PublicKeySize {
		_ = s.write(conn, Message{Type: "reject", Protocol: Protocol, Error: ErrBadChallenge.Error()})
		return
	}
	pub := ed25519.PublicKey(auth.PublicKey)
	if !ed25519.Verify(pub, challengeProof(nonce, s.room.ID()), auth.Signature) {
		_ = s.write(conn, Message{Type: "reject", Protocol: Protocol, Error: ErrBadChallenge.Error()})
		return
	}

	// A ticket is a reconnect; a password gates a first join. A ticket always wins, so a
	// dropped client rejoins the seat it already held without resending the password.
	reconnect := auth.Ticket != "" && s.ticketValid(auth.Ticket, auth.Profile.ID)
	if !reconnect {
		if s.room.Locked() && !s.room.CheckPassword(auth.Password) {
			_ = s.write(conn, Message{Type: "reject", Protocol: Protocol, Error: ErrBadPassword.Error()})
			return
		}
	}

	member, err := s.room.Join(auth.Profile.ID, auth.Profile.Nickname)
	if err != nil && !errors.Is(err, room.ErrAlreadyJoined) {
		_ = s.write(conn, Message{Type: "reject", Protocol: Protocol, Error: err.Error()})
		return
	}

	ticket := auth.Ticket
	if !reconnect {
		ticket, err = newToken()
		if err != nil {
			return
		}
	}
	peer := &hostConn{conn: conn, publicKey: pub, ticket: ticket, memberID: member.ID}
	s.mu.Lock()
	state := s.tickets[ticket]
	if state == nil {
		state = &ticketState{memberID: member.ID}
		s.tickets[ticket] = state
	}
	state.memberID = member.ID
	state.generation++
	if state.timer != nil {
		state.timer.Stop()
		state.timer = nil
	}
	previous := s.peers[ticket]
	s.peers[ticket] = peer
	s.mu.Unlock()
	if previous != nil && previous.conn != conn {
		_ = previous.conn.Close()
	}
	defer s.disconnectPeer(ticket, conn, member.ID)
	s.room.SetConnected(member.ID, true)

	snapshot, err := json.Marshal(snapshotOf(s.room, member.ID))
	if err != nil {
		return
	}
	_ = conn.SetDeadline(time.Time{})
	if err := s.write(conn, Message{Type: "welcome", Protocol: Protocol, RoomID: s.room.ID(), Ticket: ticket, Snapshot: snapshot}); err != nil {
		return
	}

	// The guest is seated and has its opening snapshot. Tell the host: the lobby only
	// offers "start" once it sees both seats filled, so this is what unblocks the match.
	s.notifyMembership()

	// Serve requests until the peer disconnects. A guest holds no authority, so every
	// message it sends is a request for the host to act.
	for {
		message, err := s.read(conn)
		if err != nil {
			return
		}
		if message.Type != "request" || message.Method == "" {
			continue
		}

		s.mu.Lock()
		handler := s.handler
		s.mu.Unlock()

		reply := Message{Type: "response", Protocol: Protocol, RequestID: message.RequestID}
		if handler == nil {
			reply.Error = "host is not ready to accept requests"
		} else if result, callErr := handler(member.ID, message.Method, message.Params); callErr != nil {
			reply.Error = callErr.Error()
		} else if encoded, marshalErr := json.Marshal(result); marshalErr != nil {
			reply.Error = "result could not be encoded"
		} else {
			reply.Result = encoded
		}
		_ = s.write(conn, reply)
	}
}

func (s *Server) ticketValid(ticket, memberID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.tickets[ticket]
	return state != nil && state.memberID == memberID
}

// disconnectPeer keeps the membership for a short reconnect window while the old
// connection unwinds. The ticket remains valid until this generation's timer expires.
func (s *Server) disconnectPeer(ticket string, conn net.Conn, memberID string) {
	s.mu.Lock()
	current := s.peers[ticket]
	if current == nil || current.conn != conn {
		s.mu.Unlock()
		return
	}
	delete(s.peers, ticket)
	state := s.tickets[ticket]
	if state == nil {
		s.mu.Unlock()
		_ = s.room.Leave(memberID)
		s.notifyMembership()
		return
	}
	state.generation++
	generation := state.generation
	if state.timer != nil {
		state.timer.Stop()
	}
	state.timer = time.AfterFunc(lanReconnectGrace, func() {
		s.expireTicket(ticket, generation)
	})
	s.mu.Unlock()

	s.room.SetConnected(memberID, false)
	s.notifyMembership()
}

func (s *Server) expireTicket(ticket string, generation uint64) {
	s.mu.Lock()
	state := s.tickets[ticket]
	if state == nil || state.generation != generation || s.peers[ticket] != nil {
		s.mu.Unlock()
		return
	}
	delete(s.tickets, ticket)
	s.mu.Unlock()

	_ = s.room.Leave(state.memberID)
	s.notifyMembership()
}

func (s *Server) read(conn net.Conn) (Message, error) {
	var m Message
	payload, err := readFrame(conn)
	if err != nil {
		return m, err
	}
	err = json.Unmarshal(payload, &m)
	return m, err
}

func (s *Server) write(conn net.Conn, m Message) error {
	payload, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return writeFrame(conn, payload)
}

// snapshotOf builds the room view a given member receives. Seats, phase, and the board
// are shared; the member's own identity is included so the UI knows where it sits.
func snapshotOf(r *room.Room, selfID string) map[string]any {
	view := map[string]any{
		"roomId":    r.ID(),
		"name":      r.Name(),
		"game":      r.GameName(),
		"selfId":    selfID,
		"hostId":    r.HostID(),
		"phase":     string(r.Phase()),
		"locked":    r.Locked(),
		"seats":     r.Seats(),
		"members":   r.Members(),
		"permitted": true,
	}
	if rec, ok := r.Replay(); ok {
		view["record"] = rec
	}
	return view
}
