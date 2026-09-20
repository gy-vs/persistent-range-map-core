import { test } from "node:test";
import assert from "node:assert/strict";
import { RangeMap } from "../src/index.js";

function segs<V>(m: RangeMap<V>): Array<[number, number, V]> {
  return m.toArray().map((s) => [s.start, s.end, s.value]);
}

test("single overwrite creates one interval", () => {
  const m = RangeMap.empty<string>().set(2, 8, "a");
  assert.deepEqual(segs(m), [[2, 8, "a"]]);
});

test("empty overwrite is a no-op and returns same version", () => {
  const m0 = RangeMap.fromSorted<number>([{ start: 0, end: 5, value: 1 }]);
  const m1 = m0.set(3, 3, 9);
  assert.equal(m1, m0);
});

test("overwrite splits an interval on both sides", () => {
  const m0 = RangeMap.fromSorted<string>([{ start: 0, end: 10, value: "a" }]);
  const m1 = m0.set(3, 7, "b");
  assert.deepEqual(segs(m1), [
    [0, 3, "a"],
    [3, 7, "b"],
    [7, 10, "a"],
  ]);
});

test("overwrite aligned to boundaries", () => {
  const m0 = RangeMap.fromSorted<string>([
    { start: 0, end: 5, value: "a" },
    { start: 5, end: 10, value: "b" },
  ]);
  const m1 = m0.set(0, 5, "c");
  assert.deepEqual(segs(m1), [
    [0, 5, "c"],
    [5, 10, "b"],
  ]);
  const m2 = m1.set(5, 10, "c");
  assert.deepEqual(segs(m2), [[0, 10, "c"]]);
});

test("nested overwrites: different value creates layers, same value merges", () => {
  let m = RangeMap.empty<string>();
  m = m.set(0, 100, "a");
  m = m.set(10, 90, "b");
  m = m.set(20, 80, "c");
  m = m.set(30, 70, "d");
  assert.deepEqual(segs(m), [
    [0, 10, "a"],
    [10, 20, "b"],
    [20, 30, "c"],
    [30, 70, "d"],
    [70, 80, "c"],
    [80, 90, "b"],
    [90, 100, "a"],
  ]);
  // Rewriting the center with "c" merges with its c-neighbors.
  m = m.set(30, 70, "c");
  assert.deepEqual(segs(m), [
    [0, 10, "a"],
    [10, 20, "b"],
    [20, 80, "c"],
    [80, 90, "b"],
    [90, 100, "a"],
  ]);
  // Rewriting with "a" merges both outer a pieces into one.
  m = m.set(10, 90, "a");
  assert.deepEqual(segs(m), [[0, 100, "a"]]);
});

test("overwrite spanning multiple intervals replaces them all", () => {
  const m0 = RangeMap.fromSorted<string>([
    { start: 0, end: 2, value: "a" },
    { start: 2, end: 4, value: "b" },
    { start: 4, end: 6, value: "c" },
    { start: 6, end: 8, value: "d" },
  ]);
  const m1 = m0.set(1, 7, "x");
  assert.deepEqual(segs(m1), [
    [0, 1, "a"],
    [1, 7, "x"],
    [7, 8, "d"],
  ]);
});

test("overwrite merges only when touching, not across a gap", () => {
  const m0 = RangeMap.fromSorted<string>([
    { start: 0, end: 3, value: "a" },
    { start: 5, end: 8, value: "a" },
  ]);
  const m1 = m0.set(3, 5, "a");
  assert.deepEqual(segs(m1), [[0, 8, "a"]]);

  const m2 = RangeMap.fromSorted<string>([
    { start: 0, end: 3, value: "a" },
    { start: 5, end: 8, value: "a" },
  ]);
  const m3 = m2.set(3, 5, "b");
  assert.deepEqual(segs(m3), [
    [0, 3, "a"],
    [3, 5, "b"],
    [5, 8, "a"],
  ]);
});

test("overwrite extending past the last interval", () => {
  const m0 = RangeMap.fromSorted<string>([{ start: 0, end: 5, value: "a" }]);
  const m1 = m0.set(3, 10, "b");
  assert.deepEqual(segs(m1), [
    [0, 3, "a"],
    [3, 10, "b"],
  ]);
});

test("overwrite before the first interval", () => {
  const m0 = RangeMap.fromSorted<string>([{ start: 5, end: 10, value: "a" }]);
  const m1 = m0.set(0, 5, "a");
  assert.deepEqual(segs(m1), [[0, 10, "a"]]);
});

test("delete creates a gap and keeps coordinates", () => {
  const m0 = RangeMap.fromSorted<string>([
    { start: 0, end: 5, value: "a" },
    { start: 5, end: 10, value: "b" },
  ]);
  const m1 = m0.delete(3, 7);
  assert.deepEqual(segs(m1), [
    [0, 3, "a"],
    [7, 10, "b"],
  ]);
  assert.equal(m1.get(5), undefined);
  // Equal values do not merge across the gap.
  const m2 = RangeMap.fromSorted<string>([
    { start: 0, end: 5, value: "a" },
    { start: 5, end: 10, value: "a" },
  ]).delete(3, 7);
  assert.deepEqual(segs(m2), [
    [0, 3, "a"],
    [7, 10, "a"],
  ]);
});

test("delete empty range is a no-op returning same version", () => {
  const m0 = RangeMap.fromSorted<number>([{ start: 0, end: 5, value: 1 }]);
  assert.equal(m0.delete(2, 2), m0);
});

test("delete removes full intervals when contained", () => {
  const m0 = RangeMap.fromSorted<number>([
    { start: 0, end: 2, value: 1 },
    { start: 2, end: 4, value: 2 },
    { start: 4, end: 6, value: 3 },
  ]);
  assert.deepEqual(segs(m0.delete(2, 4)), [
    [0, 2, 1],
    [4, 6, 3],
  ]);
  assert.equal(m0.delete(0, 6).size, 0);
});

test("delete fully inside a single interval splits it", () => {
  const m0 = RangeMap.fromSorted<number>([{ start: 0, end: 10, value: 7 }]);
  assert.deepEqual(segs(m0.delete(4, 6)), [
    [0, 4, 7],
    [6, 10, 7],
  ]);
});

test("shift translates all coordinates in O(1)-ish fashion", () => {
  const m0 = RangeMap.fromSorted<string>([
    { start: 0, end: 5, value: "a" },
    { start: 8, end: 12, value: "b" },
  ]);
  const m1 = m0.shift(100);
  assert.deepEqual(segs(m1), [
    [100, 105, "a"],
    [108, 112, "b"],
  ]);
  assert.equal(m1.sharedNodes(m0), m0.size - 1, "shift shares all but the lazy-cloned root");
  assert.equal(m0.shift(0), m0);
});

test("querying via get after many operations stays consistent", () => {
  let m = RangeMap.empty<string>().set(0, 1000, "a");
  m = m.set(100, 200, "b");
  m = m.delete(500, 600);
  m = m.set(150, 160, "c");
  const arr = m.toArray();
  for (const [s, e, v] of [
    [0, 100, "a"],
    [100, 150, "b"],
    [150, 160, "c"],
    [160, 200, "b"],
    [200, 500, "a"],
    [600, 1000, "a"],
  ] as Array<[number, number, string]>) {
    assert.ok(arr.find((x) => x.start === s && x.end === e && x.value === v));
  }
});
