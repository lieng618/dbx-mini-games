import test from "node:test";
import assert from "node:assert/strict";

import { reconcileLastMove } from "../src/snapshot.js";

test("a board snapshot without lastMove clears the previous marker", () => {
  const previous = { from: -1, to: 112 };
  assert.equal(reconcileLastMove({ cells: new Array(225).fill(0) }, previous), null);
});

test("a board snapshot with lastMove replaces the previous marker", () => {
  const next = { from: 0, to: 1 };
  assert.deepEqual(
    reconcileLastMove({ cells: new Array(225).fill(0), lastMove: next }, { from: -1, to: 112 }),
    next,
  );
});

test("a partial snapshot leaves the board marker untouched", () => {
  const previous = { from: -1, to: 112 };
  assert.equal(reconcileLastMove({ nickname: "棋友" }, previous), previous);
});
