import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CREATE_ROOM_SETTINGS,
  loadCreateRoomSettings,
  saveCreateRoomSettings,
} from "../src/storage.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

test("create-room defaults enable scoring", () => {
  globalThis.localStorage = memoryStorage();
  assert.deepEqual(loadCreateRoomSettings(), { ...DEFAULT_CREATE_ROOM_SETTINGS });
  assert.equal(DEFAULT_CREATE_ROOM_SETTINGS.scoring, true);
});

test("create-room rule choices survive the next visit", () => {
  globalThis.localStorage = memoryStorage();
  saveCreateRoomSettings({
    game: "gomoku",
    seat: 1,
    minutes: 30,
    moveSeconds: 15,
    scoring: false,
    passwordEnabled: true,
  });
  assert.deepEqual(loadCreateRoomSettings(), {
    game: "gomoku",
    seat: 1,
    minutes: 30,
    moveSeconds: 15,
    scoring: false,
    passwordEnabled: true,
  });
});

test("create-room drafts reject unsupported stored values", () => {
  const storage = memoryStorage();
  storage.setItem(
    "dbxmg.createRoom",
    JSON.stringify({
      game: "go",
      seat: 7,
      minutes: 999,
      moveSeconds: -1,
      scoring: "yes",
      passwordEnabled: "yes",
    }),
  );
  globalThis.localStorage = storage;
  assert.deepEqual(loadCreateRoomSettings(), {
    game: "xiangqi",
    seat: 0,
    minutes: 0,
    moveSeconds: 0,
    scoring: true,
    passwordEnabled: false,
  });
});
