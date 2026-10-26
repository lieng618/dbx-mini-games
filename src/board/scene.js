/**
 * BoardScene renders one board and its effects on a Pixi canvas.
 *
 * The scene is deliberately state-light: it is told what the position is and draws it.
 * It never validates moves or decides outcomes — the host is the only authority. Its
 * public surface is `update`, `suspend`, `resume`, and `destroy`.
 */

import { Application, Container, Graphics, Text, TextStyle } from "pixi.js";
import { ShockwaveFilter } from "pixi-filters/shockwave";
import {
  LOGICAL_HEIGHT,
  LOGICAL_WIDTH,
  PIECE,
  cellAt,
  cellCenter,
  cellsBetween,
  crossesRiver,
  glyphFor,
  layout,
} from "./layout.js";
import {
  CannonBlastEffect,
  CaptureBurstEffect,
  CheckEffect,
  FlashEffect,
  GhostMoveEffect,
  KeyCaptureCinematicEffect,
  LandingWeightEffect,
  LastMoveEffect,
  PALETTE,
  PieceCaptureAccentEffect,
  RematchInkEffect,
  RippleEffect,
  RiverSurgeEffect,
  ShatterEffect,
  VictoryFractureEffect,
  WinEffect,
  captureImpactAngle,
  clearTransient,
  isCinematicCapture,
} from "./effects.js";
import { HandShadow } from "./hand.js";
import { BoardAudio, tap, tapLanding } from "./sound.js";
import { PieceLayer } from "./pieces.js";

/** Resolves a player's ink colour from their seat. */
function seatColour(seat) {
  return seat === 0 ? PALETTE.red : PALETTE.black;
}

/** Colour of the landing ink after a move, using the next seat to identify the mover. */
export function landingColour(game, nextTurn) {
  if (game === "xiangqi") return nextTurn === 1 ? PALETTE.red : PALETTE.black;
  // Five-in-a-row uses one contrasting warm halo for both sides. A piece-coloured ripple
  // disappears for either black (into the grid) or white (into the paper).
  return PALETTE.gold;
}

/**
 * A finished gomoku room becomes a fresh empty round without changing board geometry.
 * Checking every condition keeps an undo back to the first move or an ordinary snapshot
 * from being mistaken for a rematch.
 */
export function startsFreshGomokuRound({
  game,
  previousCells,
  cells,
  previousMoveCount,
  moveCount,
  previousFinished,
}) {
  return (
    game === "gomoku" &&
    previousFinished === true &&
    Number(previousMoveCount) > 0 &&
    Number(moveCount) === 0 &&
    Array.isArray(previousCells) &&
    previousCells.some((cell) => cell !== 0) &&
    Array.isArray(cells) &&
    cells.length === previousCells.length &&
    cells.every((cell) => cell === 0)
  );
}

/**
 * A rematch also drops the move counter, but it replaces the whole position rather than
 * rewinding one authoritative move. Keep the undo animation to an unfinished match that
 * moved back exactly one ply, so opening the next round cannot replay the old last move.
 */
export function isImmediateXiangqiUndo({
  game,
  previousMoveCount,
  moveCount,
  previousFinished,
  previousLastMove,
}) {
  const previous = Number(previousMoveCount);
  const current = Number(moveCount);
  const from = Number(previousLastMove?.from);
  const to = Number(previousLastMove?.to);
  return (
    game === "xiangqi" &&
    previousFinished !== true &&
    Number.isFinite(previous) &&
    Number.isFinite(current) &&
    previous > 0 &&
    current === previous - 1 &&
    Number.isInteger(from) &&
    from >= 0 &&
    Number.isInteger(to) &&
    to >= 0
  );
}

/**
 * Escalates checks that arrive in quick succession. The room move counter is authoritative,
 * so players and spectators derive the same tier even if their snapshots arrive late.
 */
export function nextCheckTier(previousTier, lastCheckMove, moveCount) {
  const move = Number(moveCount);
  const previous = Number(lastCheckMove);
  if (!Number.isFinite(move) || !Number.isFinite(previous) || previous < 0) return 1;
  const gap = move - previous;
  if (gap <= 0 || gap > 3) return 1;
  return Math.min(3, Math.max(1, Number(previousTier) || 1) + 1);
}

export class BoardScene {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.app = null;
    this.game = null;
    this.lay = null;
    // Whether the board is drawn from seat two's side of the table.
    this.flipped = false;
    this.lowMotion = false;
    this.effectsOff = false;
    this.effects = [];
    this.lastCells = null;
    this.currentLastMove = null;
    this.lastMoveKey = null;
    this.lastMoveAnchorKey = "";
    this.lastMoveEffect = null;
    this.replayGhostEffect = null;
    this.result = null;
    this.destroyed = false;
    this.audio = new BoardAudio();
    // Effects that must fire later (a landing ink waits for the piece to arrive). Kept in
    // one queue so an undo or a replay jump can drop them: a queued ripple for a move that
    // no longer exists would paint ink on an empty square.
    this.pending = [];
    // Tracks which one-shot cues have already fired for the current position, so a
    // repeated snapshot cannot re-trigger the check gong or the victory chime.
    this.cued = { check: false, win: false };
    this.lastMoveCount = null;
    this.lastCheckMove = -Infinity;
    this.checkStreak = 0;
    // The board-wide shockwave is transient: it lives only while settling, then the filter
    // is detached. Leaving a filter on the root would cost a full render-to-texture every
    // frame for the rest of the session.
    this.shock = null;
    // The hand that carries the piece the player just moved, or null.
    this.hand = null;
    // A local tap arms this only after the board accepts input. The landing callback consumes
    // it at the exact frame of the ripple, never on pointerdown and never for an opponent move.
    this.landingHaptic = null;
  }

  /** Boots Pixi and mounts the canvas. Throws when the renderer cannot start. */
  async init(container, game) {
    this.app = new Application();
    await this.app.init({
      width: LOGICAL_WIDTH,
      height: LOGICAL_HEIGHT,
      backgroundAlpha: 0,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
    });
    container.appendChild(this.app.canvas);
    this.app.canvas.style.width = "100%";
    this.app.canvas.style.height = "100%";
    this.app.canvas.style.display = "block";
    this.app.canvas.style.touchAction = "manipulation";

    this.root = new Container();
    this.boardLayer = new Container();
    // A quiet last-move anchor stays under the pieces until the next move. It is positional
    // information rather than a transient celebration, so it survives clock snapshots.
    this.lastMoveLayer = new Container();
    this.pieces = new PieceLayer();
    this.pieceLayer = this.pieces.root;
    this.effectLayer = new Container();
    // Under-effects sit between the board and the stones: a winning line belongs behind
    // the pieces it connects, not painted over them.
    this.underLayer = new Container();
    // Above the stones: seals and stamps land on the board, not behind it.
    this.overlayLayer = new Container();
    this.root.addChild(
      this.boardLayer,
      this.lastMoveLayer,
      this.underLayer,
      this.pieceLayer,
      this.effectLayer,
      this.overlayLayer,
    );
    this.app.stage.addChild(this.root);

    this.setGame(game);

    this.app.stage.eventMode = "static";
    this.app.stage.hitArea = this.app.screen;
    this.app.stage.on("pointertap", (event) => this.onPointer(event));

    this.app.ticker.add((ticker) => this.tick(ticker.deltaMS / 1000));
  }

  /** Switches the board geometry. Safe to call when the room changes game. */
  setGame(game) {
    if (this.game === game) return;
    // Effects are drawn in the old board's coordinates and some of them (the check glyph,
    // the winning line) are game-specific, so carrying them across a switch would strand
    // ink at meaningless positions.
    this.clearEffects();
    this.clearLastMove();
    this.cued.check = false;
    this.cued.win = false;
    this.lastMoveCount = null;
    this.lastCheckMove = -Infinity;
    this.checkStreak = 0;
    this.lastMoveKey = null;
    this.game = game;
    this.lay = layout(game, this.flipped);
    this.drawBoard();
    this.pieces.reset(game, this.lay);
  }

  /**
   * Turns the board around for the player who holds seat two, so their own side sits along
   * the near edge. Safe at any time: the position is captured and re-laid-out, so the same
   * stones stay put on the board rather than the board spinning under them.
   */
  setFlipped(flipped) {
    const next = flipped === true;
    if (this.flipped === next || !this.lay) return;
    const cells = this.pieces.cellsOf();
    this.flipped = next;
    this.lay = layout(this.game, next);
    this.drawBoard();
    this.pieces.reset(this.game, this.lay);
    if (cells && cells.length) this.pieces.sync(cells, this.lay, { animate: false });
    // Keep the cache in step, or the next update would re-diff against the old orientation
    // and replay every piece as a move.
    this.lastCells = cells;
    // Ink, seals and winning lines were placed with the old mapping; leaving them would put
    // them on the wrong squares.
    this.clearEffects();
    this.lastMoveKey = null;
    this.drawLastMoveAnchor(this.currentLastMove, { force: true });
  }

  /**
   * Returns the board's visible frame in viewport coordinates.
   *
   * The scene canvas is larger than the drawn paper so effects have room around the board.
   * Mobile controls need the actual frame bounds rather than the canvas bounds to sit in the
   * gaps around the board.
   */
  getBoardVisualRect() {
    if (!this.boardBounds || !this.app?.canvas) return null;
    const canvasRect = this.app.canvas.getBoundingClientRect();
    if (!canvasRect.width || !canvasRect.height) return null;

    const frame = 34;
    const scaleX = canvasRect.width / LOGICAL_WIDTH;
    const scaleY = canvasRect.height / LOGICAL_HEIGHT;
    return {
      left: canvasRect.left + (this.boardBounds.left - frame) * scaleX,
      top: canvasRect.top + (this.boardBounds.top - frame) * scaleY,
      right: canvasRect.left + (this.boardBounds.left + this.boardBounds.width + frame) * scaleX,
      bottom: canvasRect.top + (this.boardBounds.top + this.boardBounds.height + frame) * scaleY,
    };
  }

  /** Draws the static board: frame, grid, palace diagonals, river. */
  drawBoard() {
    this.boardLayer.removeChildren().forEach((child) => child.destroy({ children: true }));
    this.boardFrame = new Graphics();
    this.boardLayer.addChild(this.boardFrame);

    const lay = this.lay;
    const g = this.boardFrame;
    // The frame is offset to logical 0,0 so effect coordinates stay board-local.
    const left = lay.originX;
    const top = lay.originY;
    const right = left + lay.boardWidth;
    const bottom = top + lay.boardHeight;

    // Paper ground with a soft vignette so the canvas does not look flat.
    g.roundRect(left - 34, top - 34, lay.boardWidth + 68, lay.boardHeight + 68, 22)
      .fill({ color: PALETTE.paper, alpha: 0.97 })
      .stroke({ width: 2, color: 0x8a6a3c, alpha: 0.5 });
    g.roundRect(left - 26, top - 26, lay.boardWidth + 52, lay.boardHeight + 52, 18)
      .stroke({ width: 1, color: 0x8a6a3c, alpha: 0.32 });
    this.drawPaperGrain(g, left, top, lay);

    const lineColour = 0x6b5433;
    if (this.game === "xiangqi") {
      // Full grid: ten ranks, nine files.
      for (let rank = 0; rank < lay.ranks; rank++) {
        const y = top + rank * lay.step;
        g.moveTo(left, y).lineTo(right, y);
      }
      for (let file = 0; file < lay.files; file++) {
        const x = left + file * lay.step;
        // The river splits the outer files: draw two segments instead of one line.
        if (file === 0 || file === lay.files - 1) {
          g.moveTo(x, top).lineTo(x, bottom);
        } else {
          const mid = top + 4 * lay.step;
          const mid2 = top + 5 * lay.step;
          g.moveTo(x, top).lineTo(x, mid);
          g.moveTo(x, mid2).lineTo(x, bottom);
        }
      }
      g.stroke({ width: 1.4, color: lineColour, alpha: 0.85 });

      // Palaces: a cross in each side's 3x3.
      const palace = (topRank) => {
        const x0 = left + 3 * lay.step;
        const x1 = left + 5 * lay.step;
        const y0 = top + topRank * lay.step;
        const y1 = top + (topRank + 2) * lay.step;
        g.moveTo(x0, y0).lineTo(x1, y1).moveTo(x1, y0).lineTo(x0, y1);
      };
      palace(0);
      palace(7);
      g.stroke({ width: 1.2, color: lineColour, alpha: 0.7 });

      this.drawRiverLabel();
    } else {
      for (let rank = 0; rank < lay.ranks; rank++) {
        const y = top + rank * lay.step;
        g.moveTo(left, y).lineTo(right, y);
      }
      for (let file = 0; file < lay.files; file++) {
        const x = left + file * lay.step;
        g.moveTo(x, top).lineTo(x, bottom);
      }
      g.stroke({ width: 1.1, color: lineColour, alpha: 0.7 });

      // Star points help players judge distance at a glance.
      for (const [fr, rr] of [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]]) {
        g.circle(left + fr * lay.step, top + rr * lay.step, 4)
          .fill({ color: PALETTE.ink, alpha: 0.75 });
      }
    }

    this.boardBounds = { left, top, width: lay.boardWidth, height: lay.boardHeight };
  }

  /**
   * Speckles the paper so it reads as a sheet rather than as a flat fill.
   *
   * Ink effects only look wet against something absorbent. This is a fixed, deterministic
   * scatter of very faint dots and fibre strokes, drawn once, cost paid at board paint only.
   */
  drawPaperGrain(g, left, top, lay) {
    let seed = 0x2f6b1d;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const w = lay.boardWidth + 68;
    const h = lay.boardHeight + 68;
    for (let i = 0; i < 320; i++) {
      const x = left - 34 + rand() * w;
      const y = top - 34 + rand() * h;
      const r = 0.6 + rand() * 1.6;
      g.circle(x, y, r).fill({ color: 0x8a6a3c, alpha: 0.05 + rand() * 0.07 });
    }
    // Fibres: short strokes whose direction is mostly diagonal, like laid paper.
    for (let i = 0; i < 90; i++) {
      const x = left - 34 + rand() * w;
      const y = top - 34 + rand() * h;
      const len = 4 + rand() * 16;
      const angle = (rand() - 0.5) * 0.9 + (rand() < 0.5 ? 0 : Math.PI / 2);
      g.moveTo(x, y)
        .lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len)
        .stroke({ width: 0.7, color: 0x8a6a3c, alpha: 0.04 + rand() * 0.05 });
    }
    // Vignette: corner shadows pooling toward the edges of the sheet.
    g.roundRect(left - 34, top - 34, w, h, 22).stroke({ width: 26, color: 0x6b5433, alpha: 0.04 });
    g.roundRect(left - 20, top - 20, w - 28, h - 28, 18).stroke({ width: 12, color: 0x6b5433, alpha: 0.03 });
  }

  /** Renders the faint 楚河汉界 across the river gap. */
  drawRiverLabel() {
    const lay = this.lay;
    const style = new TextStyle({
      fontFamily: "Songti SC, SimSun, STSong, serif",
      fontSize: Math.max(20, lay.step * 0.52),
      fill: 0x8a6a3c,
      letterSpacing: Math.max(8, lay.step * 0.3),
    });
    const y = lay.originY + 4.5 * lay.step;
    const left = new Text({ text: "楚河", style });
    const right = new Text({ text: "漢界", style });
    left.anchor.set(0.5);
    right.anchor.set(0.5);
    left.alpha = 0.34;
    right.alpha = 0.34;
    left.position.set(lay.originX + lay.boardWidth * 0.27, y);
    right.position.set(lay.originX + lay.boardWidth * 0.73, y);
    this.boardLayer.addChild(left, right);
  }

  /** Drops every piece view. Only for teardown; a move must never rebuild the layer. */
  clearPieces() {
    this.pieces.reset(this.game, this.lay);
  }

  /**
   * update applies an authoritative snapshot.
   *
   * Effects are derived by diffing against the previous snapshot, so they fire from host
   * state rather than from a local optimistic guess. That is what makes a spectator see
   * the same effects as the player.
   */
  update(snapshot) {
    if (this.destroyed || !this.app) return;
    const cells = snapshot.cells || [];
    const lowMotion = !!snapshot.lowMotion;
    const effectsOff = !!snapshot.effectsOff;
    if (lowMotion !== this.lowMotion) {
      this.lowMotion = lowMotion;
    }
    if (effectsOff !== this.effectsOff) {
      this.effectsOff = effectsOff;
      if (effectsOff) this.clearEffects();
    }

    const lay = this.lay;
    if (!lay) return;
    const cellCount = lay.cells;
    const prev = this.lastCells;
    const positionChanged =
      !!prev &&
      prev.length === cells.length &&
      prev.some((value, index) => value !== cells[index]);
    const nextLastMoveKey =
      snapshot.lastMove && snapshot.lastMove.to >= 0
        ? `${snapshot.lastMove.from ?? -1}:${snapshot.lastMove.to}`
        : "";
    const lastMoveChanged = nextLastMoveKey !== this.lastMoveKey;
    const previousLastMove = this.currentLastMove;
    const previousMoveCount = this.lastMoveCount;
    const previousFinished = this.result?.finished === true;
    const incomingMoveCount = Number(snapshot.moveCount);
    const moveCountDropped =
      Number.isFinite(incomingMoveCount) &&
      Number.isFinite(this.lastMoveCount) &&
      incomingMoveCount < this.lastMoveCount;
    this.lastMoveCount = Number.isFinite(incomingMoveCount) ? incomingMoveCount : this.lastMoveCount;
    if (incomingMoveCount === 0) {
      this.lastCheckMove = -Infinity;
      this.checkStreak = 0;
    }
    this.lastMoveKey = nextLastMoveKey;
    this.drawLastMoveAnchor(snapshot.lastMove);

    // The piece layer resolves identity and animates the move; it reports what it played.
    // Effects are then anchored to that timeline instead of to the snapshot's arrival, so
    // the ink lands when the piece does.
    const immediateUndo = isImmediateXiangqiUndo({
      game: this.game,
      previousMoveCount,
      moveCount: incomingMoveCount,
      previousFinished,
      previousLastMove,
    });
    if (moveCountDropped && immediateUndo && positionChanged && !this.effectsOff && prev) {
      const undoCode = prev[previousLastMove.to] || 0;
      const undoEffect = new GhostMoveEffect({
        from: cellCenter(this.lay, previousLastMove.to),
        to: cellCenter(this.lay, previousLastMove.from),
        glyph: glyphFor(undoCode),
        colour: undoCode > 0 ? PALETTE.red : PALETTE.black,
        kind: Math.abs(undoCode),
        radius: this.lay.step * 0.36,
        lowMotion: this.lowMotion,
        mode: "undo",
      });
      this.effects.push(undoEffect);
      this.audio.play("undo");
      tap([34, 22, 12]);
    }

    const freshGomokuRound = startsFreshGomokuRound({
      game: this.game,
      previousCells: prev,
      cells,
      previousMoveCount,
      moveCount: incomingMoveCount,
      previousFinished,
    });
    if (freshGomokuRound && !this.effectsOff) {
      // The win line and seal belong to the old round. Capture their stones first, rebuild
      // the clean board beneath the transition, then let the empty authoritative position
      // clear the piece layer as usual.
      this.clearEffects();
      this.drawBoard();
      const stoneRadius = this.pieces.radius || lay.step * 0.4;
      const stones = [];
      for (let index = 0; index < prev.length; index++) {
        const code = prev[index] || 0;
        if (!code) continue;
        const point = cellCenter(lay, index);
        stones.push({ code, radius: stoneRadius, x: point.x, y: point.y });
      }
      if (this.boardBounds && stones.length) {
        this.effects.push(
          new RematchInkEffect({
            stones,
            bounds: this.boardBounds,
            lowMotion: this.lowMotion,
          }),
        );
      }
    }

    this.lastCells = Array.from(cells);
    const moves = this.drawPieces(cells, snapshot) || [];

    // A new position means the one-shot cues are live again. This is reset here rather than
    // on move, because a spectator has no move callback at all.
    if (positionChanged) {
      this.cued.check = false;
      this.cued.win = false;
    }

    const lay2 = lay;
    for (const move of moves) {
      const travel = move.duration || 0;
      if (this.game === "xiangqi" && !this.effectsOff && move.fromCell >= 0) {
        const moverColour = move.moverColour ?? landingColour(this.game, snapshot.turnSeat);

        // Cannon captures are the one move whose visual needs an extra rule made visible:
        // the jumped screen is found from the previous authoritative board, not guessed
        // from the destination. Without that piece the shot is a plain capture again.
        if (move.moverKind === PIECE.cannon && move.captured && prev) {
          const between = cellsBetween(lay2, move.fromCell, move.toCell);
          const occupied = between.filter((index) => (prev[index] || 0) !== 0);
          const screenPoint = occupied.length === 1 ? cellCenter(lay2, occupied[0]) : null;
          this.effects.push(
            new CannonBlastEffect({
              from: move.from,
              to: move.to,
              screen: screenPoint,
              radius: lay2.step * 0.4,
              colour: moverColour,
              lowMotion: this.lowMotion,
            }),
          );
          this.audio.play("cannon");
          tap([18, 28, 18]);
        }

        if (crossesRiver(lay2, move.fromCell, move.toCell)) {
          this.effects.push(
            new RiverSurgeEffect({
              left: lay2.originX,
              top: lay2.originY + 4 * lay2.step,
              width: lay2.boardWidth,
              height: lay2.step,
              step: lay2.step,
              colour: moverColour,
              lowMotion: this.lowMotion,
            }),
          );
          this.audio.play("river");
          tap(12);
        }
      }

      // One hand, on the first move of the update. A scenario replay produces several
      // moves in one snapshot, and a hand per move would look like a crowd at the table.
      // The hand belongs to xiangqi piece travel. A gomoku tap places a new stone directly;
      // showing a full hand shadow for both sides made openings look like a shared cursor.
      if (
        this.game === "xiangqi" &&
        !this.effectsOff &&
        !this.lowMotion &&
        !this.hand &&
        travel > 0
      ) {
        const carrier = this.pieces.nodeAt(move.toCell);
        if (carrier) this.startHand(carrier, travel, move);
      }
      // Landing ink fires as the piece touches down; a capture fires a beat earlier so the
      // burst and the knock-back overlap instead of queueing.
      this.schedule(travel, () => {
        const turn = snapshot.turnSeat;
        const localLanding = this.game === "gomoku" && this.consumeLandingHaptic(move.toCell);
        // The snapshot already points at the next player. A move by seat zero therefore
        // arrives with turnSeat=1, so invert it before choosing the landed ink's colour.
        const colour = landingColour(this.game, turn);
        if (!this.effectsOff) {
          const ripple = new RippleEffect({
            x: move.to.x,
            y: move.to.y,
            radius: lay2.step * 0.34,
            colour,
            heavy: this.game === "xiangqi",
            lowMotion: this.lowMotion,
          });
          this.effects.push(ripple);
          if (this.game === "gomoku") {
            this.effects.push(
              new LandingWeightEffect({
                x: move.to.x,
                y: move.to.y,
                radius: lay2.step * 0.4,
                lowMotion: this.lowMotion,
              }),
            );
          }
        }
        this.audio.play(this.game === "xiangqi" ? "landHeavy" : "land", {
          pitch: (move.to.x + move.to.y) % 2 < 1 ? 1.02 : 0.97,
        });
        if (this.game === "xiangqi") tap(6);
        else if (localLanding && !this.effectsOff) tapLanding();

        // A quiet move gets a local board answer. A capture already owns the hit through
        // its directional scar and shock, so doubling the response would make the cut hard
        // to read and flash the whole position at the exact moment of the exchange.
        if (!this.effectsOff && !move.captured) {
          this.pulseShock(move.to, {
            amplitude: 18,
            wavelength: 90,
            speed: 760,
            duration: 0.42,
          });
        }
        if (!this.effectsOff && this.boardBounds && !this.lowMotion && !move.captured) {
          this.effects.push(
            new FlashEffect({
              x: this.boardBounds.left,
              y: this.boardBounds.top,
              width: this.boardBounds.width,
              height: this.boardBounds.height,
              colour: 0xfff4e2,
              peak: 0.14,
              duration: 0.26,
              lowMotion: false,
            }),
          );
        }
      });

      if (move.captured) {
        this.schedule(Math.max(0, travel - 0.06), () => {
          // The victim's own colour, so a capture looks like that piece breaking.
          const broken = move.victimColour ?? (this.game === "xiangqi" ? PALETTE.red : PALETTE.ink);
          const keyCapture =
            this.game === "xiangqi" && isCinematicCapture(move.victimKind);
          if (!this.effectsOff) {
            this.effects.push(
              // The disc comes apart first; the dust trails it.
              new ShatterEffect({
                x: move.to.x,
                y: move.to.y,
                radius: lay2.step * 0.44,
                colour: broken,
                glyph: move.victimGlyph,
                kind: move.victimKind,
                from: move.from,
                to: move.to,
                lowMotion: this.lowMotion,
              }),
              new CaptureBurstEffect({
                x: move.to.x,
                y: move.to.y,
                radius: lay2.step * 0.36,
                colour: broken,
                kind: move.victimKind,
                from: move.from,
                to: move.to,
                lowMotion: this.lowMotion,
              }),
            );
            if (move.moverKind !== PIECE.cannon) {
              this.effects.push(
                new PieceCaptureAccentEffect({
                  from: move.from,
                  to: move.to,
                  kind: move.moverKind,
                  radius: lay2.step * 0.38,
                  colour: move.moverColour ?? landingColour(this.game, snapshot.turnSeat),
                  lowMotion: this.lowMotion,
                }),
              );
            }
            if (keyCapture) {
              this.effects.push(
                new KeyCaptureCinematicEffect({
                  start: move.to,
                  width: this.app.screen.width,
                  height: this.app.screen.height,
                  radius: lay2.step * 1.34,
                  startRadius: lay2.step * 0.36,
                  colour: broken,
                  glyph: move.victimGlyph,
                  kind: move.victimKind,
                  angle: captureImpactAngle(move.from, move.to),
                  lowMotion: this.lowMotion,
                }),
              );
            }
            // A short, tight wave on the struck square: the board takes the hit locally.
            this.pulseShock(move.to, {
              amplitude: keyCapture ? 44 : 22,
              wavelength: keyCapture ? 190 : 105,
              speed: keyCapture ? 780 : 900,
              duration: keyCapture ? 0.68 : 0.46,
            });
          }
          this.audio.play(keyCapture ? "keyCapture" : "capture", {
            pitch: keyCapture ? 0.9 : 1,
            volume: keyCapture ? 1.12 : 1,
          });
          tap(keyCapture ? [12, 34, 20] : [10, 24, 14]);
        });
      }
    }

    // Last-move marker.
    // Room snapshots also arrive for clocks and membership. Replaying the last-move marker
    // on every one kept several copies alive and made an idle board look permanently busy.
    if (
      !this.effectsOff &&
      snapshot.lastMove &&
      snapshot.lastMove.to >= 0 &&
      (positionChanged || lastMoveChanged)
    ) {
      this.playLastMove(snapshot.lastMove, this.lowMotion ? 0.4 : 2.6);
    }

    // Check announcement. Only xiangqi has a general to threaten: a gomoku board that
    // carries a stale inCheck flag (a room switched games, a snapshot replayed) must not
    // sprout a 将 glyph over the stones.
    //
    // This fires on the rising edge only. Pushing a CheckEffect per snapshot used to stack
    // a fresh translucent 将 on top of the last one on every update, so a check read as a
    // muddy blur instead of one decisive slam. The edge also has to be re-armed when check
    // clears, otherwise only the first check of a session would ever be announced.
    if (!this.effectsOff && snapshot.inCheck && this.boardBounds && this.game === "xiangqi") {
      if (!this.cued.check) {
        this.cued.check = true;
        this.checkStreak = nextCheckTier(this.checkStreak, this.lastCheckMove, snapshot.moveCount);
        this.lastCheckMove = Number.isFinite(Number(snapshot.moveCount))
          ? Number(snapshot.moveCount)
          : this.lastCheckMove;
        const focus = snapshot.checkFocus != null ? cellCenter(lay2, snapshot.checkFocus) : null;
        const attackerIndex = Number(snapshot.lastMove?.to);
        const attacker =
          Number.isInteger(attackerIndex) && attackerIndex >= 0 && attackerIndex < lay2.cells
            ? cellCenter(lay2, attackerIndex)
            : null;
        this.effects.push(
          new CheckEffect({
            boardWidth: this.boardBounds.width,
            boardHeight: this.boardBounds.height,
            originX: this.boardBounds.left,
            originY: this.boardBounds.top,
            focus,
            attacker,
            step: lay2.step,
            lowMotion: this.lowMotion,
            tier: this.checkStreak,
          }),
        );
        // The glyph says "check"; the shockwave is what makes the board feel hit.
        this.pulseShock(
          focus ?? {
            x: this.boardBounds.left + this.boardBounds.width / 2,
            y: this.boardBounds.top + this.boardBounds.height / 2,
          },
          {
            amplitude: 66 + (this.checkStreak - 1) * 16,
            wavelength: 220 + (this.checkStreak - 1) * 40,
            speed: 850,
            duration: 0.86 + (this.checkStreak - 1) * 0.1,
          },
        );
        if (!this.lowMotion) {
          this.effects.push(
            new FlashEffect({
              x: this.boardBounds.left,
              y: this.boardBounds.top,
              width: this.boardBounds.width,
              height: this.boardBounds.height,
              colour: 0xffd7c4,
              peak: 0.24 + (this.checkStreak - 1) * 0.045,
              duration: 0.32 + (this.checkStreak - 1) * 0.06,
              lowMotion: false,
            }),
          );
        }
        this.audio.play("check");
        tap([26, 40, 26]);
      }
    } else {
      // Check lifted (or wrong game): re-arm so the next one plays again.
      this.cued.check = false;
    }

    // Terminal result.
    if (snapshot.result && snapshot.result.finished && !this.result) {
      this.result = snapshot.result;
      if (!this.effectsOff) this.playWin(snapshot, cells);
    }
    if (!snapshot.result || !snapshot.result.finished) {
      this.result = null;
    }
  }

  /** Builds the win effect from the winning line, when the host supplies one. */
  playWin(snapshot, cells) {
    const lay = this.lay;
    const points = (snapshot.winLine || []).map((index) => cellCenter(lay, index));
    let sealAt = null;
    if (points.length) {
      // The seal marks the decisive stone, not the middle of the line: the winning move is
      // the one worth pointing at afterwards. It is nudged just past that stone, because a
      // stamp centred on a stone hides the very piece it is celebrating.
      const lastIndex = snapshot.lastMove?.to;
      const winIndexes = snapshot.winLine || [];
      const at = winIndexes.indexOf(lastIndex);
      const anchor = at >= 0 ? points[at] : points[points.length - 1];
      const prev = at > 0 ? points[at - 1] : points.length > 1 ? points[0] : null;
      let dx = 0;
      let dy = -1;
      if (prev) {
        const vx = anchor.x - prev.x;
        const vy = anchor.y - prev.y;
        const len = Math.hypot(vx, vy) || 1;
        dx = vx / len;
        dy = vy / len;
      }
      const push = lay.step * 0.78;
      // Clamped inside the board: a win on the last rank would otherwise push the stamp
      // half off the paper.
      const margin = lay.step * 0.5;
      sealAt = {
        x: Math.min(Math.max(anchor.x + dx * push, lay.originX + margin), lay.originX + lay.boardWidth - margin),
        y: Math.min(Math.max(anchor.y + dy * push, lay.originY + margin), lay.originY + lay.boardHeight - margin),
      };
    } else {
      // Xiangqi: stamp the losing general's square.
      for (let i = 0; i < cells.length; i++) {
        if (Math.abs(cells[i]) === PIECE.king) {
          sealAt = cellCenter(lay, i);
          break;
        }
      }
    }
    if (this.game === "xiangqi" && sealAt) {
      this.effects.push(
        new VictoryFractureEffect({
          center: sealAt,
          step: lay.step,
          lowMotion: this.lowMotion,
        }),
      );
    }
    this.effects.push(
      new WinEffect({
        points,
        sealAt,
        step: lay.step,
        lowMotion: this.lowMotion,
        // 连五 for five-in-a-row, 胜 for a decided chess game: the block should say what
        // actually happened, not just "someone won".
        sealGlyph: this.game === "gomoku" ? "五" : "胜",
      }),
    );
    // The stamp is the heaviest moment in the whole game, so it gets the strongest wave.
    // Scheduled to land with the seal rather than at t=0, which would fire it during the
    // line-drawing phase and be over before the seal arrives.
    if (sealAt) {
      const stampAt = this.lowMotion ? 0.3 : 0.85 + 0.35;
      this.schedule(stampAt, () =>
        this.pulseShock(sealAt, { amplitude: 60, wavelength: 260, speed: 940, duration: 0.95 }),
      );
    }
    if (this.boardBounds) {
      this.effects.push(
        new FlashEffect({
          x: this.boardBounds.left,
          y: this.boardBounds.top,
          width: this.boardBounds.width,
          height: this.boardBounds.height,
          colour: 0xfff3d8,
          peak: 0.34,
          duration: 0.5,
          lowMotion: this.lowMotion,
        }),
      );
    }
    if (!this.cued.win) {
      this.cued.win = true;
      this.audio.play("win");
      tap([18, 60, 40]);
    }
  }

  /**
   * Hands the authoritative cell array to the piece layer.
   *
   * The layer keeps its views alive and animates a recognised move; it reports back the
   * moves it played so the ink can be anchored to the same event. The old implementation
   * destroyed and rebuilt every piece here, which is why nothing on the board ever moved.
   */
  drawPieces(cells, snapshot = {}) {
    const terminal =
      this.game === "xiangqi" &&
      snapshot.result?.finished === true &&
      !!snapshot.lastMove &&
      Number(snapshot.lastMove.to) >= 0;
    const moves = this.pieces.sync(cells, this.lay, { animate: true, terminal });
    this.lastMoves = moves;
    return moves;
  }

  /**
   * Leaves a faint destination ring until the next move. This is deliberately separate
   * from transient ink: a missed two-second animation should not erase the answer.
   */
  drawLastMoveAnchor(lastMove, { force = false } = {}) {
    if (!this.lastMoveLayer || !this.lay) return;
    const valid = !!lastMove && Number.isInteger(Number(lastMove.to)) && Number(lastMove.to) >= 0;
    const key = valid ? `${lastMove.from ?? -1}:${lastMove.to}` : "";
    const fromIndex = lastMove?.from == null ? -1 : Number(lastMove.from);
    this.currentLastMove = valid
      ? { from: Number.isInteger(fromIndex) ? fromIndex : -1, to: Number(lastMove.to) }
      : null;
    if (!force && key === this.lastMoveAnchorKey) return;
    this.lastMoveAnchorKey = key;
    this.lastMoveLayer.removeChildren().forEach((child) => child.destroy({ children: true }));
    if (!valid) return;

    const lay = this.lay;
    const to = cellCenter(lay, this.currentLastMove.to);
    const radius = lay.step * 0.46;
    const anchor = new Graphics();
    anchor.circle(to.x, to.y, radius * 1.13).fill({ color: PALETTE.gold, alpha: 0.035 });
    anchor.circle(to.x, to.y, radius).stroke({ width: 2.2, color: PALETTE.gold, alpha: 0.32 });
    anchor.circle(to.x, to.y, radius * 0.16).fill({ color: PALETTE.gold, alpha: 0.2 });
    this.lastMoveLayer.addChild(anchor);
  }

  clearLastMove() {
    this.currentLastMove = null;
    this.lastMoveAnchorKey = "";
    if (this.lastMoveLayer) {
      this.lastMoveLayer.removeChildren().forEach((child) => child.destroy({ children: true }));
    }
  }

  /**
   * Replays the from-to trace on demand. Repeated presses replace the current replay so
   * effects cannot stack into a permanently busy board.
   */
  showLastMove(lastMove = this.currentLastMove, { duration = 4 } = {}) {
    if (!lastMove || !this.lay) return false;
    const toIndex = Number(lastMove.to);
    if (!Number.isInteger(toIndex) || toIndex < 0) return false;
    this.playLastMove(lastMove, duration);

    if (this.replayGhostEffect) {
      const existing = this.effects.indexOf(this.replayGhostEffect);
      if (existing >= 0) this.effects.splice(existing, 1);
      this.replayGhostEffect.destroy();
    }
    const lay = this.lay;
    const cells = this.pieces.cellsOf();
    const code = cells[toIndex] || 0;
    const fromIndex = lastMove.from == null ? -1 : Number(lastMove.from);
    const from = Number.isInteger(fromIndex) && fromIndex >= 0 ? cellCenter(lay, fromIndex) : null;
    const to = cellCenter(lay, toIndex);
    if (from) {
      const ghost = new GhostMoveEffect({
        from,
        to,
        glyph: glyphFor(code),
        colour:
          this.game === "gomoku"
            ? code === 2
              ? PALETTE.paper
              : PALETTE.ink
            : code > 0
              ? PALETTE.red
              : PALETTE.black,
        kind: Math.abs(code),
        radius: lay.step * 0.36,
        lowMotion: this.lowMotion,
        mode: "replay",
      });
      this.replayGhostEffect = ghost;
      this.effects.push(ghost);

      if (this.game === "xiangqi" && Math.abs(code) === PIECE.cannon) {
        const between = cellsBetween(lay, fromIndex, toIndex);
        const occupied = between.filter((index) => (cells[index] || 0) !== 0);
        this.effects.push(
          new CannonBlastEffect({
            from,
            to,
            screen: occupied.length === 1 ? cellCenter(lay, occupied[0]) : null,
            radius: lay.step * 0.4,
            colour: code > 0 ? PALETTE.red : PALETTE.black,
            lowMotion: this.lowMotion,
          }),
        );
        this.audio.play("cannon");
      }
    }
    return true;
  }

  playLastMove(lastMove, duration) {
    if (this.lastMoveEffect) {
      const index = this.effects.indexOf(this.lastMoveEffect);
      if (index >= 0) this.effects.splice(index, 1);
      this.lastMoveEffect.destroy();
    }
    const lay = this.lay;
    const to = cellCenter(lay, Number(lastMove.to));
    const fromIndex = lastMove.from == null ? -1 : Number(lastMove.from);
    const from = Number.isInteger(fromIndex) && fromIndex >= 0 ? cellCenter(lay, fromIndex) : null;
    const effect = new LastMoveEffect({
      from,
      to,
      radius: lay.step * 0.42,
      lowMotion: this.lowMotion || this.effectsOff,
      duration,
      wave: this.game === "gomoku",
    });
    this.lastMoveEffect = effect;
    this.effects.push(effect);
  }

  /** Draws legal destination hints for the selected piece. */
  showHints(indexes) {
    if (!this.lay) return;
    this.pieces.showHints(this.lay, indexes);
  }

  /** Selects a piece locally and asks the host for its legal destinations. */
  select(index) {
    this.selected = index;
    this.pieces.setSelected(index);
    this.callbacks.onSelect?.(index);
  }

  clearSelection() {
    this.selected = -1;
    this.pieces.setSelected(-1);
    this.showHints([]);
  }

  onPointer(event) {
    if (!this.lay) return;
    // The first pointer contact is the only reliable moment to open an AudioContext.
    this.audio.unlock();
    const point = event.getLocalPosition(this.app.stage);
    const index = cellAt(this.lay, point.x, point.y);
    if (index < 0) return;
    this.callbacks.onCell?.(index);
  }

  /** Opens the shared match audio context from a user gesture. */
  unlockAudio() {
    this.audio.unlock();
  }

  /** Plays a short named interface sound through the board's shared audio context. */
  playSound(name) {
    this.audio.play(name);
  }

  /** Records the destination of a locally initiated gomoku move. */
  armLandingHaptic(index) {
    const cell = Number(index);
    if (!Number.isInteger(cell) || cell < 0) return;
    this.landingHaptic = {
      cell,
      at: typeof performance !== "undefined" ? performance.now() : Date.now(),
    };
  }

  /**
   * Consumes a matching local tap only when the authoritative stone lands. A short expiry
   * protects the next move from inheriting a haptic after a rejected or timed-out request.
   */
  consumeLandingHaptic(index) {
    const pending = this.landingHaptic;
    this.landingHaptic = null;
    if (!pending || pending.cell !== Number(index)) return false;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    return now - pending.at <= 3000;
  }

  /**
   * Puts a hand on the moving piece.
   *
   * The piece itself still animates from the tween — the hand is a second, larger body that
   * tracks the same node, so the two can never disagree about where the piece is.
   */
  startHand(node, travel, move) {
    const pos = node.container.position;
    // The arm reaches in from the side the piece came from: near seat for a piece that
    // started in the lower half of the board, far seat for the upper half.
    const centerY = this.boardBounds
      ? this.boardBounds.top + this.boardBounds.height / 2
      : pos.y;
    const side = move && move.from && move.from.y < centerY ? "far" : "near";
    const cursor = new HandShadow({ x: pos.x, y: pos.y, radius: node.radius, side });
    // Under the pieces, on the board itself: a shadow falls on the surface, so the piece
    // that is being carried has to stay legible on top of it.
    this.underLayer.addChild(cursor.view);
    this.hand = { cursor, node, remaining: travel };
  }

  updateHand(step) {
    const hand = this.hand;
    if (!hand) return;
    hand.remaining -= step;
    if (hand.remaining <= 0) hand.cursor.release();
    hand.cursor.update(step, {
      x: hand.node.container.x,
      y: hand.node.container.y,
    });
    if (hand.cursor.done) {
      hand.cursor.destroy();
      this.hand = null;
    }
  }

  /** Queues a callback to run after `delay` seconds of scene time. */
  schedule(delay, fn) {
    if (delay <= 0) {
      fn();
      return;
    }
    this.pending.push({ at: delay, fn });
  }

  /**
   * Fires a board-wide radial shockwave from `point` (scene coordinates).
   *
   * This is the one distortion in the whole effect set: everything else is ink painted on
   * top of the board, but a shockwave bends the board itself, which is what sells an
   * impact. It is capped short and detached afterwards because a filter on the root makes
   * every frame a render-to-texture.
   */
  pulseShock(point, { amplitude = 26, wavelength = 150, speed = 700, duration = 0.62 } = {}) {
    if (this.effectsOff || this.lowMotion || !this.root) return;
    if (!point) return;
    try {
      const filter = new ShockwaveFilter({
        center: { x: point.x, y: point.y },
        amplitude,
        wavelength,
        speed,
        brightness: 1.15,
        radius: 900,
        time: 0,
      });
      this.root.filters = [filter];
      // Keep the requested amplitude: the decay in tick() scales from it, and a hardcoded
      // base silently clamped every stronger wave back to the same thin ripple.
      this.shock = { filter, age: 0, duration, amplitude };
    } catch {
      // A filter that will not compile costs distortion, not the effect underneath.
      this.shock = null;
    }
  }

  /** Stops animation while the page is hidden or suspended by the host. */
  suspend() {
    this.app?.ticker.stop();
  }

  /**
   * Re-arms Pixi after the page becomes visible again. A long background stay can leave
   * half-finished ink from an old move on screen, so callers may discard transient effects
   * before the next authoritative snapshot is painted.
   */
  resume({ discardEffects = false } = {}) {
    if (this.destroyed || !this.app) return;
    if (discardEffects) this.clearEffects();
    this.app.ticker.start();
    this.app.renderer.render(this.app.stage);
  }

  /** Advances all live effects. */
  tick(dt) {
    if (this.destroyed) return;
    // Cap dt so a background tab returning to focus cannot fast-forward every effect.
    // A throttled tab can also report a missing/NaN delta once; treating that as a normal
    // frame prevents every effect age from becoming permanently NaN.
    const step = Number.isFinite(dt) ? Math.min(Math.max(0, dt), 0.05) : 1 / 60;
    this.pieces.update(step);
    this.updateHand(step);

    // Settle the shockwave, then take the filter off the root as soon as it has run.
    if (this.shock) {
      this.shock.age += step;
      const t = this.shock.age / this.shock.duration;
      if (t >= 1) {
        this.root.filters = null;
        this.shock = null;
      } else {
        // Ease the amplitude out so the wave dies instead of vanishing mid-ripple.
        this.shock.filter.time = this.shock.age;
        this.shock.filter.amplitude = this.shock.amplitude * (1 - t) * (1 - t);
      }
    }

    // Fire due cues. Iterate a copy because a callback may push effects, not cues.
    if (this.pending.length) {
      const due = [];
      for (let i = this.pending.length - 1; i >= 0; i--) {
        const item = this.pending[i];
        item.at -= step;
        if (item.at <= 0) {
          due.push(item);
          this.pending.splice(i, 1);
        }
      }
      for (const item of due) item.fn();
    }
    for (const effect of this.effects) effect.update(step);

    if (this.lastMoveEffect?.done) this.lastMoveEffect = null;
    if (this.replayGhostEffect?.done) this.replayGhostEffect = null;

    // Camera shake is owned by the check effect and applied to the board as a whole.
    let shake = { x: 0, y: 0 };
    for (const effect of this.effects) {
      if (effect instanceof CheckEffect) {
        shake = effect.shake();
        break;
      }
    }
    if (this.boardLayer) this.boardLayer.position.set(shake.x, shake.y);
    if (this.lastMoveLayer) this.lastMoveLayer.position.set(shake.x, shake.y);
    if (this.pieceLayer) this.pieceLayer.position.set(shake.x, shake.y);
    if (this.effectLayer) this.effectLayer.position.set(shake.x, shake.y);
    if (this.underLayer) this.underLayer.position.set(shake.x, shake.y);
    if (this.overlayLayer) this.overlayLayer.position.set(shake.x, shake.y);

    for (const effect of this.effects) {
      if (effect.view && !effect.view.parent) {
        const target = effect.under ? this.underLayer : this.effectLayer;
        if (target) target.addChild(effect.view);
      }
      // Some effects split across layers: the win stroke sits under the stones while its
      // seal lands on top of them, so it carries a second container that always goes above.
      if (effect.overlayView && !effect.overlayView.parent && this.overlayLayer) {
        this.overlayLayer.addChild(effect.overlayView);
      }
    }

    for (let i = this.effects.length - 1; i >= 0; i--) {
      if (this.effects[i].done) {
        if (this.effects[i] === this.lastMoveEffect) this.lastMoveEffect = null;
        if (this.effects[i] === this.replayGhostEffect) this.replayGhostEffect = null;
        this.effects[i].destroy();
        this.effects.splice(i, 1);
      }
    }
  }

  /** Clears transient ink, used when navigating a replay or undoing. */
  /** Drops the hand without waiting for it to withdraw. */
  clearHand() {
    if (!this.hand) return;
    this.hand.cursor.destroy();
    this.hand = null;
  }

  clearEffects() {
    // A hand is anchored to a piece node; if the board is rebuilt that node is gone and the
    // hand would be left pointing at nothing.
    this.clearHand();
    this.pending.length = 0;
    clearTransient(this.effects);
    this.lastMoveEffect = null;
    this.replayGhostEffect = null;
    if (this.shock) {
      if (this.root) this.root.filters = null;
      this.shock = null;
    }
    if (this.boardLayer) this.boardLayer.position.set(0, 0);
    if (this.lastMoveLayer) this.lastMoveLayer.position.set(0, 0);
    if (this.pieceLayer) this.pieceLayer.position.set(0, 0);
    if (this.effectLayer) this.effectLayer.position.set(0, 0);
    if (this.overlayLayer) this.overlayLayer.position.set(0, 0);
  }

  destroy() {
    this.destroyed = true;
    this.app?.ticker.stop();
    this.clearEffects();
    this.audio.destroy();
    if (this.app) {
      this.app.destroy(true, { children: true });
      this.app = null;
    }
  }
}
