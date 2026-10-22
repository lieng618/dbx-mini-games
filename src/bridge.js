/**
 * Cloud bridge for the DBX Mini Games workbench.
 *
 * The plugin is frontend-only. It talks to the public Go service directly over a compact
 * JSON WebSocket protocol; no local native sidecar is started by DBX.
 */

const REQUEST_TIMEOUT_MS = 12_000;
const CLIENT_ID_KEY = "dbxmg.clientId";

let singleton = null;

export function hasHost() {
  return typeof window !== "undefined" && !!window.dbxPlugin;
}

export async function whenReady() {
  if (hasHost()) {
    try {
      await window.dbxPlugin.ready;
    } catch {
      // The cloud connection is independent of host readiness.
    }
  }
  return null;
}

export function createBridge() {
  if (!singleton) singleton = new CloudBridge();
  return singleton;
}

export function resolveServerUrl() {
  const override = typeof window !== "undefined" ? window.__DBX_MINI_GAMES_SERVER__ : undefined;
  if (typeof override === "string" && override.trim()) return override.trim();

  const localConfigured =
    typeof __DBX_LOCAL_GAME_SERVER_URL__ === "string" ? __DBX_LOCAL_GAME_SERVER_URL__ : "";
  if (localConfigured && typeof window !== "undefined") {
    const local = new URL(localConfigured);
    const localPort = local.port || (local.protocol === "https:" ? "443" : "80");
    if (window.location.port === localPort) {
      const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
      return `${scheme}//${window.location.host}${local.pathname}`;
    }
  }

  const configured =
    typeof __DBX_GAME_SERVER_URL__ === "string" ? __DBX_GAME_SERVER_URL__.trim() : "";
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  throw new Error("游戏服务器地址未配置");
}

class CloudBridge {
  constructor() {
    this.live = true;
    this.socket = null;
    this.pending = new Map();
    this.listeners = new Set();
    this.connectionListeners = new Set();
    this.requestSeq = 0;
    this.retryTimer = null;
    this.retryDelay = 500;
    this.manualClose = false;
    const developmentParams = new URLSearchParams(window.location.search);
    const requestedClientId = developmentParams.get("clientId");
    this.ephemeralIdentity = Boolean(requestedClientId);
    this.clientId = requestedClientId || loadOrCreateClientId();
    this.nickname = randomNickname();
    this.readyPromise = null;
    this.resolveReady = null;
    this.rejectReady = null;
    this.serverUrl = resolveServerUrl();
    this.connect();
  }

  locale() {
    return window.dbxPlugin?.locale || navigator.language || "zh-CN";
  }

  ready() {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (!this.readyPromise) {
      this.readyPromise = new Promise((resolve, reject) => {
        this.resolveReady = resolve;
        this.rejectReady = reject;
      });
    }
    return this.readyPromise;
  }

  on(handler) {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  onConnection(handler) {
    this.connectionListeners.add(handler);
    queueMicrotask(() =>
      handler({
        connected: this.socket?.readyState === WebSocket.OPEN,
        serverUrl: this.serverUrl,
      }),
    );
    return () => this.connectionListeners.delete(handler);
  }

  connect() {
    if (this.manualClose || this.socket?.readyState === WebSocket.CONNECTING) return;
    clearTimeout(this.retryTimer);
    const url = new URL(this.serverUrl);
    url.searchParams.set("clientId", this.clientId);
    url.searchParams.set("nickname", this.nickname);

    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.retryDelay = 500;
      this.resolveReady?.();
      this.resolveReady = null;
      this.rejectReady = null;
      this.emitConnection({ connected: true, serverUrl: this.serverUrl });
    });
    socket.addEventListener("message", (event) => this.handleMessage(event.data));
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = null;
      if (!this.resolveReady) this.readyPromise = null;
      const error = new Error("云端连接已断开");
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.emitConnection({ connected: false, serverUrl: this.serverUrl });
      if (!this.manualClose) {
        this.retryTimer = setTimeout(() => this.connect(), this.retryDelay);
        this.retryDelay = Math.min(10_000, this.retryDelay * 2);
      }
    });
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.type === "response") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message || "云端请求失败"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.type !== "event") return;

    if (message.method === "session.ready") {
      if (message.params?.clientId) this.clientId = message.params.clientId;
      if (message.params?.nickname) this.nickname = message.params.nickname;
      if (!this.ephemeralIdentity) persistClientId(this.clientId);
    }
    for (const listener of this.listeners) {
      try {
        listener({ method: message.method, params: message.params || {} });
      } catch {
        // One broken listener must not block the remaining subscribers.
      }
    }
  }

  emitConnection(state) {
    for (const listener of this.connectionListeners) {
      try {
        listener(state);
      } catch {}
    }
  }

  async invoke(method, params = {}) {
    await this.ready();
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("尚未连接到游戏服务器");
    }
    const id = `r${++this.requestSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("云端请求超时"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(
        JSON.stringify({
          type: "request",
          id,
          method,
          params: params || {},
        }),
      );
    });
  }

  close() {
    this.manualClose = true;
    clearTimeout(this.retryTimer);
    this.socket?.close();
    this.socket = null;
  }
}

function loadOrCreateClientId() {
  try {
    const stored = localStorage.getItem(CLIENT_ID_KEY);
    if (stored && /^[A-Za-z0-9_-]{8,64}$/.test(stored)) return stored;
    const created = crypto.randomUUID();
    localStorage.setItem(CLIENT_ID_KEY, created);
    return created;
  } catch {
    return `guest-${Math.random().toString(36).slice(2, 12)}`;
  }
}

function randomNickname() {
  const adjectives = ["青竹", "听雨", "临风", "知秋", "观澜", "云舟", "松间", "逐月"];
  const bytes = new Uint32Array(2);
  crypto.getRandomValues(bytes);
  const adjective = adjectives[bytes[0] % adjectives.length];
  const suffix = String(bytes[1] % 10_000).padStart(4, "0");
  return `${adjective}-${suffix}`;
}

function persistClientId(clientId) {
  try {
    localStorage.setItem(CLIENT_ID_KEY, clientId);
  } catch {}
}
