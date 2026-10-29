import test from "node:test";
import assert from "node:assert/strict";

import { isConnectionLostError } from "../src/bridge.js";
import { describeError } from "../src/errors.js";

test("a dropped socket no longer reads like a terminal failure", () => {
  for (const raw of ["云端连接已断开", "云端事件连接已断开"]) {
    const message = describeError(raw);
    assert.equal(message, "网络波动，正在自动重连…");
    assert.ok(!message.includes("已断开"), `${raw} still claims the connection is gone`);
  }
});

test("fallbacks that fire while the bridge retries stay honest", () => {
  assert.equal(describeError("尚未连接到游戏服务器"), "还没有连上云端，正在自动重试…");
  assert.equal(describeError(new Error("云端请求超时")), "云端迟迟没有回应：网络可能不稳定，稍后再试");
});

test("protocol errors keep their dedicated wording", () => {
  assert.equal(describeError("not your turn"), "还没轮到你走棋");
  assert.equal(describeError("session was replaced by a newer connection"), "连接已更新，正在恢复");
  assert.equal(describeError(""), "操作失败");
});

test("the bridge tags a dropped-socket rejection so callers can stay quiet", () => {
  const dropped = new Error("云端连接已断开");
  dropped.code = "connection-lost";
  assert.equal(isConnectionLostError(dropped), true);
  assert.equal(isConnectionLostError(new Error("云端连接已断开")), false);
  assert.equal(isConnectionLostError(null), false);
});
