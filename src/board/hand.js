/**
 * HandShadow casts the shadow of a hand onto the board.
 *
 * The hand itself is never drawn. A hard vector hand at this size reads as clip art: a
 * piece is about 40px across, so fingers come out three pixels wide and the whole thing
 * looks pasted on. A shadow has no such problem — it is soft, it belongs to the paper, and
 * it says "someone is sitting here" without pretending to be a photograph of an arm.
 *
 * The shadow reaches in from the seat that is moving: the near side from below, the far side
 * turned around. While the piece is lifted the shadow grows and lightens, which is what a
 * shadow does when the thing casting it rises off the surface.
 */
import { BlurFilter, Container, Graphics } from "pixi.js";

const SHADOW = 0x2a1d12;

/** Cubic-out: fast start, gentle settle. Matches the piece easing so the two agree. */
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/** Fills a tapered segment between two points, in piece radii. */
function limb(g, x0, y0, w0, x1, y1, w1, colour) {
  const steps = 8;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const half = (w0 + (w1 - w0) * t) / 2;
    pts.push(x0 + dx * t + nx * half, y0 + dy * t + ny * half);
  }
  for (let i = steps; i >= 0; i--) {
    const t = i / steps;
    const half = (w0 + (w1 - w0) * t) / 2;
    pts.push(x0 + dx * t - nx * half, y0 + dy * t - ny * half);
  }
  g.poly(pts, true).fill({ color: colour });
}

export class HandShadow {
  /**
   * @param {object} opts
   * @param {number} opts.x piece centre
   * @param {number} opts.y piece centre
   * @param {number} opts.radius piece radius; the shadow is built in units of it
   * @param {"near"|"far"} opts.side which seat is reaching in
   */
  constructor({ x, y, radius, side = "near", lowMotion = false, lead = 0.2, tail = 0.24 }) {
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

    // A shadow is a darkening of the paper, not an object on it.
    this.restAlpha = lowMotion ? 0.2 : 0.34;

    this.view = new Container();
    this.view.position.set(x, y);
    // The far seat reaches from the other edge; rotating the rig keeps the drawing code in
    // one coordinate system.
    this.view.rotation = side === "far" ? Math.PI : 0;
    this.view.alpha = 0;

    this.build();
  }

  build() {
    const r = this.radius;
    const X = (v) => r * v;
    const Y = (v) => r * v;

    // Built from primitives rather than bezier outlines: the blur is going to soften every
    // edge anyway, and an ellipse plus capsules is far harder to get wrong than a hand-built
    // path. An earlier version drew the forearm but silently dropped the palm and fingers.
    this.body = new Graphics();

    // Forearm, entering from behind and narrowing toward the wrist.
    limb(this.body, X(0), Y(7.6), X(2.2), X(0), Y(3.4), X(2.9), SHADOW);

    // Wrist.
    this.body.roundRect(X(-1.3), Y(2.6), X(2.6), Y(1.6), Y(0.6)).fill({ color: SHADOW });

    // Palm: an ellipse wide enough to cover four fingers, and the mass that makes the shape
    // read as a hand rather than as a stick.
    this.body.ellipse(0, Y(2.0), X(1.95), Y(1.45)).fill({ color: SHADOW });

    // Four fingers reaching over the piece, fanned and uneven.
    const fingers = [
      { x: -1.18, angle: -0.26, length: 2.4, w: 0.66 },
      { x: -0.4, angle: -0.07, length: 2.85, w: 0.7 },
      { x: 0.36, angle: 0.09, length: 2.7, w: 0.68 },
      { x: 1.1, angle: 0.28, length: 2.25, w: 0.6 },
    ];
    for (const f of fingers) {
      const tipX = f.x + Math.sin(f.angle) * f.length;
      const tipY = 1.1 - Math.cos(f.angle) * f.length;
      limb(this.body, X(f.x), Y(1.1), X(f.w), X(tipX), Y(tipY), X(f.w * 0.8), SHADOW);
      this.body.circle(X(tipX), Y(tipY), X(f.w * 0.4)).fill({ color: SHADOW });
    }

    // Thumb across the near side.
    limb(this.body, X(1.6), Y(2.5), X(0.82), X(0.7), Y(1.05), X(0.7), SHADOW);
    this.body.circle(X(0.7), Y(1.05), X(0.35)).fill({ color: SHADOW });

    // Soften into a shadow. Small radius on purpose: sharp enough to show the gaps between
    // fingers and it stops being a shadow and becomes a drawing again.
    try {
      this.body.filters = [
        new BlurFilter({ strength: Math.max(1.6, this.radius * 0.13), quality: 4 }),
      ];
    } catch {
      // Without the blur this is a hard silhouette; still tracks the piece correctly.
    }

    this.view.addChild(this.body);
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

    // The shadow slides in from its own edge rather than appearing in place.
    const arrive = Math.min(1, this.age / this.lead);
    const arriveEase = easeOutCubic(arrive);
    let back = (1 - arriveEase) * this.radius * 8;
    let alpha = arriveEase;

    if (this.released) {
      const out = Math.min(1, (this.age - this.releaseAt) / this.tail);
      const outEase = easeOutCubic(out);
      back += outEase * this.radius * 8;
      alpha = 1 - outEase;
      if (out >= 1) this.done = true;
    }

    const dir = this.side === "far" ? -1 : 1;
    // Cast slightly away from the light, which comes from the upper left on this board.
    this.view.position.set(this.baseX + this.radius * 0.16, this.baseY + back * dir + this.radius * 0.12);

    // Held between finger and board, the piece sits higher: its shadow spreads and thins.
    // This is what makes the carry read as lifting rather than as sliding.
    const lift = arriveEase * (this.released ? Math.max(0, 1 - (this.age - this.releaseAt) / this.tail) : 1);
    const spread = 1 + lift * 0.1;
    this.view.scale.set(spread);
    this.view.alpha = Math.max(0, Math.min(1, alpha)) * this.restAlpha * (1 - lift * 0.18);
  }

  destroy() {
    this.view.destroy({ children: true });
  }
}
