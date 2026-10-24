/**
 * Sound and haptics for the board.
 *
 * Everything here is synthesised at call time: the plugin ships no audio assets, and the
 * DBX sandbox would not load them from disk anyway. A wood click is a short noise burst
 * with a resonant body; that is cheap to build and, unlike a sample, can be detuned per
 * board so the two games do not sound identical.
 *
 * Audio is created lazily on the first real gesture. Browsers refuse to start an
 * AudioContext before one, and a context created too early also burns the tick budget.
 */

const VOICES = {
  /** A stone or piece meeting the board: filtered noise plus a low body thump. */
  land: { noise: 0.045, gain: 0.5, body: 190, bodyGain: 0.42, q: 1.2 },
  /** Heavier landing for a xiangqi piece, which is wood on wood rather than slate. */
  landHeavy: { noise: 0.06, gain: 0.6, body: 132, bodyGain: 0.55, q: 0.9 },
  /** A piece swept off the board: bright, dry, brief. */
  capture: { noise: 0.11, gain: 0.42, body: 240, bodyGain: 0.2, q: 1.8 },
  /** A heavy piece lost: a deep pressure wave with a long cut through it. */
  keyCapture: { noise: 0.26, gain: 0.54, body: 82, bodyGain: 0.58, q: 0.62, ring: 1.18 },
  /** Cannon: a short low pressure wave behind the high wood impact. */
  cannon: { noise: 0.2, gain: 0.52, body: 112, bodyGain: 0.38, q: 0.65, ring: 0.34 },
  /** River: a wide, soft brush of noise rather than a pitched impact. */
  river: { noise: 0.3, gain: 0.2, body: 174, bodyGain: 0.08, q: 0.45, ring: 0.42 },
  /** Undo: a quick, dry inhale that ends where the landing began. */
  undo: { noise: 0.18, gain: 0.2, body: 310, bodyGain: 0.16, q: 1.1, ring: 0.34 },
  /** Check: a struck gong, low and long, with a beating partial to make it cut through. */
  check: { noise: 0.16, gain: 0.3, body: 96, bodyGain: 0.5, q: 0.6, ring: 1.5 },
  /** Victory: two rising chimes, deliberately short so it does not loop annoyingly. */
  win: { noise: 0.02, gain: 0.16, body: 520, bodyGain: 0.34, q: 2, ring: 0.9 },
  /** Emote: two soft sine notes a fifth apart, short enough to stay unobtrusive. */
  emote: { noise: 0, gain: 0, body: 660, bodyGain: 0.15, q: 1, ring: 0.25 },
};

export class BoardAudio {
  constructor() {
    this.enabled = true;
    this.ctx = null;
    this.lastAt = new Map();
  }

  /** Creates the context on demand. Safe to call on every gesture. */
  unlock() {
    if (this.ctx || !this.enabled) return this.ctx;
    const Ctor = typeof window !== "undefined" ? window.AudioContext || window.webkitAudioContext : null;
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled && this.ctx) {
      try {
        this.ctx.suspend();
      } catch {
        // A suspended-while-closing context is not worth surfacing.
      }
    } else if (this.enabled && this.ctx) {
      try {
        this.ctx.resume();
      } catch {
        // Same: a refused resume just means the next gesture will re-arm it.
      }
    }
  }

  /**
   * Plays one named voice.
   *
   * Voices are rate-limited: a fast scripted line can fire two landings within a few
   * milliseconds, and stacking them clips into a click.
   */
  play(name, { pitch = 1, volume = 1 } = {}) {
    if (!this.enabled) return;
    const spec = VOICES[name];
    if (!spec) return;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const prev = this.lastAt.get(name) || 0;
    if (now - prev < 45) return;
    this.lastAt.set(name, now);

    const ctx = this.unlock();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});

    const t0 = ctx.currentTime;

    // A dedicated two-note chime reads as friendly rather than as another board knock.
    if (name === "emote") {
      const notes = [
        { delay: 0, frequency: spec.body, gain: spec.bodyGain, duration: spec.ring },
        { delay: 0.055, frequency: spec.body * 1.5, gain: spec.bodyGain * 0.46, duration: 0.19 },
      ];
      for (const note of notes) {
        const chime = ctx.createOscillator();
        const chimeGain = ctx.createGain();
        const start = t0 + note.delay;
        chime.type = "sine";
        chime.frequency.setValueAtTime(note.frequency * 1.025, start);
        chime.frequency.exponentialRampToValueAtTime(note.frequency, start + 0.09);
        chimeGain.gain.setValueAtTime(0, start);
        chimeGain.gain.linearRampToValueAtTime(note.gain * volume, start + 0.008);
        chimeGain.gain.exponentialRampToValueAtTime(0.0001, start + note.duration);
        chime.connect(chimeGain).connect(ctx.destination);
        chime.start(start);
        chime.stop(start + note.duration + 0.02);
      }
      return;
    }

    // Body: a sine that drops in pitch, which is what gives a knock its weight.
    const body = ctx.createOscillator();
    body.type = "sine";
    const bodyGain = ctx.createGain();
    body.frequency.setValueAtTime(spec.body * pitch, t0);
    body.frequency.exponentialRampToValueAtTime(spec.body * pitch * 0.55, t0 + 0.16);
    bodyGain.gain.setValueAtTime(0, t0);
    bodyGain.gain.linearRampToValueAtTime(spec.bodyGain * volume, t0 + 0.004);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t0 + (spec.ring ? spec.ring : 0.22));
    body.connect(bodyGain).connect(ctx.destination);
    body.start(t0);
    body.stop(t0 + (spec.ring ? spec.ring : 0.24));

    // Noise: the contact transient. Generated per call; 2048 samples is enough for a click.
    const length = Math.max(1, Math.floor(ctx.sampleRate * spec.noise));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2.2);
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(1900 * pitch, t0);
    filter.Q.setValueAtTime(spec.q, t0);
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(spec.gain * volume, t0);
    noise.connect(filter).connect(noiseGain).connect(ctx.destination);
    noise.start(t0);

    // Victory gets a second partial a fourth above, so it reads as a chime not a thud.
    if (name === "win") {
      const chime = ctx.createOscillator();
      chime.type = "triangle";
      const chimeGain = ctx.createGain();
      chime.frequency.setValueAtTime(spec.body * 1.5 * pitch, t0 + 0.07);
      chimeGain.gain.setValueAtTime(0, t0 + 0.07);
      chimeGain.gain.linearRampToValueAtTime(0.16 * volume, t0 + 0.09);
      chimeGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
      chime.connect(chimeGain).connect(ctx.destination);
      chime.start(t0 + 0.07);
      chime.stop(t0 + 0.55);
    }
  }

  destroy() {
    if (this.ctx) {
      try {
        this.ctx.close();
      } catch {
        // Closing an already-closed context throws; nothing to do about it.
      }
      this.ctx = null;
    }
  }
}

/**
 * Fires a haptic pulse where the platform has one.
 *
 * macOS Safari has no vibration API and the DBX host is a frame, so this is best-effort by
 * design: a no-op is the correct outcome, not an error.
 */
export function tap(pattern = 8) {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(pattern);
    }
  } catch {
    // Vibration is blocked outside a user gesture on some platforms.
  }
}

/** True for touch-first devices, including DBX hosts with no vibration support. */
export function isCoarsePointer() {
  if (typeof window === "undefined") return false;
  try {
    if (typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches) {
      return true;
    }
  } catch {
    // Some embedded webviews expose matchMedia but reject pointer queries.
  }
  return Number(globalThis.navigator?.maxTouchPoints || 0) > 0;
}

/**
 * The landing pulse is deliberately tiny and only fires on touch-first devices.
 * Callers should invoke it at the same moment as the landing ripple, not on pointerdown:
 * the authoritative stone may still be travelling or the host may reject the move.
 */
export function tapLanding() {
  if (isCoarsePointer()) tap(8);
}
