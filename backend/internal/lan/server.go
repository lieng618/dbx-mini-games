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

	"github.com/southernMortals/dbx-board-games/backend/internal/room"
)

// Message is the single wire envelope for every frame in both directions.
type Message struct {
	Type     string          `json:"type"`
	Protocol int             `json:"protocol"`
	RoomID   string          `json:"roomId,omitempty"`
	Nonce    []byte          `json:"nonce,omitempty"`
	PublicKey []byte         `json:"publicKey,omitempty"`
	Signature []byte         `json:"signature,omitempty"`
	Password string          `json:"password,omitempty"`
	Ticket   string          `json:"ticket,omitempty"`
	Profile  *Profile        `json:"profile,omitempty"`
	Snapshot json.RawMessage `json:"snapshot,omitempty"`
	Error    string          `json:"error,omitempty"`
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

// Server hosts a Room over TLS on the local network.
type Server struct {
	identity ed25519.PrivateKey
	listener net.Listener
	room     *room.Room

	mu    sync.Mutex
	peers map[string]*hostConn
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
	s := &Server{identity: identity, listener: listener, room: r, peers: map[string]*hostConn{}}
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
	s.peers = map[string]*hostConn{}
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

	ticket, err := newToken()
	if err != nil {
		return
	}
	s.mu.Lock()
	s.peers[ticket] = &hostConn{conn: conn, publicKey: pub, ticket: ticket, memberID: member.ID}
	s.mu.Unlock()

	snapshot, err := json.Marshal(snapshotOf(s.room, member.ID))
	if err != nil {
		return
	}
	_ = conn.SetDeadline(time.Time{})
	if err := s.write(conn, Message{Type: "welcome", Protocol: Protocol, RoomID: s.room.ID(), Ticket: ticket, Snapshot: snapshot}); err != nil {
		return
	}

	// Hold the connection open so the peer can report a disconnect.
	buf := make([]byte, 1)
	for {
		if _, err := conn.Read(buf); err != nil {
			s.mu.Lock()
			delete(s.peers, ticket)
			s.mu.Unlock()
			_ = s.room.Leave(member.ID)
			return
		}
	}
}

func (s *Server) ticketValid(ticket, memberID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	peer, ok := s.peers[ticket]
	return ok && peer.memberID == memberID
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
