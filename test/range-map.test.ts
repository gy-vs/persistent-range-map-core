import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RangeMap,
  countSharedNodes,
  getAllocatedNodeCount,
  normalizeEdits,
  resetDebugCounters,
  validateRangeMap,
  type Affinity,
  type Edit,
  type RangeEntry,
} from '../src/range-map.js';

type E = RangeEntry<string>;
type ME = { -readonly [K in keyof E]: E[K] };

function list(map: RangeMap<string>): E[] {
  return [...map.entries()];
}

function en(start: number, end: number, value: string, affinity: Affinity): E {
  return { start, end, value, affinity };
}

// ---------------------------------------------------------------------------
// 覆盖：切分与嵌套覆盖
// ---------------------------------------------------------------------------

test('overwrite splits existing intervals and supports nesting', () => {
  const v1 = RangeMap.empty<string>().set(0, 100, 'a');
  assert.deepEqual(list(v1), [en(0, 100, 'a', 'left')]);

  // 嵌套覆盖：内部挖洞
  const v2 = v1.set(20, 50, 'b');
  assert.deepEqual(list(v2), [
    en(0, 20, 'a', 'left'),
    en(20, 50, 'b', 'left'),
    en(50, 100, 'a', 'left'),
  ]);

  // 覆盖跨多个已有区间，并与同值邻居合并
  const v3 = v2.set(40, 60, 'b');
  assert.deepEqual(list(v3), [
    en(0, 20, 'a', 'left'),
    en(20, 60, 'b', 'left'),
    en(60, 100, 'a', 'left'),
  ]);

  // 覆盖把整段统一回 'a'：三段全部合并为一段
  const v4 = v3.set(10, 70, 'a');
  assert.deepEqual(list(v4), [en(0, 100, 'a', 'left')]);
  assert.equal(v4.size, 1);

  for (const v of [v1, v2, v3, v4]) validateRangeMap(v);
});

test('overwrite exact boundaries and spanning many intervals', () => {
  let m = RangeMap.empty<string>();
  m = m.set(0, 10, 'a').set(10, 20, 'b').set(20, 30, 'c');
  // 精确覆盖中段
  const m2 = m.set(10, 20, 'x');
  assert.deepEqual(list(m2), [en(0, 10, 'a', 'left'), en(10, 20, 'x', 'left'), en(20, 30, 'c', 'left')]);
  // 横跨三段的覆盖
  const m3 = m.set(5, 25, 'y');
  assert.deepEqual(list(m3), [en(0, 5, 'a', 'left'), en(5, 25, 'y', 'left'), en(25, 30, 'c', 'left')]);
  validateRangeMap(m2);
  validateRangeMap(m3);
});

// ---------------------------------------------------------------------------
// 相邻合并
// ---------------------------------------------------------------------------

test('adjacent equal-value intervals merge; different affinity does not', () => {
  const v1 = RangeMap.empty<string>().set(0, 10, 'a').set(10, 20, 'a');
  assert.deepEqual(list(v1), [en(0, 20, 'a', 'left')]);

  // 桥接两个已有的同值区间
  const v2 = RangeMap.empty<string>().set(0, 10, 'a').set(20, 30, 'a').set(10, 20, 'a');
  assert.deepEqual(list(v2), [en(0, 30, 'a', 'left')]);

  // affinity 不同则不合并
  const v3 = RangeMap.empty<string>().set(0, 10, 'a', 'left').set(10, 20, 'a', 'right');
  assert.deepEqual(list(v3), [en(0, 10, 'a', 'left'), en(10, 20, 'a', 'right')]);

  // 值不同不合并
  const v4 = RangeMap.empty<string>().set(0, 10, 'a').set(10, 20, 'b');
  assert.equal(v4.size, 2);

  for (const v of [v1, v2, v3, v4]) validateRangeMap(v);
});

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

test('delete cuts intervals, removes coverage, no-op returns same version', () => {
  const v1 = RangeMap.empty<string>().set(0, 100, 'a');
  const v2 = v1.delete(30, 60);
  assert.deepEqual(list(v2), [en(0, 30, 'a', 'left'), en(60, 100, 'a', 'left')]);

  // 删除覆盖整个区间
  const v3 = v2.delete(0, 100);
  assert.equal(v3.size, 0);
  assert.deepEqual(list(v3), []);

  // 空范围删除 / 无交集删除：返回同一对象（无新版本）
  assert.equal(v2.delete(40, 40), v2);
  assert.equal(v2.delete(30, 60), v2);
  assert.equal(v2.delete(200, 300), v2);

  validateRangeMap(v2);
  validateRangeMap(v3);
});

// ---------------------------------------------------------------------------
// 空区间
// ---------------------------------------------------------------------------

test('empty intervals are no-ops and collapsed results are dropped', () => {
  const v1 = RangeMap.empty<string>();
  assert.equal(v1.set(5, 5, 'a'), v1); // 空区间 set 是无操作
  assert.equal(v1.size, 0);

  const v2 = v1.set(0, 10, 'a');
  assert.equal(v2.delete(4, 4), v2);

  // 区间完全落入被替换区域 → 折叠丢弃；[10,20) 整体平移 3-8=-5
  const v3 = RangeMap.empty<string>().set(2, 5, 'x').set(10, 20, 'y');
  const v4 = v3.applyEdits([{ start: 0, end: 8, insertLength: 3 }]);
  assert.deepEqual(list(v4), [en(5, 15, 'y', 'left')]);

  // fromEntries 拒绝空区间
  assert.throws(() => RangeMap.fromEntries([{ start: 3, end: 3, value: 'x' }]), RangeError);
  validateRangeMap(v4);
});

// ---------------------------------------------------------------------------
// 历史版本隔离
// ---------------------------------------------------------------------------

test('historical versions remain readable and unchanged', () => {
  const v1 = RangeMap.empty<string>().set(0, 10, 'a');
  const v2 = v1.set(5, 15, 'b');
  const v3 = v2.delete(8, 12);
  const v4 = v3.shift(20, 100);

  // v1 不受后续任何修改影响
  assert.deepEqual(list(v1), [en(0, 10, 'a', 'left')]);
  assert.equal(v1.get(7)?.value, 'a');
  assert.equal(v1.get(12), undefined);

  // v2 保持覆盖后的样子
  assert.deepEqual(list(v2), [en(0, 5, 'a', 'left'), en(5, 15, 'b', 'left')]);

  // v3 保持删除后的样子
  assert.deepEqual(list(v3), [en(0, 5, 'a', 'left'), en(5, 8, 'b', 'left'), en(12, 15, 'b', 'left')]);

  // v4 是平移后的版本
  assert.deepEqual(list(v4), [en(0, 5, 'a', 'left'), en(5, 8, 'b', 'left'), en(12, 15, 'b', 'left')]);

  const v5 = v4.shift(0, 50);
  // 在 0 处插入 50：left affinity 的 [0,5) 起点不动、拉伸吞并插入文本
  assert.deepEqual(list(v5), [en(0, 55, 'a', 'left'), en(55, 58, 'b', 'left'), en(62, 65, 'b', 'left')]);
  // v4 依然不变
  assert.deepEqual(list(v4), [en(0, 5, 'a', 'left'), en(5, 8, 'b', 'left'), en(12, 15, 'b', 'left')]);

  for (const v of [v1, v2, v3, v4, v5]) validateRangeMap(v);
  assert.ok(v5.version > v4.version && v4.version > v3.version);
});

// ---------------------------------------------------------------------------
// 区间平移
// ---------------------------------------------------------------------------

test('shift translates suffix, stretches containing interval, collapses deletions', () => {
  const base = RangeMap.empty<string>().set(0, 5, 'a').set(10, 15, 'b');

  // 在间隙插入：右侧区间整体平移
  const v1 = base.shift(8, 10);
  assert.deepEqual(list(v1), [en(0, 5, 'a', 'left'), en(20, 25, 'b', 'left')]);

  // 插入点落在区间内部：区间拉伸覆盖插入文本
  const v2 = base.shift(12, 4);
  assert.deepEqual(list(v2), [en(0, 5, 'a', 'left'), en(10, 19, 'b', 'left')]);

  // 负向平移 = 删除 [at+delta, at)：落在删除区内的边界折叠
  const v3 = base.shift(12, -4); // 删除 [8, 12)
  assert.deepEqual(list(v3), [en(0, 5, 'a', 'left'), en(8, 11, 'b', 'left')]);

  // 删除覆盖整个区间：该区间消失
  const v4 = base.shift(15, -5); // 删除 [10, 15)
  assert.deepEqual(list(v4), [en(0, 5, 'a', 'left')]);

  assert.equal(base.shift(3, 0), base); // 无操作
  for (const v of [v1, v2, v3, v4]) validateRangeMap(v);
});

// ---------------------------------------------------------------------------
// 批量替换：affinity 映射、折叠、合并、平局裁决
// ---------------------------------------------------------------------------

test('applyEdits maps coordinates by affinity (original coordinates, simultaneous)', () => {
  const base = RangeMap.empty<string>()
    .set(0, 4, 'a', 'left')
    .set(6, 10, 'b', 'right')
    .set(12, 20, 'c', 'left');

  // 编辑1：把 [2,3) 替换为 5 个字符（+4）；编辑2：删除 [8,14)（-6）
  const v = base.applyEdits([
    { start: 2, end: 3, insertLength: 5 },
    { start: 8, end: 14, insertLength: 0 },
  ]);

  // a=[0,4) 内含编辑1 → 拉伸为 [0,8)
  // b=[6,10) 起点在间隙 → 10；终点 10 落入删除区，right affinity → 折叠到 12
  // c=[12,20) 起点 12 落入删除区，left affinity → 折叠到 12；终点 20 → 18
  assert.deepEqual(list(v), [
    en(0, 8, 'a', 'left'),
    en(10, 12, 'b', 'right'),
    en(12, 18, 'c', 'left'),
  ]);
  validateRangeMap(v);
});

test('applyEdits: insertion at boundaries follows affinity', () => {
  const mk = (aff: Affinity) => RangeMap.empty<string>().set(5, 10, 'x', aff);
  // 在起点处插入：left 不动（吞并插入文本），right 右移
  assert.deepEqual(list(mk('left').shift(5, 3)), [en(5, 13, 'x', 'left')]);
  assert.deepEqual(list(mk('right').shift(5, 3)), [en(8, 13, 'x', 'right')]);

  const mk2 = (aff: Affinity) => RangeMap.empty<string>().set(0, 5, 'x', aff);
  // 在终点处插入：left 不动，right 延伸吞并插入文本
  assert.deepEqual(list(mk2('left').shift(5, 3)), [en(0, 5, 'x', 'left')]);
  assert.deepEqual(list(mk2('right').shift(5, 3)), [en(0, 8, 'x', 'right')]);
});

test('applyEdits: adjacent edits merge; deleted separator merges equal values', () => {
  // 两个 'x' 区间被 'y' 隔开，删除 'y' 后相邻 → 合并
  const base = RangeMap.empty<string>()
    .set(0, 3, 'x', 'left')
    .set(3, 7, 'y', 'left')
    .set(7, 10, 'x', 'left');
  const v = base.applyEdits([{ start: 3, end: 7, insertLength: 0 }]);
  assert.deepEqual(list(v), [en(0, 6, 'x', 'left')]);
  validateRangeMap(v);
});

test('applyEdits: conflict for inserted text is resolved left-wins', () => {
  // 左区间 right affinity、右区间 left affinity，同时争夺在 5 处插入的 4 个字符
  const base = RangeMap.empty<string>().set(0, 5, 'L', 'right').set(5, 10, 'R', 'left');
  const v = base.applyEdits([{ start: 5, end: 5, insertLength: 4 }]);
  // 左区间优先：L 延伸到 9，R 被钳到 [9, 14)
  assert.deepEqual(list(v), [en(0, 9, 'L', 'right'), en(9, 14, 'R', 'left')]);
  validateRangeMap(v);
});

test('applyEdits: adjacent edits are merged before mapping', () => {
  // 删除 [3,7) 并在 7 处插入 5 个字符（相邻编辑 → 合并为替换 [3,7)→5）
  const base = RangeMap.empty<string>().set(0, 7, 'a', 'right').set(7, 12, 'b', 'left');
  const v = base.applyEdits([
    { start: 3, end: 7, insertLength: 0 },
    { start: 7, end: 7, insertLength: 5 },
  ]);
  // 等价于把 [3,7) 替换为 5：a 的终点 7（right）→ 8；b 的起点 7（left）→ 3，
  // 但 a 已声称 [3,8) 这段插入文本 → 左区间优先，b 被钳到 [8,13)
  assert.deepEqual(list(v), [en(0, 8, 'a', 'right'), en(8, 13, 'b', 'left')]);
  validateRangeMap(v);
});

test('applyEdits validates input', () => {
  const m = RangeMap.empty<string>().set(0, 10, 'a');
  assert.throws(() => m.applyEdits([{ start: 5, end: 2, insertLength: 0 }]), RangeError);
  assert.throws(() => m.applyEdits([{ start: 0, end: 3, insertLength: -1 }]), RangeError);
  assert.throws(
    () =>
      m.applyEdits([
        { start: 0, end: 4, insertLength: 1 },
        { start: 3, end: 6, insertLength: 1 },
      ]),
    RangeError,
  );
  // 无操作编辑 → 同一版本
  assert.equal(m.applyEdits([{ start: 2, end: 2, insertLength: 0 }]), m);
  assert.equal(m.applyEdits([]), m);
});

// ---------------------------------------------------------------------------
// 朴素参考模型（规范的直接实现，用于对照）
// ---------------------------------------------------------------------------

class NaiveModel {
  entries: ME[] = [];

  private cutAt(b: number): void {
    const i = this.entries.findIndex((x) => x.start < b && b < x.end);
    if (i >= 0) {
      const x = this.entries[i];
      this.entries.splice(
        i,
        1,
        { start: x.start, end: b, value: x.value, affinity: x.affinity },
        { start: b, end: x.end, value: x.value, affinity: x.affinity },
      );
    }
  }

  private mergeAdjacent(): void {
    const out: ME[] = [];
    for (const x of this.entries) {
      const last = out[out.length - 1];
      if (last && last.end === x.start && last.value === x.value && last.affinity === x.affinity) {
        last.end = x.end;
      } else {
        out.push({ ...x });
      }
    }
    this.entries = out;
  }

  set(s: number, e: number, v: string, aff: Affinity): void {
    if (s === e) return;
    this.cutAt(s);
    this.cutAt(e);
    this.entries = this.entries.filter((x) => x.end <= s || x.start >= e);
    // 保持按 start 升序：二分找插入点，避免全量排序
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.entries[mid].start < s) lo = mid + 1;
      else hi = mid;
    }
    this.entries.splice(lo, 0, { start: s, end: e, value: v, affinity: aff });
    this.mergeAdjacent();
  }

  delete(s: number, e: number): void {
    if (s === e) return;
    this.cutAt(s);
    this.cutAt(e);
    this.entries = this.entries.filter((x) => x.end <= s || x.start >= e);
  }

  shift(at: number, delta: number): void {
    if (delta === 0) return;
    this.applyEdits(
      delta > 0
        ? [{ start: at, end: at, insertLength: delta }]
        : [{ start: at + delta, end: at, insertLength: 0 }],
    );
  }

  applyEdits(edits: readonly Edit[]): void {
    const es = normalizeEdits(edits);
    if (es.length === 0) return;
    const cum: number[] = new Array(es.length + 1).fill(0);
    for (let i = 0; i < es.length; i++) {
      cum[i + 1] = cum[i] + es[i].insertLength - (es[i].end - es[i].start);
    }
    const mapPos = (x: number, aff: Affinity): number => {
      for (let i = 0; i < es.length; i++) {
        if (x <= es[i].end) {
          if (x < es[i].start) return x + cum[i];
          return aff === 'left' ? es[i].start + cum[i] : es[i].start + cum[i] + es[i].insertLength;
        }
      }
      return x + cum[es.length];
    };
    const mapped: ME[] = [];
    for (const x of this.entries) {
      const s = mapPos(x.start, x.affinity);
      const e = mapPos(x.end, x.affinity);
      if (s < e) mapped.push({ start: s, end: e, value: x.value, affinity: x.affinity });
    }
    // 解决重叠：左区间优先（钳制右区间起点）
    for (let i = 1; i < mapped.length; i++) {
      if (mapped[i].start < mapped[i - 1].end) {
        mapped[i] = { ...mapped[i], start: mapped[i - 1].end };
      }
    }
    this.entries = mapped.filter((x) => x.start < x.end);
    this.mergeAdjacent();
  }

  get(pos: number): E | undefined {
    return this.entries.find((x) => x.start <= pos && pos < x.end);
  }
}

// ---------------------------------------------------------------------------
// 确定性随机对照测试（fuzz vs 朴素模型）
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('fuzz: tree implementation matches naive model (set/delete/shift/applyEdits)', () => {
  for (const seed of [1, 7, 42]) {
    const rnd = mulberry32(seed);
    let map = RangeMap.empty<string>();
    const model = new NaiveModel();
    const pickAff = (): Affinity => (rnd() < 0.5 ? 'left' : 'right');
    const pickVal = (): string => ['a', 'b', 'c'][Math.floor(rnd() * 3)];

    for (let step = 0; step < 600; step++) {
      const op = rnd();
      if (op < 0.4) {
        const s = Math.floor(rnd() * 60);
        const e = rnd() < 0.05 ? s : s + 1 + Math.floor(rnd() * 12);
        const aff = pickAff();
        const v = pickVal();
        map = map.set(s, e, v, aff);
        model.set(s, e, v, aff);
      } else if (op < 0.65) {
        const s = Math.floor(rnd() * 60);
        const e = s + 1 + Math.floor(rnd() * 10);
        map = map.delete(s, e);
        model.delete(s, e);
      } else if (op < 0.8) {
        const at = Math.floor(rnd() * 65);
        const delta = Math.floor(rnd() * 21) - 10;
        map = map.shift(at, delta);
        model.shift(at, delta);
      } else {
        const nEdits = 1 + Math.floor(rnd() * 3);
        const edits: Edit[] = [];
        let pos = Math.floor(rnd() * 10);
        for (let i = 0; i < nEdits; i++) {
          const len = Math.floor(rnd() * 8);
          const ins = Math.floor(rnd() * 6);
          edits.push({ start: pos, end: pos + len, insertLength: ins });
          pos += len + 1 + Math.floor(rnd() * 8);
        }
        map = map.applyEdits(edits);
        model.applyEdits(edits);
      }

      validateRangeMap(map);
      assert.deepEqual(list(map), model.entries, `seed=${seed} step=${step}`);

      // 随机点查询对照
      for (let q = 0; q < 5; q++) {
        const pos = Math.floor(rnd() * 70);
        assert.deepEqual(map.get(pos), model.get(pos), `seed=${seed} step=${step} pos=${pos}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 结构共享：调试统计验证
// ---------------------------------------------------------------------------

function buildLarge(n: number): RangeMap<string> {
  const entries: { start: number; end: number; value: string; affinity: Affinity }[] = [];
  for (let i = 0; i < n; i++) {
    entries.push({ start: i * 10, end: i * 10 + 5, value: `v${i % 7}`, affinity: i % 2 === 0 ? 'left' : 'right' });
  }
  return RangeMap.fromEntries(entries);
}

test('structural sharing: single set copies only O(log n) nodes at 100k scale', () => {
  const base = buildLarge(100_000);
  validateRangeMap(base);
  assert.equal(base.debugInfo().nodeCount, 100_000);

  resetDebugCounters();
  const v2 = base.set(500_001, 500_004, 'new-value');
  const allocForSet = getAllocatedNodeCount();
  assert.ok(allocForSet < 2_000, `set allocated ${allocForSet} nodes (full copy would be ~100k)`);
  const shared = countSharedNodes(base, v2);
  assert.ok(shared >= 99_000, `shared ${shared} nodes with previous version`);
  assert.equal(base.size, 100_000); // 旧版本不变
  assert.equal(v2.get(500_002)?.value, 'new-value');
  assert.equal(base.get(500_002)?.value, 'v6'); // 50000 % 7 == 6
  validateRangeMap(v2);

  resetDebugCounters();
  const v3 = base.shift(500_000, 1_000);
  const allocForShift = getAllocatedNodeCount();
  assert.ok(allocForShift < 2_000, `shift allocated ${allocForShift} nodes`);
  assert.ok(countSharedNodes(base, v3) >= 99_000);
  assert.equal(v3.get(500_000 + 1_000)?.value, base.get(500_000)?.value);
  validateRangeMap(v3);

  resetDebugCounters();
  const edits: Edit[] = [];
  for (let i = 0; i < 20; i++) {
    edits.push({ start: i * 50_000 + 1_000, end: i * 50_000 + 2_000, insertLength: 300 });
  }
  const v4 = base.applyEdits(edits);
  const allocForBatch = getAllocatedNodeCount();
  assert.ok(allocForBatch < 50_000, `batch of 20 edits allocated ${allocForBatch} nodes`);
  assert.ok(countSharedNodes(base, v4) >= 80_000, 'batch edit should keep most of the tree shared');
  validateRangeMap(v4);
});

test('no-op operations return the identical version object', () => {
  const base = buildLarge(1_000);
  assert.equal(base.set(3, 3, 'x'), base);
  assert.equal(base.delete(3, 3), base);
  assert.equal(base.delete(6, 9), base); // 落在间隙里（区间是 [0,5) 等）
  assert.equal(base.shift(10, 0), base);
  assert.equal(base.applyEdits([]), base);
  assert.equal(base.applyEdits([{ start: 1, end: 1, insertLength: 0 }]), base);
});

// ---------------------------------------------------------------------------
// 十万区间规模：正确性与性能
// ---------------------------------------------------------------------------

test('scale: 100k intervals, mixed workload stays correct', () => {
  const n = 100_000;
  const base = buildLarge(n);

  // 全量平移：所有区间坐标 +delta，节点数不变
  const shifted = base.shift(0, 1_000_000);
  assert.equal(shifted.size, n);
  assert.equal(shifted.get(1_000_000)?.value, base.get(0)?.value);
  assert.equal(shifted.get(1_999_995), undefined); // 最后区间 [1999990, 1999995) 的终点是开的
  validateRangeMap(shifted);

  // 400 次随机 set/delete/shift，与朴素模型逐步对照
  // （朴素模型是 O(n)/op 的参考实现；小规模下的高强度对照见 fuzz 测试）
  const rnd = mulberry32(2026);
  let map = base;
  const model = new NaiveModel();
  model.entries = list(base);
  for (let i = 0; i < 400; i++) {
    const op = rnd();
    if (op < 0.45) {
      const s = Math.floor(rnd() * 1_000_000);
      const e = s + 1 + Math.floor(rnd() * 40);
      const v = `w${Math.floor(rnd() * 5)}`;
      const aff = rnd() < 0.5 ? 'left' : 'right';
      map = map.set(s, e, v, aff);
      model.set(s, e, v, aff);
    } else if (op < 0.8) {
      const s = Math.floor(rnd() * 1_000_000);
      const e = s + 1 + Math.floor(rnd() * 40);
      map = map.delete(s, e);
      model.delete(s, e);
    } else {
      const at = Math.floor(rnd() * 1_000_000);
      const delta = Math.floor(rnd() * 201) - 100;
      map = map.shift(at, delta);
      model.shift(at, delta);
    }
    if (i % 100 === 0) validateRangeMap(map);
  }
  validateRangeMap(map);
  assert.deepEqual(list(map), model.entries);

  // 与旧版本共享绝大多数节点
  assert.ok(countSharedNodes(base, map) > n * 0.5, 'most nodes still shared with base version');
  // 旧版本依旧可读且正确
  assert.equal(base.size, n);
  assert.equal(base.get(500_000)?.value, 'v6');
});

test('scale: sequential build via set() and bulk queries', () => {
  let m = RangeMap.empty<string>();
  const n = 50_000;
  for (let i = 0; i < n; i++) {
    m = m.set(i * 4, i * 4 + 2, `k${i % 3}`);
  }
  assert.equal(m.size, n);
  validateRangeMap(m);
  // 树高应是对数级（AVL）
  assert.ok(m.debugInfo().height <= 30, `height=${m.debugInfo().height}`);
  // 随机点查询
  const rnd = mulberry32(9);
  for (let i = 0; i < 1_000; i++) {
    const k = Math.floor(rnd() * n);
    assert.equal(m.get(k * 4)?.value, `k${k % 3}`);
    assert.equal(m.get(k * 4 + 3), undefined);
  }
  // 范围迭代
  assert.equal([...m.entriesIn(1_000, 2_000)].length, 250);
});

test('fromEntries validates input and merges adjacent equals', () => {
  assert.throws(
    () => RangeMap.fromEntries([{ start: 0, end: 10, value: 'a' }, { start: 5, end: 8, value: 'b' }]),
    RangeError,
  );
  const m = RangeMap.fromEntries<string>([
    { start: 10, end: 20, value: 'b' },
    { start: 0, end: 10, value: 'a' },
    { start: 20, end: 30, value: 'b' },
  ]);
  // 无序输入被排序；相邻同值同 affinity 合并
  assert.deepEqual(list(m), [en(0, 10, 'a', 'left'), en(10, 30, 'b', 'left')]);
  validateRangeMap(m);
});

test('custom equals and defaultAffinity options', () => {
  const m = RangeMap.empty<number>({ equals: (a, b) => a % 2 === b % 2, defaultAffinity: 'right' });
  // 1 与 3 按自定义相等判定等值 → 相邻合并；合并后取覆盖写入的新值
  const v1 = m.set(0, 5, 1).set(5, 10, 3);
  assert.deepEqual(
    [...v1.entries()].map((e) => [e.start, e.end, e.value, e.affinity]),
    [[0, 10, 3, 'right']],
  );
  // 未指定 affinity 的区间使用默认 'right'
  assert.equal(v1.get(7)?.affinity, 'right');
  validateRangeMap(v1);
});

test('debugInfo exposes version/size/nodeCount/height', () => {
  const v1 = RangeMap.empty<string>();
  const v2 = v1.set(0, 10, 'a');
  const v3 = v2.set(20, 30, 'b');
  const i2 = v2.debugInfo();
  const i3 = v3.debugInfo();
  assert.equal(i2.size, 1);
  assert.equal(i2.nodeCount, 1);
  assert.equal(i2.height, 1);
  assert.equal(i3.size, 2);
  assert.equal(i3.nodeCount, 2);
  assert.ok(i3.version > i2.version);
});
