/**
 * The piece layer: persistent piece views with motion.
 *
 * The scene used to destroy and rebuild every piece on every snapshot, which meant a piece
 * teleported from its origin to its destination. Nothing else on the board can look alive
 * while that is true — a landing ripple under a stone that never travelled reads as a
 * decoration applied afterwards, not as a consequence of the move.
 *
 * So this layer keeps its views alive and reconciles them against the authoritative cell
 * array. Two things follow:
 *
 * 1. Identity has to be inferred, because a snapshot is only a flat array of codes. A move
 *    is recognised by its shape: one square vacates, one square fills. Anything else — a
 *    replay jump, an undo, a new game — is not a move, and the layer rebuilds rather than
 *    guessing.
 * 2. Animation is owned here. The layer runs its own clock from `update`, so a tween keeps
 *    its pace even when snapshots arrive irregularly.
 *
 * Easing choices come from the standard sets (tween.js `Easing`, and the gsap curves pixi's
 * own example games use): position decelerates hard, a placed stone overshoots slightly, a
 * captured piece is knocked away rather than faded out like a UI element.
 */

import { Container, Graphics, Text, TextStyle } from "pixi.js";
import { cellCenter, glyphFor } from "./layout.js";

const INK = 0x1c1a17;
const RED = 0xb03a2e;
const GOLD = 0xd4a24a;
const PAPER = 0xf6efdd;

/** Maps a piece code to the ink it is drawn in, for effects that outlive the piece. */
function pieceColour(code, game) {
  if (game === "gomoku") return code === 2 ? PAPER : INK;
  return code > 0 ? RED : INK;
}

/**
 * Piece travel timing.
 *
 * Speed decides the duration so a long rook slide does not read as a teleport and a
 * one-step pawn nudge does not feel sluggish, but the clamp matters more than the speed:
 * a single square is only ~79 logical pixels, which at 1500 px/s would resolve in 53 ms —
 * under four frames, indistinguishable from a jump. The floor keeps even a one-square move
 * on screen long enough to read as motion (about 11 frames), and the ceiling stops a full
 * board-length slide from feeling like it is dragging.
 */
const TRAVEL_SPEED = 1100;
const MIN_TRAVEL = 0.18;
const MAX_TRAVEL = 0.34;

/** easeOutQuint: fast departure, sharp settle. What a sliding object follows. */
function easeOutQuint(t) {
  return 1 - Math.pow(1 - t, 5);
}

/** easeOutCubic: gentler than quint, used where the motion should not feel abrupt. */
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/** easeOutBack: overshoots then returns — the "pressed onto the paper" feel. */
function easeOutBack(t, overshoot = 1.7) {
  const c = overshoot * 1.525;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
}

/**
 * One piece view together with its own tween state, so the layer can advance it without
 * keeping a parallel bookkeeping table.
 */
class PieceNode {
  constructor(code, { game, radius, cell }) {
    this.code = code;
    this.game = game;
    this.radius = radius;
    this.cell = cell;
    this.container = new Container();
    // The disc lives inside a child so it can lift, scale and fade independently of the
    // square the piece logically occupies.
    this.lift = new Container();
    this.container.addChild(this.lift);

    this.tween = null;
    this.done = false;

    this.buildDisc();
    if (game === "xiangqi") this.buildGlyph();
  }

  buildDisc() {
    const r = this.radius;
    const code = this.code;
    const disc = new Graphics();
    if (this.game === "xiangqi") {
      disc.circle(0, 0, r).fill({ color: PAPER, alpha: 1 });
      disc.circle(0, 0, r).stroke({ width: 2, color: code > 0 ? RED : INK, alpha: 0.9 });
      disc.circle(0, 0, r * 0.84).stroke({ width: 1, color: code > 0 ? RED : INK, alpha: 0.45 });
    } else {
      // Gomoku encodes stones as 1 (black) and 2 (white) rather than by sign, because both
      // colours are positive piece codes in the engine. Reading the sign would paint every
      // white stone black.
      const stone = code === 2 ? 0xfbf8f1 : INK;
      // A white stone on pale paper needs a defined edge and a soft inner shade, or it
      // reads as a hole in the board.
      disc.circle(0, 0, r).fill({ color: stone, alpha: 1 });
      disc.circle(0, 0, r).stroke({ width: 1.6, color: 0x6f6555, alpha: 0.85 });
      disc.circle(0, 0, r * 0.72).stroke({ width: 1, color: 0x8b8272, alpha: 0.35 });
    }
    this.lift.addChild(disc);
  }

  buildGlyph() {
    const glyph = glyphFor(this.code);
    if (!glyph) return;
    const text = new Text({
      text: glyph,
      style: new TextStyle({
        fontFamily: "Songti SC, SimSun, STSong, serif",
        fontSize: this.radius * 1.24,
        fontWeight: "600",
        fill: this.code > 0 ? RED : INK,
      }),
    });
    text.anchor.set(0.5);
    text.position.set(0, this.radius * 0.04);
    this.lift.addChild(text);
  }

  /** Puts the view at a square with no animation. */
  snapTo(point) {
    this.container.position.set(point.x, point.y);
  }

  startMove(to, duration) {
    // from is captured from the live position, so a move issued mid-animation chains from
    // where the piece actually is rather than jumping to a stale origin.
    this.tween = {
      kind: "move",
      fromX: this.container.x,
      fromY: this.container.y,
      toX: to.x,
      toY: to.y,
      duration,
      age: 0,
    };
  }

  /** A stone dropped on an empty point: it appears and presses down, it does not slide. */
  startPlace(point) {
    this.container.position.set(point.x, point.y);
    this.lift.scale.set(0.001);
    this.lift.alpha = 0;
    this.tween = { kind: "place", duration: 0.18, age: 0 };
  }

  /** A captured piece is knocked back and shrinks; it is not faded like a UI element. */
  startCapture() {
    this.tween = { kind: "capture", duration: 0.16, age: 0 };
  }

  update(dt) {
    const tw = this.tween;
    if (!tw) return;
    tw.age += dt;
    const t = Math.min(1, tw.age / tw.duration);

    if (tw.kind === "move") {
      const e = easeOutQuint(t);
      this.container.position.set(tw.fromX + (tw.toX - tw.fromX) * e, tw.fromY + (tw.toY - tw.fromY) * e);
      // A sine arc lifts the piece over the board and sets it down. This is the part that
      // reads as "picked up and placed" instead of "slid along the surface".
      const arc = Math.sin(t * Math.PI);
      this.lift.scale.set(1 + arc * 0.1);
      this.lift.y = -arc * this.radius * 0.14;
    } else if (tw.kind === "place") {
      const s = easeOutBack(t);
      this.lift.scale.set(Math.max(0.001, s));
      this.lift.alpha = Math.min(1, t * 2.6);
    } else if (tw.kind === "capture") {
      // Collapse fast. The old version politely shrank over 0.28s, which read as the piece
      // being tidied away rather than struck; the shatter fragments now carry the moment,
      // so the disc itself only has to register the hit and get out of their way.
      const e = easeOutCubic(t);
      const pop = 1 + Math.sin(Math.min(1, t * 3.4) * Math.PI) * 0.18;
      this.lift.scale.set(Math.max(0.001, pop * (1 - e)));
      this.lift.alpha = 1 - e;
      this.lift.y = -e * this.radius * 0.3;
      this.lift.rotation = e * 0.7;
    }

    if (t >= 1) {
      if (tw.kind === "capture") {
        this.done = true;
      } else {
        this.lift.scale.set(1);
        this.lift.alpha = 1;
        this.lift.y = 0;
        this.lift.rotation = 0;
      }
      this.tween = null;
    }
  }

  /** Attaches the local selection ring, which then rides every animation. */
  setRing(show, ringLayer) {
    if (!show) {
      if (this.ring) {
        this.ring.destroy();
        this.ring = null;
      }
      return;
    }
    if (this.ring) return;
    const ring = new Graphics();
    ring.circle(0, 0, this.radius * 1.2).stroke({ width: 2.6, color: GOLD, alpha: 0.95 });
    ringLayer.addChild(ring);
    this.ring = ring;
  }

  destroy() {
    this.container.destroy({ children: true });
  }
}

/**
 * PieceLayer reconciles piece views against authoritative cell arrays.
 *
 * It decides nothing about the game: it is handed a cell array and reports the moves it
 * animated, so the scene can anchor its ink to the event the player just watched.
 */
export class PieceLayer {
  constructor() {
    this.root = new Container();
    this.body = new Container();
    this.hintLayer = new Container();
    // Hints sit above the stones, or a destination dot vanishes under a piece.
    this.root.addChild(this.body, this.hintLayer);
    this.nodes = [];
    /** Nodes on their way out; detached from reconciliation but still animating. */
    this.dying = [];
    this.game = null;
    this.radius = 0;
    this.cellCount = 0;
    this.selected = -1;
    this.moves = [];
  }

  /** Whether anything is still moving, so the scene can keep ticking cheaply. */
  get busy() {
    if (this.dying.length) return true;
    for (const node of this.nodes) if (node.tween) return true;
    return false;
  }

  reset(game, lay) {
    for (const node of this.nodes) node.destroy();
    for (const node of this.dying) node.destroy();
    this.nodes = [];
    this.dying = [];
    this.body.removeChildren();
    this.game = game;
    this.radius = lay.step * (game === "xiangqi" ? 0.355 : 0.4);
    this.selected = -1;
    this.cellCount = lay.cells;
    this.clearHints();
  }

  clearHints() {
    this.hintLayer.removeChildren().forEach((child) => child.destroy({ children: true }));
  }

  /**
   * Applies a cell array and returns the moves it animated as
   * `[{ from, to, captured, duration }]`, with points.
   */
  sync(cells, lay, { animate = true } = {}) {
    this.moves = [];

    if (this.game !== lay.game || this.cellCount !== cells.length) {
      // A different board size means a different game or a fresh start: never a move.
      this.reset(lay.game, lay);
      this.rebuild(cells, lay);
      return this.moves;
    }

    // The first gomoku stone starts from a board with no piece nodes, but it is still a
    // placement that must produce the landing timeline. The diff can recognise it from the
    // cached cell count; requiring an existing node sent that opening move down the silent
    // rebuild path and skipped its ripple, sound, and board response.
    if (animate) {
      const diff = this.diffCells(cells);
      if (diff.kind === "move") {
        this.applyMove(diff, cells, lay);
        this.drawSelection();
        return this.moves;
      }
      if (diff.kind === "place") {
        this.applyPlace(diff, cells, lay);
        return this.moves;
      }
      if (diff.kind === "none") {
        this.drawSelection();
        return this.moves;
      }
    }

    this.rebuild(cells, lay);
    return this.moves;
  }

  /** Classifies the change between the drawn cells and the incoming ones. */
  diffCells(cells) {
    const drawn = this.cellsOf();
    // A capture touches two squares: the origin empties, and the destination changes owner
    // without ever being empty in between. The destination therefore belongs in `arrived`,
    // not in `prised` — folding it into both used to make vacated.length 2 and push every
    // capture down the rebuild path, so captures never animated at all.
    const prised = [];
    const arrived = [];
    let changed = 0;
    for (let i = 0; i < cells.length; i++) {
      const a = drawn[i] || 0;
      const b = cells[i] || 0;
      if (a === b) continue;
      changed++;
      if (a !== 0 && b === 0) prised.push(i);
      else if (b !== 0) arrived.push(i);
    }
    if (changed === 0) return { kind: "none" };
    if (prised.length === 1 && arrived.length === 1 && prised[0] !== arrived[0]) {
      const from = prised[0];
      const to = arrived[0];
      // The piece that landed must be the piece that left. Anything else (an undo, a
      // scenario replayed from the opening, a different game) is a rebuild.
      if ((drawn[to] || 0) !== 0 && cells[to] !== drawn[from]) return { kind: "rebuild" };
      return { kind: "move", from, to, captured: (drawn[to] || 0) !== 0 };
    }
    // Gomoku: a stone appears and nothing empties.
    if (prised.length === 0 && arrived.length === 1) return { kind: "place", to: arrived[0] };
    return { kind: "rebuild" };
  }

  cellsOf() {
    const cells = new Array(this.cellCount || 0).fill(0);
    for (const node of this.nodes) cells[node.cell] = node.code;
    return cells;
  }

  nodeAt(cell) {
    for (const node of this.nodes) if (node.cell === cell) return node;
    return null;
  }

  applyMove({ from, to }, cells, lay) {
    const mover = this.nodeAt(from);
    if (!mover) {
      this.rebuild(cells, lay);
      return;
    }
    const victim = this.nodeAt(to);
    const fromPt = cellCenter(lay, from);
    const toPt = cellCenter(lay, to);

    // Duration proportional to distance: a long rook slide must not read as a teleport, and
    // a one-step pawn nudge must not feel sluggish.
    const distance = Math.hypot(toPt.x - fromPt.x, toPt.y - fromPt.y);
    const duration = Math.min(MAX_TRAVEL, Math.max(MIN_TRAVEL, distance / TRAVEL_SPEED));

    let victimColour = null;
    if (victim) {
      // Read the colour off the victim before detaching: the shatter has to fly in the
      // colour of the piece that broke, not in the mover's.
      victimColour = pieceColour(victim.code, lay.game);
      victim.startCapture();
      this.detach(victim);
    }
    mover.cell = to;
    mover.startMove(toPt, duration);
    // `to` is a point for the effects layer; `toCell` is the index, which is what anything
    // that needs to find the piece again has to use — nodeAt takes a cell, not a position.
    this.moves.push({
      from: fromPt,
      to: toPt,
      fromCell: from,
      toCell: to,
      captured: !!victim,
      victimColour,
      duration,
    });
  }

  applyPlace({ to }, cells, lay) {
    const pt = cellCenter(lay, to);
    const node = new PieceNode(cells[to], { game: lay.game, radius: this.radius, cell: to });
    node.startPlace(pt);
    this.nodes.push(node);
    this.body.addChild(node.container);
    this.moves.push({ from: null, to: pt, fromCell: -1, toCell: to, captured: false, duration: 0.18 });
  }

  /** Removes a node from reconciliation while its death animation plays out. */
  detach(node) {
    const i = this.nodes.indexOf(node);
    if (i >= 0) this.nodes.splice(i, 1);
    this.dying.push(node);
  }

  /** Hard rebuild: correct but not animated. Used for jumps the layer cannot infer. */
  rebuild(cells, lay) {
    for (const node of this.nodes) node.destroy();
    this.nodes = [];
    this.body.removeChildren();
    this.cellCount = cells.length;
    this.game = lay.game;

    for (let i = 0; i < cells.length; i++) {
      const code = cells[i] || 0;
      if (!code) continue;
      const node = new PieceNode(code, { game: lay.game, radius: this.radius, cell: i });
      node.snapTo(cellCenter(lay, i));
      this.nodes.push(node);
      this.body.addChild(node.container);
    }
    this.drawSelection();
  }

  /** Highlights the locally selected square without disturbing a running animation. */
  setSelected(index) {
    this.selected = index;
    this.drawSelection();
  }

  drawSelection() {
    for (const node of this.nodes) node.setRing(node.cell === this.selected, this.body);
    const selected = this.nodeAt(this.selected);
    // The ring is drawn in the node's own coordinate space, so it has to be re-parented to
    // follow a piece that is currently travelling.
    for (const node of this.nodes) {
      if (!node.ring) continue;
      const target = node === selected ? node.lift : null;
      if (target && node.ring.parent !== target) target.addChild(node.ring);
      else if (!target && node.ring.parent) {
        node.ring.destroy();
        node.ring = null;
      }
    }
    // An unselected node keeping a stale ring would leave gold circles on the board.
    for (const node of this.nodes) {
      if (node.cell !== this.selected && node.ring) {
        node.ring.destroy();
        node.ring = null;
      }
    }
  }

  /** Legal destination dots. */
  showHints(lay, indexes) {
    this.clearHints();
    for (const index of indexes || []) {
      if (index < 0 || index >= lay.cells) continue;
      const pt = cellCenter(lay, index);
      const dot = new Graphics();
      dot.circle(pt.x, pt.y, lay.step * 0.11).fill({ color: GOLD, alpha: 0.72 });
      dot.circle(pt.x, pt.y, lay.step * 0.42).stroke({ width: 1.6, color: GOLD, alpha: 0.34 });
      this.hintLayer.addChild(dot);
    }
  }

  update(dt) {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      this.nodes[i].update(dt);
    }
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const node = this.dying[i];
      node.update(dt);
      if (node.done) {
        node.destroy();
        this.dying.splice(i, 1);
      }
    }
  }

  destroy() {
    for (const node of this.nodes) node.destroy();
    for (const node of this.dying) node.destroy();
    this.nodes = [];
    this.dying = [];
    this.root.destroy({ children: true });
  }
}
