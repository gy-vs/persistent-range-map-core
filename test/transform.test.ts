import { test } from "node:test";
import assert from "node:assert/strict";
import { RangeMap } from "../src/index.js";

function segs<V>(m: RangeMap<V>): Array<[number, number, V]> {
  return m.toArray().map((s) => [s.start, s.end, s.value]);
}

// Default affinity: start=right, end=left (content sticks to new text).

test("pure insertion shifts intervals after the cursor", () => {
  const m = RangeMap.fromSorted<string>([
    { start: 0, end: 3, value: "a" },
    { start: 5, end: 8, value: "b" },
  ]);
  // Insert 4 chars at offset 4: "...."
  const m2 = m.transform([{ start: 4, end: 4, newLength: 4 }]);
  assert.deepEqual(segs(m2), [
    [0, 3, "a"],
    [9, 12, "b"],
  ]);
});

test("interval touching an insertion point sticks by default (start right, end left)", () => {
  // "abc|" where a segment ends at the cursor: end-left stays before insert.
  const endAtCursor = RangeMap.fromSorted<string>([
    { start: 0, end: 4, value: "a" },
  ]);
  assert.deepEqual(
    segs(endAtCursor.transform([{ start: 4, end: 4, newLength: 2 }])),
    [[0, 4, "a"]],
  );

  // Segment starts at the cursor: start-right moves with the insertion.
  const startAtCursor = RangeMap.fromSorted<string>([
    { start: 4, end: 8, value: "b" },
  ]);
  assert.deepEqual(
    segs(startAtCursor.transform([{ start: 4, end: 4, newLength: 2 }])),
    [[6, 10, "b"]],
  );
});

test("explicit affinity overrides boundary folding", () => {
  const endAtCursor = RangeMap.fromSorted<string>([
    { start: 0, end: 4, value: "a" },
  ]);
  assert.deepEqual(
    segs(
      endAtCursor.transform(
        [{ start: 4, end: 4, newLength: 2 }],
        { affinity: { end: "right" } },
      ),
    ),
    [[0, 6, "a"]],
  );

  // With start=left the opening edge stays at 4; the closing edge (8, far)
  // shifts normally: [4, 10).
  const startAtCursor = RangeMap.fromSorted<string>([
    { start: 4, end: 8, value: "b" },
  ]);
  assert.deepEqual(
    segs(
      startAtCursor.transform(
        [{ start: 4, end: 4, newLength: 2 }],
        { affinity: { start: "left" } },
      ),
    ),
    [[4, 10, "b"]],
  );
});

test("pure deletion: edges fold, covering interval maps to remaining parts", () => {
  // delete [4,7), length 3, in [0,10)
  const m = RangeMap.fromSorted<string>([
    { start: 0, end: 10, value: "a" },
  ]);
  const m2 = m.transform([{ start: 4, end: 7, newLength: 0 }]);
  // start edge far left: 0; end edge far right: 10-3=7
  assert.deepEqual(segs(m2), [[0, 7, "a"]]);

  // Segment strictly inside the deleted region collapses to nothing.
  const inner = RangeMap.fromSorted<string>([
    { start: 5, end: 6, value: "x" },
  ]);
  assert.deepEqual(
    segs(inner.transform([{ start: 4, end: 7, newLength: 0 }])),
    [],
  );

  // Half-overlapping interval on the left with default end=left affinity:
  // the end edge (6, inside) folds to the mapped start 4; the start edge (2,
  // before) shifts to 2. The surviving remnant is [2,4).
  const left = RangeMap.fromSorted<string>([
    { start: 2, end: 6, value: "y" },
  ]);
  assert.deepEqual(
    segs(left.transform([{ start: 4, end: 7, newLength: 0 }])),
    [[2, 4, "y"]],
  );

  // End=right gives the same remnant here: the end edge folds to the mapped
  // region end, which equals its start under a pure deletion.
  assert.deepEqual(
    segs(
      left.transform(
        [{ start: 4, end: 7, newLength: 0 }],
        { affinity: "right" },
      ),
    ),
    [[2, 4, "y"]],
  );

  // Half-overlapping on the right: [5,9). start inside folds (start=right) to
  // 4; end 9 far shifts to 6 -> [4,6).
  const right = RangeMap.fromSorted<string>([
    { start: 5, end: 9, value: "z" },
  ]);
  assert.deepEqual(
    segs(right.transform([{ start: 4, end: 7, newLength: 0 }])),
    [[4, 6, "z"]],
  );
  // start=left anchors the remnant at the mapped start; the far end still
  // moves to 6, giving [4,6) as well (a zero-width fold cannot drop a
  // still-living far edge).
  assert.deepEqual(
    segs(
      right.transform(
        [{ start: 4, end: 7, newLength: 0 }],
        { affinity: "left" },
      ),
    ),
    [[4, 6, "z"]],
  );

  // Only an interval entirely at the fold collapses: [5,6) is strictly
  // interior under deletion and disappears regardless of affinity.
  const buried = RangeMap.fromSorted<string>([
    { start: 5, end: 6, value: "w" },
  ]);
  assert.deepEqual(
    segs(buried.transform(
      [{ start: 4, end: 7, newLength: 0 }],
      { affinity: "left" },
    )),
    [],
  );
});

test("replacement: interval spanning the region keeps value over new text", () => {
  const m = RangeMap.fromSorted<string>([
    { start: 0, end: 10, value: "a" },
    { start: 10, end: 20, value: "b" },
  ]);
  // replace [4,7) (3 chars) with 6 chars; delta +3.
  // a [0,10) crosses: its end is strictly past the region, so it shifts to
  // 13; the value still covers the inserted text because the same interval
  // spans it. b [10,20) is entirely past the region: 13..23.
  const m2 = m.transform([{ start: 4, end: 7, newLength: 6 }]);
  assert.deepEqual(segs(m2), [
    [0, 13, "a"],
    [13, 23, "b"],
  ]);

  // Interval opening exactly on the boundary: start=right lets it cover the
  // new text; start=left anchors it before, so its value skips the insert.
  const onEdge = RangeMap.fromSorted<string>([
    { start: 4, end: 20, value: "c" },
  ]);
  assert.deepEqual(
    segs(onEdge.transform([{ start: 4, end: 7, newLength: 6 }])),
    [[10, 23, "c"]],
  );
  assert.deepEqual(
    segs(
      onEdge.transform(
        [{ start: 4, end: 7, newLength: 6 }],
        { affinity: { start: "left" } },
      ),
    ),
    [[4, 23, "c"]],
  );

  // A segment strictly interior to the region disappears.
  const inner = RangeMap.fromSorted<string>([
    { start: 5, end: 6, value: "z" },
  ]);
  assert.deepEqual(
    segs(inner.transform([{ start: 4, end: 7, newLength: 6 }])),
    [],
  );
});

test("boundary-fold strategies on a deletion edge", () => {
  // [4,8) value; delete [2,4): end-right affinity keeps the interval alive
  // starting at 2; end-left collapses start onto start=4... interval [4,8)
  // start edge is far right so start=4-2=2 regardless; check explicit forms.
  const m = RangeMap.fromSorted<string>([{ start: 4, end: 8, value: "a" }]);
  const leftStart = m.transform(
    [{ start: 2, end: 4, newLength: 0 }],
    { affinity: "left" },
  );
  // start edge (4) strictly after region -> 4-2 = 2
  assert.deepEqual(segs(leftStart), [[2, 6, "a"]]);
});

test("multiple edits in original coordinates are applied consistently", () => {
  const m = RangeMap.fromSorted<number>([
    { start: 0, end: 10, value: 0 },
    { start: 10, end: 20, value: 1 },
    { start: 20, end: 30, value: 2 },
    { start: 30, end: 40, value: 3 },
  ]);
  // Edit A: delete [5,10)  (-5)
  // Edit B: insert 10 chars at 20 (+10)
  // Edit C: replace [30,35) with 2 chars (-3)
  const m2 = m.transform([
    { start: 5, end: 10, newLength: 0 },
    { start: 20, end: 20, newLength: 10 },
    { start: 30, end: 35, newLength: 2 },
  ]);
  // A delta -5, B delta +10, C delta -3.
  // [0,10) spans A:        start 0,        end 10 -> 5
  // [10,20):               10 -> 5,        end 20 -> 15
  // [20,30): start on B (right affinity) -> 30; end 30 == C.start boundary
  //          (end-edge left affinity) -> 35
  // [30,40) spans C:       start 35 (right) -> 37; end 40+2 = 42
  assert.deepEqual(segs(m2), [
    [0, 5, 0],
    [5, 15, 1],
    [25, 35, 2],
    [37, 42, 3],
  ]);
});

test("no-op edit list returns the same version", () => {
  const m = RangeMap.fromSorted<number>([{ start: 0, end: 5, value: 1 }]);
  assert.equal(m.transform([]), m);
  assert.equal(
    m.transform([{ start: 3, end: 3, newLength: 0 }]),
    m,
  );
});

test("overlapping edits are rejected", () => {
  const m = RangeMap.empty<number>();
  assert.throws(
    () =>
      m.transform([
        { start: 0, end: 5, newLength: 1 },
        { start: 4, end: 6, newLength: 1 },
      ]),
    RangeError,
  );
});

test("adjacent edits (touching but not overlapping) are allowed", () => {
  const m = RangeMap.fromSorted<number>([{ start: 0, end: 10, value: 1 }]);
  const m2 = m.transform([
    { start: 2, end: 4, newLength: 1 },
    { start: 4, end: 6, newLength: 3 },
  ]);
  // A delta -1, B delta +1. interval spans both:
  // start 0 -> 0
  // end 10: after both cumulative 0 -> 10
  assert.deepEqual(segs(m2), [[0, 10, 1]]);
});

test("transform preserves gaps: deleted region is not invented", () => {
  const m = RangeMap.fromSorted<number>([
    { start: 0, end: 2, value: 1 },
    { start: 8, end: 10, value: 2 },
  ]);
  const m2 = m.transform([{ start: 3, end: 7, newLength: 0 }]);
  assert.deepEqual(segs(m2), [
    [0, 2, 1],
    [4, 6, 2],
  ]);
});

test("mixed affinity folds two boundary pieces onto overlapping ranges", () => {
  // [0,10) a, [10,20) b; insert 5 chars at 10.
  const m = RangeMap.fromSorted<string>([
    { start: 0, end: 10, value: "a" },
    { start: 10, end: 20, value: "b" },
  ]);
  // end=right: a's end moves to 15; start=left: b's start stays at 10.
  // The overlap [10,15) is resolved in ordered-join order: a keeps the
  // prefix, b keeps the tail [15,25).
  assert.deepEqual(
    segs(
      m.transform(
        [{ start: 10, end: 10, newLength: 5 }],
        { affinity: { start: "left", end: "right" } },
      ),
    ),
    [
      [0, 15, "a"],
      [15, 25, "b"],
    ],
  );
});

test("text simulation: typing and deleting through a marked range", () => {
  // Range [0,5) marked "comment" in a 10-char document.
  let m = RangeMap.empty<string>().set(0, 5, "comment");
  // Type 3 chars at position 2 (insertion).
  m = m.transform([{ start: 2, end: 2, newLength: 3 }]);
  assert.deepEqual(segs(m), [[0, 8, "comment"]]);
  // Delete 4 chars inside the comment [3,7).
  m = m.transform([{ start: 3, end: 7, newLength: 0 }]);
  assert.deepEqual(segs(m), [[0, 4, "comment"]]);
  // Delete the rest.
  m = m.transform([{ start: 0, end: 4, newLength: 0 }]);
  assert.deepEqual(segs(m), []);
});
