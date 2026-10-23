/**
 * App.vue — the workbench shell.
 *
 * Layout: a full-window lobby and a focused board view once a room is entered.
 */
<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { BoardScene } from "./board/scene.js";
import { createBridge, whenReady } from "./bridge.js";
import { reconcileLastMove } from "./snapshot.js";
import { clearLegacyRecords, loadSettings, saveSettings } from "./storage.js";

const GAMES = [
  { id: "xiangqi", name: "中国象棋" },
  { id: "gomoku", name: "五子棋" },
];
const TOTAL_TIME_OPTIONS = [
  { value: 0, label: "不限" },
  { value: 10, label: "10 分钟" },
  { value: 20, label: "20 分钟" },
  { value: 30, label: "30 分钟" },
  { value: 60, label: "60 分钟" },
];
const MOVE_TIME_OPTIONS = [
  { value: 0, label: "不限" },
  { value: 15, label: "15 秒" },
  { value: 30, label: "30 秒" },
  { value: 60, label: "60 秒" },
];
const EFFECT_OPTIONS = [
  { value: "full", label: "完整" },
  { value: "reduced", label: "精简" },
  { value: "off", label: "关闭" },
];
const THEME_OPTIONS = [
  { value: "paper", label: "纸白" },
  { value: "ink", label: "墨色" },
];
const BOARD_SIZE_OPTIONS = [
  { value: "compact", label: "紧凑" },
  { value: "standard", label: "标准" },
  { value: "large", label: "大" },
];
const NICKNAME_PATTERN = /^[\p{L}\p{N}_-]{2,12}$/u;

const bridge = createBridge();
const ready = ref(false);
const settings = ref(loadSettings());
const role = ref("idle");
const roomId = ref(null);
const roomName = ref("");
const game = ref("xiangqi");
const phase = ref("lobby");
const members = ref([]);
const seats = ref(["", ""]);
const selfId = ref("");
const lowMotion = ref(Boolean(settings.value.lowMotion));
// Visual effect intensity is a local preference; it is not part of the cloud protocol.
const effectsLevel = ref(settings.value.effectsLevel || "full");
const boardSize = ref(settings.value.boardSize || "standard");
const theme = ref(settings.value.theme || "paper");
const pendingInviteRoomId = readInviteRoomId();
const reducedMotion = computed(() => lowMotion.value || effectsLevel.value !== "full");
const lobbyRooms = ref([]);
const lobbyOnline = ref(0);
const scanning = ref(false);
const error = ref("");
const notice = ref("");
const floatingMessage = ref(null);
const serverConnected = ref(false);
const serverUrl = ref(bridge.serverUrl || "");
const lobbyTab = ref("rooms");
const nickname = ref("");
const nicknameDraft = ref(bridge.nickname || "");
const nicknameSaving = ref(false);
const nicknameError = ref("");
const joinPassword = ref("");
const joinPrompt = ref(null);
const joinPasswordError = ref("");
const joinSubmitting = ref(false);
const joinPasswordInput = ref(null);
const lobbyNow = ref(Date.now());

const cells = ref([]);
const lastMove = ref(null);
const inCheck = ref(false);
const checkFocus = ref(null);
const result = ref(null);
const winLine = ref([]);
const clock = ref(null);
const undoRequestedBy = ref("");
const undoRequestedSeat = ref(-1);
const undoRemainingMs = ref(0);
const hasLastMove = computed(
  () => !!lastMove.value && Number.isInteger(Number(lastMove.value.to)) && Number(lastMove.value.to) >= 0,
);
const lastMovePreviewActive = ref(false);
const lastMoveAnnouncement = ref("");
let clockBase = null;
let clockBaseAt = 0;
let undoTimer = null;
let lastMovePreviewTimer = null;
// The practice partner's seat, or -1. Kept separate from `seats` because the partner is
// not a member: it has a seat but no id, no nickname and no connection.
const aiSeat = ref(-1);
const aiThinking = ref(false);
const moveCount = ref(0);

const inputPassword = ref("");
const passwordEnabled = ref(false);
const showPassword = ref(false);
// Time control chosen before the table exists. 0 means "no limit" for either field.
const inputMinutes = ref(0);
const inputMoveSeconds = ref(0);
const inputSeat = ref(0);

const boardHost = ref(null);
const boardColumn = ref(null);
const railActions = ref(null);
const canvasFailed = ref(false);
let scene = null;
let sceneInitPromise = null;
let seatLayoutFrame = 0;
let seatResizeObserver = null;
let hiddenAt = 0;
let resumeInFlight = false;
let floatingTimer = null;
let floatingSerial = 0;

const mySeat = computed(() => seats.value.findIndex((id) => id && id === selfId.value));
const isSeated = computed(() => mySeat.value >= 0);
const isPractice = computed(() => phase.value === "practice");
const isMyTurn = computed(() => {
  if (phase.value !== "playing") return false;
  const turn = cells.value.turnSeat;
  return isSeated.value && turn === mySeat.value;
});
/** What to call whoever sits in a seat, including the partner, which is not a member. */
function seatLabel(seat) {
  if (seat === aiSeat.value) return "陪练";
  const m = seatMembers.value[seat];
  return m ? m.nickname : "空座";
}

/**
 * Xiangqi is read from each player's side, so the viewer's seat stays near. Gomoku uses one
 * shared screen orientation for both players: seat zero stays near and seat one stays far.
 */
function isNearSeat(seat) {
  if (game.value === "gomoku") return seat === 0;
  return seat === (mySeat.value >= 0 ? mySeat.value : 0);
}

/** Only xiangqi is drawn from each player's own side of the table. */
function shouldFlipBoard(gameId, seat) {
  return gameId === "xiangqi" && seat === 1;
}

/** True when the seat is the one currently thinking. */
function seatActive(seat) {
  if (phase.value !== "playing" && phase.value !== "practice") return false;
  if (clock.value?.running === seat) return true;
  return (cells.value.turnSeat ?? -1) === seat;
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

const undoPending = computed(() => Boolean(undoRequestedBy.value));
const isUndoRequester = computed(() => undoRequestedBy.value === selfId.value);
const isUndoRecipient = computed(() => undoPending.value && isSeated.value && !isUndoRequester.value);
const undoRequesterName = computed(() => {
  if (undoRequestedSeat.value < 0) return "对手";
  return seatMembers.value[undoRequestedSeat.value]?.nickname || seatLabel(undoRequestedSeat.value);
});
const canRequestUndo = computed(
  () =>
    phase.value === "playing" &&
    isSeated.value &&
    !undoPending.value &&
    moveCount.value > 0 &&
    (cells.value.turnSeat ?? -1) !== mySeat.value,
);
const phaseLabel = computed(() => {
  if (phase.value === "playing") return "对局中";
  if (phase.value === "practice") return "练习中";
  if (phase.value === "finished") return "已结束";
  return "等待开始";
});
const timeControlLabel = computed(() => {
  const totalMinutes = Math.round(Number(clock.value?.budget || 0) / 60000);
  const moveSeconds = Math.round(Number(clock.value?.perMove || 0) / 1000);
  if (!totalMinutes && !moveSeconds) return "不限时";
  if (!moveSeconds) return `${totalMinutes} 分钟`;
  if (!totalMinutes) return `每步 ${moveSeconds} 秒`;
  return `${totalMinutes} 分钟 · 每步 ${moveSeconds} 秒`;
});
const visibleLobbyRooms = computed(() => {
  const phaseRank = { lobby: 0, playing: 1, finished: 2 };
  return lobbyRooms.value
    .slice()
    .sort((left, right) => {
      const phaseDifference = (phaseRank[left.phase] ?? 3) - (phaseRank[right.phase] ?? 3);
      return phaseDifference || Number(right.createdAt || 0) - Number(left.createdAt || 0);
    });
});

function gameLabel(gameId) {
  return gameId === "xiangqi" ? "中国象棋" : "五子棋";
}

function roomStatusLabel(room) {
  if (room.phase === "playing") return "进行中";
  if (room.phase === "finished") return "已结束";
  return "等待中";
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}时${String(minutes).padStart(2, "0")}分`;
  return `${minutes}分${String(seconds).padStart(2, "0")}秒`;
}

function roomDurationLabel(room) {
  const prefix = room.phase === "playing" ? "已进行" : room.phase === "finished" ? "本局" : "已等待";
  let elapsed = room.elapsedMs;
  if (room.phase === "playing" && room.startedAt) elapsed = lobbyNow.value - room.startedAt;
  if (room.phase === "lobby" && room.createdAt) elapsed = lobbyNow.value - room.createdAt;
  return `${prefix} ${formatDuration(elapsed)}`;
}

/** Applies any host snapshot to local state. */
function applySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  if (snapshot.role) role.value = snapshot.role;
  if (snapshot.roomId !== undefined) roomId.value = snapshot.roomId;
  if (snapshot.name !== undefined) roomName.value = snapshot.name;
  if (snapshot.game) game.value = snapshot.game;
  if (snapshot.phase) phase.value = snapshot.phase;
  if (snapshot.selfId) selfId.value = snapshot.selfId;
  if (snapshot.nickname) {
    nickname.value = snapshot.nickname;
  }
  if (snapshot.role === "idle") {
    role.value = "idle";
    roomId.value = null;
    roomName.value = "";
    phase.value = "lobby";
    members.value = [];
    seats.value = ["", ""];
    moveCount.value = 0;
    undoRequestedBy.value = "";
    undoRequestedSeat.value = -1;
    undoRemainingMs.value = 0;
    result.value = null;
    winLine.value = [];
    lastMove.value = null;
    clock.value = null;
    clockBase = null;
    cells.value = [];
    aiSeat.value = -1;
    return;
  }
  if (Array.isArray(snapshot.members)) members.value = snapshot.members;
  if (Array.isArray(snapshot.seats)) seats.value = snapshot.seats;
  if (snapshot.clock) {
    clockBase = JSON.parse(JSON.stringify(snapshot.clock));
    clockBaseAt = Date.now();
    clock.value = JSON.parse(JSON.stringify(snapshot.clock));
  }
  if (typeof snapshot.moveCount === "number") moveCount.value = snapshot.moveCount;

  if (snapshot.cells) {
    cells.value = {
      ...cells.value,
      board: snapshot.cells,
      turnSeat: snapshot.turnSeat ?? cells.value.turnSeat ?? null,
    };
  }
  lastMove.value = reconcileLastMove(snapshot, lastMove.value);
  const isRoomSnapshot = Array.isArray(snapshot.members) && typeof snapshot.phase === "string";
  if (isRoomSnapshot) {
    aiSeat.value = typeof snapshot.aiSeat === "number" ? snapshot.aiSeat : -1;
    undoRequestedBy.value = typeof snapshot.undoRequestedBy === "string" ? snapshot.undoRequestedBy : "";
    undoRequestedSeat.value = Number.isFinite(Number(snapshot.undoRequestedSeat))
      ? Number(snapshot.undoRequestedSeat)
      : -1;
    undoRemainingMs.value = Number.isFinite(Number(snapshot.undoRemainingMs))
      ? Math.max(0, Number(snapshot.undoRemainingMs))
      : snapshot.undoRequestedBy
        ? 20000
        : 0;
    inCheck.value = snapshot.inCheck === true;
    checkFocus.value = snapshot.checkFocus ?? null;
    const nextResult = snapshot.result ?? null;
    // Room snapshots are rebuilt on every push. Keep the same reactive value when the
    // result itself is unchanged, otherwise closing the result card is undone by the next
    // clock/member push and the card pops back up.
    if (
      !result.value ||
      !nextResult ||
      result.value.finished !== nextResult.finished ||
      result.value.outcome !== nextResult.outcome ||
      result.value.reason !== nextResult.reason
    ) {
      result.value = nextResult;
    }
    winLine.value = snapshot.winLine ?? [];
  }
  paint();
  if (role.value !== "idle") {
    void nextTick().then(() => ensureScene());
  }
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
    moveCount: moveCount.value,
    lowMotion: reducedMotion.value,
    effectsOff: effectsLevel.value === "off",
  });
}

function persistSettings() {
  settings.value = {
    ...settings.value,
    lowMotion: lowMotion.value,
    effectsLevel: effectsLevel.value,
    boardSize: boardSize.value,
    theme: theme.value,
  };
  saveSettings(settings.value);
}

/** Sends one host invocation and folds the reply into state. */
/** Maps a sidecar error to something a player can act on. */
function describeError(raw) {
  const text = String(raw ?? "");
  const table = [
    // "Not enough players" is the opposite of "full". These two used to share one error,
    // so a lone host pressing 开始对局 was told the room was full.
    ["both seats must be filled", "还差一位对手，等朋友加入后即可开始"],
    ["both seats are already taken by players", "两个座位都坐着真人，陪练没位置了"],
    ["no seated player to start practice", "没有人在座位上，无法开始练习"],
    ["seat already occupied", "这个座位已经有人了"],
    ["that seat does not exist", "没有这个座位"],
    ["a match is already in progress", "对局正在进行中，无法调整座位"],
    ["room is full", "房间人数已满（8 人）"],
    ["spectating is only available while a match is in progress", "对局开始后才能观战"],
    ["not your turn", "还没轮到你走棋"],
    ["illegal move", "这一步不合规则"],
    ["only seated players may do that", "你在观战，坐下后才能操作"],
    ["an undo request is already pending", "已有悔棋请求等待处理"],
    ["no move to undo", "现在没有可以撤回的棋"],
    ["only the player who made the last move may request an undo", "只能撤回自己刚下的最后一手"],
    ["only the opponent can answer an undo request", "只有对手可以处理这次悔棋请求"],
    ["not hosting a room", "当前没有房间，请先开桌"],
    ["already hosting or joined a room", "你已经在一个房间里了"],
    ["you are already in a room", "你已经在一个房间里了"],
    ["join a room first", "请先加入房间"],
    ["leave the current room before creating another", "请先离开当前房间再创建新房间"],
    ["room no longer exists", "房间已关闭或不存在"],
    ["server room capacity reached", "服务器房间已满，请稍后再试"],
    ["only the room creator can start the match", "只有房主可以开始对局"],
    ["only the room creator can rematch", "只有房主可以再来一局"],
    ["nickname must contain 2 to 12 characters", "昵称需为 2–12 个字符"],
    [
      "nickname may only contain letters, numbers, hyphens, and underscores",
      "昵称只能使用文字、数字、短横线和下划线",
    ],
    ["nickname contains unavailable words", "昵称包含不可用词语，请换一个"],
    ["session was replaced by a newer connection", "连接已更新，正在恢复"],
    ["session is not connected", "连接已失效，正在恢复"],
    ["poll session does not exist", "连接已失效，正在恢复"],
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

function showFloatingMessage(text, tone = "info", duration = 3200) {
  const message = String(text || "").trim();
  if (!message) return;
  floatingMessage.value = {
    text: message,
    tone,
    serial: ++floatingSerial,
  };
  clearTimeout(floatingTimer);
  floatingTimer = setTimeout(() => {
    floatingMessage.value = null;
    floatingTimer = null;
  }, duration);
}

function validateNicknameDraft(value) {
  const candidate = String(value || "").trim();
  if (!NICKNAME_PATTERN.test(candidate)) {
    return "昵称需为 2–12 个字符，只能使用文字、数字、短横线和下划线";
  }
  return "";
}

async function saveNickname() {
  if (nicknameSaving.value) return;
  const candidate = String(nicknameDraft.value || "").trim();
  if (candidate === nickname.value) {
    nicknameDraft.value = nickname.value;
    nicknameError.value = "";
    return;
  }
  const validationError = validateNicknameDraft(candidate);
  nicknameError.value = validationError;
  if (validationError) return;

  nicknameSaving.value = true;
  try {
    const reply = await bridge.invoke("profile.save", { nickname: candidate });
    if (reply && typeof reply === "object") applySnapshot(reply);
    nickname.value = reply?.nickname || candidate;
    nicknameDraft.value = nickname.value;
    showFloatingMessage("昵称已更新", "info", 2800);
  } catch (e) {
    nicknameError.value = describeError(e?.message || e);
  } finally {
    nicknameSaving.value = false;
  }
}

function resetNicknameDraft() {
  if (nicknameSaving.value) return;
  nicknameDraft.value = nickname.value;
  nicknameError.value = "";
}

watch(error, (message) => {
  if (message) showFloatingMessage(message, "error", 5200);
});

watch(notice, (message) => {
  if (message) showFloatingMessage(message, "info", 3200);
});

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

watch(nickname, (value) => {
  nicknameDraft.value = value;
});

async function createRoom() {
  const roomName = `${nickname.value || "棋友"}的${game.value === "xiangqi" ? "象棋室" : "五子棋室"}`;
  const roomPassword = String(inputPassword.value || "").trim();
  if (passwordEnabled.value && !roomPassword) {
    error.value = "请输入房间密码，或切换为公开房间";
    return;
  }
  await call("room.create", {
    name: roomName,
    game: game.value,
    password: passwordEnabled.value ? roomPassword : "",
    minutes: Number(inputMinutes.value) || 0,
    moveSeconds: Number(inputMoveSeconds.value) || 0,
    seat: Number(inputSeat.value),
  });
}

function requestJoin(room, joinRole = "player") {
  if (!room || joinSubmitting.value) return;
  if (!room.locked) {
    void performJoin(room, joinRole, "");
    return;
  }
  joinPrompt.value = { room, role: joinRole };
  joinPassword.value = "";
  joinPasswordError.value = "";
  void nextTick(() => joinPasswordInput.value?.focus());
}

async function performJoin(room, joinRole, password) {
  joinSubmitting.value = true;
  joinPasswordError.value = "";
  error.value = "";
  try {
    const reply = await bridge.invoke("room.join", {
      roomId: room.roomId,
      role: joinRole,
      password: String(password || "").trim(),
    });
    if (reply && typeof reply === "object") applySnapshot(reply);
    joinSubmitting.value = false;
    closeJoinPrompt();
    clearInviteParam();
    return true;
  } catch (joinError) {
    joinSubmitting.value = false;
    const message = describeError(joinError?.message || joinError);
    if (joinPrompt.value) {
      joinPasswordError.value = message;
    } else {
      error.value = message;
      clearInviteParam();
    }
    return false;
  }
}

async function submitJoinPassword() {
  const prompt = joinPrompt.value;
  if (!prompt || joinSubmitting.value) return;
  const password = String(joinPassword.value || "").trim();
  if (!password) {
    joinPasswordError.value = "请输入房间密码";
    joinPasswordInput.value?.focus();
    return;
  }
  await performJoin(prompt.room, prompt.role, password);
}

function closeJoinPrompt() {
  if (joinSubmitting.value) return;
  joinPrompt.value = null;
  joinPassword.value = "";
  joinPasswordError.value = "";
}

function readInviteRoomId() {
  try {
    const value = new URL(window.location.href).searchParams.get("join")?.trim() || "";
    return /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : "";
  } catch {
    return "";
  }
}

function clearInviteParam() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("join")) return;
    url.searchParams.delete("join");
    window.history.replaceState({}, "", url);
  } catch {}
}

async function tryJoinPendingInvite() {
  if (!pendingInviteRoomId || role.value !== "idle") {
    if (pendingInviteRoomId) {
      error.value = "你已经在一个房间里，请先离开当前房间再打开邀请链接";
      clearInviteParam();
    }
    return;
  }
  const room = lobbyRooms.value.find((candidate) => candidate.roomId === pendingInviteRoomId);
  if (!room) {
    error.value = "邀请房间已关闭或不存在";
    clearInviteParam();
    return;
  }
  requestJoin(room, "auto");
}

async function copyInviteLink() {
  if (!roomId.value) {
    error.value = "当前没有可邀请的房间";
    return;
  }
  const origin =
    typeof __DBX_PUBLIC_ORIGIN__ === "string" && __DBX_PUBLIC_ORIGIN__
      ? __DBX_PUBLIC_ORIGIN__
      : window.location.origin;
  const url = new URL(origin);
  url.searchParams.set("join", roomId.value);
  const link = url.toString();
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(link);
    } else {
      const field = document.createElement("textarea");
      field.value = link;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      const copied = document.execCommand("copy");
      field.remove();
      if (!copied) throw new Error("clipboard unavailable");
    }
    showFloatingMessage("邀请链接已复制，发给好友即可进入", "info", 3600);
  } catch {
    error.value = `复制失败，请手动复制：${link}`;
  }
}

async function scan() {
  scanning.value = true;
  try {
    const reply = await call("lobby.list");
    if (reply && Array.isArray(reply.rooms)) lobbyRooms.value = reply.rooms;
    if (reply && Number.isFinite(Number(reply.online))) lobbyOnline.value = Number(reply.online);
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

async function requestUndo() {
  if (!canRequestUndo.value) return;
  await call("game.undo.request");
}

async function consentUndo() {
  if (!isUndoRecipient.value) return;
  await call("game.undo.consent");
}

async function declineUndo(auto = false) {
  if (!isUndoRecipient.value) return;
  const reply = await call("game.undo.decline");
  if (reply && auto) showFloatingMessage("悔棋请求已超时", "info", 2600);
}

/** Replays the authoritative last move without changing the game state. */
function previewLastMove() {
  if (!hasLastMove.value || !scene?.showLastMove(lastMove.value, { duration: 4 })) return;
  lastMovePreviewActive.value = true;
  clearTimeout(lastMovePreviewTimer);
  lastMovePreviewTimer = setTimeout(() => {
    lastMovePreviewTimer = null;
    lastMovePreviewActive.value = false;
  }, 4000);

  // The canvas is not exposed to assistive technology, so announce the result beside the
  // native button instead of relying on the visual ring alone.
  lastMoveAnnouncement.value = "";
  void nextTick(() => {
    lastMoveAnnouncement.value = "已复演上一手，持续四秒";
  });
}

async function rematch() {
  if (role.value !== "host") return;
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
  undoRequestedBy.value = "";
  undoRequestedSeat.value = -1;
  lobbyTab.value = "rooms";
  await scan();
}

async function toggleLowMotion() {
  lowMotion.value = !lowMotion.value;
  persistSettings();
  paint();
}

function updateEffectsLevel() {
  if (effectsLevel.value === "off") {
    scene?.clearEffects();
  }
  persistSettings();
  paint();
}

/** Handles a click on a board intersection. */
async function onCell(index) {
  const canMove = (phase.value === "playing" && isMyTurn.value) || phase.value === "practice";
  if (!canMove || !isSeated.value || undoPending.value) return;
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
    }
    return;
  }

  // Gomoku: one click is one move.
  if (code) return;
  await call("game.move", { to: index });
}

function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function totalClockLabel(ms) {
  if (!clock.value || Number(clock.value.budget || 0) <= 0) return "不限";
  return formatClock(ms);
}

function outcomeText(outcome) {
  if (outcome === 1) return "先手胜";
  if (outcome === 2) return "后手胜";
  if (outcome === 3) return "和棋";
  return "对局结束";
}

function resultReasonLabel(reason) {
  const labels = {
    "five in a row": "五子连珠",
    checkmate: "将死",
    stalemate: "困毙",
    resign: "认输",
    timeout: "超时",
    forfeit: "掉线判负",
    "sixty-move rule": "六十回合无吃子",
    repetition: "三次重复局面",
    "board full": "棋盘已满",
  };
  return labels[reason] || reason || "对局结束";
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
  const moves = moveCount.value;

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
      stats.push({ label, value: totalClockLabel(remaining[seat] ?? 0) });
    }
  }

  return {
    name: draw ? "两位棋手" : seatLabel(winnerSeat),
    title,
    reason: resultReasonLabel(res.reason),
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
    }, effectsLevel.value === "off" ? 300 : reducedMotion.value ? 1000 : 2300);
  }
});

function dismissMvp() {
  mvpDismissed.value = true;
}

function closeResultOnEscape(event) {
  if (event.key !== "Escape") return;
  if (joinPrompt.value) {
    closeJoinPrompt();
    return;
  }
  if (mvp.value) dismissMvp();
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
    lobbyNow.value = Date.now();
    if (phase.value !== "playing" || !clockBase || clockBase.running < 0 || undoPending.value) return;
    const elapsed = Date.now() - clockBaseAt;
    const next = JSON.parse(JSON.stringify(clockBase));
    if (next.budget > 0) {
      next.remaining[next.running] = Math.max(0, next.remaining[next.running] - elapsed);
    }
    if (next.perMove > 0 && next.moveRemaining >= 0) {
      next.moveRemaining = Math.max(0, next.moveRemaining - elapsed);
    }
    clock.value = next;
  }, 1000);
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
let stopConnectionEvents = null;
let refreshInFlight = false;
let lobbyRefreshTimer = null;

function scheduleLobbyRefresh() {
  clearTimeout(lobbyRefreshTimer);
  lobbyRefreshTimer = setTimeout(() => {
    lobbyRefreshTimer = null;
    void scan();
  }, 350);
}

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
    if (method === "room.state" || method === "room.members") {
      if (event?.params?.members && event?.params?.phase) {
        applySnapshot(event.params);
        return;
      }
      void refreshFromEvent();
      return;
    }
    if (method === "lobby.updated") {
      if (Array.isArray(event?.params?.rooms)) {
        lobbyRooms.value = event.params.rooms;
        if (Number.isFinite(Number(event.params.online))) {
          lobbyOnline.value = Number(event.params.online);
        }
        lobbyNow.value = Date.now();
      } else {
        scheduleLobbyRefresh();
      }
    }
  });
  stopConnectionEvents = bridge.onConnection?.((state) => {
    serverConnected.value = Boolean(state?.connected);
    if (state?.serverUrl) serverUrl.value = state.serverUrl;
    if (state?.connected) {
      void scan();
      void call("room.snapshot");
    }
  });
}

function stopEventListening() {
  if (typeof stopEvents === "function") stopEvents();
  stopEvents = null;
  if (typeof stopConnectionEvents === "function") stopConnectionEvents();
  stopConnectionEvents = null;
  clearTimeout(lobbyRefreshTimer);
  lobbyRefreshTimer = null;
}

async function resumeAfterBackground(awayMs) {
  if (resumeInFlight) return;
  resumeInFlight = true;
  try {
    await ensureScene();
    if (!scene) return;
    // Animations are decorative state. Drop a half-finished move or check effect after a
    // long absence, then let the authoritative snapshot paint the current position.
    scene.resume({ discardEffects: awayMs >= 1500 });
    if (!ready.value) return;
    const snapshot = await call("room.snapshot");
    if (snapshot) {
      applySnapshot(snapshot);
    }
    if (role.value === "idle") await scan();
  } catch {
    // Connection state events own retry and error reporting. The board stays interactive.
  } finally {
    resumeInFlight = false;
  }
}

function handleVisibilityChange() {
  if (document.visibilityState === "hidden") {
    hiddenAt = Date.now();
    scene?.suspend();
    return;
  }
  if (document.visibilityState !== "visible") return;
  const awayMs = hiddenAt ? Date.now() - hiddenAt : 0;
  hiddenAt = 0;
  if (ready.value) void resumeAfterBackground(awayMs);
  else scene?.resume();
}

function handleWindowFocus() {
  if (document.visibilityState === "visible") scene?.resume();
}

function syncSeatLayout() {
  seatLayoutFrame = 0;
  const column = boardColumn.value;
  const boardRect = scene?.getBoardVisualRect();
  if (!column || !boardRect) return;

  const columnRect = column.getBoundingClientRect();
  const isPhone = window.matchMedia("(max-width: 620px)").matches;
  const actionsRect = railActions.value?.getBoundingClientRect();
  if (!columnRect.height || !actionsRect?.height) return;

  const farCenter = (columnRect.top + boardRect.top) / 2;
  const bottomBoundary = actionsRect.top;
  const nearCenter = (boardRect.bottom + bottomBoundary) / 2;

  if (isPhone) {
    column.style.removeProperty("--seat-far-offset");
    column.style.removeProperty("--seat-near-offset");
    column.style.setProperty("--seat-far-top", `${farCenter - columnRect.top}px`);
    column.style.setProperty("--seat-near-top", `${nearCenter - columnRect.top}px`);
    return;
  }

  const farSeat = column.querySelector(".seat-strip.far");
  const nearSeat = column.querySelector(".seat-strip.near");
  if (!farSeat || !nearSeat) return;
  const layoutCenter = (element) => {
    const parentTop = element.offsetParent?.getBoundingClientRect().top ?? columnRect.top;
    return parentTop + element.offsetTop + element.offsetHeight / 2;
  };
  const farBaseCenter = layoutCenter(farSeat);
  const nearBaseCenter = layoutCenter(nearSeat);

  column.style.removeProperty("--seat-far-top");
  column.style.removeProperty("--seat-near-top");
  column.style.setProperty("--seat-far-offset", `${farCenter - farBaseCenter}px`);
  column.style.setProperty("--seat-near-offset", `${nearCenter - nearBaseCenter}px`);
}

function scheduleSeatLayout() {
  if (!seatLayoutFrame) seatLayoutFrame = window.requestAnimationFrame(syncSeatLayout);
}

async function ensureScene() {
  if (scene) return scene;
  if (sceneInitPromise) return sceneInitPromise;
  sceneInitPromise = (async () => {
    await nextTick();
    if (!boardHost.value || scene) return scene;
    try {
      const created = new BoardScene({
        onCell,
      });
      await created.init(boardHost.value, game.value);
      created.setFlipped(shouldFlipBoard(game.value, mySeat.value));
      if (document.visibilityState === "hidden") created.suspend();
      scene = created;
      canvasFailed.value = false;
      if (typeof window !== "undefined" && window.__DBX_DEBUG_FX) {
        window.__boardScene = scene;
        window.__dbxClock = () => JSON.parse(JSON.stringify(clock.value));
      }
      paint();
      scheduleSeatLayout();
    } catch (sceneError) {
      canvasFailed.value = true;
      console.warn("board renderer unavailable", sceneError);
    } finally {
      sceneInitPromise = null;
    }
    return scene;
  })();
  return sceneInitPromise;
}

onMounted(async () => {
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("focus", handleWindowFocus);
  window.addEventListener("pageshow", handleVisibilityChange);
  window.addEventListener("resize", scheduleSeatLayout);

  await whenReady();
  ready.value = true;

  await ensureScene();
  if (typeof ResizeObserver !== "undefined") {
    seatResizeObserver = new ResizeObserver(scheduleSeatLayout);
    if (boardHost.value) seatResizeObserver.observe(boardHost.value);
    if (railActions.value) seatResizeObserver.observe(railActions.value);
  }
  scheduleSeatLayout();

  startClockTimers();
  startEvents();
  window.addEventListener("keydown", closeResultOnEscape);

  await clearLegacyRecords();
  try {
    await call("lobby.subscribe");
    await scan();
    const profile = await call("profile.get");
    if (profile?.nickname) {
      nickname.value = profile.nickname;
    }
    const snapshot = await call("room.snapshot");
    if (snapshot) applySnapshot(snapshot);
    await tryJoinPendingInvite();
  } catch (connectionError) {
    error.value = describeError(connectionError?.message || connectionError);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", closeResultOnEscape);
  window.removeEventListener("focus", handleWindowFocus);
  window.removeEventListener("pageshow", handleVisibilityChange);
  window.removeEventListener("resize", scheduleSeatLayout);
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  seatResizeObserver?.disconnect();
  seatResizeObserver = null;
  if (seatLayoutFrame) window.cancelAnimationFrame(seatLayoutFrame);
  seatLayoutFrame = 0;
  clearTimeout(undoTimer);
  undoTimer = null;
  clearTimeout(lastMovePreviewTimer);
  lastMovePreviewTimer = null;
  if (mvpTimer) clearTimeout(mvpTimer);
  mvpTimer = null;
  clearTimeout(floatingTimer);
  floatingTimer = null;
  stopEventListening();
  stopClockTimers();
  scene?.destroy();
  scene = null;
});

watch(role, async (next) => {
  if (next !== "idle") await ensureScene();
});

watch(game, (next) => {
  if (scene) {
    scene.setGame(next);
    scene.setFlipped(shouldFlipBoard(next, mySeat.value));
    scheduleSeatLayout();
  }
  else void ensureScene();
});

watch(
  theme,
  (next) => {
    document.documentElement.dataset.theme = next;
    persistSettings();
  },
  { immediate: true },
);

// Seating can settle after the board is already mounted: a guest joins, a seat is released,
// or a spectator sits down. Xiangqi follows the viewer's side; Gomoku keeps one orientation
// so the same coordinate is visible in the same place on both screens.
watch(mySeat, (seat) => {
  scene?.setFlipped(shouldFlipBoard(game.value, seat));
  scheduleSeatLayout();
});

watch(phase, scheduleSeatLayout, { flush: "post" });

watch([undoRequestedBy, moveCount, phase, undoRemainingMs], ([nextBy, nextMoves, nextPhase], [previousBy, previousMoves]) => {
  clearTimeout(undoTimer);
  undoTimer = null;

  if (nextBy) {
    if (nextBy !== selfId.value && isSeated.value) {
      undoTimer = setTimeout(() => {
        undoTimer = null;
        void declineUndo(true);
        // The server expires the request first. This fallback only covers a missed push.
      }, Math.max(250, undoRemainingMs.value + 1000));
    }
    return;
  }
  if (!previousBy) return;

  if (nextMoves < previousMoves) {
    showFloatingMessage("悔棋成功，棋局已回退一手", "info", 3000);
  } else if (nextPhase === "playing") {
    showFloatingMessage("悔棋请求未通过", "info", 3000);
  }
});

// Membership IDs are stable across nickname edits and reconnects. Only announce members
// that are genuinely new to this client, and never announce the viewer joining the room.
watch(members, (next, previous) => {
  if (role.value === "idle" || !selfId.value || !Array.isArray(previous) || !previous.length) return;
  const previousIds = new Set(previous.map((member) => member.id));
  const arrivals = next.filter((member) => member.id !== selfId.value && !previousIds.has(member.id));
  if (!arrivals.length) return;
  const messages = arrivals.map((member) => {
    const who = member.nickname || "棋友";
    return member.seat >= 0 ? `${who} 加入房间` : `${who} 进入观战`;
  });
  showFloatingMessage(messages.join(" · "), "info", 3600);
});

// A departure arrives as a normal room snapshot. Compare the seating table with its
// previous value so the remaining player is told why their opponent vanished, while a
// reconnect or a room change does not replay a stale notice.
watch(seats, (next, previous) => {
  if (role.value === "idle" || !selfId.value || !previous) return;
  const myPreviousSeat = previous.findIndex((id) => id && id === selfId.value);
  if (myPreviousSeat < 0) return;
  const opponentSeat = 1 - myPreviousSeat;
  const departedId = previous[opponentSeat];
  if (!departedId || next[opponentSeat]) return;

  const stillInRoom = members.value.some((member) => member.id === departedId);
  let message = stillInRoom ? "对手已离开棋席" : "对手已离开房间";
  if (result.value?.finished && result.value.reason === "forfeit") {
    message = "对手已离开，本局判你胜";
  }
  showFloatingMessage(message, "info", 3600);
});
</script>

<template>
  <div
    class="workbench"
    :class="{ 'lobby-mode': role === 'idle', 'motion-reduced': reducedMotion }"
    :data-board-size="boardSize"
    :data-game="game"
  >
    <aside v-show="role !== 'idle'" class="rail">
      <header class="rail-head">
        <div class="brand">棋牌小馆</div>
        <p class="brand-sub">云端棋室</p>
      </header>

      <section class="panel">
        <div class="room-summary">
          <div class="room-summary-meta">
            <span class="room-overline">棋室</span>
            <span class="room-phase" :class="`phase-${phase}`">{{ phaseLabel }}</span>
          </div>
          <h2>{{ roomName }}</h2>
          <div class="room-meta-row">
            <p class="room-meta">
              {{ gameLabel(game) }} ·
              {{ role === "host" ? "房主" : isSeated ? "棋手" : "观战" }}
            </p>
            <button
              class="ghost room-invite-button"
              type="button"
              title="复制房间邀请链接"
              @click="copyInviteLink"
            >
              <svg aria-hidden="true" viewBox="0 0 20 20">
                <path d="M7.5 6.5h-1A3.5 3.5 0 0 0 3 10v0a3.5 3.5 0 0 0 3.5 3.5h1M12.5 6.5h1A3.5 3.5 0 0 1 17 10v0a3.5 3.5 0 0 1-3.5 3.5h-1M6.5 10h7" />
              </svg>
              邀请好友
            </button>
          </div>
        </div>

        <dl class="room-details">
          <div>
            <dt>我的位置</dt>
            <dd>{{ isSeated ? sideName(mySeat) : "观战席" }}</dd>
          </div>
          <div>
            <dt>用时规则</dt>
            <dd>{{ timeControlLabel }}</dd>
          </div>
        </dl>

        <div v-if="spectators.length" class="spectators">
          <span class="spectator-label">观战 {{ spectators.length }} 人</span>
          <div class="spectator-names">
            <span v-for="s in spectators" :key="s.id" class="chip">{{ s.nickname }}</span>
          </div>
        </div>

        <!-- The per-move limit only exists when the host set one. -->
        <div
          v-if="clock && clock.perMove > 0 && clock.moveRemaining >= 0 && (phase === 'playing' || phase === 'practice')"
          class="move-clock"
          :class="{ urgent: clock.moveRemaining <= 10000 }"
        >
          <span>本步剩余</span>
          <strong>{{ formatClock(clock.moveRemaining) }}</strong>
        </div>

      </section>
    </aside>

    <!-- Room actions stay outside both the scrolling details and the board so they can occupy
         a stable side rail on desktop and the bottom edge on smaller screens. -->
    <div v-show="role !== 'idle'" ref="railActions" class="actions rail-actions">
      <button v-if="phase === 'lobby' && role === 'host'" class="primary" @click="startMatch">
        开始对局
      </button>
      <button
        v-if="phase === 'playing' || phase === 'practice' || phase === 'finished'"
        class="ghost last-move-action"
        :class="{ active: lastMovePreviewActive }"
        type="button"
        :disabled="!hasLastMove"
        aria-label="复演上一手，持续四秒"
        title="复演棋子上一步的移动和吃子特效"
        @click="previewLastMove"
      >
        上一手
      </button>
      <button
        v-if="phase === 'playing' && isSeated"
        class="ghost undo-action"
        :disabled="!canRequestUndo"
        @click="requestUndo"
      >
        {{ isUndoRequester ? "等待悔棋" : "悔棋" }}
      </button>
      <button v-if="phase === 'playing' && isSeated" class="ghost resign-action" @click="resign">
        认输
      </button>
      <button v-if="phase === 'finished' && role === 'host'" class="primary" @click="rematch">再来一局</button>
      <button class="ghost room-leave-action" @click="leaveRoom">
        {{ role === "host" ? "结束房间" : "离开" }}
      </button>
      <span class="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {{ lastMoveAnnouncement }}
      </span>
    </div>

    <main class="stage" :class="{ 'lobby-stage': role === 'idle' }">
      <section v-if="role === 'idle'" class="lobby-screen">
        <div class="lobby-atmosphere" aria-hidden="true">
          <i v-for="n in 9" :key="n" :class="`mote mote-${n}`"></i>
        </div>

        <header class="lobby-topbar">
          <div class="lobby-brand">
            <span class="lobby-mark" aria-hidden="true">
              <svg viewBox="0 0 32 32">
                <path d="M8 7h16v18H8zM8 13h16M8 19h16M14 7v18M18 7v18" />
                <circle cx="16" cy="16" r="4.5" />
              </svg>
            </span>
            <div>
              <h1>棋牌小馆</h1>
              <p class="lobby-brand-note">实时棋局</p>
            </div>
          </div>

          <div class="lobby-account">
            <div class="account-profile">
              <span class="guest-name" aria-label="当前昵称" :title="nickname">
                {{ nickname || "随机昵称生成中" }}
              </span>
            </div>
            <div class="account-meta">
              <span class="connection-state" :class="{ online: serverConnected }">
                <i aria-hidden="true"></i>
                {{ serverConnected ? "在线" : "连接中" }}
              </span>
              <span
                v-if="serverConnected"
                class="lobby-population"
                role="status"
                aria-live="polite"
                :aria-label="`当前大厅 ${lobbyOnline} 人`"
                title="当前大厅在线人数"
              >
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <circle cx="9" cy="8" r="3" />
                  <path d="M3.5 19c.5-4 2.4-6 5.5-6s5 2 5.5 6M16 6.5a3 3 0 0 1 0 5.8M17 13c2.2.4 3.4 2.3 3.5 5" />
                </svg>
                <span class="lobby-population-label">大厅</span>
                <strong>{{ lobbyOnline }}</strong>
                <span class="lobby-population-unit">人</span>
              </span>
            </div>
          </div>
          <button
            type="button"
            class="lobby-settings-button"
            :class="{ active: lobbyTab === 'settings' }"
            aria-label="设置"
            :aria-current="lobbyTab === 'settings' ? 'page' : undefined"
            title="设置"
            @click="lobbyTab = 'settings'"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M4 7h9M17 7h3M4 17h3M11 17h9M4 12h4M12 12h8" />
              <circle cx="15" cy="7" r="2" />
              <circle cx="9" cy="17" r="2" />
              <circle cx="10" cy="12" r="2" />
            </svg>
            <span class="settings-label">设置</span>
          </button>
        </header>

        <main class="lobby-main">
        <section v-show="lobbyTab === 'rooms'" class="lobby-view">
          <div v-if="visibleLobbyRooms.length" class="lobby-room-grid">
            <article
              v-for="roomItem in visibleLobbyRooms"
              :key="roomItem.roomId"
              class="lobby-room-card"
              :class="`status-${roomItem.phase}`"
              :data-game="roomItem.game"
            >
              <div class="lobby-room-top">
                <span class="game-mark">
                  <span class="game-seal" aria-hidden="true">
                    <svg v-if="roomItem.game === 'xiangqi'" viewBox="0 0 24 24">
                      <circle cx="12" cy="12" r="8" />
                      <path d="M8.5 10h7M8.5 14h7M12 7.5v9" />
                    </svg>
                    <svg v-else viewBox="0 0 24 24">
                      <circle cx="6" cy="6" r="2" />
                      <circle cx="12" cy="9" r="2" />
                      <circle cx="18" cy="12" r="2" />
                      <circle cx="9" cy="15" r="2" />
                      <circle cx="15" cy="18" r="2" />
                    </svg>
                  </span>
                  {{ gameLabel(roomItem.game) }}
                </span>
                <span class="room-badges">
                  <span v-if="roomItem.locked" class="lock-badge" title="需要密码">
                    <svg aria-hidden="true" viewBox="0 0 16 16">
                      <rect x="3.5" y="7" width="9" height="6" rx="1.5" />
                      <path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7" />
                    </svg>
                    私房
                  </span>
                  <span class="room-state">{{ roomStatusLabel(roomItem) }}</span>
                </span>
              </div>
              <h3>{{ roomItem.name }}</h3>
              <div class="room-stats">
                <span><b>{{ roomItem.players }}/{{ roomItem.capacity }}</b> 玩家</span>
                <span v-if="roomItem.phase === 'playing'"><b>{{ roomItem.spectators }}</b> 观战</span>
                <span>{{ roomDurationLabel(roomItem) }}</span>
              </div>
              <div class="room-actions" :class="{ 'single-action': roomItem.phase !== 'playing' }">
                <button
                  class="primary"
                  :disabled="roomItem.players >= roomItem.capacity || roomItem.phase === 'finished'"
                  @click="requestJoin(roomItem, 'player')"
                >
                  {{ roomItem.phase === "finished" ? "已结束" : roomItem.players >= roomItem.capacity ? "满桌" : "加入" }}
                </button>
                <button
                  v-if="roomItem.phase === 'playing'"
                  class="ghost"
                  :disabled="roomItem.spectators >= roomItem.spectatorCap"
                  @click="requestJoin(roomItem, 'spectator')"
                >
                  观战
                </button>
              </div>
            </article>
            <article class="lobby-create-card">
              <div class="create-card-top">
                <span class="create-card-mark" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </span>
                <strong>另开一席</strong>
              </div>
              <button type="button" class="primary lobby-create-action" @click="lobbyTab = 'create'">
                创建房间
              </button>
            </article>
          </div>
          <div v-else class="lobby-empty">
            <svg class="empty-board-art" aria-hidden="true" viewBox="0 0 440 320">
              <rect x="38" y="24" width="364" height="272" rx="10" />
              <path d="M56 62h328M56 100h328M56 138h328M56 176h328M56 214h328M56 252h328" />
              <path d="M74 42v236M112 42v236M150 42v236M188 42v236M226 42v236M264 42v236M302 42v236M340 42v236M378 42v236" />
              <circle class="stone red" cx="150" cy="138" r="12" />
              <circle class="stone dark" cx="226" cy="100" r="12" />
              <circle class="stone red" cx="264" cy="214" r="12" />
              <circle class="stone dark" cx="302" cy="176" r="12" />
            </svg>
            <div class="empty-copy">
              <span class="lobby-kicker">{{ scanning ? "正在读取" : "棋席虚设" }}</span>
              <p>这里还没有开桌。选好棋种与时限，先把这一席留给朋友。</p>
              <button class="primary" @click="lobbyTab = 'create'">创建房间</button>
            </div>
          </div>
        </section>

        <section v-show="lobbyTab === 'create'" class="lobby-view lobby-form-card">
          <header class="lobby-form-heading">
            <button
              type="button"
              class="lobby-form-back"
              aria-label="返回房间列表"
              title="返回房间列表"
              @click="lobbyTab = 'rooms'"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M19 12H5m6-6-6 6 6 6" />
              </svg>
            </button>
            <span class="lobby-kicker">新开一席</span>
            <h2>创建房间</h2>
            <p>定下棋种、执方和用时时长，邀请朋友入座。</p>
          </header>
          <div class="lobby-form-grid">
            <div class="field">
              <span>玩法</span>
              <div class="side-pick game-pick">
                <button
                  v-for="item in GAMES"
                  :key="item.id"
                  type="button"
                  class="time-option"
                  :class="{ on: game === item.id }"
                  @click="game = item.id"
                >
                  <span>{{ item.name }}</span>
                  <svg v-if="game === item.id" class="choice-check" aria-hidden="true" viewBox="0 0 20 20">
                    <path d="m5 10.5 3.2 3.2L15 6.8" />
                  </svg>
                </button>
              </div>
            </div>
            <div class="field">
              <span>执方</span>
              <div class="side-pick">
                <button type="button" class="time-option" :class="{ on: inputSeat === 0 }" @click="inputSeat = 0">
                  <span>{{ sideName(0) }}</span>
                  <svg v-if="inputSeat === 0" class="choice-check" aria-hidden="true" viewBox="0 0 20 20">
                    <path d="m5 10.5 3.2 3.2L15 6.8" />
                  </svg>
                </button>
                <button type="button" class="time-option" :class="{ on: inputSeat === 1 }" @click="inputSeat = 1">
                  <span>{{ sideName(1) }}</span>
                  <svg v-if="inputSeat === 1" class="choice-check" aria-hidden="true" viewBox="0 0 20 20">
                    <path d="m5 10.5 3.2 3.2L15 6.8" />
                  </svg>
                </button>
              </div>
            </div>
            <div class="field">
              <span>访问方式</span>
              <div class="password-row" :class="{ enabled: passwordEnabled }">
                <div class="password-options">
                  <button
                    type="button"
                    class="time-option"
                    :class="{ on: !passwordEnabled }"
                    :aria-pressed="!passwordEnabled"
                    @click="passwordEnabled = false"
                  >
                    公开房间
                    <svg v-if="!passwordEnabled" aria-hidden="true" viewBox="0 0 20 20">
                      <path d="m5 10.5 3.2 3.2L15 6.8" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    class="time-option"
                    :class="{ on: passwordEnabled }"
                    :aria-pressed="passwordEnabled"
                    @click="passwordEnabled = true"
                  >
                    密码房
                    <svg v-if="passwordEnabled" aria-hidden="true" viewBox="0 0 20 20">
                      <path d="m5 10.5 3.2 3.2L15 6.8" />
                    </svg>
                  </button>
                </div>

                <div v-if="passwordEnabled" class="password-control">
                  <input
                    v-model="inputPassword"
                    :type="showPassword ? 'text' : 'password'"
                    maxlength="32"
                    autocomplete="new-password"
                    placeholder="输入房间密码"
                  />
                  <button
                    type="button"
                    class="password-reveal"
                    :aria-label="showPassword ? '隐藏密码' : '显示密码'"
                    @click="showPassword = !showPassword"
                  >
                    <svg aria-hidden="true" viewBox="0 0 20 20">
                      <path d="M2.5 10s2.8-4.5 7.5-4.5 7.5 4.5 7.5 4.5-2.8 4.5-7.5 4.5S2.5 10 2.5 10z" />
                      <circle cx="10" cy="10" r="2.2" />
                      <path v-if="!showPassword" d="m4 4 12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
            <div class="field">
              <span>总时间</span>
              <div class="time-options">
                <button
                  v-for="option in TOTAL_TIME_OPTIONS"
                  :key="option.value"
                  type="button"
                  class="time-option"
                  :class="{ on: inputMinutes === option.value }"
                  @click="inputMinutes = option.value"
                >
                  {{ option.label }}
                  <svg v-if="inputMinutes === option.value" class="choice-check" aria-hidden="true" viewBox="0 0 20 20">
                    <path d="m5 10.5 3.2 3.2L15 6.8" />
                  </svg>
                </button>
              </div>
            </div>
            <div class="field">
              <span>每步限时</span>
              <div class="time-options">
                <button
                  v-for="option in MOVE_TIME_OPTIONS"
                  :key="option.value"
                  type="button"
                  class="time-option"
                  :class="{ on: inputMoveSeconds === option.value }"
                  @click="inputMoveSeconds = option.value"
                >
                  {{ option.label }}
                  <svg v-if="inputMoveSeconds === option.value" class="choice-check" aria-hidden="true" viewBox="0 0 20 20">
                    <path d="m5 10.5 3.2 3.2L15 6.8" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
          <button class="primary lobby-create" @click="createRoom">创建并进入</button>
        </section>

        <section v-show="lobbyTab === 'settings'" class="lobby-view lobby-settings">
          <header class="lobby-form-heading settings-heading">
            <button
              type="button"
              class="lobby-form-back"
              aria-label="返回房间列表"
              title="返回房间列表"
              @click="lobbyTab = 'rooms'"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M19 12H5m6-6-6 6 6 6" />
              </svg>
            </button>
            <span class="lobby-kicker">个人偏好</span>
            <h2>设置</h2>
            <p>个人资料与显示偏好</p>
          </header>
          <div class="settings-grid">
            <div class="setting-row setting-nickname-row">
              <span class="setting-copy">
                <strong>昵称</strong>
              </span>
              <div class="nickname-settings-control">
                <form class="nickname-settings-form" @submit.prevent="saveNickname">
                  <input
                    v-model="nicknameDraft"
                    :class="{ invalid: Boolean(nicknameError) }"
                    type="text"
                    maxlength="12"
                    autocomplete="nickname"
                    autocapitalize="off"
                    spellcheck="false"
                    aria-label="昵称"
                    :aria-invalid="Boolean(nicknameError)"
                    :aria-describedby="nicknameError ? 'nickname-settings-error' : undefined"
                    :disabled="nicknameSaving"
                    @input="nicknameError = ''"
                    @keydown.esc.prevent="resetNicknameDraft"
                  />
                  <button
                    type="submit"
                    class="nickname-save"
                    aria-label="保存昵称"
                    title="保存昵称"
                    :disabled="nicknameSaving || nicknameDraft.trim() === nickname"
                  >
                    <svg aria-hidden="true" viewBox="0 0 20 20">
                      <path d="m5 10.5 3.2 3.2L15 6.8" />
                    </svg>
                  </button>
                </form>
                <span
                  v-if="nicknameError"
                  id="nickname-settings-error"
                  class="nickname-settings-error"
                  role="alert"
                >
                  {{ nicknameError }}
                </span>
              </div>
            </div>
            <label class="setting-row">
              <span><strong>低动效</strong></span>
              <input :checked="lowMotion" type="checkbox" @change="toggleLowMotion" />
            </label>
            <div class="setting-row setting-choice-row">
              <span><strong>特效</strong></span>
              <div class="time-options">
                <button
                  v-for="option in EFFECT_OPTIONS"
                  :key="option.value"
                  type="button"
                  class="time-option"
                  :class="{ on: effectsLevel === option.value }"
                  @click="effectsLevel = option.value; updateEffectsLevel()"
                >
                  {{ option.label }}
                  <svg v-if="effectsLevel === option.value" class="choice-check" aria-hidden="true" viewBox="0 0 20 20">
                    <path d="m5 10.5 3.2 3.2L15 6.8" />
                  </svg>
                </button>
              </div>
            </div>
            <div class="setting-row setting-choice-row">
              <span>
                <strong>棋盘大小</strong>
                <small>对局中的棋盘显示尺寸</small>
              </span>
              <div class="time-options">
                <button
                  v-for="option in BOARD_SIZE_OPTIONS"
                  :key="option.value"
                  type="button"
                  class="time-option"
                  :class="{ on: boardSize === option.value }"
                  @click="boardSize = option.value; persistSettings()"
                >
                  {{ option.label }}
                  <svg v-if="boardSize === option.value" class="choice-check" aria-hidden="true" viewBox="0 0 20 20">
                    <path d="m5 10.5 3.2 3.2L15 6.8" />
                  </svg>
                </button>
              </div>
            </div>
            <div class="setting-row setting-choice-row">
              <span><strong>主题</strong></span>
              <div class="time-options">
                <button
                  v-for="option in THEME_OPTIONS"
                  :key="option.value"
                  type="button"
                  class="time-option"
                  :class="{ on: theme === option.value }"
                  @click="theme = option.value; persistSettings()"
                >
                  {{ option.label }}
                  <svg v-if="theme === option.value" class="choice-check" aria-hidden="true" viewBox="0 0 20 20">
                    <path d="m5 10.5 3.2 3.2L15 6.8" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </section>
        </main>
      </section>

      <div v-show="role !== 'idle'" class="room-stage">
      <!-- Seats flank the board so the players are placed around the table rather than
           listed away in the sidebar. Each one carries the person, the name and the clock. -->
      <div ref="boardColumn" class="board-col">
        <!-- Seats sit across the table, not beside it. Xiangqi puts the viewer's own side
             near; Gomoku keeps seat zero near for both players so their boards match. -->
        <aside
          v-for="seat in [0, 1]"
          :key="seat"
          class="seat-strip"
          :class="[
            isNearSeat(seat) ? 'near' : 'far',
            {
              active: seatActive(seat),
              empty: !seatMembers[seat] && seat !== aiSeat,
              mine: mySeat === seat,
            },
          ]"
        >
          <span v-if="seatActive(seat)" class="seat-turn-effect" aria-hidden="true">
            <span class="seat-turn-sweep"></span>
          </span>
          <svg class="avatar" viewBox="0 0 64 72" aria-hidden="true">
            <!-- A robe silhouette: head, shoulders, and a collar V. Kept as three shapes so
                 it reads at 44px without any asset, which the single-bundle CSP forbids. -->
            <circle class="avatar-head" cx="32" cy="19" r="10" />
            <path class="avatar-body" d="M32 31c-12 0-21 9-21 21v14h42V52c0-12-9-21-21-21z" />
            <path class="avatar-collar" d="M32 31l-7 8 7 5 7-5-7-8z" />
          </svg>
          <span class="seat-panel-tag">{{ seat === 0 ? "先手" : "后手" }}</span>
          <span class="seat-panel-name">{{ seatLabel(seat) }}</span>
          <span v-if="mySeat === seat" class="seat-self">你</span>
          <span
            v-if="clock && clock.budget > 0 && (seatMembers[seat] || seat === aiSeat)"
            class="seat-strip-clock"
            :class="{ low: clock.remaining[seat] <= 30000 }"
          >
            {{ totalClockLabel(clock.remaining[seat]) }}
          </span>
        </aside>

        <div ref="boardHost" class="canvas-host" :class="{ hidden: canvasFailed }"></div>
      </div>

      <div v-if="canvasFailed" class="fallback">渲染器不可用，已切换到简化视图。</div>

      <Transition name="undo-request">
        <div
          v-if="undoPending"
          class="undo-request"
          :class="{ waiting: isUndoRequester, spectator: !isSeated }"
          role="dialog"
          aria-live="polite"
          aria-labelledby="undo-request-title"
        >
          <div class="undo-request-copy">
            <span>悔棋请求</span>
            <strong id="undo-request-title">
              {{ isUndoRequester ? "等待对手确认" : isSeated ? "对手请求悔棋" : "棋手请求悔棋" }}
            </strong>
            <p v-if="isUndoRequester">请求已发送，确认前双方暂停落子。</p>
            <p v-else-if="isSeated">{{ undoRequesterName }} 想撤回上一手，是否同意？</p>
            <p v-else>{{ undoRequesterName }} 请求撤回上一手，等待对手处理。</p>
            <small v-if="isSeated">20 秒未处理将自动拒绝</small>
          </div>
          <div v-if="isUndoRecipient" class="undo-request-actions">
            <button class="ghost" type="button" @click="declineUndo(false)">拒绝</button>
            <button class="primary" type="button" @click="consentUndo">同意</button>
          </div>
        </div>
      </Transition>

      <!-- MVP 面板显示时让出横幅，关掉面板后横幅接回，免得同一句话出现两遍。 -->
      <div v-if="result && result.finished && !mvp" class="result-banner">
        <strong>{{ outcomeText(result.outcome) }}</strong>
        <span>{{ resultReasonLabel(result.reason) }}</span>
      </div>

      <!-- 结算整活。低动效模式只留淡入：不撒彩带、不旋转，符合本项目的降级约定。
           等棋盘的连线、印章演完后，居中的结算卡再出现。 -->
      <div v-if="mvp && !reducedMotion" class="mvp-confetti" aria-hidden="true">
        <i v-for="n in 26" :key="n" :style="confettiStyle(n)"></i>
      </div>

      <div
        v-if="mvp"
        class="mvp"
        :class="{ calm: reducedMotion, draw: mvp.draw }"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mvp-title"
        @click.self="dismissMvp"
      >
        <div class="mvp-card">
          <button
            class="mvp-close"
            type="button"
            aria-label="收起结算卡"
            @click="dismissMvp"
          >×</button>
          <p class="mvp-eyebrow">本 局 最 有 价 值</p>
          <h2 id="mvp-title" class="mvp-badge">MVP</h2>
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
            <button v-if="role === 'host'" class="primary" @click="rematch">再来一局</button>
            <p v-else class="mvp-awaiting">等待房主开始下一局</p>
          </div>
        </div>
      </div>

      </div>
    </main>

    <Transition name="join-prompt">
      <div
        v-if="joinPrompt"
        class="join-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="join-prompt-title"
        @click.self="closeJoinPrompt"
      >
        <form class="join-prompt-card" @submit.prevent="submitJoinPassword">
          <button
            class="join-prompt-close"
            type="button"
            aria-label="关闭密码输入"
            :disabled="joinSubmitting"
            @click="closeJoinPrompt"
          >×</button>
          <span class="join-prompt-kicker">私房验证</span>
          <h2 id="join-prompt-title">{{ joinPrompt.room.name }}</h2>
          <p>
            输入房主设置的密码后{{ joinPrompt.role === "spectator" ? "观战" : joinPrompt.role === "auto" ? "进入房间" : "加入" }}。
          </p>
          <label class="join-prompt-field">
            <span>房间密码</span>
            <input
              ref="joinPasswordInput"
              v-model="joinPassword"
              type="password"
              name="room-join-password"
              autocomplete="new-password"
              autocapitalize="off"
              spellcheck="false"
              placeholder="请输入密码"
              :aria-invalid="Boolean(joinPasswordError)"
              :aria-describedby="joinPasswordError ? 'join-prompt-error' : undefined"
              :disabled="joinSubmitting"
            />
          </label>
          <p v-if="joinPasswordError" id="join-prompt-error" class="join-prompt-error" role="alert">
            {{ joinPasswordError }}
          </p>
          <div class="join-prompt-actions">
            <button type="button" class="ghost" :disabled="joinSubmitting" @click="closeJoinPrompt">
              取消
            </button>
            <button type="submit" class="primary" :disabled="joinSubmitting">
              {{ joinSubmitting ? "正在进入…" : joinPrompt.role === "spectator" ? "进入观战" : joinPrompt.role === "auto" ? "进入房间" : "加入房间" }}
            </button>
          </div>
        </form>
      </div>
    </Transition>

    <Transition name="floating-message">
      <div
        v-if="floatingMessage"
        :key="floatingMessage.serial"
        class="floating-message"
        :class="`is-${floatingMessage.tone}`"
        :role="floatingMessage.tone === 'error' ? 'alert' : 'status'"
        :aria-live="floatingMessage.tone === 'error' ? 'assertive' : 'polite'"
        aria-atomic="true"
      >
        <span>{{ floatingMessage.text }}</span>
      </div>
    </Transition>
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
  /* Text on intentionally dark surfaces must not follow the theme's dark paper. */
  --on-dark: #fffaf0;
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
  --board-fit: 0.9;
  height: 100vh;
  margin: 0;
  font-family: var(--font-ui);
  color: var(--ink);
  background:
    radial-gradient(120% 90% at 14% 0%, rgba(212, 162, 74, 0.13), transparent 52%),
    radial-gradient(100% 80% at 92% 100%, rgba(176, 58, 46, 0.08), transparent 50%),
    var(--paper);
}

.workbench.lobby-mode { grid-template-columns: 1fr; }

/* ── Public lobby ───────────────────────────────────────────────────────── */

.lobby-stage {
  min-height: 100vh;
  overflow-y: auto;
  background:
    linear-gradient(180deg, rgba(255, 250, 239, 0.12), rgba(56, 40, 24, 0.08)),
    url("../assets/lobby-bg.svg") center / cover no-repeat,
    #d9c5a1;
}

.lobby-screen {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 22px;
  width: min(1180px, 100%);
  min-height: 100vh;
  margin: 0 auto;
  padding: 24px 34px 50px;
}

.lobby-atmosphere {
  position: fixed;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.mote {
  position: absolute;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: rgba(176, 58, 46, 0.44);
  box-shadow: 0 0 14px rgba(212, 162, 74, 0.45);
  animation: mote-drift 12s ease-in-out infinite alternate;
}

.mote-1 { left: 8%; top: 24%; animation-delay: -1s; }
.mote-2 { left: 18%; top: 78%; width: 3px; height: 3px; animation-delay: -5s; }
.mote-3 { left: 34%; top: 14%; animation-delay: -7s; }
.mote-4 { left: 51%; top: 84%; width: 4px; height: 4px; animation-delay: -3s; }
.mote-5 { left: 67%; top: 17%; width: 3px; height: 3px; animation-delay: -8s; }
.mote-6 { left: 78%; top: 62%; animation-delay: -4s; }
.mote-7 { left: 88%; top: 34%; width: 4px; height: 4px; animation-delay: -9s; }
.mote-8 { left: 42%; top: 63%; width: 2px; height: 2px; animation-delay: -2s; }
.mote-9 { left: 94%; top: 80%; width: 3px; height: 3px; animation-delay: -6s; }

.lobby-topbar {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 22px;
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, 0.48);
  border-radius: 20px 8px 20px 8px;
  background:
    linear-gradient(120deg, rgba(255, 252, 244, 0.72), rgba(246, 235, 214, 0.42));
  box-shadow: 0 12px 40px rgba(64, 45, 24, 0.13);
  backdrop-filter: blur(16px) saturate(1.1);
}

.lobby-brand {
  display: flex;
  align-items: center;
  gap: 14px;
}

.lobby-brand h1 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 24px;
  line-height: 1.1;
  letter-spacing: 0.04em;
  color: var(--ink);
}

.lobby-mark {
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  flex: 0 0 auto;
  font-family: var(--font-display);
  font-size: 24px;
  color: var(--on-dark);
  border-radius: 6px 12px 6px 12px;
  background: linear-gradient(145deg, #cf5945, #8f271f);
  box-shadow: 0 8px 24px rgba(176, 58, 46, 0.28);
  animation: seal-breathe 5s ease-in-out infinite;
}

.lobby-mark svg {
  width: 28px;
  height: 28px;
  fill: none;
  stroke: #fff3df;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.lobby-brand > div {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.lobby-account {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-left: auto;
}

.guest-name {
  padding: 6px 10px;
  font-size: 12px;
  color: var(--muted-text);
  background: rgba(255, 252, 244, 0.56);
  border: 1px solid rgba(112, 88, 55, 0.16);
  border-radius: var(--radius-pill);
}

.connection-state {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--soft-text);
}

.connection-state i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #8f8371;
}

.connection-state.online i {
  background: #3f7b56;
  box-shadow: 0 0 0 4px rgba(63, 123, 86, 0.12);
}

.lobby-nav {
  display: flex;
  flex-direction: row;
  gap: 4px;
}

.lobby-nav button {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 44px;
  padding: 0 14px;
  text-align: center;
  color: var(--muted-text);
  background: transparent;
  border-color: transparent;
  box-shadow: none;
}

.nav-icon {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  margin-right: 10px;
  flex: 0 0 auto;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.lobby-nav button.active {
  color: var(--red-deep);
  background: rgba(255, 250, 240, 0.78);
  border-color: rgba(176, 58, 46, 0.18);
  box-shadow: 0 5px 14px rgba(78, 53, 28, 0.1);
}

.lobby-nav button.active .nav-icon {
  stroke: var(--red-deep);
}

.lobby-main .primary {
  border-radius: 18px 7px 20px 9px;
  color: #fff9ee;
  background: linear-gradient(135deg, #c8513d, #8f2c22);
  box-shadow: 0 9px 22px rgba(119, 39, 29, 0.22);
}

.lobby-main .primary:hover {
  background: linear-gradient(135deg, #d05c47, #9b3227);
  box-shadow: 0 13px 28px rgba(119, 39, 29, 0.28);
}

.lobby-main .ghost {
  border-radius: 7px 16px 8px 18px;
  background: rgba(255, 250, 240, 0.55);
  backdrop-filter: blur(10px);
}

.lobby-main {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
  padding: 8px 4px 40px;
  background: transparent;
  box-shadow: none;
  z-index: 1;
}

.lobby-main > * {
  position: relative;
  z-index: 1;
}

.server-pill {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 4px 9px;
  padding: 12px 16px;
  font-size: 12px;
  color: var(--soft-text);
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  background: rgba(255, 253, 248, 0.82);
  box-shadow: var(--shadow-1);
}

.server-pill small {
  grid-column: 2;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--soft-text);
}

.server-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--soft-text);
  box-shadow: 0 0 0 4px rgba(107, 98, 83, 0.1);
}

.server-pill.online .server-dot {
  background: #3f7b56;
  box-shadow: 0 0 0 4px rgba(63, 123, 86, 0.14);
}

.lobby-tabs {
  display: flex;
  gap: 8px;
  margin: 16px 0 20px;
  padding: 5px;
  width: fit-content;
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  background: rgba(255, 253, 248, 0.72);
}

.lobby-tabs button {
  height: 40px;
  border: 0;
  border-radius: var(--radius-pill);
  background: transparent;
  box-shadow: none;
  color: var(--soft-text);
}

.lobby-tabs button.active {
  color: var(--paper-warm);
  background: var(--ink);
  box-shadow: var(--shadow-2);
}

.lobby-view {
  display: flex;
  flex-direction: column;
  gap: 20px;
  animation: reveal var(--dur-slow) var(--ease-decelerate) both;
}

.lobby-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.lobby-toolbar h2 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 26px;
  letter-spacing: 0.04em;
}

.room-filters {
  display: flex;
  gap: 4px;
}

.room-filters button {
  height: 36px;
  padding: 0 14px;
  font-size: 13px;
  color: var(--soft-text);
  background: transparent;
  border-color: transparent;
  box-shadow: none;
}

.room-filters button.active {
  color: var(--ink);
  background: var(--surface);
  border-color: var(--line);
  box-shadow: var(--shadow-1);
}

.lobby-toolbar-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: var(--soft-text);
}

.lobby-section-head {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 20px;
}

.lobby-section-head h2 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 24px;
  letter-spacing: 0.06em;
}

.lobby-section-head p {
  margin: 6px 0 0;
  color: var(--soft-text);
  font-size: 13px;
}

.identity-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 16px 18px;
  background: rgba(255, 253, 248, 0.72);
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
}

.identity-card > div:first-child { display: flex; flex-direction: column; gap: 4px; }
.identity-label { font-size: 11px; letter-spacing: 0.12em; color: var(--soft-text); }
.identity-edit { display: flex; gap: 8px; }

.identity-edit input,
.lobby-password input,
.setting-row select {
  min-height: 38px;
  padding: 0 12px;
  color: var(--ink);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-btn);
  font: inherit;
}

.lobby-password {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 16px;
  border-left: 3px solid var(--gold);
  background: rgba(212, 162, 74, 0.09);
}

.lobby-password span { font-size: 12px; color: var(--soft-text); }
.lobby-password input { flex: 1; }

.join-prompt {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(28, 26, 23, 0.46);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
}

.join-prompt-card {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(420px, 100%);
  padding: 28px;
  color: var(--ink);
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.62), transparent 48%),
    var(--paper-warm);
  border: 1px solid rgba(91, 70, 44, 0.28);
  border-radius: 4px 18px 4px 18px;
  box-shadow: 8px 8px 0 rgba(28, 26, 23, 0.12), var(--shadow-3);
}

.join-prompt-card::before {
  content: "";
  position: absolute;
  inset: 0 auto 0 0;
  width: 5px;
  background: linear-gradient(180deg, var(--red), var(--red-deep));
}

.join-prompt-close {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 32px;
  height: 32px;
  min-width: 32px;
  padding: 0;
  color: var(--soft-text);
  background: transparent;
  border: 0;
  box-shadow: none;
  font-size: 22px;
  line-height: 1;
}

.join-prompt-kicker {
  color: var(--red-deep);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.18em;
}

.join-prompt-card h2 {
  margin: 8px 34px 6px 0;
  font-family: var(--font-display);
  font-size: 24px;
  letter-spacing: 0.04em;
}

.join-prompt-card > p {
  margin: 0 0 20px;
  color: var(--soft-text);
  font-size: 13px;
  line-height: 1.65;
}

.join-prompt-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.join-prompt-field span {
  color: var(--muted-text);
  font-size: 12px;
  font-weight: 600;
}

.join-prompt-field input {
  width: 100%;
  height: 44px;
  padding: 0 14px;
  color: var(--ink);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-btn);
  box-shadow: var(--shadow-1);
  font: inherit;
}

.join-prompt-field input:focus-visible {
  outline: 3px solid rgba(212, 162, 74, 0.36);
  outline-offset: 1px;
  border-color: var(--wood);
}

.join-prompt-card > .join-prompt-error {
  margin: 9px 0 0;
  color: var(--red-deep);
  font-size: 12px;
}

.join-prompt-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 22px;
}

.join-prompt-enter-active,
.join-prompt-leave-active {
  transition: opacity var(--dur-base) var(--ease-standard);
}

.join-prompt-enter-active .join-prompt-card,
.join-prompt-leave-active .join-prompt-card {
  transition: transform var(--dur-base) var(--ease-spring), opacity var(--dur-base) var(--ease-standard);
}

.join-prompt-enter-from,
.join-prompt-leave-to {
  opacity: 0;
}

.join-prompt-enter-from .join-prompt-card,
.join-prompt-leave-to .join-prompt-card {
  opacity: 0;
  transform: translateY(12px) scale(0.97);
}

.notice {
  margin: 0;
  padding: 9px 12px;
  color: var(--wood);
  background: rgba(212, 162, 74, 0.1);
  border-left: 3px solid var(--gold);
  border-radius: var(--radius-sm);
}

.lobby-room-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 10px;
}

.lobby-room-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  overflow: hidden;
  border: 1px solid rgba(91, 70, 44, 0.18);
  border-radius: 4px 14px 14px 4px;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.65), transparent 55%),
    #fbf5e9;
  box-shadow: 4px 4px 0 rgba(59, 45, 29, 0.06), 0 10px 24px rgba(59, 45, 29, 0.08);
  transition: transform var(--dur-base) var(--ease-standard), box-shadow var(--dur-base) var(--ease-standard);
}

.lobby-room-card:nth-child(3n + 1) { transform: rotate(-0.35deg); }
.lobby-room-card:nth-child(3n + 2) { transform: translateY(4px) rotate(0.28deg); }
.lobby-room-card:nth-child(3n) { transform: translateY(-2px) rotate(0.16deg); }

.lobby-room-card::before {
  content: "";
  position: absolute;
  inset: 0 auto 0 0;
  width: 5px;
  background: linear-gradient(180deg, #c34a39, #8f271f);
}

.lobby-room-card.status-playing::before { background: var(--red); }
.lobby-room-card.status-finished::before { background: var(--soft-text); }
.lobby-room-card:hover {
  transform: translateY(-4px) rotate(0deg);
  box-shadow: 5px 5px 0 rgba(59, 45, 29, 0.07), 0 15px 30px rgba(59, 45, 29, 0.12);
}

.lobby-room-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.game-mark {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-display);
  font-size: 14px;
  letter-spacing: 0.08em;
}

.game-seal {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  font-size: 14px;
  color: var(--paper-warm);
  border-radius: 50%;
  background: var(--ink);
}

.game-seal svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: #fff8eb;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.lobby-room-card[data-game="gomoku"] .game-seal svg {
  fill: #fff8eb;
  stroke: none;
}

.lobby-room-card[data-game="xiangqi"] .game-seal {
  background: linear-gradient(145deg, #c54d3c, #8f271f);
}

.lobby-room-card[data-game="gomoku"] .game-seal {
  background: linear-gradient(145deg, #4d4a43, #211f1b);
}

.room-state {
  padding: 4px 9px;
  font-size: 11px;
  border-radius: var(--radius-pill);
  background: rgba(212, 162, 74, 0.12);
  color: var(--wood);
}

.status-playing .room-state { background: rgba(176, 58, 46, 0.1); color: var(--red-deep); }
.status-finished .room-state { background: rgba(28, 26, 23, 0.07); color: var(--soft-text); }

.lobby-room-card h3 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 20px;
  line-height: 1.25;
  letter-spacing: 0.04em;
}

.room-facts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin: 0;
}

.room-badges {
  display: flex;
  align-items: center;
  gap: 6px;
}

.lock-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 7px;
  font-size: 10px;
  border-radius: var(--radius-pill);
  color: var(--red-deep);
  background: rgba(176, 58, 46, 0.08);
}

.lock-badge svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
}

.room-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  font-size: 12px;
  color: var(--soft-text);
}

.room-stats b {
  font-family: var(--font-num);
  font-size: 13px;
  color: var(--ink);
}

.room-facts > div {
  padding: 8px 10px;
  background: rgba(28, 26, 23, 0.035);
  border-radius: var(--radius-sm);
}

.room-facts dt { font-size: 10px; letter-spacing: 0.08em; color: var(--soft-text); }
.room-facts dd { margin: 2px 0 0; font-size: 13px; font-weight: 650; }
.room-actions { display: grid; grid-template-columns: 1fr auto; gap: 8px; margin-top: auto; }
.lobby-room-card .room-actions { grid-template-columns: auto auto; justify-content: start; }
.room-actions.single-action { grid-template-columns: auto; }
.lobby-room-card .room-actions .primary {
  background: linear-gradient(180deg, #9c3429, #76241d);
}
.lobby-room-card .room-actions button {
  width: 108px;
  min-width: 108px;
  height: 36px;
  padding: 0 12px;
  font-size: 13px;
  box-shadow: 2px 2px 0 var(--ink);
}
.lobby-room-card .room-actions button:hover {
  box-shadow: 3px 3px 0 var(--ink);
}

.lobby-empty {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 48px 24px;
  text-align: center;
  min-height: 360px;
  overflow: hidden;
  border: 0;
  border-radius: 4px 18px 18px 4px;
  background:
    radial-gradient(ellipse at center, rgba(255, 250, 240, 0.48), rgba(255, 250, 240, 0.1) 55%, transparent 73%),
    repeating-linear-gradient(0deg, transparent 0 46px, rgba(104, 77, 43, 0.08) 46px 47px),
    repeating-linear-gradient(90deg, transparent 0 46px, rgba(104, 77, 43, 0.08) 46px 47px);
}

.empty-board-art {
  position: absolute;
  left: 50%;
  top: 50%;
  width: min(440px, 72%);
  transform: translate(-50%, -50%) rotate(-4deg);
  fill: none;
  stroke: rgba(104, 77, 43, 0.12);
  stroke-width: 1;
  pointer-events: none;
}

.empty-board-art .stone {
  stroke-width: 0;
}

.empty-board-art .stone.red { fill: rgba(176, 58, 46, 0.16); }
.empty-board-art .stone.dark { fill: rgba(28, 26, 23, 0.12); }

.lobby-empty strong,
.lobby-empty button {
  position: relative;
  z-index: 1;
}

.lobby-empty strong { font-family: var(--font-display); font-size: 28px; letter-spacing: 0.08em; }
.lobby-empty p { margin: 0 0 8px; color: var(--soft-text); }

.lobby-form-card h2,
.settings-head h2 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 22px;
  letter-spacing: 0.04em;
}

.settings-head {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 16px;
}

.settings-head > span {
  font-size: 12px;
  color: var(--soft-text);
}

.lobby-form-card,
.lobby-settings {
  width: min(680px, 100%);
  margin-inline: auto;
  padding: 24px;
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  background: rgba(255, 253, 248, 0.8);
  box-shadow: var(--shadow-1);
}

.lobby-form-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 18px;
}

.lobby-form-card > h2 { text-align: center; }
.lobby-create { align-self: center; min-width: 200px; }

.settings-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 54px;
  padding: 10px 14px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-card);
  background: rgba(255, 253, 248, 0.72);
}

.setting-row > span { display: flex; flex-direction: column; gap: 3px; }
.setting-row strong { font-size: 14px; }
.setting-row small { color: var(--soft-text); font-size: 11px; line-height: 1.45; }
.setting-row > input[type="checkbox"] { width: 20px; height: 20px; accent-color: var(--red); }
.setting-row.disabled { opacity: 0.5; }
.setting-range { flex-wrap: wrap; }
.setting-range input[type="range"] { width: 100%; accent-color: var(--red); }

:root[data-theme="ink"] {
  --ink: #f3ead9;
  --ink-soft: #d9ceb9;
  --paper: #171613;
  --paper-warm: #211f1a;
  --paper-deep: #2c2922;
  --surface: #24211c;
  --muted-text: #d0c5b2;
  --soft-text: #b7ad9d;
  --line: rgba(243, 234, 217, 0.16);
  --line-soft: rgba(243, 234, 217, 0.09);
}

[data-theme="ink"] .workbench,
[data-theme="ink"] .lobby-stage {
  background: radial-gradient(90% 80% at 20% 0%, rgba(212, 162, 74, 0.1), transparent 50%), var(--paper);
}

[data-theme="ink"] .lobby-main {
  background:
    linear-gradient(90deg, rgba(143, 47, 40, 0.2) 0 4px, transparent 4px),
    radial-gradient(70% 80% at 85% 8%, rgba(212, 162, 74, 0.08), transparent 60%),
    repeating-linear-gradient(0deg, transparent 0 39px, rgba(243, 234, 217, 0.018) 39px 40px),
    #201d18;
}

[data-theme="ink"] .lobby-empty {
  background:
    linear-gradient(rgba(32, 29, 24, 0.84), rgba(32, 29, 24, 0.94)),
    repeating-linear-gradient(0deg, transparent 0 46px, rgba(212, 162, 74, 0.12) 46px 47px),
    repeating-linear-gradient(90deg, transparent 0 46px, rgba(212, 162, 74, 0.12) 46px 47px);
}

[data-theme="ink"] .rail,
[data-theme="ink"] .lobby-room-card,
[data-theme="ink"] .identity-card,
[data-theme="ink"] .lobby-form-card,
[data-theme="ink"] .lobby-settings,
[data-theme="ink"] .setting-row,
[data-theme="ink"] .server-pill {
  background-color: rgba(36, 33, 28, 0.9);
}

[data-theme="ink"] .lobby-section-head p,
[data-theme="ink"] .lobby-lead,
[data-theme="ink"] .room-facts dt {
  color: var(--soft-text);
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

.password-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.password-options {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: 0;
  flex: 0 0 auto;
}

.password-control {
  width: 100%;
  min-width: 0;
  height: 44px;
  display: flex;
  align-items: center;
  background: rgba(255, 252, 244, 0.52);
  border: 1px solid rgba(112, 88, 55, 0.1);
  border-radius: 0;
  animation: password-pop var(--dur-base) var(--ease-decelerate) both;
}

.password-control input {
  width: 100%;
  flex: 1;
  min-width: 0;
  height: 42px;
  padding: 0 10px;
  background: transparent;
  border: 0;
  box-shadow: none;
}

.password-control input:focus-visible {
  outline: 0;
  box-shadow: none;
}

.password-reveal {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  flex: 0 0 42px;
  padding: 0;
  color: var(--soft-text);
  background: transparent;
  border: 0;
  border-radius: 8px;
  box-shadow: none;
}

.password-reveal:hover {
  color: var(--ink);
  background: rgba(112, 88, 55, 0.08);
}

.password-reveal svg {
  width: 17px;
  height: 17px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
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
.side-pick {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.side-pick .pick {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-height: 38px;
  padding: 0 14px;
  flex: 0 1 auto;
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
  color: #28573f;
  background: rgba(63, 123, 86, 0.09);
  border-color: rgba(63, 123, 86, 0.42);
  box-shadow: inset 3px 0 0 #4f8665;
}

.side-pick .pick:focus-visible { outline: 3px solid var(--gold); outline-offset: 2px; }

.time-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.time-option {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 34px;
  padding: 0 10px;
  flex: 0 0 auto;
  white-space: nowrap;
  font-size: 12px;
  color: var(--muted-text);
  background: rgba(247, 239, 223, 0.42);
  border: 1px solid rgba(112, 88, 55, 0.14);
  border-radius: var(--radius-pill);
  box-shadow: none;
}

.time-option:hover {
  color: var(--ink);
  background: rgba(255, 250, 240, 0.68);
  border-color: rgba(112, 88, 55, 0.28);
}

.time-option.on {
  color: #28573f;
  background: rgba(63, 123, 86, 0.1);
  border-color: rgba(63, 123, 86, 0.4);
}

.time-option .choice-check {
  width: 15px;
  height: 15px;
}

.choice-check {
  width: 19px;
  height: 19px;
  flex: 0 0 auto;
  fill: none;
  stroke: #3f7b56;
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

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
.room-stage { flex: 1; min-height: 0; display: flex; flex-direction: column; }

/* Board with its two seats stacked across the table: the far side on top, the viewer's
   side underneath. Placed by named areas rather than source order, because both seats come
   from one v-for and would otherwise sit next to each other. */
.board-col {
  position: relative;
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
  position: relative;
  isolation: isolate;
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

.board-col .seat-strip.far {
  transform: translateY(var(--seat-far-offset, 0px));
}

.board-col .seat-strip.near {
  transform: translateY(var(--seat-near-offset, 0px));
}

.seat-strip.active {
  border-color: rgba(176, 58, 46, 0.45);
  box-shadow: var(--shadow-2);
  transform: translateY(-1px);
}

.seat-turn-effect {
  position: absolute;
  inset: -3px;
  z-index: 0;
  border: 1px solid rgba(188, 138, 61, 0.72);
  border-radius: inherit;
  pointer-events: none;
  animation: seat-turn-breathe 2.35s var(--ease-standard) infinite;
}

.seat-strip > :not(.seat-turn-effect) {
  position: relative;
  z-index: 1;
}

.seat-turn-effect::before,
.seat-turn-effect::after {
  content: "";
  position: absolute;
  pointer-events: none;
}

.seat-turn-effect::before {
  inset: -2px;
  border: 2px solid rgba(176, 58, 46, 0.64);
  border-radius: inherit;
  animation: seat-turn-flare 0.95s var(--ease-decelerate) both;
}

.seat-turn-effect::after {
  top: -3px;
  left: 22%;
  width: 42%;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--gold), var(--red), transparent);
  box-shadow: 0 0 9px rgba(212, 162, 74, 0.72);
  animation: seat-turn-brush 0.9s var(--ease-decelerate) both;
}

.seat-turn-sweep {
  position: absolute;
  inset: 0;
  overflow: hidden;
  border-radius: inherit;
}

.seat-turn-sweep::before {
  content: "";
  position: absolute;
  top: -25%;
  bottom: -25%;
  left: 0;
  width: 34%;
  background: linear-gradient(90deg, transparent, rgba(255, 249, 234, 0.44), transparent);
  transform: translateX(-180%) skewX(-16deg);
  animation: seat-turn-sheen 2.8s var(--ease-standard) 0.8s infinite;
}

.seat-turn-sweep::after {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  width: 30%;
  height: 3px;
  border-radius: 2px;
  background: linear-gradient(90deg, transparent, var(--red), var(--gold), transparent);
  box-shadow: 0 0 12px rgba(188, 138, 61, 0.72);
  transform: translateX(18%);
  animation: seat-turn-orbit 2.1s ease-in-out infinite alternate;
}

.seat-strip.active .avatar {
  animation:
    seat-turn-avatar 0.72s var(--ease-spring) both,
    seat-turn-avatar-glow 2.35s ease-in-out 0.72s infinite;
  filter: drop-shadow(0 0 7px rgba(176, 58, 46, 0.35));
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

@keyframes seat-turn-breathe {
  0%,
  100% {
    border-color: rgba(188, 138, 61, 0.48);
    box-shadow: 0 0 0 0 rgba(176, 58, 46, 0);
  }
  50% {
    border-color: rgba(188, 138, 61, 0.9);
    box-shadow:
      0 0 0 2px rgba(176, 58, 46, 0.08),
      0 0 18px rgba(188, 138, 61, 0.28);
  }
}

@keyframes seat-turn-flare {
  0% {
    opacity: 0.78;
    transform: scale(0.96);
  }
  100% {
    opacity: 0;
    transform: scale(1.13);
  }
}

@keyframes seat-turn-brush {
  0% {
    opacity: 0;
    transform: scaleX(0.25);
  }
  35% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    transform: scaleX(1.9);
  }
}

@keyframes seat-turn-avatar {
  0% {
    opacity: 0.45;
    transform: scale(0.82);
  }
  65% {
    opacity: 1;
    transform: scale(1.08);
  }
  100% {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes seat-turn-sheen {
  0%,
  18% {
    opacity: 0;
    transform: translateX(-180%) skewX(-16deg);
  }
  42% {
    opacity: 0.8;
  }
  78%,
  100% {
    opacity: 0;
    transform: translateX(390%) skewX(-16deg);
  }
}

@keyframes seat-turn-orbit {
  0% {
    opacity: 0.42;
    transform: translateX(18%);
  }
  100% {
    opacity: 1;
    transform: translateX(228%);
  }
}

@keyframes seat-turn-avatar-glow {
  0%,
  100% {
    filter: drop-shadow(0 0 4px rgba(176, 58, 46, 0.24));
  }
  50% {
    filter: drop-shadow(0 0 10px rgba(188, 138, 61, 0.62));
  }
}

.motion-reduced .seat-turn-effect,
.motion-reduced .seat-turn-effect::before,
.motion-reduced .seat-turn-effect::after,
.motion-reduced .seat-turn-sweep::before,
.motion-reduced .seat-strip.active .avatar {
  animation: none !important;
}

.motion-reduced .seat-turn-effect::before,
.motion-reduced .seat-turn-effect::after,
.motion-reduced .seat-turn-sweep,
.motion-reduced .seat-turn-sweep::after {
  display: none;
}

.motion-reduced .seat-turn-effect {
  border-color: rgba(176, 58, 46, 0.46);
  box-shadow: none;
}

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
  max-width: calc(100% * var(--board-fit));
  max-height: calc(100% * var(--board-fit));
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

/* ── Undo request ────────────────────────────────────────────────────────── */

.undo-request {
  position: fixed;
  top: 92px;
  left: calc(50% + 152px);
  z-index: 55;
  width: min(400px, calc(100vw - 40px));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 15px 18px;
  border: 1px solid rgba(157, 48, 38, 0.26);
  border-radius: 2px;
  background: rgba(248, 242, 231, 0.78);
  backdrop-filter: blur(12px) saturate(1.18);
  -webkit-backdrop-filter: blur(12px) saturate(1.18);
  box-shadow: 0 16px 38px rgba(34, 28, 20, 0.16);
  transform: translateX(-50%);
}

.undo-request-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.undo-request-copy > span {
  color: var(--red-deep);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.2em;
}

.undo-request-copy strong {
  color: var(--ink);
  font-family: var(--font-display);
  font-size: 18px;
  letter-spacing: 0.04em;
}

.undo-request-copy p,
.undo-request-copy small {
  margin: 0;
  color: var(--soft-text);
  font-size: 12px;
  line-height: 1.5;
}

.undo-request-copy small {
  color: var(--muted-text);
  font-size: 10px;
}

.undo-request-actions {
  flex: 0 0 auto;
  display: flex;
  gap: 7px;
}

.undo-request-actions button {
  min-width: 62px;
  min-height: 34px;
  padding: 6px 12px;
}

.undo-request-enter-active,
.undo-request-leave-active {
  transition:
    opacity var(--dur-base) var(--ease-standard),
    transform var(--dur-base) var(--ease-standard);
}

.undo-request-enter-from,
.undo-request-leave-to {
  opacity: 0;
  transform: translate(-50%, -8px);
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
  color: var(--on-dark);
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

/* The result is a modal card at the centre of the viewport, independent of the room layout.
   Its backdrop is clickable so the player can return to the board without the old
   secondary action. */
.mvp {
  position: fixed;
  inset: 0;
  z-index: 60;
  width: auto;
  max-width: none;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: clamp(16px, 4vw, 40px);
  overflow-y: auto;
  background: rgba(28, 26, 23, 0.48);
  backdrop-filter: blur(5px);
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
  width: min(430px, 100%);
  max-height: calc(100dvh - clamp(32px, 8vw, 80px));
  padding: 30px 30px 24px;
  overflow-y: auto;
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

.mvp-close {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  box-shadow: none;
  color: rgba(28, 26, 23, 0.48);
  font: 400 24px/1 var(--font-ui);
}

.mvp-close:hover {
  color: var(--ink);
  background: rgba(28, 26, 23, 0.07);
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

.mvp-actions button {
  min-width: 148px;
}

.mvp-awaiting {
  margin: 0;
  padding: 6px 10px;
  font-size: 12px;
  letter-spacing: 0.08em;
  color: rgba(28, 26, 23, 0.52);
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
  color: var(--on-dark);
  background: var(--red);
  border-radius: var(--radius-pill);
  animation: flag-pulse 1.4s var(--ease-standard) infinite;
}

@keyframes flag-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.62; }
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

@keyframes mote-drift {
  from { transform: translate3d(-8px, 8px, 0) scale(0.8); opacity: 0.25; }
  55% { opacity: 0.75; }
  to { transform: translate3d(18px, -26px, 0) scale(1.15); opacity: 0.2; }
}

@keyframes seal-breathe {
  0%, 100% { transform: rotate(-1deg); box-shadow: 0 8px 24px rgba(176, 58, 46, 0.24); }
  50% { transform: rotate(1deg); box-shadow: 0 11px 30px rgba(176, 58, 46, 0.34); }
}

@keyframes password-pop {
  from { opacity: 0; transform: translateX(-7px); }
  to { opacity: 1; transform: translateX(0); }
}

/* ── Responsive ─────────────────────────────────────────────────────────── */

@media (max-width: 900px) {
  .workbench { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
  .workbench.lobby-mode { grid-template-rows: 1fr; }

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
  .lobby-screen {
    gap: 12px;
    padding: 12px 14px 36px;
  }
  .lobby-topbar {
    flex-wrap: wrap;
    align-items: center;
    padding: 12px;
    border-radius: 16px;
  }
  .lobby-brand { flex: 1 0 auto; }
  .lobby-nav { flex-direction: row; flex-wrap: wrap; }
  .lobby-nav button { width: auto; }
  .lobby-account {
    flex-direction: row;
    align-items: center;
    margin-left: auto;
  }
  .lobby-main { padding: 4px 0 32px; }
  .lobby-toolbar { align-items: flex-start; flex-direction: column; }
  .lobby-form-grid,
  .settings-grid { grid-template-columns: 1fr; }
  .identity-card { align-items: stretch; flex-direction: column; }
  .identity-edit { width: 100%; }
  .identity-edit input { flex: 1; min-width: 0; }
  .lobby-room-grid { grid-template-columns: 1fr; }
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

/* ── 2026 editorial refresh ───────────────────────────────────────────────
 * A chess-house visual language: fewer floating cards, flatter paper surfaces,
 * seal-red accents, ink rules and board geometry. The interaction model and
 * game canvas stay untouched.
 */

:root {
  --ink: #201d18;
  --ink-soft: #343028;
  --paper: #e8decd;
  --paper-warm: #f7f0e4;
  --paper-deep: #d8cbb7;
  --surface: #f8f2e7;
  --red: #9d3026;
  --red-deep: #7d241d;
  --gold: #bc8a3d;
  --wood: #735833;
  --muted-text: #564e42;
  --soft-text: #665c4d;
  --line: rgba(42, 34, 24, 0.2);
  --line-soft: rgba(42, 34, 24, 0.1);
  --radius-sm: 2px;
  --radius-btn: 3px;
  --radius-card: 3px;
  --radius-panel: 4px;
  --radius-pill: 3px;
  --shadow-1: 0 1px 0 rgba(41, 31, 20, 0.06);
  --shadow-2: 0 8px 24px rgba(41, 31, 20, 0.08);
  --shadow-3: 0 18px 48px rgba(41, 31, 20, 0.14);
  --font-ui: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
  --font-display: "Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif;
}

.workbench {
  background-color: #ddd1bf;
  background-image:
    linear-gradient(90deg, rgba(73, 57, 38, 0.025) 1px, transparent 1px),
    linear-gradient(rgba(73, 57, 38, 0.025) 1px, transparent 1px);
  background-size: 56px 56px;
}

.lobby-stage {
  position: relative;
  background-color: #e9dfcf;
  background-image:
    linear-gradient(90deg, rgba(69, 54, 36, 0.055) 1px, transparent 1px),
    linear-gradient(rgba(69, 54, 36, 0.055) 1px, transparent 1px),
    repeating-linear-gradient(0deg, transparent 0 3px, rgba(255, 255, 255, 0.08) 3px 4px),
    repeating-linear-gradient(115deg, transparent 0 22px, rgba(77, 59, 39, 0.022) 22px 23px);
  background-size: 64px 64px, 64px 64px, auto, auto;
}

.lobby-stage::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background:
    linear-gradient(90deg, transparent 0 7.5%, rgba(116, 86, 50, 0.06) 7.5% calc(7.5% + 1px), transparent calc(7.5% + 1px)),
    linear-gradient(90deg, transparent 0 92.5%, rgba(116, 86, 50, 0.06) 92.5% calc(92.5% + 1px), transparent calc(92.5% + 1px));
}

.lobby-stage::after {
  content: "";
  position: fixed;
  right: clamp(-175px, -10vw, -72px);
  bottom: clamp(-190px, -20vh, -90px);
  z-index: 0;
  width: clamp(460px, 52vw, 740px);
  aspect-ratio: 1;
  border: 1px solid rgba(73, 53, 30, 0.13);
  background-image:
    repeating-linear-gradient(0deg, transparent 0 55px, rgba(73, 53, 30, 0.11) 55px 56px),
    repeating-linear-gradient(90deg, transparent 0 55px, rgba(73, 53, 30, 0.11) 55px 56px);
  box-shadow: inset 0 0 0 18px rgba(255, 250, 239, 0.05);
  transform: rotate(-7deg);
  pointer-events: none;
}

.lobby-screen {
  z-index: 1;
  gap: 18px;
  width: min(1240px, 100%);
  padding: 22px 42px 48px;
}

.lobby-atmosphere {
  display: none;
}

.lobby-topbar {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 34px;
  align-items: center;
  padding: 15px 0 17px;
  border: 0;
  border-bottom: 1px solid rgba(42, 34, 24, 0.28);
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}

.lobby-brand {
  gap: 13px;
}

.lobby-mark {
  width: 42px;
  height: 46px;
  border: 1px solid rgba(255, 248, 235, 0.38);
  border-radius: 2px;
  background: var(--red-deep);
  box-shadow: 4px 4px 0 rgba(83, 61, 36, 0.15);
  animation: none;
}

.lobby-mark svg {
  width: 25px;
  height: 25px;
  stroke: #fff9ed;
}

.lobby-brand > div {
  gap: 5px;
}

.lobby-brand h1 {
  font-size: 25px;
  font-weight: 700;
  letter-spacing: 0.12em;
}

.lobby-brand-note {
  margin: 0;
  font-family: var(--font-ui);
  font-size: 10px;
  line-height: 1;
  letter-spacing: 0.18em;
  color: var(--soft-text);
}

.lobby-nav {
  align-self: stretch;
  justify-self: center;
  gap: 24px;
}

.lobby-nav button {
  position: relative;
  height: auto;
  min-height: 44px;
  padding: 0 3px;
  color: var(--soft-text);
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.lobby-nav button::after {
  content: "";
  position: absolute;
  right: 2px;
  bottom: -18px;
  left: 2px;
  height: 2px;
  background: transparent;
  transition: background var(--dur-base) var(--ease-standard);
}

.lobby-nav button:hover {
  color: var(--ink);
  background: transparent;
}

.lobby-nav button.active {
  color: var(--ink);
  background: transparent;
  border: 0;
  box-shadow: none;
}

.lobby-nav button.active::after {
  background: var(--red);
}

.lobby-nav button.active .nav-icon {
  stroke: var(--red-deep);
}

.nav-icon {
  width: 21px;
  height: 21px;
  margin-right: 8px;
  stroke-width: 1.55;
}

.lobby-account {
  display: grid;
  justify-self: end;
  gap: 4px;
  min-width: 180px;
  margin-left: 0;
}

.account-profile {
  display: flex;
  align-items: baseline;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
}

.account-meta {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  min-width: 0;
  gap: 10px;
}

.lobby-settings-button,
.lobby-form-back {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  padding: 0;
  color: var(--soft-text);
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 2px;
  box-shadow: none;
}

.lobby-settings-button {
  display: inline-flex;
  width: auto;
  min-width: 88px;
  height: 46px;
  margin-left: 0;
  padding: 0 13px;
  gap: 7px;
  background: transparent;
  border: 0;
  box-shadow: none;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.lobby-form-back {
  width: 42px;
  height: 42px;
  color: #fffaf0;
  background: var(--red-deep);
  border-color: var(--red-deep);
  box-shadow: 2px 2px 0 var(--ink);
}

.lobby-form-back:hover {
  color: #fffaf0;
  background: var(--red);
  border-color: var(--red);
  box-shadow: 3px 3px 0 var(--ink);
}

.lobby-form-back:active {
  box-shadow: 1px 1px 0 var(--ink);
  transform: translate(1px, 1px);
}

.lobby-population {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding-left: 14px;
  color: var(--soft-text);
  border-left: 1px solid var(--line);
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
}

.lobby-population svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.lobby-population strong {
  color: var(--ink);
  font-family: var(--font-num);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.lobby-form-back:hover {
  color: var(--ink);
  background: rgba(247, 240, 228, 0.5);
  border-color: rgba(58, 45, 29, 0.34);
  transform: none;
}

.lobby-settings-button:hover {
  color: var(--red-deep);
  background: transparent;
  border-color: transparent;
  transform: none;
}

.lobby-settings-button.active {
  color: var(--red-deep);
  background: transparent;
  border-color: transparent;
}

.lobby-settings-button svg,
.lobby-form-back svg {
  width: 17px;
  height: 17px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.guest-name {
  display: block;
  min-width: 0;
  max-width: 260px;
  padding: 0;
  overflow: hidden;
  color: var(--ink);
  background: transparent;
  border: 0;
  font-family: var(--font-ui);
  font-size: 16px;
  font-weight: 400;
  line-height: 1.3;
  letter-spacing: 0.015em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-label {
  white-space: nowrap;
}

.setting-nickname-row {
  align-items: flex-start;
  gap: 24px;
}

.setting-nickname-row .setting-copy {
  flex: 1 1 auto;
  padding-top: 10px;
}

.nickname-settings-control {
  flex: 0 1 248px;
  width: 248px;
  min-width: 0;
}

.nickname-settings-form {
  display: flex;
  align-items: stretch;
  gap: 0;
}

.nickname-settings-form input {
  flex: 1;
  min-width: 0;
  height: 44px;
  padding: 0 14px;
  color: var(--ink);
  background: rgba(249, 244, 235, 0.42);
  border: 1px solid rgba(55, 43, 27, 0.25);
  border-right: 0;
  border-radius: 0;
  outline: 0;
  font: inherit;
  font-family: var(--font-num);
  font-size: 14px;
  letter-spacing: 0.02em;
}

.nickname-settings-form input:focus {
  position: relative;
  z-index: 1;
  border-color: var(--ink);
  box-shadow: inset 0 0 0 1px var(--ink);
}

.nickname-settings-form input.invalid {
  border-color: var(--red);
}

.nickname-save {
  display: grid;
  place-items: center;
  flex: 0 0 46px;
  width: 46px;
  height: 44px;
  padding: 0;
  color: #fffaf0;
  background: var(--ink);
  border: 1px solid var(--ink);
  border-radius: 0;
  box-shadow: none;
}

.nickname-save:disabled {
  color: var(--soft-text);
  background: rgba(249, 244, 235, 0.42);
  border-color: rgba(55, 43, 27, 0.25);
  opacity: 1;
  box-shadow: none;
}

.nickname-save svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.nickname-settings-error {
  display: block;
  margin-top: 7px;
  color: var(--red-deep);
  font-size: 11px;
  line-height: 1.45;
}

.connection-state {
  padding-left: 14px;
  border-left: 1px solid var(--line);
  font-size: 11px;
}

.connection-state.online i {
  background: #47705a;
  box-shadow: none;
}

.lobby-main {
  gap: 18px;
  padding: 22px 0 34px;
}

.lobby-toolbar {
  align-items: flex-end;
  padding-bottom: 17px;
  border-bottom: 1px solid var(--line);
}

.lobby-toolbar-copy {
  display: grid;
  grid-template-columns: auto auto;
  align-items: baseline;
  gap: 5px 13px;
}

.lobby-toolbar-copy h2 {
  font-size: 30px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.lobby-toolbar-copy p {
  grid-column: 2;
  margin: 0;
  color: var(--soft-text);
  font-size: 13px;
}

.lobby-kicker {
  font-family: var(--font-ui);
  color: var(--red-deep);
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}

.lobby-room-count {
  padding-bottom: 3px;
  font-family: var(--font-num);
  color: var(--soft-text);
  font-size: 11px;
  letter-spacing: 0.05em;
}

.lobby-room-grid {
  grid-template-columns: repeat(auto-fill, minmax(274px, 1fr));
  gap: 14px;
}

.lobby-room-card {
  gap: 12px;
  padding: 19px 19px 17px;
  border: 1px solid rgba(58, 45, 29, 0.2);
  border-radius: 2px;
  background: #f7f0e4;
  box-shadow: 3px 3px 0 rgba(69, 51, 30, 0.055);
}

.lobby-room-card:nth-child(3n + 1),
.lobby-room-card:nth-child(3n + 2),
.lobby-room-card:nth-child(3n) {
  transform: none;
}

.lobby-room-card::before {
  width: 3px;
  background: var(--red-deep);
}

.lobby-room-card:hover {
  transform: translateY(-2px);
  border-color: rgba(58, 45, 29, 0.34);
  box-shadow: 4px 5px 0 rgba(69, 51, 30, 0.07);
}

.lobby-create-card {
  display: flex;
  min-height: 188px;
  height: auto;
  padding: 19px 19px 17px;
  flex-direction: column;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  color: var(--ink);
  border: 1px dashed rgba(58, 45, 29, 0.3);
  border-radius: 2px;
  background: transparent;
  box-shadow: none;
}

.lobby-create-card:hover {
  color: var(--ink);
  border-color: rgba(157, 48, 38, 0.5);
  background: transparent;
  transform: translateY(-1px);
}

.lobby-create-card:hover .create-card-mark {
  background: var(--red);
}

.create-card-top {
  display: flex;
  align-items: center;
  gap: 8px;
}

.create-card-mark {
  display: grid;
  place-items: center;
  width: 25px;
  height: 25px;
  flex: 0 0 auto;
  color: #fffaf0;
  background: var(--red-deep);
}

.create-card-mark svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
}

.create-card-top strong {
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: 0.08em;
}

.lobby-create-action {
  width: 108px;
  min-width: 108px;
  height: 36px;
  margin-top: 0;
  padding: 0 12px;
  font-size: 13px;
  box-shadow: 2px 2px 0 var(--ink);
}

.lobby-create-action:hover {
  box-shadow: 3px 3px 0 var(--ink);
}

.game-mark {
  font-size: 13px;
  font-weight: 700;
}

.game-seal {
  width: 25px;
  height: 25px;
  border-radius: 1px;
}

.lobby-room-card[data-game="xiangqi"] .game-seal {
  background: var(--red-deep);
}

.lobby-room-card[data-game="gomoku"] .game-seal {
  background: var(--ink);
}

.room-state {
  border-radius: 1px;
  background: transparent;
  border: 1px solid var(--line);
  color: var(--soft-text);
  letter-spacing: 0.04em;
}

.lobby-room-card h3 {
  font-size: 21px;
  font-weight: 700;
}

.room-facts > div {
  border: 1px solid var(--line-soft);
  border-radius: 1px;
  background: rgba(71, 53, 32, 0.035);
}

.lobby-room-card .room-actions .primary {
  background: var(--red-deep);
}

.lobby-empty {
  display: grid;
  grid-template-columns: minmax(250px, 0.82fr) minmax(360px, 1.18fr);
  align-items: center;
  gap: 42px;
  min-height: 430px;
  padding: 38px 2px 56px;
  overflow: hidden;
  border: 0;
  border-radius: 0;
  background: transparent;
  text-align: left;
}

.lobby-empty::before {
  content: none;
}

.empty-copy {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 15px;
}

.lobby-empty strong {
  font-size: clamp(38px, 4.2vw, 56px);
  font-weight: 700;
  line-height: 1.08;
  letter-spacing: 0.08em;
}

.lobby-empty p {
  max-width: 34ch;
  margin: 0 0 8px;
  color: var(--soft-text);
  font-size: 14px;
  line-height: 1.75;
}

.empty-board-art {
  position: relative;
  top: auto;
  left: auto;
  grid-column: 2;
  grid-row: 1;
  width: min(100%, 510px);
  transform: rotate(-1.2deg);
  stroke: rgba(73, 53, 30, 0.33);
  filter: drop-shadow(9px 12px 0 rgba(72, 52, 29, 0.06));
}

.empty-board-art rect {
  fill: #eadcc5;
}

.empty-board-art .stone.dark {
  fill: rgba(32, 29, 24, 0.68);
}

.empty-board-art .stone.red {
  fill: rgba(157, 48, 38, 0.68);
}

button {
  border-radius: 2px;
  transition:
    transform var(--dur-fast) var(--ease-standard),
    background var(--dur-base) var(--ease-standard),
    box-shadow var(--dur-base) var(--ease-standard),
    border-color var(--dur-base) var(--ease-standard);
}

button:active {
  transform: translate(1px, 1px);
}

button:focus-visible {
  outline: 2px solid var(--red-deep);
  outline-offset: 3px;
}

.primary {
  color: #fffaf0;
  background: var(--red-deep);
  border-color: var(--red-deep);
  box-shadow: 4px 4px 0 var(--ink);
}

.lobby-main .primary {
  color: #fffaf0;
  border-radius: 2px;
  background: var(--red-deep);
  box-shadow: 4px 4px 0 var(--ink);
}

.primary:hover {
  color: #fffaf0;
  background: var(--red);
  box-shadow: 5px 5px 0 var(--ink);
  transform: translate(-1px, -1px);
}

.lobby-main .primary:hover {
  background: var(--red);
  box-shadow: 5px 5px 0 var(--ink);
}

.primary:active {
  box-shadow: 2px 2px 0 var(--ink);
  transform: translate(2px, 2px);
}

.lobby-room-card .room-actions button,
.lobby-main .lobby-create-action {
  box-shadow: 2px 2px 0 var(--ink);
}

.lobby-room-card .room-actions button:hover,
.lobby-main .lobby-create-action:hover {
  box-shadow: 3px 3px 0 var(--ink);
}

.ghost {
  color: var(--ink);
  background: transparent;
  border-color: rgba(48, 38, 26, 0.32);
  box-shadow: none;
}

.lobby-main .ghost {
  border-radius: 2px;
  background: transparent;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}

.ghost:hover {
  background: rgba(255, 250, 239, 0.56);
  border-color: var(--ink);
  box-shadow: none;
  transform: none;
}

.lobby-form-card,
.lobby-settings {
  width: min(900px, 100%);
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.lobby-form-card {
  gap: 28px;
}

.lobby-form-heading {
  position: relative;
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: baseline;
  gap: 7px 16px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--line);
}

.lobby-form-back {
  position: absolute;
  top: 0;
  right: 0;
}

.lobby-form-heading h2,
.settings-head h2 {
  margin: 0;
  font-size: 32px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.lobby-form-heading p {
  grid-column: 2;
  margin: 0;
  color: var(--soft-text);
  font-size: 13px;
}

.lobby-form-grid {
  grid-template-columns: 1fr 1fr;
  gap: 0;
  border-top: 1px solid var(--line-soft);
}

.lobby-form-grid > .field {
  gap: 12px;
  min-width: 0;
  padding: 22px 24px 24px 0;
  border-bottom: 1px solid var(--line-soft);
}

.lobby-form-grid > .field:nth-child(even) {
  padding-right: 0;
  padding-left: 24px;
  border-left: 1px solid var(--line-soft);
}

.lobby-form-grid > .field:last-child {
  grid-column: 2;
  padding-right: 0;
  padding-left: 24px;
  border-left: 1px solid var(--line-soft);
}

.field > span {
  font-family: var(--font-display);
  color: var(--ink);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.1em;
}

.side-pick,
.time-options {
  gap: 0;
  flex-wrap: wrap;
}

.time-option {
  height: 44px;
  padding: 0 16px;
  border: 1px solid rgba(55, 43, 27, 0.25);
  border-radius: 0;
  background: rgba(249, 244, 235, 0.42);
  color: var(--muted-text);
  letter-spacing: 0.02em;
}

.time-option + .time-option {
  margin-left: -1px;
}

.time-option:hover {
  position: relative;
  z-index: 1;
  color: var(--ink);
  border-color: var(--ink);
  background: var(--paper-warm);
}

.side-pick .time-option:hover {
  border-color: var(--ink);
}

.time-option.on,
.side-pick .pick.on {
  position: relative;
  z-index: 2;
  color: #fffaf0;
  background: var(--ink);
  border-color: var(--ink);
  box-shadow: none;
}

.choice-check {
  stroke: currentColor;
}

.game-pick .time-option {
  min-width: 128px;
  justify-content: space-between;
  height: 46px;
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 700;
}

.password-control {
  border-radius: 0;
  background: var(--surface);
  border-color: rgba(48, 38, 26, 0.28);
}

.password-control input {
  height: 38px;
}

.lobby-create {
  grid-column: 1 / -1;
  align-self: flex-end;
  justify-self: end;
  min-width: 176px;
  height: 48px;
  margin-top: 2px;
}

.settings-head {
  justify-content: flex-start;
  gap: 24px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--line);
}

.settings-head h2 {
  font-size: 30px;
}

.settings-grid {
  gap: 0;
  border-top: 1px solid var(--line-soft);
}

.setting-row {
  min-height: 64px;
  padding: 14px 4px;
  border: 0;
  border-bottom: 1px solid var(--line-soft);
  border-radius: 0;
  background: transparent;
}

.setting-row strong {
  font-family: var(--font-display);
  font-size: 15px;
  letter-spacing: 0.06em;
}

.identity-card {
  border-radius: 2px;
  background: rgba(249, 244, 235, 0.48);
  box-shadow: none;
}

.lobby-password,
.notice {
  border-radius: 0;
}

.error {
  border-radius: 0;
}

.workbench:not(.lobby-mode) {
  grid-template-rows: minmax(0, 1fr);
  overflow: hidden;
}

.rail {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 24px;
  min-height: 0;
  padding: 28px 26px 30px;
  overflow: hidden;
  border-right-color: rgba(42, 34, 24, 0.24);
  background-color: #e8decd;
  background-image: repeating-linear-gradient(0deg, transparent 0 3px, rgba(255, 255, 255, 0.04) 3px 4px);
  box-shadow: none;
}

.rail-head {
  gap: 9px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--line);
}

.brand {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: 0.15em;
}

.brand::before {
  width: 6px;
  height: 24px;
  border-radius: 0;
  background: var(--red-deep);
  box-shadow: none;
}

.brand-sub {
  padding-left: 18px;
  font-size: 10px;
  letter-spacing: 0.18em;
}

.panel {
  flex: 1;
  min-height: 0;
  gap: 17px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.panel h2 {
  font-family: var(--font-display);
  font-size: 17px;
  line-height: 1.45;
  letter-spacing: 0.05em;
  color: var(--ink);
}

.room-summary {
  padding-bottom: 21px;
  border-bottom: 1px solid var(--line);
}

.room-summary-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.room-overline {
  color: var(--red-deep);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.2em;
}

.room-phase {
  padding: 4px 8px;
  color: var(--soft-text);
  border: 1px solid var(--line);
  font-size: 10px;
  line-height: 1;
  letter-spacing: 0.06em;
}

.room-phase.phase-playing,
.room-phase.phase-practice {
  color: #fffaf0;
  background: var(--red-deep);
  border-color: var(--red-deep);
}

.room-summary h2 {
  margin: 13px 0 6px;
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 700;
  line-height: 1.35;
  letter-spacing: 0.035em;
  color: var(--ink);
}

.room-meta {
  margin: 0;
  color: var(--soft-text);
  font-size: 12px;
  line-height: 1.5;
  letter-spacing: 0.04em;
}

.room-meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.room-meta-row .room-meta {
  min-width: 0;
}

.room-invite-button {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  gap: 5px;
  height: 32px;
  padding: 0 2px;
  color: var(--red-deep);
  background: transparent;
  border-color: transparent;
  box-shadow: none;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.07em;
  text-decoration-line: underline;
  text-decoration-style: dotted;
  text-decoration-thickness: 1px;
  text-underline-offset: 4px;
  text-decoration-color: rgba(157, 48, 38, 0.28);
  white-space: nowrap;
}

.room-invite-button:hover {
  color: var(--red);
  border-color: transparent;
  background: transparent;
  box-shadow: none;
  text-decoration-color: currentColor;
}

.room-invite-button svg {
  box-sizing: border-box;
  width: 14px;
  height: 14px;
  padding: 0;
  fill: none;
  color: currentColor;
  background: transparent;
  border: 0;
  border-radius: 0;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.82;
}

.room-details {
  display: grid;
  margin: 0;
  padding: 0;
  border-bottom: 1px solid var(--line);
}

.room-details > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 0;
}

.room-details > div + div {
  border-top: 1px solid var(--line-soft);
}

.room-details dt {
  color: var(--soft-text);
  font-size: 10px;
  letter-spacing: 0.12em;
}

.room-details dd {
  margin: 0;
  color: var(--ink);
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 700;
  text-align: right;
}

.spectator-label {
  color: var(--soft-text);
  font-size: 10px;
  letter-spacing: 0.12em;
}

.spectator-names {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.rail-actions {
  align-self: end;
  gap: 8px;
  flex-wrap: nowrap;
  padding-top: 18px;
  border-top: 1px solid var(--line);
}

.rail-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 1 1 0;
  min-width: 0;
  padding-top: 1px;
  padding-inline: 10px;
  line-height: 1;
  white-space: nowrap;
}

.last-move-action.active {
  color: var(--red-deep);
  border-color: rgba(169, 121, 44, 0.58);
  background: rgba(214, 177, 102, 0.14);
}

.rail-actions .ghost {
  background: transparent;
  box-shadow: none;
}

.rail-actions .ghost:not(:disabled):hover {
  background: rgba(83, 64, 40, 0.055);
  border-color: rgba(48, 38, 26, 0.52);
  box-shadow: none;
  transform: none;
}

.rail-actions .ghost:not(:disabled):active {
  background: rgba(83, 64, 40, 0.09);
  transform: translate(1px, 1px);
}

.rail-actions .resign-action,
.rail-actions .room-leave-action {
  color: var(--red-deep);
  border-color: rgba(157, 48, 38, 0.34);
}

.rail-actions .resign-action:not(:disabled):hover,
.rail-actions .room-leave-action:not(:disabled):hover {
  color: var(--red);
  border-color: rgba(157, 48, 38, 0.58);
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.seat {
  padding: 13px 14px;
  border-radius: 1px;
  background: rgba(249, 244, 235, 0.56);
  box-shadow: none;
}

.seat.active {
  border-color: rgba(157, 48, 38, 0.46);
  box-shadow: inset 3px 0 0 var(--red-deep);
  background: rgba(157, 48, 38, 0.045);
}

.seat.empty {
  background: transparent;
}

.seat.partner {
  background: rgba(157, 48, 38, 0.045);
}

.seat-tag {
  font-size: 10px;
  letter-spacing: 0.2em;
}

.seat-name {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 700;
}

.chip {
  height: 26px;
  border: 1px solid rgba(96, 72, 40, 0.2);
  border-radius: 1px;
  background: transparent;
}

.clock-side {
  border-radius: 1px;
  background: rgba(249, 244, 235, 0.55);
}

.clock-side.running {
  border-color: var(--red-deep);
  box-shadow: inset 3px 0 0 var(--red-deep);
}

.move-clock {
  border-radius: 1px;
}

.actions {
  gap: 10px;
}

.actions .primary {
  color: #fffaf0;
}

.toggle .box {
  border-radius: 1px;
}

.toggle input:focus-visible + .box {
  outline: 2px solid var(--red-deep);
}

.room-stage {
  background-color: #e8dece;
  background-image:
    linear-gradient(90deg, rgba(69, 54, 36, 0.035) 1px, transparent 1px),
    linear-gradient(rgba(69, 54, 36, 0.035) 1px, transparent 1px);
  background-size: 52px 52px;
}

.seat-strip {
  justify-content: center;
  gap: 10px;
  min-width: 230px;
  padding: 8px 16px;
  border-radius: 1px;
  background: rgba(248, 242, 231, 0.78);
  box-shadow: none;
}

.seat-strip.active {
  border-color: rgba(157, 48, 38, 0.5);
  box-shadow:
    0 0 0 1px rgba(157, 48, 38, 0.08),
    0 8px 20px rgba(157, 48, 38, 0.11);
  transform: none;
}

.seat-strip.empty {
  background: rgba(248, 242, 231, 0.36);
}

.seat-self {
  padding: 2px 5px;
  color: var(--red-deep);
  border: 1px solid rgba(157, 48, 38, 0.3);
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
}

.seat-strip-clock {
  margin-left: 4px;
}

.canvas-host canvas {
  filter: drop-shadow(0 24px 36px rgba(28, 24, 18, 0.15));
  transform-origin: center;
  transition: transform var(--dur-base) var(--ease-standard);
}

.workbench[data-board-size="compact"] {
  --board-fit: 0.92;
}

.workbench[data-board-size="standard"] {
  --board-fit: 1.05;
}

.workbench[data-board-size="large"] {
  --board-fit: 1.18;
}

.controls {
  border-top-color: rgba(42, 34, 24, 0.2);
  background: rgba(233, 223, 207, 0.9);
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}

.result-banner {
  border-radius: 2px;
  background: rgba(32, 29, 24, 0.96);
}

.mvp {
  background-color: rgba(28, 26, 23, 0.48);
  background-image: none;
}

.mvp-card {
  border-radius: 2px;
  border-color: rgba(157, 48, 38, 0.38);
  background: #f5ecde;
  box-shadow: 8px 8px 0 rgba(34, 28, 20, 0.16);
}

.mvp-badge {
  background: none;
  -webkit-background-clip: initial;
  background-clip: initial;
  color: var(--red-deep);
  filter: none;
  animation: none;
}

.mvp-stats > div {
  border-radius: 1px;
}

.mvp-close {
  border-radius: 1px;
}

.lobby-view {
  animation: none;
}

.floating-message {
  position: fixed;
  top: 40px;
  left: 50%;
  z-index: 120;
  display: flex;
  align-items: center;
  justify-content: center;
  width: max-content;
  max-width: min(560px, calc(100vw - 40px));
  min-height: 44px;
  padding: 10px 20px;
  border: 1px solid rgba(247, 240, 228, 0.18);
  border-radius: 2px;
  background: rgba(32, 29, 24, 0.94);
  box-shadow: 0 10px 28px rgba(28, 26, 23, 0.24);
  text-align: center;
  pointer-events: none;
  transform: translateX(-50%);
}

.workbench:not(.lobby-mode) .floating-message {
  left: calc(50% + 152px);
}

.floating-message span {
  color: var(--on-dark);
  background: transparent;
  font-family: var(--font-ui);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.55;
  letter-spacing: 0.045em;
  text-shadow: none;
}

.floating-message-enter-active,
.floating-message-leave-active {
  transition:
    opacity var(--dur-base) var(--ease-standard),
    transform var(--dur-slow) var(--ease-standard);
}

.floating-message-enter-from {
  opacity: 0;
  transform: translate(-50%, -12px) scale(0.98);
}

.floating-message-leave-to {
  opacity: 0;
  transform: translate(-50%, -8px) scale(0.99);
}

[data-theme="ink"] .lobby-stage,
[data-theme="ink"] .room-stage {
  background-color: #181613;
  background-image:
    linear-gradient(90deg, rgba(236, 222, 199, 0.06) 1px, transparent 1px),
    linear-gradient(rgba(236, 222, 199, 0.06) 1px, transparent 1px),
    repeating-linear-gradient(115deg, transparent 0 22px, rgba(236, 222, 199, 0.018) 22px 23px);
  background-size: 64px 64px, 64px 64px, auto;
}

[data-theme="ink"] .lobby-topbar {
  background: transparent;
  border-bottom-color: rgba(243, 234, 217, 0.22);
}

[data-theme="ink"] .lobby-main,
[data-theme="ink"] .lobby-form-card,
[data-theme="ink"] .lobby-settings,
[data-theme="ink"] .setting-row {
  background: transparent;
}

[data-theme="ink"] .lobby-empty {
  border-color: rgba(243, 234, 217, 0.18);
  background: transparent;
}

[data-theme="ink"] .lobby-stage::after {
  border-color: rgba(243, 234, 217, 0.13);
  background-image:
    repeating-linear-gradient(0deg, transparent 0 55px, rgba(243, 234, 217, 0.1) 55px 56px),
    repeating-linear-gradient(90deg, transparent 0 55px, rgba(243, 234, 217, 0.1) 55px 56px);
  box-shadow: inset 0 0 0 18px rgba(24, 22, 19, 0.12);
}

[data-theme="ink"] .lobby-create-card {
  border-color: rgba(243, 234, 217, 0.28);
}

[data-theme="ink"] .lobby-create-card:hover {
  color: #f3ead9;
  border-color: rgba(239, 139, 127, 0.55);
}

[data-theme="ink"] .lobby-create-card:hover .create-card-mark {
  background: #a64035;
}

[data-theme="ink"] .empty-board-art rect {
  fill: #2b2721;
}

[data-theme="ink"] .rail {
  background-color: #201d18;
  background-image: repeating-linear-gradient(0deg, transparent 0 3px, rgba(255, 255, 255, 0.018) 3px 4px);
}

[data-theme="ink"] .mvp {
  background: rgba(9, 8, 7, 0.7);
}

[data-theme="ink"] .undo-request {
  border-color: rgba(222, 128, 114, 0.34);
  background: rgba(43, 39, 33, 0.8);
  box-shadow: 0 16px 38px rgba(0, 0, 0, 0.3);
}

[data-theme="ink"] .undo-request-copy > span {
  color: #ef9b90;
}

[data-theme="ink"] .undo-request-copy strong {
  color: #f3ead9;
}

[data-theme="ink"] .undo-request-copy p,
[data-theme="ink"] .undo-request-copy small {
  color: #c8bda9;
}

[data-theme="ink"] .room-overline,
[data-theme="ink"] .seat-self,
[data-theme="ink"] .chip.accent,
[data-theme="ink"] .join-prompt-kicker,
[data-theme="ink"] .mvp-badge,
[data-theme="ink"] .mvp-title {
  color: #ef9b90;
}

[data-theme="ink"] .mvp.draw .mvp-title {
  color: #bfd1c1;
  border-color: rgba(154, 186, 160, 0.3);
  background: rgba(154, 186, 160, 0.12);
}

[data-theme="ink"] .join-prompt-error,
[data-theme="ink"] .nickname-settings-error,
[data-theme="ink"] .move-clock.urgent,
[data-theme="ink"] .move-clock.urgent strong,
[data-theme="ink"] .seat-strip-clock.low {
  color: #ffb3a8;
}

[data-theme="ink"] .lock-badge {
  color: #f0a095;
  background: rgba(222, 128, 114, 0.14);
}

[data-theme="ink"] .status-playing .room-state {
  color: #f0a095;
  background: rgba(222, 128, 114, 0.12);
  border-color: rgba(222, 128, 114, 0.34);
}

[data-theme="ink"] .room-invite-button {
  color: #ef9b90;
  background: transparent;
  border-color: transparent;
  box-shadow: none;
  text-decoration-color: rgba(239, 155, 144, 0.34);
}

[data-theme="ink"] .room-invite-button:hover {
  color: #ffb3a8;
  background: transparent;
  border-color: transparent;
  box-shadow: none;
  text-decoration-color: currentColor;
}

[data-theme="ink"] .seat-strip.active .avatar {
  fill: #ef8b7f;
}

[data-theme="ink"] .seat,
[data-theme="ink"] .clock-side,
[data-theme="ink"] .seat-strip,
[data-theme="ink"] .mvp-card {
  background: rgba(43, 39, 33, 0.82);
}

[data-theme="ink"] .primary {
  color: #fffaf0;
  border-color: #b4473c;
  background: #8d2e25;
}

[data-theme="ink"] .lobby-nav button.active .nav-icon {
  stroke: #ef8b7f;
}

[data-theme="ink"] .lobby-nav button.active::after {
  background: #d56559;
}

[data-theme="ink"] .lobby-settings-button {
  color: #d8cebc;
  background: transparent;
  border-color: transparent;
}

[data-theme="ink"] .lobby-settings-button:hover {
  color: #fffaf0;
  background: transparent;
  border-color: transparent;
}

[data-theme="ink"] .lobby-settings-button.active {
  color: #ef9b90;
  background: transparent;
  border-color: transparent;
}

[data-theme="ink"] .lobby-form-back {
  color: #fffaf0;
  background: #98372d;
  border-color: #c85e52;
  box-shadow: 2px 2px 0 #080706;
}

[data-theme="ink"] .lobby-form-back:hover {
  color: #fffaf0;
  background: #aa4338;
  border-color: #df776b;
  box-shadow: 3px 3px 0 #080706;
}

[data-theme="ink"] .lobby-kicker {
  color: #ef8b7f;
}

[data-theme="ink"] .time-option {
  color: #e9dfcf;
  background: rgba(255, 248, 235, 0.055);
  border-color: rgba(243, 234, 217, 0.26);
}

[data-theme="ink"] .time-option:hover {
  color: #fffaf0;
  background: #302b24;
  border-color: #e4d8c5;
}

[data-theme="ink"] .time-option.on,
[data-theme="ink"] .side-pick .pick.on {
  color: #fffaf0;
  background: #98372d;
  border-color: #d76d61;
}

[data-theme="ink"] .nickname-settings-form input {
  color: #f3ead9;
  background: rgba(255, 248, 235, 0.055);
  border-color: rgba(243, 234, 217, 0.26);
}

[data-theme="ink"] .nickname-settings-form input:focus {
  border-color: #e4d8c5;
  box-shadow: inset 0 0 0 1px #e4d8c5;
}

[data-theme="ink"] .nickname-settings-form input.invalid {
  border-color: #de8072;
}

[data-theme="ink"] .nickname-save {
  color: #fffaf0;
  background: #98372d;
  border-color: #d76d61;
}

[data-theme="ink"] .nickname-save:disabled {
  color: #b7ad9d;
  background: rgba(255, 248, 235, 0.055);
  border-color: rgba(243, 234, 217, 0.16);
}

[data-theme="ink"] .choice-check {
  stroke: #fffaf0;
}

[data-theme="ink"] .toggle .box {
  background: #24211c;
  border-color: rgba(243, 234, 217, 0.42);
}

[data-theme="ink"] .toggle input:checked + .box {
  background: #98372d;
  border-color: #c85e52;
}

[data-theme="ink"] .toggle input:checked + .box::after {
  border-color: #fffaf0;
}

[data-theme="ink"] .ghost,
[data-theme="ink"] .lobby-main .ghost {
  color: #f3ead9;
  background: transparent;
  border-color: rgba(243, 234, 217, 0.3);
}

[data-theme="ink"] .ghost:hover,
[data-theme="ink"] .lobby-main .ghost:hover {
  color: #fffaf0;
  background: rgba(255, 248, 235, 0.08);
  border-color: #f3ead9;
}

[data-theme="ink"] .rail-actions .ghost {
  background: transparent;
  box-shadow: none;
}

[data-theme="ink"] .rail-actions .ghost:not(:disabled):hover {
  background: rgba(255, 248, 235, 0.065);
  border-color: rgba(243, 234, 217, 0.68);
  box-shadow: none;
}

[data-theme="ink"] .rail-actions .resign-action,
[data-theme="ink"] .rail-actions .room-leave-action {
  color: #ef9b90;
  border-color: rgba(239, 155, 144, 0.42);
}

[data-theme="ink"] .rail-actions .resign-action:not(:disabled):hover,
[data-theme="ink"] .rail-actions .room-leave-action:not(:disabled):hover {
  color: #ffb3a8;
  border-color: rgba(255, 179, 168, 0.72);
}

[data-theme="ink"] .primary,
[data-theme="ink"] .lobby-main .primary {
  color: #fffaf0;
  background: #98372d;
  border-color: #c85e52;
  box-shadow: 4px 4px 0 #080706;
}

[data-theme="ink"] .primary:hover,
[data-theme="ink"] .lobby-main .primary:hover {
  color: #fffaf0;
  background: #aa4338;
  box-shadow: 5px 5px 0 #080706;
}

[data-theme="ink"] .lobby-room-card .room-actions button,
[data-theme="ink"] .lobby-main .lobby-create-action {
  box-shadow: 2px 2px 0 #080706;
}

[data-theme="ink"] .lobby-room-card .room-actions button:hover,
[data-theme="ink"] .lobby-main .lobby-create-action:hover {
  box-shadow: 3px 3px 0 #080706;
}

[data-theme="ink"] button:disabled {
  opacity: 0.62;
}

[data-theme="ink"] .room-state,
[data-theme="ink"] .room-stats,
[data-theme="ink"] .lobby-form-heading p,
[data-theme="ink"] .lobby-toolbar-copy p,
[data-theme="ink"] .settings-head > span {
  color: #c8bda9;
}

[data-theme="ink"] .notice {
  color: #e6c88f;
  background: rgba(212, 162, 74, 0.11);
}

[data-theme="ink"] .error {
  color: #ffb3a8;
  background: rgba(176, 58, 46, 0.17);
  border-left-color: #d56559;
}

[data-theme="ink"] .mvp-card {
  background: #2b2721;
  border-color: rgba(222, 128, 114, 0.42);
}

[data-theme="ink"] .mvp-eyebrow,
[data-theme="ink"] .mvp-stats dt,
[data-theme="ink"] .mvp-reason {
  color: rgba(243, 234, 217, 0.72);
}

[data-theme="ink"] .mvp-name {
  color: #f3ead9;
}

[data-theme="ink"] .mvp-close {
  color: rgba(243, 234, 217, 0.62);
}

[data-theme="ink"] .mvp-close:hover {
  color: #f3ead9;
  background: rgba(255, 248, 235, 0.08);
}

[data-theme="ink"] .mvp-stats > div {
  background: rgba(255, 248, 235, 0.07);
}

@media (min-width: 901px) {
  .workbench:not(.lobby-mode) {
    grid-template-columns: 304px minmax(0, 1fr);
  }

  .workbench:not(.lobby-mode) > .rail {
    grid-column: 1;
    grid-row: 1;
  }

  .workbench:not(.lobby-mode) > .stage {
    grid-column: 2;
    grid-row: 1;
    padding-bottom: 70px;
    background-color: #e8dece;
    background-image:
      linear-gradient(90deg, rgba(69, 54, 36, 0.035) 1px, transparent 1px),
      linear-gradient(rgba(69, 54, 36, 0.035) 1px, transparent 1px);
    background-size: 52px 52px;
  }

  .workbench:not(.lobby-mode) > .rail-actions {
    position: fixed;
    right: 0;
    bottom: 8px;
    left: 304px;
    z-index: 20;
    justify-content: center;
    flex-direction: row;
    flex-wrap: nowrap;
    width: auto;
    padding: 8px 12px;
    border-top: 1px solid var(--line-soft);
    gap: 8px;
  }

  .workbench:not(.lobby-mode) > .rail-actions button {
    flex: 0 1 110px;
    width: 110px;
    min-height: 44px;
    padding-inline: 12px;
    font-size: 13px;
  }
}

/* Wide, short windows make the 16:9 scene height-constrained before its width is used.
   Cap the canvas by viewport height so the paper frame stays inside its host while keeping
   a distinct size for each board option. */
@media (min-width: 901px) and (min-aspect-ratio: 7/4) {
  .workbench[data-board-size="compact"]:not(.lobby-mode) .canvas-host canvas {
    max-height: 68vh;
  }

  .workbench[data-board-size="standard"]:not(.lobby-mode) .canvas-host canvas {
    max-height: 76vh;
  }

  .workbench[data-board-size="large"]:not(.lobby-mode) .canvas-host canvas {
    max-height: 80vh;
  }
}

@media (max-width: 1040px) {
  .lobby-topbar {
    gap: 20px;
  }

  .lobby-nav {
    gap: 14px;
  }

  .lobby-empty {
    grid-template-columns: minmax(230px, 0.9fr) minmax(300px, 1.1fr);
    gap: 24px;
    padding: 36px;
  }
}

@media (max-width: 900px) {
  .workbench:not(.lobby-mode) {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }

  .workbench:not(.lobby-mode) .stage {
    padding-bottom: calc(70px + env(safe-area-inset-bottom, 0px));
  }

  .workbench:not(.lobby-mode) .floating-message {
    left: 50%;
  }

  .undo-request {
    left: 50%;
    top: 76px;
  }

  .lobby-screen {
    gap: 14px;
    padding: 14px 20px 36px;
  }

  .lobby-topbar {
    grid-template-columns: 1fr auto;
    grid-template-areas:
      "brand settings"
      "account account";
    gap: 14px 20px;
    padding: 14px 0 12px;
    border-radius: 0;
  }

  .lobby-brand {
    grid-area: brand;
  }

  .lobby-nav {
    grid-column: 1 / -1;
    grid-row: 2;
    justify-self: stretch;
    justify-content: flex-start;
    gap: 22px;
    border-top: 1px solid var(--line-soft);
  }

  .lobby-nav button {
    height: 44px;
  }

  .lobby-nav button::after {
    bottom: -1px;
  }

  .lobby-account {
    grid-area: account;
    grid-template-areas: "profile meta";
    grid-template-columns: minmax(0, 1fr) auto;
    width: 100%;
    padding-top: 10px;
    border-top: 1px solid var(--line-soft);
    margin-left: 0;
  }

  .account-profile {
    grid-area: profile;
    justify-content: flex-start;
  }

  .account-meta {
    grid-area: meta;
    justify-content: flex-end;
  }

  .lobby-settings-button {
    grid-area: settings;
    align-self: center;
  }

  .lobby-main {
    padding-top: 16px;
  }

  .lobby-empty {
    grid-template-columns: 1fr;
    gap: 30px;
    min-height: 0;
    padding: 30px 0 44px;
  }

  .lobby-empty::before {
    font-size: 220px;
  }

  .empty-copy {
    grid-row: 1;
  }

  .empty-board-art {
    grid-column: 1;
    grid-row: 2;
    justify-self: end;
    width: min(390px, 78%);
  }

  .lobby-form-card,
  .lobby-settings {
    width: 100%;
  }

  .lobby-form-grid > .field,
  .lobby-form-grid > .field:nth-child(even),
  .lobby-form-grid > .field:last-child {
    grid-column: 1;
    padding: 20px 0;
    border-left: 0;
  }

  .workbench:not(.lobby-mode) .rail {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-rows: auto minmax(0, 1fr) auto;
    gap: 12px 18px;
    max-height: min(310px, 42dvh);
    padding: 14px 18px;
    border-bottom: 1px solid var(--line);
  }

  .workbench:not(.lobby-mode) .rail-head {
    grid-column: 1 / -1;
    padding-bottom: 10px;
  }

  .workbench:not(.lobby-mode) .panel {
    grid-column: 1;
    grid-row: 2;
    overflow-y: auto;
  }

  .workbench:not(.lobby-mode) .rail-actions {
    position: fixed;
    right: 0;
    bottom: 8px;
    left: 0;
    z-index: 20;
    justify-content: center;
    flex-direction: row;
    flex-wrap: nowrap;
    width: 100%;
    padding: 8px 12px calc(8px + env(safe-area-inset-bottom, 0px));
    border-top: 1px solid var(--line-soft);
    gap: 8px;
  }

  .workbench:not(.lobby-mode) .rail-actions button {
    flex: 0 1 auto;
    min-height: 44px;
    padding-inline: 12px;
    font-size: 12px;
  }
}

@media (max-width: 620px) {
  .undo-request {
    top: 68px;
    align-items: stretch;
    flex-direction: column;
    gap: 12px;
    padding: 14px;
  }

  .undo-request-actions button {
    flex: 1;
  }

  .workbench:not(.lobby-mode) {
    grid-template-rows: auto minmax(0, 1fr);
    height: 100dvh;
    --mobile-board-height: 1.12;
    --mobile-board-width-guard: 0.79;
  }

  .workbench:not(.lobby-mode) .stage {
    padding-bottom: calc(70px + env(safe-area-inset-bottom, 0px));
  }

  .workbench[data-game="gomoku"]:not(.lobby-mode) {
    --mobile-board-width-guard: 0.895;
  }

  .workbench[data-board-size="compact"]:not(.lobby-mode) {
    --mobile-board-height: 1.04;
  }

  .workbench[data-board-size="large"]:not(.lobby-mode) {
    --mobile-board-height: 1.16;
  }

  .workbench:not(.lobby-mode) .rail {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto auto;
    grid-template-areas:
      "head"
      "panel"
      "actions";
    gap: 6px 10px;
    max-height: none;
    padding: 8px 12px 10px;
    overflow: visible;
  }

  .workbench:not(.lobby-mode) .rail-head {
    grid-area: head;
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: flex-start;
    gap: 8px;
    min-width: 0;
    padding: 0;
    border-bottom: 0;
  }

  .workbench:not(.lobby-mode) .brand {
    gap: 8px;
    overflow: hidden;
    font-size: 16px;
    letter-spacing: 0.1em;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .workbench:not(.lobby-mode) .brand::before {
    width: 5px;
    height: 16px;
  }

  .workbench:not(.lobby-mode) .brand-sub {
    display: none;
  }

  .workbench:not(.lobby-mode) .panel {
    grid-area: panel;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      "summary"
      "details"
      "spectators"
      "clock";
    gap: 3px;
    min-width: 0;
    overflow: visible;
    scrollbar-gutter: auto;
  }

  .workbench:not(.lobby-mode) .room-summary {
    grid-area: summary;
    padding: 0 0 5px;
    border-bottom: 1px solid var(--line);
  }

  .workbench:not(.lobby-mode) .room-summary-meta {
    justify-content: flex-start;
    gap: 8px;
  }

  .workbench:not(.lobby-mode) .room-overline {
    font-size: 9px;
    letter-spacing: 0.14em;
  }

  .workbench:not(.lobby-mode) .room-phase {
    padding: 3px 6px;
    font-size: 9px;
  }

  .workbench:not(.lobby-mode) .room-summary h2 {
    margin: 3px 0 2px;
    overflow: hidden;
    font-size: 16px;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .workbench:not(.lobby-mode) .room-meta {
    overflow: hidden;
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .workbench:not(.lobby-mode) .room-invite-button {
    height: 32px;
    padding-inline: 2px;
  }

  .workbench:not(.lobby-mode) .room-details {
    grid-area: details;
    grid-template-columns: 1fr 1fr;
    align-self: center;
    border-bottom: 0;
  }

  .workbench:not(.lobby-mode) .room-details > div {
    align-items: baseline;
    justify-content: center;
    flex-direction: row;
    gap: 8px;
    padding: 5px 8px;
    text-align: center;
  }

  .workbench:not(.lobby-mode) .room-details > div + div {
    border-top: 0;
    border-left: 1px solid var(--line-soft);
  }

  .workbench:not(.lobby-mode) .room-details dt {
    font-size: 9px;
    letter-spacing: 0.05em;
    white-space: nowrap;
  }

  .workbench:not(.lobby-mode) .room-details dd {
    font-size: 12px;
    text-align: center;
    white-space: nowrap;
  }

  .workbench:not(.lobby-mode) .spectators {
    grid-area: spectators;
    align-self: center;
    flex-wrap: nowrap;
    width: 100%;
    min-width: 0;
    gap: 6px;
    padding: 3px 0;
  }

  .workbench:not(.lobby-mode) .spectator-label {
    flex: 0 0 auto;
    font-size: 9px;
    white-space: nowrap;
  }

  .workbench:not(.lobby-mode) .spectator-names {
    flex: 1;
    min-width: 0;
    flex-wrap: nowrap;
    margin: 0;
    padding: 2px 0;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
  }

  .workbench:not(.lobby-mode) .spectator-names::-webkit-scrollbar {
    display: none;
  }

  .workbench:not(.lobby-mode) .chip {
    height: 24px;
    padding-inline: 8px;
    font-size: 10px;
    white-space: nowrap;
  }

  .workbench:not(.lobby-mode) .move-clock {
    grid-area: clock;
    justify-self: end;
  }

  .workbench:not(.lobby-mode) .rail-actions {
    grid-area: actions;
    align-self: stretch;
    position: fixed;
    right: 0;
    bottom: 8px;
    left: 0;
    z-index: 20;
    justify-content: center;
    flex-direction: row;
    flex-wrap: nowrap;
    width: 100%;
    padding: 8px 12px calc(8px + env(safe-area-inset-bottom, 0px));
    border-top: 1px solid var(--line-soft);
    gap: 8px;
  }

  .workbench:not(.lobby-mode) .rail-actions button {
    flex: 0 1 auto;
    min-height: 44px;
    padding-inline: 12px;
    font-size: 12px;
  }

  .workbench:not(.lobby-mode) .toggle {
    min-height: 34px;
  }

  .workbench:not(.lobby-mode) .board-col {
    position: relative;
    gap: 0;
    padding: 4px 8px 8px;
  }

  .workbench:not(.lobby-mode) .seat-strip {
    position: absolute;
    left: 50%;
    z-index: 2;
    grid-area: auto;
    gap: 7px;
    width: max-content;
    max-width: calc(100vw - 48px);
    min-width: 0;
    min-height: 38px;
    padding: 2px 4px;
    overflow: visible;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
    transform: translate(-50%, -50%);
  }

  .workbench:not(.lobby-mode) .seat-strip.far {
    top: var(--seat-far-top, 12%);
  }

  .workbench:not(.lobby-mode) .seat-strip.near {
    top: var(--seat-near-top, 88%);
  }

  .workbench:not(.lobby-mode) .seat-strip::before {
    display: none;
  }

  .workbench:not(.lobby-mode) .seat-strip.active {
    border: 0;
    box-shadow: none;
  }

  .workbench:not(.lobby-mode) .seat-strip.mine {
    background: transparent;
  }

  .workbench:not(.lobby-mode) .seat-strip.empty {
    border: 0;
    background: transparent;
    box-shadow: none;
  }

  .workbench:not(.lobby-mode) .seat-strip.empty::before {
    display: none;
  }

  .workbench:not(.lobby-mode) .avatar {
    width: 26px;
    height: 30px;
    padding: 3px;
    border: 1px solid rgba(92, 73, 49, 0.16);
    border-radius: 50%;
    background: rgba(255, 252, 246, 0.7);
  }

  .workbench:not(.lobby-mode) .seat-panel-tag {
    padding: 4px 7px;
    border: 1px solid rgba(91, 72, 47, 0.2);
    border-radius: 4px;
    background: rgba(255, 251, 243, 0.52);
    font-size: 10px;
    line-height: 1;
    letter-spacing: 0.08em;
  }

  .workbench:not(.lobby-mode) .seat-panel-name {
    min-width: 0;
    font-size: 14px;
    font-weight: 700;
  }

  .workbench:not(.lobby-mode) .seat-self {
    padding: 3px 6px;
    color: #fffaf0;
    border-color: var(--red-deep);
    border-radius: 3px;
    background: var(--red-deep);
  }

  .workbench:not(.lobby-mode) .seat-strip-clock {
    margin-left: auto;
    padding: 2px 0 2px 10px;
    border-left: 1px solid rgba(91, 72, 47, 0.2);
    font-size: 14px;
  }

  [data-theme="ink"] .workbench:not(.lobby-mode) .seat-strip {
    border: 0;
    background: transparent;
    box-shadow: none;
  }

  [data-theme="ink"] .workbench:not(.lobby-mode) .seat-strip::before {
    display: none;
  }

  [data-theme="ink"] .workbench:not(.lobby-mode) .seat-strip.active {
    border: 0;
    box-shadow: none;
  }

  [data-theme="ink"] .workbench:not(.lobby-mode) .seat-strip.active::before {
    display: none;
  }

  [data-theme="ink"] .workbench:not(.lobby-mode) .seat-strip.mine {
    background: transparent;
  }

  [data-theme="ink"] .workbench:not(.lobby-mode) .seat-strip.empty {
    border: 0;
    background: transparent;
  }

  [data-theme="ink"] .workbench:not(.lobby-mode) .avatar {
    border-color: rgba(243, 234, 217, 0.14);
    background: rgba(255, 248, 235, 0.05);
  }

  [data-theme="ink"] .workbench:not(.lobby-mode) .seat-panel-tag {
    border-color: rgba(243, 234, 217, 0.17);
    background: rgba(255, 248, 235, 0.05);
  }

  [data-theme="ink"] .workbench:not(.lobby-mode) .seat-self {
    border-color: #b4473c;
    background: #8d2e25;
  }

  [data-theme="ink"] .workbench:not(.lobby-mode) .seat-strip-clock {
    border-left-color: rgba(243, 234, 217, 0.15);
  }

  .workbench:not(.lobby-mode) .canvas-host {
    position: relative;
    container-type: size;
    width: 100%;
    min-width: 0;
    padding: 0;
    overflow: hidden;
  }

  /* Fit the 16:9 scene by height. The board is centred inside the scene, so the
     unused side margins are clipped while the whole board remains visible. */
  .workbench:not(.lobby-mode) .canvas-host canvas {
    position: absolute;
    top: 50%;
    left: 50%;
    width: auto !important;
    height: 100% !important;
    height: min(
      calc(100cqh * var(--mobile-board-height)),
      calc(100cqw / var(--mobile-board-width-guard))
    ) !important;
    max-width: none !important;
    max-height: none !important;
    transform: translate(-50%, -50%);
  }

  .lobby-screen {
    padding-inline: 14px;
  }

  .lobby-topbar {
    gap: 10px;
  }

  .lobby-brand h1 {
    font-size: 21px;
  }

  .lobby-brand-note {
    font-size: 9px;
  }

  .lobby-account {
    gap: 4px 8px;
  }

  .guest-name {
    display: block;
    max-width: 100%;
    overflow: hidden;
    font-size: 15px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .account-profile {
    gap: 6px;
  }

  .setting-nickname-row {
    align-items: stretch;
    flex-direction: column;
    gap: 10px;
  }

  .setting-nickname-row .setting-copy {
    padding-top: 0;
  }

  .nickname-settings-control {
    align-self: flex-start;
    width: min(248px, 100%);
    flex-basis: auto;
  }

  .connection-state {
    padding-left: 6px;
    font-size: 10px;
  }

  .lobby-population {
    gap: 4px;
    padding-left: 6px;
  }

  .lobby-population-label,
  .lobby-population-unit {
    display: none;
  }

  .lobby-settings-button {
    width: auto;
    min-width: 78px;
    height: 44px;
    padding: 0 10px;
    margin-left: 0;
    font-size: 12px;
  }

  .lobby-nav {
    justify-content: space-between;
    gap: 4px;
  }

  .lobby-nav button {
    padding-inline: 2px;
    font-size: 13px;
  }

  .nav-icon {
    width: 19px;
    height: 19px;
    margin-right: 5px;
  }

  .lobby-toolbar {
    align-items: flex-start;
  }

  .lobby-toolbar-copy {
    grid-template-columns: 1fr;
  }

  .lobby-toolbar-copy h2 {
    font-size: 25px;
  }

  .lobby-toolbar-copy p {
    grid-column: 1;
  }

  .lobby-room-count {
    margin-top: 22px;
  }

  .lobby-room-grid {
    grid-template-columns: 1fr;
  }

  .lobby-empty {
    padding: 24px 0 40px;
  }

  .lobby-empty strong {
    font-size: 36px;
  }

  .empty-board-art {
    width: 100%;
  }

  .lobby-form-heading {
    grid-template-columns: 1fr;
  }

  .lobby-form-heading p {
    grid-column: 1;
  }

  .lobby-form-grid {
    grid-template-columns: 1fr;
  }

  .lobby-form-grid > .field,
  .lobby-form-grid > .field:nth-child(even) {
    grid-column: 1;
    padding: 20px 0;
    border-left: 0;
  }

  .game-pick .time-option {
    min-width: 0;
    flex: 1;
  }

  .lobby-create {
    justify-self: stretch;
    width: 100%;
  }
}

</style>
