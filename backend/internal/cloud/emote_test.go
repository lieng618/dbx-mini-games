package cloud

import (
	"strings"
	"testing"
)

type recordedEvent struct {
	method string
	params map[string]any
}

func TestRoomEmoteBroadcastsToTheOpponentOnly(t *testing.T) {
	hub := NewHub()
	var ownerEvents []recordedEvent
	var guestEvents []recordedEvent
	var spectatorEvents []recordedEvent
	ownerID, _ := hub.AddClient("emote-owner", "先手", func(method string, params any) {
		ownerEvents = append(ownerEvents, recordedEvent{method, params.(map[string]any)})
	})
	guestID, _ := hub.AddClient("emote-guest", "后手", func(method string, params any) {
		guestEvents = append(guestEvents, recordedEvent{method, params.(map[string]any)})
	})
	spectatorID, _ := hub.AddClient("emote-watch", "观战", func(method string, params any) {
		spectatorEvents = append(spectatorEvents, recordedEvent{method, params.(map[string]any)})
	})

	created, err := hub.Call(ownerID, "room.create", map[string]any{
		"name": "表情房", "game": "gomoku", "seat": float64(0),
	})
	if err != nil {
		t.Fatal(err)
	}
	roomID := created.(map[string]any)["roomId"].(string)
	if _, err := hub.Call(guestID, "room.join", map[string]any{"roomId": roomID}); err != nil {
		t.Fatal(err)
	}

	if _, err := hub.Call(ownerID, "room.emote", map[string]any{"id": "smug"}); err == nil {
		t.Fatal("a lobby must not accept match emotes")
	}
	if _, err := hub.Call(ownerID, "room.start", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := hub.Call(spectatorID, "room.join", map[string]any{
		"roomId": roomID, "role": "spectator",
	}); err != nil {
		t.Fatal(err)
	}
	ownerEvents = nil
	guestEvents = nil
	spectatorEvents = nil

	reply, err := hub.Call(ownerID, "room.emote", map[string]any{"id": "smug"})
	if err != nil {
		t.Fatal(err)
	}
	if reply.(map[string]any)["ok"] != true || reply.(map[string]any)["seat"] != 0 {
		t.Fatalf("unexpected emote reply: %#v", reply)
	}

	if len(ownerEvents) != 0 {
		t.Fatalf("the sender should rely on its immediate bubble; got %#v", ownerEvents)
	}
	if len(guestEvents) != 1 || guestEvents[0].method != "room.emote" {
		t.Fatalf("opponent events = %#v", guestEvents)
	}
	if got := guestEvents[0].params["id"]; got != "smug" {
		t.Fatalf("emote id = %v", got)
	}
	if got := guestEvents[0].params["seat"]; got != 0 {
		t.Fatalf("emote seat = %v", got)
	}
	if len(spectatorEvents) != 1 || spectatorEvents[0].method != "room.emote" {
		t.Fatalf("spectator should receive the reaction: %#v", spectatorEvents)
	}
}

func TestRoomEmoteValidatesSenderAndCooldown(t *testing.T) {
	hub := NewHub()
	ownerID, _ := hub.AddClient("emote-validation-owner", "先手", func(string, any) {})
	guestID, _ := hub.AddClient("emote-validation-guest", "后手", func(string, any) {})
	watcherID, _ := hub.AddClient("emote-validation-watch", "观战", func(string, any) {})

	created, err := hub.Call(ownerID, "room.create", map[string]any{
		"name": "表情校验", "game": "gomoku", "seat": float64(0),
	})
	if err != nil {
		t.Fatal(err)
	}
	roomID := created.(map[string]any)["roomId"].(string)
	if _, err := hub.Call(guestID, "room.join", map[string]any{"roomId": roomID}); err != nil {
		t.Fatal(err)
	}
	if _, err := hub.Call(ownerID, "room.start", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := hub.Call(watcherID, "room.join", map[string]any{
		"roomId": roomID, "role": "spectator",
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := hub.Call(ownerID, "room.emote", map[string]any{"id": "not-allowed"}); err == nil ||
		!strings.Contains(err.Error(), "unknown emote") {
		t.Fatalf("invalid emote error = %v", err)
	}
	if _, err := hub.Call(watcherID, "room.emote", map[string]any{"id": "smug"}); err == nil ||
		!strings.Contains(err.Error(), "only seated players") {
		t.Fatalf("spectator emote error = %v", err)
	}
	if _, err := hub.Call(ownerID, "room.emote", map[string]any{"id": "praise"}); err != nil {
		t.Fatal(err)
	}
	if _, err := hub.Call(ownerID, "room.emote", map[string]any{"id": "crack"}); err == nil ||
		!strings.Contains(err.Error(), "cooling down") {
		t.Fatalf("cooldown error = %v", err)
	}
}
