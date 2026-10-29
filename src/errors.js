/**
 * Player-facing wording for errors that arrive from the cloud service or the bridge.
 *
 * The sidecar speaks in protocol strings ("not your turn", "i/o timeout"). Every one of
 * them is mapped here to something a player can act on. The table lives outside App.vue so
 * the wording is unit-testable: a wrong phrase in the UI is a bug, not a style choice.
 */

/** Maps a sidecar or bridge error to something a player can act on. */
export function describeError(raw) {
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
    ["emote is cooling down", "表情发得太快了，稍等一下"],
    ["emotes are only available during a match", "对局开始后才能发表情"],
    ["only seated players may send emotes", "坐下后才能发表情"],
    ["unknown emote", "这个表情不存在"],
    ["not your turn", "还没轮到你走棋"],
    ["illegal move", "这一步不合规则"],
    ["only seated players may do that", "你在观战，坐下后才能操作"],
    ["an undo request is already pending", "已有悔棋请求等待处理"],
    ["no move to undo", "现在没有可以撤回的棋"],
    ["only the player who made the last move may request an undo", "只能撤回自己刚下的最后一手"],
    ["only the opponent can answer an undo request", "只有对手可以处理这次悔棋请求"],
    ["a seat swap request is already pending", "已有交换位置请求等待处理"],
    ["no seat swap request is pending", "交换位置请求已失效"],
    ["only the opponent can answer a seat swap request", "只有对手可以处理这次交换位置请求"],
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
    // A dropped socket is repaired by the bridge on its own, usually within half a second.
    // The bridge's own wording ("云端连接已断开") reads like a terminal failure, so any
    // path that still surfaces it says the same story the player will actually live
    // through: the connection is coming back.
    ["云端事件连接已断开", "网络波动，正在自动重连…"],
    ["云端连接已断开", "网络波动，正在自动重连…"],
    ["尚未连接到游戏服务器", "还没有连上云端，正在自动重试…"],
    ["云端请求超时", "云端迟迟没有回应：网络可能不稳定，稍后再试"],
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
