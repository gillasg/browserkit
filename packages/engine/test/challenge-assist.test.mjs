import assert from "node:assert/strict";
import test from "node:test";
import {
  attemptAllowed,
  challengeCleared,
  columnGap,
  gridTiles,
  tileCentre,
} from "../dist/challenge-assist.js";

test("a darker gap column is found against the track median", () => {
  const width = 60;
  const height = 8;
  const rgba = new Uint8ClampedArray(width * height * 4).fill(220);
  for (let y = 0; y < height; y++)
    for (let x = 43; x < 46; x++) {
      const at = (y * width + x) * 4;
      rgba[at] = rgba[at + 1] = rgba[at + 2] = 20;
      rgba[at + 3] = 255;
    }
  assert.equal(columnGap(rgba, width, height, 30), 13);
});

test("tiles are numbered in reading order and centres sit inside them", () => {
  const tiles = gridTiles({ x: 100, y: 50, width: 90, height: 90 });
  assert.equal(tiles.length, 9);
  assert.deepEqual(tileCentre(tiles[0]), { x: 115, y: 65 });
  assert.deepEqual(tileCentre(tiles[8]), { x: 175, y: 125 });
});

test("solved means a token, or the provider frame is gone", () => {
  assert.equal(challengeCleared([false, true, false], true), true);
  assert.equal(challengeCleared([false, false], false), true);
  assert.equal(challengeCleared([false, false], true), false);
});

test("three attempts are allowed, the fourth is not", () => {
  assert.equal(attemptAllowed(1), true);
  assert.equal(attemptAllowed(3), true);
  assert.equal(attemptAllowed(4), false);
});
