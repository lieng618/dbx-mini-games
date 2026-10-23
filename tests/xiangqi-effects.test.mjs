import test from "node:test";
import assert from "node:assert/strict";

import {
  CannonBlastEffect,
  CheckEffect,
  GhostMoveEffect,
  PieceCaptureAccentEffect,
  RiverSurgeEffect,
  ShatterEffect,
  VictoryFractureEffect,
} from "../src/board/effects.js";
import { PIECE, cellCenter, cellsBetween, crossesRiver, layout } from "../src/board/layout.js";
import { PieceLayer } from "../src/board/pieces.js";
import { nextCheckTier } from "../src/board/scene.js";

test("cannon geometry exposes the one screen piece and river crossing", () => {
  const lay = layout("xiangqi");
  const from = 7 * lay.files + 7;
  const to = 0 * lay.files + 7;
  assert.deepEqual(cellsBetween(lay, from, to), [61, 52, 43, 34, 25, 16]);
  assert.equal(crossesRiver(lay, from, to), true);
  assert.equal(crossesRiver(lay, 8 * lay.files + 4, 7 * lay.files + 4), false);
});

test("piece moves carry cannon and victim identity for their effects", () => {
  const lay = layout("xiangqi");
  const pieces = new PieceLayer();
  const old = new Array(lay.cells).fill(0);
  const from = 7 * lay.files + 7;
  const screen = 3 * lay.files + 7;
  const to = 7;
  old[from] = PIECE.cannon;
  old[screen] = PIECE.pawn;
  old[to] = -PIECE.horse;

  pieces.reset("xiangqi", lay);
  pieces.sync(old, lay);
  const next = old.slice();
  next[from] = 0;
  next[to] = PIECE.cannon;
  const [move] = pieces.sync(next, lay);

  assert.equal(move.moverKind, PIECE.cannon);
  assert.equal(move.victimGlyph, "马");
  pieces.root.destroy({ children: true });
});

test("signature effects draw their primary geometry", () => {
  const cannon = new CannonBlastEffect({
    from: { x: 20, y: 20 },
    to: { x: 300, y: 20 },
    screen: { x: 160, y: 20 },
    radius: 30,
    seed: 7,
  });
  cannon.update(0.26);
  assert.ok(cannon.beam.context.instructions.length > 0);
  assert.ok(cannon.screenLock.context.instructions.length > 0);
  assert.ok(cannon.impact.context.instructions.length > 0);
  cannon.destroy();

  const river = new RiverSurgeEffect({
    left: 20,
    top: 200,
    width: 500,
    height: 64,
    step: 64,
    seed: 8,
  });
  river.update(0.24);
  assert.ok(river.band.context.instructions.length > 0);
  assert.ok(river.current.context.instructions.length > 0);
  river.destroy();

  const check = new CheckEffect({
    boardWidth: 500,
    boardHeight: 600,
    originX: 20,
    originY: 20,
    focus: { x: 260, y: 120 },
    attacker: { x: 260, y: 540 },
    step: 64,
    seed: 9,
  });
  check.update(0.32);
  assert.ok(check.attack.context.instructions.length > 0);
  check.destroy();

  const comboCheck = new CheckEffect({
    boardWidth: 500,
    boardHeight: 600,
    originX: 20,
    originY: 20,
    focus: { x: 260, y: 120 },
    attacker: { x: 260, y: 540 },
    step: 64,
    tier: 3,
    seed: 19,
  });
  comboCheck.update(0.4);
  assert.equal(comboCheck.echoes.length, 2);
  comboCheck.destroy();

  const glyphShatter = new ShatterEffect({
    x: 240,
    y: 240,
    radius: 30,
    colour: 0xb03a2e,
    glyph: "马",
    seed: 11,
  });
  glyphShatter.update(0.18);
  assert.equal(glyphShatter.glyphShards.length, 7);
  assert.ok(glyphShatter.glyphShards.some((shard) => shard.group.alpha > 0));
  glyphShatter.destroy();

  const accent = new PieceCaptureAccentEffect({
    from: { x: 120, y: 140 },
    to: { x: 280, y: 140 },
    kind: PIECE.rook,
    radius: 30,
  });
  accent.update(0.18);
  assert.ok(accent.mark.context.instructions.length > 0);
  accent.destroy();

  const ghost = new GhostMoveEffect({
    from: { x: 100, y: 260 },
    to: { x: 300, y: 260 },
    glyph: "炮",
    colour: 0xb03a2e,
    kind: PIECE.cannon,
    radius: 30,
    mode: "undo",
  });
  ghost.update(0.16);
  assert.ok(ghost.body.x > 100);
  assert.ok(ghost.trail.context.instructions.length > 0);
  ghost.destroy();

  const fracture = new VictoryFractureEffect({
    center: cellCenter(layout("xiangqi"), 4),
    step: 64,
    seed: 10,
  });
  fracture.update(0.72);
  assert.ok(fracture.cracks.context.instructions.length > 0);
  fracture.destroy();
});

test("check chains escalate", () => {
  assert.equal(nextCheckTier(0, -Infinity, 8), 1);
  assert.equal(nextCheckTier(1, 8, 10), 2);
  assert.equal(nextCheckTier(2, 10, 11), 3);
  assert.equal(nextCheckTier(3, 11, 12), 3);
  assert.equal(nextCheckTier(2, 10, 15), 1);
});
