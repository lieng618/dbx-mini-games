/**
 * Ink-effect toolkit for the board.
 *
 * Every effect here is a short-lived object with an `update(dt)` method and a `done` flag.
 * The scene owns a list of them and drops finished ones. Effects only ever read board
 * state they are handed; they never decide anything about the game.
 *
 * Two ideas run through the whole file:
 *
 * 1. Real ink is never a circle. Every shape that is meant to read as a wet mark is an
 *    irregular closed polygon whose edge noise decays as the mark settles. A clean circle
 *    reads as "graphic"; a slightly wobbly one reads as "ink".
 * 2. Paper absorbs. So each mark is drawn as a dense core, a feathered halo, and a rim —
 *    three alphas rather than one — which is what makes a stroke look like it bled into
 *    the sheet instead of being printed on top of it.
 *
 * The low-motion path is not "the same effect, smaller": it is a separate, calmer form
 * with no shake, no glyph, no particles, and no long trails.
 */

import { Container, Graphics, Text, TextStyle } from "pixi.js";
// Only these two are imported by name, because the package's barrel export pulls in forty
// filters and the plugin ships as a single inline bundle.
import { GlowFilter } from "pixi-filters/glow";
import { DropShadowFilter } from "pixi-filters/drop-shadow";
import { PIECE } from "./layout.js";

const INK = 0x1c1a17;
const RED_SEAL = 0xb03a2e;
const GOLD = 0xd4a24a;

/** Palette used by both games, kept in one place so the boards feel like one product. */
export const PALETTE = {
  ink: INK,
  red: 0xb03a2e,
  black: 0x22201d,
  gold: GOLD,
  seal: RED_SEAL,
  paper: 0xf2e8d5,
};

/** Deterministic PRNG so a captured frame can be reproduced from the same seed. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fresh seed for callers that do not care about reproducibility. */
let seedCounter = 0x9e3779b9;
function nextSeed() {
  seedCounter = (seedCounter + 0x6d2b79f5) | 0;
  return seedCounter >>> 0;
}

/**
 * Builds an irregular closed outline as a flat point array for `Graphics.poly`.
 *
 * `lobes` controls how many vertices the outline has. Few lobes read as a torn blot, many
 * read as a ragged circle; ink spreading on paper sits around 14-20.
 */
function blobRadii(rand, lobes, wobble) {
  const radii = [];
  const phase = rand() * Math.PI * 2;
  const fastFreq = 3 + Math.round(rand() * 3);
  const fastPhase = rand() * Math.PI * 2;
  for (let i = 0; i < lobes; i++) {
    const angle = (Math.PI * 2 * i) / lobes;
    // Two frequencies: a slow one that makes the blot lopsided, a fast one that frays the
    // edge. The radii are kept as scalars around 1 so a caller can rescale the whole mark
    // and also dial the wobble down as ink settles — recomputing a polygon from points
    // cannot do that without distorting the shape.
    const slow = Math.sin(angle * 2 + phase) * 0.6;
    const fast = Math.sin(angle * fastFreq + fastPhase) * 0.4;
    radii.push(1 + wobble * (slow + fast));
  }
  return radii;
}

/** Turns scalar radii back into a flat point array for `Graphics.poly`. */
function radiiToPoints(radii, radius, wobbleScale = 1, cx = 0, cy = 0, squash = 1) {
  const points = [];
  const lobes = radii.length;
  for (let i = 0; i < lobes; i++) {
    const angle = (Math.PI * 2 * i) / lobes;
    const r = radius * (1 + (radii[i] - 1) * wobbleScale);
    points.push(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r * squash);
  }
  return points;
}

function blobPoints(rand, radius, opts = {}) {
  const { lobes = 16, wobble = 0.14 } = opts;
  return radiiToPoints(blobRadii(rand, lobes, wobble), radius, 1, opts.cx || 0, opts.cy || 0, opts.squash || 1);
}

/**
 * Builds a rounded-square outline with slight per-corner irregularity.
 *
 * A seal is a carved block: its silhouette is a square with worn corners, so a circular
 * outline reads as a sticker rather than as a stamp. `jitter` lets each corner deviate a
 * touch, which is what a hand-cut block looks like.
 */
function sealOutline(half, jitter, rand) {
  const pts = [];
  const total = 64;
  for (let i = 0; i < total; i++) {
    const a = (Math.PI * 2 * i) / total;
    const c = Math.abs(Math.cos(a));
    const sn = Math.abs(Math.sin(a));
    // Distance from the centre to the square boundary along this angle.
    let d = half / Math.max(c, sn);
    // Near a diagonal, blend toward the circular radius so the corners round off.
    const diag = Math.min(c, sn) / (Math.max(c, sn) || 1);
    const round = Math.min(1, Math.max(0, (0.34 - diag) * 3.4));
    d = d * (1 - round) + half * 1.04 * round;
    d *= 1 + (rand() - 0.5) * jitter;
    pts.push(Math.cos(a) * d, Math.sin(a) * d);
  }
  return pts;
}

/** Draws one ink mark: feathered halo, mid bleed, dense core. */
function drawInkMark(g, points, radius, colour, alpha) {
  g.poly(points, true).fill({ color: colour, alpha: alpha * 0.1 });
  g.poly(points, true).stroke({ width: Math.max(1, radius * 0.5), color: colour, alpha: alpha * 0.22 });
  g.poly(points, true).fill({ color: colour, alpha: alpha * 0.55 });
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/** Direction in which the captured piece is driven: attacker to victim. */
export function captureImpactAngle(from, to) {
  if (!from || !to) return 0;
  return Math.atan2(to.y - from.y, to.x - from.x);
}

/**
 * Capture profiles keep the shared "broken piece" grammar while letting the victim's
 * material decide how much it moves. Pawns dry out; rooks leave heavy, straight debris;
 * a cannon hit throws the widest fan.
 */
const CAPTURE_PROFILES = {
  [PIECE.pawn]: { force: 0.78, spread: 0.52, lift: 0.36, chips: 8, spin: 3.2 },
  [PIECE.advisor]: { force: 0.9, spread: 0.72, lift: 0.58, chips: 10, spin: 4.2 },
  [PIECE.elephant]: { force: 0.94, spread: 0.74, lift: 0.62, chips: 10, spin: 4.4 },
  [PIECE.horse]: { force: 1.04, spread: 0.68, lift: 0.92, chips: 11, spin: 4.6 },
  [PIECE.rook]: { force: 1.18, spread: 0.38, lift: 0.68, chips: 12, spin: 4.8 },
  [PIECE.cannon]: { force: 1.3, spread: 0.88, lift: 0.82, chips: 12, spin: 5.2 },
  [PIECE.king]: { force: 1.36, spread: 0.64, lift: 0.9, chips: 12, spin: 5.4 },
};

function captureProfile(kind) {
  return CAPTURE_PROFILES[Math.abs(Number(kind))] || {
    force: 1,
    spread: 0.64,
    lift: 0.64,
    chips: 10,
    spin: 4,
  };
}

/** Heavy pieces earn a board-wide cinematic beat; advisors and elephants stay local. */
export function isCinematicCapture(kind) {
  const value = Math.abs(Number(kind));
  return (
    value === PIECE.rook ||
    value === PIECE.horse ||
    value === PIECE.cannon ||
    value === PIECE.king
  );
}

/** Flat point array for an ellipse aligned to the impact direction. */
function orientedEllipsePoints(rx, ry, angle, steps = 24, cx = 0, cy = 0) {
  const points = [];
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  for (let i = 0; i < steps; i++) {
    const a = (Math.PI * 2 * i) / steps;
    const x = Math.cos(a) * rx;
    const y = Math.sin(a) * ry;
    points.push(cx + x * cos - y * sin, cy + x * sin + y * cos);
  }
  return points;
}

/** Shared irregular crack used to cut both halves of a large piece in the cinematic. */
function tornCrack(rand, radius, steps = 10) {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const along = -radius * 1.22 + (radius * 2.44 * i) / steps;
    const offset =
      radius * Math.sin(i * 1.17 + 0.4) * 0.055 + (rand() - 0.5) * radius * 0.024;
    points.push({ along, offset });
  }
  return points;
}

/** One side of the irregular crack, expressed in attack-aligned local coordinates. */
function tornHalfPoints(crack, radius, side, ux, uy, nx, ny) {
  const points = [];
  for (const point of crack) {
    points.push(ux * point.along + nx * point.offset, uy * point.along + ny * point.offset);
  }
  for (let i = crack.length - 1; i >= 0; i--) {
    const point = crack[i];
    const edge = side * radius * 1.3;
    points.push(ux * point.along + nx * edge, uy * point.along + ny * edge);
  }
  return points;
}

/**
 * RippleEffect is a real ink drop: a dark core that blooms instantly, an irregular rim that
 * creeps outward as the paper pulls the ink, and a few satellite droplets thrown clear.
 *
 * The old version was two perfect concentric circles, which is why the board read as flat:
 * circles have no direction and no texture, so the eye has nothing to follow.
 */
export class RippleEffect {
  constructor({ x, y, radius, colour = PALETTE.ink, heavy = false, lowMotion = false, seed }) {
    this.lowMotion = lowMotion;
    this.age = 0;
    this.duration = lowMotion ? 0.3 : heavy ? 1.05 : 0.86;
    this.maxRadius = radius * (heavy ? 2.2 : 1.9);
    this.colour = colour;
    this.done = false;
    this.view = new Container();
    this.view.position.set(x, y);
    this.core = new Graphics();
    this.spread = new Graphics();
    this.drops = new Graphics();
    this.view.addChild(this.core, this.spread, this.drops);

    const rand = mulberry32(seed ?? nextSeed());
    // The edge outline is sampled once and reused every frame. Regenerating the noise per
    // frame would make the rim shimmer, which reads as a glitch rather than as ink.
    this.outline = blobRadii(rand, 20, 0.13);
    this.inner = blobRadii(rand, 13, 0.17);

    this.satellites = [];
    const satellites = lowMotion ? 0 : 4;
    for (let i = 0; i < satellites; i++) {
      const angle = rand() * Math.PI * 2;
      this.satellites.push({
        angle,
        distance: radius * (1.1 + rand() * 1.5),
        size: radius * (0.1 + rand() * 0.14),
        delay: rand() * 0.22,
        radii: blobRadii(rand, 9, 0.22),
      });
    }
  }

  update(dt) {
    this.age += dt;
    const t = Math.min(1, this.age / this.duration);
    // Ink runs fast at first and then creeps: a low exponent gives that front-loaded feel,
    // where a plain ease-out makes the drop look like it is inflating.
    const spread = Math.pow(t, 0.42);
    const fade = Math.pow(1 - t, 1.35);
    const settle = this.lowMotion ? 0 : 1 - t;

    this.core.clear();
    this.spread.clear();
    this.drops.clear();

    // Core: dense, small, wins the eye immediately, gone by the halfway point.
    const coreR = this.maxRadius * 0.5;
    const coreAlpha = this.lowMotion ? fade * 0.35 : Math.min(1, fade * 1.9);
    if (coreAlpha > 0.01) {
      drawInkMark(this.core, radiiToPoints(this.inner, coreR, 1), coreR, this.colour, coreAlpha);
    }

    // Rim: the wet edge creeping through the fibres. The wobble decays as the mark dries,
    // because ink relaxing into the sheet does not keep its torn silhouette.
    const rimR = this.maxRadius * spread;
    const rimAlpha = this.lowMotion ? fade * 0.5 : fade * 0.72;
    if (rimAlpha > 0.01) {
      const edge = radiiToPoints(this.outline, rimR, 0.45 + settle * 0.55);
      this.spread.poly(edge, true).stroke({ width: Math.max(2, this.maxRadius * 0.13), color: this.colour, alpha: rimAlpha * 0.22 });
      this.spread.poly(edge, true).stroke({ width: Math.max(1.2, this.maxRadius * 0.045), color: this.colour, alpha: rimAlpha });
      // A second, tighter ring left behind the front: ink that soaked in earlier.
      if (!this.lowMotion) {
        this.spread
          .poly(radiiToPoints(this.outline, rimR * 0.62, 0.3), true)
          .stroke({ width: 1.4, color: this.colour, alpha: rimAlpha * 0.35 });
      }
    }

    // Satellites: ink flicked clear of the drop. They appear late and die fast, which is
    // what sells the impact as a strike rather than a bloom.
    if (!this.lowMotion) {
      for (const s of this.satellites) {
        const local = (this.age - s.delay) / (this.duration * 0.55);
        if (local <= 0 || local >= 1) continue;
        const travel = s.distance * Math.pow(local, 0.6);
        const px = Math.cos(s.angle) * travel;
        const py = Math.sin(s.angle) * travel;
        const r = s.size * (1 - local * 0.35);
        const a = (1 - local) * 0.85;
        this.drops.poly(radiiToPoints(s.radii, r, 1, px, py), true).fill({ color: this.colour, alpha: a });
      }
    }

    if (t >= 1) this.done = true;
  }

  destroy() {
    this.view.destroy({ children: true });
  }
}

/**
 * CaptureBurstEffect shatters a captured piece into ink dust.
 *
 * Three kinds of debris, because one kind of dot is what made the old burst look like a
 * particle template: round blots that arc and settle, thin hairs that stretch along their
 * own velocity, and flat specks that tumble. All of it is pooled into three Graphics
 * redraws per frame rather than per-particle sprites.
 *
 * The burst is a forward fan, not a ring. A small amount of back-scatter keeps it from
 * looking like a cone stencil, but the victim is visibly driven away from the attacker.
 */
export class CaptureBurstEffect {
  constructor({
    x,
    y,
    radius,
    colour = PALETTE.ink,
    lowMotion = false,
    seed,
    from = null,
    to = null,
    kind = 0,
  }) {
    this.lowMotion = lowMotion;
    this.age = 0;
    this.duration = lowMotion ? 0.28 : 0.68;
    this.done = false;
    this.view = new Container();
    this.view.position.set(x, y);
    this.blots = new Graphics();
    this.hairs = new Graphics();
    this.shock = new Graphics();
    this.view.addChild(this.shock, this.hairs, this.blots);

    this.radius = radius;
    this.colour = colour;
    this.kind = kind;
    this.angle = captureImpactAngle(from, to);
    this.profile = captureProfile(kind);
    /** One array reused for every polygon: no per-frame allocation. */
    this.scratch = [];

    const rand = mulberry32(seed ?? nextSeed());
    // The shatter owns the large fragments; this layer supplies the dust that follows them.
    // Keeping it below thirty particles prevents the two effects from turning into a cloud.
    const count = lowMotion ? 0 : 24;
    this.particles = [];
    for (let i = 0; i < count; i++) {
      // Mostly forward, with just enough debris thrown back to describe a real impact.
      const back = rand() < 0.12;
      const angle =
        this.angle +
        (back ? Math.PI : 0) +
        (rand() - 0.5) * (back ? 0.54 : this.profile.spread * 1.55);
      const speed = radius * (1.1 + Math.pow(rand(), 0.6) * 3.2) * this.profile.force;
      const kind = rand();
      this.particles.push({
        kind: kind < 0.5 ? "blot" : kind < 0.82 ? "hair" : "speck",
        x: 0,
        y: 0,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        // Blots are heavy and fall; hairs are light and die early; specks drift.
        mass: kind < 0.5 ? 1 : kind < 0.82 ? 0.35 : 0.6,
        size: radius * (0.035 + rand() * 0.1),
        life: 0.55 + rand() * 0.45,
        radii: blobRadii(rand, 7 + Math.round(rand() * 4), 0.26),
        // Pre-baked unit outline: every frame reuses it, scaled to the live radius.
        unit: null,
      });
    }
  }

  update(dt) {
    this.age += dt;
    const t = Math.min(1, this.age / this.duration);

    this.shock.clear();
    this.hairs.clear();
    this.blots.clear();

    // Shock: a flattened ellipse across the cut, with one short wake behind it. Unlike the
    // old perfect circle, this gives the debris a readable direction even when motion is
    // paused on a single frame.
    if (!this.lowMotion) {
      const shockR = this.radius * (0.5 + Math.pow(t, 0.58) * 1.15);
      const shockFade = Math.pow(1 - t, 1.35);
      const cx = Math.cos(this.angle) * this.radius * 0.22 * t;
      const cy = Math.sin(this.angle) * this.radius * 0.22 * t;
      this.shock
        .poly(
          orientedEllipsePoints(shockR * 1.45, shockR * 0.16, this.angle + Math.PI / 2, 28, cx, cy),
          true,
        )
        .stroke({ width: 1.8, color: this.colour, alpha: shockFade * 0.2 });
      this.shock
        .moveTo(-Math.cos(this.angle) * this.radius * 0.8, -Math.sin(this.angle) * this.radius * 0.8)
        .lineTo(
          Math.cos(this.angle) * this.radius * (1.2 + t * 1.5),
          Math.sin(this.angle) * this.radius * (1.2 + t * 1.5),
        )
        .stroke({ width: 1.4, color: PALETTE.gold, alpha: shockFade * 0.42 });
    }

    for (const p of this.particles) {
      const local = Math.min(1, this.age / (this.duration * p.life));
      if (local >= 1) continue;
      // Drag is per-particle so light debris slows sooner than heavy blots. Gravity is
      // scaled by mass for the same reason.
      const drag = Math.pow(0.2 / p.mass, dt);
      p.vx *= drag;
      p.vy *= drag;
      p.vy += this.radius * 2.4 * p.mass * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      // Fade curve: hold the first third (debris still reading as a shape), then fall away
      // fast. A linear fade makes the burst look like it is being dimmed rather than spent.
      const alpha = Math.pow(1 - local, 1.5) * 0.9;
      if (alpha < 0.01) continue;

      if (p.kind === "hair") {
        // Tapered stroke along the velocity vector: a hair of ink pulled off the piece.
        const speed = Math.hypot(p.vx, p.vy) || 1;
        const len = Math.min(this.radius * 1.5, speed * 0.06);
        const dirX = p.vx / speed;
        const dirY = p.vy / speed;
        const nx = -p.vy,
          ny = p.vx;
        const norm = Math.hypot(nx, ny) || 1;
        const w = p.size * 0.9;
        this.hairs
          .poly(
            [
              p.x + (nx / norm) * w,
              p.y + (ny / norm) * w,
              p.x - (nx / norm) * w,
              p.y - (ny / norm) * w,
              p.x - dirX * len,
              p.y - dirY * len,
            ],
            true,
          )
          .fill({ color: this.colour, alpha: alpha * 0.75 });
      } else if (p.kind === "speck") {
        const rot = local * 6;
        const cos = Math.cos(rot),
          sin = Math.sin(rot);
        const pts = [];
        for (let i = 0; i < 4; i++) {
          const a = (Math.PI / 2) * i;
          const rx = Math.cos(a) * p.size,
            ry = Math.sin(a) * p.size * 0.45;
          pts.push(p.x + rx * cos - ry * sin, p.y + rx * sin + ry * cos);
        }
        this.blots.poly(pts, true).fill({ color: this.colour, alpha: alpha * 0.8 });
      } else {
        const r = p.size * (1 - local * 0.45);
        // Reuse the unit outline: radiiToPoints would otherwise rebuild a 7-11 vertex
        // polygon array per particle per frame.
        if (!p.unit) p.unit = radiiToPoints(p.radii, 1, 1, 0, 0);
        const pts = this.scratch;
        pts.length = 0;
        for (let i = 0; i < p.unit.length; i += 2) {
          pts.push(p.x + p.unit[i] * r, p.y + p.unit[i + 1] * r);
        }
        this.blots.poly(pts, true).fill({ color: this.colour, alpha });
      }
    }

    if (t >= 1) this.done = true;
  }

  destroy() {
    this.view.destroy({ children: true });
  }
}

/**
 * Breaks a captured piece along the attacker's line of travel.
 *
 * The old shatter was a radial ring, so every capture ended in the same circular explosion.
 * This version holds the victim together for a beat, opens one wobbly cut through its
 * glyph, then sends two unequal halves and a forward fan of ink away from the attacker.
 * The victim's kind changes weight and spread without changing the shared grammar.
 */
export class ShatterEffect {
  constructor({
    x,
    y,
    radius,
    colour = PALETTE.ink,
    glyph = "",
    kind = 0,
    from = null,
    to = null,
    lowMotion = false,
    seed,
  }) {
    this.lowMotion = lowMotion;
    this.age = 0;
    this.duration = lowMotion ? 0.24 : 0.64;
    this.done = false;
    this.view = new Container();
    this.view.position.set(x, y);
    this.paper = new Graphics();
    this.crack = new Graphics();
    this.ink = new Graphics();
    this.glyphLayer = new Container();
    this.view.addChild(this.paper, this.crack, this.ink, this.glyphLayer);

    this.radius = radius;
    this.colour = colour;
    this.kind = kind;
    this.profile = captureProfile(kind);
    this.angle = captureImpactAngle(from, to);
    this.ux = Math.cos(this.angle);
    this.uy = Math.sin(this.angle);
    this.nx = -this.uy;
    this.ny = this.ux;
    this.scratch = [];

    const rand = mulberry32(seed ?? nextSeed());
    const wedgeCount = lowMotion ? 0 : 12;
    this.wedges = [];
    for (let i = 0; i < wedgeCount; i++) {
      const side = i % 2 ? -1 : 1;
      const lane = Math.floor(i / 2) / Math.max(1, wedgeCount / 2 - 1) - 0.5;
      const mid =
        this.angle +
        side * (Math.PI / 2 + lane * this.profile.spread * 0.68 + (rand() - 0.5) * 0.16);
      // Each fragment is still a curved rim segment, not a generic rectangle.
      const span = 0.22 + rand() * 0.15;
      const forward = radius * (0.9 + rand() * 1.2) * this.profile.force * (side > 0 ? 1.05 : 0.9);
      const lateral = radius * (0.55 + rand() * 1.15) * (0.7 + Math.abs(lane) * 0.55);
      this.wedges.push({
        start: mid - span / 2,
        span,
        inner: radius * (0.46 + rand() * 0.16),
        outer: radius * (0.88 + rand() * 0.1),
        x: 0,
        y: 0,
        vx: this.ux * forward + this.nx * side * lateral,
        vy: this.uy * forward + this.ny * side * lateral - radius * (0.16 + this.profile.lift * 0.42),
        rot: 0,
        spin: side * (1.4 + rand() * this.profile.spin),
        life: 0.66 + rand() * 0.3,
      });
    }

    const chipCount = lowMotion ? 0 : this.profile.chips;
    this.chips = [];
    for (let i = 0; i < chipCount; i++) {
      const back = rand() < 0.1;
      const angle =
        this.angle +
        (back ? Math.PI : 0) +
        (rand() - 0.5) * (back ? 0.48 : this.profile.spread * 1.7);
      const speed = radius * (1.4 + rand() * 3.4) * this.profile.force;
      this.chips.push({
        x: 0,
        y: 0,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - radius * (0.35 + this.profile.lift * 0.6),
        size: radius * (0.045 + rand() * 0.09),
        radii: blobRadii(rand, 6 + Math.round(rand() * 3), 0.3),
        unit: null,
        life: 0.46 + rand() * 0.36,
      });
    }

    // One irregular cut is sampled once and used by both masks. That leaves a visible seam
    // between the halves instead of two clean semicircles meeting at a straight line.
    this.glyphHalves = [];
    if (glyph) {
      const steps = 8;
      const crack = [];
      for (let i = 0; i <= steps; i++) {
        const along = -radius * 1.5 + (radius * 3 * i) / steps;
        const offset =
          radius * Math.sin(i * 1.23 + 0.7) * 0.045 + (rand() - 0.5) * radius * 0.018;
        crack.push({ along, offset });
      }
      for (const side of [-1, 1]) {
        const group = new Container();
        const glyphText = new Text({
          text: glyph,
          style: new TextStyle({
            fontFamily: "Songti SC, SimSun, STSong, serif",
            fontSize: radius * 1.24,
            fontWeight: "600",
            fill: colour,
          }),
        });
        glyphText.anchor.set(0.5);
        glyphText.position.set(0, radius * 0.04);

        const mask = new Graphics();
        const points = [];
        for (const point of crack) {
          points.push(
            this.ux * point.along + this.nx * point.offset,
            this.uy * point.along + this.ny * point.offset,
          );
        }
        for (let i = crack.length - 1; i >= 0; i--) {
          const point = crack[i];
          const edge = side * radius * 1.42;
          points.push(
            this.ux * point.along + this.nx * edge,
            this.uy * point.along + this.ny * edge,
          );
        }
        mask.poly(points, true).fill({ color: 0xffffff });
        group.addChild(glyphText, mask);
        group.mask = mask;
        this.glyphLayer.addChild(group);

        const forward = radius * (0.72 + rand() * 0.42) * this.profile.force * (side > 0 ? 1 : 0.78);
        const lateral = radius * (0.82 + rand() * 0.58) * side;
        this.glyphHalves.push({
          group,
          side,
          x: 0,
          y: 0,
          vx: this.ux * forward + this.nx * lateral,
          vy: this.uy * forward + this.ny * lateral - radius * 0.26,
          rot: 0,
          spin: side * (1.2 + rand() * 2.4),
          life: 0.56 + rand() * 0.28,
        });
      }
    }
  }

  /** A quiet stain and cut behind the stationary glyph halves. */
  drawLowMotion(t) {
    const fade = Math.pow(1 - t, 1.25);
    this.ink
      .poly(
        orientedEllipsePoints(
          this.radius * 0.82,
          this.radius * 0.5,
          this.angle,
          18,
        ),
        true,
      )
      .fill({ color: this.colour, alpha: fade * 0.065 });
    this.crack
      .moveTo(-this.ux * this.radius * 0.86, -this.uy * this.radius * 0.86)
      .lineTo(this.ux * this.radius * 0.7, this.uy * this.radius * 0.7)
      .stroke({ width: 1.8, color: PALETTE.gold, alpha: fade * 0.64 });
  }

  update(dt) {
    this.age += dt;
    const t = Math.min(1, this.age / this.duration);
    this.paper.clear();
    this.crack.clear();
    this.ink.clear();

    if (this.lowMotion) {
      const fade = Math.pow(1 - t, 1.2);
      for (const half of this.glyphHalves) {
        const offset = this.radius * (0.08 + t * 0.16) * half.side;
        half.group.visible = true;
        half.group.position.set(this.nx * offset, this.ny * offset);
        half.group.alpha = fade;
        half.group.scale.set(1 - t * 0.06);
      }
      this.drawLowMotion(t);
      if (t >= 1) this.done = true;
      return;
    }

    // The victim gets one held beat before the cut. Landing local light replaces the old
    // full-board capture flash, so the rest of the position never disappears.
    const flash = Math.max(0, 1 - this.age / 0.17);
    if (flash > 0) {
      this.paper
        .poly(
          orientedEllipsePoints(
            this.radius * (1.9 + t * 0.8),
            this.radius * (0.95 + t * 0.35),
            this.angle + Math.PI / 2,
            28,
          ),
          true,
        )
        .fill({ color: 0xfff2cf, alpha: flash * flash * 0.16 });
    }
    const stainFade = Math.max(0, 1 - this.age / 0.44);
    if (stainFade > 0) {
      this.paper
        .poly(
          orientedEllipsePoints(
            this.radius * 1.45,
            this.radius * 0.58,
            this.angle + Math.PI / 2,
            22,
          ),
          true,
        )
        .fill({ color: this.colour, alpha: stainFade * 0.055 });
    }

    const cut = Math.min(1, Math.max(0, (this.age - 0.025) / 0.075));
    const cutFade = Math.max(0, 1 - Math.max(0, this.age - 0.04) / 0.36);
    if (cut > 0 && cutFade > 0) {
      const fromAlong = -this.radius * 0.88;
      const toAlong = this.radius * (0.52 + cut * 0.82);
      const midAlong = fromAlong + (toAlong - fromAlong) * 0.52;
      for (const [offset, width, colour, alpha] of [
        [-0.075, 1.1, this.colour, 0.42],
        [0, 3.1, PALETTE.gold, 0.86],
        [0.09, 1.35, this.colour, 0.5],
      ]) {
        const wobble = offset < 0 ? -0.045 : offset > 0 ? 0.035 : 0.015;
        this.crack
          .moveTo(
            this.ux * fromAlong + this.nx * this.radius * offset,
            this.uy * fromAlong + this.ny * this.radius * offset,
          )
          .lineTo(
            this.ux * midAlong + this.nx * this.radius * (offset + wobble),
            this.uy * midAlong + this.ny * this.radius * (offset + wobble),
          )
          .lineTo(
            this.ux * toAlong + this.nx * this.radius * offset,
            this.uy * toAlong + this.ny * this.radius * offset,
          )
          .stroke({ width, color: colour, alpha: cutFade * alpha });
      }
    }

    const motionAge = Math.max(0, this.age - 0.035);
    for (const w of this.wedges) {
      const local = Math.min(1, motionAge / (this.duration * w.life));
      if (local >= 1) continue;
      w.vx *= Math.pow(0.36, dt);
      w.vy *= Math.pow(0.36, dt);
      w.vy += this.radius * 4.8 * dt;
      w.x += w.vx * dt;
      w.y += w.vy * dt;
      w.rot += w.spin * dt;

      const alpha = Math.pow(1 - local, 1.15);
      if (alpha < 0.02) continue;

      const pts = this.scratch;
      pts.length = 0;
      const steps = 4;
      for (let k = 0; k <= steps; k++) {
        const a = w.start + w.rot + (w.span * k) / steps;
        pts.push(w.x + Math.cos(a) * w.outer, w.y + Math.sin(a) * w.outer);
      }
      for (let k = steps; k >= 0; k--) {
        const a = w.start + w.rot + (w.span * k) / steps;
        pts.push(w.x + Math.cos(a) * w.inner, w.y + Math.sin(a) * w.inner);
      }
      this.ink.poly(pts, true).fill({ color: this.colour, alpha: alpha * 0.92 });
    }

    for (const c of this.chips) {
      const local = Math.min(1, motionAge / (this.duration * c.life));
      if (local >= 1) continue;
      c.vx *= Math.pow(0.42, dt);
      c.vy *= Math.pow(0.42, dt);
      c.vy += this.radius * 5.6 * dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      const alpha = Math.pow(1 - local, 1.35) * 0.9;
      if (alpha < 0.02) continue;
      if (!c.unit) c.unit = radiiToPoints(c.radii, 1, 1, 0, 0);
      const pts = this.scratch;
      pts.length = 0;
      for (let i = 0; i < c.unit.length; i += 2) {
        pts.push(c.x + c.unit[i] * c.size, c.y + c.unit[i + 1] * c.size);
      }
      this.ink.poly(pts, true).fill({ color: this.colour, alpha });
    }

    for (const shard of this.glyphHalves) {
      const local = Math.min(1, motionAge / (this.duration * shard.life));
      if (local >= 1) {
        shard.group.visible = false;
        continue;
      }
      shard.vx *= Math.pow(0.48, dt);
      shard.vy *= Math.pow(0.48, dt);
      shard.vy += this.radius * 3.6 * dt;
      shard.x += shard.vx * dt;
      shard.y += shard.vy * dt;
      shard.rot += shard.spin * dt;
      shard.group.position.set(shard.x, shard.y);
      shard.group.rotation = shard.rot;
      shard.group.alpha = Math.pow(1 - local, 0.82);
      shard.group.scale.set(1 - local * 0.14);
    }

    if (t >= 1) this.done = true;
  }

  destroy() {
    this.view.destroy({ children: true });
  }
}

/**
 * A board-wide cinematic for a heavy piece capture.
 *
 * The captured piece rises from its square into a calm central focus, remains legible for a
 * beat, and is then torn along the attacker's line. Both the disc and glyph use the same
 * irregular mask, so the two halves read as one physical object rather than as text stamped
 * over an unrelated explosion. The effect never disables pointer input or pauses game state.
 */
export class KeyCaptureCinematicEffect {
  constructor({
    start,
    width,
    height,
    radius = 102,
    startRadius = 34,
    colour = PALETTE.red,
    glyph = "",
    kind = 0,
    angle = 0,
    lowMotion = false,
    seed,
  }) {
    this.lowMotion = lowMotion;
    this.age = 0;
    this.duration = lowMotion ? 0.7 : 1.55;
    this.done = false;
    this.width = width;
    this.height = height;
    this.radius = radius;
    this.colour = colour;
    this.kind = kind;
    this.angle = angle;
    this.ux = Math.cos(angle);
    this.uy = Math.sin(angle);
    this.nx = -this.uy;
    this.ny = this.ux;
    this.start = start ? { x: start.x, y: start.y } : { x: width / 2, y: height / 2 };
    this.center = { x: width / 2, y: height * 0.475 };
    this.startScale = Math.min(0.52, Math.max(0.18, startRadius / radius));
    this.revealAt = lowMotion ? 0.14 : 0.34;
    this.tearAt = lowMotion ? 0.21 : 0.47;
    this.tearDuration = lowMotion ? 0.25 : 0.66;

    this.view = new Container();
    this.scrim = new Graphics();
    this.frame = new Graphics();
    this.threads = new Graphics();
    this.hero = new Container();
    this.halo = new Graphics();
    this.shadow = new Graphics();
    this.body = new Container();
    this.cut = new Graphics();
    this.caption = new Text({
      text: "大 子 失 守",
      style: new TextStyle({
        fontFamily: "Songti SC, SimSun, STSong, serif",
        fontSize: 21,
        fontWeight: "600",
        fill: PALETTE.gold,
        letterSpacing: 10,
      }),
    });
    this.caption.anchor.set(0.5);
    this.caption.position.set(this.center.x, this.center.y + radius * 1.42);
    this.caption.alpha = 0;
    this.hero.addChild(this.halo, this.shadow, this.body, this.cut);
    this.view.addChild(this.scrim, this.frame, this.threads, this.hero, this.caption);

    this.scrim
      .rect(-80, -80, width + 160, height + 160)
      .fill({ color: INK, alpha: 0.62 });
    this.scrim.alpha = 0;

    const frameTop = this.center.y - radius * 1.58;
    const frameBottom = this.center.y + radius * 1.62;
    this.frame
      .roundRect(width * 0.06, height * 0.13, width * 0.88, height * 0.74, 2)
      .fill({ color: PALETTE.paper, alpha: 0.035 })
      .stroke({ width: 1, color: PALETTE.gold, alpha: 0.16 });
    for (const y of [frameTop, frameBottom]) {
      this.frame
        .moveTo(width * 0.12, y)
        .lineTo(width * 0.88, y)
        .stroke({ width: y === frameTop ? 1.2 : 1, color: PALETTE.gold, alpha: 0.22 });
    }
    for (const x of [width * 0.12, width * 0.88]) {
      this.frame
        .moveTo(x, this.center.y - radius * 0.16)
        .lineTo(x, this.center.y + radius * 0.16)
        .stroke({ width: 1.4, color: PALETTE.gold, alpha: 0.42 });
    }
    this.frame.alpha = 0;

    this.shadow
      .ellipse(0, radius * 0.36, radius * 0.66, radius * 0.13)
      .fill({ color: 0x000000, alpha: 0.14 });
    this.shadow.alpha = 0;

    const rand = mulberry32(seed ?? nextSeed());
    const crack = tornCrack(rand, radius);
    this.halves = [];
    for (const side of [-1, 1]) {
      const group = new Container();
      const disc = new Graphics();
      disc
        .circle(0, 0, radius)
        .fill({ color: PALETTE.paper, alpha: 1 })
        .circle(0, 0, radius)
        .stroke({ width: 4, color: colour, alpha: 0.94 })
        .circle(0, 0, radius * 0.84)
        .stroke({ width: 1.5, color: colour, alpha: 0.48 });
      const glyphText = new Text({
        text: glyph,
        style: new TextStyle({
          fontFamily: "Songti SC, SimSun, STSong, serif",
          fontSize: radius * 1.2,
          fontWeight: "600",
          fill: colour,
        }),
      });
      glyphText.anchor.set(0.5);
      glyphText.position.set(0, radius * 0.035);
      const mask = new Graphics();
      mask
        .poly(tornHalfPoints(crack, radius, side, this.ux, this.uy, this.nx, this.ny), true)
        .fill({ color: 0xffffff });
      group.addChild(disc, glyphText, mask);
      group.mask = mask;
      this.body.addChild(group);
      this.halves.push({
        group,
        side,
        rotation: side * (0.12 + rand() * 0.08),
        drift: 0.82 + rand() * 0.22,
      });
    }

    this.hero.position.set(this.start.x, this.start.y);
    this.hero.scale.set(this.startScale);

    this.strands = [];
    for (let i = 0; i < 11; i++) {
      this.strands.push({
        side: i % 2 ? -1 : 1,
        offset: (rand() - 0.5) * 0.34,
        reach: 0.72 + rand() * 0.86,
        lift: (rand() - 0.5) * 0.5,
        delay: rand() * 0.18,
        life: 0.42 + rand() * 0.34,
      });
    }
  }

  update(dt) {
    this.age += dt;
    const t = Math.min(1, this.age / this.duration);
    const reveal = Math.min(1, this.age / this.revealAt);
    const revealEase = easeOutCubic(reveal);
    const outro = Math.min(1, Math.max(0, (this.age - (this.duration - 0.28)) / 0.28));
    const tear = Math.min(1, Math.max(0, (this.age - this.tearAt) / this.tearDuration));
    const tearEase = easeOutCubic(tear);
    this.view.alpha = 1 - outro;

    this.scrim.alpha = (this.lowMotion ? 0.26 : 0.62) * revealEase;
    this.frame.alpha = revealEase * (1 - outro);

    if (this.lowMotion) {
      this.hero.position.set(this.center.x, this.center.y);
      this.hero.scale.set(1);
    } else {
      this.hero.position.set(
        this.start.x + (this.center.x - this.start.x) * revealEase,
        this.start.y + (this.center.y - this.start.y) * revealEase,
      );
      const settle = 1 + Math.sin(reveal * Math.PI) * 0.045;
      this.hero.scale.set(
        (this.startScale + (1 - this.startScale) * revealEase) * settle,
      );
    }

    this.caption.alpha =
      Math.max(0, Math.min(1, (this.age - this.revealAt * 0.7) / 0.18)) *
      (1 - outro) *
      (1 - Math.max(0, (tear - 0.46) / 0.54));

    this.halo.clear();
    const haloFade = revealEase * (1 - outro) * (1 - tear * 0.55);
    if (haloFade > 0.01) {
      this.halo
        .circle(0, 0, this.radius * (1.17 + Math.sin(this.age * 3.4) * 0.012))
        .stroke({ width: 2, color: PALETTE.gold, alpha: haloFade * 0.34 })
        .circle(0, 0, this.radius * 1.31)
        .stroke({ width: 1, color: this.colour, alpha: haloFade * 0.18 });
    }
    this.shadow.alpha =
      (this.lowMotion ? 0.06 : 0.18) *
      revealEase *
      (1 - outro) *
      Math.max(0, 1 - tear * 1.8);

    for (const half of this.halves) {
      const spread = this.radius * (this.lowMotion ? 0.11 : 0.92) * half.drift * tearEase;
      const forward = this.radius * (this.lowMotion ? 0 : 0.18) * tearEase;
      half.group.position.set(
        this.ux * forward + this.nx * half.side * spread,
        this.uy * forward + this.ny * half.side * spread,
      );
      half.group.rotation = this.lowMotion ? 0 : half.rotation * tearEase;
      const fadeWindow = this.lowMotion ? 0.2 : 0.38;
      const fadeStart = this.duration - fadeWindow;
      half.group.alpha = Math.max(
        0,
        1 - Math.min(1, Math.max(0, (this.age - fadeStart) / fadeWindow)),
      );
    }

    this.cut.clear();
    const cutT = Math.min(1, Math.max(0, (this.age - (this.tearAt - 0.09)) / 0.11));
    const cutFade = Math.max(0, 1 - Math.max(0, this.age - this.tearAt) / 0.32);
    if (cutT > 0 && cutFade > 0) {
      const reach = this.radius * (0.55 + cutT * 0.72);
      this.cut
        .moveTo(-this.ux * reach, -this.uy * reach)
        .lineTo(this.ux * reach * 0.16, this.uy * reach * 0.16)
        .lineTo(this.ux * reach, this.uy * reach)
        .stroke({ width: 2.6, color: PALETTE.gold, alpha: cutFade * 0.86 });
      this.cut
        .moveTo(-this.ux * reach * 0.82, -this.uy * reach * 0.82)
        .lineTo(this.ux * reach * 0.92, this.uy * reach * 0.92)
        .stroke({ width: 6, color: this.colour, alpha: cutFade * 0.12 });
    }

    this.threads.clear();
    if (!this.lowMotion && tear > 0.02 && tear < 0.98) {
      for (const strand of this.strands) {
        const local = (tear - strand.delay) / strand.life;
        if (local <= 0 || local >= 1) continue;
        const alpha = Math.pow(1 - local, 1.2) * 0.66;
        const from = {
          x:
            this.center.x +
            this.nx * strand.side * this.radius * 0.16 +
            this.uy * strand.offset * this.radius * 0.18,
          y:
            this.center.y +
            this.ny * strand.side * this.radius * 0.16 -
            this.ux * strand.offset * this.radius * 0.18,
        };
        const to = {
          x:
            this.center.x +
            this.nx * strand.side * this.radius * strand.reach +
            this.ux * this.radius * (0.34 + strand.lift * 0.18),
          y:
            this.center.y +
            this.ny * strand.side * this.radius * strand.reach +
            this.uy * this.radius * (0.34 + strand.lift * 0.18) -
            this.radius * 0.22 * local,
        };
        const mid = {
          x: (from.x + to.x) / 2 + this.ux * this.radius * strand.offset * 0.4,
          y: (from.y + to.y) / 2 + this.radius * 0.08,
        };
        this.threads
          .moveTo(from.x, from.y)
          .quadraticCurveTo(mid.x, mid.y, to.x, to.y)
          .stroke({
            width: 0.9 + (1 - local) * 1.1,
            color: strand.side < 0 ? this.colour : PALETTE.gold,
            alpha,
          });
      }
    }

    if (t >= 1) this.done = true;
  }

  destroy() {
    this.view.destroy({ children: true });
  }
}

/**
 * A cannon capture made legible as a cannon shot.
 *
 * The screen piece is the rule that distinguishes a cannon from every other Xiangqi piece,
 * so the shot starts by marking that piece, charges at the muzzle, then drives a double ink
 * beam through it. The beam lives below the pieces; the lock-on and impact flare live above
 * them, so the board stays readable while the strike still feels physical.
 */
export class CannonBlastEffect {
  constructor({ from, to, screen, radius = 38, colour = PALETTE.red, lowMotion = false, seed }) {
    this.lowMotion = lowMotion;
    this.age = 0;
    this.duration = lowMotion ? 0.42 : 1.08;
    this.done = false;
    this.from = from;
    this.to = to;
    this.screen = screen;
    this.radius = radius;
    this.colour = colour;
    this.view = new Container();
    this.beam = new Graphics();
    this.view.addChild(this.beam);

    this.overlayView = new Container();
    this.charge = new Graphics();
    this.screenLock = new Graphics();
    this.impact = new Graphics();
    this.sparks = new Graphics();
    this.overlayView.addChild(this.screenLock, this.charge, this.sparks, this.impact);

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    this.length = Math.hypot(dx, dy) || 1;
    this.ux = dx / this.length;
    this.uy = dy / this.length;

    const rand = mulberry32(seed ?? nextSeed());
    this.sparkSeeds = [];
    const count = lowMotion ? 0 : 34;
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + (rand() - 0.5) * 0.42;
      this.sparkSeeds.push({
        angle,
        speed: radius * (2.2 + rand() * 5.8),
        size: radius * (0.025 + rand() * 0.075),
        life: 0.34 + rand() * 0.4,
        kind: rand() < 0.36 ? "line" : "dot",
        radii: blobRadii(rand, 6 + Math.round(rand() * 4), 0.3),
      });
    }
  }

  update(dt) {
    this.age += dt;
    const t = Math.min(1, this.age / this.duration);
    this.beam.clear();
    this.charge.clear();
    this.screenLock.clear();
    this.impact.clear();
    this.sparks.clear();

    const launchStart = this.lowMotion ? 0.06 : 0.1;
    const launchEnd = this.lowMotion ? 0.17 : 0.24;
    const beamFade = this.lowMotion ? 1 - t : Math.max(0, 1 - Math.max(0, this.age - 0.26) / 0.78);

    // The screen is the "mountain". Hold a gold and vermilion lock on it long enough for
    // the player to read why the shot can reach across the board.
    if (this.screen && beamFade > 0) {
      const lockAlpha = Math.min(1, this.age / 0.08) * beamFade;
      const lockR = this.radius * (1.34 + Math.sin(this.age * 13) * 0.08);
      this.screenLock
        .circle(this.screen.x, this.screen.y, lockR)
        .stroke({ width: 3.2, color: PALETTE.gold, alpha: lockAlpha * 0.8 });
      this.screenLock
        .circle(this.screen.x, this.screen.y, lockR * 0.72)
        .stroke({ width: 1.4, color: this.colour, alpha: lockAlpha * 0.7 });
      for (let i = 0; i < 8; i++) {
        const a = (Math.PI * 2 * i) / 8 + this.age * 0.65;
        const inner = lockR * 1.14;
        const outer = lockR * (1.34 + (i % 2) * 0.08);
        this.screenLock
          .moveTo(this.screen.x + Math.cos(a) * inner, this.screen.y + Math.sin(a) * inner)
          .lineTo(this.screen.x + Math.cos(a) * outer, this.screen.y + Math.sin(a) * outer)
          .stroke({ width: 2, color: PALETTE.gold, alpha: lockAlpha * 0.7 });
      }
    }

    // Charge: three shrinking rings and a hot centre at the cannon. This begins before the
    // piece has travelled far, so the shot reads as the cause of the capture.
    if (this.age < launchEnd + 0.12) {
      const chargeT = Math.min(1, this.age / Math.max(0.08, launchEnd));
      const chargeAlpha = Math.min(1, this.age / 0.06);
      for (let i = 0; i < 3; i++) {
        const r = this.radius * (1.34 - i * 0.24) * (1 - chargeT * 0.34);
        this.charge
          .circle(this.from.x, this.from.y, r)
          .stroke({
            width: 4 - i,
            color: i === 0 ? PALETTE.gold : this.colour,
            alpha: chargeAlpha * (0.68 - i * 0.13),
          });
      }
      this.charge
        .circle(this.from.x, this.from.y, this.radius * (0.42 + chargeT * 0.3))
        .fill({ color: 0xfff2cf, alpha: chargeAlpha * 0.58 });
    }

    if (this.age >= launchStart && beamFade > 0) {
      const p = Math.min(1, (this.age - launchStart) / Math.max(0.01, launchEnd - launchStart));
      const ex = this.from.x + (this.to.x - this.from.x) * p;
      const ey = this.from.y + (this.to.y - this.from.y) * p;
      this.beam
        .moveTo(this.from.x, this.from.y)
        .lineTo(ex, ey)
        .stroke({ width: this.radius * 1.18, color: this.colour, alpha: beamFade * 0.16 });
      this.beam
        .moveTo(this.from.x, this.from.y)
        .lineTo(ex, ey)
        .stroke({ width: this.radius * 0.28, color: PALETTE.gold, alpha: beamFade * 0.82 });
      this.beam
        .moveTo(this.from.x, this.from.y)
        .lineTo(ex, ey)
        .stroke({ width: Math.max(1.2, this.radius * 0.055), color: 0xfff8e9, alpha: beamFade * 0.96 });
    }

    if (this.age >= launchEnd - 0.04) {
      const impactT = Math.min(1, (this.age - (launchEnd - 0.04)) / 0.54);
      const impactFade = Math.pow(1 - impactT, 1.5);
      const front = this.radius * (0.72 + Math.pow(impactT, 0.48) * 4.4);
      this.impact
        .circle(this.to.x, this.to.y, front)
        .stroke({ width: 6, color: this.colour, alpha: impactFade * 0.28 });
      this.impact
        .circle(this.to.x, this.to.y, front * 0.92)
        .stroke({ width: 2.2, color: PALETTE.gold, alpha: impactFade * 0.94 });
      for (let i = 0; i < 10; i++) {
        const a = (Math.PI * 2 * i) / 10 + 0.18;
        const r0 = this.radius * (0.8 + impactT * 0.55);
        const r1 = r0 + this.radius * (0.7 + (i % 3) * 0.34) * impactFade;
        this.impact
          .moveTo(this.to.x + Math.cos(a) * r0, this.to.y + Math.sin(a) * r0)
          .lineTo(this.to.x + Math.cos(a) * r1, this.to.y + Math.sin(a) * r1)
          .stroke({ width: i % 2 ? 2 : 3.4, color: i % 3 ? PALETTE.gold : this.colour, alpha: impactFade * 0.72 });
      }

      for (const spark of this.sparkSeeds) {
        const local = Math.max(0, this.age - launchEnd) / spark.life;
        if (local >= 1) continue;
        const travel = spark.speed * Math.pow(local, 0.56);
        const x = this.to.x + Math.cos(spark.angle) * travel;
        const y = this.to.y + Math.sin(spark.angle) * travel;
        const alpha = Math.pow(1 - local, 1.3);
        if (spark.kind === "line") {
          this.sparks
            .moveTo(this.to.x + Math.cos(spark.angle) * travel * 0.45, this.to.y + Math.sin(spark.angle) * travel * 0.45)
            .lineTo(x, y)
            .stroke({ width: spark.size * 1.8, color: this.colour, alpha: alpha * 0.78 });
        } else {
          this.sparks
            .poly(radiiToPoints(spark.radii, spark.size, 1, x, y), true)
            .fill({ color: PALETTE.gold, alpha: alpha * 0.9 });
        }
      }
    }

    if (t >= 1) this.done = true;
  }

  destroy() {
    this.view.destroy({ children: true });
    this.overlayView.destroy({ children: true });
  }
}

/**
 * The short signature left by the piece that delivered a capture.
 *
 * Cannon captures already own the long-range shot. Every other Xiangqi piece gets a motif
 * built from how it entered the square: rooks cut, horses stamp, pawns thrust, advisors and
 * elephants sweep the palace, and a general hits with concentric pressure.
 */
export class PieceCaptureAccentEffect {
  constructor({ from, to, kind, radius = 34, colour = PALETTE.red, lowMotion = false }) {
    this.lowMotion = lowMotion;
    this.age = 0;
    this.duration = lowMotion ? 0.32 : 0.78;
    this.done = false;
    this.from = from;
    this.to = to;
    this.kind = kind;
    this.radius = radius;
    this.colour = colour;
    this.angle = Math.atan2(to.y - from.y, to.x - from.x);
    this.view = new Container();
    this.mark = new Graphics();
    this.view.addChild(this.mark);
  }

  update(dt) {
    this.age += dt;
    const t = Math.min(1, this.age / this.duration);
    const fade = Math.pow(1 - t, 1.35);
    this.mark.clear();

    if (this.lowMotion) {
      this.mark
        .circle(this.to.x, this.to.y, this.radius * (1.2 + t * 0.8))
        .stroke({ width: 2, color: this.colour, alpha: (1 - t) * 0.5 });
      if (t >= 1) this.done = true;
      return;
    }

    const ux = Math.cos(this.angle);
    const uy = Math.sin(this.angle);
    const nx = -uy;
    const ny = ux;

    if (this.kind === PIECE.rook) {
      // Rook: two clean parallel cuts that extend beyond the struck square.
      for (let side = -1; side <= 1; side += 2) {
        const offset = this.radius * 0.42 * side;
        const tail = this.radius * (4.2 * fade + 0.5);
        this.mark
          .moveTo(this.to.x - ux * tail + nx * offset, this.to.y - uy * tail + ny * offset)
          .lineTo(this.to.x + ux * this.radius * 2.1 + nx * offset, this.to.y + uy * this.radius * 2.1 + ny * offset)
          .stroke({
            width: side < 0 ? 3.4 : 1.5,
            color: side < 0 ? PALETTE.gold : this.colour,
            alpha: fade * 0.82,
          });
      }
      for (let i = 0; i < 4; i++) {
        const r = this.radius * (0.7 + i * 0.42);
        this.mark
          .moveTo(this.to.x + nx * r, this.to.y + ny * r)
          .lineTo(this.to.x - nx * r, this.to.y - ny * r)
          .stroke({ width: 1.2, color: this.colour, alpha: fade * (0.32 - i * 0.045) });
      }
    } else if (this.kind === PIECE.horse) {
      // Horse: a crescent of hoof prints and three hair-like arcs around the landing.
      for (let i = 0; i < 7; i++) {
        const a = this.angle + Math.PI * 0.66 + i * 0.16;
        const r = this.radius * (0.72 + i * 0.3) * (1 + (1 - fade) * 0.24);
        const x = this.to.x + Math.cos(a) * r;
        const y = this.to.y + Math.sin(a) * r;
        this.mark
          .ellipse(x, y, this.radius * 0.11, this.radius * 0.055)
          .fill({ color: i % 2 ? PALETTE.gold : this.colour, alpha: fade * (0.62 - i * 0.045) });
      }
      for (let i = 0; i < 3; i++) {
        const r = this.radius * (1.1 + i * 0.34 + t * 0.6);
        this.mark
          .arc(this.to.x, this.to.y, r, this.angle - 0.9, this.angle + 1.7)
          .stroke({ width: 2.6 - i * 0.5, color: i === 1 ? PALETTE.gold : this.colour, alpha: fade * 0.48 });
      }
    } else if (this.kind === PIECE.pawn) {
      // Pawn: a low, short thrust rather than a broad blast.
      const reach = this.radius * (2.8 * fade + 0.5);
      this.mark
        .poly(
          [
            this.to.x - ux * reach,
            this.to.y - uy * reach,
            this.to.x + nx * this.radius * 0.8,
            this.to.y + ny * this.radius * 0.8,
            this.to.x - nx * this.radius * 0.8,
            this.to.y - ny * this.radius * 0.8,
          ],
          true,
        )
        .fill({ color: this.colour, alpha: fade * 0.3 });
      for (let i = 0; i < 3; i++) {
        this.mark
          .ellipse(this.to.x - ux * this.radius * (0.7 + i * 0.42), this.to.y - uy * this.radius * (0.7 + i * 0.42), this.radius * 0.42, this.radius * 0.16)
          .stroke({ width: 1.2, color: PALETTE.gold, alpha: fade * (0.48 - i * 0.09) });
      }
    } else if (this.kind === PIECE.advisor || this.kind === PIECE.elephant) {
      // Advisor and elephant: palace wind, drawn as four elegant rotating curls.
      for (let i = 0; i < 4; i++) {
        const a = this.age * 2.2 + (Math.PI * 2 * i) / 4;
        const r = this.radius * (1.15 + t * 0.78);
        this.mark
          .arc(this.to.x, this.to.y, r, a, a + 1.08)
          .stroke({ width: 2.4, color: i % 2 ? this.colour : PALETTE.gold, alpha: fade * 0.58 });
        this.mark
          .circle(this.to.x + Math.cos(a) * r, this.to.y + Math.sin(a) * r, this.radius * 0.07)
          .fill({ color: PALETTE.paper, alpha: fade * 0.8 });
      }
    } else {
      // General: compact pressure rings and radial fault lines.
      for (let i = 0; i < 8; i++) {
        const a = (Math.PI * 2 * i) / 8;
        const r0 = this.radius * (0.8 + t * 0.45);
        const r1 = r0 + this.radius * 1.4 * fade;
        this.mark
          .moveTo(this.to.x + Math.cos(a) * r0, this.to.y + Math.sin(a) * r0)
          .lineTo(this.to.x + Math.cos(a) * r1, this.to.y + Math.sin(a) * r1)
          .stroke({ width: i % 2 ? 2 : 3.2, color: i % 2 ? PALETTE.gold : this.colour, alpha: fade * 0.64 });
      }
      this.mark
        .circle(this.to.x, this.to.y, this.radius * (1.2 + t * 1.4))
        .stroke({ width: 3, color: this.colour, alpha: fade * 0.45 });
    }

    if (t >= 1) this.done = true;
  }

  destroy() {
    this.view.destroy({ children: true });
  }
}

/**
 * The river answers a piece that crosses it.
 *
 * A translucent wash travels through the楚河漢界 band while gold current lines sweep across
 * and a large 渡 seal rises from the paper. This is deliberately attached to the actual
 * move timeline, so it reads as the board reacting rather than as a generic banner.
 */
export class RiverSurgeEffect {
  constructor({ left, top, width, height, step = 64, colour = PALETTE.red, lowMotion = false, seed }) {
    this.lowMotion = lowMotion;
    this.age = 0;
    this.duration = lowMotion ? 0.5 : 1.5;
    this.done = false;
    this.left = left;
    this.top = top;
    this.width = width;
    this.height = height;
    this.colour = colour;
    this.view = new Container();
    this.band = new Graphics();
    this.current = new Graphics();
    this.motes = new Graphics();
    this.view.addChild(this.band, this.current, this.motes);

    const rand = mulberry32(seed ?? nextSeed());
    this.lines = [];
    const count = lowMotion ? 1 : 9;
    for (let i = 0; i < count; i++) {
      this.lines.push({
        y: top + height * (0.16 + rand() * 0.68),
        offset: rand(),
        speed: 1.15 + rand() * 0.9,
        width: 2.1 + rand() * 4.2,
        gold: rand() > 0.35,
      });
    }
    this.moteSeeds = [];
    const moteCount = lowMotion ? 0 : 28;
    for (let i = 0; i < moteCount; i++) {
      this.moteSeeds.push({
        x: left + rand() * width,
        y: top + height * (0.05 + rand() * 0.9),
        speed: 0.7 + rand() * 1.8,
        length: step * (0.08 + rand() * 0.22),
        delay: rand() * 0.24,
      });
    }

    this.glyph = null;
    if (!lowMotion) {
      this.glyph = new Text({
        text: "渡",
        style: new TextStyle({
          fontFamily: "Songti SC, SimSun, STSong, serif",
          fontSize: Math.max(44, step * 1.35),
          fontWeight: "700",
          fill: this.colour,
          stroke: { color: PALETTE.paper, width: Math.max(2, step * 0.04) },
        }),
      });
      this.glyph.anchor.set(0.5);
      this.glyph.position.set(left + width / 2, top + height / 2);
      this.view.addChild(this.glyph);
    }
  }

  update(dt) {
    this.age += dt;
    const t = Math.min(1, this.age / this.duration);
    const fade = Math.pow(1 - t, 1.35);
    this.band.clear();
    this.current.clear();
    this.motes.clear();

    const rise = Math.min(1, this.age / 0.18);
    this.band
      .rect(this.left - 6, this.top, this.width + 12, this.height)
      .fill({ color: this.colour, alpha: (this.lowMotion ? 0.08 : 0.2) * rise * fade });
    this.band
      .rect(this.left - 6, this.top - 2, this.width + 12, this.height + 4)
      .stroke({ width: this.lowMotion ? 1.5 : 4, color: PALETTE.gold, alpha: rise * fade * (this.lowMotion ? 0.42 : 0.94) });

    for (const line of this.lines) {
      const head = (this.age * line.speed + line.offset) % 1;
      const tail = Math.max(0, head - (this.lowMotion ? 0.9 : 0.28));
      const x0 = this.left + tail * this.width;
      const x1 = this.left + head * this.width;
      const wave = Math.sin(this.age * 9 + line.offset * 12) * this.height * 0.08;
      this.current
        .moveTo(x0, line.y)
        .quadraticCurveTo((x0 + x1) / 2, line.y + wave, x1, line.y - wave * 0.35)
        .stroke({
          width: line.width,
          color: line.gold ? PALETTE.gold : this.colour,
          alpha: fade * (line.gold ? 0.82 : 0.5),
        });
    }
    if (!this.lowMotion) {
      const crestX = this.left - 30 + ((this.age * 0.92) % 1) * (this.width + 60);
      this.current
        .poly(
          [
            crestX - 10,
            this.top + 4,
            crestX + 22,
            this.top + this.height / 2,
            crestX - 10,
            this.top + this.height - 4,
          ],
          true,
        )
        .stroke({ width: 6, color: PALETTE.gold, alpha: fade * 0.52 });
    }

    for (const mote of this.moteSeeds) {
      const local = Math.max(0, this.age - mote.delay) / Math.max(0.01, this.duration - mote.delay);
      if (local <= 0 || local >= 1) continue;
      const x = this.left - 16 + ((mote.x - this.left + mote.speed * this.age * this.width) % (this.width + 32));
      const alpha = Math.sin(local * Math.PI) * 0.72;
      this.motes
        .moveTo(x, mote.y)
        .lineTo(x + mote.length, mote.y + Math.sin(this.age * 11 + mote.y) * 1.8)
        .stroke({ width: 1.5, color: this.colour, alpha });
    }

    if (this.glyph) {
      const riseT = Math.min(1, this.age / 0.34);
      const overshoot = 1 + Math.sin(riseT * Math.PI) * 0.18;
      this.glyph.scale.set((0.34 + riseT * 0.76) * overshoot);
      this.glyph.alpha = riseT * Math.max(0, 1 - t) * 0.68;
      this.glyph.rotation = -0.06 + Math.sin(this.age * 4.2) * 0.012;
    }

    if (t >= 1) this.done = true;
  }

  destroy() {
    this.view.destroy({ children: true });
  }
}

/**
 * A single wash of light across the board.
 *
 * Every other effect is ink added on top; this is the only one that changes the exposure of
 * what is already there, which makes an impact register even when the player is not looking
 * at the square that changed.
 */
export class FlashEffect {
  constructor({ x, y, width, height, colour = 0xfff3d8, peak = 0.34, duration = 0.42, lowMotion = false }) {
    this.lowMotion = lowMotion;
    this.age = 0;
    this.duration = lowMotion ? 0.18 : duration;
    this.peak = lowMotion ? peak * 0.35 : peak;
    this.done = false;
    this.view = new Container();
    this.sheet = new Graphics();
    this.sheet.rect(x, y, width, height).fill({ color: colour });
    this.view.addChild(this.sheet);
    this.view.alpha = this.peak;
  }

  update(dt) {
    this.age += dt;
    const t = Math.min(1, this.age / this.duration);
    // Squared falloff: an even fade reads as a slow dim, not as a flash.
    this.view.alpha = this.peak * (1 - t) * (1 - t);
    if (t >= 1) this.done = true;
  }

  destroy() {
    this.view.destroy({ children: true });
  }
}

/**
 * CheckEffect announces check: a red rim breathing around the board, a short camera shake,
 * a spray of ink behind the threatened general, and a calligraphic character that bursts in
 * and settles.
 *
 * This is the loudest effect in the product, which is why it has the most aggressive
 * low-motion form: a single soft rim pulse, no shake, no glyph, no spray.
 */
export class CheckEffect {
  constructor({ boardWidth, boardHeight, originX = 0, originY = 0, focus, attacker, step = 64, lowMotion = false, tier = 1, seed }) {
    this.lowMotion = lowMotion;
    this.tier = Math.min(3, Math.max(1, Math.round(Number(tier) || 1)));
    this.age = 0;
    this.duration = lowMotion ? 0.55 : 1.35 + (this.tier - 1) * 0.22;
    this.done = false;
    this.view = new Container();
    this.rim = new Graphics();
    this.attack = new Graphics();
    this.view.addChild(this.rim, this.attack);
    this.focus = focus;
    this.attacker = attacker;
    this.step = step;
    this.boardWidth = boardWidth;
    this.boardHeight = boardHeight;
    // The frame is drawn in stage coordinates, so it needs the board's own origin: drawing
    // from (0,0) would put the rim outside the board on the upper-left side.
    this.originX = originX;
    this.originY = originY;

    const rand = mulberry32(seed ?? nextSeed());
    this.spray = null;
    this.glyph = null;
    this.glyphBleed = null;
    this.echoes = [];

    if (!lowMotion) {
      // The spray sits under the character: ink hitting the page behind the brush.
      this.spray = new Graphics();
      this.spray.position.set(0, 0);
      this.view.addChild(this.spray);
      this.spraySeeds = [];
      for (let i = 0; i < 16 + this.tier * 6; i++) {
        const angle = rand() * Math.PI * 2;
        this.spraySeeds.push({
          angle,
          distance: 0.9 + rand() * 1.5,
          size: 0.06 + rand() * 0.12,
          radii: blobRadii(rand, 10, 0.3),
          delay: rand() * 0.18,
        });
      }

      if (focus) {
        // The character is sized to about one cell and a half and then clamped inside the
        // board: the threatened general is often on the back rank, and a glyph centred on
        // it without clamping hangs half off the paper.
        const size = Math.max(56, step * 1.35);
        const base = {
          fontFamily: "Songti SC, SimSun, STSong, serif",
          fontSize: size,
          fontWeight: "600",
        };
        // The bleed copy carries the wet edge; the crisp copy sits on top and keeps its
        // counters open, which is why only the bleed gets a wide stroke.
        this.glyphBleed = new Text({
          text: "将",
          style: new TextStyle({ ...base, fill: PALETTE.red, stroke: { color: PALETTE.red, width: size * 0.075 } }),
        });
        this.glyph = new Text({ text: "将", style: new TextStyle({ ...base, fill: 0x8f2b20 }) });
        const margin = size * 0.58;
        const cx = Math.min(Math.max(focus.x, originX + margin), originX + boardWidth - margin);
        const cy = Math.min(Math.max(focus.y, originY + margin), originY + boardHeight - margin);
        this.glyph.anchor.set(0.5);
        this.glyphBleed.anchor.set(0.5);
        this.glyph.position.set(cx, cy);
        this.glyphBleed.position.set(cx, cy);
        // The bleed copy gets a real glow instead of a fake wider stroke: a stroke can only
        // thicken the outline, while a glow samples outward and produces the uneven bleed
        // that wet ink actually leaves. Guarded because a filter that cannot compile must
        // not take the effect down with it.
        try {
          this.glyphBleed.filters = [
            new GlowFilter({
              distance: Math.max(10, size * 0.16),
              outerStrength: 2.4,
              innerStrength: 0.6,
              color: PALETTE.red,
              quality: 0.25,
              alpha: 0.9,
            }),
          ];
        } catch {
          // Keep the plain tinted copy: the glyph still reads, just without the bloom.
        }
        this.glyphBleed.alpha = 0.5;
        this.view.addChild(this.glyphBleed, this.glyph);

        // A second and third check in quick succession leave afterimages behind the main
        // character. They are echoes, not extra labels: the threat itself stays unmistakably
        // one call of "将".
        for (let i = 1; i < this.tier; i++) {
          const echo = new Text({
            text: "将",
            style: new TextStyle({ ...base, fill: i === 1 ? PALETTE.red : 0xffefcf }),
          });
          echo.anchor.set(0.5);
          echo.position.set(cx, cy);
          echo.alpha = 0;
          this.view.addChild(echo);
          this.echoes.push({
            text: echo,
            angle: i === 1 ? (this.tier >= 3 ? 0 : -0.45) : Math.PI - 0.2,
          });
        }
      }
    }
  }

  update(dt) {
    this.age += dt;
    const t = Math.min(1, this.age / this.duration);
    // Two quick breaths, then fade: reads as an alarm without becoming a strobe.
    const breath = this.lowMotion ? 1 - t : Math.abs(Math.sin(t * Math.PI * 2));
    const alpha = (1 - t) * (this.lowMotion ? 0.4 : 0.85) * (0.55 + breath * 0.45);

    this.rim.clear();
    // The rim is drawn twice with a small offset so the frame looks stamped, not vector.
    this.rim
      .roundRect(this.originX, this.originY, this.boardWidth, this.boardHeight, 18)
      .stroke({ width: 7, color: PALETTE.red, alpha: alpha * 0.22 });
    this.rim
      .roundRect(this.originX, this.originY, this.boardWidth, this.boardHeight, 18)
      .stroke({ width: 4, color: PALETTE.red, alpha });

    this.attack.clear();
    if (!this.lowMotion && this.attacker && this.focus) {
      // A broken tactical line, not a movement arrow: it converges on the threatened
      // general and then breaks into orbiting slashes. This points at the source of the
      // check without claiming that horses or cannons move in a straight line.
      const dx = this.focus.x - this.attacker.x;
      const dy = this.focus.y - this.attacker.y;
      const length = Math.hypot(dx, dy) || 1;
      const ux = dx / length;
      const uy = dy / length;
      const reveal = Math.min(1, this.age / 0.28);
      const lockFade = Math.max(0, 1 - Math.max(0, this.age - 0.55) / 0.8);
      const segments = 15;
      for (let i = 0; i < segments; i += 2) {
        const a = Math.min(reveal, i / segments);
        const b = Math.min(reveal, (i + 1) / segments);
        if (b <= a) continue;
        const wa = this.attacker.x + dx * a;
        const wb = this.attacker.x + dx * b;
        const ha = this.attacker.y + dy * a;
        const hb = this.attacker.y + dy * b;
        this.attack
          .moveTo(wa, ha)
          .lineTo(wb, hb)
          .stroke({
            width: i % 4 === 0 ? 3.4 : 2,
            color: i % 4 === 0 ? PALETTE.red : PALETTE.gold,
            alpha: lockFade * (i % 4 === 0 ? 0.68 : 0.45),
          });
      }
      const lockR = Math.max(24, this.step * 0.62) * (1 + Math.sin(this.age * 14) * 0.08);
      for (let i = 0; i < 3; i++) {
        const a = this.age * 2.8 + (Math.PI * 2 * i) / 3;
        this.attack
          .arc(this.focus.x, this.focus.y, lockR * (1 + i * 0.16), a, a + 0.72)
          .stroke({
            width: 3.2 - i * 0.6,
            color: i === 1 ? PALETTE.gold : PALETTE.red,
            alpha: lockFade * (0.76 - i * 0.12),
          });
      }
      const tipX = this.focus.x - ux * lockR * 1.2;
      const tipY = this.focus.y - uy * lockR * 1.2;
      this.attack
        .moveTo(this.attacker.x + ux * length * reveal, this.attacker.y + uy * length * reveal)
        .lineTo(tipX + ux * 18, tipY + uy * 18)
        .stroke({ width: 1.4, color: 0xfff0cf, alpha: lockFade * 0.8 });
    }

    if (this.spray && this.focus) {
      const burst = Math.min(1, t / 0.35);
      this.spray.clear();
      for (const s of this.spraySeeds) {
        const local = (this.age - s.delay) / 0.5;
        if (local <= 0 || local >= 1) continue;
        const travel = Math.max(40, s.distance * 150) * Math.pow(local, 0.55) * burst;
        const px = this.focus.x + Math.cos(s.angle) * travel;
        const py = this.focus.y + Math.sin(s.angle) * travel;
        const r = Math.max(10, s.size * 120) * (1 - local * 0.4);
        this.spray.poly(radiiToPoints(s.radii, r, 1, px, py), true).fill({ color: PALETTE.red, alpha: (1 - local) * 0.42 });
      }
    }

    if (this.glyph) {
      // The character slams down: overshoot to 1.22, settle to 1.0, then bleed away.
      const inT = Math.min(1, this.age / 0.36);
      const overshoot = 1 + 0.22 * Math.sin(inT * Math.PI);
      const scale = (0.28 + inT * 0.86) * overshoot;
      const glyphAlpha = inT * Math.max(0, 1 - Math.pow(t, 2.6));
      const tilt = (1 - inT) * -0.32 + Math.sin(this.age * 3.2) * 0.012;
      this.glyph.scale.set(scale);
      this.glyph.rotation = tilt;
      this.glyph.alpha = glyphAlpha;
      this.glyphBleed.scale.set(scale * 1.06);
      this.glyphBleed.rotation = tilt * 1.4;
      this.glyphBleed.alpha = glyphAlpha * 0.42;

      for (let i = 0; i < this.echoes.length; i++) {
        const echo = this.echoes[i];
        const echoT = Math.min(1, Math.max(0, (this.age - 0.08 - i * 0.1) / 0.42));
        const spread = this.step * (1.7 + i * 0.9);
        const echoMargin = this.step * 0.78;
        const echoX = this.glyph.x + Math.cos(echo.angle) * spread * Math.sin(echoT * Math.PI * 0.5);
        const echoY = this.glyph.y + Math.sin(echo.angle) * spread * Math.sin(echoT * Math.PI * 0.5);
        echo.text.position.set(
          Math.min(Math.max(echoX, this.originX + echoMargin), this.originX + this.boardWidth - echoMargin),
          Math.min(Math.max(echoY, this.originY + echoMargin), this.originY + this.boardHeight - echoMargin),
        );
        echo.text.scale.set(scale * (0.86 - i * 0.1));
        echo.text.rotation = -echo.angle * 0.06 + tilt * 0.5;
        echo.text.alpha = glyphAlpha * (i === 0 ? 0.28 : 0.18);
      }
    }

    if (t >= 1) this.done = true;
  }

  /** Shake offset the scene applies to the board container this frame. */
  shake() {
    if (this.lowMotion) return { x: 0, y: 0 };
    const t = Math.min(1, this.age / this.duration);
    if (t > 0.5) return { x: 0, y: 0 };
    // Decaying random walk with a directional bias: the board is knocked, then settles.
    const magnitude = (6 + (this.tier - 1) * 2.3) * (1 - t * 2);
    return { x: (Math.random() - 0.5) * magnitude * 2, y: (Math.random() - 0.5) * magnitude * 2 };
  }

  destroy() {
    this.view.destroy({ children: true });
  }
}

/**
 * A translucent piece that retraces a move for a replay or a successful undo.
 *
 * The authoritative pieces still jump/rebuild on undo snapshots; this ghost supplies the
 * spatial continuity the player actually sees. Replay ghosts warm toward gold, while undo
 * ghosts pull a vermilion thread back to the origin and collapse at the end.
 */
export class GhostMoveEffect {
  constructor({
    from,
    to,
    glyph = "",
    colour = PALETTE.red,
    kind = 0,
    radius = 34,
    lowMotion = false,
    mode = "replay",
    duration,
  }) {
    this.from = from;
    this.to = to;
    this.glyph = glyph;
    this.colour = colour;
    this.kind = kind;
    this.radius = radius;
    this.lowMotion = lowMotion;
    this.mode = mode;
    this.age = 0;
    this.duration =
      Number.isFinite(duration) && duration > 0
        ? duration
        : lowMotion
          ? 0.32
          : mode === "undo"
            ? 0.86
            : 1.05;
    this.done = false;
    this.view = new Container();
    this.trail = new Graphics();
    this.aura = new Graphics();
    this.body = new Container();
    this.disc = new Graphics();
    this.body.addChild(this.disc);
    if (glyph) {
      this.text = new Text({
        text: glyph,
        style: new TextStyle({
          fontFamily: "Songti SC, SimSun, STSong, serif",
          fontSize: radius * 1.22,
          fontWeight: "600",
          fill: colour,
        }),
      });
      this.text.anchor.set(0.5);
      this.text.position.set(0, radius * 0.04);
      this.body.addChild(this.text);
    }
    this.disc
      .circle(0, 0, radius)
      .fill({ color: PALETTE.paper, alpha: 0.86 })
      .stroke({ width: 2.4, color: colour, alpha: 0.88 });
    this.view.addChild(this.trail, this.aura, this.body);
  }

  update(dt) {
    this.age += dt;
    const t = Math.min(1, this.age / this.duration);
    const eased = this.mode === "undo" ? 1 - Math.pow(1 - t, 3) : easeOutCubic(t);
    const dx = this.to.x - this.from.x;
    const dy = this.to.y - this.from.y;
    const distance = Math.hypot(dx, dy) || 1;
    const arc = this.kind === PIECE.horse ? Math.sin(t * Math.PI) * this.radius * 0.8 : 0;
    const x = this.from.x + dx * eased - (dy / distance) * arc;
    const y = this.from.y + dy * eased + (dx / distance) * arc;

    this.body.position.set(x, y);
    this.body.scale.set(this.lowMotion ? 1 : 1 + Math.sin(t * Math.PI) * 0.08);
    const fadeIn = Math.min(1, this.age / 0.06);
    const fadeOut = this.mode === "undo" ? Math.max(0, 1 - Math.pow(Math.max(0, t - 0.78) / 0.22, 2)) : Math.max(0, 1 - Math.pow(Math.max(0, t - 0.86) / 0.14, 2));
    this.body.alpha = this.lowMotion ? 0.72 * fadeIn * fadeOut : 0.9 * fadeIn * fadeOut;
    this.body.rotation = Math.sin(t * Math.PI) * (this.mode === "undo" ? -0.12 : 0.08);

    this.trail.clear();
    this.aura.clear();
    if (this.lowMotion) {
      this.trail
        .moveTo(this.from.x, this.from.y)
        .lineTo(this.to.x, this.to.y)
        .stroke({ width: 2, color: this.mode === "undo" ? PALETTE.red : PALETTE.gold, alpha: (1 - t) * 0.5 });
    } else {
      const steps = 18;
      for (let i = 0; i < steps; i++) {
        const t0 = (i / steps) * eased;
        const t1 = Math.min(eased, ((i + 1) / steps) * eased);
        if (t1 <= t0) continue;
        const x0 = this.from.x + dx * t0;
        const y0 = this.from.y + dy * t0;
        const x1 = this.from.x + dx * t1;
        const y1 = this.from.y + dy * t1;
        this.trail
          .moveTo(x0, y0)
          .lineTo(x1, y1)
          .stroke({
            width: this.radius * (0.08 + t0 * 0.22),
            color: this.mode === "undo" ? this.colour : PALETTE.gold,
            alpha: (1 - t) * (0.2 + t0 * 0.55),
          });
      }
      const auraR = this.radius * (1.2 + Math.sin(t * Math.PI) * 0.42);
      this.aura
        .circle(x, y, auraR)
        .stroke({
          width: this.mode === "undo" ? 2.8 : 2,
          color: this.mode === "undo" ? PALETTE.red : PALETTE.gold,
          alpha: (1 - t) * 0.58,
        });
      if (this.mode === "undo") {
        for (let i = 0; i < 3; i++) {
          const a = this.age * 4.2 + (Math.PI * 2 * i) / 3;
          this.aura
            .arc(x, y, auraR * (1.1 + i * 0.18), a, a + 0.76)
            .stroke({ width: 2, color: i === 1 ? PALETTE.gold : PALETTE.red, alpha: (1 - t) * 0.52 });
        }
      }
    }

    if (t >= 1) this.done = true;
  }

  destroy() {
    this.view.destroy({ children: true });
  }
}

/**
 * LastMoveEffect marks the most recent move: a breathing glow pooled under the arriving
 * piece, a gold rim on top of it, and a tapered ink trail back to where it came from.
 *
 * The glow is the part that was missing. A thin ring alone disappears against a busy board
 * at a glance; a soft pool of warm light is findable from across the room and does not
 * compete with the pieces.
 */
export class LastMoveEffect {
  constructor({ from, to, radius, lowMotion = false, seed, duration, wave = false }) {
    this.lowMotion = lowMotion;
    this.wave = wave;
    this.age = 0;
    // The automatic cue is intentionally brief. The manual "last move" control can request
    // a longer replay without changing the normal move rhythm for every player.
    this.duration =
      Number.isFinite(duration) && duration > 0 ? duration : lowMotion ? 0.4 : 2.6;
    this.done = false;
    this.view = new Container();
    this.glow = new Graphics();
    this.halo = new Graphics();
    this.trail = new Graphics();
    this.ring = new Graphics();
    this.view.addChild(this.glow, this.halo, this.trail, this.ring);
    this.from = from;
    this.to = to;
    this.radius = radius;

    const rand = mulberry32(seed ?? nextSeed());
    this.blotRadii = blobRadii(rand, 15, 0.09);
  }

  update(dt) {
    this.age += dt;
    const t = Math.min(1, this.age / this.duration);

    this.glow.clear();
    this.halo.clear();
    this.trail.clear();
    this.ring.clear();

    // Gomoku uses one bright halo for both sides. A ring in the mover's ink colour vanishes
    // for black against the grid and for white against the paper.
    if (this.wave) {
      const waveDuration = this.lowMotion ? 0.3 : 0.82;
      const waveT = Math.min(1, this.age / waveDuration);
      const spread = 1 - Math.pow(1 - waveT, 3);
      const fade = Math.pow(1 - waveT, 1.25);
      const ringRadius = this.radius * (1.35 + spread * 7.65);
      for (let i = 0; i < 3; i++) {
        this.halo
          .circle(this.to.x, this.to.y, ringRadius * (1 - i * 0.025))
          .stroke({
            width: this.radius * (0.68 - i * 0.16),
            color: 0xfff7e7,
            alpha: (0.28 - i * 0.055) * fade,
          });
      }
      this.halo
        .circle(this.to.x, this.to.y, ringRadius)
        .stroke({ width: 1.8, color: GOLD, alpha: 0.36 * fade });
    }

    if (this.lowMotion) {
      const alpha = (1 - t) * 0.45;
      this.ring.circle(this.to.x, this.to.y, this.radius * 1.12).stroke({ width: 2, color: GOLD, alpha });
      if (this.age >= this.duration) this.done = true;
      return;
    }

    // Breathing: slow, shallow, asymmetric — the marker inhales and holds rather than
    // pulsing at a constant rate, which would read as an alarm.
    const breath = 0.72 + Math.sin(this.age * 2.4) * 0.16 + Math.sin(this.age * 4.1) * 0.05;
    const life = 1 - Math.pow(t, 3);

    // Pooled glow: three stacked, shrinking discs. Layering alpha is how you get a soft
    // falloff with flat fills.
    const r0 = this.radius * 1.9 * breath;
    for (let i = 0; i < 3; i++) {
      const k = 1 - i * 0.26;
      this.glow
        .poly(radiiToPoints(this.blotRadii, r0 * k, 1, this.to.x, this.to.y), true)
        .fill({ color: GOLD, alpha: 0.11 * life * (1 - i * 0.24) });
    }

    // Trail: a thin tapered stroke, not a wedge. The first version was wide enough to read
    // as a solid arrow, which competed with the pieces; a brush mark the width of a line
    // label reads as a trace of motion and leaves the board legible.
    if (this.from) {
      const dx = this.to.x - this.from.x;
      const dy = this.to.y - this.from.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const trailAlpha = 0.42 * life;
      const steps = 10;
      for (let s = 0; s < steps; s++) {
        const t0 = s / steps;
        const t1 = (s + 1) / steps;
        // Width tapers from the origin to nothing; a sine bump adds the swell a brush
        // leaves where it touches down and lifts off.
        const w0 = this.radius * 0.13 * (1 - t0) * (0.6 + Math.sin(t0 * Math.PI) * 0.8);
        const w1 = this.radius * 0.13 * (1 - t1) * (0.6 + Math.sin(t1 * Math.PI) * 0.8);
        const x0 = this.from.x + dx * t0;
        const y0 = this.from.y + dy * t0;
        const x1 = this.from.x + dx * t1;
        const y1 = this.from.y + dy * t1;
        this.trail
          .poly([x0 + nx * w0, y0 + ny * w0, x1 + nx * w1, y1 + ny * w1, x1 - nx * w1, y1 - ny * w1, x0 - nx * w0, y0 - ny * w0], true)
          .fill({ color: GOLD, alpha: trailAlpha * (0.45 + Math.sin(t0 * Math.PI) * 0.55) });
      }
    }

    // Rim: double stroke, breathing with the glow.
    const rimR = this.radius * (1.1 + breath * 0.06);
    this.ring.circle(this.to.x, this.to.y, rimR).stroke({ width: 3.2, color: GOLD, alpha: 0.55 * life * breath });
    this.ring.circle(this.to.x, this.to.y, rimR * 1.16).stroke({ width: 1.2, color: GOLD, alpha: 0.3 * life });

    if (t >= 1) this.done = true;
  }

  destroy() {
    this.view.destroy({ children: true });
  }
}

/**
 * WinEffect draws the winning line as a brush stroke that grows stone by stone, then stamps
 * a seal onto the paper.
 *
 * The line is a tapered ink stroke with a wobbling spine, not a straight gold bar: a bar
 * looks like a UI decoration, a stroke looks like someone marked the board.
 */
export class WinEffect {
  constructor({ points, sealAt, step = 64, lowMotion = false, seed, sealGlyph }) {
    this.lowMotion = lowMotion;
    this.age = 0;
    // Four beats: draw, hold, stamp, settle.
    this.growDuration = lowMotion ? 0.2 : 0.85;
    this.holdDuration = lowMotion ? 0.1 : 0.35;
    this.stampDuration = lowMotion ? 0.3 : 0.7;
    this.done = false;
    this.view = new Container();
    this.line = new Graphics();
    this.view.addChild(this.line);
    // The line belongs behind the stones; the seal must land on top of them. One container
    // cannot be in both layers, so the seal rides in its own overlay.
    this.overlayView = new Container();
    // A group carries the placement and tilt so the carved glyph can rotate with the block;
    // a Graphics cannot own a Text child.
    this.sealGroup = new Container();
    this.seal = new Graphics();
    this.sealGlyph = sealGlyph;
    this.sealGroup.addChild(this.seal);
    this.overlayView.addChild(this.sealGroup);
    this.points = points || [];
    this.step = step;
    this.sealAt = sealAt || (this.points.length ? this.points[this.points.length - 1] : null);
    // The connecting line reads as a highlight on the board, so it goes under the pieces.
    this.under = true;

    const rand = mulberry32(seed ?? nextSeed());
    // The seal is drawn with a fresh jitter each stamp, so two victories a session apart do
    // not produce an identical mark. Kept in its own generator so the body and frame jitter
    // independently.
    this.sealRand = () => rand();
    this.sealText = null;
    if (!lowMotion) {
      // Sized to the inner carve, not the block: the character sits inside the cut frame.
      const glyphSize = this.step * 0.62;
      this.sealText = new Text({
        text: this.sealGlyph || "胜",
        style: new TextStyle({
          fontFamily: "Songti SC, SimSun, STSong, serif",
          fontSize: glyphSize,
          fontWeight: "700",
          fill: PALETTE.paper,
        }),
      });
      this.sealText.anchor.set(0.5);
      this.sealText.alpha = 0;
      this.sealGroup.addChild(this.sealText);
    }
    this.sealChips = [];
    for (let i = 0; i < 7; i++) {
      this.sealChips.push({
        angle: rand() * Math.PI * 2,
        radius: 0.62 + rand() * 0.3,
        size: 0.05 + rand() * 0.08,
      });
    }
    this.sealTilt = (rand() - 0.5) * 0.16;
  }

  update(dt) {
    this.age += dt;
    const growEnd = this.growDuration;
    const holdEnd = growEnd + this.holdDuration;

    this.line.clear();

    // Phase one: the stroke is laid down segment by segment, with a brush tip at the front.
    const growT = Math.min(1, this.age / growEnd);
    if (!this.lowMotion && this.points.length > 1) {
      const segments = this.points.length - 1;
      const drawn = growT * segments;
      const w = this.step * 0.14;
      for (let i = 0; i < segments; i++) {
        if (i >= drawn) break;
        const a = this.points[i];
        const b = this.points[i + 1];
        const local = Math.min(1, drawn - i);
        const ex = a.x + (b.x - a.x) * local;
        const ey = a.y + (b.y - a.y) * local;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;

        // Taper within each segment: thin at the seam, thick in the middle. Chaining those
        // gives the whole line a calligraphic width rhythm instead of a constant bar.
        const steps = 6;
        for (let s = 0; s < steps; s++) {
          const t0 = s / steps;
          const t1 = (s + 1) / steps;
          if (s / steps > local) break;
          const px0 = a.x + (ex - a.x) * t0;
          const py0 = a.y + (ey - a.y) * t0;
          const px1 = a.x + (ex - a.x) * Math.min(t1, local);
          const py1 = a.y + (ey - a.y) * Math.min(t1, local);
          const mid = (t0 + t1) / 2;
          const width = w * (0.55 + Math.sin(mid * Math.PI) * 0.8);
          this.line
            .poly(
              [
                px0 + nx * width,
                py0 + ny * width,
                px1 + nx * width,
                py1 + ny * width,
                px1 - nx * width,
                py1 - ny * width,
                px0 - nx * width,
                py0 - ny * width,
              ],
              true,
            )
            .fill({ color: PALETTE.ink, alpha: 0.7 });
        }
        this.line
          .poly(
            [a.x + nx * w * 0.35, a.y + ny * w * 0.35, ex + nx * w * 0.2, ey + ny * w * 0.2, ex - nx * w * 0.2, ey - ny * w * 0.2, a.x - nx * w * 0.35, a.y - ny * w * 0.35],
            true,
          )
          .fill({ color: PALETTE.gold, alpha: 0.75 });
      }

      // Brush tip: a bright head that leads the stroke, then vanishes when the line lands.
      if (growT < 1) {
        const tipIndex = Math.min(segments - 1, Math.floor(drawn));
        const a = this.points[tipIndex];
        const b = this.points[Math.min(segments, tipIndex + 1)];
        const local = Math.min(1, drawn - tipIndex);
        const tx = a.x + (b.x - a.x) * local;
        const ty = a.y + (b.y - a.y) * local;
        this.line.circle(tx, ty, w * 1.6).fill({ color: PALETTE.gold, alpha: 0.5 });
        this.line.circle(tx, ty, w * 0.8).fill({ color: 0xfff2cf, alpha: 0.8 });
      }
    } else if (this.lowMotion && this.points.length > 1) {
      const first = this.points[0];
      const last = this.points[this.points.length - 1];
      this.line.moveTo(first.x, first.y).lineTo(last.x, last.y).stroke({ width: 3, color: PALETTE.gold, alpha: 0.6 });
    }

    // Phase two: the seal. It arrives oversized, tilts, and sinks into the paper.
    this.seal.clear();
    if (this.sealAt && this.age >= holdEnd) {
      const stampT = Math.min(1, (this.age - holdEnd) / this.stampDuration);
      const overshoot = this.lowMotion ? 1 : 1.24 - 0.24 * Math.min(1, stampT * 1.6);
      const scale = overshoot * (0.94 + Math.min(1, stampT) * 0.06);
      const alpha = Math.min(1, stampT * 2.2);
      const size = this.step * 0.72 * scale;
      const cx = this.sealAt.x;
      const cy = this.sealAt.y;
      const tilt = this.sealTilt * (1 + (1 - stampT) * 0.8);

      this.sealGroup.position.set(cx, cy);
      this.sealGroup.rotation = tilt;

      // A carved block pressed into paper leaves the paper slightly raised around it, not
      // just ink on top. A drop shadow offset down-right with a tight blur reads as that
      // relief; without it the seal looks pasted on.
      if (!this.sealShadowApplied && stampT > 0.35) {
        try {
          this.sealGroup.filters = [
            new DropShadowFilter({
              offset: { x: Math.max(1, size * 0.045), y: Math.max(1, size * 0.055) },
              blur: Math.max(2, size * 0.05),
              alpha: 0.32,
              color: 0x2a1815,
              quality: 3,
            }),
          ];
          this.sealShadowApplied = true;
        } catch {
          // A missing shadow costs depth, nothing else.
          this.sealShadowApplied = true;
        }
      }

      // Press impression first: a darker, slightly offset silhouette, as if the block
      // rocked when it was struck. Drawn before the body so the body covers most of it and
      // only a shadow rim survives on one side.
      const press = sealOutline(size * 1.06, 0.02, this.sealRand);
      this.seal
        .poly(
          press.map((v, i) => (i % 2 === 0 ? v + size * 0.045 : v + size * 0.055)),
          true,
        )
        .fill({ color: 0x6d1f18, alpha: alpha * 0.32 });

      // Body of the stamp. Two passes at different jitter read as uneven ink coverage
      // rather than a flat red blob.
      this.seal.poly(sealOutline(size, 0.035, this.sealRand), true).fill({ color: PALETTE.seal, alpha: alpha * 0.9 });
      this.seal.poly(sealOutline(size * 0.95, 0.05, this.sealRand), true).fill({ color: PALETTE.seal, alpha: alpha * 0.3 });

      // Carved frame: paper colour cut out of the block, leaving a border of red.
      this.seal
        .poly(sealOutline(size * 0.8, 0.02, this.sealRand), true)
        .stroke({ width: Math.max(2, size * 0.055), color: PALETTE.paper, alpha: alpha * 0.8 });

      // The character itself, cut out of the block in paper colour. A seal with no glyph is
      // just a red dot; the glyph is what makes it read as 朱印.
      if (this.sealText) {
        this.sealText.alpha = alpha;
        this.sealText.position.set(0, 0);
        this.sealText.scale.set(1);
      }

      // Chips: places where the block did not take ink.
      for (const chip of this.sealChips) {
        this.seal
          .circle(Math.cos(chip.angle) * size * chip.radius, Math.sin(chip.angle) * size * chip.radius, size * chip.size)
          .fill({ color: PALETTE.paper, alpha: alpha * 0.55 });
      }
    }

    if (this.age >= holdEnd + this.stampDuration) this.done = true;
  }

  destroy() {
    this.view.destroy({ children: true });
    this.overlayView.destroy({ children: true });
  }
}

/**
 * Cracks the losing palace when a Xiangqi game ends.
 *
 * The victory seal is a stamp on top of the board; this effect is the board giving way
 * underneath it. Fourteen irregular fractures radiate from the defeated general, with a
 * suspended ring of ink dust between the first crack and the final seal.
 */
export class VictoryFractureEffect {
  constructor({ center, step = 64, lowMotion = false, seed }) {
    this.lowMotion = lowMotion;
    this.age = 0;
    this.duration = lowMotion ? 0.5 : 2.15;
    this.done = false;
    this.center = center;
    this.step = step;
    this.view = new Container();
    this.cracks = new Graphics();
    this.rings = new Graphics();
    this.dust = new Graphics();
    this.view.addChild(this.cracks, this.rings, this.dust);

    const rand = mulberry32(seed ?? nextSeed());
    this.fractures = [];
    const count = lowMotion ? 0 : 14;
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + (rand() - 0.5) * 0.5;
      const branches = [];
      let a = angle;
      let distance = 0;
      const total = step * (1.2 + rand() * 4.2);
      while (distance < total) {
        const run = step * (0.2 + rand() * 0.46);
        distance = Math.min(total, distance + run);
        a += (rand() - 0.5) * 0.34;
        branches.push({
          x: Math.cos(a) * distance,
          y: Math.sin(a) * distance,
          at: distance / total,
        });
      }
      this.fractures.push({
        branches,
        delay: rand() * 0.18,
        width: 1.3 + rand() * 2.5,
      });
    }
    this.motes = [];
    for (let i = 0; i < (lowMotion ? 0 : 30); i++) {
      this.motes.push({
        angle: rand() * Math.PI * 2,
        radius: step * (0.7 + rand() * 3.6),
        size: step * (0.014 + rand() * 0.035),
        delay: rand() * 0.35,
      });
    }
  }

  update(dt) {
    this.age += dt;
    const t = Math.min(1, this.age / this.duration);
    this.cracks.clear();
    this.rings.clear();
    this.dust.clear();

    const settle = Math.max(0, 1 - Math.max(0, this.age - 1.15) / 1);
    if (this.lowMotion) {
      this.rings
        .circle(this.center.x, this.center.y, this.step * (0.7 + t * 1.4))
        .stroke({ width: 2, color: PALETTE.red, alpha: (1 - t) * 0.5 });
    } else {
      const shock = Math.min(1, this.age / 0.7);
      for (let i = 0; i < 3; i++) {
        const r = this.step * (0.5 + Math.pow(shock, 0.6) * (2.2 + i * 0.86));
        this.rings
          .circle(this.center.x, this.center.y, r)
          .stroke({
            width: 5 - i,
            color: i === 0 ? PALETTE.gold : PALETTE.red,
            alpha: Math.pow(1 - shock, 1.3) * (0.7 - i * 0.14),
          });
      }

      for (const fracture of this.fractures) {
        const local = Math.max(0, this.age - fracture.delay) / 0.62;
        if (local <= 0) continue;
        const reveal = Math.min(1, local);
        let previous = { x: 0, y: 0 };
        for (const branch of fracture.branches) {
          if (branch.at > reveal) break;
          this.cracks
            .moveTo(this.center.x + previous.x, this.center.y + previous.y)
            .lineTo(this.center.x + branch.x, this.center.y + branch.y)
            .stroke({
              width: fracture.width * (1 - branch.at * 0.45),
              color: PALETTE.ink,
              alpha: settle * 0.78,
            });
          this.cracks
            .moveTo(this.center.x + previous.x, this.center.y + previous.y)
            .lineTo(this.center.x + branch.x, this.center.y + branch.y)
            .stroke({
              width: Math.max(1, fracture.width * 0.34),
              color: PALETTE.red,
              alpha: settle * 0.58,
            });
          previous = branch;
        }
      }

      for (const mote of this.motes) {
        const local = Math.max(0, this.age - mote.delay) / 1.45;
        if (local <= 0 || local >= 1) continue;
        const travel = mote.radius * Math.pow(local, 0.56);
        const angle = mote.angle + local * 0.9;
        const x = this.center.x + Math.cos(angle) * travel;
        const y = this.center.y + Math.sin(angle) * travel * 0.78;
        this.dust
          .circle(x, y, mote.size * (1 - local * 0.5))
          .fill({ color: local < 0.45 ? PALETTE.gold : PALETTE.red, alpha: (1 - local) * 0.78 * settle });
      }
    }

    if (t >= 1) this.done = true;
  }

  destroy() {
    this.view.destroy({ children: true });
  }
}

/**
 * UndoTimeline holds the effect list so an undo can rewind the last few seconds of ink.
 *
 * Rather than playing effects backwards, the scene simply clears transient effects and
 * lets the board redraw: a rewind that replays stale particles would show pieces that no
 * longer exist.
 */
export function clearTransient(effects) {
  for (const effect of effects) {
    effect.destroy();
  }
  effects.length = 0;
}
