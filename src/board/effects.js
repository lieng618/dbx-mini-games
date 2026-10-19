/**
 * Ink-effect toolkit for the board.
 *
 * Every effect here is a short-lived object with an `update(dt)` method and a `done` flag.
 * The scene owns a list of them and drops finished ones. Effects only ever read board
 * state they are handed; they never decide anything about the game.
 *
 * Each effect honours the low-motion setting: pixels, shake, and long trails collapse into
 * a single short fade so the board stays readable for players who need less movement.
 */

import { Container, Graphics } from "pixi.js";

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

/**
 * RippleEffect draws an expanding ink halo at the point where a stone or piece landed.
 *
 * Xiangqi lands with a heavier, inkier ring; gomoku lands like a stone in water.
 */
export class RippleEffect {
  constructor({ x, y, radius, heavy = false, lowMotion = false }) {
    this.lowMotion = lowMotion;
    this.age = 0;
    this.duration = lowMotion ? 0.34 : heavy ? 0.95 : 0.72;
    this.maxRadius = radius * (heavy ? 2.1 : 1.8);
    this.heavy = heavy;
    this.done = false;
    this.view = new Container();
    this.view.position.set(x, y);
    this.ring = new Graphics();
    this.view.addChild(this.ring);
  }

  update(dt) {
    this.age += dt;
    const t = Math.min(1, this.age / this.duration);
    // Ease-out: fast start, long tail, like ink spreading on paper.
    const eased = 1 - Math.pow(1 - t, 3);
    const r = this.maxRadius * eased;
    const alpha = this.lowMotion ? (1 - t) * 0.5 : (1 - t) * 0.8;
    const width = this.heavy ? 3.2 : 2.4;

    this.ring.clear();
    this.ring.circle(0, 0, r).stroke({ width, color: this.heavy ? PALETTE.red : PALETTE.ink, alpha });
    if (!this.lowMotion) {
      this.ring.circle(0, 0, r * 0.62).stroke({ width: width * 0.5, color: PALETTE.ink, alpha: alpha * 0.45 });
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
 * The particles are pooled into one Graphics redraw per frame rather than many sprites: a
 * few dozen small circles cost less than sprite churn, and the pieces are simple shapes.
 */
export class CaptureBurstEffect {
  constructor({ x, y, radius, colour = PALETTE.ink, lowMotion = false }) {
    this.lowMotion = lowMotion;
    this.age = 0;
    this.duration = lowMotion ? 0.3 : 0.85;
    this.done = false;
    this.view = new Container();
    this.view.position.set(x, y);
    this.graphics = new Graphics();
    this.view.addChild(this.graphics);

    const count = lowMotion ? 6 : 22;
    this.particles = [];
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
      const speed = radius * (0.9 + Math.random() * 2.4);
      this.particles.push({
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: radius * (0.05 + Math.random() * 0.11),
        spin: Math.random() * Math.PI,
      });
    }
    this.radius = radius;
    this.colour = colour;
  }

  update(dt) {
    this.age += dt;
    const t = Math.min(1, this.age / this.duration);
    const alpha = (1 - t) * 0.9;
    // Drag plus gravity gives dust that arcs and settles instead of shooting straight out.
    const drag = Math.pow(0.12, dt);
    this.graphics.clear();
    for (const p of this.particles) {
      p.vx *= drag;
      p.vy *= drag;
      p.vy += this.radius * 1.6 * dt;
      p.x = (p.x || 0) + p.vx * dt;
      p.y = (p.y || 0) + p.vy * dt;
      this.graphics.circle(p.x, p.y, p.size * (1 - t * 0.4)).fill({ color: this.colour, alpha });
    }
    if (t >= 1) this.done = true;
  }

  destroy() {
    this.view.destroy({ children: true });
  }
}

/**
 * CheckEffect announces check: a red rim breathing around the board, a short camera shake,
 * and a calligraphic burst behind the threatened general.
 *
 * This is the loudest effect in the product, which is why it has the most aggressive
 * low-motion form — a single soft rim pulse, no shake, no glyph.
 */
export class CheckEffect {
  constructor({ boardWidth, boardHeight, focus, lowMotion = false }) {
    this.lowMotion = lowMotion;
    this.age = 0;
    this.duration = lowMotion ? 0.5 : 1.15;
    this.done = false;
    this.view = new Container();
    this.rim = new Graphics();
    this.view.addChild(this.rim);
    this.focus = focus;
    this.boardWidth = boardWidth;
    this.boardHeight = boardHeight;

    this.glyph = null;
    if (!lowMotion && focus) {
      this.glyph = new Graphics();
      this.glyph.position.set(focus.x, focus.y);
      this.view.addChild(this.glyph);
    }
  }

  update(dt) {
    this.age += dt;
    const t = Math.min(1, this.age / this.duration);
    // Two quick breaths, then fade: reads as an alarm without becoming a strobe.
    const breath = this.lowMotion ? 1 - t : Math.abs(Math.sin(t * Math.PI * 2));
    const alpha = (1 - t) * (this.lowMotion ? 0.4 : 0.85) * (0.55 + breath * 0.45);

    this.rim.clear();
    this.rim
      .roundRect(0, 0, this.boardWidth, this.boardHeight, 18)
      .stroke({ width: 5, color: PALETTE.red, alpha });

    if (this.glyph && this.focus) {
      const scale = 0.6 + Math.min(1, t * 2.2) * 1.5;
      const glyphAlpha = (1 - t) * 0.75;
      this.glyph.clear();
      this.glyph.circle(0, 0, 62 * scale).fill({ color: PALETTE.red, alpha: glyphAlpha * 0.22 });
      this.glyph.circle(0, 0, 62 * scale).stroke({ width: 2.4, color: PALETTE.red, alpha: glyphAlpha });
    }

    if (t >= 1) this.done = true;
  }

  /** Shake offset the scene applies to the board container this frame. */
  shake() {
    if (this.lowMotion) return { x: 0, y: 0 };
    const t = Math.min(1, this.age / this.duration);
    if (t > 0.5) return { x: 0, y: 0 };
    const magnitude = 5 * (1 - t * 2);
    return { x: (Math.random() - 0.5) * magnitude * 2, y: (Math.random() - 0.5) * magnitude * 2 };
  }

  destroy() {
    this.view.destroy({ children: true });
  }
}

/**
 * LastMoveEffect marks the most recent move: a gold outline on the arriving piece and an
 * ink trail from origin to destination.
 */
export class LastMoveEffect {
  constructor({ from, to, radius, lowMotion = false }) {
    this.lowMotion = lowMotion;
    this.age = 0;
    this.duration = lowMotion ? 0.4 : 1.8;
    this.done = false;
    this.view = new Container();
    this.graphics = new Graphics();
    this.view.addChild(this.graphics);
    this.from = from;
    this.to = to;
    this.radius = radius;
  }

  update(dt) {
    this.age += dt;
    const t = Math.min(1, this.age / this.duration);
    // A slow 2-second pulse that settles, so the marker stays findable without blinking.
    const pulse = 0.65 + Math.sin(this.age * 6) * 0.2;
    const alpha = this.lowMotion ? (1 - t) * 0.5 : pulse * (1 - t * 0.4);

    this.graphics.clear();
    if (!this.lowMotion && this.from) {
      this.graphics
        .moveTo(this.from.x, this.from.y)
        .lineTo(this.to.x, this.to.y)
        .stroke({ width: 3, color: GOLD, alpha: alpha * 0.55 });
    }
    this.graphics
      .circle(this.to.x, this.to.y, this.radius * 1.14)
      .stroke({ width: 2.6, color: GOLD, alpha });

    if (t >= 1) this.done = true;
  }

  destroy() {
    this.view.destroy({ children: true });
  }
}

/**
 * WinEffect grows a line through the winning stones, freezes, then stamps a seal.
 *
 * For gomoku the line follows the five stones. For xiangqi there is no line, so the seal
 * drops on the losing general instead.
 */
export class WinEffect {
  constructor({ points, sealAt, lowMotion = false }) {
    this.lowMotion = lowMotion;
    this.age = 0;
    // Three beats: grow, hold, stamp.
    this.growDuration = lowMotion ? 0.2 : 0.7;
    this.holdDuration = lowMotion ? 0.1 : 0.35;
    this.stampDuration = lowMotion ? 0.3 : 0.6;
    this.done = false;
    this.view = new Container();
    this.line = new Graphics();
    this.seal = new Graphics();
    this.view.addChild(this.line);
    this.view.addChild(this.seal);
    this.points = points || [];
    this.sealAt = sealAt || (points && points.length ? points[points.length - 1] : null);
  }

  update(dt) {
    this.age += dt;
    const growEnd = this.growDuration;
    const holdEnd = growEnd + this.holdDuration;

    // Phase one: the winning line draws itself stone by stone.
    const growT = Math.min(1, this.age / growEnd);
    this.line.clear();
    if (!this.lowMotion && this.points.length > 1) {
      const segments = this.points.length - 1;
      const drawn = growT * segments;
      for (let i = 0; i < segments; i++) {
        if (i >= drawn) break;
        const a = this.points[i];
        const b = this.points[i + 1];
        const local = Math.min(1, drawn - i);
        this.line
          .moveTo(a.x, a.y)
          .lineTo(a.x + (b.x - a.x) * local, a.y + (b.y - a.y) * local)
          .stroke({ width: 6, color: PALETTE.gold, alpha: 0.92 });
      }
    }

    // Phase two: the seal arrives, slightly oversized, then settles with a squash.
    this.seal.clear();
    if (this.sealAt && this.age >= holdEnd) {
      const stampT = Math.min(1, (this.age - holdEnd) / this.stampDuration);
      const overshoot = this.lowMotion ? 1 : 1.18 - 0.18 * stampT;
      const scale = overshoot * (stampT < 1 ? 0.92 + stampT * 0.08 : 1);
      const alpha = Math.min(1, stampT * 2.2);
      const size = 54 * scale;
      this.seal.position.set(this.sealAt.x, this.sealAt.y);
      this.seal
        .roundRect(-size, -size, size * 2, size * 2, 10)
        .stroke({ width: 5, color: PALETTE.seal, alpha });
      this.seal
        .moveTo(-size * 0.5, 0)
        .lineTo(size * 0.5, 0)
        .moveTo(0, -size * 0.5)
        .lineTo(0, size * 0.5)
        .stroke({ width: 4, color: PALETTE.seal, alpha: alpha * 0.85 });
    }

    if (this.age >= holdEnd + this.stampDuration) this.done = true;
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
