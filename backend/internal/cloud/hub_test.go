package cloud

import "testing"

func TestCloudRoomJoinSpectateAndStart(t *testing.T) {
	hub := NewHub()
	ownerID, _ := hub.AddClient("owner-test-1", "创建者", func(string, any) {})
	guestID, _ := hub.AddClient("guest-test-1", "挑战者", func(string, any) {})
	watchID, _ := hub.AddClient("watch-test-1", "观战者", func(string, any) {})

	created, err := hub.Call(ownerID, "room.create", map[string]any{
		"name": "云房间",
		"game": "gomoku",
		"seat": float64(0),
	})
	if err != nil {
		t.Fatal(err)
	}
	snapshot := created.(map[string]any)
	roomID := snapshot["roomId"].(string)
	if snapshot["selfSeat"] != 0 {
		t.Fatalf("creator seat = %v, want 0", snapshot["selfSeat"])
	}

	joined, err := hub.Call(guestID, "room.join", map[string]any{
		"roomId": roomID,
		"role":   "player",
	})
	if err != nil {
		t.Fatal(err)
	}
	if joined.(map[string]any)["selfSeat"] != 1 {
		t.Fatal("second player did not take seat two")
	}

	started, err := hub.Call(ownerID, "room.start", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := started.(map[string]any)["phase"]; got != "playing" {
		t.Fatalf("phase = %v, want playing", got)
	}

	watched, err := hub.Call(watchID, "room.join", map[string]any{
		"roomId": roomID,
		"role":   "spectator",
	})
	if err != nil {
		t.Fatal(err)
	}
	if watched.(map[string]any)["selfSeat"] != -1 {
		t.Fatal("spectator was assigned a seat")
	}

	if _, err := hub.Call(watchID, "game.move", map[string]any{"to": float64(0)}); err == nil {
		t.Fatal("spectator must not be able to move")
	}
}

func TestLobbyOnlineCountTracksOnlyConnectedLobbyClients(t *testing.T) {
	hub := NewHub()
	firstID, _ := hub.AddClient("lobby-count-owner", "甲", func(string, any) {})
	secondID, _ := hub.AddClient("lobby-count-guest", "乙", func(string, any) {})

	if got := hub.LobbySnapshot()["online"]; got != 2 {
		t.Fatalf("online = %v, want 2", got)
	}
	if _, err := hub.Call(firstID, "room.create", map[string]any{
		"name": "在线统计房",
		"game": "xiangqi",
	}); err != nil {
		t.Fatal(err)
	}
	if got := hub.LobbySnapshot()["online"]; got != 1 {
		t.Fatalf("online after entering room = %v, want 1", got)
	}

	hub.RemoveClient(secondID)
	if got := hub.LobbySnapshot()["online"]; got != 0 {
		t.Fatalf("online after disconnect = %v, want 0", got)
	}
}

func TestSpectatingIsUnavailableBeforeMatchStarts(t *testing.T) {
	hub := NewHub()
	ownerID, _ := hub.AddClient("watch-window-owner", "创建者", func(string, any) {})
	watchID, _ := hub.AddClient("watch-window-guest", "观战者", func(string, any) {})

	created, err := hub.Call(ownerID, "room.create", map[string]any{
		"name": "未开局房间",
		"game": "xiangqi",
	})
	if err != nil {
		t.Fatal(err)
	}
	roomID := created.(map[string]any)["roomId"].(string)
	if _, err := hub.Call(watchID, "room.join", map[string]any{
		"roomId": roomID,
		"role":   "spectator",
	}); err == nil {
		t.Fatal("spectator joined a room before the match started")
	}
}

func TestCloudOwnerTransferAndRoomCleanup(t *testing.T) {
	hub := NewHub()
	ownerID, _ := hub.AddClient("owner-test-2", "创建者", func(string, any) {})
	guestID, _ := hub.AddClient("guest-test-2", "下一位", func(string, any) {})

	created, err := hub.Call(ownerID, "room.create", map[string]any{
		"name": "转交房",
		"game": "xiangqi",
	})
	if err != nil {
		t.Fatal(err)
	}
	roomID := created.(map[string]any)["roomId"].(string)
	if _, err := hub.Call(guestID, "room.join", map[string]any{"roomId": roomID}); err != nil {
		t.Fatal(err)
	}

	hub.RemoveClient(ownerID)
	hub.expireClient(ownerID)
	next, err := hub.Call(guestID, "room.snapshot", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := next.(map[string]any)["role"]; got != "host" {
		t.Fatalf("remaining member role = %v, want host", got)
	}

	hub.RemoveClient(guestID)
	hub.expireClient(guestID)
	if rooms := hub.LobbySnapshot()["rooms"].([]map[string]any); len(rooms) != 0 {
		t.Fatalf("empty room was not removed: %d rooms remain", len(rooms))
	}
}

func TestRoomClosesWhenOnlySpectatorsRemain(t *testing.T) {
	hub := NewHub()
	ownerID, _ := hub.AddClient("empty-owner-1", "创建者", func(string, any) {})
	guestID, _ := hub.AddClient("empty-guest-1", "挑战者", func(string, any) {})
	watchID, _ := hub.AddClient("empty-watch-1", "观战者", func(string, any) {})

	created, err := hub.Call(ownerID, "room.create", map[string]any{
		"name": "只剩观战的房间",
		"game": "xiangqi",
	})
	if err != nil {
		t.Fatal(err)
	}
	roomID := created.(map[string]any)["roomId"].(string)
	if _, err := hub.Call(guestID, "room.join", map[string]any{
		"roomId": roomID,
		"role":   "player",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := hub.Call(ownerID, "room.start", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := hub.Call(watchID, "room.join", map[string]any{
		"roomId": roomID,
		"role":   "spectator",
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := hub.Call(ownerID, "room.leave", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := hub.Call(guestID, "room.leave", nil); err != nil {
		t.Fatal(err)
	}
	if rooms := hub.LobbySnapshot()["rooms"].([]map[string]any); len(rooms) != 0 {
		t.Fatalf("a room with no seated players must close: %d rooms remain", len(rooms))
	}

	after, err := hub.Call(watchID, "room.snapshot", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := after.(map[string]any)["role"]; got != "idle" {
		t.Fatalf("remaining spectator role = %v, want idle", got)
	}
}

func TestReconnectKeepsSeatDuringGraceWindow(t *testing.T) {
	hub := NewHub()
	ownerID, _ := hub.AddClient("reconnect-owner", "创建者", func(string, any) {})
	created, err := hub.Call(ownerID, "room.create", map[string]any{
		"name": "重连房",
		"game": "gomoku",
	})
	if err != nil {
		t.Fatal(err)
	}
	roomID := created.(map[string]any)["roomId"].(string)

	hub.RemoveClient(ownerID)
	reconnectedID, _ := hub.AddClient(ownerID, "创建者", func(string, any) {})
	if reconnectedID != ownerID {
		t.Fatalf("reconnected id = %q, want %q", reconnectedID, ownerID)
	}
	restored, err := hub.Call(reconnectedID, "room.snapshot", nil)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := restored.(map[string]any)
	if snapshot["roomId"] != roomID || snapshot["selfSeat"] != 0 {
		t.Fatalf("reconnect did not restore room and seat: %#v", snapshot)
	}
}

func TestOpponentLeavingEndsMatchWithVisibleResult(t *testing.T) {
	hub := NewHub()
	ownerID, _ := hub.AddClient("leave-owner-1", "留下的人", func(string, any) {})
	guestID, _ := hub.AddClient("leave-guest-1", "离开的人", func(string, any) {})
	created, err := hub.Call(ownerID, "room.create", map[string]any{
		"name": "离场房",
		"game": "gomoku",
		"seat": float64(0),
	})
	if err != nil {
		t.Fatal(err)
	}
	roomID := created.(map[string]any)["roomId"].(string)
	if _, err := hub.Call(guestID, "room.join", map[string]any{
		"roomId": roomID,
		"role":   "player",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := hub.Call(ownerID, "room.start", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := hub.Call(guestID, "room.leave", nil); err != nil {
		t.Fatal(err)
	}

	remaining, err := hub.Call(ownerID, "room.snapshot", nil)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := remaining.(map[string]any)
	if snapshot["phase"] != "finished" {
		t.Fatalf("phase = %v, want finished", snapshot["phase"])
	}
	result, ok := snapshot["result"].(map[string]any)
	if !ok {
		t.Fatal("remaining player did not receive a terminal result")
	}
	if result["reason"] != "forfeit" || result["outcome"] != 1 {
		t.Fatalf("unexpected result: %#v", result)
	}
}
