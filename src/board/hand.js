/**
 * HandCursor draws an arm reaching in from the player's own side of the table.
 *
 * Two things make it read as a person rather than as a cursor: the arm enters from the seat
 * that is moving (bottom for the near side, top for the far side) instead of dropping
 * vertically onto the piece, and the hand is built from anatomy — a tapering forearm, a
 * palm with knuckles, and fingers with two segments each that curl over the piece.
 *
 * Everything is drawn as vectors: the plugin ships as one inlined bundle under a CSP that
 * forbids loading image assets, so there is no texture to use.
 */
import { Container, Graphics } from "pixi.js";

const SKIN = 0xe8c9a6;
const SKIN_SHADE = 0xd0a982;
const SKIN_LIGHT = 0xf3ddc4;
const NAIL = 0xf8e8d8;
const SLEEVE = 0x2b2620;
const SLEEVE_FOLD = 0x3c342c;

/** Cubic-out: fast start, gentle settle. Matches the piece easing so the two agree. */
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Fills a tapered segment: a limb `w0` wide at one end and `w1` at the other, bowed by
 * (bendX, bendY) so it reads as flesh rather than as a stick.
 *
 * Lengths are in piece radii, so the whole hand scales with the board.
 */
function limb(g, x0, y0, w0, x1, y1, w1, colour, bendX = 0, bendY = 0) {
  const steps = 10;
  const pts = [];
  const at = (t) => {
    const cx = x0 + (x1 - x0) * t + bendX * Math.sin(Math.PI * t);
    const cy = y0 + (y1 - y0) * t + bendY * Math.sin(Math.PI * t);
    const tx = (x1 - x0) + bendX * Math.PI * Math.cos(Math.PI * t);
    const ty = (y1 - y0) + bendY * Math.PI * Math.cos(Math.PI * t);
    const len = Math.hypot(tx, ty) || 1;
    return { cx, cy, nx: -ty / len, ny: tx / len, half: (w0 + (w1 - w0) * t) / 2 };
  };
  for (let i = 0; i <= steps; i++) {
    const s = at(i / steps);
    pts.push(s.cx + s.nx * s.half, s.cy + s.ny * s.half);
  }
  for (let i = steps; i >= 0; i--) {
    const s = at(i / steps);
    pts.push(s.cx - s.nx * s.half, s.cy - s.ny * s.half);
  }
  g.poly(pts, true).fill({ color: colour });
  return pts;
}

export class HandCursor {
  /**
   * @param {object} opts
   * @param {number} opts.x piece centre
   * @param {number} opts.y piece centre
   * @param {number} opts.radius piece radius; the hand is built in units of it
   * @param {"near"|"far"} opts.side which seat is reaching in
   */
  constructor({ x, y, radius, side = "near", lowMotion = false, lead = 0.18, tail = 0.2 }) {
    this.lowMotion = lowMotion;
    this.radius = radius;
    this.side = side;
    this.lead = lead;
    this.tail = tail;
    this.age = 0;
    this.carrying = false;
    this.released = false;
    this.releaseAt = Infinity;
    this.done = false;
    this.baseX = x;
    this.baseY = y;
    this.grip = 0;

    this.view = new Container();
    this.view.position.set(x, y);
    // The far seat reaches from the other edge, so the whole rig is turned around. Rotating
    // the container keeps the drawing code in one coordinate system.
    this.view.rotation = side === "far" ? Math.PI : 0;
    this.view.alpha = 0;

    this.build();
  }

  build() {
    const r = this.radius;
    // Everything below is written in units of the piece radius and multiplied at the end.
    // Mixing the two spaces is how an earlier version turned four fingers into one long bar.
    const X = (v) => r * v;
    const Y = (v) => r * v;

    this.shadow = new Graphics();
    this.shadow.ellipse(0, Y(0.4), X(2.0), Y(1.6)).fill({ color: 0x1c1a17, alpha: 0.09 });

    // Sleeve: short, rounded, widening away from the wrist. Kept narrow and soft, because at
    // board scale a long straight-edged sleeve reads as a black wedge rather than as cloth.
    this.arm = new Graphics();
    this.arm
      .moveTo(X(-1.3), Y(4.4))
      .quadraticCurveTo(X(-1.8), Y(6.4), X(-1.7), Y(7.7))
      .quadraticCurveTo(0, Y(8.3), X(1.7), Y(7.7))
      .quadraticCurveTo(X(1.8), Y(6.4), X(1.3), Y(4.4))
      .closePath()
      .fill({ color: SLEEVE });
    // Cuff where the cloth folds back.
    this.arm.roundRect(X(-1.42), Y(4.3), X(2.84), Y(0.6), Y(0.28)).fill({ color: SLEEVE_FOLD });
    // One fold line, so the sleeve is cloth and not a slab.
    this.arm
      .moveTo(X(-0.45), Y(5.1))
      .quadraticCurveTo(X(-0.55), Y(6.5), X(-0.45), Y(7.6))
      .stroke({ width: X(0.09), color: 0x1d1915, alpha: 0.5 });
    // Bare wrist between cuff and hand.
    this.arm.roundRect(X(-1.2), Y(3.6), X(2.4), Y(0.95), Y(0.36)).fill({ color: SKIN });

    // Back of the hand: four scalloped fingertips on the leading edge. The lobes are what
    // read as fingers — one smooth curve looks like a mitten at any size.
    const baseY = 1.9;
    const tips = [
      { x: -1.02, w: 0.4, depth: 1.06 },
      { x: -0.34, w: 0.4, depth: 0.92 },
      { x: 0.34, w: 0.4, depth: 0.97 },
      { x: 1.02, w: 0.4, depth: 1.1 },
    ];

    const p = new Graphics();
    p.moveTo(X(-1.3), Y(4.7));
    p.quadraticCurveTo(X(-1.78), Y(3.4), X(-1.82), Y(baseY));

    let edge = -1.82;
    for (const t of tips) {
      const left = t.x - t.w;
      const right = t.x + t.w;
      // Travel along the notch between fingers, then arch over one fingertip.
      if (left > edge) p.lineTo(X(left), Y(baseY));
      p.quadraticCurveTo(X(t.x), Y(t.depth), X(right), Y(baseY));
      edge = right;
    }
    p.lineTo(X(1.82), Y(baseY));
    p.quadraticCurveTo(X(1.78), Y(3.4), X(1.3), Y(4.7));
    p.closePath();
    p.fill({ color: SKIN });

    // Shading down the left side; the board is lit from the upper right.
    p.moveTo(X(-1.3), Y(4.7))
      .quadraticCurveTo(X(-1.78), Y(3.4), X(-1.82), Y(baseY))
      .quadraticCurveTo(X(-1.4), Y(3.2), X(-1.0), Y(4.66))
      .closePath()
      .fill({ color: SKIN_SHADE, alpha: 0.5 });

    // Knuckle highlight across the back of the hand.
    p.ellipse(0, Y(2.45), X(1.25), Y(0.28)).fill({ color: SKIN_LIGHT, alpha: 0.45 });

    // A nail on each fingertip.
    for (const t of tips) {
      p.roundRect(X(t.x - t.w * 0.55), Y(t.depth + 0.16), X(t.w * 1.1), Y(0.4), Y(0.16))
        .fill({ color: NAIL, alpha: 0.9 });
    }
    this.palm = p;

    // Thumb laid across the near side of the piece.
    this.thumb = new Graphics();
    limb(this.thumb, X(1.45), Y(2.75), X(0.95), X(0.6), Y(1.35), X(0.8), SKIN, X(-0.1), 0);
    this.thumb.roundRect(X(0.33), Y(1.28), X(0.46), Y(0.36), Y(0.16)).fill({ color: NAIL, alpha: 0.9 });

    this.view.addChild(this.shadow, this.arm, this.palm, this.thumb);
    this.setGrip(0);
  }

  /** @param {number} v 0 open, 1 closed over the piece */
  setGrip(v) {
    this.grip = Math.max(0, Math.min(1, v));
    // The silhouette is already closed; the grip adds the small settle of a hand taking
    // weight — the thumb draws in and the whole hand presses down a hair.
    this.thumb.rotation = -0.06 + this.grip * 0.14;
    this.thumb.x = -this.grip * this.radius * 0.12;
    const squeeze = 1 - this.grip * 0.03;
    this.palm.scale.set(squeeze, 1 + this.grip * 0.02);
  }

  grab() {
    this.carrying = true;
  }

  release() {
    if (this.released) return;
    this.released = true;
    this.carrying = false;
    this.releaseAt = this.age;
  }

  /**
   * @param {number} dt seconds
   * @param {{x:number,y:number}|null} target where the carried piece is now
   */
  update(dt, target) {
    this.age += dt;
    if (target) {
      this.baseX = target.x;
      this.baseY = target.y;
    }

    // The arm slides in from its own edge rather than down from above: "behind" is +y in
    // local space, already rotated toward the seat that is reaching in.
    const arrive = Math.min(1, this.age / this.lead);
    const arriveEase = easeOutCubic(arrive);
    let back = (1 - arriveEase) * this.radius * 9;
    let alpha = arriveEase;

    if (this.released) {
      const out = Math.min(1, (this.age - this.releaseAt) / this.tail);
      const outEase = easeOutCubic(out);
      back += outEase * this.radius * 9;
      alpha = 1 - outEase;
      if (out >= 1) this.done = true;
    }

    const dir = this.side === "far" ? -1 : 1;
    this.view.position.set(this.baseX, this.baseY + back * dir);
    this.view.alpha = Math.max(0, Math.min(1, alpha));

    // Fingers close as the hand arrives, and open again on release.
    this.setGrip(this.released ? 0 : arriveEase);
  }

  destroy() {
    this.view.destroy({ children: true });
  }
}
