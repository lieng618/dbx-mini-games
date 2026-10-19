// Package lan implements the local-network transport for a hosted Room.
//
// The host listens on an ephemeral TLS port with a self-signed certificate. Because no
// CA vouches for that certificate, the client validates the leaf by comparing its public
// key against the key advertised over mDNS, then proves possession of its own key in an
// Ed25519 challenge-response. Passwords are optional; reconnect tokens survive a
// transient drop without re-hosting.
package lan

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"errors"
	"fmt"
	"math/big"
	"net"
	"time"
)

// Protocol is the wire version. Peers must agree or the handshake is refused.
const Protocol = 1

// MaxFrameBytes bounds a single wire message.
const MaxFrameBytes = 1 << 18

// Errors peers and tests need to distinguish.
var (
	ErrProtocolMismatch = errors.New("peer speaks a different protocol version")
	ErrBadPassword      = errors.New("wrong room password")
	ErrBadTicket        = errors.New("room ticket rejected")
	ErrBadChallenge     = errors.New("handshake challenge failed")
	ErrFrameTooLarge    = errors.New("wire frame exceeds the limit")
)

// selfSignedCertificate builds a TLS 1.3 certificate whose public key is the identity
// peers pin. The certificate is deliberately short-lived: it carries no authority, only
// a key.
func selfSignedCertificate(identity ed25519.PrivateKey) (tls.Certificate, error) {
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, err
	}
	template := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "dbx-board-games"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(30 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, identity.Public(), identity)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: identity}, nil
}

// serverTLSConfig returns a TLS 1.3 server config for the given identity.
func serverTLSConfig(identity ed25519.PrivateKey) (*tls.Config, error) {
	cert, err := selfSignedCertificate(identity)
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{cert},
	}, nil
}

// clientTLSConfig pins the expected host public key instead of trusting a CA. The
// verification runs after the handshake, so the connection is refused before any
// application data crosses it.
func clientTLSConfig(expected ed25519.PublicKey) *tls.Config {
	return &tls.Config{
		MinVersion:         tls.VersionTLS13,
		InsecureSkipVerify: true, // replaced by VerifyConnection below
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return ErrBadChallenge
			}
			pub, ok := cs.PeerCertificates[0].PublicKey.(ed25519.PublicKey)
			if !ok {
				return ErrBadChallenge
			}
			if !pub.Equal(expected) {
				return ErrBadChallenge
			}
			return nil
		},
	}
}

// writeFrame writes a length-prefixed frame.
func writeFrame(conn net.Conn, payload []byte) error {
	if len(payload) > MaxFrameBytes {
		return ErrFrameTooLarge
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(payload)))
	if _, err := conn.Write(header[:]); err != nil {
		return err
	}
	_, err := conn.Write(payload)
	return err
}

// readFrame reads one length-prefixed frame.
func readFrame(conn net.Conn) ([]byte, error) {
	var header [4]byte
	if _, err := readFull(conn, header[:]); err != nil {
		return nil, err
	}
	size := binary.BigEndian.Uint32(header[:])
	if size == 0 || size > MaxFrameBytes {
		return nil, ErrFrameTooLarge
	}
	payload := make([]byte, size)
	if _, err := readFull(conn, payload); err != nil {
		return nil, err
	}
	return payload, nil
}

func readFull(conn net.Conn, buf []byte) (int, error) {
	total := 0
	for total < len(buf) {
		n, err := conn.Read(buf[total:])
		total += n
		if err != nil {
			return total, err
		}
	}
	return total, nil
}

// challengeProof is the byte string both sides sign. Binding the nonce to the room id
// stops a proof captured in one room from being replayed into another.
func challengeProof(nonce []byte, roomID string) []byte {
	buf := make([]byte, 0, len(nonce)+len(roomID))
	buf = append(buf, nonce...)
	buf = append(buf, roomID...)
	return buf
}

// newNonce returns a fresh 32-byte challenge.
func newNonce() ([]byte, error) {
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return nonce, nil
}

// newToken returns an opaque reconnect ticket.
func newToken() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", buf), nil
}
