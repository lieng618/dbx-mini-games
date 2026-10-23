import test from "node:test";
import assert from "node:assert/strict";

import {
  CannonBlastEffect,
  CaptureBurstEffect,
  CheckEffect,
  GhostMoveEffect,
  KeyCaptureCinematicEffect,
  PieceCaptureAccentEffect,
  RiverSurgeEffect,
  ShatterEffect,
  VictoryFractureEffect,
  captureImpactAngle,
  isCinematicCapture,
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
  assert.equal(move.victimKind, PIECE.horse);
  const victim = pieces.dying[0];
  assert.ok(victim?.tween);
  assert.equal(victim.tween.kind, "capture");
  assert.ok(Math.abs(victim.tween.delay - Math.max(0, move.duration - 0.06)) < 1e-9);
  assert.ok(Math.abs(victim.tween.angle + Math.PI / 2) < 1e-9);
  pieces.root.destroy({ children: true });
});

test("capture effects follow the attacker's line and break the glyph in two", () => {
  const from = { x: 100, y: 260 };
  const to = { x: 340, y: 260 };
  assert.equal(captureImpactAngle(from, to), 0);

  const shatter = new ShatterEffect({
    x: to.x,
    y: to.y,
    radius: 30,
    colour: 0xb03a2e,
    glyph: "马",
    kind: PIECE.horse,
    from,
    to,
    seed: 13,
  });
  assert.equal(shatter.angle, 0);
  assert.equal(shatter.glyphHalves.length, 2);
  assert.ok(shatter.wedges.length >= 11);
  assert.ok(shatter.wedges.every((wedge) => wedge.vx > 0));
  shatter.update(0.11);
  assert.ok(shatter.crack.context.instructions.length > 0);
  assert.ok(shatter.ink.context.instructions.length > 0);
  assert.ok(shatter.glyphHalves.some((half) => half.group.alpha > 0.5));
  shatter.destroy();

  const dust = new CaptureBurstEffect({
    x: to.x,
    y: to.y,
    radius: 28,
    colour: 0xb03a2e,
    kind: PIECE.horse,
    from,
    to,
    seed: 14,
  });
  assert.equal(dust.angle, 0);
  assert.ok(dust.particles.length < 30);
  assert.ok(dust.particles.filter((particle) => particle.vx > 0).length > dust.particles.length / 2);
  dust.destroy();
});

test("low-motion capture still shows that the piece broke", () => {
  const shatter = new ShatterEffect({
    x: 200,
    y: 200,
    radius: 30,
    colour: 0x22201d,
    glyph: "车",
    kind: PIECE.rook,
    from: { x: 200, y: 40 },
    to: { x: 200, y: 200 },
    lowMotion: true,
    seed: 15,
  });
  shatter.update(0.08);
  assert.equal(shatter.glyphHalves.length, 2);
  assert.ok(shatter.glyphHalves.every((half) => half.group.alpha > 0));
  assert.ok(shatter.ink.context.instructions.length > 0);
  assert.ok(shatter.crack.context.instructions.length > 0);
  shatter.destroy();
});

test("heavy-piece captures rise and shatter across the full board", () => {
  assert.equal(isCinematicCapture(PIECE.rook), true);
  assert.equal(isCinematicCapture(PIECE.horse), true);
  assert.equal(isCinematicCapture(PIECE.cannon), true);
  assert.equal(isCinematicCapture(PIECE.king), true);
  assert.equal(isCinematicCapture(PIECE.advisor), false);
  assert.equal(isCinematicCapture(PIECE.elephant), false);
  assert.equal(isCinematicCapture(PIECE.pawn), false);

  const effect = new KeyCaptureCinematicEffect({
    start: { x: 300, y: 620 },
    width: 1600,
    height: 900,
    radius: 100,
    startRadius: 34,
    colour: 0xb03a2e,
    glyph: "车",
    kind: PIECE.rook,
    angle: 0,
    seed: 31,
  });
  assert.equal(effect.fragments.length, 50);
  assert.equal(effect.cracks.length, 32);
  assert.equal(effect.strikes.length, 15);
  assert.equal(effect.seal, undefined);
  assert.ok(effect.debris.length >= 38);
  const strikeQuadrants = new Set(
    effect.strikes.map(
      (strike) =>
        `${strike.points[0].x < effect.center.x ? "L" : "R"}${
          strike.points[0].y < effect.center.y ? "T" : "B"
        }`,
    ),
  );
  assert.ok(strikeQuadrants.size >= 2);
  assert.ok(
    effect.strikes.some((strike) => {
      const first = strike.points[0];
      const last = strike.points[strike.points.length - 1];
      const middle = strike.points[Math.floor(strike.points.length / 2)];
      const dx = last.x - first.x;
      const dy = last.y - first.y;
      return Math.abs(dx * (middle.y - first.y) - dy * (middle.x - first.x)) > 20;
    }),
  );
  assert.ok(effect.debris.every((particle) => particle.x === effect.center.x));
  effect.update(0.16);
  assert.ok(effect.hero.x > 300);
  assert.ok(effect.hero.x < effect.center.x);
  assert.ok(effect.scrim.context.instructions.length > 0);

  effect.update(0.24);
  assert.ok(Math.abs(effect.hero.x - effect.center.x) < 1);
  assert.ok(effect.caption.alpha > 0);

  effect.update(0.18);
  assert.ok(effect.fragments.some((fragment) => Math.abs(fragment.group.position.y) > 1));
  assert.ok(effect.threads.context.instructions.length > 0);
  assert.ok(effect.inkCloud.context.instructions.length > 0);
  assert.ok(effect.lightning.context.instructions.length > 0);
  assert.ok(effect.shock.context.instructions.length > 0);
  assert.ok(effect.shards.context.instructions.length > 0);
  assert.equal(effect.intact.alpha, 0);
  const sample = effect.fragments[0];
  const fallenFrom = sample.group.position.y;
  effect.update(0.42);
  assert.ok(sample.group.position.y > fallenFrom + 20);
  assert.ok(sample.fall > 0);
  const scrimBefore = effect.scrim.alpha;
  effect.update(0.42);
  assert.ok(effect.scrim.alpha < scrimBefore);
  assert.ok(effect.scrim.alpha > 0);
  effect.destroy();
});

test("heavy-piece cinematic has a quiet reduced-motion shatter", () => {
  const effect = new KeyCaptureCinematicEffect({
    start: { x: 300, y: 620 },
    width: 1600,
    height: 900,
    radius: 100,
    colour: 0x22201d,
    glyph: "炮",
    kind: PIECE.cannon,
    angle: Math.PI / 2,
    lowMotion: true,
    seed: 37,
  });
  effect.update(0.38);
  assert.equal(effect.hero.x, effect.center.x);
  assert.equal(effect.threads.context.instructions.length, 0);
  assert.equal(effect.lightning.context.instructions.length, 0);
  assert.equal(effect.shock.context.instructions.length, 0);
  assert.equal(effect.shards.context.instructions.length, 0);
  assert.ok(
    effect.fragments.every(
      (fragment) =>
        Math.hypot(fragment.group.position.x, fragment.group.position.y) < 32 &&
        fragment.group.rotation === 0 &&
        fragment.group.visible,
    ),
  );
  effect.destroy();
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
    kind: PIECE.horse,
    from: { x: 100, y: 240 },
    to: { x: 240, y: 240 },
    seed: 11,
  });
  glyphShatter.update(0.18);
  assert.equal(glyphShatter.glyphHalves.length, 2);
  assert.ok(glyphShatter.glyphHalves.some((shard) => shard.group.alpha > 0));
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
