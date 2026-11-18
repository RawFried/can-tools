/**
 * chart-math 纯函数测试：零依赖断言（失败即 throw），由 esbuild 打包后 node 运行。
 * 覆盖纵轴“好读刻度”、值域留白（恒定/近恒定/正常）、时间窗索引、
 * 最近采样二分与刻度/光标文案格式化。
 */
import {
  fmtRelExact,
  fmtTick,
  nearestIndex,
  niceTicks,
  padDomain,
  scanDomain,
  timeWindowRange,
} from '../src/chart-math';
import type { TimePoint } from '../src/chart-math';

let passed = 0;

function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log('  ✓ ' + name);
}

function eq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(label + '：期望 ' + String(expected) + '，实际 ' + String(actual));
  }
}

function near(actual: number, expected: number, label: string): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > 1e-9) {
    throw new Error(label + '：期望 ' + expected + '，实际 ' + String(actual));
  }
}

function pts(...tv: Array<[number, number]>): TimePoint[] {
  return tv.map(([t, v]) => ({ t, v }));
}

/* ---------- niceTicks ---------- */

test('niceTicks 整数跨度取 25 的倍数', () => {
  const ticks = niceTicks(0, 100, 4);
  eq(ticks.join(','), '0,25,50,75,100', '0..100');
});

test('niceTicks 从 lo 向上对齐到步长整数倍', () => {
  const ticks = niceTicks(-12, 112, 4);
  eq(ticks.join(','), '0,50,100', '-12..112（12% 留白后的典型形状）');
});

test('niceTicks 对称小值域取 0.5 步长', () => {
  const ticks = niceTicks(-1, 1, 4);
  eq(ticks.join(','), '-1,-0.5,0,0.5,1', '-1..1');
});

test('niceTicks 跨度是 4 的倍数时 2.5 步长可整除', () => {
  const ticks = niceTicks(0, 10, 4);
  eq(ticks.join(','), '0,2.5,5,7.5,10', '0..10');
});

test('niceTicks 原始步长 ≤1.5 归一到 1（约 330px 绘区不至过疏）', () => {
  const ticks = niceTicks(18.02, 23.98, 4);
  eq(ticks.join(','), '19,20,21,22,23', '18.02..23.98（12% 留白后的 18..24 形状）');
});

test('niceTicks 非正值域与畸形输入', () => {
  eq(niceTicks(5, 5, 4).length, 0, '零跨度');
  eq(niceTicks(Number.NaN, 1, 4).length, 0, 'NaN');
});

test('niceTicks 步长永远包含端点内整档（浮点 epsilon）', () => {
  const ticks = niceTicks(0.1, 0.9, 4);
  eq(ticks.join(','), '0.2,0.4,0.6,0.8', '0.1..0.9');
});

/* ---------- padDomain ---------- */

test('padDomain 正常值域上下各留 12%', () => {
  const d = padDomain({ lo: 0, hi: 100 });
  near(d.lo, -12, 'lo');
  near(d.hi, 112, 'hi');
});

test('padDomain 恒定值给 |中值| 5%（至少 1）的对称余量', () => {
  const d = padDomain({ lo: 952, hi: 952 });
  near(d.lo, 952 - 47.6, 'lo');
  near(d.hi, 952 + 47.6, 'hi');
  eq(d.hi > d.lo, true, '可区分');
});

test('padDomain 近恒定（刻度文案相同）也按恒定处理', () => {
  /* 952.0 与 952.3 都格式化为 952：实际范围无法作刻度展示 */
  const d = padDomain({ lo: 952, hi: 952.3 });
  eq(d.hi - d.lo > 2, true, '对称余量');
  near((d.lo + d.hi) / 2, 952.15, '居中');
});

test('padDomain 恒定 0 时至少给 ±1', () => {
  const d = padDomain({ lo: 0, hi: 0 });
  near(d.lo, -1, 'lo');
  near(d.hi, 1, 'hi');
});

/* ---------- scanDomain / timeWindowRange ---------- */

test('scanDomain 跳过非有限值', () => {
  const s = pts([0, 1], [1, Number.NaN], [2, Infinity], [3, -2], [4, 5]);
  const d = scanDomain(s, 0, s.length - 1);
  eq(d === null, false, '有有效值');
  near(d?.lo ?? Number.NaN, -2, 'lo');
  near(d?.hi ?? Number.NaN, 5, 'hi');
});

test('scanDomain 全非法返回 null', () => {
  eq(scanDomain(pts([0, Number.NaN], [1, Number.POSITIVE_INFINITY]), 0, 1), null, 'null');
});

test('timeWindowRange 取窗口内闭区间索引', () => {
  const s = pts([0, 0], [5, 0], [10, 0], [15, 0]);
  const r = timeWindowRange(s, 4, 14);
  eq(r === null, false, '命中');
  eq(r?.first, 1, 'first');
  eq(r?.last, 2, 'last');
  eq(timeWindowRange(s, 6, 9), null, '窗口落在采样间隙时无样本');
});

test('timeWindowRange 窗口内无样本返回 null', () => {
  eq(timeWindowRange(pts([0, 0], [5, 0]), 10, 20), null, 'null');
});

/* ---------- nearestIndex ---------- */

test('nearestIndex 命中精确时间', () => {
  eq(nearestIndex(pts([0, 0], [5, 0], [10, 0]), 5), 1, '精确');
});

test('nearestIndex 并列与居中取较近一侧（等距取较早）', () => {
  const s = pts([0, 0], [10, 0]);
  eq(nearestIndex(s, 4), 0, '偏早');
  eq(nearestIndex(s, 6), 1, '偏晚');
  eq(nearestIndex(s, 5), 0, '等距取较早');
});

test('nearestIndex 越界与空数组', () => {
  const s = pts([5, 0], [10, 0]);
  eq(nearestIndex(s, -100), 0, '早于全部');
  eq(nearestIndex(s, 100), 1, '晚于全部');
  eq(nearestIndex([], 0), -1, '空数组');
});

/* ---------- 文案格式化 ---------- */

test('fmtTick 按步长决定小数位（舍入到 0 时归一为 0）', () => {
  eq(fmtTick(25, 25), '25', '整数步');
  eq(fmtTick(2.5, 2.5), '2.5', '一位小数');
  eq(fmtTick(0.25, 0.25), '0.25', '两位小数');
  eq(fmtTick(-0.2, 0.5), '-0.2', '负值');
  eq(fmtTick(-0.4, 2), '0', '负值舍入到 0 显示 0，不显示 -0');
  eq(fmtTick(0, 0.5), '0', '零');
  eq(fmtTick(1500000, 250000), '1500k', '超大值缩写');
});

test('fmtRelExact 秒级两位小数、分钟级一位小数', () => {
  eq(fmtRelExact(0), '0.00s', '零');
  eq(fmtRelExact(-2350), '-2.35s', '秒');
  eq(fmtRelExact(-90000), '-1.5m', '分钟');
});

console.log('chart-math 测试通过：' + passed + ' 项');
