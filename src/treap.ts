/**
 * Persistent randomized treap keyed by `start` of half-open intervals.
 *
 * Each node stores one interval [start, end) -> value. Every node carries a
 * lazy `off` offset that applies to itself and its entire subtree; pushing the
 * offset copies only the two children (never the whole subtree), so shifting
 * a whole forest is O(1) and keeps structural sharing across versions.
 *
 * Every mutation clones the nodes it touches; input nodes are never mutated.
 */

import { freeze } from "./freeze.js";

export interface Interval<V> {
  start: number;
  end: number;
  value: V;
}

export interface Node<V> extends Interval<V> {
  readonly priority: number;
  readonly size: number;
  readonly off: number;
  readonly left: Node<V> | null;
  readonly right: Node<V> | null;
}

export type Forest<V> = ReadonlyArray<Node<V> | null>;

let nextPriority = 1;

/**
 * Deterministic well-mixed pseudo-random priority (splitmix32 finalizer over
 * a monotonic counter). Plain xorshift over a linear counter is too strongly
 * correlated and would degenerate the Cartesian tree on sequential builds.
 */
export function freshPriority(): number {
  let z = (nextPriority++ | 0) >>> 0;
  z = (z + 0x9e3779b9) | 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  z ^= z >>> 15;
  return z >>> 0;
}

function nodeSize<V>(n: Node<V> | null): number {
  return n === null ? 0 : n.size;
}

export function makeNode<V>(
  start: number,
  end: number,
  value: V,
  priority: number,
  left: Node<V> | null = null,
  right: Node<V> | null = null,
  off = 0,
): Node<V> {
  return freeze<V>({
    start,
    end,
    value,
    priority,
    left,
    right,
    off,
    size: nodeSize(left) + nodeSize(right) + 1,
  });
}

/** Clone a node, replacing the given fields. */
function clone<V>(
  n: Node<V>,
  fields: Partial<Omit<Node<V>, "size">>,
): Node<V> {
  const left = fields.left !== undefined ? fields.left : n.left;
  const right = fields.right !== undefined ? fields.right : n.right;
  return freeze<V>({
    start: fields.start !== undefined ? fields.start : n.start,
    end: fields.end !== undefined ? fields.end : n.end,
    value: fields.value !== undefined ? fields.value : n.value,
    priority: n.priority,
    left,
    right,
    off: fields.off !== undefined ? fields.off : n.off,
    size: nodeSize(left) + nodeSize(right) + 1,
  });
}

function apply<V>(root: Node<V>, d: number): Node<V> {
  if (d === 0) return root;
  return clone(root, {
    start: root.start + d,
    end: root.end + d,
    off: root.off + d,
  });
}

/** Add lazy offset d to an entire tree in O(1) (structural sharing). */
export function shiftTree<V>(root: Node<V> | null, d: number): Node<V> | null {
  if (root === null || d === 0) return root;
  return apply(root, d);
}

/** Push lazy offset into children; returns a node whose own subtree is settled. */
function push<V>(root: Node<V>): Node<V> {
  const d = root.off;
  if (d === 0) return root;
  return clone(root, {
    left: root.left === null ? null : apply(root.left, d),
    right: root.right === null ? null : apply(root.right, d),
    off: 0,
  });
}

/**
 * Split by interval start: L holds keys < key, R holds keys >= key.
 */
export function split<V>(
  root: Node<V> | null,
  key: number,
): [Node<V> | null, Node<V> | null] {
  if (root === null) return [null, null];
  const t = push(root);
  if (t.start < key) {
    const [l, r] = split(t.right, key);
    return [clone(t, { right: l }), r];
  }
  const [l, r] = split(t.left, key);
  return [l, clone(t, { left: r })];
}

/** Merge: every key in A must be smaller than every key in B. */
export function merge<V>(
  a: Node<V> | null,
  b: Node<V> | null,
): Node<V> | null {
  if (a === null) return b;
  if (b === null) return a;
  const A = push(a);
  const B = push(b);
  if (A.priority >= B.priority) {
    return clone(A, { right: merge(A.right, B) });
  }
  return clone(B, { left: merge(A, B.left) });
}

/** Remove and return the minimum-key node (its children are stripped). */
export function popMin<V>(
  root: Node<V>,
): [Node<V>, Node<V> | null] {
  const t = push(root);
  if (t.left === null) {
    const stripped = makeNode<V>(t.start, t.end, t.value, t.priority);
    return [stripped, t.right];
  }
  const [min, left] = popMin(t.left);
  return [min, clone(t, { left })];
}

/** Remove and return the maximum-key node (its children are stripped). */
export function popMax<V>(
  root: Node<V>,
): [Node<V> | null, Node<V>] {
  const t = push(root);
  if (t.right === null) {
    const stripped = makeNode<V>(t.start, t.end, t.value, t.priority);
    return [t.left, stripped];
  }
  const [right, max] = popMax(t.right);
  return [clone(t, { right }), max];
}

function minNode<V>(root: Node<V>): Node<V> {
  const t = push(root);
  return t.left === null ? t : minNode(t.left);
}

export function maxNode<V>(root: Node<V>): Node<V> {
  const t = push(root);
  return t.right === null ? t : maxNode(t.right);
}

export function minStart<V>(root: Node<V>): number {
  return minNode(root).start;
}

export function maxStart<V>(root: Node<V>): number {
  return maxNode(root).start;
}

export function maxEnd<V>(root: Node<V>): number {
  return maxNode(root).end;
}

/** Find the unique interval containing point p, or null. Read-only traversal. */
export function findContaining<V>(
  root: Node<V> | null,
  p: number,
): Interval<V> | null {
  let t = root;
  let off = 0;
  while (t !== null) {
    const start = t.start + off;
    const end = t.end + off;
    if (p < start) {
      if (t.left === null) return null;
      off += t.left.off;
      t = t.left;
    } else if (p >= end) {
      if (t.right === null) return null;
      off += t.right.off;
      t = t.right;
    } else {
      return { start, end, value: t.value };
    }
  }
  return null;
}

/** In-order list of intervals, honoring lazy offsets. */
export function toList<V>(root: Node<V> | null): Array<Interval<V>> {
  const out: Array<Interval<V>> = [];
  const walk = (t: Node<V> | null, base: number): void => {
    if (t === null) return;
    walk(t.left, base + t.off);
    out.push({
      start: t.start + base,
      end: t.end + base,
      value: t.value,
    });
    walk(t.right, base + t.off);
  };
  walk(root, 0);
  return out;
}

/**
 * Linear-time Cartesian-tree build from strictly-disjoint sorted segments.
 * Caller guarantees the segments are sorted and non-overlapping.
 */
export function buildSorted<V>(segments: ReadonlyArray<Interval<V>>): Node<V> | null {
  interface M {
    seg: Interval<V>;
    priority: number;
    left: M | null;
    right: M | null;
  }
  const stack: M[] = [];
  for (const seg of segments) {
    let last: M | null = null;
    const cur: M = { seg, priority: freshPriority(), left: null, right: null };
    while (stack.length > 0 && stack[stack.length - 1]!.priority < cur.priority) {
      last = stack.pop()!;
    }
    cur.left = last;
    if (stack.length > 0) stack[stack.length - 1]!.right = cur;
    stack.push(cur);
  }
  // Freeze and compute sizes bottom-up in a single pass.
  const fix = (m: M | null): Node<V> | null => {
    if (m === null) return null;
    const left = fix(m.left);
    const right = fix(m.right);
    return makeNode<V>(
      m.seg.start,
      m.seg.end,
      m.seg.value,
      m.priority,
      left,
      right,
    );
  };
  return fix(stack[0] ?? null);
}

/** Count nodes in a forest (duplicates across trees are counted twice). */
export function nodeCount<V>(trees: Forest<V>): number {
  let n = 0;
  for (const t of trees) {
    const walk = (x: Node<V> | null): void => {
      if (x === null) return;
      n++;
      walk(x.left);
      walk(x.right);
    };
    walk(t);
  }
  return n;
}

/** Count distinct node objects shared between two forests. */
export function sharedNodeCount<V>(
  a: Node<V> | null,
  b: Node<V> | null,
): number {
  const inA = new Set<Node<V>>();
  const collect = (t: Node<V> | null): void => {
    if (t === null) return;
    inA.add(t);
    collect(t.left);
    collect(t.right);
  };
  collect(a);
  let shared = 0;
  const count = (t: Node<V> | null): void => {
    if (t === null) return;
    if (inA.has(t)) shared++;
    count(t.left);
    count(t.right);
  };
  count(b);
  return shared;
}
