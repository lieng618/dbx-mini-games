/**
 * Cloud bridge for the DBX Mini Games workbench.
 *
 * The plugin is frontend-only. Browsers use the compact JSON WebSocket protocol. DBX only
 * exposes HTTPS origins to the plugin CSP, so the workbench uses HTTPS long polling there.
 */

const REQUEST_TIMEOUT_MS = 12_000;
const CLIENT_ID_KEY = "dbxmg.clientId";
const NICKNAME_KEY = "dbxmg.nickname";

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

  const configured =
    typeof __DBX_GAME_SERVER_URL__ === "string" ? __DBX_GAME_SERVER_URL__.trim() : "";
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  throw new Error("游戏服务器地址未配置");
}

class CloudBridge {
  constructor() {
    this.live = true;
    this.socket = null;
    this.connected = false;
    this.pollController = null;
    this.usePolling = hasHost();
    this.pending = new Map();
    this.listeners = new Set();
    this.connectionListeners = new Set();
    this.requestSeq = 0;
    this.retryTimer = null;
    this.retryDelay = 500;
    this.recoveryPromise = null;
    this.manualClose = false;
    const developmentParams = new URLSearchParams(window.location.search);
    const requestedClientId = developmentParams.get("clientId");
    this.ephemeralIdentity = Boolean(requestedClientId);
    this.clientId = requestedClientId || loadOrCreateClientId();
    this.nickname = loadStoredNickname() || randomNickname();
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
    if (this.connected) return Promise.resolve();
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
        connected: this.connected,
        serverUrl: this.serverUrl,
      }),
    );
    return () => this.connectionListeners.delete(handler);
  }

  connect() {
    if (this.manualClose) return;
    clearTimeout(this.retryTimer);
    if (this.usePolling) {
      void this.connectPolling();
      return;
    }
    if (this.socket?.readyState === WebSocket.CONNECTING) return;
    const url = new URL(this.serverUrl);
    url.searchParams.set("clientId", this.clientId);
    url.searchParams.set("nickname", this.nickname);

    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.retryDelay = 500;
      this.connected = true;
      this.resolveReady?.();
      this.resolveReady = null;
      this.rejectReady = null;
      this.emitConnection({ connected: true, serverUrl: this.serverUrl });
    });
    socket.addEventListener("message", (event) => {
      if (this.socket === socket) this.handleMessage(event.data);
    });
    socket.addEventListener("close", () => {
      // A replacement socket can already be connected when an old socket finishes closing.
      // Its late close event must not mark the new connection offline.
      if (this.socket !== socket) return;
      this.socket = null;
      this.connected = false;
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

  async connectPolling() {
    if (this.manualClose || this.pollController) return;
    const controller = new AbortController();
    this.pollController = controller;
    const base = apiBase(this.serverUrl);
    try {
      const response = await fetchWithTimeout(new URL("connect", base), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: this.clientId, nickname: this.nickname }),
        signal: controller.signal,
      }, REQUEST_TIMEOUT_MS);
      const session = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(session.error || "无法建立云端会话");
      if (controller.signal.aborted || this.pollController !== controller) return;

      if (session.clientId) this.clientId = session.clientId;
      if (session.nickname) this.rememberNickname(session.nickname);
      if (!this.ephemeralIdentity) persistClientId(this.clientId);
      this.retryDelay = 500;
      this.connected = true;
      this.resolveReady?.();
      this.resolveReady = null;
      this.rejectReady = null;
      this.emitConnection({ connected: true, serverUrl: this.serverUrl });
      void this.pollEvents(controller, base);
    } catch (error) {
      if (!controller.signal.aborted) this.connectionLost(error);
    }
  }

  async pollEvents(controller, base) {
    try {
      while (!this.manualClose && this.pollController === controller) {
        const url = new URL("events", base);
        url.searchParams.set("clientId", this.clientId);
        const response = await fetch(url, { signal: controller.signal });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "云端事件连接已断开");
        for (const event of payload.events || []) this.handleEvent(event);
      }
    } catch (error) {
      if (!controller.signal.aborted) this.connectionLost(error);
    }
  }

  connectionLost() {
    this.pollController = null;
    this.connected = false;
    if (!this.resolveReady) this.readyPromise = null;
    this.emitConnection({ connected: false, serverUrl: this.serverUrl });
    if (!this.manualClose) {
      this.retryTimer = setTimeout(() => this.connect(), this.retryDelay);
      this.retryDelay = Math.min(10_000, this.retryDelay * 2);
    }
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    this.handleEvent(message);
  }

  handleEvent(message) {
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
      if (message.params?.nickname) this.rememberNickname(message.params.nickname);
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
    let result;
    try {
      result = await this.invokeOnce(method, params);
    } catch (error) {
      if (this.manualClose || !isSessionExpiredError(error)) throw error;
      await this.recoverSession();
      result = await this.invokeOnce(method, params);
    }
    if (method === "profile.save" && result?.nickname) {
      this.rememberNickname(result.nickname);
    }
    return result;
  }

  async invokeOnce(method, params = {}) {
    if (this.usePolling) {
      const base = apiBase(this.serverUrl);
      const response = await fetchWithTimeout(new URL("request", base), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: this.clientId,
          method,
          params: params || {},
        }),
      }, REQUEST_TIMEOUT_MS);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.error) {
        throw new Error(payload.error || "云端请求失败");
      }
      return payload.result;
    }
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

  async recoverSession() {
    if (this.recoveryPromise) return this.recoveryPromise;
    this.recoveryPromise = (async () => {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      if (this.usePolling) {
        const controller = this.pollController;
        this.pollController = null;
        controller?.abort();
      } else {
        const socket = this.socket;
        this.socket = null;
        socket?.close();
      }
      this.connected = false;
      this.readyPromise = null;
      this.resolveReady = null;
      this.rejectReady = null;
      this.retryDelay = 500;
      this.emitConnection({ connected: false, serverUrl: this.serverUrl });
      this.connect();
      await this.ready();
    })().finally(() => {
      this.recoveryPromise = null;
    });
    return this.recoveryPromise;
  }

  close() {
    this.manualClose = true;
    clearTimeout(this.retryTimer);
    this.pollController?.abort();
    this.pollController = null;
    this.socket?.close();
    this.socket = null;
  }

  rememberNickname(nickname) {
    const value = String(nickname || "").trim();
    if (!value) return;
    this.nickname = value;
    persistNickname(value);
  }
}

function isSessionExpiredError(error) {
  const message = String(error?.message || error || "");
  return (
    message.includes("session is not connected") ||
    message.includes("session was replaced by a newer connection") ||
    message.includes("poll session does not exist")
  );
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const externalSignal = options?.signal;
  const abortFromExternal = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", abortFromExternal, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && !externalSignal?.aborted) {
      throw new Error("云端请求超时，请检查网络后重试");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

function apiBase(serverUrl) {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "wss:" || url.protocol === "https:" ? "https:" : "http:";
  url.pathname = "/api/";
  url.search = "";
  url.hash = "";
  return url;
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

function loadStoredNickname() {
  try {
    const stored = localStorage.getItem(NICKNAME_KEY)?.trim();
    if (stored && stored.length <= 64) return stored;
  } catch {}
  return "";
}

function persistNickname(nickname) {
  try {
    localStorage.setItem(NICKNAME_KEY, nickname);
  } catch {}
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
