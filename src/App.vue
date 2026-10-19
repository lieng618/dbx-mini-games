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
const record = ref(null);
const notation = ref([]);

const inputName = ref("我的棋室");
const inputPassword = ref("");
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
  if (typeof snapshot.inCheck === "boolean") inCheck.value = snapshot.inCheck;
  if (snapshot.checkFocus !== undefined) checkFocus.value = snapshot.checkFocus;
  if (snapshot.result !== undefined) result.value = snapshot.result;
  if (snapshot.winLine) winLine.value = snapshot.winLine;
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
    ["no free seat", "两个座位都满了，可以让一位朋友先离座"],
    ["a match is already in progress", "对局正在进行中，无法调整座位"],
    ["room is full", "房间人数已满（8 人）"],
    ["not your turn", "还没轮到你走棋"],
    ["illegal move", "这一步不合规则"],
    ["only seated players may do that", "你在观战，坐下后才能操作"],
    ["not hosting a room", "当前没有房间，请先开桌"],
    ["already hosting or joined a room", "你已经在一个房间里了"],
    ["wrong room password", "房间密码不正确"],
    ["a valid host key is required", "缺少房主公钥，请用房间列表加入"],
    ["an address is required", "请填写房间地址"],
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
  const [address, roomIdPart] = inputAddress.value.split("#");
  await call("room.join", { address, roomId: roomIdPart || "", hostKey: hostKey.value });
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

/** Handles a click on a board intersection. */
async function onCell(index) {
  const canMove = (phase.value === "playing" && isMyTurn.value) || phase.value === "practice";
  if (!canMove || !isSeated.value) return;
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
    }
    return;
  }

  // Gomoku: one click is one move.
  if (code) return;
  await call("game.move", { to: index });
}

async function loadNotation() {
  const reply = await call("replay.notation");
  if (reply && Array.isArray(reply.notation)) notation.value = reply.notation;
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

watch(phase, (next) => {
  if (next === "finished") loadNotation();
});

onMounted(async () => {
  await whenReady();
  ready.value = true;

  if (boardHost.value) {
    try {
      scene = new BoardScene({ onCell });
      await scene.init(boardHost.value, game.value);
    } catch (e) {
      // A failed renderer must degrade to the text grid rather than a blank workbench.
      canvasFailed.value = true;
      console.warn("board renderer unavailable", e);
    }
  }

  const snapshot = await call("room.snapshot");
  if (snapshot) applySnapshot(snapshot);
  const profile = await call("profile.get");
  if (profile && typeof profile.lowMotion === "boolean") lowMotion.value = profile.lowMotion;
});

onBeforeUnmount(() => {
  scene?.destroy();
  scene = null;
});

watch(game, (next) => {
  scene?.setGame(next);
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
          <div v-for="(m, i) in seatMembers" :key="i" class="seat" :class="{ empty: !m }">
            <span class="seat-tag">{{ i === 0 ? "先手" : "后手" }}</span>
            <span class="seat-name">{{ m ? m.nickname : "空座" }}</span>
          </div>
        </div>

        <div v-if="spectators.length" class="spectators">
          <span class="hint">观战 {{ spectators.length }} 人：</span>
          <span v-for="s in spectators" :key="s.id" class="chip">{{ s.nickname }}</span>
        </div>

        <div v-if="clock" class="clock">
          <div class="clock-side" :class="{ running: clock.running === 0 }">
            先手 {{ formatClock(clock.remaining[0]) }}
          </div>
          <div class="clock-side" :class="{ running: clock.running === 1 }">
            后手 {{ formatClock(clock.remaining[1]) }}
          </div>
        </div>

        <div class="actions">
          <button v-if="phase === 'lobby' && role === 'host'" class="primary" @click="startMatch">
            开始对局
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

        <label class="toggle">
          <input type="checkbox" :checked="lowMotion" @change="toggleLowMotion" />
          <span>低动效模式</span>
        </label>

        <div v-if="role === 'host' && addresses.length" class="address">
          <span class="hint">让朋友用这个地址加入：</span>
          <code v-for="a in addresses" :key="a">{{ a }}</code>
        </div>
      </section>

      <p v-if="error" class="error">{{ error }}</p>
      <p v-if="notice" class="hint">{{ notice }}</p>
      <p v-if="!bridge.live" class="hint">本地预览模式：未连接 DBX 宿主，部分操作不可用。</p>
    </aside>

    <main class="stage">
      <div ref="boardHost" class="canvas-host" :class="{ hidden: canvasFailed }"></div>
      <div v-if="canvasFailed" class="fallback">渲染器不可用，已切换到简化视图。</div>

      <div v-if="result && result.finished" class="result-banner">
        <strong>{{ outcomeText(result.outcome) }}</strong>
        <span>{{ result.reason }}</span>
      </div>

      <footer class="controls">
        <div class="status">
          <span v-if="phase === 'practice'">练习模式 · 不计胜负，可自由走子</span>
          <span v-else-if="phase === 'playing'">
            {{ isMyTurn ? "轮到你走" : isSeated ? "等对方走" : "观战中" }}
          </span>
          <span v-else-if="phase === 'lobby'">{{ isSeated ? "你已就座" : "你在观战" }}</span>
          <span v-else>对局结束</span>
          <span v-if="inCheck" class="check-flag">将军</span>
        </div>

        <div v-if="notation.length" class="notation">
          <span v-for="(n, i) in notation.slice(-12)" :key="i" class="ply">
            <em>{{ i + 1 }}</em>{{ n }}
          </span>
        </div>
      </footer>
    </main>
  </div>
</template>

<style>
:root {
  --ink: #1c1a17;
  --paper: #f2e8d5;
  --paper-deep: #e7d9c0;
  --wood: #8a6a3c;
  --red: #b03a2e;
  --gold: #d4a24a;
  --muted: #6f6455;
  --line: rgba(28, 26, 23, 0.12);
}

* { box-sizing: border-box; }

.workbench {
  display: grid;
  grid-template-columns: 320px 1fr;
  height: 100vh;
  margin: 0;
  font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  color: var(--ink);
  background:
    radial-gradient(circle at 18% 8%, rgba(212, 162, 74, 0.16), transparent 46%),
    radial-gradient(circle at 84% 92%, rgba(176, 58, 46, 0.1), transparent 44%),
    var(--paper);
}

.rail {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 22px 20px;
  overflow-y: auto;
  border-right: 1px solid var(--line);
  background: linear-gradient(180deg, rgba(255, 252, 245, 0.86), rgba(242, 232, 213, 0.7));
}

.brand {
  font-family: "Songti SC", "SimSun", STSong, serif;
  font-size: 24px;
  letter-spacing: 0.24em;
  color: var(--ink);
}

.brand-sub {
  margin: 4px 0 0;
  font-size: 12px;
  letter-spacing: 0.08em;
  color: var(--muted);
}

.panel { display: flex; flex-direction: column; gap: 12px; }

.panel h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
  letter-spacing: 0.06em;
  color: var(--muted);
  text-transform: none;
}

.field { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--muted); }

.field input,
.field select {
  padding: 9px 11px;
  font: inherit;
  font-size: 13px;
  color: var(--ink);
  background: rgba(255, 255, 255, 0.72);
  border: 1px solid var(--line);
  border-radius: 9px;
  outline: none;
}

.field input:focus,
.field select:focus { border-color: var(--wood); box-shadow: 0 0 0 3px rgba(138, 106, 60, 0.14); }

button {
  font: inherit;
  font-size: 13px;
  padding: 9px 14px;
  border-radius: 9px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: transform 0.12s ease, background 0.16s ease;
}

button:active { transform: translateY(1px); }
button:disabled { opacity: 0.5; cursor: not-allowed; }

.primary { background: var(--ink); color: var(--paper); }
.primary:hover { background: #322e28; }

.ghost { background: transparent; color: var(--ink); border-color: var(--line); }
.ghost:hover { background: rgba(255, 255, 255, 0.6); }
.ghost.small { padding: 6px 10px; font-size: 12px; }

hr { border: 0; border-top: 1px dashed var(--line); margin: 6px 0; }

.hint { margin: 0; font-size: 12px; line-height: 1.6; color: var(--muted); }
.error { margin: 0; font-size: 12px; color: var(--red); }

.room-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }

.room-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 11px;
  background: rgba(255, 255, 255, 0.62);
  border: 1px solid var(--line);
  border-radius: 10px;
}

.room-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.room-main strong { font-size: 13px; font-weight: 600; }
.room-main small { font-size: 11px; color: var(--muted); }

.seat-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }

.seat {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.72);
  border: 1px solid var(--line);
  border-radius: 10px;
}

.seat.empty { background: rgba(255, 255, 255, 0.34); border-style: dashed; }
.seat-tag { font-size: 10px; letter-spacing: 0.12em; color: var(--muted); }
.seat-name { font-size: 14px; font-weight: 620; }

.spectators { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }

.chip {
  padding: 3px 9px;
  font-size: 11px;
  border-radius: 999px;
  background: rgba(138, 106, 60, 0.14);
  color: #6a5230;
}

.clock { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }

.clock-side {
  padding: 8px 10px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: center;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid var(--line);
  color: var(--muted);
}

.clock-side.running { color: var(--ink); border-color: var(--wood); box-shadow: 0 0 0 3px rgba(138, 106, 60, 0.12); }

.actions { display: flex; flex-wrap: wrap; gap: 8px; }

.toggle { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); cursor: pointer; }

.address { display: flex; flex-direction: column; gap: 4px; }
.address code {
  font-size: 11px;
  padding: 5px 8px;
  border-radius: 7px;
  background: rgba(28, 26, 23, 0.06);
  color: #4a4034;
}

.stage { position: relative; display: flex; flex-direction: column; min-width: 0; }

.canvas-host {
  flex: 1;
  min-height: 0;
  display: grid;
  place-items: center;
  padding: 8px;
  overflow: hidden;
}

/* The renderer is fixed at 1600x900 logical pixels. Let it scale up to fill whatever
   space the workbench has while never cropping the board. */
.canvas-host canvas {
  display: block;
  max-width: 100%;
  max-height: 100%;
  width: auto !important;
  height: auto !important;
  filter: drop-shadow(0 16px 36px rgba(28, 26, 23, 0.14));
}

.canvas-host.hidden { display: none; }

.fallback {
  flex: 1;
  display: grid;
  place-items: center;
  font-size: 13px;
  color: var(--muted);
}

.result-banner {
  position: absolute;
  top: 26px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 12px 28px;
  border-radius: 14px;
  background: rgba(28, 26, 23, 0.9);
  color: var(--paper);
  box-shadow: 0 14px 40px rgba(28, 26, 23, 0.28);
  animation: rise 0.42s cubic-bezier(0.2, 0.9, 0.2, 1);
}

.result-banner strong { font-size: 20px; letter-spacing: 0.18em; }
.result-banner span { font-size: 11px; opacity: 0.68; letter-spacing: 0.1em; }

@keyframes rise {
  from { opacity: 0; transform: translate(-50%, 10px); }
  to { opacity: 1; transform: translate(-50%, 0); }
}

.controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 22px;
  border-top: 1px solid var(--line);
  background: rgba(255, 252, 245, 0.72);
}

.status { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--muted); }

.check-flag {
  padding: 2px 10px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.2em;
  color: var(--paper);
  background: var(--red);
  border-radius: 999px;
  animation: pulse 1.1s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

.notation { display: flex; flex-wrap: wrap; gap: 4px 10px; justify-content: flex-end; max-width: 62%; }

.ply { font-size: 11px; color: #5c5344; font-variant-numeric: tabular-nums; }
.ply em { font-style: normal; margin-right: 4px; color: var(--muted); opacity: 0.6; }

@media (max-width: 900px) {
  .workbench { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
  .rail { flex-direction: row; flex-wrap: wrap; border-right: 0; border-bottom: 1px solid var(--line); }
  .panel { min-width: 260px; }
  .notation { max-width: 100%; justify-content: flex-start; }
}

@media (prefers-reduced-motion: reduce) {
  .result-banner, .check-flag { animation: none; }
}
</style>
