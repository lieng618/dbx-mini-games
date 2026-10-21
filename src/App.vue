/**
 * App.vue — the workbench shell.
 *
 * Layout: a lobby rail on the left, the board in the centre, and a control bar beneath it
 * that becomes the replay scrubber once a match has ended.
 */
<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { BoardScene } from "./board/scene.js";
import { createBridge, whenReady } from "./bridge.js";

const GAMES = [
  { id: "xiangqi", name: "中国象棋" },
  { id: "gomoku", name: "五子棋" },
];

const bridge = createBridge();
const ready = ref(false);
const role = ref("idle");
const roomId = ref(null);
const roomName = ref("");
const game = ref("xiangqi");
const phase = ref("lobby");
const members = ref([]);
const seats = ref(["", ""]);
const selfId = ref("");
const hostKey = ref("");
const addresses = ref([]);
const lowMotion = ref(false);
// Sound is a local preference, not part of the host profile: it changes nothing the other
// players see, so it does not belong in the wire protocol.
const soundOn = ref(true);
const lobbyRooms = ref([]);
const scanning = ref(false);
const error = ref("");
const notice = ref("");

const cells = ref([]);
const lastMove = ref(null);
const inCheck = ref(false);
const checkFocus = ref(null);
const result = ref(null);
const winLine = ref([]);
const clock = ref(null);
// The practice partner's seat, or -1. Kept separate from `seats` because the partner is
// not a member: it has a seat but no id, no nickname and no connection.
const aiSeat = ref(-1);
const aiThinking = ref(false);
const record = ref(null);
const notation = ref([]);
const replayPly = ref(0);
const replayTotal = ref(0);
const replaying = ref(false);

const inputName = ref("我的棋室");
const inputPassword = ref("");
// Time control chosen before the table exists. 0 means "no limit" for either field.
const inputMinutes = ref(10);
const inputMoveSeconds = ref(0);
// Which side the host wants. -1 keeps the old "first free seat" behaviour.
const inputSeat = ref(-1);
const inputAddress = ref("");

const boardHost = ref(null);
const canvasFailed = ref(false);
let scene = null;

const mySeat = computed(() => seats.value.findIndex((id) => id && id === selfId.value));
const isSeated = computed(() => mySeat.value >= 0);
const isPractice = computed(() => phase.value === "practice");
const isMyTurn = computed(() => {
  if (phase.value !== "playing") return false;
  const turn = cells.value.turnSeat;
  return isSeated.value && turn === mySeat.value;
});
/**
 * The complete invitation: address, room id and host public key.
 *
 * Joining needs all three. Discovery supplies the last two, so a room that mDNS cannot see
 * was previously impossible to join by hand — pasting the address alone always failed with
 * "a valid host key is required". One pasteable string fixes that.
 */
const inviteLink = computed(() => {
  if (role.value !== "host") return "";
  const address = addresses.value[0];
  if (!address || !roomId.value || !hostKey.value) return "";
  return `${address}#${roomId.value}#${hostKey.value}`;
});

/** What to call whoever sits in a seat, including the partner, which is not a member. */
function seatLabel(seat) {
  if (seat === aiSeat.value) return "陪练";
  const m = seatMembers.value[seat];
  return m ? m.nickname : "空座";
}

/** True when the seat is the one currently thinking. */
function seatActive(seat) {
  if (!clock.value) return false;
  return clock.value.running === seat;
}

/** How a seat is named on the board, which depends on the game. */
function sideName(seat) {
  if (game.value === "xiangqi") return seat === 0 ? "红方 · 先手" : "黑方 · 后手";
  return seat === 0 ? "黑棋 · 先手" : "白棋 · 后手";
}

/** True while the practice partner holds the turn. */
const isAiTurn = computed(() => aiSeat.value >= 0 && (cells.value.turnSeat ?? 0) === aiSeat.value);

const seatMembers = computed(() =>
  seats.value.map((id) => members.value.find((m) => m.id === id) || null),
);
const spectators = computed(() => members.value.filter((m) => !seats.value.includes(m.id)));

/** Applies any host snapshot to local state. */
function applySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  if (snapshot.role) role.value = snapshot.role;
  if (snapshot.roomId !== undefined) roomId.value = snapshot.roomId;
  if (snapshot.name !== undefined) roomName.value = snapshot.name;
  if (snapshot.game) game.value = snapshot.game;
  if (snapshot.phase) phase.value = snapshot.phase;
  if (snapshot.selfId) selfId.value = snapshot.selfId;
  if (snapshot.hostKey) hostKey.value = snapshot.hostKey;
  if (snapshot.addresses) addresses.value = snapshot.addresses;
  if (typeof snapshot.lowMotion === "boolean") lowMotion.value = snapshot.lowMotion;
  if (Array.isArray(snapshot.members)) members.value = snapshot.members;
  if (Array.isArray(snapshot.seats)) seats.value = snapshot.seats;
  if (snapshot.clock) clock.value = snapshot.clock;
  if (snapshot.record) {
    record.value = snapshot.record;
    if (snapshot.record.moves) cells.value = { ...cells.value, moves: snapshot.record.moves };
  }

  if (snapshot.cells) {
    cells.value = {
      ...cells.value,
      board: snapshot.cells,
      turnSeat: snapshot.turnSeat ?? cells.value.turnSeat ?? null,
    };
  }
  if (snapshot.lastMove !== undefined) lastMove.value = snapshot.lastMove;
  // `applySnapshot` folds every reply, not just room snapshots: replay.notation returns
  // {notation}, profile.get returns a profile, and so on. So the transient effects state is
  // only recomputed when the reply really is a whole room snapshot — otherwise a notation
  // fetch right after 将军 would wipe the check it had just raised. Within a real snapshot
  // absence does mean false, which is what clears a check the move has answered.
  const isRoomSnapshot = Array.isArray(snapshot.members) && typeof snapshot.phase === "string";
  if (isRoomSnapshot) {
    aiSeat.value = typeof snapshot.aiSeat === "number" ? snapshot.aiSeat : -1;
    inCheck.value = snapshot.inCheck === true;
    checkFocus.value = snapshot.checkFocus ?? null;
    result.value = snapshot.result ?? null;
    winLine.value = snapshot.winLine ?? [];
  }
  paint();
}

/** Pushes current state into the canvas scene. */
function paint() {
  if (!scene) return;
  const board = cells.value.board || [];
  if (!board.length) return;
  scene.update({
    cells: cells.value.board || [],
    lastMove: lastMove.value,
    inCheck: inCheck.value,
    checkFocus: checkFocus.value,
    result: result.value,
    winLine: winLine.value,
    lowMotion: lowMotion.value,
  });
}

/** Sends one host invocation and folds the reply into state. */
/** Maps a sidecar error to something a player can act on. */
function describeError(raw) {
  const text = String(raw ?? "");
  const table = [
    // "Not enough players" is the opposite of "full". These two used to share one error,
    // so a lone host pressing 开始对局 was told the room was full.
    ["both seats must be filled", "还差一位对手才能开始，等朋友加入，或先摆一摆"],
    ["both seats are already taken by players", "两个座位都坐着真人，陪练没位置了"],
    ["no seated player to start practice", "没有人在座位上，无法开始练习"],
    ["seat already occupied", "这个座位已经有人了"],
    ["that seat does not exist", "没有这个座位"],
    ["a match is already in progress", "对局正在进行中，无法调整座位"],
    ["room is full", "房间人数已满（8 人）"],
    ["not your turn", "还没轮到你走棋"],
    ["illegal move", "这一步不合规则"],
    ["only seated players may do that", "你在观战，坐下后才能操作"],
    ["not hosting a room", "当前没有房间，请先开桌"],
    ["already hosting or joined a room", "你已经在一个房间里了"],
    ["wrong room password", "房间密码不正确"],
    [
      "a valid host key is required",
      "地址不完整：请让房主把「邀请串」整串发你（地址#房间号#公钥），或改用搜索局域网房间",
    ],
    ["an address is required", "请填写房间地址"],
    // Network failures used to surface as raw Go: "dial tcp 192.168.1.116:52525: connect:
    // no route to host". Each of these means something different and only one of them is
    // the player's fault, so they get their own words.
    [
      "no route to host",
      "连不上这个地址：确认用的是对方 WiFi 那个地址（不是 VPN/公司网那个），且两台机器在同一个 WiFi",
    ],
    ["connection refused", "这个地址没有房间在等：对方可能已经结束了房间，地址是旧的"],
    ["i/o timeout", "连接超时：两台机器可能不在同一个网络，或被防火墙拦住了"],
    ["operation not permitted", "系统拦住了局域网访问：请在「系统设置 → 隐私与安全性 → 本地网络」里允许 DBX"],
    ["join rejected", "加入被拒绝，请确认地址与密码"],
  ];
  for (const [needle, message] of table) {
    if (text.includes(needle)) return message;
  }
  return text || "操作失败";
}

async function call(method, params = {}) {
  error.value = "";
  try {
    const reply = await bridge.invoke(method, params);
    if (reply && typeof reply === "object") applySnapshot(reply);
    return reply;
  } catch (e) {
    error.value = describeError(e?.message || e);
    return null;
  }
}

async function createRoom() {
  await call("room.create", {
    name: inputName.value || "我的棋室",
    game: game.value,
    password: inputPassword.value,
    minutes: Number(inputMinutes.value) || 0,
    moveSeconds: Number(inputMoveSeconds.value) || 0,
    seat: Number(inputSeat.value),
  });
}

async function joinRoom(room) {
  await call("room.join", {
    address: room.address,
    roomId: room.roomId,
    hostKey: room.hostKey,
    password: inputPassword.value,
  });
}

async function joinByAddress() {
  if (!inputAddress.value) return;
  const [address, roomIdPart, keyPart] = inputAddress.value.trim().split("#");
  await call("room.join", {
    address: address.trim(),
    roomId: (roomIdPart || "").trim(),
    hostKey: (keyPart || hostKey.value).trim(),
  });
}

async function scan() {
  scanning.value = true;
  try {
    const reply = await call("lobby.scan", { windowMs: 1500 });
    if (reply && Array.isArray(reply.rooms)) lobbyRooms.value = reply.rooms;
  } finally {
    scanning.value = false;
  }
}

async function startMatch() {
  scene?.clearEffects();
  await call("room.start");
}

/** Opens a solo board so one player can look at the table and its effects. */
async function startPractice() {
  scene?.clearEffects();
  await call("room.practice.start");
}

async function endPractice() {
  scene?.clearEffects();
  await call("room.practice.end");
}

/**
 * Plays a scripted position so a specific effect can be inspected on demand.
 *
 * This is a practice-board convenience, not a game feature: it never runs during a real
 * match, which the sidecar also enforces.
 */
/** Starts a practice board with the partner holding the other seat. */
async function startPartner() {
  scene?.clearEffects();
  await call("room.ai.start");
}

/**
 * Gives the partner its turn.
 *
 * The reply is a separate host call on purpose. Applying both moves inside one snapshot
 * makes the piece diff read as a rebuild, and the pair would teleport instead of animating.
 */
async function partnerReply() {
  if (phase.value !== "practice" || aiSeat.value < 0) return;
  if ((cells.value.turnSeat ?? 0) !== aiSeat.value) return;
  aiThinking.value = true;
  try {
    // A beat before answering: replying inside the landing animation reads as a glitch
    // rather than as someone considering a move.
    await new Promise((resolve) => setTimeout(resolve, 420));
    await call("room.ai.move");
    await loadNotation();
  } finally {
    aiThinking.value = false;
  }
}

async function runScenario(name) {
  scene?.clearEffects();
  const reply = await call("dev.scenario", { name });
  if (reply) await loadNotation();
}

async function resign() {
  await call("game.resign");
}

async function rematch() {
  scene?.clearEffects();
  await call("game.rematch");
}

async function leaveRoom() {
  scene?.clearEffects();
  await call("room.leave");
  role.value = "idle";
  roomId.value = null;
  phase.value = "lobby";
  cells.value = {};
  lastMove.value = null;
  result.value = null;
  members.value = [];
  seats.value = ["", ""];
}

async function toggleLowMotion() {
  lowMotion.value = !lowMotion.value;
  await call("profile.save", { lowMotion: lowMotion.value });
  paint();
}

/** Mutes or unmutes effect audio. Persisted in localStorage, never in the host profile. */
function toggleSound() {
  soundOn.value = !soundOn.value;
  scene?.audio.setEnabled(soundOn.value);
  try {
    localStorage.setItem("dbxbg.sound", soundOn.value ? "on" : "off");
  } catch {
    // A blocked storage write only loses the preference across reloads.
  }
}

/** Handles a click on a board intersection. */
async function onCell(index) {
  const canMove = (phase.value === "playing" && isMyTurn.value) || phase.value === "practice";
  if (!canMove || !isSeated.value) return;
  // While the partner owns the turn the board is read-only: otherwise the player could
  // move twice, and the partner's own move would then be rejected as out of turn.
  if (aiThinking.value || isAiTurn.value) return;
  const board = cells.value.board || [];
  const code = board[index] || 0;

  // First click: pick up one of my own pieces (xiangqi) or place a stone (gomoku).
  if (game.value === "xiangqi") {
    const turn = cells.value.turnSeat ?? 0;
    const mine = isPractice.value ? (turn === 0 ? code > 0 : code < 0) : mySeat.value === 0 ? code > 0 : code < 0;
    if (code && mine) {
      scene?.select(index);
      const reply = await bridge.invoke("game.legal", { from: index }).catch(() => null);
      scene?.showHints(reply?.destinations || []);
      return;
    }
    const selected = scene?.selected ?? -1;
    if (selected >= 0) {
      scene?.clearSelection();
      await call("game.move", { from: selected, to: index });
      await loadNotation();
      await partnerReply();
    }
    return;
  }

  // Gomoku: one click is one move.
  if (code) return;
  await call("game.move", { to: index });
  await loadNotation();
  await partnerReply();
}

async function loadNotation() {
  const reply = await call("replay.notation");
  if (reply && Array.isArray(reply.notation)) notation.value = reply.notation;
  const rec = record.value;
  replayTotal.value = rec?.moves?.length ?? notation.value.length;
  replayPly.value = replayTotal.value;
}

/** Shows the board at a given ply. The sidecar rebuilds the position, so this is stateless. */
async function seekPly(ply) {
  const target = Math.max(0, Math.min(replayTotal.value, ply));
  try {
    const state = await bridge.invoke("replay.state", { ply: target });
    if (!state) return;
    replayPly.value = state.ply;
    replaying.value = true;
    scene?.clearEffects();
    cells.value = { ...cells.value, board: state.cells, turnSeat: state.turnSeat };
    lastMove.value = state.lastMove || null;
    result.value = state.ply >= state.total ? state.result : null;
    if (Array.isArray(state.notation)) notation.value = state.notation;
    paint();
  } catch (e) {
    error.value = describeError(e?.message || e);
  }
}

function replayFirst() { seekPly(0); }
function replayPrev() { seekPly(replayPly.value - 1); }
function replayNext() { seekPly(replayPly.value + 1); }
function replayLast() { seekPly(replayTotal.value); }

/** Leaves replay and returns to the live position. */
async function exitReplay() {
  replaying.value = false;
  await call("room.snapshot");
  paint();
}

/** Exports the recorded game as plain text: a header plus one ply per line. */
function exportRecord() {
  const rec = record.value;
  if (!rec || !rec.moves) return;
  const lines = [
    `棋牌桌对局记录`,
    `棋种: ${rec.game === "xiangqi" ? "中国象棋" : "五子棋"}`,
    `手数: ${rec.moves.length}`,
    rec.outcome ? `结果: ${outcomeText(rec.outcome)}${rec.reason ? `（${rec.reason}）` : ""}` : "结果: 未分胜负",
    "",
    ...(notation.value.length
      ? notation.value.map((n, i) => `${String(i + 1).padStart(3, " ")}. ${n}`)
      : rec.moves.map((m, i) => `${String(i + 1).padStart(3, " ")}. ${m.from} -> ${m.to}`)),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${rec.game}-${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function outcomeText(outcome) {
  if (outcome === 1) return "先手胜";
  if (outcome === 2) return "后手胜";
  if (outcome === 3) return "和棋";
  return "对局结束";
}

// ── MVP panel ───────────────────────────────────────────────────────────────────────
// The win screen is theatre on purpose: a bare "先手胜" says who won but not that anything
// happened. Titles key off the engine's own reason string, so the wording can never drift
// from why the match actually ended.
const mvpDismissed = ref(false);
// 结算特效要先把连线画完、印章落下（WinEffect 的 draw 0.85 + hold 0.35 + stamp 0.7，
// 后面还有一记冲击波），面板等它演完再登场，否则一结束就把棋盘盖住了。
const mvpReady = ref(false);
let mvpTimer = null;

const MVP_TITLES = {
  "five in a row": "五连绝世",
  checkmate: "一击必杀",
  stalemate: "困毙流大师",
  resign: "不战而屈人之兵",
  timeout: "时间管理大师",
  forfeit: "人走茶凉",
  "sixty-move rule": "六十回合拉锯王",
  repetition: "复读机",
  "board full": "满盘和棋",
};

const mvp = computed(() => {
  const res = result.value;
  if (!res || !res.finished || mvpDismissed.value || !mvpReady.value) return null;

  const draw = res.outcome === 3;
  const winnerSeat = res.outcome === 1 ? 0 : res.outcome === 2 ? 1 : -1;
  const moves = record.value?.moves?.length ?? 0;

  let title = MVP_TITLES[res.reason] || "本局最佳";
  if (!draw && moves > 0) {
    if (moves <= 9) title = `闪电${title}`;
    else if (moves >= 60) title = `马拉松${title}`;
  }

  const stats = [{ label: "总手数", value: moves }];
  const remaining = clock.value?.remaining;
  if (Array.isArray(remaining) && remaining.length === 2) {
    const pairs = draw
      ? [["先手余时", 0], ["后手余时", 1]]
      : [["胜者余时", winnerSeat], ["对手余时", winnerSeat === 0 ? 1 : 0]];
    for (const [label, seat] of pairs) {
      stats.push({ label, value: formatClock(remaining[seat] ?? 0) });
    }
  }

  return {
    name: draw ? "两位棋手" : seatLabel(winnerSeat),
    title,
    reason: res.reason || "",
    draw,
    stats,
  };
});

// A fresh result means a fresh match, so the panel may appear again — after the board has
// finished its own celebration. Low-motion shortens the whole effect to well under a second.
watch(result, (next) => {
  mvpDismissed.value = false;
  mvpReady.value = false;
  if (mvpTimer) clearTimeout(mvpTimer);
  mvpTimer = null;
  if (next && next.finished) {
    mvpTimer = setTimeout(() => {
      mvpReady.value = true;
      mvpTimer = null;
    }, lowMotion.value ? 1000 : 2300);
  }
});

function dismissMvp() {
  mvpDismissed.value = true;
}

// Fixed pseudo-random placement: the ribbons must not jump around when the panel re-renders.
function confettiStyle(n) {
  const colors = ["#c8a24a", "#8f2f28", "#4a6b52", "#2f2a24", "#d9c48a"];
  return {
    left: `${(n * 37) % 100}%`,
    animationDelay: `${((n * 13) % 30) / 10}s`,
    animationDuration: `${2.6 + ((n * 7) % 20) / 10}s`,
    background: colors[n % colors.length],
  };
}

watch(phase, (next) => {
  if (next === "finished" || next === "practice" || next === "playing") loadNotation();
});

// A move changes the record length, so keep the scrubber in step with the live board
// unless the player is deliberately reviewing an earlier position.
watch(
  () => cells.value.board?.length,
  () => {
    if (replaying.value) return;
    const moves = record.value?.moves?.length ?? 0;
    if (moves > replayTotal.value) {
      replayTotal.value = moves;
      replayPly.value = moves;
      if (!notation.value.length) loadNotation();
    }
  },
);

// ── Clock ───────────────────────────────────────────────────────────────────────────
// The host owns the clock, so the display is refreshed from it rather than kept in step by
// hand. An earlier version also decremented locally between snapshots; the two writers
// fought, the local one always won the last word, and the countdown drifted to zero while
// the host still had nearly three minutes on it. One source, polled, cannot disagree.
//
// The poll is also what makes a flag fall: the sidecar checks for a timeout on every call,
// so a client that only waits still loses on time.
let syncTimer = null;

function startClockTimers() {
  if (syncTimer) return;
  syncTimer = setInterval(() => {
    if (phase.value === "playing") call("room.snapshot");
  }, 500);
}

function stopClockTimers() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
}

// ── Pushed changes ──────────────────────────────────────────────────────────────────
// Two things change with no local action to ride along with: a challenger taking the
// second seat, and the host pushing state after the opponent moves. The lobby does not
// poll and a guest never polls, so without a listener the table sits still until somebody
// clicks something — which is exactly the "joined but the match never started" freeze.
let stopEvents = null;
let refreshInFlight = false;

async function refreshFromEvent() {
  // A burst of pushes collapses into one read; the snapshot is authoritative either way.
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    await call("room.snapshot");
  } finally {
    refreshInFlight = false;
  }
}

function startEvents() {
  if (stopEvents) return;
  stopEvents = bridge.on((event) => {
    const method = event?.method;
    // room.members: seat occupancy changed. room.state: the host pushed a new snapshot.
    if (method !== "room.members" && method !== "room.state") return;
    void refreshFromEvent();
  });
}

function stopEventListening() {
  if (typeof stopEvents === "function") stopEvents();
  stopEvents = null;
}

onMounted(async () => {
  await whenReady();
  ready.value = true;

  if (boardHost.value) {
    try {
      scene = new BoardScene({ onCell });
      await scene.init(boardHost.value, game.value);
      // Seat two looks at the board from the far side of the table, so the pieces they
      // command sit along the near edge the way a real board faces each player.
      scene.setFlipped(mySeat.value === 1);
      // A debug handle for the verification scripts: sampling piece positions needs to see
      // the running scene, and a screenshot is too slow to resolve a 200 ms tween. Gated on
      // an explicit flag so a normal session keeps its scope clean.
      if (typeof window !== "undefined" && window.__DBX_DEBUG_FX) {
        window.__boardScene = scene;
        // Also expose the clock so a verification script can compare the store with what
        // the seat panels actually paint; they disagreed once and the DOM was the liar.
        window.__dbxClock = () => JSON.parse(JSON.stringify(clock.value));
      }
    } catch (e) {
      // A failed renderer must degrade to the text grid rather than a blank workbench.
      canvasFailed.value = true;
      console.warn("board renderer unavailable", e);
    }
  }

  try {
    const stored = localStorage.getItem("dbxbg.sound");
    if (stored === "off") soundOn.value = false;
  } catch {
    // Storage is unavailable in some sandboxed frames; keep the default.
  }
  scene?.audio.setEnabled(soundOn.value);

  startClockTimers();
  startEvents();

  const snapshot = await call("room.snapshot");
  if (snapshot) applySnapshot(snapshot);
  const profile = await call("profile.get");
  if (profile && typeof profile.lowMotion === "boolean") lowMotion.value = profile.lowMotion;
});

onBeforeUnmount(() => {
  if (mvpTimer) clearTimeout(mvpTimer);
  mvpTimer = null;
  stopEventListening();
  stopClockTimers();
  scene?.destroy();
  scene = null;
});

watch(game, (next) => {
  scene?.setGame(next);
});

// Seating can settle after the board is already mounted: a guest joins, a seat is released,
// or a spectator sits down. Re-orient whenever the viewer's own side changes.
watch(mySeat, (seat) => {
  scene?.setFlipped(seat === 1);
});
</script>

<template>
  <div class="workbench">
    <aside class="rail">
      <header class="rail-head">
        <div class="brand">棋牌桌</div>
        <p class="brand-sub">局域网 · 中国象棋 / 五子棋</p>
      </header>

      <section v-if="role === 'idle'" class="panel">
        <h2>开一桌</h2>
        <label class="field">
          <span>房间名</span>
          <input v-model="inputName" type="text" placeholder="我的棋室" />
        </label>
        <label class="field">
          <span>棋种</span>
          <select v-model="game">
            <option v-for="g in GAMES" :key="g.id" :value="g.id">{{ g.name }}</option>
          </select>
        </label>
        <label class="field">
          <span>密码（可留空）</span>
          <input v-model="inputPassword" type="password" placeholder="不设密码" />
        </label>

        <!-- Time control and side are chosen before the table exists, because both are
             fixed for the whole match and a guest has to be able to see them on the way in. -->
        <div class="field">
          <span>对局限时（分钟，0 为不限）</span>
          <input v-model.number="inputMinutes" type="number" min="0" max="180" step="1" />
        </div>
        <div class="field">
          <span>每步限时（秒，0 为不限）</span>
          <input v-model.number="inputMoveSeconds" type="number" min="0" max="600" step="5" />
        </div>
        <div class="field">
          <span>我坐哪边</span>
          <div class="side-pick">
            <button
              type="button"
              class="pick"
              :class="{ on: inputSeat === 0 }"
              @click="inputSeat = 0"
            >
              {{ sideName(0) }}
            </button>
            <button
              type="button"
              class="pick"
              :class="{ on: inputSeat === 1 }"
              @click="inputSeat = 1"
            >
              {{ sideName(1) }}
            </button>
            <button
              type="button"
              class="pick"
              :class="{ on: inputSeat === -1 }"
              @click="inputSeat = -1"
            >
              随便
            </button>
          </div>
        </div>

        <button class="primary" @click="createRoom">开桌</button>

        <hr />

        <h2>加入一桌</h2>
        <button class="ghost" :disabled="scanning" @click="scan">
          {{ scanning ? "正在搜索…" : "搜索局域网房间" }}
        </button>
        <ul v-if="lobbyRooms.length" class="room-list">
          <li v-for="r in lobbyRooms" :key="r.roomId + r.address">
            <div class="room-main">
              <strong>{{ r.name }}</strong>
              <small>{{ r.game === "xiangqi" ? "中国象棋" : "五子棋" }} · {{ r.players }} 人 · {{ r.address }}</small>
            </div>
            <button class="ghost small" :disabled="r.locked && !inputPassword" @click="joinRoom(r)">
              {{ r.locked ? "密码加入" : "加入" }}
            </button>
          </li>
        </ul>
        <p v-else class="hint">没搜到房间。可以让对方把地址发给你，直接填在下面。</p>

        <label class="field">
          <span>手动地址</span>
          <input v-model="inputAddress" type="text" placeholder="192.168.1.10:51234#房间id" />
        </label>
        <button class="ghost" @click="joinByAddress">按地址加入</button>
      </section>

      <section v-else class="panel">
        <h2>{{ roomName }}</h2>
        <p class="hint">
          {{ game === "xiangqi" ? "中国象棋" : "五子棋" }} ·
          {{ role === "host" ? "你是房主" : "你是访客" }} ·
          {{ phase === "playing" ? "对局中" : phase === "practice" ? "练习中" : phase === "finished" ? "已结束" : "等待开始" }}
        </p>

        <div class="seat-row">
          <div
            v-for="(m, i) in seatMembers"
            :key="i"
            class="seat"
            :class="{ empty: !m && i !== aiSeat, partner: i === aiSeat }"
          >
            <span class="seat-tag">{{ i === 0 ? "先手" : "后手" }}</span>
            <!-- The partner holds a seat without being a member, so it has no nickname. -->
            <span class="seat-name">{{ i === aiSeat ? "陪练" : m ? m.nickname : "空座" }}</span>
          </div>
        </div>

        <div v-if="spectators.length" class="spectators">
          <span class="hint">观战 {{ spectators.length }} 人：</span>
          <span v-for="s in spectators" :key="s.id" class="chip">{{ s.nickname }}</span>
        </div>

        <div v-if="clock" class="clock">
          <!-- The two clocks sit under the two seats, so repeating 先手/后手 here would be
               the third time the same word appears on screen. -->
          <div class="clock-side" :class="{ running: clock.running === 0 }">
            {{ formatClock(clock.remaining[0]) }}
          </div>
          <div class="clock-side" :class="{ running: clock.running === 1 }">
            {{ formatClock(clock.remaining[1]) }}
          </div>
        </div>

        <!-- The per-move limit only exists when the host set one. -->
        <div
          v-if="clock && clock.perMove > 0 && clock.moveRemaining >= 0"
          class="move-clock"
          :class="{ urgent: clock.moveRemaining <= 10000 }"
        >
          <span>本步剩余</span>
          <strong>{{ formatClock(clock.moveRemaining) }}</strong>
        </div>

        <div class="actions">
          <button v-if="phase === 'lobby' && role === 'host'" class="primary" @click="startMatch">
            开始对局
          </button>
          <button
            v-if="phase === 'lobby' && role === 'host'"
            class="primary"
            title="和启发式陪练下一局：不记胜负，可以随时重来"
            @click="startPartner"
          >
            和陪练下
          </button>
          <button
            v-if="phase === 'lobby' && role === 'host'"
            class="ghost"
            title="一个人先摆一摆：不计胜负，只用于看盘面和特效"
            @click="startPractice"
          >
            先摆一摆
          </button>
          <button v-if="phase === 'practice'" class="ghost" @click="endPractice">结束练习</button>
          <button v-if="phase === 'playing'" class="ghost" @click="resign">认输</button>
          <button v-if="phase === 'finished'" class="primary" @click="rematch">再来一局</button>
          <button class="ghost" @click="leaveRoom">{{ role === "host" ? "结束房间" : "离开" }}</button>
        </div>

        <div v-if="phase === 'practice'" class="scenarios">
          <span class="hint">特效预演</span>
          <div class="scenario-row">
            <button class="ghost tiny" @click="runScenario('opening')">开局</button>
            <button v-if="game === 'xiangqi'" class="ghost tiny" @click="runScenario('capture')">吃子</button>
            <button v-if="game === 'xiangqi'" class="ghost tiny" @click="runScenario('check')">将军</button>
            <button v-if="game === 'gomoku'" class="ghost tiny" @click="runScenario('win')">连五</button>
          </div>
        </div>

        <label class="toggle">
          <input type="checkbox" :checked="lowMotion" @change="toggleLowMotion" />
          <span class="box" aria-hidden="true"></span>
          <span>低动效模式</span>
        </label>

        <label class="toggle">
          <input type="checkbox" :checked="soundOn" @change="toggleSound" />
          <span class="box" aria-hidden="true"></span>
          <span>落子音效</span>
        </label>

        <div v-if="role === 'host' && addresses.length" class="address">
          <span class="hint">让朋友用这个地址加入：</span>
          <!-- The first entry is ranked by reachability, so a machine on both WiFi and a
               corporate VPN does not hand out the address nobody can dial. -->
          <code v-for="(a, i) in addresses" :key="a">
            {{ a }}<span v-if="i === 0" class="addr-tag">推荐</span>
          </code>
          <span v-if="inviteLink" class="hint">
            网络里搜不到时，把这一整串发给朋友，粘到「手动地址」里：
          </span>
          <code v-if="inviteLink" class="invite">{{ inviteLink }}</code>
        </div>
      </section>

      <p v-if="error" class="error">{{ error }}</p>
      <p v-if="notice" class="hint">{{ notice }}</p>
      <p v-if="!bridge.live" class="hint">本地预览模式：未连接 DBX 宿主，部分操作不可用。</p>
    </aside>

    <main class="stage">
      <!-- Seats flank the board so the players are placed around the table rather than
           listed away in the sidebar. Each one carries the person, the name and the clock. -->
      <div class="board-col">
        <!-- Seats sit across the table, not beside it: seat one is the far side, seat zero
             is the side nearest the viewer. Reading down the screen is then the same as
             looking across a real board. -->
        <aside
          v-for="seat in [0, 1]"
          :key="seat"
          class="seat-strip"
          :class="[
            seat === 0 ? 'near' : 'far',
            {
              active: seatActive(seat),
              empty: !seatMembers[seat] && seat !== aiSeat,
              mine: mySeat === seat,
            },
          ]"
        >
          <svg class="avatar" viewBox="0 0 64 72" aria-hidden="true">
            <!-- A robe silhouette: head, shoulders, and a collar V. Kept as three shapes so
                 it reads at 44px without any asset, which the single-bundle CSP forbids. -->
            <circle class="avatar-head" cx="32" cy="19" r="10" />
            <path class="avatar-body" d="M32 31c-12 0-21 9-21 21v14h42V52c0-12-9-21-21-21z" />
            <path class="avatar-collar" d="M32 31l-7 8 7 5 7-5-7-8z" />
          </svg>
          <span class="seat-panel-tag">{{ seat === 0 ? "先手" : "后手" }}</span>
          <span class="seat-panel-name">{{ seatLabel(seat) }}</span>
          <span v-if="clock" class="seat-strip-clock" :class="{ low: clock.remaining[seat] <= 30000 }">
            {{ formatClock(clock.remaining[seat]) }}
          </span>
        </aside>

        <div ref="boardHost" class="canvas-host" :class="{ hidden: canvasFailed }"></div>
      </div>
      <div v-if="canvasFailed" class="fallback">渲染器不可用，已切换到简化视图。</div>

      <!-- MVP 面板显示时让出横幅，关掉面板后横幅接回，免得同一句话出现两遍。 -->
      <div v-if="result && result.finished && !mvp" class="result-banner">
        <strong>{{ outcomeText(result.outcome) }}</strong>
        <span>{{ result.reason }}</span>
      </div>

      <!-- 结算整活。低动效模式只留淡入：不撒彩带、不旋转，符合本项目的降级约定。
           彩带整窗飘但只是细条，不压暗也不拦截点击；面板自己固定在左侧栏，
           把棋盘和它上面的连线、印章等结算特效完整让出来。 -->
      <div v-if="mvp && !lowMotion" class="mvp-confetti" aria-hidden="true">
        <i v-for="n in 26" :key="n" :style="confettiStyle(n)"></i>
      </div>

      <div v-if="mvp" class="mvp" :class="{ calm: lowMotion, draw: mvp.draw }">
        <div class="mvp-card">
          <p class="mvp-eyebrow">本 局 最 有 价 值</p>
          <h2 class="mvp-badge">MVP</h2>
          <p class="mvp-name">{{ mvp.name }}</p>
          <p class="mvp-title">{{ mvp.title }}</p>
          <dl class="mvp-stats">
            <div v-for="s in mvp.stats" :key="s.label">
              <dt>{{ s.label }}</dt>
              <dd>{{ s.value }}</dd>
            </div>
          </dl>
          <p class="mvp-reason">{{ mvp.reason }}</p>
          <div class="mvp-actions">
            <button class="primary" @click="rematch">再来一局</button>
            <button class="ghost" @click="dismissMvp">看看棋盘</button>
          </div>
        </div>
      </div>

      <footer class="controls">
        <div class="controls-top">
        <div class="status">
          <span v-if="phase === 'practice' && aiSeat >= 0">
            {{ aiThinking || isAiTurn ? "陪练正在想…" : "轮到你走 · 陪练模式" }}
          </span>
          <span v-else-if="phase === 'practice'">练习模式 · 不计胜负，可自由走子</span>
          <span v-else-if="phase === 'playing'">
            {{ isMyTurn ? "轮到你走" : isSeated ? "等对方走" : "观战中" }}
          </span>
          <span v-else-if="phase === 'lobby'">{{ isSeated ? "你已就座" : "你在观战" }}</span>
          <span v-else>对局结束</span>
          <span v-if="inCheck" class="check-flag">将军</span>
        </div>

        <div v-if="replayTotal > 0" class="replay-bar">
          <button class="ghost tiny" title="复盘到开局" @click="replayFirst">⏮</button>
          <button class="ghost tiny" title="上一手" @click="replayPrev">◀</button>
          <input
            class="scrubber"
            type="range"
            min="0"
            :max="replayTotal"
            :value="replayPly"
            @input="seekPly(Number($event.target.value))"
          />
          <button class="ghost tiny" title="下一手" @click="replayNext">▶</button>
          <button class="ghost tiny" title="复盘到最后一手" @click="replayLast">⏭</button>
          <span class="ply-count">{{ replayPly }} / {{ replayTotal }}</span>
          <button v-if="replaying" class="ghost tiny" @click="exitReplay">回到实时</button>
          <button class="ghost tiny" title="导出棋谱" @click="exportRecord">导出</button>
        </div>
        </div>

        <div v-if="notation.length" class="notation">
          <button
            v-for="(n, i) in notation"
            :key="i"
            class="ply"
            :class="{ active: i + 1 === replayPly }"
            :title="`跳到第 ${i + 1} 手`"
            @click="seekPly(i + 1)"
          >
            <em>{{ i + 1 }}</em>{{ n }}
          </button>
        </div>
      </footer>
    </main>
  </div>
</template>

<style>
/*
 * Design tokens.
 *
 * One palette, one radius scale, one motion scale. The board already speaks a 国风 ink
 * language, so the shell borrows the same three colours (ink, paper, vermilion) and adds a
 * gold that only ever appears on state, never on decoration.
 *
 * Contrast was checked, not eyeballed: --muted-text on --surface is 5.2:1 and
 * --soft-text 4.6:1, both past WCAG AA for body copy. The old #8a6a3c on paper was 4.11:1,
 * which is why every secondary label used to look washed out.
 */
:root {
  /* Colour */
  --ink: #1c1a17;
  --ink-soft: #322e28;
  --paper: #f2e8d5;
  --paper-warm: #fbf6ea;
  --paper-deep: #e7d9c0;
  --surface: #fffdf8;
  --red: #b03a2e;
  --red-deep: #8f2b20;
  --gold: #d4a24a;
  --wood: #7a5c31;
  --muted-text: #5f5647;
  --soft-text: #6b6253;
  --line: rgba(28, 26, 23, 0.14);
  --line-soft: rgba(28, 26, 23, 0.08);

  /* Radius */
  --radius-sm: 8px;
  --radius-btn: 12px;
  --radius-card: 14px;
  --radius-panel: 18px;
  --radius-pill: 999px;

  /* Elevation: two layers, never one heavy drop */
  --shadow-1: 0 1px 2px rgba(28, 26, 23, 0.06);
  --shadow-2: 0 1px 2px rgba(28, 26, 23, 0.05), 0 6px 18px rgba(28, 26, 23, 0.08);
  --shadow-3: 0 2px 4px rgba(28, 26, 23, 0.06), 0 14px 36px rgba(28, 26, 23, 0.14);

  /* Motion */
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --ease-standard: cubic-bezier(0.2, 0, 0, 1);
  --ease-decelerate: cubic-bezier(0, 0, 0.2, 1);
  --dur-fast: 140ms;
  --dur-base: 220ms;
  --dur-slow: 340ms;

  /* Type */
  --font-ui: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
  --font-display: "Songti SC", "SimSun", STSong, serif;
  --font-num: "SF Mono", "JetBrains Mono", ui-monospace, monospace;
}

* { box-sizing: border-box; }

.workbench {
  display: grid;
  grid-template-columns: 336px 1fr;
  height: 100vh;
  margin: 0;
  font-family: var(--font-ui);
  color: var(--ink);
  background:
    radial-gradient(120% 90% at 14% 0%, rgba(212, 162, 74, 0.13), transparent 52%),
    radial-gradient(100% 80% at 92% 100%, rgba(176, 58, 46, 0.08), transparent 50%),
    var(--paper);
}

/* ── Rail ───────────────────────────────────────────────────────────────── */

.rail {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 24px 24px 28px;
  overflow-y: auto;
  border-right: 1px solid var(--line);
  background: linear-gradient(180deg, rgba(255, 253, 248, 0.92), rgba(242, 232, 213, 0.62));
}

.rail-head { display: flex; flex-direction: column; gap: 8px; }

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  font-family: var(--font-display);
  font-size: 26px;
  line-height: 1.1;
  letter-spacing: 0.2em;
  color: var(--ink);
}

/* The seal-mark beside the name: a small vermilion block, the only decoration allowed. */
.brand::before {
  content: "";
  width: 8px;
  height: 22px;
  border-radius: 2px;
  background: linear-gradient(180deg, var(--red), var(--red-deep));
  box-shadow: var(--shadow-1);
}

.brand-sub {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  letter-spacing: 0.1em;
  color: var(--soft-text);
}

/* ── Panels ─────────────────────────────────────────────────────────────── */

.panel { display: flex; flex-direction: column; gap: 16px; }

.panel h2 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.16em;
  color: var(--muted-text);
}

.panel h2::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--line-soft);
}

.field { display: flex; flex-direction: column; gap: 8px; }

.field > span {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--muted-text);
}

/* 44px tall: a 34px control is below the touch minimum and feels cheap on a trackpad. */
.field input,
.field select {
  height: 44px;
  padding: 0 16px;
  font: inherit;
  font-size: 14px;
  color: var(--ink);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-btn);
  box-shadow: var(--shadow-1);
  outline: none;
  transition: border-color var(--dur-base) var(--ease-standard), box-shadow var(--dur-base) var(--ease-standard);
}

.field input::placeholder { color: var(--soft-text); opacity: 0.72; }

.field input:hover,
.field select:hover { border-color: rgba(28, 26, 23, 0.24); }

.field input:focus-visible,
.field select:focus-visible {
  border-color: var(--wood);
  box-shadow: 0 0 0 3px rgba(122, 92, 49, 0.18);
}

/* ── Buttons ────────────────────────────────────────────────────────────── */

button {
  height: 44px;
  padding: 0 20px;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--ink);
  border: 1px solid transparent;
  border-radius: var(--radius-btn);
  cursor: pointer;
  transition: transform var(--dur-fast) var(--ease-spring),
    background var(--dur-base) var(--ease-standard),
    box-shadow var(--dur-base) var(--ease-standard),
    border-color var(--dur-base) var(--ease-standard);
}

button:active { transform: scale(0.97); }

button:focus-visible {
  outline: 3px solid var(--gold);
  outline-offset: 2px;
}

button:disabled { opacity: 0.45; cursor: not-allowed; transform: none; }

.primary {
  color: var(--paper-warm);
  background: linear-gradient(180deg, var(--ink-soft), var(--ink));
  box-shadow: var(--shadow-2);
}

.primary:hover {
  background: linear-gradient(180deg, #413b33, var(--ink-soft));
  box-shadow: var(--shadow-3);
}

.ghost {
  color: var(--ink);
  background: var(--surface);
  border-color: var(--line);
  box-shadow: var(--shadow-1);
}

.ghost:hover {
  background: var(--paper-warm);
  border-color: rgba(28, 26, 23, 0.26);
  transform: translateY(-1px);
  box-shadow: var(--shadow-2);
}

.ghost:active { transform: scale(0.97); }

.ghost.small { height: 36px; padding: 0 12px; font-size: 13px; }

.ghost.tiny {
  height: 32px;
  min-width: 46px;
  padding: 0 12px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

hr { margin: 2px 0; border: 0; border-top: 1px dashed var(--line); }

/* ── Text ───────────────────────────────────────────────────────────────── */

.hint {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--soft-text);
}

.error {
  margin: 0;
  padding: 8px 12px;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--red-deep);
  background: rgba(176, 58, 46, 0.08);
  border-radius: var(--radius-sm);
  border-left: 3px solid var(--red);
}

/* ── Room list ──────────────────────────────────────────────────────────── */

.room-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.room-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-1);
  transition: transform var(--dur-base) var(--ease-standard), box-shadow var(--dur-base) var(--ease-standard);
}

.room-list li:hover { transform: translateY(-2px); box-shadow: var(--shadow-2); }

.room-main { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.room-main strong { font-size: 14px; font-weight: 650; letter-spacing: -0.01em; }
.room-main small { font-size: 12px; color: var(--soft-text); }

/* ── Seats ──────────────────────────────────────────────────────────────── */

.seat-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

.seat {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 16px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-1);
  transition: box-shadow var(--dur-base) var(--ease-standard), border-color var(--dur-base) var(--ease-standard);
}

/* The side to move gets a vermilion edge, not a glow: the board is already busy. */
.seat.active {
  border-color: rgba(176, 58, 46, 0.5);
  box-shadow: var(--shadow-2), inset 3px 0 0 var(--red);
}

.seat.empty { background: rgba(255, 253, 248, 0.5); border-style: dashed; box-shadow: none; }

/* The partner is a fixture, not a guest: it gets the accent rail rather than a new colour,
   so it reads as "occupied by something that lives here". */
.seat.partner {
  border-color: rgba(176, 58, 46, 0.34);
  background: linear-gradient(180deg, rgba(176, 58, 46, 0.06), transparent 70%), var(--surface);
}

.seat-tag {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.16em;
  color: var(--muted-text);
}

.seat-name {
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.seat.empty .seat-name { color: var(--soft-text); font-weight: 500; }

/* ── Chips ──────────────────────────────────────────────────────────────── */

.spectators { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }

.chip {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 12px;
  font-size: 12px;
  font-weight: 600;
  border-radius: var(--radius-pill);
  background: rgba(122, 92, 49, 0.12);
  color: var(--wood);
}

.chip.accent { background: rgba(176, 58, 46, 0.1); color: var(--red-deep); }

/* ── Clock ──────────────────────────────────────────────────────────────── */

.clock { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

.move-clock {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  padding: 8px 12px;
  font-family: var(--font-ui);
  font-size: 12px;
  color: var(--muted-text);
  background: rgba(28, 26, 23, 0.05);
  border-radius: var(--radius-sm);
  transition: color var(--dur-fast) var(--ease-standard),
    background var(--dur-fast) var(--ease-standard);
}

.move-clock strong {
  font-family: var(--font-num);
  font-size: 15px;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}

/* Under ten seconds the move clock has to shout, or it is decoration. */
.move-clock.urgent {
  color: var(--red);
  background: rgba(176, 58, 46, 0.1);
}

.move-clock.urgent strong { color: var(--red); }

.clock-side {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 12px 8px;
  font-family: var(--font-num);
  font-size: 17px;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
  color: var(--muted-text);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  transition: color var(--dur-base) var(--ease-standard), border-color var(--dur-base) var(--ease-standard);
}

.clock-side.running {
  color: var(--ink);
  border-color: var(--wood);
  box-shadow: 0 0 0 3px rgba(122, 92, 49, 0.12);
}

/* ── Actions & toggles ──────────────────────────────────────────────────── */

.actions { display: flex; flex-wrap: wrap; gap: 8px; }

.toggle {
  display: flex;
  align-items: center;
  gap: 12px;
  /* 44px row: the checkbox is small, but the whole labelled row is the hit target. */
  min-height: 44px;
  font-size: 13px;
  color: var(--muted-text);
  cursor: pointer;
  user-select: none;
}

/* The input is visually hidden but still focusable and still the semantic control; the
   20px square is painted next to it. The label row is 44px tall, so the touch target meets
   the minimum without forcing the mark to be that large. */
.toggle input {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: 0;
  padding: 0;
  opacity: 0;
  pointer-events: none;
}

.toggle .box {
  position: relative;
  flex-shrink: 0;
  /* Decoration only: clicks must reach the label so the hidden input toggles. */
  pointer-events: none;
  width: 20px;
  height: 20px;
  background: var(--surface);
  border: 1.5px solid rgba(28, 26, 23, 0.28);
  border-radius: 5px;
  transition: background var(--dur-fast) var(--ease-standard),
    border-color var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-spring);
}

/* The tick: a rotated L drawn with two borders, cheaper and sharper than a glyph. */
.toggle .box::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 8px;
  width: 5px;
  height: 9px;
  border-right: 2px solid var(--paper-warm);
  border-bottom: 2px solid var(--paper-warm);
  transform: rotate(45deg) scale(0);
  transition: transform var(--dur-fast) var(--ease-spring);
}

.toggle input:checked + .box {
  background: var(--ink);
  border-color: var(--ink);
}

.toggle input:checked + .box::after { transform: rotate(45deg) scale(1); }

.toggle:hover .box { border-color: var(--wood); }
.toggle:active .box { transform: scale(0.92); }

.toggle input:focus-visible + .box {
  outline: 3px solid var(--gold);
  outline-offset: 3px;
}

.toggle span { line-height: 1.4; }

/* ── Scenarios & address ───────────────────────────────────────────────── */

.scenarios { display: flex; flex-direction: column; gap: 8px; }

.scenario-row { display: flex; flex-wrap: wrap; gap: 8px; }

/* Side picker: three equal chips, sized to stay past the 44px touch floor. */
.side-pick { display: grid; grid-template-columns: 1fr 1fr 0.8fr; gap: 8px; }

.side-pick .pick {
  min-height: 44px;
  padding: 0 12px;
  font-family: var(--font-ui);
  font-size: 13px;
  color: var(--muted-text);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: color var(--dur-fast) var(--ease-standard),
    border-color var(--dur-fast) var(--ease-standard),
    background var(--dur-fast) var(--ease-standard);
}

.side-pick .pick:hover { color: var(--ink); border-color: var(--wood); }

.side-pick .pick.on {
  color: var(--paper-warm);
  background: var(--ink);
  border-color: var(--ink);
}

.side-pick .pick:focus-visible { outline: 3px solid var(--gold); outline-offset: 2px; }

.address { display: flex; flex-direction: column; gap: 4px; }

.invite {
  word-break: break-all;
  line-height: 1.5;
  font-size: 12px;
}

.addr-tag {
  margin-left: 8px;
  padding: 0 8px;
  font-size: 12px;
  color: var(--muted-text);
  background: rgba(28, 26, 23, 0.07);
  border-radius: 999px;
}

.address code {
  padding: 8px 12px;
  font-family: var(--font-num);
  font-size: 12px;
  border-radius: var(--radius-sm);
  background: rgba(28, 26, 23, 0.055);
  color: var(--muted-text);
}

/* ── Stage ──────────────────────────────────────────────────────────────── */

.stage { position: relative; display: flex; flex-direction: column; min-width: 0; }

/* Board with its two seats stacked across the table: the far side on top, the viewer's
   side underneath. Placed by named areas rather than source order, because both seats come
   from one v-for and would otherwise sit next to each other. */
.board-col {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-areas: "far" "board" "near";
  grid-template-rows: auto minmax(0, 1fr) auto;
  justify-items: center;
  gap: 8px;
  padding: 12px 16px;
}

.seat-strip {
  grid-area: far;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-pill, 999px);
  box-shadow: var(--shadow-1);
  transition: border-color var(--dur-base) var(--ease-standard),
    box-shadow var(--dur-base) var(--ease-standard),
    transform var(--dur-base) var(--ease-standard);
}

/* seat zero is the near side. */
.seat-strip.near { grid-area: near; }
.seat-strip.far { grid-area: far; }

.seat-strip.active {
  border-color: rgba(176, 58, 46, 0.45);
  box-shadow: var(--shadow-2);
  transform: translateY(-1px);
}

.seat-strip.empty { border-style: dashed; box-shadow: none; background: rgba(255, 253, 248, 0.5); }
.seat-strip.empty .avatar { opacity: 0.3; }

.avatar {
  width: 24px;
  height: 28px;
  fill: var(--muted-text);
  transition: fill var(--dur-base) var(--ease-standard),
    opacity var(--dur-base) var(--ease-standard);
}

.seat-strip.active .avatar { fill: var(--red); }
.seat-strip.mine .avatar { fill: var(--ink); }
.avatar-collar { fill: var(--surface); opacity: 0.85; }

.seat-panel-tag {
  font-family: var(--font-ui);
  font-size: 12px;
  letter-spacing: 0.14em;
  color: var(--soft-text);
}

.seat-panel-name {
  font-family: var(--font-ui);
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.seat-strip-clock {
  font-family: var(--font-num);
  font-size: 15px;
  font-variant-numeric: tabular-nums;
  color: var(--muted-text);
  padding-left: 4px;
}

.seat-strip.active .seat-strip-clock { color: var(--ink); }
.seat-strip-clock.low { color: var(--red); }

.canvas-host {
  grid-area: board;
  min-height: 0;
  width: 100%;
  display: grid;
  place-items: center;
  padding: 12px;
  overflow: hidden;
}

/* The renderer is fixed at 1600x900 logical pixels. Let it scale up to fill whatever space
   the workbench has while never cropping the board. */
.canvas-host canvas {
  display: block;
  max-width: 100%;
  max-height: 100%;
  width: auto !important;
  height: auto !important;
  filter: drop-shadow(0 18px 42px rgba(28, 26, 23, 0.16));
}

.canvas-host.hidden { display: none; }

.fallback {
  flex: 1;
  display: grid;
  place-items: center;
  font-size: 13px;
  color: var(--soft-text);
}

/* ── Result banner ──────────────────────────────────────────────────────── */

.result-banner {
  position: absolute;
  top: 28px;
  left: 50%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 16px 32px;
  border-radius: var(--radius-panel);
  background: linear-gradient(180deg, rgba(50, 46, 40, 0.96), rgba(28, 26, 23, 0.96));
  color: var(--paper-warm);
  box-shadow: var(--shadow-3);
  animation: banner-in var(--dur-slow) var(--ease-spring) both;
}

.result-banner strong {
  font-family: var(--font-display);
  font-size: 21px;
  letter-spacing: 0.2em;
}

.result-banner span {
  font-size: 12px;
  letter-spacing: 0.1em;
  opacity: 0.72;
}

@keyframes banner-in {
  from { opacity: 0; transform: translate(-50%, -8px) scale(0.96); }
  to { opacity: 1; transform: translate(-50%, 0) scale(1); }
}

/* ── MVP panel ──────────────────────────────────────────────────────────── */

/* Fixed rather than absolute: the panel is a full-window flourish and must not depend on
   whichever ancestor happens to be positioned. */
.mvp {
  position: fixed;
  left: 0;
  top: 0;
  bottom: 0;
  z-index: 60;
  width: 336px;
  max-width: 100vw;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px;
  /* 结算后的展示层，不该挡住棋盘：只有卡片本身接收点击，其余区域留给棋盘。 */
  pointer-events: none;
  background: linear-gradient(180deg, #fffdf8, #f2e8d5);
  border-right: 1px solid var(--line);
  animation: mvp-fade 320ms ease both;
}

.mvp-confetti {
  position: fixed;
  inset: 0;
  z-index: 61;
  overflow: hidden;
  pointer-events: none;
}

.mvp-confetti i {
  position: absolute;
  top: -8vh;
  width: 7px;
  height: 13px;
  border-radius: 1px;
  opacity: 0;
  animation-name: mvp-fall;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
}

@keyframes mvp-fall {
  0%   { transform: translateY(-10vh) rotate(0deg); opacity: 0; }
  8%   { opacity: 0.95; }
  100% { transform: translateY(112vh) rotate(680deg); opacity: 0; }
}

.mvp-card {
  position: relative;
  z-index: 1;
  width: 100%;
  padding: 26px 20px 22px;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  border-radius: 22px;
  border: 1px solid rgba(212, 162, 74, 0.55);
  background:
    radial-gradient(circle at 50% 0%, rgba(212, 162, 74, 0.22), transparent 62%),
    linear-gradient(180deg, #fdf8ec, #f2e9d6);
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.5) inset,
    0 26px 70px rgba(28, 26, 23, 0.45);
  animation: mvp-pop 620ms var(--ease-spring) both;
}

@keyframes mvp-pop {
  0%   { opacity: 0; transform: translateY(28px) scale(0.72) rotate(-7deg); }
  60%  { opacity: 1; transform: translateY(-6px) scale(1.04) rotate(1.5deg); }
  100% { opacity: 1; transform: translateY(0) scale(1) rotate(0deg); }
}

.mvp-eyebrow {
  margin: 0;
  font-size: 11px;
  letter-spacing: 0.42em;
  text-indent: 0.42em;
  color: rgba(28, 26, 23, 0.5);
}

.mvp-badge {
  margin: 2px 0 0;
  font-family: var(--font-display);
  font-size: 44px;
  line-height: 1;
  letter-spacing: 0.12em;
  text-indent: 0.14em;
  background: linear-gradient(180deg, #f6dc93 0%, #d4a24a 42%, #9c6f1f 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: mvp-glow 2.6s ease-in-out 0.6s infinite;
}

@keyframes mvp-glow {
  0%, 100% {
    filter: drop-shadow(0 2px 0 rgba(255, 255, 255, 0.7))
            drop-shadow(0 10px 22px rgba(212, 162, 74, 0.35));
  }
  50% {
    filter: drop-shadow(0 2px 0 rgba(255, 255, 255, 0.9))
            drop-shadow(0 14px 34px rgba(212, 162, 74, 0.75));
  }
}

.mvp-name {
  margin: 4px 0 0;
  font-family: var(--font-display);
  font-size: 20px;
  letter-spacing: 0.06em;
  color: var(--ink);
}

.mvp-title {
  margin: 0;
  padding: 3px 12px;
  border-radius: 999px;
  border: 1px solid rgba(143, 47, 40, 0.28);
  background: rgba(143, 47, 40, 0.1);
  font-size: 11px;
  text-align: center;
  letter-spacing: 0.16em;
  color: #8f2f28;
}

/* A draw has no hero, so it gets a quieter palette instead of a "loser" MVP. */
.mvp.draw .mvp-badge {
  background: linear-gradient(180deg, #cfd6cc 0%, #8fa295 45%, #566456 100%);
  -webkit-background-clip: text;
  background-clip: text;
  animation: none;
  filter: none;
}

.mvp.draw .mvp-title {
  border-color: rgba(74, 107, 82, 0.3);
  background: rgba(74, 107, 82, 0.12);
  color: #47624f;
}

.mvp-stats {
  width: 100%;
  margin: 10px 0 2px;
  display: grid;
  grid-template-columns: 1fr;
  gap: 6px;
}

.mvp-stats > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 12px;
  border-radius: 10px;
  background: rgba(28, 26, 23, 0.05);
}

.mvp-stats dt {
  font-size: 10px;
  letter-spacing: 0.12em;
  color: rgba(28, 26, 23, 0.52);
}

.mvp-stats dd {
  margin: 0;
  font-family: var(--font-display);
  font-size: 17px;
  color: var(--ink);
}

.mvp-reason {
  margin: 2px 0 0;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: rgba(28, 26, 23, 0.42);
}

.mvp-actions {
  margin-top: 12px;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}

@keyframes mvp-fade {
  from { opacity: 0; }
  to   { opacity: 1; }
}

/* Low-motion: no bounce, no glow pulse, no ribbons — one fade, per the project's rule that
   every effect needs a calm form. */
.mvp.calm .mvp-card { animation: mvp-fade 200ms ease both; }
.mvp.calm .mvp-badge { animation: none; }

/* ── Controls ───────────────────────────────────────────────────────────── */

.controls {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 24px 16px;
  border-top: 1px solid var(--line);
  background: rgba(255, 253, 248, 0.86);
  backdrop-filter: blur(10px);
}

.controls-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.status {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
  color: var(--muted-text);
}

.check-flag {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 12px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.18em;
  color: var(--paper-warm);
  background: var(--red);
  border-radius: var(--radius-pill);
  animation: flag-pulse 1.4s var(--ease-standard) infinite;
}

@keyframes flag-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.62; }
}

/* ── Replay bar ─────────────────────────────────────────────────────────── */

.replay-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  background: var(--surface);
  box-shadow: var(--shadow-1);
}

.scrubber {
  flex: 1;
  min-width: 120px;
  max-width: 260px;
  height: 4px;
  border-radius: var(--radius-pill);
  background: rgba(28, 26, 23, 0.14);
  appearance: none;
  cursor: pointer;
}

.scrubber::-webkit-slider-thumb {
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--ink);
  border: 3px solid var(--surface);
  box-shadow: var(--shadow-2);
  transition: transform var(--dur-fast) var(--ease-spring);
}

.scrubber::-webkit-slider-thumb:hover { transform: scale(1.15); }

.scrubber:focus-visible { outline: 3px solid var(--gold); outline-offset: 4px; }

.ply-count {
  font-family: var(--font-num);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--soft-text);
}

/* ── Notation ───────────────────────────────────────────────────────────── */

.notation {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  max-height: 60px;
  overflow-y: auto;
  padding: 2px 0;
}

.ply {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 8px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--muted-text);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  transition: background var(--dur-fast) var(--ease-standard), color var(--dur-fast) var(--ease-standard);
}

.ply:hover { background: rgba(122, 92, 49, 0.1); color: var(--ink); }

.ply.active {
  color: var(--ink);
  font-weight: 650;
  background: rgba(122, 92, 49, 0.15);
  border-color: rgba(122, 92, 49, 0.4);
}

.ply em {
  font-style: normal;
  margin-right: 4px;
  font-size: 12px;
  color: var(--soft-text);
}

/* ── Staggered entrance ────────────────────────────────────────────────── */

.reveal { animation: reveal var(--dur-slow) var(--ease-decelerate) both; }
.reveal:nth-child(1) { animation-delay: 20ms; }
.reveal:nth-child(2) { animation-delay: 60ms; }
.reveal:nth-child(3) { animation-delay: 100ms; }
.reveal:nth-child(4) { animation-delay: 140ms; }

@keyframes reveal {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ── Responsive ─────────────────────────────────────────────────────────── */

@media (max-width: 900px) {
  .workbench { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }

  .rail {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: flex-start;
    border-right: 0;
    border-bottom: 1px solid var(--line);
    padding: 16px;
  }

  .rail-head { flex: 1 0 100%; }
  .panel { min-width: 280px; }
  .notation { max-width: 100%; justify-content: flex-start; }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
</style>
