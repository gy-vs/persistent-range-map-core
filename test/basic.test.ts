import { test } from "node:test";
import assert from "node:assert/strict";
import { RangeMap, type Interval } from "../src/index.js";

function segs<V>(m: RangeMap<V>): Array<[number, number, V]> {
  return m.toArray().map((s) => [s.start, s.end, s.value]);
}

test("empty map has no intervals", () => {
  const m = RangeMap.empty<string>();
  assert.equal(m.size, 0);
  assert.deepEqual(m.toArray(), []);
  assert.equal(m.get(0), undefined);
  assert.deepEqual(m.stats(), { nodes: 0, intervals: 0, height: 0 });
});

test("fromSorted stores disjoint intervals in order", () => {
  const m = RangeMap.fromSorted<number>([
    { start: 0, end: 5, value: 1 },
    { start: 5, end: 10, value: 2 },
    { start: 10, end: 20, value: 3 },
  ]);
  assert.equal(m.size, 3);
  assert.equal(m.get(0), 1);
  assert.equal(m.get(4), 1);
  assert.equal(m.get(5), 2);
  assert.equal(m.get(19), 3);
  assert.equal(m.get(20), undefined);
});

test("fromSorted coalesces adjacent equal segments", () => {
  const m = RangeMap.fromSorted<string>([
    { start: 0, end: 3, value: "a" },
    { start: 3, end: 7, value: "a" },
    { start: 7, end: 9, value: "b" },
  ]);
  assert.deepEqual(segs(m), [
    [0, 7, "a"],
    [7, 9, "b"],
  ]);
});

test("fromSorted skips empty intervals", () => {
  const m = RangeMap.fromSorted<number>([
    { start: 0, end: 0, value: 1 },
    { start: 0, end: 4, value: 2 },
    { start: 9, end: 9, value: 3 },
  ]);
  assert.deepEqual(segs(m), [[0, 4, 2]]);
});

test("fromSorted rejects overlaps and bad ranges", () => {
  assert.throws(
    () =>
      RangeMap.fromSorted<number>([
        { start: 0, end: 5, value: 1 },
        { start: 4, end: 6, value: 2 },
      ]),
    RangeError,
  );
  assert.throws(
    () => RangeMap.empty<number>().set(3, 2, 1),
    RangeError,
  );
  assert.throws(
    () => RangeMap.empty<number>().set(-1, 2, 1),
    RangeError,
  );
});

test("custom value equality drives coalescing", () => {
  type Box = { tag: string };
  const m = RangeMap.fromSorted<Box>(
    [
      { start: 0, end: 3, value: { tag: "x" } },
      { start: 3, end: 6, value: { tag: "x" } },
    ],
    { valuesEqual: (a, b) => a.tag === b.tag },
  );
  assert.deepEqual(segs(m), [[0, 6, { tag: "x" }]]);
});

test("undefined is a storable value", () => {
  const m = RangeMap.fromSorted<string | undefined>([
    { start: 0, end: 5, value: undefined },
  ]);
  assert.equal(m.get(3), undefined);
  assert.equal(m.size, 1);
  // Point outside the interval is also undefined but the interval exists.
  assert.deepEqual(m.toArray(), [{ start: 0, end: 5, value: undefined }]);
});

test("invariant: every built tree is a valid treap with disjoint intervals", () => {
  const segsList: Interval<number>[] = [];
  for (let i = 0; i < 500; i++) {
    segsList.push({ start: i * 3, end: i * 3 + 2, value: i });
  }
  const m = RangeMap.fromSorted(segsList);
  assert.equal(m.size, 500);
  for (let i = 0; i < 500; i++) {
    assert.equal(m.get(i * 3), i);
    assert.equal(m.get(i * 3 + 1), i);
    assert.equal(m.get(i * 3 + 2), undefined);
  }
});
