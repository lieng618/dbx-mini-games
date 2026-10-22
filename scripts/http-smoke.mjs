const origin = process.env.DBX_MINI_GAMES_HTTP_ORIGIN || "https://1.92.64.227";

async function json(path, init = {}) {
  const response = await fetch(`${origin}${path}`, init);
  const payload = await response.json();
  if (!response.ok || payload.error) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

const suffix = Date.now();
const session = await json("/api/connect", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    clientId: `http-smoke-${suffix}`,
    nickname: "HTTP 测试",
  }),
});

const initialEvents = await json(`/api/events?clientId=${encodeURIComponent(session.clientId)}`);
if (!initialEvents.events.some((event) => event.method === "session.ready")) {
  throw new Error("session.ready event was not delivered");
}

await json("/api/request", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    clientId: session.clientId,
    method: "lobby.subscribe",
    params: {},
  }),
});
const lobbyEvents = await json(`/api/events?clientId=${encodeURIComponent(session.clientId)}`);
if (!lobbyEvents.events.some((event) => event.method === "lobby.updated")) {
  throw new Error("lobby.updated event was not delivered");
}

const created = await json("/api/request", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    clientId: session.clientId,
    method: "room.create",
    params: {
      name: "HTTP 验收房",
      game: "gomoku",
      minutes: 0,
      moveSeconds: 0,
      seat: 0,
    },
  }),
});
if (created.result?.role !== "host" || !created.result?.roomId) {
  throw new Error("HTTP room.create did not return a host room");
}

console.log(
  JSON.stringify(
    {
      ok: true,
      clientId: session.clientId,
      roomId: created.result.roomId,
      events: ["session.ready", "lobby.updated"],
    },
    null,
    2,
  ),
);
