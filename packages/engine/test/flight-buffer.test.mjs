import assert from "node:assert/strict";
import test from "node:test";
import { FLIGHT_MAX_BYTES, FlightRing } from "../dist/flight-buffer.js";

test("frames keep their order and report count and duration", () => {
  const ring = new FlightRing();
  ring.add(7, "chat", 1000, "aaa");
  ring.add(7, "chat", 1500, "bbbb");
  ring.add(7, "chat", 2500, "cc");
  const record = ring.get(7);
  assert.deepEqual(
    record?.frames.map((frame) => frame.data),
    ["aaa", "bbbb", "cc"],
  );
  assert.deepEqual(ring.status(7), {
    frames: 3,
    durationMs: 1500,
    bytes: record?.bytes,
    startedAt: 1000,
  });
});

test("frames older than two minutes are evicted", () => {
  const ring = new FlightRing();
  ring.add(1, "chat", 0, "old");
  ring.add(1, "chat", 60_000, "middle");
  ring.add(1, "chat", 120_001, "new");
  assert.deepEqual(
    ring.get(1)?.frames.map((frame) => frame.data),
    ["middle", "new"],
  );
});

test("the total cap drops the oldest frame across tabs", () => {
  const ring = new FlightRing();
  const chunk = "x".repeat(Math.ceil((FLIGHT_MAX_BYTES / 0.75) * 0.6));
  ring.add(1, "a", 1000, chunk);
  ring.add(2, "b", 2000, chunk);
  assert.ok(ring.totalBytes <= FLIGHT_MAX_BYTES);
  assert.equal(ring.get(1), undefined);
  assert.equal(ring.status(2).frames, 1);
});

test("clearing a tab subtracts its bytes", () => {
  const ring = new FlightRing();
  ring.add(3, "chat", 1000, "abc");
  const bytes = ring.totalBytes;
  ring.clear(3);
  assert.equal(ring.totalBytes, 0);
  assert.deepEqual(ring.status(3), { frames: 0, durationMs: 0, bytes: 0, startedAt: 0 });
  assert.ok(bytes > 0);
});
