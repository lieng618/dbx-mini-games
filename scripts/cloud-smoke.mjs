const server = process.env.DBX_MINI_GAMES_SMOKE_URL || "ws://127.0.0.1:8787/ws";

async function connect(clientId, nickname) {
  const url = new URL(server);
  url.searchParams.set("clientId", clientId);
  url.searchParams.set("nickname", nickname);
  const socket = new WebSocket(url);
  const pending = new Map();
  const events = [];
  let sequence = 0;

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "response") {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      return;
    }
    events.push(message);
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  return {
    id: clientId,
    events,
    request(method, params = {}) {
      const id = `smoke-${++sequence}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ type: "request", id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const owner = await connect(`smoke-owner-${Date.now()}`, "创建者");
const guest = await connect(`smoke-guest-${Date.now()}`, "挑战者");
const watcher = await connect(`smoke-watch-${Date.now()}`, "观战者");

try {
  const created = await owner.request("room.create", {
    name: "自动验收房",
    game: "gomoku",
    minutes: 0,
    moveSeconds: 0,
    seat: 0,
  });
  assert(created.roomId && created.role === "host", "owner did not create a room");

  const joined = await guest.request("room.join", {
    roomId: created.roomId,
    role: "player",
    password: "",
  });
  assert(joined.selfSeat === 1, "second player did not occupy seat two");

  const watched = await watcher.request("room.join", {
    roomId: created.roomId,
    role: "spectator",
    password: "",
  });
  assert(watched.selfSeat === -1, "spectator unexpectedly occupied a seat");
  assert(watched.members.length === 3, "room membership is incomplete");

  const lobby = await guest.request("lobby.subscribe");
  assert(lobby.ok, "lobby subscription failed");
  const started = await owner.request("room.start");
  assert(started.phase === "playing", "owner could not start the match");

  const sequence = [
    [owner, 7 * 15 + 3],
    [guest, 8 * 15 + 0],
    [owner, 7 * 15 + 4],
    [guest, 8 * 15 + 2],
    [owner, 7 * 15 + 5],
    [guest, 8 * 15 + 4],
    [owner, 7 * 15 + 6],
    [guest, 8 * 15 + 6],
    [owner, 7 * 15 + 7],
  ];
  let finalState;
  for (const [client, to] of sequence) {
    finalState = await client.request("game.move", { from: -1, to });
  }
  assert(finalState.phase === "finished", "five-in-a-row did not finish the room");
  assert(finalState.moveCount === 9, "move count is wrong");
  assert(finalState.result?.outcome === 1, "winner outcome is wrong");

  const spectatorSnapshot = await watcher.request("room.snapshot");
  assert(spectatorSnapshot.phase === "finished", "spectator did not receive the result");

  console.log(
    JSON.stringify(
      {
        ok: true,
        roomId: created.roomId,
        players: 2,
        spectators: 1,
        moves: finalState.moveCount,
        result: finalState.result,
      },
      null,
      2,
    ),
  );
} finally {
  owner.close();
  guest.close();
  watcher.close();
}
