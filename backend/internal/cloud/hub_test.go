package cloud

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/lieng618/dbx-mini-games/backend/internal/room"
)

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

func TestNicknameValidationAndOwnerRoomRename(t *testing.T) {
	hub := NewHub()
	ownerID, _ := hub.AddClient("nickname-owner-1", "创建者", func(string, any) {})

	created, err := hub.Call(ownerID, "room.create", map[string]any{
		"name": "旧房间名",
		"game": "gomoku",
		"seat": float64(0),
	})
	if err != nil {
		t.Fatal(err)
	}
	roomID := created.(map[string]any)["roomId"].(string)

	saved, err := hub.Call(ownerID, "profile.save", map[string]any{"nickname": "新名字"})
	if err != nil {
		t.Fatal(err)
	}
	if nickname := saved.(map[string]any)["nickname"]; nickname != "新名字" {
		t.Fatalf("saved nickname = %v, want 新名字", nickname)
	}

	snapshotReply, err := hub.Call(ownerID, "room.snapshot", nil)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := snapshotReply.(map[string]any)
	if snapshot["roomId"] != roomID {
		t.Fatalf("room id changed after rename: %v", snapshot["roomId"])
	}
	if name := snapshot["name"]; name != "新名字的五子棋室" {
		t.Fatalf("room name = %v, want 新名字的五子棋室", name)
	}
	members := snapshot["members"].([]room.Member)
	if len(members) != 1 || members[0].Nickname != "新名字" {
		t.Fatalf("member nickname did not update: %#v", members)
	}

	invalid := []string{"a", strings.Repeat("棋", maxNicknameRunes+1), "名字 带空格", "管理员"}
	for _, nickname := range invalid {
		if _, err := hub.Call(ownerID, "profile.save", map[string]any{"nickname": nickname}); err == nil {
			t.Fatalf("nickname %q was accepted", nickname)
		}
	}
}

func TestInviteAutoJoinPrefersSeatThenSpectatesWhenFull(t *testing.T) {
	hub := NewHub()
	ownerID, _ := hub.AddClient("invite-owner-1", "房主", func(string, any) {})
	guestID, _ := hub.AddClient("invite-guest-1", "来客", func(string, any) {})
	watchID, _ := hub.AddClient("invite-watch-1", "旁观", func(string, any) {})

	created, err := hub.Call(ownerID, "room.create", map[string]any{
		"name": "邀请房",
		"game": "gomoku",
		"seat": float64(0),
	})
	if err != nil {
		t.Fatal(err)
	}
	roomID := created.(map[string]any)["roomId"].(string)

	seated, err := hub.Call(guestID, "room.join", map[string]any{
		"roomId": roomID,
		"role":   "auto",
	})
	if err != nil {
		t.Fatal(err)
	}
	if seat := seated.(map[string]any)["selfSeat"]; seat != 1 {
		t.Fatalf("auto invite seat = %v, want 1", seat)
	}

	watched, err := hub.Call(watchID, "room.join", map[string]any{
		"roomId": roomID,
		"role":   "auto",
	})
	if err != nil {
		t.Fatalf("auto invite did not fall back to spectator: %v", err)
	}
	if seat := watched.(map[string]any)["selfSeat"]; seat != -1 {
		t.Fatalf("full-room auto invite seat = %v, want -1", seat)
	}

	for index := 0; index < room.MaxParticipants-3; index++ {
		id := fmt.Sprintf("invite-extra-%d", index)
		hub.AddClient(id, "旁观", func(string, any) {})
		if _, err := hub.Call(id, "room.join", map[string]any{
			"roomId": roomID,
			"role":   "auto",
		}); err != nil {
			t.Fatalf("spectator %d could not join: %v", index, err)
		}
	}
	fullID, _ := hub.AddClient("invite-full-1", "满员", func(string, any) {})
	if _, err := hub.Call(fullID, "room.join", map[string]any{
		"roomId": roomID,
		"role":   "auto",
	}); err == nil {
		t.Fatal("auto invite admitted a ninth participant")
	}
}

func TestLockedRoomSpectatingRequiresTheRoomPassword(t *testing.T) {
	hub := NewHub()
	ownerID, _ := hub.AddClient("locked-owner", "房主", func(string, any) {})
	guestID, _ := hub.AddClient("locked-guest", "棋手", func(string, any) {})
	watcherID, _ := hub.AddClient("locked-watcher", "观战者", func(string, any) {})

	created, err := hub.Call(ownerID, "room.create", map[string]any{
		"name":     "密码房",
		"game":     "gomoku",
		"password": "s3cret",
	})
	if err != nil {
		t.Fatal(err)
	}
	roomID := created.(map[string]any)["roomId"].(string)
	if _, err := hub.Call(guestID, "room.join", map[string]any{
		"roomId":   roomID,
		"role":     "player",
		"password": "s3cret",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := hub.Call(ownerID, "room.start", nil); err != nil {
		t.Fatal(err)
	}

	if _, err := hub.Call(watcherID, "room.join", map[string]any{
		"roomId":   roomID,
		"role":     "spectator",
		"password": "wrong",
	}); err == nil {
		t.Fatal("spectator joined a locked room with the wrong password")
	}

	watched, err := hub.Call(watcherID, "room.join", map[string]any{
		"roomId":   roomID,
		"role":     "spectator",
		"password": "s3cret",
	})
	if err != nil {
		t.Fatalf("spectator could not join with the correct password: %v", err)
	}
	if seat := watched.(map[string]any)["selfSeat"]; seat != -1 {
		t.Fatalf("spectator seat = %v, want -1", seat)
	}
}

func TestCloudClockTimeoutEndsTheMatch(t *testing.T) {
	hub := NewHub()
	ownerID, _ := hub.AddClient("timeout-owner", "先手", func(string, any) {})
	guestID, _ := hub.AddClient("timeout-guest", "后手", func(string, any) {})

	created, err := hub.Call(ownerID, "room.create", map[string]any{
		"name":    "限时房",
		"game":    "gomoku",
		"minutes": float64(1),
	})
	if err != nil {
		t.Fatal(err)
	}
	roomID := created.(map[string]any)["roomId"].(string)
	if _, err := hub.Call(guestID, "room.join", map[string]any{"roomId": roomID}); err != nil {
		t.Fatal(err)
	}
	startedAt := time.Now()
	if _, err := hub.Call(ownerID, "room.start", nil); err != nil {
		t.Fatal(err)
	}
	hub.expireClocks(startedAt.Add(61 * time.Second))

	view, err := hub.Call(guestID, "room.snapshot", nil)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := view.(map[string]any)
	if snapshot["phase"] != "finished" {
		t.Fatalf("phase = %v, want finished", snapshot["phase"])
	}
	result, ok := snapshot["result"].(map[string]any)
	if !ok || result["reason"] != "timeout" || result["outcome"] != 2 {
		t.Fatalf("unexpected timeout result: %#v", snapshot["result"])
	}
}

func TestCloudUndoRequestIsVisibleAndConsentRewinds(t *testing.T) {
	hub := NewHub()
	ownerID, _ := hub.AddClient("undo-owner", "先手", func(string, any) {})
	guestID, _ := hub.AddClient("undo-guest", "后手", func(string, any) {})
	created, err := hub.Call(ownerID, "room.create", map[string]any{
		"name": "悔棋房",
		"game": "gomoku",
		"seat": float64(0),
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
	if _, err := hub.Call(ownerID, "game.move", map[string]any{"to": float64(112)}); err != nil {
		t.Fatal(err)
	}
	if _, err := hub.Call(ownerID, "game.undo.request", nil); err != nil {
		t.Fatal(err)
	}

	guestView, err := hub.Call(guestID, "room.snapshot", nil)
	if err != nil {
		t.Fatal(err)
	}
	pending := guestView.(map[string]any)
	if pending["undoRequestedBy"] != ownerID || pending["undoRequestedSeat"] != 0 {
		t.Fatalf("undo request missing from guest snapshot: %#v", pending)
	}
	if paused := pending["clock"].(map[string]any)["paused"]; paused != true {
		t.Fatalf("undo request must pause the clock, got %#v", pending["clock"])
	}
	if _, err := hub.Call(guestID, "game.undo.consent", nil); err != nil {
		t.Fatal(err)
	}
	after, err := hub.Call(guestID, "room.snapshot", nil)
	if err != nil {
		t.Fatal(err)
	}
	rewound := after.(map[string]any)
	if _, ok := rewound["undoRequestedBy"]; ok {
		t.Fatal("completed undo left a stale request in the snapshot")
	}
	if rewound["moveCount"] != 0 || rewound["turnSeat"] != 0 {
		t.Fatalf("undo did not restore the opening position: %#v", rewound)
	}
	if paused := rewound["clock"].(map[string]any)["paused"]; paused != false {
		t.Fatal("consented undo did not resume the clock")
	}
}

func TestCloudUndoRequestExpiresOnTheServer(t *testing.T) {
	hub := NewHub()
	ownerID, _ := hub.AddClient("undo-expiry-owner", "先手", func(string, any) {})
	guestID, _ := hub.AddClient("undo-expiry-guest", "后手", func(string, any) {})
	created, err := hub.Call(ownerID, "room.create", map[string]any{
		"name": "悔棋超时房",
		"game": "gomoku",
		"seat": float64(0),
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
	if _, err := hub.Call(ownerID, "game.move", map[string]any{"to": float64(0)}); err != nil {
		t.Fatal(err)
	}
	requested, err := hub.Call(ownerID, "game.undo.request", nil)
	if err != nil {
		t.Fatal(err)
	}
	if remaining := requested.(map[string]any)["undoRemainingMs"]; remaining == nil {
		t.Fatal("undo snapshot did not expose its server deadline")
	}

	hub.expireClocks(time.Now().Add(undoDecisionTimeout + time.Second))
	view, err := hub.Call(guestID, "room.snapshot", nil)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := view.(map[string]any)
	if snapshot["undoRequestedBy"] != nil {
		t.Fatalf("expired undo request is still visible: %#v", snapshot)
	}
	clock := snapshot["clock"].(map[string]any)
	if clock["paused"] != false || clock["running"] == -1 {
		t.Fatalf("clock did not resume after undo expired: %#v", clock)
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

func TestOldConnectionCleanupCannotDisconnectReplacementSession(t *testing.T) {
	hub := NewHub()
	clientID, _, oldToken := hub.AddClientSession("stale-reconnect", "重连者", func(string, any) {})
	clientID, _, newToken := hub.AddClientSession(clientID, "重连者", func(string, any) {})

	if _, err := hub.CallSession(clientID, oldToken, "profile.get", nil); err == nil {
		t.Fatal("a replaced connection could still submit requests")
	}
	if _, err := hub.CallSession(clientID, newToken, "profile.get", nil); err != nil {
		t.Fatalf("the current connection was rejected: %v", err)
	}

	hub.RemoveClientSession(clientID, oldToken)
	hub.expireClientSession(clientID, oldToken)
	if _, err := hub.Call(clientID, "profile.get", nil); err != nil {
		t.Fatalf("stale cleanup removed the replacement session: %v", err)
	}

	hub.RemoveClientSession(clientID, newToken)
	hub.expireClientSession(clientID, newToken)
	if _, err := hub.Call(clientID, "profile.get", nil); err == nil {
		t.Fatal("removing the current connection did not expire its session")
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
	if snapshot["roomFinishedAt"] == int64(0) {
		t.Fatal("forfeit did not record the match end time")
	}
	if running := snapshot["clock"].(map[string]any)["running"]; running != -1 {
		t.Fatalf("forfeit clock running = %v, want -1", running)
	}
}
