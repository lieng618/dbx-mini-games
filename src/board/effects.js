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
 */
export class CaptureBurstEffect {
  constructor({ x, y, radius, colour = PALETTE.ink, lowMotion = false, seed }) {
    this.lowMotion = lowMotion;
    this.age = 0;
    this.duration = lowMotion ? 0.32 : 0.95;
    this.done = false;
    this.view = new Container();
    this.view.position.set(x, y);
    this.blots = new Graphics();
    this.hairs = new Graphics();
    this.shock = new Graphics();
    this.view.addChild(this.shock, this.hairs, this.blots);

    this.radius = radius;
    this.colour = colour;
    /** One array reused for every polygon: no per-frame allocation. */
    this.scratch = [];

    const rand = mulberry32(seed ?? nextSeed());
    // 34 was chosen when every particle reallocated its polygon every frame. The shapes are
    // now cached per particle, so the cost is fill rate rather than GC pressure and the
    // burst can carry enough debris to read as shattering instead of as confetti.
    const count = lowMotion ? 0 : 52;
    this.particles = [];
    for (let i = 0; i < count; i++) {
      // Even angular distribution with jitter: a perfect fan looks synthetic, and pure
      // random clumps. Sorted-angle placement with noise keeps coverage but kills the grid.
      const angle = (Math.PI * 2 * i) / count + (rand() - 0.5) * 0.7;
      const speed = radius * (0.7 + Math.pow(rand(), 0.6) * 3.2);
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

    // Shock: the pale ring the piece leaves as it clears the square.
    if (!this.lowMotion) {
      const shockR = this.radius * (0.6 + Math.pow(t, 0.5) * 2.4);
      this.shock
        .circle(0, 0, shockR)
        .stroke({ width: 2.6, color: this.colour, alpha: (1 - t) * 0.3 });
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
        const len = Math.min(this.radius * 1.5, Math.hypot(p.vx, p.vy) * 0.06);
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
              p.x - p.vx * len,
              p.y - p.vy * len,
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
 * Breaks the captured piece itself into rim wedges and chips.
 *
 * The burst alone reads as a puff of dust next to a piece that politely shrinks. Shattering
 * the disc means the thing you were hunting visibly comes apart, which is the part players
 * actually feel. Wedges are cut from the piece's own ring so the fragments keep its colour
 * and its curvature instead of turning into generic confetti.
 */
export class ShatterEffect {
  constructor({ x, y, radius, colour = PALETTE.ink, lowMotion = false, seed }) {
    this.lowMotion = lowMotion;
    this.age = 0;
    this.duration = lowMotion ? 0.26 : 0.72;
    this.done = false;
    this.view = new Container();
    this.view.position.set(x, y);
    this.ink = new Graphics();
    this.view.addChild(this.ink);

    this.radius = radius;
    this.colour = colour;
    this.scratch = [];

    const rand = mulberry32(seed ?? nextSeed());
    const wedgeCount = lowMotion ? 0 : 11;
    this.wedges = [];
    const sector = (Math.PI * 2) / wedgeCount;
    for (let i = 0; i < wedgeCount; i++) {
      const start = sector * i;
      // A little gap between wedges: a closed ring only looks like a shrinking donut.
      const span = sector * (0.52 + rand() * 0.3);
      const mid = start + span / 2;
      const speed = radius * (1.5 + rand() * 2.6);
      this.wedges.push({
        start,
        span,
        inner: radius * (0.5 + rand() * 0.14),
        outer: radius * (0.9 + rand() * 0.08),
        x: 0,
        y: 0,
        vx: Math.cos(mid) * speed,
        vy: Math.sin(mid) * speed - radius * 0.9,
        rot: 0,
        spin: (rand() - 0.5) * 10,
        life: 0.6 + rand() * 0.4,
      });
    }

    const chipCount = lowMotion ? 0 : 16;
    this.chips = [];
    for (let i = 0; i < chipCount; i++) {
      const angle = rand() * Math.PI * 2;
      const speed = radius * (2 + rand() * 4);
      this.chips.push({
        x: 0,
        y: 0,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - radius * 1.4,
        size: radius * (0.05 + rand() * 0.09),
        radii: blobRadii(rand, 6 + Math.round(rand() * 3), 0.3),
        unit: null,
        life: 0.45 + rand() * 0.4,
      });
    }
  }

  update(dt) {
    this.age += dt;
    const t = Math.min(1, this.age / this.duration);
    this.ink.clear();

    for (const w of this.wedges) {
      const local = Math.min(1, this.age / (this.duration * w.life));
      if (local >= 1) continue;
      w.vx *= Math.pow(0.34, dt);
      w.vy *= Math.pow(0.34, dt);
      w.vy += this.radius * 5.2 * dt;
      w.x += w.vx * dt;
      w.y += w.vy * dt;
      w.rot += w.spin * dt;

      const alpha = Math.pow(1 - local, 1.2);
      if (alpha < 0.02) continue;

      // Cut each wedge from its own arc so the fragment keeps the piece's curvature.
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
      const local = Math.min(1, this.age / (this.duration * c.life));
      if (local >= 1) continue;
      c.vx *= Math.pow(0.4, dt);
      c.vy *= Math.pow(0.4, dt);
      c.vy += this.radius * 6 * dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      const alpha = Math.pow(1 - local, 1.4) * 0.9;
      if (alpha < 0.02) continue;
      if (!c.unit) c.unit = radiiToPoints(c.radii, 1, 1, 0, 0);
      const pts = this.scratch;
      pts.length = 0;
      for (let i = 0; i < c.unit.length; i += 2) {
        pts.push(c.x + c.unit[i] * c.size, c.y + c.unit[i + 1] * c.size);
      }
      this.ink.poly(pts, true).fill({ color: this.colour, alpha });
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
  constructor({ boardWidth, boardHeight, originX = 0, originY = 0, focus, step = 64, lowMotion = false, seed }) {
    this.lowMotion = lowMotion;
    this.age = 0;
    this.duration = lowMotion ? 0.55 : 1.35;
    this.done = false;
    this.view = new Container();
    this.rim = new Graphics();
    this.view.addChild(this.rim);
    this.focus = focus;
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

    if (!lowMotion) {
      // The spray sits under the character: ink hitting the page behind the brush.
      this.spray = new Graphics();
      this.spray.position.set(0, 0);
      this.view.addChild(this.spray);
      this.spraySeeds = [];
      for (let i = 0; i < 16; i++) {
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
    }

    if (t >= 1) this.done = true;
  }

  /** Shake offset the scene applies to the board container this frame. */
  shake() {
    if (this.lowMotion) return { x: 0, y: 0 };
    const t = Math.min(1, this.age / this.duration);
    if (t > 0.5) return { x: 0, y: 0 };
    // Decaying random walk with a directional bias: the board is knocked, then settles.
    const magnitude = 6 * (1 - t * 2);
    return { x: (Math.random() - 0.5) * magnitude * 2, y: (Math.random() - 0.5) * magnitude * 2 };
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
  constructor({ from, to, radius, lowMotion = false, seed }) {
    this.lowMotion = lowMotion;
    this.age = 0;
    this.duration = lowMotion ? 0.4 : 2.6;
    this.done = false;
    this.view = new Container();
    this.glow = new Graphics();
    this.trail = new Graphics();
    this.ring = new Graphics();
    this.view.addChild(this.glow, this.trail, this.ring);
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
    this.trail.clear();
    this.ring.clear();

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
