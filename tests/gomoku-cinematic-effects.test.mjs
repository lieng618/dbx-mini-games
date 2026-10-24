import test from "node:test";
import assert from "node:assert/strict";

import {
  LandingWeightEffect,
  WinEffect,
  RematchInkEffect,
} from "../src/board/effects.js";
import { BoardScene, startsFreshGomokuRound } from "../src/board/scene.js";

test("gomoku landing compresses the paper beneath the stone", () => {
  const effect = new LandingWeightEffect({ x: 120, y: 90, radius: 28 });
  effect.update(0.04);

  assert.equal(effect.under, true);
  assert.ok(effect.press.context.instructions.length > 0);
  assert.ok(effect.creases.context.instructions.length > 0);

  effect.update(0.3);
  assert.equal(effect.done, true);
  effect.destroy();
});

test("winning stones light up while the brush draws the line", () => {
  const points = Array.from({ length: 5 }, (_, index) => ({
    x: 100 + index * 54,
    y: 180,
  }));
  const effect = new WinEffect({
    points,
    sealAt: { x: 360, y: 180 },
    step: 54,
    sealGlyph: "五",
  });

  effect.update(0.45);
  assert.ok(effect.line.context.instructions.length > 0);
  assert.ok(effect.stoneGlow.context.instructions.length > 0);

  effect.destroy();
});

test("rematch first absorbs the old stones, then reveals a clean sheet", () => {
  const effect = new RematchInkEffect({
    stones: [
      { code: 1, radius: 28, x: 120, y: 140 },
      { code: 2, radius: 28, x: 174, y: 140 },
    ],
    bounds: { left: 40, top: 40, width: 320, height: 320 },
  });

  effect.update(0.16);
  assert.ok(effect.sheet.context.instructions.length > 0);
  assert.ok(effect.ink.context.instructions.length > 0);

  effect.update(1.4);
  assert.equal(effect.done, true);
  effect.destroy();
});

test("only a finished, populated gomoku board triggers the rematch wash", () => {
  const previousCells = new Array(225).fill(0);
  previousCells[112] = 1;
  const cells = new Array(225).fill(0);

  assert.equal(
    startsFreshGomokuRound({
      game: "gomoku",
      previousCells,
      cells,
      previousMoveCount: 18,
      moveCount: 0,
      previousFinished: true,
    }),
    true,
  );
  assert.equal(
    startsFreshGomokuRound({
      game: "gomoku",
      previousCells,
      cells,
      previousMoveCount: 1,
      moveCount: 0,
      previousFinished: false,
    }),
    false,
  );
  assert.equal(
    startsFreshGomokuRound({
      game: "xiangqi",
      previousCells,
      cells,
      previousMoveCount: 18,
      moveCount: 0,
      previousFinished: true,
    }),
    false,
  );
});

test("a local landing pulse is consumed once and only at its destination", () => {
  const scene = new BoardScene();
  scene.armLandingHaptic(112);

  assert.equal(scene.consumeLandingHaptic(113), false);
  assert.equal(scene.consumeLandingHaptic(112), false);
  scene.armLandingHaptic(112);
  assert.equal(scene.consumeLandingHaptic(112), true);
  assert.equal(scene.consumeLandingHaptic(112), false);

  scene.destroy();
});
