import test from "node:test";
import assert from "node:assert/strict";

// A dropped socket used to surface as a hard error ("云端连接已断开") in the UI even though
// the bridge reconnects on its own. The UI now decides what to say from the attempt count
// emitted here, so this test pins that count down: the live drop itself is attempt 0, and
// only retries that never open a socket increment it.
const sockets = [];
const timers = [];

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = String(url);
    this.readyState = 0;
    this.listeners = {};
    sockets.push(this);
  }

  addEventListener(type, handler) {
    (this.listeners[type] ||= []).push(handler);
  }

  send() {}
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    for (const handler of this.listeners.open || []) handler({});
  }
  fail() {
    this.readyState = 3;
    for (const handler of this.listeners.close || []) handler({});
  }
}

test("a drop reports attempt 0, then every failed retry counts up", async () => {
  globalThis.window = {
    location: { search: "" },
    __DBX_MINI_GAMES_SERVER__: "ws://127.0.0.1:9/ws",
  };
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.WebSocket = FakeSocket;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  // The bridge schedules its retries through setTimeout; capturing them keeps the test
  // instant and lets it assert the backoff order.
  globalThis.setTimeout = (callback, delay) => {
    timers.push({ callback, delay });
    return timers.length;
  };
  globalThis.clearTimeout = () => {};

  try {
    const { createBridge } = await import("../src/bridge.js");
    const bridge = createBridge();
    const seen = [];
    bridge.onConnection((state) =>
      seen.push({ connected: Boolean(state.connected), attempts: Number(state.attempts) || 0 }),
    );
    await Promise.resolve();

    assert.deepEqual(seen.at(-1), { connected: false, attempts: 0 });

    sockets.at(-1).open();
    assert.deepEqual(seen.at(-1), { connected: true, attempts: 0 });

    sockets.at(-1).fail();
    assert.deepEqual(seen.at(-1), { connected: false, attempts: 0 });
    assert.equal(timers.at(-1).delay, 500);

    const delays = [];
    for (let failed = 1; failed <= 3; failed += 1) {
      timers.shift().callback();
      sockets.at(-1).fail();
      assert.deepEqual(seen.at(-1), { connected: false, attempts: failed });
      delays.push(timers.at(-1).delay);
    }
    assert.deepEqual(delays, [1000, 2000, 4000]);

    timers.shift().callback();
    sockets.at(-1).open();
    assert.deepEqual(seen.at(-1), { connected: true, attempts: 0 });
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});
