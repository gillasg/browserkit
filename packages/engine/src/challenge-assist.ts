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

/**
 * The darkest column in a strip, as an offset from the handle. A slider gap is a vertical band
 * darker than the track's median column; noise below `minFraction` is ignored.
 */
export function columnGap(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  handleX: number,
  minFraction = 0.08,
): number | undefined {
  const fractions: number[] = [];
  for (let x = 0; x < width; x++) {
    let dark = 0;
    for (let y = 0; y < height; y++) {
      const at = (y * width + x) * 4;
      const value = (rgba[at] ?? 0) + (rgba[at + 1] ?? 0) + (rgba[at + 2] ?? 0);
      if (value < 330) dark++;
    }
    fractions.push(dark / height);
  }
  const median = [...fractions].sort((a, b) => a - b)[Math.floor(fractions.length / 2)] ?? 0;
  let peak = -1;
  let score = 0;
  for (let x = 0; x < fractions.length; x++) {
    const excess = (fractions[x] ?? 0) - median;
    if (excess > score) {
      score = excess;
      peak = x;
    }
  }
  if (peak < 0 || score < minFraction) return undefined;
  return peak - handleX;
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
