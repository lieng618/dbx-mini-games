/**
 * The bridge to the DBX host.
 *
 * The UI runs inside a sandboxed iframe. Everything it can do goes through
 * `window.dbxPlugin`: invoking the sidecar and receiving events. This module hides that
 * shape and provides a stand-in when the page is opened outside DBX, so the board and its
 * effects can be developed in a plain browser.
 */

/** True when running inside the DBX host bridge. */
export function hasHost() {
  return typeof window !== "undefined" && !!window.dbxPlugin && typeof window.dbxPlugin.invoke === "function";
}

/** Resolves once the host has finished initialising the plugin. */
export async function whenReady() {
  if (!hasHost()) return null;
  try {
    await window.dbxPlugin.ready;
  } catch {
    // A failed ready still leaves a usable bridge in some host versions; the first
    // invoke will surface a real error.
  }
  return window.dbxPlugin;
}

/**
 * CreateBridge returns an object with `invoke`, `on`, and `locale`.
 *
 * Outside DBX it installs a small local stand-in that answers enough methods to render and
 * exercise the UI: a lobby, one hosted room, and a driven board. That keeps visual work
 * independent of a packaged build.
 */
export function createBridge() {
  if (hasHost()) {
    return {
      live: true,
      locale: () => (window.dbxPlugin.locale || "zh-CN"),
      invoke: (method, params) => window.dbxPlugin.invoke(method, params ?? {}),
      on: (handler) => (typeof window.dbxPlugin.onEvent === "function" ? window.dbxPlugin.onEvent(handler) : () => {}),
    };
  }
  return createLocalBridge();
}

/**
 * The local stand-in. It is deliberately not a rules engine: it exists to render states,
 * not to adjudicate them. Anything that needs real authority goes through the sidecar.
 */
function createLocalBridge() {
  const listeners = new Set();
  const emit = (method, params) => {
    for (const fn of listeners) {
      try {
        fn({ method, params });
      } catch {
        // A broken listener must not take down the others.
      }
    }
  };

  const state = {
    role: "idle",
    roomId: null,
    name: "本地预览房",
    game: "xiangqi",
    phase: "lobby",
    seats: ["me", "rival"],
    members: [
      { id: "me", nickname: "我", seat: 0, connected: true, isHost: true },
      { id: "rival", nickname: "对手", seat: 1, connected: true, isHost: false },
    ],
    lowMotion: false,
    turnSeat: 0,
    lastMove: null,
    inCheck: false,
    checkFocus: null,
    result: null,
    winLine: [],
    cells: null,
  };

  // Both openings are static data, not rule logic. The preview has no referee; it exists
  // so pieces and effects can be looked at in a plain browser.
  const xiangqiOpening = () => {
    const board = new Array(90).fill(0);
    const back = [5, 4, 3, 2, 1, 2, 3, 4, 5];
    for (let f = 0; f < 9; f++) {
      board[f] = -back[f];
      board[9 * 9 + f] = back[f];
    }
    board[2 * 9 + 1] = -6;
    board[2 * 9 + 7] = -6;
    board[7 * 9 + 1] = 6;
    board[7 * 9 + 7] = 6;
    for (const f of [0, 2, 4, 6, 8]) {
      board[3 * 9 + f] = -7;
      board[6 * 9 + f] = 7;
    }
    return board;
  };

  const gomokuOpening = () => new Array(225).fill(0);

  // A short scripted line per game. Each entry is a move the preview will apply when the
  // board is clicked, purely to produce states worth looking at.
  const scripts = {
    xiangqi: [
      { from: 7 * 9 + 1, to: 7 * 9 + 4 },
      { from: 0 * 9 + 1, to: 2 * 9 + 2 },
      { from: 7 * 9 + 7, to: 7 * 9 + 6 },
      { from: 0 * 9 + 7, to: 0 * 9 + 6 },
      { from: 9 * 9 + 1, to: 7 * 9 + 2 },
      { from: 2 * 9 + 2, to: 3 * 9 + 4 },
    ],
    gomoku: [
      { from: -1, to: 7 * 15 + 7 },
      { from: -1, to: 7 * 15 + 8 },
      { from: -1, to: 8 * 15 + 7 },
      { from: -1, to: 6 * 15 + 8 },
      { from: -1, to: 6 * 15 + 7 },
      { from: -1, to: 8 * 15 + 8 },
    ],
  };

  let scriptIndex = 0;

  const snapshot = () => ({
    role: state.role,
    roomId: state.roomId,
    name: state.name,
    game: state.game,
    phase: state.phase,
    selfId: "me",
    seats: state.seats,
    members: state.members,
    lowMotion: state.lowMotion,
    cells: state.cells,
    turnSeat: state.turnSeat,
    lastMove: state.lastMove,
    inCheck: state.inCheck,
    checkFocus: state.checkFocus,
    result: state.result,
    winLine: state.winLine,
    clock: { remaining: [600000, 600000], running: state.turnSeat, budget: 600000 },
  });

  const resetBoard = () => {
    state.cells = state.game === "xiangqi" ? xiangqiOpening() : gomokuOpening();
    state.turnSeat = 0;
    state.lastMove = null;
    state.inCheck = false;
    state.checkFocus = null;
    state.result = null;
    state.winLine = [];
    scriptIndex = 0;
  };

  return {
    live: false,
    locale: () => "zh-CN",
    on: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    invoke: async (method, params = {}) => {
      switch (method) {
        case "profile.get":
          return { id: "local", nickname: "我", lowMotion: state.lowMotion };
        case "profile.save": {
          if (typeof params.lowMotion === "boolean") state.lowMotion = params.lowMotion;
          return { id: "local", nickname: params.nickname || "我", lowMotion: state.lowMotion };
        }
        case "room.snapshot":
          return snapshot();
        case "room.create":
          state.role = "host";
          state.roomId = "local-room";
          state.game = params.game || "xiangqi";
          state.phase = "lobby";
          resetBoard();
          return snapshot();
        case "room.join":
          state.role = "guest";
          state.roomId = "local-room";
          resetBoard();
          return snapshot();
        case "room.leave":
          state.role = "idle";
          state.roomId = null;
          state.cells = null;
          return { ok: true };
        case "lobby.scan":
          return { rooms: [] };
        case "room.start":
          state.phase = "playing";
          resetBoard();
          return snapshot();
        case "room.practice.start":
          state.phase = "practice";
          resetBoard();
          return snapshot();
        case "room.practice.end":
          state.phase = "lobby";
          resetBoard();
          return snapshot();
        case "game.legal": {
          // The preview offers no legality: it answers with every empty square so the hint
          // layer can be inspected, and nothing more.
          const from = Number(params.from ?? -1);
          if (from < 0 || !state.cells) return { destinations: [] };
          const dests = [];
          for (let i = 0; i < state.cells.length; i++) if (!state.cells[i]) dests.push(i);
          return { destinations: dests.slice(0, 24) };
        }
        case "game.move": {
          const line = scripts[state.game] || [];
          const move = line[scriptIndex];
          if (!move) return snapshot();
          scriptIndex += 1;
          const next = state.cells.slice();
          if (state.game === "xiangqi") {
            next[move.to] = next[move.from];
            next[move.from] = 0;
          } else {
            next[move.to] = scriptIndex % 2 === 1 ? 1 : 2;
          }
          state.cells = next;
          state.lastMove = move;
          state.turnSeat = scriptIndex % 2;
          // Cue a check announcement partway through the script so the loudest effect can
          // be reviewed without a real referee.
          state.inCheck = state.game === "xiangqi" && scriptIndex === 5;
          state.checkFocus = state.inCheck ? 4 : null;
          return snapshot();
        }
        case "game.resign":
          state.phase = "finished";
          state.result = { finished: true, outcome: 1, reason: "resign" };
          return snapshot();
        case "game.rematch":
          state.phase = "lobby";
          resetBoard();
          return snapshot();
        case "replay.state": {
          // The preview replays its scripted line by rebuilding the opening and applying
          // the first N entries, mirroring what the sidecar does.
          const line = scripts[state.game] || [];
          const ply = Math.max(0, Math.min(line.length, Number(params.ply ?? line.length)));
          const board = state.game === "xiangqi" ? xiangqiOpening() : gomokuOpening();
          for (let i = 0; i < ply; i++) {
            const mv = line[i];
            if (state.game === "xiangqi") {
              board[mv.to] = board[mv.from];
              board[mv.from] = 0;
            } else {
              board[mv.to] = i % 2 === 0 ? 1 : 2;
            }
          }
          const last = ply > 0 ? line[ply - 1] : null;
          return {
            ply,
            total: line.length,
            cells: board,
            turnSeat: ply % 2,
            notation: line.slice(0, ply).map((_, i) => `第 ${i + 1} 手`),
            lastMove: last,
            result: ply >= line.length ? state.result : null,
          };
        }
        case "replay.notation":
          return { notation: (scripts[state.game] || []).slice(0, scriptIndex).map((_, i) => `第 ${i + 1} 手`) };
        case "room.seat":
        case "room.release":
        case "game.undo.request":
        case "game.undo.consent":
          return snapshot();
        default:
          if (method.startsWith("game.") || method.startsWith("room.") || method.startsWith("replay.")) {
            return snapshot();
          }
          throw new Error(`本地预览未实现 ${method}`);
      }
    },
    _emit: emit,
  };
}
