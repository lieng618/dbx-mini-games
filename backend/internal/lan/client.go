package lan

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"time"
)

// Client is one guest's connection to a hosted Room.
type Client struct {
	conn     net.Conn
	identity ed25519.PrivateKey
	ticket   string
	roomID   string
	memberID string
	Snapshot map[string]any
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
	return &Client{
		conn:     conn,
		identity: identity,
		ticket:   welcome.Ticket,
		roomID:   welcome.RoomID,
		memberID: opts.Profile.ID,
		Snapshot: snapshot,
	}, nil
}

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
func (c *Client) SnapshotText() ([]byte, error) { return json.Marshal(c.Snapshot) }

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
