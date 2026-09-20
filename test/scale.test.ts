import { test } from "node:test";
import assert from "node:assert/strict";
import { RangeMap } from "../src/index.js";

const N = 100_000;

test("100k intervals: linear build, queries, overwrite, delete, transform", () => {
  const data = Array.from({ length: N }, (_, i) => ({
    start: i * 2,
    end: i * 2 + 1,
    value: i % 7,
  }));

  const t0 = performance.now();
  const m = RangeMap.fromSorted<number>(data);
  const t1 = performance.now();
  assert.equal(m.size, N);
  assert.ok(t1 - t0 < 2000, `build took ${t1 - t0}ms`);

  // Treap stays balanced.
  const s = m.stats();
  assert.ok(s.height < 80, `height ${s.height} too large for 100k nodes`);

  // Point probes.
  assert.equal(m.get(0), 0);
  assert.equal(m.get(2 * (N - 1)), (N - 1) % 7);
  assert.equal(m.get(1), undefined);

  // toArray round trip.
  const arr = m.toArray();
  assert.equal(arr.length, N);
  assert.equal(arr[0]!.start, 0);
  assert.equal(arr[N - 1]!.end, 2 * N - 1);

  // Small overwrite touches O(log n) nodes and keeps sharing.
  const m2 = m.set(100_000, 100_005, 99);
  assert.equal(m2.get(100_000), 99);
  assert.equal(m2.get(99_999), undefined);
  const shared2 = m.sharedNodes(m2);
  assert.ok(shared2 > N - 100, `only ~path nodes should be cloned, got ${shared2}`);

  // Small delete.
  const m3 = m.delete(50_000, 50_001);
  assert.equal(m3.size, N - 1);
  assert.equal(m3.get(50_000), undefined);
  const shared3 = m.sharedNodes(m3);
  assert.ok(shared3 > N - 100, `delete shared ${shared3}`);

  // One insertion edit: the whole prefix subtree is shared lazily.
  const m4 = m.transform([{ start: 60_000, end: 60_000, newLength: 3 }]);
  assert.equal(m4.size, N);
  const shared4 = m.sharedNodes(m4);
  assert.ok(shared4 > 25_000, `prefix subtree sharing expected, got ${shared4}`);

  // Delete a big middle range; survivors keep sharing.
  const m5 = m.delete(20_000, 160_000);
  assert.equal(m5.size, 30_000);
  const shared5 = m.sharedNodes(m5);
  assert.ok(shared5 > 29_000, `survivors should mostly be shared, got ${shared5}`);

  // shift clones only the root (lazy offset) and shares everything else.
  const m6 = m.shift(1);
  assert.equal(m.sharedNodes(m6), N - 1);
});

test("100k overwrites build a deep history without copying the map each time", () => {
  let m = RangeMap.empty<number>();
  // Write 100k adjacent intervals one at a time: each must be ~O(log n).
  for (let i = 0; i < 5000; i++) {
    m = m.set(i * 2, i * 2 + 1, i);
  }
  assert.equal(m.size, 5000);
  assert.ok(m.stats().height < 60);
});
