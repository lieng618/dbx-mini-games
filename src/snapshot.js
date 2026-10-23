/**
 * Reconciles the last-move marker with an incoming protocol snapshot.
 *
 * Board snapshots are authoritative even when they omit `lastMove`: an empty opening
 * position means there is no last move. Partial snapshots, such as a profile update, must
 * leave the current board state alone.
 */
export function reconcileLastMove(snapshot, current = null) {
  if (!snapshot || typeof snapshot !== "object") return current;
  const hasBoard = Array.isArray(snapshot.cells);
  const hasLastMove = Object.prototype.hasOwnProperty.call(snapshot, "lastMove");
  if (!hasBoard && !hasLastMove) return current;
  return snapshot.lastMove ?? null;
}
