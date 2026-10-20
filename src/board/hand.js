/**
 * HandCursor draws a large hand that reaches in, picks a piece up and sets it down.
 *
 * It is drawn as vector shapes rather than a sprite: the plugin ships as a single inlined
 * bundle under a CSP that forbids loading image assets, so there is no texture to use.
 *
 * The shape is a sleeve and a hand seen from above, not an anatomical hand. That is a
 * deliberate style choice as much as a practical one — a realistic hand at this size reads
 * as a cursor, while a broad sleeve reads as someone sitting at the table.
 */
import { Container, Graphics } from "pixi.js";

const SLEEVE = 0x2b2620;
const SKIN = 0xf0d9bd;
const SKIN_SHADE = 0xdfc0a0;

/** Cubic-out: fast start, gentle settle. Matches the piece easing so the two agree. */
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

export class HandCursor {
  constructor({ x, y, radius, lowMotion = false, lead = 0.14, tail = 0.16 }) {
    this.lowMotion = lowMotion;
    this.radius = radius;
    this.lead = lead; // time to arrive before the carry starts
    this.tail = tail; // time to withdraw after releasing
    this.age = 0;
    this.carrying = false;
    this.released = false;
    this.releaseAt = Infinity;
    this.done = false;
    // Anchored position of the piece being carried. Kept apart from view.y, which also has
    // to hold the approach/withdraw lift, or the lift would accumulate every frame.
    this.baseX = x;
    this.baseY = y;

    this.view = new Container();
    this.view.position.set(x, y);
    // Zero until the move begins: the hand must not sit on the board between turns.
    this.view.alpha = 0;

    const scale = radius / 16; // drawn at a 16px unit piece, scaled to the live radius
    this.scale = scale;

    this.shade = new Graphics();
    this.shade
      .ellipse(0, radius * 0.55, radius * 1.15, radius * 0.42)
      .fill({ color: 0x000000, alpha: 0.1 });

    // Sleeve: wide at the top, narrowing to the wrist. Drawn first so the hand covers it.
    this.sleeve = new Graphics();
    this.sleeve
      .poly(
        [
          -radius * 0.06, -radius * 4.4,
          radius * 0.06, -radius * 4.4,
          radius * 1.02, -radius * 0.55,
          -radius * 1.02, -radius * 0.55,
        ],
        true,
      )
      .fill({ color: SLEEVE });
    // A lighter inner fold keeps the sleeve from reading as a solid wedge.
    this.sleeve
      .poly(
        [
          -radius * 0.02, -radius * 3.9,
          radius * 0.02, -radius * 3.9,
          radius * 0.42, -radius * 0.8,
          -radius * 0.42, -radius * 0.8,
        ],
        true,
      )
      .fill({ color: 0x3a332c, alpha: 0.9 });

    this.palm = new Graphics();
    this.palm
      .ellipse(0, 0, radius * 0.95, radius * 0.82)
      .fill({ color: SKIN });
    this.palm
      .ellipse(0, radius * 0.14, radius * 0.78, radius * 0.5)
      .fill({ color: SKIN_SHADE, alpha: 0.55 });
    this.palm.circle(0, 0, radius * 0.42).fill({ color: SKIN, alpha: 0.9 });

    // Fingers curl over the piece: their length is animated, so they are their own group.
    this.fingers = new Container();
    for (let i = 0; i < 4; i++) {
      const angle = -0.62 + i * 0.41;
      const finger = new Graphics();
      finger
        .roundRect(-radius * 0.13, 0, radius * 0.26, radius * 0.72, radius * 0.13)
        .fill({ color: SKIN });
      finger.rotation = angle;
      finger.x = Math.sin(angle) * radius * 0.52;
      finger.y = -radius * 0.5;
      this.fingers.addChild(finger);
    }
    // Thumb, held to the side so the grip is not symmetrical.
    this.thumb = new Graphics();
    this.thumb
      .roundRect(-radius * 0.24, -radius * 0.12, radius * 0.28, radius * 0.66, radius * 0.14)
      .fill({ color: SKIN });
    this.thumb.rotation = -1.15;
    this.thumb.x = radius * 0.62;
    this.thumb.y = -radius * 0.1;

    this.view.addChild(this.shade, this.sleeve, this.palm, this.fingers, this.thumb);
    this.view.scale.set(scale);
  }

  /** Begins the carry. Call once, when the piece starts moving. */
  grab() {
    this.carrying = true;
  }

  /** Releases the piece: fingers open and the hand starts to withdraw. */
  release() {
    if (this.released) return;
    this.released = true;
    this.carrying = false;
    this.releaseAt = this.age;
  }

  /**
   * @param {number} dt seconds
   * @param {{x:number,y:number}|null} target where the carried piece is right now
   */
  update(dt, target) {
    this.age += dt;

    if (target) {
      this.baseX = target.x;
      this.baseY = target.y;
    }

    // Arrival: the hand slides down onto the piece rather than fading in place.
    const arrive = Math.min(1, this.age / this.lead);
    const arriveEase = easeOutCubic(arrive);
    let lift = (1 - arriveEase) * this.radius * 3.2;
    let alpha = arriveEase;

    if (this.released) {
      const out = Math.min(1, (this.age - this.releaseAt) / this.tail);
      const outEase = easeOutCubic(out);
      lift += outEase * this.radius * 3.2;
      alpha = 1 - outEase;
      if (out >= 1) this.done = true;
    }

    this.view.position.set(this.baseX, this.baseY - lift);
    this.view.alpha = Math.max(0, Math.min(1, alpha));

    // Grip: fingers close just after arrival and open again on release.
    const grip = this.released
      ? 0.55
      : arrive >= 1
        ? 1
        : 0.55 + arriveEase * 0.45;
    this.fingers.scale.y = grip;
    this.fingers.y = -this.radius * 0.5 * grip;
    this.thumb.rotation = -1.15 - (grip - 0.55) * 0.35;
  }

  destroy() {
    this.view.destroy({ children: true });
  }
}
