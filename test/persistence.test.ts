import { test } from "node:test";
import assert from "node:assert/strict";
import { RangeMap } from "../src/index.js";

function segs<V>(m: RangeMap<V>): Array<[number, number, V]> {
  return m.toArray().map((s) => [s.start, s.end, s.value]);
}

test("old versions remain readable after new versions are created", () => {
  const v0 = RangeMap.empty<string>()
    .set(0, 100, "a");
  const v1 = v0.set(20, 80, "b");
  const v2 = v1.delete(40, 60);
  const v3 = v2.set(0, 100, "c");

  assert.deepEqual(segs(v0), [[0, 100, "a"]]);
  assert.deepEqual(segs(v1), [
    [0, 20, "a"],
    [20, 80, "b"],
    [80, 100, "a"],
  ]);
  assert.deepEqual(segs(v2), [
    [0, 20, "a"],
    [20, 40, "b"],
    [60, 80, "b"],
    [80, 100, "a"],
  ]);
  assert.deepEqual(segs(v3), [[0, 100, "c"]]);

  // Point queries on each version.
  assert.equal(v0.get(50), "a");
  assert.equal(v1.get(50), "b");
  assert.equal(v2.get(50), undefined);
  assert.equal(v3.get(50), "c");
});

test("branching histories are independent", () => {
  const base = RangeMap.empty<number>().set(0, 10, 1);
  const branchA = base.set(0, 5, 10);
  const branchB = base.set(5, 10, 20);
  const branchA2 = branchA.delete(0, 5);
  const branchB2 = branchB.shift(100);

  assert.deepEqual(segs(base), [[0, 10, 1]]);
  assert.deepEqual(segs(branchA), [
    [0, 5, 10],
    [5, 10, 1],
  ]);
  assert.deepEqual(segs(branchB), [
    [0, 5, 1],
    [5, 10, 20],
  ]);
  assert.deepEqual(segs(branchA2), [[5, 10, 1]]);
  assert.deepEqual(segs(branchB2), [
    [100, 105, 1],
    [105, 110, 20],
  ]);
});

test("versions structurally share untouched nodes", () => {
  const v0 = RangeMap.fromSorted<number>(
    Array.from({ length: 1000 }, (_, i) => ({
      start: i * 10,
      end: i * 10 + 9,
      value: i,
    })),
  );
  // Small overwrite far away from most intervals.
  const v1 = v0.set(5000, 5004, -1);
  const shared = v0.sharedNodes(v1);
  assert.ok(shared > 900, `expected >900 shared nodes, got ${shared}`);
  assert.ok(shared < 1000, "changed nodes must not be shared");

  // Deleting one interval shares nearly all nodes too.
  const v2 = v0.delete(200, 209);
  const shared2 = v0.sharedNodes(v2);
  assert.ok(shared2 > 985, `expected >985 shared, got ${shared2}`);

  // Transform shifting a suffix shares the untouched prefix subtree.
  const v3 = v0.transform([{ start: 5000, end: 5000, newLength: 7 }]);
  const shared3 = v0.sharedNodes(v3);
  assert.ok(shared3 >= 480, `expected prefix sharing >=480, got ${shared3}`);

  // shift() clones only the root for the lazy offset; all others are shared.
  const v4 = v0.shift(3);
  assert.equal(v0.sharedNodes(v4), 999);
});

test("sharedNodes is identity-based, not equality-based", () => {
  const a = RangeMap.fromSorted<number>(
    Array.from({ length: 100 }, (_, i) => ({
      start: i * 2,
      end: i * 2 + 1,
      value: i,
    })),
  );
  // Build an equal-looking but independently constructed map.
  const b = RangeMap.fromSorted<number>(
    Array.from({ length: 100 }, (_, i) => ({
      start: i * 2,
      end: i * 2 + 1,
      value: i,
    })),
  );
  assert.deepEqual(a.toArray(), b.toArray());
  assert.equal(a.sharedNodes(b), 0, "equal content, disjoint objects");
});

test("stats expose node counts and treap height", () => {
  const m = RangeMap.fromSorted<number>(
    Array.from({ length: 1000 }, (_, i) => ({
      start: i,
      end: i + 1,
      value: i,
    })),
  );
  const s = m.stats();
  assert.equal(s.nodes, 1000);
  assert.equal(s.intervals, 1000);
  // Expected treap height ~ c * log2(n); be generous.
  assert.ok(s.height > 0 && s.height < 100, `height was ${s.height}`);
});

test("long history does not mutate previous roots", () => {
  let m = RangeMap.empty<number>();
  const snapshots: RangeMap<number>[] = [];
  for (let i = 0; i < 50; i++) {
    m = m.set(i * 3, i * 3 + 2, i);
    snapshots.push(m);
  }
  snapshots.forEach((snap, i) => {
    assert.equal(snap.size, i + 1);
    assert.equal(snap.get(0), 0);
    assert.equal(snap.get(i * 3), i);
  });
});
