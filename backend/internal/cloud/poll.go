package cloud

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"
)

const (
	pollBodyLimit    = 64 << 10
	pollEventBacklog = 128
	pollWait         = 20 * time.Second
	pollIdleTimeout  = 45 * time.Second
)

type pollSession struct {
	id              string
	nickname        string
	events          chan wireEvent
	lastSeen        time.Time
	connectionToken string
}

type pollManager struct {
	mu       sync.Mutex
	sessions map[string]*pollSession
	hub      *Hub
}

func newPollManager(hub *Hub) *pollManager {
	manager := &pollManager{
		sessions: make(map[string]*pollSession),
		hub:      hub,
	}
	go manager.cleanupLoop()
	return manager
}

func (m *pollManager) connect(requestedID, nickname string) (string, string) {
	session := &pollSession{
		events:   make(chan wireEvent, pollEventBacklog),
		lastSeen: time.Now(),
	}
	clientID, resolvedNickname, connectionToken := m.hub.AddClientSession(requestedID, nickname, func(method string, params any) {
		select {
		case session.events <- wireEvent{Type: "event", Method: method, Params: params}:
		default:
		}
	})
	session.id = clientID
	session.nickname = resolvedNickname
	session.connectionToken = connectionToken

	m.mu.Lock()
	m.sessions[clientID] = session
	m.mu.Unlock()

	select {
	case session.events <- wireEvent{
		Type:   "event",
		Method: "session.ready",
		Params: map[string]any{
			"clientId": clientID,
			"nickname": resolvedNickname,
			"serverAt": time.Now().UnixMilli(),
		},
	}:
	default:
	}
	return clientID, resolvedNickname
}

func (m *pollManager) session(clientID string) (*pollSession, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	session := m.sessions[clientID]
	if session == nil {
		return nil, errors.New("poll session does not exist")
	}
	session.lastSeen = time.Now()
	return session, nil
}

func (m *pollManager) request(clientID, method string, params map[string]any) (any, error) {
	session, err := m.session(clientID)
	if err != nil {
		return nil, err
	}
	return m.hub.CallSession(clientID, session.connectionToken, method, params)
}

func (m *pollManager) wait(ctx context.Context, clientID string) ([]wireEvent, error) {
	session, err := m.session(clientID)
	if err != nil {
		return nil, err
	}

	timer := time.NewTimer(pollWait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timer.C:
		return []wireEvent{}, nil
	case event := <-session.events:
		events := []wireEvent{event}
		for len(events) < 64 {
			select {
			case next := <-session.events:
				events = append(events, next)
			default:
				return events, nil
			}
		}
		return events, nil
	}
}

func (m *pollManager) cleanupLoop() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		now := time.Now()
		var expired []*pollSession
		m.mu.Lock()
		for id, session := range m.sessions {
			if now.Sub(session.lastSeen) > pollIdleTimeout {
				expired = append(expired, session)
				delete(m.sessions, id)
			}
		}
		m.mu.Unlock()
		for _, session := range expired {
			m.hub.RemoveClientSession(session.id, session.connectionToken)
		}
	}
}

func (s *Server) handlePollConnect(w http.ResponseWriter, r *http.Request) {
	var request struct {
		ClientID string `json:"clientId"`
		Nickname string `json:"nickname"`
	}
	if err := decodePollBody(r, &request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	clientID, nickname := s.poll.connect(request.ClientID, request.Nickname)
	writeJSON(w, http.StatusOK, map[string]any{
		"clientId": clientID,
		"nickname": nickname,
		"serverAt": time.Now().UnixMilli(),
	})
}

func (s *Server) handlePollEvents(w http.ResponseWriter, r *http.Request) {
	events, err := s.poll.wait(r.Context(), r.URL.Query().Get("clientId"))
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return
		}
		writeJSON(w, http.StatusConflict, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": events})
}

func (s *Server) handlePollRequest(w http.ResponseWriter, r *http.Request) {
	var request struct {
		ClientID string         `json:"clientId"`
		Method   string         `json:"method"`
		Params   map[string]any `json:"params"`
	}
	if err := decodePollBody(r, &request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	if request.ClientID == "" || request.Method == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "clientId and method are required"})
		return
	}
	result, err := s.poll.request(request.ClientID, request.Method, request.Params)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"result": result})
}

func decodePollBody(r *http.Request, target any) error {
	decoder := json.NewDecoder(io.LimitReader(r.Body, pollBodyLimit))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	return nil
}
