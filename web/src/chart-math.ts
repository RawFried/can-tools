/**
 * 曲线绘制的纯计算（零 DOM / 零状态）：数值与时间格式化、纵轴“好读刻度”、
 * 窗口内值域与留白、时间窗索引与最近采样查找。
 * 从 chart.ts 拆出以便独立测试；chart.ts 依赖本模块，本模块不依赖任何应用模块
 * （样本用结构化的 {t, v} 接收，与 ChartSample 兼容）。
 */

/** 与 ChartSample 结构兼容的最小采样形状（避免反向依赖 chart.ts 的类型）。 */
export interface TimePoint {
  t: number;
  v: number;
}

/** 纵轴值域（含端点）。 */
export interface ValueDomain {
  lo: number;
  hi: number;
}

/** 数值格式化：约 3 位有效数字，万级以上用 k 缩写。 */
export function fmtVal(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 100000) return (v / 1000).toFixed(0) + 'k';
  if (a >= 10000) return (v / 1000).toFixed(1) + 'k';
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.01) return v.toFixed(3);
  return a === 0 ? '0' : v.toExponential(1);
}

/** 相对时间刻度文案：-30s / -5m / 0。 */
export function fmtRel(ms: number): string {
  if (ms === 0) return '0';
  const sec = Math.round(Math.abs(ms) / 1000);
  const txt = sec >= 60 && sec % 60 === 0 ? sec / 60 + 'm' : sec + 's';
  return '-' + txt;
}

/** 光标提示用的时间文案：60s 内保留两位小数，更长则一位小数的分钟。 */
export function fmtRelExact(ms: number): string {
  const sec = ms / 1000;
  if (Math.abs(sec) < 60) return sec.toFixed(2) + 's';
  return (sec / 60).toFixed(1) + 'm';
}

/**
 * 在 [lo, hi] 内生成约 target 档的等距“好读”刻度：
 * 步长取 1/2/2.5/5 × 10^k（2.5 保证跨度是 4 的倍数时也能整除），
 * 刻度从 lo 向上取整到步长整数倍开始；端点判定用 epsilon、
 * 刻度值再按 10 位小数量化，避免 0.2*3 之类的浮点尘埃进入后续计算。
 * 阈值在中点取整：原始步长 ≤1.5 归一到 1（否则 18..24 这类跨度只剩
 * 两三条网格线，对常见绘区高度过于稀疏）。
 */
export function niceTicks(lo: number, hi: number, target: number): number[] {
  const span = hi - lo;
  if (!(span > 0) || !Number.isFinite(span)) return [];
  const raw = span / Math.max(2, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const mul = norm <= 1.5 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  const step = mul * mag;
  const out: number[] = [];
  const first = Number((Math.ceil(lo / step - 1e-9) * step).toFixed(10));
  for (let k = 0; out.length <= 12; k++) {
    const v = Number((first + k * step).toFixed(10));
    if (v > hi + step * 1e-9) break;
    out.push(v);
  }
  return out;
}

/** 刻度文案的小数位：由步长决定（2.5 → 1 位、0.25 → 2 位），上限 6 位。 */
export function tickDecimals(step: number): number {
  let d = 0;
  let s = Math.abs(step);
  while (d < 6 && Math.abs(Math.round(s) - s) > 1e-9 * Math.max(1, s)) {
    s *= 10;
    d++;
  }
  return d;
}

/** 纵轴刻度文案：按步长小数位定点输出；舍入到 0 时归一为 '0'（不显示 '-0'），
 *  超大值交给 fmtVal 缩写。 */
export function fmtTick(v: number, step: number): string {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1000000) return fmtVal(v);
  const txt = v.toFixed(tickDecimals(step));
  return Number(txt) === 0 ? '0' : txt;
}

/** 窗口样本闭区间 [first, last] 内有限值的最小/最大；无有效值返回 null。 */
export function scanDomain(
  samples: readonly TimePoint[],
  first: number,
  last: number
): ValueDomain | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = Math.max(0, first); i <= last && i < samples.length; i++) {
    const v = samples[i].v;
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo <= hi ? { lo, hi } : null;
}

/**
 * 值域留白：
 * - 恒定/近恒定（上下刻度格式化后相同，涵盖 range === 0 与大数值下的微小抖动）
 *   按 |中值| 的 5%（至少 1）给对称余量，曲线居中、上下刻度可区分；
 * - 正常序列上下各给 12%，波峰不贴绘图区边缘。
 */
export function padDomain(d: ValueDomain): ValueDomain {
  if (fmtVal(d.hi) === fmtVal(d.lo)) {
    const mid = (d.hi + d.lo) / 2;
    const r = Math.max(Math.abs(mid) * 0.05, 1);
    return { lo: mid - r, hi: mid + r };
  }
  const pad = (d.hi - d.lo) * 0.12;
  return { lo: d.lo - pad, hi: d.hi + pad };
}

/** 时间升序样本落在 [tLeft, tRight] 的闭区间索引；窗口内无样本返回 null。 */
export function timeWindowRange(
  samples: readonly TimePoint[],
  tLeft: number,
  tRight: number
): { first: number; last: number } | null {
  let first = -1;
  let last = -1;
  for (let i = 0; i < samples.length; i++) {
    const t = samples[i].t;
    if (t < tLeft) continue;
    if (t > tRight) break;
    if (first < 0) first = i;
    last = i;
  }
  return first >= 0 ? { first, last } : null;
}

/**
 * 时间升序样本中与 t 最近的样本索引（并列取较早者）；空数组返回 -1。
 * 二分只保证命中首个 t' >= t，再与前一个比较距离。
 */
export function nearestIndex(samples: readonly TimePoint[], t: number): number {
  let lo = 0;
  let hi = samples.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && samples[lo].t - t >= t - samples[lo - 1].t) return lo - 1;
  return lo;
}

/**
 * 任意时刻 t 的曲线读数：t 落在样本时间范围内时，在相邻两点间线性插值，
 * 恰好命中采样点则直接返回该点；范围外或最近点值非法时返回 null。
 * 用于“同一 X 刻度读取全部曲线”的提示框，与折线绘制保持一致。
 */
export function valueAt(samples: readonly TimePoint[], t: number): number | null {
  const n = samples.length;
  if (n === 0 || !Number.isFinite(t)) return null;
  if (t < samples[0].t || t > samples[n - 1].t) return null;
  const i = nearestIndex(samples, t);
  if (i < 0) return null;
  const hit = samples[i];
  if (!Number.isFinite(hit.v)) return null;
  if (hit.t === t) return hit.v;
  const j = hit.t < t ? i + 1 : i - 1;
  if (j < 0 || j >= n) return hit.v;
  const a = hit.t < t ? hit : samples[j];
  const b = hit.t < t ? samples[j] : hit;
  if (!Number.isFinite(a.v) || !Number.isFinite(b.v) || b.t === a.t) return hit.v;
  const f = (t - a.t) / (b.t - a.t);
  return a.v + (b.v - a.v) * f;
}
