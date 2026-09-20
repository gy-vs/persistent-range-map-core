/**
 * Persistent Range Map.
 *
 * Maps disjoint half-open integer intervals [start, end) to values. Every
 * mutating operation returns a new version; old versions stay readable because
 * the underlying treap is fully persistent and large unchanged subtrees are
 * shared (see {@link RangeMap.stats} / {@link RangeMap.sharedNodes}).
 */

import {
  type Interval,
  type Node,
  buildSorted,
  findContaining,
  maxEnd,
  maxNode,
  merge,
  minStart,
  nodeCount,
  popMax,
  popMin,
  shiftTree,
  split,
  sharedNodeCount,
  toList,
  makeNode,
  freshPriority,
} from "./treap.js";

export type Affinity = "left" | "right";

export interface AffinityPolicy {
  /** Affinity of an interval's left edge when it lands on an edit boundary. */
  start?: Affinity;
  /** Affinity of an interval's right edge when it lands on an edit boundary. */
  end?: Affinity;
}

export interface TextEdit {
  /** Inclusive start offset in the *original* coordinate space. */
  start: number;
  /** Exclusive end offset in the *original* coordinate space. */
  end: number;
  /** Length of the replacement text (0 = pure deletion). */
  newLength: number;
}

export type RangeMapOptions<V> = {
  valuesEqual?: (a: V, b: V) => boolean;
};

export type TransformOptions = {
  /**
   * How interval edges glued to an edit boundary map.
   *
   * A shorthand string sets both edges; an object sets them independently.
   * Defaults model text-like content that sticks to the replacement region:
   * start edges use "right" affinity, end edges use "left" affinity.
   */
  affinity?: Affinity | AffinityPolicy;
};

export interface RangeMapStats {
  /** Number of interval nodes reachable from this version's root. */
  nodes: number;
  /** Number of stored intervals (equals nodes here). */
  intervals: number;
  /** Height of the treap. */
  height: number;
}

interface NormalizedEdit extends TextEdit {
  /** Cumulative delta of all edits strictly before this one. */
  base: number;
  /** newLength - (end - start). */
  delta: number;
}

function defaultEqual<V>(a: V, b: V): boolean {
  return Object.is(a, b);
}

function isInt(n: number): boolean {
  return Number.isInteger(n);
}

function leaf<V>(start: number, end: number, value: V): Node<V> {
  return makeNode<V>(start, end, value, freshPriority());
}

/**
 * Merge two trees whose pieces are ordered by min-key, fusing the boundary
 * pair when intervals touch and carry equal values. If the later tree starts
 * inside the earlier max interval (possible when mixed affinities fold two
 * boundary intervals onto overlapping ranges), its overlapping prefix is
 * clipped away.
 */
function joinOne<V>(
  eq: (a: V, b: V) => boolean,
  a: Node<V> | null,
  b: Node<V> | null,
): Node<V> | null {
  if (a === null) return b;
  if (b === null) return a;
  const [aLeft, aMax] = popMax(a);
  const [bMin, bRight] = popMin(b);

  if (bMin.start < aMax.end) {
    if (bMin.end <= aMax.end) {
      // Whole next piece (and conceptually following keys until past the
      // boundary) is covered; merge without it and re-process the remainder.
      return joinOne(eq, a, bRight);
    }
    // The next piece straddles the boundary: keep only its tail; the covered
    // prefix belongs to the earlier interval.
    const tailStart = aMax.end;
    const tail = leaf<V>(tailStart, bMin.end, bMin.value);
    return joinOne(eq, a, merge(tail, bRight));
  }

  if (aMax.end === bMin.start && eq(aMax.value, bMin.value)) {
    const fused = makeNode<V>(
      aMax.start,
      bMin.end,
      aMax.value,
      aMax.priority,
    );
    return merge(merge(aLeft, fused), bRight);
  }
  return merge(a, b);
}

function joinAll<V>(
  eq: (a: V, b: V) => boolean,
  trees: ReadonlyArray<Node<V> | null>,
): Node<V> | null {
  let acc: Node<V> | null = null;
  for (const t of trees) acc = joinOne(eq, acc, t);
  return acc;
}

export class RangeMap<V> {
  private readonly root: Node<V> | null;
  private readonly eq: (a: V, b: V) => boolean;

  private constructor(
    root: Node<V> | null,
    eq: (a: V, b: V) => boolean,
  ) {
    this.root = root;
    this.eq = eq;
  }

  /** Empty map. */
  static empty<V>(options?: RangeMapOptions<V>): RangeMap<V> {
    return new RangeMap<V>(null, options?.valuesEqual ?? defaultEqual);
  }

  /**
   * Build in O(n) from intervals sorted by start. Empty intervals are ignored.
   * Overlapping intervals are rejected; adjacent equal-valued intervals are
   * coalesced.
   */
  static fromSorted<V>(
    segments: ReadonlyArray<Interval<V>>,
    options?: RangeMapOptions<V>,
  ): RangeMap<V> {
    const eq = options?.valuesEqual ?? defaultEqual;
    const merged: Array<Interval<V>> = [];
    for (const seg of segments) {
      if (!isInt(seg.start) || !isInt(seg.end) || seg.start < 0) {
        throw new RangeError(
          `invalid interval [${seg.start}, ${seg.end}): coordinates must be non-negative integers`,
        );
      }
      if (seg.end < seg.start) {
        throw new RangeError(
          `invalid interval [${seg.start}, ${seg.end}): end before start`,
        );
      }
      if (seg.start === seg.end) continue; // empty intervals store nothing
      const prev = merged[merged.length - 1];
      if (prev !== undefined) {
        if (seg.start < prev.end) {
          throw new RangeError(
            `overlapping intervals at [${seg.start}, ${seg.end})`,
          );
        }
        if (seg.start === prev.end && eq(prev.value, seg.value)) {
          merged[merged.length - 1] = {
            start: prev.start,
            end: seg.end,
            value: prev.value,
          };
          continue;
        }
      }
      merged.push({ start: seg.start, end: seg.end, value: seg.value });
    }
    return new RangeMap<V>(buildSorted(merged), eq);
  }

  /** Number of mapped intervals in this version. */
  get size(): number {
    return this.root === null ? 0 : this.root.size;
  }

  /** Value covering point p, or undefined when p is unmapped. */
  get(p: number): V | undefined {
    const hit = findContaining(this.root, p);
    return hit === null ? undefined : hit.value;
  }

  /** Sorted interval list of this version. */
  toArray(): Array<Interval<V>> {
    return toList(this.root);
  }

  /**
   * Overwrite [start, end) with value, splitting any intersecting intervals
   * and coalescing with adjacent intervals carrying the same value.
   *
   * Empty ranges (start === end) are no-ops: this version is returned.
   */
  set(start: number, end: number, value: V): RangeMap<V> {
    this.assertRange(start, end);
    if (start === end) return this;

    const [before, rest] = split(this.root, start);
    const [mid, after] = split(rest, end);

    let left: Node<V> | null = null;
    let right: Node<V> | null = after;

    if (before !== null) {
      const crossing = maxEnd(before) > start ? maxNode(before) : null;
      if (crossing !== null) {
        const [bl, bm] = popMax(before);
        if (bm.start < start) {
          left = merge(bl, leaf<V>(bm.start, start, bm.value));
        } else {
          left = bl;
        }
        if (bm.end > end) {
          // One interval fully enclosed the overwrite: keep its right tail.
          right = joinOne(this.eq, leaf<V>(end, bm.end, bm.value), after);
        }
      } else {
        left = before;
      }
    }

    if (mid !== null) {
      // Only the max-key interval of mid can extend past `end` (disjointness).
      const last = maxNode(mid);
      if (last !== null && last.end > end) {
        const [, mm] = popMax(mid);
        right = joinOne(this.eq, leaf<V>(end, mm.end, mm.value), right);
      }
    }

    const next = joinAll(this.eq, [left, leaf<V>(start, end, value), right]);
    return new RangeMap<V>(next, this.eq);
  }

  /**
   * Remove mappings from [start, end). Surviving intervals keep their
   * coordinates; the deleted range becomes an unmapped gap.
   *
   * Empty ranges are no-ops.
   */
  delete(start: number, end: number): RangeMap<V> {
    this.assertRange(start, end);
    if (start === end) return this;

    const [before, rest] = split(this.root, start);
    const [mid, after] = split(rest, end);

    let left: Node<V> | null = null;
    let right: Node<V> | null = after;

    if (before !== null) {
      if (maxEnd(before) > start) {
        const [bl, bm] = popMax(before);
        if (bm.start < start) {
          left = merge(bl, leaf<V>(bm.start, start, bm.value));
        } else {
          left = bl;
        }
        if (bm.end > end) {
          right = joinOne(this.eq, leaf<V>(end, bm.end, bm.value), after);
        }
      } else {
        left = before;
      }
    }

    if (mid !== null) {
      const last = maxNode(mid);
      if (last !== null && last.end > end) {
        const [, mm] = popMax(mid);
        right = joinOne(this.eq, leaf<V>(end, mm.end, mm.value), right);
      }
    }

    // left ends at `start`, right starts at `end`; the gap keeps them apart,
    // so no cross-boundary coalescing is possible.
    const next = joinAll(this.eq, [left, right]);
    return new RangeMap<V>(next, this.eq);
  }

  /**
   * Translate every interval coordinate by delta (e.g. after moving a whole
   * document prefix). O(1): only the root node is cloned.
   */
  shift(delta: number): RangeMap<V> {
    if (!isInt(delta)) throw new RangeError("shift delta must be an integer");
    if (delta === 0) return this;
    return new RangeMap<V>(shiftTree(this.root, delta), this.eq);
  }

  /**
   * Apply a batch of text replacements given in *original* coordinates.
   *
   * Interval coordinates are re-mapped into the post-edit space:
   *  - edges before/after the edited regions shift by the cumulative delta;
   *  - edges on an edit boundary follow the requested affinity;
   *  - edges strictly inside a deleted/replaced region fold onto a boundary;
   *  - intervals that collapse (mapped start === mapped end) disappear, except
   *    the interval spanning the whole replacement region, which keeps the
   *    value over the inserted text.
   *
   * Edits must be non-overlapping. Returns a new version; with zero effective
   * edits this version is returned unchanged.
   */
  transform(
    edits: ReadonlyArray<TextEdit>,
    options?: TransformOptions,
  ): RangeMap<V> {
    const startAff = resolveAffinity(options?.affinity, "start");
    const endAff = resolveAffinity(options?.affinity, "end");

    const norm = normalizeEdits(edits);
    if (norm.length === 0) return this;

    interface FarPart {
      tree: Node<V>;
      delta: number;
    }

    // Step 1: peel off every interval that touches or crosses an edit
    // boundary. At most two distinct intervals per boundary, deduplicated by
    // node identity (an enclosing interval may be met at several cuts).
    //
    // The remaining chunks ("far") contain only intervals lying strictly in a
    // gap, so all their coordinates move by one cumulative delta each.
    const far: FarPart[] = [];
    const specialIds = new Set<Node<V>>();
    const specials: Array<Node<V>> = [];

    let cursor: Node<V> | null = this.root;
    let base = 0;

    const takeSpecial = (n: Node<V>): void => {
      if (!specialIds.has(n)) {
        specialIds.add(n);
        specials.push(n);
      }
    };

    for (const edit of norm) {
      const [lTree, rest] = split(cursor, edit.start);

      // Left cut: the max-key interval below the boundary. It is a boundary
      // interval when it reaches the cut (crossing or just touching); only a
      // boundary interval can fold by affinity, so those go to specials.
      if (lTree !== null && maxEnd(lTree) >= edit.start) {
        const [bl, bm] = popMax(lTree);
        takeSpecial(bm);
        if (bl !== null) far.push({ tree: bl, delta: base });
      } else if (lTree !== null) {
        far.push({ tree: lTree, delta: base });
      }

      const [middleTree, rightTree] = split(rest, edit.end);
      let middle = middleTree;

      // Right cut: the min-key interval at/above the boundary.
      if (rightTree !== null && minStart(rightTree) === edit.end) {
        const [mn, rn] = popMin(rightTree);
        takeSpecial(mn);
        cursor = rn;
      } else {
        cursor = rightTree;
      }

      // Inside [start, end): the min may open on the left boundary and the
      // max may cross the right boundary; strictly interior ones are dropped.
      if (middle !== null && minStart(middle) === edit.start) {
        const [mn, rest2] = popMin(middle);
        takeSpecial(mn);
        middle = rest2;
      }
      if (middle !== null && maxEnd(middle) >= edit.end) {
        // Interval reaching or touching the right boundary: its closing edge
        // must map edge-wise, so it cannot be bulk-discarded.
        const [rest2, mx] = popMax(middle);
        takeSpecial(mx);
        middle = rest2;
      }

      base += edit.delta;
    }
    if (cursor !== null) far.push({ tree: cursor, delta: base });

    const trees: Array<Node<V> | null> = far.map((p) =>
      shiftTree(p.tree, p.delta),
    );

    // Step 2: re-insert boundary intervals, mapping each edge pointwise.
    for (const sp of specials) {
      const ns = mapPoint(sp.start, norm, startAff);
      const ne = mapPoint(sp.end, norm, endAff);
      if (ns < ne) trees.push(leaf<V>(ns, ne, sp.value));
    }

    trees.sort((a, b) => {
      if (a === null) return b === null ? 0 : -1;
      if (b === null) return 1;
      const sa = minStart(a);
      const sb = minStart(b);
      if (sa !== sb) return sa - sb;
      return maxEnd(a) - maxEnd(b);
    });

    const next = joinAll(this.eq, trees);
    return new RangeMap<V>(next, this.eq);
  }

  /** Debug statistics for structural-sharing verification. */
  stats(): RangeMapStats {
    const heightOf = (t: Node<V> | null): number => {
      if (t === null) return 0;
      return 1 + Math.max(heightOf(t.left), heightOf(t.right));
    };
    return {
      nodes: nodeCount([this.root]),
      intervals: this.size,
      height: heightOf(this.root),
    };
  }

  /**
   * Count treap node objects that are literally the same object in this
   * version and `other` — the structural-sharing proof (not just equal output).
   */
  sharedNodes(other: RangeMap<V>): number {
    return sharedNodeCount(this.root, other.root);
  }

  private assertRange(start: number, end: number): void {
    if (!isInt(start) || !isInt(end) || start < 0) {
      throw new RangeError(
        `coordinates must be non-negative integers, got [${start}, ${end})`,
      );
    }
    if (end < start) {
      throw new RangeError(`end ${end} is before start ${start}`);
    }
  }
}

function resolveAffinity(
  aff: Affinity | AffinityPolicy | undefined,
  edge: "start" | "end",
): Affinity {
  if (aff === undefined) return edge === "start" ? "right" : "left";
  if (typeof aff === "string") return aff;
  if (edge === "start") return aff.start ?? "right";
  return aff.end ?? "left";
}

function normalizeEdits(edits: ReadonlyArray<TextEdit>): NormalizedEdit[] {
  const out: NormalizedEdit[] = [];
  for (const e of edits) {
    if (
      !isInt(e.start) ||
      !isInt(e.end) ||
      !isInt(e.newLength) ||
      e.start < 0 ||
      e.newLength < 0
    ) {
      throw new RangeError(
        `invalid edit {start:${e.start}, end:${e.end}, newLength:${e.newLength}}`,
      );
    }
    if (e.end < e.start) throw new RangeError("edit end before start");
    if (e.start === e.end && e.newLength === 0) continue; // pure no-op
    out.push({
      start: e.start,
      end: e.end,
      newLength: e.newLength,
      base: 0,
      delta: e.newLength - (e.end - e.start),
    });
  }
  out.sort((a, b) => a.start - b.start);
  let base = 0;
  for (let i = 0; i < out.length; i++) {
    const e = out[i]!;
    if (i > 0 && e.start < out[i - 1]!.end) {
      throw new RangeError("transform edits must not overlap");
    }
    e.base = base;
    base += e.delta;
  }
  return out;
}

/**
 * Map one original-coordinate point into post-edit coordinates.
 *
 * Folding rules around one edited region:
 *   - p === e.start (left edge, zero-width edits included):
 *       "left"  -> mapped region start
 *       "right" -> mapped region end
 *   - strictly inside [start, end): same fold by affinity;
 *   - p === e.end with e.end > e.start (right edge): after the region, so it
 *     moves to the mapped end regardless of affinity;
 *   - strictly outside: only the cumulative shift applies.
 */
function mapPoint(
  p: number,
  edits: ReadonlyArray<NormalizedEdit>,
  aff: Affinity,
): number {
  for (const e of edits) {
    const mappedStart = e.start + e.base;
    const mappedEnd = mappedStart + e.newLength;
    if (p < e.start) return p + e.base;
    if (p <= e.end) {
      if (p === e.end && p > e.start) return mappedEnd;
      return aff === "right" ? mappedEnd : mappedStart;
    }
    // p > e.end: continue; the point may fall inside a later edit.
  }
  const last = edits[edits.length - 1];
  return last === undefined ? p : p + (last.base + last.delta);
}
