package cloud

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const maxMessageBytes = 64 << 10

type wireRequest struct {
	Type   string         `json:"type"`
	ID     string         `json:"id"`
	Method string         `json:"method"`
	Params map[string]any `json:"params"`
}

type wireResponse struct {
	Type   string     `json:"type"`
	ID     string     `json:"id"`
	Result any        `json:"result,omitempty"`
	Error  *wireError `json:"error,omitempty"`
}

type wireEvent struct {
	Type   string `json:"type"`
	Method string `json:"method"`
	Params any    `json:"params,omitempty"`
}

type wireError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type Server struct {
	hub     *Hub
	logger  *slog.Logger
	handler http.Handler
}

func NewServer(hub *Hub, logger *slog.Logger, uiDirectory string) *Server {
	if logger == nil {
		logger = slog.Default()
	}
	server := &Server{hub: hub, logger: logger}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":       true,
			"serverAt": time.Now().UnixMilli(),
			"stats":    hub.Stats(),
		})
	})
	mux.HandleFunc("GET /api/config", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"protocolVersion": 1,
			"serverAt":        time.Now().UnixMilli(),
		})
	})
	mux.HandleFunc("GET /api/lobby", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, hub.LobbySnapshot())
	})
	mux.HandleFunc("GET /ws", server.handleWebSocket)

	if strings.TrimSpace(uiDirectory) != "" {
		mux.Handle("/", http.FileServer(http.Dir(uiDirectory)))
	}
	server.handler = withSecurityHeaders(mux)
	return server
}

func (s *Server) Handler() http.Handler {
	return s.handler
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	upgrader := websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
		// DBX workbench origins differ between desktop releases. The protocol carries no
		// cookies or credentials, so cross-origin access is intentional for this anonymous
		// public lobby.
		CheckOrigin: func(*http.Request) bool { return true },
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.logger.Warn("websocket upgrade failed", "error", err)
		return
	}
	conn.SetReadLimit(maxMessageBytes)

	outgoing := make(chan []byte, 64)
	done := make(chan struct{})
	var closeDone sync.Once
	shutdown := func() {
		closeDone.Do(func() { close(done) })
	}
	send := func(method string, params any) {
		payload, err := json.Marshal(wireEvent{Type: "event", Method: method, Params: params})
		if err != nil {
			return
		}
		select {
		case <-done:
			return
		case outgoing <- payload:
		default:
			// A client that cannot drain 64 small events is disconnected by its writer
			// rather than slowing the room broadcast down.
		}
	}
	clientID, nickname := s.hub.AddClient(
		r.URL.Query().Get("clientId"),
		r.URL.Query().Get("nickname"),
		send,
	)
	defer s.hub.RemoveClient(clientID)
	defer conn.Close()

	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		ticker := time.NewTicker(25 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case payload := <-outgoing:
				_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if err := conn.WriteMessage(websocket.TextMessage, payload); err != nil {
					return
				}
			case <-ticker.C:
				_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
					return
				}
			}
		}
	}()

	send("session.ready", map[string]any{
		"clientId": clientID,
		"nickname": nickname,
		"serverAt": time.Now().UnixMilli(),
	})

	conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	})

	for {
		messageType, payload, err := conn.ReadMessage()
		if err != nil {
			if !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				s.logger.Debug("websocket read stopped", "error", err)
			}
			break
		}
		if messageType != websocket.TextMessage {
			s.writeError(outgoing, "", -32600, "only text JSON messages are supported")
			continue
		}
		_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))

		var request wireRequest
		if err := json.Unmarshal(payload, &request); err != nil {
			s.writeError(outgoing, "", -32700, "invalid JSON")
			continue
		}
		if request.Type != "request" || request.ID == "" || request.Method == "" {
			s.writeError(outgoing, request.ID, -32600, "invalid request envelope")
			continue
		}
		if request.Params == nil {
			request.Params = map[string]any{}
		}

		result, callErr := s.hub.Call(clientID, request.Method, request.Params)
		if callErr != nil {
			s.writeError(outgoing, request.ID, -32000, callErr.Error())
			continue
		}
		response, err := json.Marshal(wireResponse{
			Type:   "response",
			ID:     request.ID,
			Result: result,
		})
		if err != nil {
			s.writeError(outgoing, request.ID, -32603, "response encoding failed")
			continue
		}
		select {
		case <-done:
			break
		case outgoing <- response:
		default:
			shutdown()
			_ = conn.Close()
		}
	}

	shutdown()
	<-writerDone
}

func (s *Server) writeError(outgoing chan<- []byte, id string, code int, message string) {
	payload, err := json.Marshal(wireResponse{
		Type:  "response",
		ID:    id,
		Error: &wireError{Code: code, Message: message},
	})
	if err != nil {
		return
	}
	select {
	case outgoing <- payload:
	default:
	}
}

func withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if strings.HasPrefix(r.URL.Path, "/ws") {
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
