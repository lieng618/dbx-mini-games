import test from "node:test";
import assert from "node:assert/strict";

import { LastMoveEffect, PALETTE } from "../src/board/effects.js";
import { landingColour } from "../src/board/scene.js";

test("both gomoku sides use the same contrasting landing halo", () => {
  assert.equal(landingColour("gomoku", 1), PALETTE.gold);
  assert.equal(landingColour("gomoku", 0), PALETTE.gold);
});

test("landing ink uses the moving seat's side colour for xiangqi", () => {
  assert.equal(landingColour("xiangqi", 1), PALETTE.red);
  assert.equal(landingColour("xiangqi", 0), PALETTE.black);
});

test("gomoku last-move wave is drawn independently of the stone colour", () => {
  const effect = new LastMoveEffect({
    to: { x: 100, y: 100 },
    radius: 20,
    duration: 2,
    wave: true,
  });
  effect.update(0.12);
  assert.ok(effect.halo.context.instructions.length > 0);
  effect.destroy();
});
