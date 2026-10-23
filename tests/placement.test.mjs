import test from "node:test";
import assert from "node:assert/strict";

import { layout } from "../src/board/layout.js";
import { PieceLayer } from "../src/board/pieces.js";

test("the first gomoku stone goes through the animated placement path", () => {
  const lay = layout("gomoku");
  const pieces = new PieceLayer();
  const empty = new Array(lay.cells).fill(0);
  const first = empty.slice();
  const to = 7 * lay.files + 7;
  first[to] = 1;

  pieces.reset("gomoku", lay);
  assert.deepEqual(pieces.sync(empty, lay), []);

  const moves = pieces.sync(first, lay);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].toCell, to);
  assert.equal(pieces.nodeAt(to)?.tween?.kind, "place");

  pieces.root.destroy({ children: true });
});
