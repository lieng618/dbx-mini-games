/**
 * Board geometry shared by both games.
 *
 * The canvas always uses the same logical coordinate space regardless of screen size, so
 * effects and hit-testing can be written once and never fight the layout.
 */

export const LOGICAL_WIDTH = 1600;
export const LOGICAL_HEIGHT = 900;

/** Xiangqi board: 9 files by 10 ranks of intersection points. */
export const XIANGQI = {
  files: 9,
  ranks: 10,
  /** Board frame in logical pixels. */
  padding: 96,
};

/** Gomoku board: 15x15 intersection points. */
export const GOMOKU = {
  files: 15,
  ranks: 15,
  padding: 84,
};

/**
 * Piece codes mirrored from the Go engine. Sign is the owner: positive is seat one
 * (red for xiangqi, black stone for gomoku), negative is seat two.
 */
export const PIECE = {
  king: 1,
  advisor: 2,
  elephant: 3,
  horse: 4,
  rook: 5,
  cannon: 6,
  pawn: 7,
};

/**
 * Glyphs for xiangqi pieces. Red and black use different characters for the same kind,
 * as on a real set.
 */
const RED_GLYPHS = {
  [PIECE.king]: "帅",
  [PIECE.advisor]: "仕",
  [PIECE.elephant]: "相",
  [PIECE.horse]: "马",
  [PIECE.rook]: "车",
  [PIECE.cannon]: "炮",
  [PIECE.pawn]: "兵",
};

const BLACK_GLYPHS = {
  [PIECE.king]: "将",
  [PIECE.advisor]: "士",
  [PIECE.elephant]: "象",
  [PIECE.horse]: "马",
  [PIECE.rook]: "车",
  [PIECE.cannon]: "炮",
  [PIECE.pawn]: "卒",
};

/** Returns the display glyph for a xiangqi piece code, or an empty string. */
export function glyphFor(code) {
  if (!code) return "";
  const kind = Math.abs(code);
  return code > 0 ? RED_GLYPHS[kind] : BLACK_GLYPHS[kind];
}

/**
 * Layout computes the board rectangle and the point spacing for one game.
 *
 * Points sit on intersections, so a board with `files` points has `files - 1` gaps. The
 * inset keeps the outermost points clear of the frame on both axes.
 */
export function layout(game) {
  const spec = game === "xiangqi" ? XIANGQI : GOMOKU;
  const inset = spec.padding;
  const usableWidth = LOGICAL_WIDTH - inset * 2;
  const usableHeight = LOGICAL_HEIGHT - inset * 2;

  const stepX = usableWidth / (spec.files - 1);
  const stepY = usableHeight / (spec.ranks - 1);
  // Keep the cell square so stones and pieces never look stretched.
  const step = Math.min(stepX, stepY);

  const boardWidth = step * (spec.files - 1);
  const boardHeight = step * (spec.ranks - 1);

  return {
    game,
    files: spec.files,
    ranks: spec.ranks,
    step,
    originX: (LOGICAL_WIDTH - boardWidth) / 2,
    originY: (LOGICAL_HEIGHT - boardHeight) / 2,
    boardWidth,
    boardHeight,
    cells: spec.files * spec.ranks,
  };
}

/** Converts a cell index to its centre point in logical pixels. */
export function cellCenter(lay, index) {
  const file = index % lay.files;
  const rank = Math.floor(index / lay.files);
  return {
    x: lay.originX + file * lay.step,
    y: lay.originY + rank * lay.step,
  };
}

/**
 * Converts a logical point to a cell index, or -1 when the point is too far from any
 * intersection. The tolerance is generous enough to make touch targets comfortable.
 */
export function cellAt(lay, x, y) {
  const file = Math.round((x - lay.originX) / lay.step);
  const rank = Math.round((y - lay.originY) / lay.step);
  if (file < 0 || file >= lay.files || rank < 0 || rank >= lay.ranks) return -1;
  const cx = lay.originX + file * lay.step;
  const cy = lay.originY + rank * lay.step;
  const tolerance = lay.step * 0.48;
  if (Math.abs(x - cx) > tolerance || Math.abs(y - cy) > tolerance) return -1;
  return rank * lay.files + file;
}
