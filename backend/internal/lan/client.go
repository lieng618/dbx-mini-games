package lan

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"
)

// Client is one guest's connection to a hosted Room.
type Client struct {
	conn     net.Conn
	identity ed25519.PrivateKey
	ticket   string
	roomID   string
	memberID string

	// mu guards the mutable view and the request table: the read loop updates snapshots
	// while callers issue requests.
	mu        sync.Mutex
	snapshot  map[string]any
	pending   map[string]chan Message
	nextID    int
	onState   func(map[string]any)
	readError error
}

// JoinOptions describes how to reach and authenticate against a Room.
type JoinOptions struct {
	// Address is host:port of the TLS listener.
	Address string
	// HostKey is the host's Ed25519 public key, obtained from the mDNS record. Pinning it
	// is what replaces a CA.
	HostKey ed25519.PublicKey
	// RoomID guards against connecting to a different room on the same host.
	RoomID string
	// Profile identifies this participant.
	Profile Profile
	// Password is required only for a locked Room on a first join.
	Password string
	// Ticket reconnects an earlier session instead of joining afresh.
	Ticket string
}

// Join performs the client half of the handshake and returns a live Client.
func Join(opts JoinOptions) (*Client, error) {
	if len(opts.HostKey) != ed25519.PublicKeySize {
		return nil, ErrBadChallenge
	}
	dialer := &net.Dialer{Timeout: 8 * time.Second}
	conn, err := tls.DialWithDialer(dialer, "tcp", opts.Address, clientTLSConfig(opts.HostKey))
	if err != nil {
		return nil, err
	}
	_ = conn.SetDeadline(time.Now().Add(20 * time.Second))

	pub, identity, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}

	challenge, err := readMessage(conn)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	if challenge.Type != "challenge" || challenge.Protocol != Protocol {
		_ = conn.Close()
		return nil, ErrProtocolMismatch
	}
	if opts.RoomID != "" && challenge.RoomID != opts.RoomID {
		_ = conn.Close()
		return nil, ErrBadChallenge
	}
	if len(challenge.Nonce) < 16 {
		_ = conn.Close()
		return nil, ErrBadChallenge
	}

	auth := Message{
		Type:      "auth",
		Protocol:  Protocol,
		Profile:   &opts.Profile,
		PublicKey: pub,
		Signature: ed25519.Sign(identity, challengeProof(challenge.Nonce, challenge.RoomID)),
		Password:  opts.Password,
		Ticket:    opts.Ticket,
	}
	if err := writeMessage(conn, auth); err != nil {
		_ = conn.Close()
		return nil, err
	}

	welcome, err := readMessage(conn)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	if welcome.Type == "reject" {
		_ = conn.Close()
		return nil, rejection(welcome.Error)
	}
	if welcome.Type != "welcome" || welcome.Protocol != Protocol || welcome.Ticket == "" {
		_ = conn.Close()
		return nil, ErrBadChallenge
	}

	snapshot := map[string]any{}
	if len(welcome.Snapshot) > 0 {
		if err := json.Unmarshal(welcome.Snapshot, &snapshot); err != nil {
			_ = conn.Close()
			return nil, err
		}
	}
	_ = conn.SetDeadline(time.Time{})
	client := &Client{
		conn:     conn,
		identity: identity,
		ticket:   welcome.Ticket,
		roomID:   welcome.RoomID,
		memberID: opts.Profile.ID,
		snapshot: snapshot,
		pending:  map[string]chan Message{},
	}
	go client.readLoop()
	return client, nil
}

// readLoop receives pushes and request replies from the host.
func (c *Client) readLoop() {
	for {
		message, err := readMessage(c.conn)
		if err != nil {
			c.mu.Lock()
			c.readError = err
			for _, waiter := range c.pending {
				close(waiter)
			}
			c.pending = map[string]chan Message{}
			c.mu.Unlock()
			return
		}
		switch message.Type {
		case "state":
			if len(message.Snapshot) == 0 {
				continue
			}
			view := map[string]any{}
			if err := json.Unmarshal(message.Snapshot, &view); err != nil {
				continue
			}
			c.mu.Lock()
			c.snapshot = view
			notify := c.onState
			c.mu.Unlock()
			if notify != nil {
				notify(view)
			}
		case "response":
			c.mu.Lock()
			waiter, ok := c.pending[message.RequestID]
			delete(c.pending, message.RequestID)
			c.mu.Unlock()
			if ok {
				waiter <- message
			}
		}
	}
}

// OnState registers a callback fired whenever the host pushes a new snapshot.
func (c *Client) OnState(fn func(map[string]any)) {
	c.mu.Lock()
	c.onState = fn
	c.mu.Unlock()
}

// Call asks the host to perform an action and waits for its answer.
//
// The guest never applies the action locally: the host decides, then pushes the resulting
// state back, so a spectator and a player always see the same board.
func (c *Client) Call(method string, params any) (any, error) {
	body, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}

	c.mu.Lock()
	if c.readError != nil {
		c.mu.Unlock()
		return nil, c.readError
	}
	c.nextID++
	id := fmt.Sprintf("r%d", c.nextID)
	waiter := make(chan Message, 1)
	c.pending[id] = waiter
	c.mu.Unlock()

	if err := writeMessage(c.conn, Message{
		Type:      "request",
		Protocol:  Protocol,
		RoomID:    c.roomID,
		RequestID: id,
		Method:    method,
		Params:    body,
	}); err != nil {
		return nil, err
	}

	select {
	case reply, ok := <-waiter:
		if !ok {
			return nil, errors.New("connection to the host closed")
		}
		if reply.Error != "" {
			return nil, errors.New(reply.Error)
		}
		if len(reply.Result) == 0 {
			return nil, nil
		}
		var decoded any
		if err := json.Unmarshal(reply.Result, &decoded); err != nil {
			return nil, err
		}
		return decoded, nil
	case <-time.After(15 * time.Second):
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, errors.New("the host did not answer in time")
	}
}

// Snapshot returns the latest state pushed by the host.
func (c *Client) Snapshot() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make(map[string]any, len(c.snapshot))
	for k, v := range c.snapshot {
		out[k] = v
	}
	return out
}

// MemberID is this guest's own identity inside the room.
func (c *Client) MemberID() string { return c.memberID }

// rejection maps a host error string back to a sentinel.
func rejection(text string) error {
	switch text {
	case ErrBadPassword.Error():
		return ErrBadPassword
	case ErrProtocolMismatch.Error():
		return ErrProtocolMismatch
	default:
		if text == "" {
			return errors.New("join rejected")
		}
		return fmt.Errorf("join rejected: %s", text)
	}
}

// Ticket is the reconnect credential for this session.
func (c *Client) Ticket() string { return c.ticket }

// SnapshotText renders the room view as JSON for callers that only need it verbatim.
func (c *Client) SnapshotText() ([]byte, error) { return json.Marshal(c.Snapshot()) }

// Close drops the connection.
func (c *Client) Close() error { return c.conn.Close() }

func readMessage(conn net.Conn) (Message, error) {
	var m Message
	payload, err := readFrame(conn)
	if err != nil {
		return m, err
	}
	err = json.Unmarshal(payload, &m)
	return m, err
}

func writeMessage(conn net.Conn, m Message) error {
	payload, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return writeFrame(conn, payload)
}
