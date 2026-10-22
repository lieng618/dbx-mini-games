package cloud

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPollTransportCreatesRoomAndReturnsEvents(t *testing.T) {
	hub := NewHub()
	server := httptest.NewServer(NewServer(hub, slog.New(slog.NewTextHandler(io.Discard, nil)), "").Handler())
	defer server.Close()

	connected := postPollJSON(t, server.URL+"/api/connect", map[string]any{
		"clientId": "poll-owner-test",
		"nickname": "创建者",
	})
	clientID, _ := connected["clientId"].(string)
	if clientID == "" {
		t.Fatal("connect did not return a client id")
	}

	created := postPollJSON(t, server.URL+"/api/request", map[string]any{
		"clientId": clientID,
		"method":   "room.create",
		"params": map[string]any{
			"name":   "轮询测试房",
			"game":   "gomoku",
			"seat":   0,
			"minutes": 0,
		},
	})
	result, ok := created["result"].(map[string]any)
	if !ok || result["role"] != "host" || result["roomId"] == "" {
		t.Fatalf("room.create result = %#v", created)
	}

	response, err := http.Get(server.URL + "/api/events?clientId=" + clientID)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var events struct {
		Events []wireEvent `json:"events"`
	}
	if err := json.NewDecoder(response.Body).Decode(&events); err != nil {
		t.Fatal(err)
	}
	if len(events.Events) == 0 || events.Events[0].Method != "session.ready" {
		t.Fatalf("events = %#v", events.Events)
	}
}

func postPollJSON(t *testing.T, url string, value any) map[string]any {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var result map[string]any
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, body = %#v", response.StatusCode, result)
	}
	if message, ok := result["error"].(string); ok {
		t.Fatal(message)
	}
	return result
}
