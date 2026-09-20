import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RangeMap,
  type Affinity,
  type TextEdit,
} from "../src/index.js";

type Seg<V> = { start: number; end: number; value: V };

/** Naive persistent reference: a sorted coalesced array, copied on every edit. */
function refSet<V>(
  segs: Array<Seg<V>>,
  s: number,
  e: number,
  v: V,
  eq: (a: V, b: V) => boolean,
): Array<Seg<V>> {
  const out: Array<Seg<V>> = [];
  for (const g of segs) {
    if (g.start < s) out.push({ start: g.start, end: Math.min(g.end, s), value: g.value });
    if (g.end > e) out.push({ start: Math.max(g.start, e), end: g.end, value: g.value });
  }
  out.push({ start: s, end: e, value: v });
  return coalesce(out.sort((a, b) => a.start - b.start), eq);
}

function refDelete<V>(
  segs: Array<Seg<V>>,
  s: number,
  e: number,
  eq: (a: V, b: V) => boolean,
): Array<Seg<V>> {
  const out: Array<Seg<V>> = [];
  for (const g of segs) {
    if (g.start < s) out.push({ start: g.start, end: Math.min(g.end, s), value: g.value });
    if (g.end > e) out.push({ start: Math.max(g.start, e), end: g.end, value: g.value });
  }
  // No coalescing: deletion leaves a gap by construction (left pieces end <= s,
  // right pieces start >= e).
  return coalesce(out.sort((a, b) => a.start - b.start), eq, s, e);
}

function coalesce<V>(
  segs: Array<Seg<V>>,
  eq: (a: V, b: V) => boolean,
  gapStart?: number,
  gapEnd?: number,
): Array<Seg<V>> {
  const out: Array<Seg<V>> = [];
  for (const g of segs) {
    if (g.start >= g.end) continue;
    const prev = out[out.length - 1];
    if (
      prev !== undefined &&
      prev.end === g.start &&
      eq(prev.value, g.value) &&
      !(gapStart !== undefined && prev.end === gapStart && g.start === gapStart)
    ) {
      prev.end = g.end;
    } else {
      out.push({ ...g });
    }
  }
  return out;
}

function normalize(edits: Array<TextEdit & { delta?: number; base?: number }>) {
  const es = edits
    .filter((e) => !(e.start === e.end && e.newLength === 0))
    .map((e) => ({ ...e, delta: e.newLength - (e.end - e.start), base: 0 }))
    .sort((a, b) => a.start - b.start);
  let base = 0;
  for (const e of es) {
    e.base = base;
    base += e.delta;
  }
  return es;
}

function mapPointRef(
  p: number,
  edits: ReturnType<typeof normalize>,
  aff: Affinity,
): number {
  for (const e of edits) {
    const ms = e.start + e.base;
    const me = ms + e.newLength;
    if (p < e.start) return p + e.base;
    if (p <= e.end) {
      if (p === e.end && p > e.start) return me;
      return aff === "right" ? me : ms;
    }
  }
  const last = edits[edits.length - 1];
  return last === undefined ? p : p + (last.base + last.delta);
}

function refTransform<V>(
  segs: Array<Seg<V>>,
  rawEdits: Array<TextEdit>,
  startAff: Affinity,
  endAff: Affinity,
  eq: (a: V, b: V) => boolean,
): Array<Seg<V>> {
  const edits = normalize(rawEdits.map((e) => ({ ...e })));
  if (edits.length === 0) return segs;
  const out: Array<Seg<V>> = [];
  for (const g of segs) {
    // An interval strictly contained in one edited region is removed as a
    // whole (its content is replaced); everything else maps edge-by-edge.
    const strictInside = edits.some(
      (e) => e.start < g.start && g.end < e.end,
    );
    if (strictInside) continue;
    const ns = mapPointRef(g.start, edits, startAff);
    const ne = mapPointRef(g.end, edits, endAff);
    if (ns < ne) out.push({ start: ns, end: ne, value: g.value });
  }
  const sorted = out.sort((a, b) =>
    a.start !== b.start ? a.start - b.start : a.end - b.end,
  );
  // Mirror the kernel's ordered forest join: a later piece starts no earlier
  // than an earlier one; clip the overlapping prefix.
  const filtered: Array<Seg<V>> = [];
  for (const g0 of sorted) {
    const g = { ...g0 };
    const last = filtered[filtered.length - 1];
    if (last !== undefined && g.start < last.end) g.start = last.end;
    if (g.start < g.end) filtered.push(g);
  }
  return coalesce(filtered, eq);
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("fuzz: set/delete chains match naive reference", () => {
  const rand = mulberry32(42);
  const eq = (a: number, b: number) => a === b;
  let ref: Array<Seg<number>> = [];
  let m = RangeMap.empty<number>();

  for (let iter = 0; iter < 400; iter++) {
    const a = Math.floor(rand() * 60);
    const b = a + Math.floor(rand() * 20);
    if (rand() < 0.7) {
      const v = Math.floor(rand() * 5);
      ref = refSet(ref, a, b, v, eq);
      m = m.set(a, b, v);
    } else {
      ref = refDelete(ref, a, b, eq);
      m = m.delete(a, b);
    }
    if (iter % 20 === 0) {
      assert.deepEqual(m.toArray(), ref, `mismatch at iter ${iter}`);
    }
  }
  assert.deepEqual(m.toArray(), ref);
});

test("fuzz: transform matches naive mapping under varied affinity", () => {
  const rand = mulberry32(7);
  const eq = (a: number, b: number) => a === b;
  let ref: Array<Seg<number>> = [];
  let m = RangeMap.empty<number>();

  // Lay down a random document map in a 200-wide space.
  for (let i = 0; i < 40; i++) {
    const a = Math.floor(rand() * 180);
    const len = 1 + Math.floor(rand() * 10);
    const v = Math.floor(rand() * 4);
    ref = refSet(ref, a, a + len, v, eq);
    m = m.set(a, a + len, v);
  }
  assert.deepEqual(m.toArray(), ref);

  for (let round = 0; round < 60; round++) {
    // Non-overlapping edits chosen greedily.
    const count = 1 + Math.floor(rand() * 4);
    const edits: TextEdit[] = [];
    let cursor = 0;
    for (let i = 0; i < count; i++) {
      cursor += Math.floor(rand() * 10);
      const start = cursor;
      const end = start + Math.floor(rand() * 8);
      const newLength = Math.floor(rand() * 10);
      edits.push({ start, end, newLength });
      cursor = end + 1 + Math.floor(rand() * 5);
      if (cursor > 190) break;
    }

    // Reference applies transforms in a *copy* coordinate space that we
    // rebuild from scratch each round, so track document content is irrelevant;
    // instead, only one transform round is compared before re-randomizing
    // coordinates. We re-generate the map in the same original space each time
    // by comparing a fresh transform of the current ref (ref and m agree),
    // then advance both into the new space and continue editing from there.
    const startAff: Affinity = rand() < 0.5 ? "left" : "right";
    const endAff: Affinity = rand() < 0.5 ? "left" : "right";
    const beforeRef = ref;
    const beforeM = m;

    ref = refTransform(beforeRef, edits, startAff, endAff, eq);
    m = beforeM.transform(edits, { affinity: { start: startAff, end: endAff } });

    assert.deepEqual(m.toArray(), ref, `mismatch round ${round}`);
  }
});

test("fuzz: boundary-dense edits with fully independent affinities", () => {
  const rand = mulberry32(2024);
  const eq = (a: number, b: number) => a === b;
  let ref: Array<Seg<number>> = [];
  let m = RangeMap.empty<number>();

  // Tile the space with unit intervals so every boundary has neighbors.
  for (let i = 0; i < 60; i++) {
    ref = refSet(ref, i, i + 1, i % 3, eq);
    m = m.set(i, i + 1, i % 3);
  }

  for (let round = 0; round < 200; round++) {
    const count = 1 + Math.floor(rand() * 5);
    const edits: TextEdit[] = [];
    let cursor = Math.floor(rand() * 3);
    for (let i = 0; i < count; i++) {
      const start = cursor;
      const mode = rand();
      const end = mode < 0.4 ? start : start + 1 + Math.floor(rand() * 3);
      const newLength =
        mode < 0.4 ? 1 + Math.floor(rand() * 4) : Math.floor(rand() * 5);
      edits.push({ start, end, newLength });
      cursor = end + (mode < 0.3 ? 0 : 1); // often adjacent edits
      if (cursor > 90) break;
    }
    const startAff: Affinity = rand() < 0.5 ? "left" : "right";
    const endAff: Affinity = rand() < 0.5 ? "left" : "right";
    ref = refTransform(ref, edits, startAff, endAff, eq);
    m = m.transform(edits, { affinity: { start: startAff, end: endAff } });
    assert.deepEqual(m.toArray(), ref, `round ${round}`);
  }
});

test("fuzz: set/delete/transform mixed operations", () => {
  const rand = mulberry32(99);
  const eq = (a: number, b: number) => a === b;
  let ref: Array<Seg<number>> = [];
  let m = RangeMap.empty<number>();

  for (let iter = 0; iter < 300; iter++) {
    const op = rand();
    if (op < 0.4) {
      const a = Math.floor(rand() * 100);
      const b = a + Math.floor(rand() * 15);
      const v = Math.floor(rand() * 4);
      ref = refSet(ref, a, b, v, eq);
      m = m.set(a, b, v);
    } else if (op < 0.7) {
      const a = Math.floor(rand() * 100);
      const b = a + Math.floor(rand() * 15);
      ref = refDelete(ref, a, b, eq);
      m = m.delete(a, b);
    } else {
      const a = Math.floor(rand() * 100);
      const edits: TextEdit[] = [
        { start: a, end: a + Math.floor(rand() * 6), newLength: Math.floor(rand() * 8) },
      ];
      if (a + 20 < 100) {
        edits.push({
          start: a + 15,
          end: a + 15 + Math.floor(rand() * 5),
          newLength: Math.floor(rand() * 8),
        });
      }
      ref = refTransform(ref, edits, "right", "left", eq);
      m = m.transform(edits);
    }
    if (iter % 25 === 0) {
      assert.deepEqual(m.toArray(), ref, `mismatch at iter ${iter}`);
    }
  }
  assert.deepEqual(m.toArray(), ref);
});
