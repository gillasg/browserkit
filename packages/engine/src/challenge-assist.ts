// Pure geometry and state helpers for challenge assistance. They are kept outside the browser
// code sandbox so the parts that are easy to get wrong (column scores, tile order, attempt
// budget) are covered by unit tests even though the page-side loop calls its own copy.
export interface ChallengeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A grid in reading order: left-to-right, then top-to-bottom, numbered from 1. */
export function gridTiles(
  box: ChallengeBox,
  rows = 3,
  cols = 3,
): (ChallengeBox & { index: number })[] {
  const tiles: (ChallengeBox & { index: number })[] = [];
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++)
      tiles.push({
        index: row * cols + col + 1,
        x: box.x + (col * box.width) / cols,
        y: box.y + (row * box.height) / rows,
        width: box.width / cols,
        height: box.height / rows,
      });
  return tiles;
}

/** Pixel centre of a numbered tile. */
export function tileCentre(tile: ChallengeBox): { x: number; y: number } {
  return { x: tile.x + tile.width / 2, y: tile.y + tile.height / 2 };
}

/** Every token must be filled, or the widget must be gone. */
export function challengeCleared(tokens: readonly boolean[], framePresent: boolean): boolean {
  if (tokens.some(Boolean)) return true;
  return !framePresent;
}

/** Three stages per page; the fourth attempt hands off. */
export function attemptAllowed(attempts: number): boolean {
  return attempts <= 3;
}
