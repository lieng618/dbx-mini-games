/**
 * BoardScene renders one board and its effects on a Pixi canvas.
 *
 * The scene is deliberately state-light: it is told what the position is and draws it.
 * It never validates moves or decides outcomes — the host is the only authority. Its
 * public surface is `update`, `flashEffects`, and `destroy`.
 */

import { Application, Container, Graphics, Text, TextStyle } from "pixi.js";
import { LOGICAL_HEIGHT, LOGICAL_WIDTH, PIECE, cellAt, cellCenter, glyphFor, layout } from "./layout.js";
import {
  CaptureBurstEffect,
  CheckEffect,
  LastMoveEffect,
  PALETTE,
  RippleEffect,
  WinEffect,
  clearTransient,
} from "./effects.js";

/** Resolves a player's ink colour from their seat. */
function seatColour(seat) {
  return seat === 0 ? PALETTE.red : PALETTE.black;
}

export class BoardScene {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.app = null;
    this.game = null;
    this.lay = null;
    this.lowMotion = false;
    this.effects = [];
    this.pieceViews = [];
    this.selected = -1;
    this.lastCells = null;
    this.lastMove = null;
    this.result = null;
    this.destroyed = false;
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
    this.pieceLayer = new Container();
    this.effectLayer = new Container();
    this.root.addChild(this.boardLayer, this.pieceLayer, this.effectLayer);
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
    this.game = game;
    this.lay = layout(game);
    this.selected = -1;
    this.drawBoard();
    this.clearPieces();
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

  clearPieces() {
    this.pieceLayer.removeChildren().forEach((child) => child.destroy({ children: true }));
    this.pieceViews = [];
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
    if (lowMotion !== this.lowMotion) {
      this.lowMotion = lowMotion;
    }

    const lay = this.lay;
    if (!lay) return;
    const cellCount = lay.cells;
    const prev = this.lastCells;

    // Detect a capture or a landing by comparing arrays.
    let landed = -1;
    let captured = -1;
    if (prev && prev.length === cells.length) {
      for (let i = 0; i < cellCount; i++) {
        const before = prev[i] || 0;
        const after = cells[i] || 0;
        if (before !== after) {
          if (after !== 0) landed = i;
          if (before !== 0 && after === 0) captured = i;
          // A move that lands and clears the origin in one snapshot: the origin is a
          // capture only for xiangqi, where the piece physically left.
          if (before !== 0 && after === 0 && this.game === "xiangqi") captured = i;
        }
      }
    }

    this.lastCells = Array.from(cells);
    this.drawPieces(cells);

    const lay2 = lay;
    if (landed >= 0) {
      const point = cellCenter(lay2, landed);
      this.effects.push(
        new RippleEffect({
          x: point.x,
          y: point.y,
          radius: lay2.step * 0.34,
          heavy: this.game === "xiangqi",
          lowMotion: this.lowMotion,
        }),
      );
    }
    // A xiangqi capture shows as the destination changing from an enemy piece to ours,
    // which the diff above reports as `landed` with a nonzero `before`. Detect that case
    // explicitly so the burst fires on the captured square.
    if (prev && this.game === "xiangqi" && landed >= 0 && prev[landed]) {
      const point = cellCenter(lay2, landed);
      this.effects.push(
        new CaptureBurstEffect({
          x: point.x,
          y: point.y,
          radius: lay2.step * 0.36,
          colour: seatColour(prev[landed] > 0 ? 0 : 1),
          lowMotion: this.lowMotion,
        }),
      );
    }
    if (captured >= 0 && this.game !== "xiangqi") {
      const point = cellCenter(lay2, captured);
      this.effects.push(
        new CaptureBurstEffect({
          x: point.x,
          y: point.y,
          radius: lay2.step * 0.3,
          lowMotion: this.lowMotion,
        }),
      );
    }

    // Last-move marker.
    if (snapshot.lastMove && snapshot.lastMove.to >= 0) {
      const to = cellCenter(lay2, snapshot.lastMove.to);
      const from = snapshot.lastMove.from >= 0 ? cellCenter(lay2, snapshot.lastMove.from) : null;
      this.effects.push(
        new LastMoveEffect({ from, to, radius: lay2.step * 0.42, lowMotion: this.lowMotion }),
      );
    }

    // Check announcement.
    if (snapshot.inCheck && this.boardBounds) {
      const focus = snapshot.checkFocus != null ? cellCenter(lay2, snapshot.checkFocus) : null;
      this.effects.push(
        new CheckEffect({
          boardWidth: this.boardBounds.width,
          boardHeight: this.boardBounds.height,
          focus,
          lowMotion: this.lowMotion,
        }),
      );
      this.boardLayer.position.set(0, 0);
    }

    // Terminal result.
    if (snapshot.result && snapshot.result.finished && !this.result) {
      this.result = snapshot.result;
      this.playWin(snapshot, cells);
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
      sealAt = points[Math.floor(points.length / 2)];
    } else {
      // Xiangqi: stamp the losing general's square.
      for (let i = 0; i < cells.length; i++) {
        if (Math.abs(cells[i]) === PIECE.king) {
          sealAt = cellCenter(lay, i);
          break;
        }
      }
    }
    this.effects.push(new WinEffect({ points, sealAt, lowMotion: this.lowMotion }));
  }

  /** Draws every piece and stone from a cell array. */
  drawPieces(cells) {
    this.clearPieces();
    const lay = this.lay;
    // Pieces must not touch on xiangqi's tighter grid; 0.36 of the gap reads as a proper
    // set with a visible gap between neighbouring discs.
    const radius = lay.step * (this.game === "xiangqi" ? 0.355 : 0.4);

    for (let i = 0; i < cells.length; i++) {
      const code = cells[i] || 0;
      if (!code) continue;
      const point = cellCenter(lay, i);
      const view = new Container();
      view.position.set(point.x, point.y);

      const disc = new Graphics();
      if (this.game === "xiangqi") {
        disc.circle(0, 0, radius).fill({ color: 0xf6efdd, alpha: 1 });
        disc.circle(0, 0, radius).stroke({ width: 2, color: code > 0 ? PALETTE.red : PALETTE.black, alpha: 0.9 });
        disc.circle(0, 0, radius * 0.84).stroke({ width: 1, color: code > 0 ? PALETTE.red : PALETTE.black, alpha: 0.45 });
      } else {
        const stone = code > 0 ? PALETTE.black : 0xf4efe4;
        disc.circle(0, 0, radius).fill({ color: stone, alpha: 1 });
        disc.circle(0, 0, radius).stroke({ width: 1, color: 0x8f8578, alpha: 0.5 });
      }
      view.addChild(disc);

      if (this.game === "xiangqi") {
        const glyph = glyphFor(code);
        if (glyph) {
          const text = new Text({
            text: glyph,
            style: new TextStyle({
              fontFamily: "Songti SC, SimSun, STSong, serif",
              fontSize: radius * 1.24,
              fontWeight: "600",
              fill: code > 0 ? PALETTE.red : PALETTE.black,
            }),
          });
          text.anchor.set(0.5);
          text.position.set(0, radius * 0.04);
          view.addChild(text);
        }
      }

      // Selection ring for the piece the local player picked up.
      if (i === this.selected) {
        const ring = new Graphics();
        ring.circle(0, 0, radius * 1.2).stroke({ width: 2.6, color: PALETTE.gold, alpha: 0.95 });
        view.addChild(ring);
      }

      this.pieceLayer.addChild(view);
      this.pieceViews.push(view);
    }
  }

  /** Draws legal destination hints for the selected piece. */
  showHints(indexes) {
    if (!this.hintLayer) {
      this.hintLayer = new Container();
      this.effectLayer.addChild(this.hintLayer);
    }
    this.hintLayer.removeChildren().forEach((child) => child.destroy({ children: true }));
    const lay = this.lay;
    for (const index of indexes || []) {
      if (index < 0 || index >= lay.cells) continue;
      const point = cellCenter(lay, index);
      const dot = new Graphics();
      dot.circle(point.x, point.y, lay.step * 0.11).fill({ color: PALETTE.gold, alpha: 0.72 });
      dot.circle(point.x, point.y, lay.step * 0.42).stroke({ width: 1.6, color: PALETTE.gold, alpha: 0.34 });
      this.hintLayer.addChild(dot);
    }
  }

  /** Selects a piece locally and asks the host for its legal destinations. */
  select(index) {
    this.selected = index;
    if (this.lastCells) this.drawPieces(this.lastCells);
    this.callbacks.onSelect?.(index);
  }

  clearSelection() {
    this.selected = -1;
    this.showHints([]);
    if (this.lastCells) this.drawPieces(this.lastCells);
  }

  onPointer(event) {
    if (!this.lay) return;
    const point = event.getLocalPosition(this.app.stage);
    const index = cellAt(this.lay, point.x, point.y);
    if (index < 0) return;
    this.callbacks.onCell?.(index);
  }

  /** Advances all live effects. */
  tick(dt) {
    if (this.destroyed) return;
    // Cap dt so a background tab returning to focus cannot fast-forward every effect.
    const step = Math.min(dt, 0.05);
    for (const effect of this.effects) effect.update(step);

    // Camera shake is owned by the check effect and applied to the board as a whole.
    let shake = { x: 0, y: 0 };
    for (const effect of this.effects) {
      if (effect instanceof CheckEffect) {
        shake = effect.shake();
        break;
      }
    }
    if (this.boardLayer) this.boardLayer.position.set(shake.x, shake.y);
    if (this.pieceLayer) this.pieceLayer.position.set(shake.x, shake.y);
    if (this.effectLayer) this.effectLayer.position.set(shake.x, shake.y);

    for (const effect of this.effects) {
      if (effect.view && !effect.view.parent && this.effectLayer) {
        this.effectLayer.addChild(effect.view);
      }
    }

    for (let i = this.effects.length - 1; i >= 0; i--) {
      if (this.effects[i].done) {
        this.effects[i].destroy();
        this.effects.splice(i, 1);
      }
    }
  }

  /** Clears transient ink, used when navigating a replay or undoing. */
  clearEffects() {
    clearTransient(this.effects);
    if (this.boardLayer) this.boardLayer.position.set(0, 0);
    if (this.pieceLayer) this.pieceLayer.position.set(0, 0);
    if (this.effectLayer) this.effectLayer.position.set(0, 0);
  }

  destroy() {
    this.destroyed = true;
    this.clearEffects();
    if (this.app) {
      this.app.destroy(true, { children: true });
      this.app = null;
    }
  }
}
