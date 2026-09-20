/**
 * persistent-range-map —— 持久化（不可变、按版本）Range Map 内核。
 *
 * 把互不重叠的半开区间 [start, end) 映射到值。每次修改返回新版本，
 * 旧版本继续可读；版本之间通过路径复制（path copying）+ 子树懒移位
 * （lazy subtree shift）实现结构共享，单点修改只分配 O(log n) 个新节点，
 * 坐标平移类操作对每个连续分段只分配 O(1) 个节点。
 *
 * 数据结构：按区间 start 排序的持久化 AVL 树。每个节点带一个 `shift`
 * 懒标记，表示"该子树所有坐标还需加上此值"；读取路径时累计，结构变更
 * 路径上先下推（push）再旋转，因此 split/join/insert/remove 都是标准的
 * 持久化 AVL 操作。
 *
 * 语义约定：
 * - 区间半开 [start, end)，start < end；空区间的 set 是无操作。
 * - 覆盖（set）会先切分与目标区域相交的已有区间，删除被覆盖部分，
 *   然后与左右"相邻且等值且同 affinity"的区间合并（规范形）。
 * - 删除（delete）只移除区间在范围内的部分，不平移坐标。
 * - 每个区间带一个 affinity（'left' | 'right'），决定批量文本替换
 *   （applyEdits / shift）时边界点如何映射：
 *     - 边界点落在被删除/被替换区域内：left → 折叠到替换后区域的起点，
 *       right → 折叠到替换后区域的终点（即插入文本之后）。
 *     - 边界点恰好等于编辑起点/终点时同样按上式处理，因此插入文本时
 *       left affinity 的起点不动、right affinity 的终点会跟着插入文本走。
 *     - 映射后起点 >= 终点的区间被丢弃（折叠策略）。
 * - 一批编辑（applyEdits）全部以原版本坐标给出、同时生效；相邻编辑
 *   （前一个 end == 后一个 start）会先合并为单个编辑，保证边界归属唯一。
 * - 相邻两个区间一个 right affinity（向左区间）一个 left affinity
 *   （向右区间）同时争夺同一插入文本时，左区间优先（确定性的平局裁决）。
 * - 映射后相邻且等值且同 affinity 的区间会重新合并，保持规范形。
 */

export type Affinity = 'left' | 'right';

/** 只读区间条目（绝对坐标）。 */
export interface RangeEntry<V> {
  readonly start: number;
  readonly end: number;
  readonly value: V;
  readonly affinity: Affinity;
}

/** 构造 fromEntries 时允许的输入（affinity 可省略，取默认值）。 */
export interface RangeEntryInput<V> {
  readonly start: number;
  readonly end: number;
  readonly value: V;
  readonly affinity?: Affinity;
}

/** 一次文本替换：把原坐标区间 [start, end) 替换为 insertLength 个字符。 */
export interface Edit {
  readonly start: number;
  readonly end: number;
  readonly insertLength: number;
}

export interface RangeMapOptions<V> {
  /** 值相等判断（用于相邻合并），默认 Object.is。 */
  readonly equals?: (a: V, b: V) => boolean;
  /** 未显式指定时区间使用的 affinity，默认 'left'。 */
  readonly defaultAffinity?: Affinity;
}

/** 单版本调试统计。 */
export interface DebugInfo {
  /** 版本号（单调递增，仅用于调试标识）。 */
  readonly version: number;
  /** 区间条数。 */
  readonly size: number;
  /** 该版本树的节点总数。 */
  readonly nodeCount: number;
  /** 树高。 */
  readonly height: number;
}

/**
 * 内部树节点。字段全部只读，节点创建后绝不修改（持久化的基础）。
 * `shift` 是懒移位标记：该子树所有 start/end 的绝对坐标 = 存储坐标 +
 * 从根到该节点路径上所有 shift 之和（含自身）。向调试/测试公开，
 * 用于验证版本间的结构共享。
 */
export interface RangeMapNode<V> {
  readonly start: number;
  readonly end: number;
  readonly value: V;
  readonly affinity: Affinity;
  readonly left: RangeMapNode<V> | null;
  readonly right: RangeMapNode<V> | null;
  readonly height: number;
  readonly size: number;
  readonly shift: number;
}

// ---------------------------------------------------------------------------
// 调试计数器
// ---------------------------------------------------------------------------

let allocatedNodes = 0;
let versionClock = 0;

/** 进程内累计分配的节点数（用于验证结构共享：单次修改应远小于全量复制）。 */
export function getAllocatedNodeCount(): number {
  return allocatedNodes;
}

/** 重置调试计数器（测试用）。 */
export function resetDebugCounters(): void {
  allocatedNodes = 0;
}

function nextVersion(): number {
  return ++versionClock;
}

// ---------------------------------------------------------------------------
// 节点级原语
// ---------------------------------------------------------------------------

const h = <V>(n: RangeMapNode<V> | null): number => (n === null ? 0 : n.height);

function makeNode<V>(
  start: number,
  end: number,
  value: V,
  affinity: Affinity,
  left: RangeMapNode<V> | null,
  right: RangeMapNode<V> | null,
): RangeMapNode<V> {
  allocatedNodes++;
  return {
    start,
    end,
    value,
    affinity,
    left,
    right,
    shift: 0,
    height: 1 + Math.max(h(left), h(right)),
    size: 1 + (left === null ? 0 : left.size) + (right === null ? 0 : right.size),
  };
}

/** 给整棵子树懒加坐标偏移，O(1)。 */
function addShift<V>(n: RangeMapNode<V> | null, delta: number): RangeMapNode<V> | null {
  if (n === null || delta === 0) return n;
  allocatedNodes++;
  return { ...n, shift: n.shift + delta };
}

/**
 * 下推懒标记：返回 shift 为 0、坐标已物化、子树继承原标记的节点。
 * 结构操作（旋转/split/join/增删）前必须先 push 路径上的节点。
 */
function push<V>(n: RangeMapNode<V>): RangeMapNode<V> {
  if (n.shift === 0) return n;
  return makeNode(
    n.start + n.shift,
    n.end + n.shift,
    n.value,
    n.affinity,
    addShift(n.left, n.shift),
    addShift(n.right, n.shift),
  );
}

function withLeft<V>(n: RangeMapNode<V>, left: RangeMapNode<V> | null): RangeMapNode<V> {
  return makeNode(n.start, n.end, n.value, n.affinity, left, n.right);
}

function withRight<V>(n: RangeMapNode<V>, right: RangeMapNode<V> | null): RangeMapNode<V> {
  return makeNode(n.start, n.end, n.value, n.affinity, n.left, right);
}

function rotateLeft<V>(x: RangeMapNode<V>): RangeMapNode<V> {
  // x 必须已 push（shift == 0）；y 先 push，使旋转只涉及 shift 为 0 的节点。
  const y = push(x.right as RangeMapNode<V>);
  const x2 = makeNode(x.start, x.end, x.value, x.affinity, x.left, y.left);
  return makeNode(y.start, y.end, y.value, y.affinity, x2, y.right);
}

function rotateRight<V>(x: RangeMapNode<V>): RangeMapNode<V> {
  const y = push(x.left as RangeMapNode<V>);
  const x2 = makeNode(x.start, x.end, x.value, x.affinity, y.right, x.right);
  return makeNode(y.start, y.end, y.value, y.affinity, y.left, x2);
}

function rebalance<V>(n: RangeMapNode<V>): RangeMapNode<V> {
  const bf = h(n.left) - h(n.right);
  if (bf > 1) {
    let l = push(n.left as RangeMapNode<V>);
    if (h(l.left) < h(l.right)) l = rotateLeft(l);
    return rotateRight(withLeft(n, l));
  }
  if (bf < -1) {
    let r = push(n.right as RangeMapNode<V>);
    if (h(r.right) < h(r.left)) r = rotateRight(r);
    return rotateLeft(withRight(n, r));
  }
  return n;
}

/** 区间载荷（绝对坐标），split/join 之间传递。 */
interface Payload<V> {
  readonly start: number;
  readonly end: number;
  readonly value: V;
  readonly affinity: Affinity;
}

function payloadOf<V>(n: RangeMapNode<V>): Payload<V> {
  return { start: n.start, end: n.end, value: n.value, affinity: n.affinity };
}

/** BST 插入（key = start，调用方保证不与现有区间重叠）。 */
function insertNode<V>(t: RangeMapNode<V> | null, p: Payload<V>): RangeMapNode<V> {
  if (t === null) return makeNode(p.start, p.end, p.value, p.affinity, null, null);
  const n = push(t);
  if (p.start < n.start) {
    return rebalance(withLeft(n, insertNode(n.left, p)));
  }
  if (p.start > n.start) {
    return rebalance(withRight(n, insertNode(n.right, p)));
  }
  throw new Error(`duplicate interval start: ${p.start}`);
}

/** 按 key（绝对坐标 start）删除。 */
function removeNode<V>(t: RangeMapNode<V> | null, key: number): RangeMapNode<V> | null {
  if (t === null) return null;
  const n = push(t);
  if (key < n.start) return rebalance(withLeft(n, removeNode(n.left, key)));
  if (key > n.start) return rebalance(withRight(n, removeNode(n.right, key)));
  if (n.left === null) return n.right;
  if (n.right === null) return n.left;
  const [rest, min] = splitMin(n.right);
  return rebalance(makeNode(min.start, min.end, min.value, min.affinity, n.left, rest));
}

/** 拆出最小节点，返回 [剩余树, 最小节点载荷（绝对坐标）]。 */
function splitMin<V>(t: RangeMapNode<V>): [RangeMapNode<V> | null, Payload<V>] {
  const n = push(t);
  if (n.left === null) return [n.right, payloadOf(n)];
  const [l, m] = splitMin(n.left);
  return [rebalance(withLeft(n, l)), m];
}

/** 拆出最大节点，返回 [剩余树, 最大节点载荷（绝对坐标）]。 */
function splitMax<V>(t: RangeMapNode<V>): [RangeMapNode<V> | null, Payload<V>] {
  const n = push(t);
  if (n.right === null) return [n.left, payloadOf(n)];
  const [r, m] = splitMax(n.right);
  return [rebalance(withRight(n, r)), m];
}

/** 按 key 分裂：左树所有 start < key，右树所有 start >= key（key 为绝对坐标）。 */
function split<V>(
  t: RangeMapNode<V> | null,
  key: number,
): [RangeMapNode<V> | null, RangeMapNode<V> | null] {
  if (t === null) return [null, null];
  const n = push(t);
  if (key <= n.start) {
    const [l, r] = split(n.left, key);
    return [l, joinWith(r, payloadOf(n), n.right)];
  }
  const [l, r] = split(n.right, key);
  return [joinWith(n.left, payloadOf(n), l), r];
}

/** AVL 连接：l 的所有 key < p.start < r 的所有 key。 */
function joinWith<V>(
  l: RangeMapNode<V> | null,
  p: Payload<V>,
  r: RangeMapNode<V> | null,
): RangeMapNode<V> {
  const hl = h(l);
  const hr = h(r);
  if (hl > hr + 1) {
    const n = push(l as RangeMapNode<V>);
    return rebalance(withRight(n, joinWith(n.right, p, r)));
  }
  if (hr > hl + 1) {
    const n = push(r as RangeMapNode<V>);
    return rebalance(withLeft(n, joinWith(l, p, n.left)));
  }
  return makeNode(p.start, p.end, p.value, p.affinity, l, r);
}

/** 连接两棵 key 不交的树（l 全部小于 r）。 */
function join2<V>(
  l: RangeMapNode<V> | null,
  r: RangeMapNode<V> | null,
): RangeMapNode<V> | null {
  if (l === null) return r;
  if (r === null) return l;
  const [l2, m] = splitMax(l);
  return joinWith(l2, m, r);
}

/** 只读查询最大区间（绝对坐标）。 */
function maxEntry<V>(t: RangeMapNode<V> | null): Payload<V> | null {
  let acc = 0;
  let n = t;
  while (n !== null) {
    acc += n.shift;
    if (n.right === null) {
      return { start: n.start + acc, end: n.end + acc, value: n.value, affinity: n.affinity };
    }
    n = n.right;
  }
  return null;
}

/** 只读查询最小区间（绝对坐标）。 */
function minEntry<V>(t: RangeMapNode<V> | null): Payload<V> | null {
  let acc = 0;
  let n = t;
  while (n !== null) {
    acc += n.shift;
    if (n.left === null) {
      return { start: n.start + acc, end: n.end + acc, value: n.value, affinity: n.affinity };
    }
    n = n.left;
  }
  return null;
}

/**
 * 若某个区间严格跨过 boundary（start < boundary < end），把它切成两段；
 * 否则原样返回。返回 [新树根, 是否发生切分]。
 */
function cutAt<V>(
  t: RangeMapNode<V> | null,
  boundary: number,
): [RangeMapNode<V> | null, boolean] {
  let acc = 0;
  let n = t;
  while (n !== null) {
    acc += n.shift;
    const s = n.start + acc;
    const e = n.end + acc;
    if (boundary <= s) {
      n = n.left;
      continue;
    }
    if (boundary >= e) {
      n = n.right;
      continue;
    }
    // s < boundary < e：切分
    let root = removeNode(t, s);
    root = insertNode(root, { start: s, end: boundary, value: n.value, affinity: n.affinity });
    root = insertNode(root, { start: boundary, end: e, value: n.value, affinity: n.affinity });
    return [root, true];
  }
  return [t, false];
}

/** 连接两个分段；若交界处相邻且等值同 affinity 则合并（保持规范形）。 */
function joinMerging<V>(
  l: RangeMapNode<V> | null,
  r: RangeMapNode<V> | null,
  equals: (a: V, b: V) => boolean,
): RangeMapNode<V> | null {
  if (l === null) return r;
  if (r === null) return l;
  const maxL = maxEntry(l) as Payload<V>;
  const minR = minEntry(r) as Payload<V>;
  if (maxL.end === minR.start && maxL.affinity === minR.affinity && equals(maxL.value, minR.value)) {
    const [l2, p1] = splitMax(l);
    const [r2, p2] = splitMin(r);
    return joinWith(l2, { start: p1.start, end: p2.end, value: p1.value, affinity: p1.affinity }, r2);
  }
  return join2(l, r);
}

// ---------------------------------------------------------------------------
// 编辑规范化（导出供测试/高级用法复用）
// ---------------------------------------------------------------------------

/**
 * 校验并规范化一批编辑：丢弃无操作编辑、按坐标排序、拒绝重叠，
 * 并把相邻编辑（前一个 end == 后一个 start）合并为单个编辑。
 * 合并相邻编辑不改变映射语义（最终文本相同、边界归属唯一），
 * 但能让"区间是否落入编辑区域"的判定无歧义。
 */
export function normalizeEdits(edits: readonly Edit[]): Edit[] {
  const sorted: Edit[] = [];
  for (const e of edits) {
    if (!Number.isFinite(e.start) || !Number.isFinite(e.end) || !Number.isFinite(e.insertLength)) {
      throw new RangeError('edit coordinates must be finite numbers');
    }
    if (e.start > e.end) {
      throw new RangeError(`edit start (${e.start}) must be <= end (${e.end})`);
    }
    if (e.insertLength < 0) {
      throw new RangeError(`edit insertLength (${e.insertLength}) must be >= 0`);
    }
    if (e.start === e.end && e.insertLength === 0) continue; // 无操作
    sorted.push(e);
  }
  sorted.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 0; i + 1 < sorted.length; i++) {
    if (sorted[i].end > sorted[i + 1].start) {
      throw new RangeError(
        `overlapping edits: [${sorted[i].start}, ${sorted[i].end}) and [${sorted[i + 1].start}, ${sorted[i + 1].end})`,
      );
    }
  }
  const merged: Edit[] = [];
  for (const e of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.end === e.start) {
      merged[merged.length - 1] = {
        start: last.start,
        end: e.end,
        insertLength: last.insertLength + e.insertLength,
      };
    } else {
      merged.push(e);
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// RangeMap
// ---------------------------------------------------------------------------

function checkRange(start: number, end: number): void {
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new RangeError('range bounds must be finite numbers');
  }
  if (start > end) {
    throw new RangeError(`range start (${start}) must be <= end (${end})`);
  }
}

/**
 * 不可变 Range Map 版本。所有修改方法返回新版本；本版本永远不变。
 * `root` 向调试公开，用于结构共享验证（不要修改其字段）。
 */
export class RangeMap<V> {
  private constructor(
    readonly root: RangeMapNode<V> | null,
    readonly version: number,
    readonly size: number,
    readonly equals: (a: V, b: V) => boolean,
    readonly defaultAffinity: Affinity,
  ) {}

  static empty<V>(options: RangeMapOptions<V> = {}): RangeMap<V> {
    return new RangeMap<V>(
      null,
      nextVersion(),
      0,
      options.equals ?? Object.is,
      options.defaultAffinity ?? 'left',
    );
  }

  /**
   * 从条目批量构造，O(n)。输入不必有序；重叠或空区间会抛错；
   * 相邻且等值同 affinity 的条目会被合并（规范形）。
   */
  static fromEntries<V>(
    entries: Iterable<RangeEntryInput<V>>,
    options: RangeMapOptions<V> = {},
  ): RangeMap<V> {
    const equals = options.equals ?? Object.is;
    const defaultAffinity = options.defaultAffinity ?? 'left';
    const arr: { start: number; end: number; value: V; affinity: Affinity }[] = [];
    for (const en of entries) {
      const affinity = en.affinity ?? defaultAffinity;
      if (!Number.isFinite(en.start) || !Number.isFinite(en.end) || !(en.start < en.end)) {
        throw new RangeError(`invalid interval [${en.start}, ${en.end})`);
      }
      arr.push({ start: en.start, end: en.end, value: en.value, affinity });
    }
    arr.sort((a, b) => a.start - b.start);
    const norm: { start: number; end: number; value: V; affinity: Affinity }[] = [];
    for (const en of arr) {
      const last = norm[norm.length - 1];
      if (last !== undefined && en.start < last.end) {
        throw new RangeError(`overlapping intervals: [${last.start}, ${last.end}) and [${en.start}, ${en.end})`);
      }
      if (
        last !== undefined &&
        last.end === en.start &&
        last.affinity === en.affinity &&
        equals(last.value, en.value)
      ) {
        last.end = en.end; // 合并相邻等值段（规范形）
      } else {
        norm.push({ ...en });
      }
    }
    const build = (lo: number, hi: number): RangeMapNode<V> | null => {
      if (lo >= hi) return null;
      const mid = (lo + hi) >>> 1;
      const en = norm[mid];
      return makeNode(en.start, en.end, en.value, en.affinity, build(lo, mid), build(mid + 1, hi));
    };
    const root = build(0, norm.length);
    return new RangeMap<V>(root, nextVersion(), norm.length, equals, defaultAffinity);
  }

  private next(root: RangeMapNode<V> | null): RangeMap<V> {
    return new RangeMap<V>(root, nextVersion(), root === null ? 0 : root.size, this.equals, this.defaultAffinity);
  }

  /** 查询覆盖 pos 的区间；无则 undefined。O(log n)。 */
  get(pos: number): RangeEntry<V> | undefined {
    let acc = 0;
    let n = this.root;
    while (n !== null) {
      acc += n.shift;
      const s = n.start + acc;
      const e = n.end + acc;
      if (pos < s) {
        n = n.left;
      } else if (pos >= e) {
        n = n.right;
      } else {
        return { start: s, end: e, value: n.value, affinity: n.affinity };
      }
    }
    return undefined;
  }

  has(pos: number): boolean {
    return this.get(pos) !== undefined;
  }

  /** 按 start 升序迭代全部区间。 */
  *entries(): IterableIterator<RangeEntry<V>> {
    yield* this.iterate(this.root, 0);
  }

  private *iterate(n: RangeMapNode<V> | null, acc: number): IterableIterator<RangeEntry<V>> {
    if (n === null) return;
    const a = acc + n.shift;
    yield* this.iterate(n.left, a);
    yield { start: n.start + a, end: n.end + a, value: n.value, affinity: n.affinity };
    yield* this.iterate(n.right, a);
  }

  /** 迭代与 [start, end) 相交的区间（升序）。 */
  *entriesIn(start: number, end: number): IterableIterator<RangeEntry<V>> {
    yield* this.iterateRange(this.root, 0, start, end);
  }

  private *iterateRange(
    n: RangeMapNode<V> | null,
    acc: number,
    start: number,
    end: number,
  ): IterableIterator<RangeEntry<V>> {
    if (n === null) return;
    const a = acc + n.shift;
    const s = n.start + a;
    const e = n.end + a;
    // 左子树所有区间 end <= s（不重叠不变式），s <= start 时左子树不可能相交
    if (s > start) yield* this.iterateRange(n.left, a, start, end);
    if (s < end && e > start) yield { start: s, end: e, value: n.value, affinity: n.affinity };
    // 右子树所有区间 start > s，s >= end 时右子树不可能相交
    if (s < end) yield* this.iterateRange(n.right, a, start, end);
  }

  /**
   * 覆盖：把 [start, end) 映射为 value。已有区间被切分、被覆盖部分删除，
   * 然后与左右相邻且等值同 affinity 的区间合并。start === end 为无操作。
   */
  set(start: number, end: number, value: V, affinity: Affinity = this.defaultAffinity): RangeMap<V> {
    checkRange(start, end);
    if (start === end) return this;
    let root = cutAt(this.root, start)[0];
    root = cutAt(root, end)[0];
    const [a, bc] = split(root, start);
    const [, c] = split(bc, end); // 中段（与 [start,end) 相交的区间）丢弃
    let ns = start;
    let ne = end;
    let left = a;
    let right = c;
    const p = maxEntry(a);
    if (p !== null && p.end === start && p.affinity === affinity && this.equals(p.value, value)) {
      ns = p.start;
      left = splitMax(a as RangeMapNode<V>)[0];
    }
    const n = minEntry(c);
    if (n !== null && n.start === end && n.affinity === affinity && this.equals(n.value, value)) {
      ne = n.end;
      right = splitMin(c as RangeMapNode<V>)[0];
    }
    return this.next(joinWith(left, { start: ns, end: ne, value, affinity }, right));
  }

  /** 删除：移除区间在 [start, end) 内的部分，坐标不平移。无变化时返回本版本。 */
  delete(start: number, end: number): RangeMap<V> {
    checkRange(start, end);
    if (start === end) return this;
    const [r1, c1] = cutAt(this.root, start);
    const [r2, c2] = cutAt(r1, end);
    const [a, bc] = split(r2, start);
    const [mid, c] = split(bc, end);
    if (mid === null && !c1 && !c2) return this; // 范围内没有任何区间
    return this.next(join2(a, c));
  }

  /** delete 的别名。 */
  remove(start: number, end: number): RangeMap<V> {
    return this.delete(start, end);
  }

  /**
   * 区间平移：把 at 及之后的所有坐标平移 delta。
   * 等价于文本编辑：delta > 0 时在 at 处插入 delta 个字符；
   * delta < 0 时删除 [at + delta, at) 这段文本。
   * 被插入点穿过的区间会拉伸覆盖插入文本；落在删除区域内的边界按
   * affinity 折叠。delta === 0 为无操作。
   */
  shift(at: number, delta: number): RangeMap<V> {
    if (!Number.isFinite(at) || !Number.isFinite(delta)) {
      throw new RangeError('shift arguments must be finite numbers');
    }
    if (delta === 0) return this;
    return delta > 0
      ? this.applyEdits([{ start: at, end: at, insertLength: delta }])
      : this.applyEdits([{ start: at + delta, end: at, insertLength: 0 }]);
  }

  /**
   * 批量文本替换。所有编辑以本版本（原）坐标给出、同时生效；
   * 编辑之间不得重叠（允许相邻，相邻编辑会先合并）。
   * 每个区间 [s, e) 按其 affinity 把 s、e 映射到新坐标，
   * 映射后为空（折叠）的区间被丢弃；相邻等值同 affinity 的区间重新合并。
   *
   * 实现：先在所有编辑边界切分区间，再按编辑把树分裂成若干连续分段；
   * 完全落入编辑区域的分段整体折叠丢弃；间隙分段只做 O(1) 懒平移；
   * 编辑边界上的区间端点按 affinity 做伸缩修正；最后按序连接并合并。
   * 复杂度 O((k + m) log n)，k 为被编辑触及的区间数，m 为编辑数。
   */
  applyEdits(edits: readonly Edit[]): RangeMap<V> {
    const es = normalizeEdits(edits);
    if (es.length === 0) return this;
    const m = es.length;
    // cum[i] = 前 i 个编辑的累计位移（cum[0] = 0）
    const cum: number[] = new Array<number>(m + 1);
    cum[0] = 0;
    for (let i = 0; i < m; i++) {
      cum[i + 1] = cum[i] + es[i].insertLength - (es[i].end - es[i].start);
    }

    // 1. 在所有编辑边界处切分跨边界的区间
    let root = this.root;
    for (const e of es) {
      root = cutAt(root, e.start)[0];
      root = cutAt(root, e.end)[0];
    }

    // 2. 分裂成分段：gaps[i] 是第 i 个编辑之前的间隙分段；
    //    完全落入编辑区域的分段（start ∈ [start_i, end_i)）整体折叠，丢弃。
    const gaps: (RangeMapNode<V> | null)[] = [];
    let rest = root;
    for (const e of es) {
      const [before, r1] = split(rest, e.start);
      const [, r2] = split(r1, e.end);
      gaps.push(before);
      rest = r2;
    }
    gaps.push(rest);

    // 3. 编辑边界端点的 affinity 修正（仅当插入了文本时才有影响）：
    //    - 左间隙最大区间若 end == start_i 且 right affinity：终点延伸到插入文本之后；
    //    - 右间隙最小区间若 start == end_i 且 left affinity：起点回拉到插入文本之前；
    //    - 两者同时争夺同一段插入文本时左区间优先（平局裁决）。
    for (let i = 0; i < m; i++) {
      const insLen = es[i].insertLength;
      if (insLen === 0) continue;
      const maxL = maxEntry(gaps[i]);
      const minR = minEntry(gaps[i + 1]);
      const extend = maxL !== null && maxL.end === es[i].start && maxL.affinity === 'right';
      let pull = minR !== null && minR.start === es[i].end && minR.affinity === 'left';
      if (extend && pull) pull = false; // 左区间优先
      if (extend) {
        const [g, p] = splitMax(gaps[i] as RangeMapNode<V>);
        gaps[i] = insertNode(g, { start: p.start, end: p.end + insLen, value: p.value, affinity: p.affinity });
      }
      if (pull) {
        const [g, p] = splitMin(gaps[i + 1] as RangeMapNode<V>);
        gaps[i + 1] = insertNode(g, { start: p.start - insLen, end: p.end, value: p.value, affinity: p.affinity });
      }
    }

    // 4. 每个间隙分段整体懒平移（O(1)/段）
    for (let i = 0; i <= m; i++) {
      if (cum[i] !== 0) gaps[i] = addShift(gaps[i], cum[i]);
    }

    // 5. 按序连接，交界处合并相邻等值段
    let result = gaps[0];
    for (let i = 1; i <= m; i++) {
      result = joinMerging(result, gaps[i], this.equals);
    }
    return this.next(result);
  }

  /** 单版本调试统计。 */
  debugInfo(): DebugInfo {
    return {
      version: this.version,
      size: this.size,
      nodeCount: this.root === null ? 0 : this.root.size,
      height: this.root === null ? 0 : this.root.height,
    };
  }
}

// ---------------------------------------------------------------------------
// 结构共享 / 不变式验证（调试与测试用）
// ---------------------------------------------------------------------------

/** 统计两个版本的树之间共享（同一对象引用）的节点数量。O(n)。 */
export function countSharedNodes<V>(a: RangeMap<V>, b: RangeMap<V>): number {
  const inA = new Set<RangeMapNode<V>>();
  const collect = (n: RangeMapNode<V> | null): void => {
    if (n === null) return;
    inA.add(n);
    collect(n.left);
    collect(n.right);
  };
  collect(a.root);
  let shared = 0;
  const walk = (n: RangeMapNode<V> | null): void => {
    if (n === null) return;
    if (inA.has(n)) shared++;
    walk(n.left);
    walk(n.right);
  };
  walk(b.root);
  return shared;
}

/**
 * 校验内部不变式（调试/测试用）：BST 有序、区间非空不重叠、
 * 相邻等值段已合并、height/size 元数据正确、AVL 平衡。违反时抛错。
 */
export function validateRangeMap<V>(map: RangeMap<V>): void {
  let prev: RangeEntry<V> | null = null;
  let counted = 0;
  const rec = (n: RangeMapNode<V> | null, acc: number): { height: number; size: number } => {
    if (n === null) return { height: 0, size: 0 };
    const a = acc + n.shift;
    const left = rec(n.left, a);
    const s = n.start + a;
    const e = n.end + a;
    if (!(s < e)) throw new Error(`invalid interval [${s}, ${e})`);
    if (prev !== null) {
      if (prev.end > s) {
        throw new Error(`overlapping/out-of-order intervals: [${prev.start}, ${prev.end}) then [${s}, ${e})`);
      }
      if (prev.end === s && prev.affinity === n.affinity && map.equals(prev.value, n.value)) {
        throw new Error(`adjacent equal intervals not merged: [${prev.start}, ${prev.end}) and [${s}, ${e})`);
      }
    }
    prev = { start: s, end: e, value: n.value, affinity: n.affinity };
    counted++;
    const right = rec(n.right, a);
    const height = 1 + Math.max(left.height, right.height);
    const size = 1 + left.size + right.size;
    if (height !== n.height) throw new Error(`height mismatch at [${s}, ${e})`);
    if (size !== n.size) throw new Error(`size mismatch at [${s}, ${e})`);
    if (Math.abs(left.height - right.height) > 1) throw new Error(`AVL balance violated at [${s}, ${e})`);
    return { height, size };
  };
  rec(map.root, 0);
  if (counted !== map.size) throw new Error(`map.size (${map.size}) != counted nodes (${counted})`);
}
