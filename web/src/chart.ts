/**
 * DBC 信号曲线渲染器（统一坐标系）：
 * - 所有序列共用同一绘图区与共享底部相对时间轴（如 -30s … 0s），窗口右端对齐最新样本；
 * - 纵轴刻度跟随“选中序列”：点击绘图区内的曲线（吸附阈值内最近者）或图例行切换，
 *   其余序列仍画在同一坐标系里，超出值域的部分被裁剪在绘图区内，
 *   不会压到左侧刻度与底部时间标注；选中曲线最后绘制且略粗；
 * - 光标在绘图区内移动/按下时吸附到最近的真实采样点：画竖向参考线与点标记，
 *   并在光标旁给出“名称 / 相对时间 / 数值”提示框（贴边自动翻转，始终留在画布内）；
 *   光标远离所有曲线时不画任何光标元素；
 * - 纵轴刻度用 1/2/2.5/5 × 10^k 的好读步长取约 4 档；值域只按当前窗口内样本计算：
 *   恒定/近恒定序列给对称余量、正常序列给 12% 余量；选中序列在窗口内无样本时
 *   纵轴与曲线整体给占位说明，不做无意义的映射；
 * - 每像素列做 min/max 抽稀，超长样本数组不拖慢绘制；
 * - 网格/文字颜色经 getComputedStyle 读取 app.css 的 --ef-* 变量，深/浅主题自动跟随；
 *   序列外观（灰阶级别 × 实线/虚线）由 seriesPalette() 从 --chart-1..3 解析后交给
 *   调用方分配，不用红绿与渐变填充。
 */
import type { ValueDomain } from './chart-math';
import {
  fmtRel,
  fmtRelExact,
  fmtTick,
  fmtVal,
  nearestIndex,
  niceTicks,
  padDomain,
  scanDomain,
  timeWindowRange,
} from './chart-math';

/** 单个采样点：t 为毫秒时间戳（升序），v 为物理值。 */
export interface ChartSample {
  t: number;
  v: number;
}

/** 一条曲线：label/unit 用于图例与光标提示；samples 可能很长，窗口外自动忽略。 */
export interface ChartSeries {
  key: string;
  label: string;
  unit: string;
  color: string;
  /** 虚线节拍（空数组=实线）；同色级的序列靠它区分。 */
  dash?: readonly number[];
  samples: readonly ChartSample[];
}

/** 曲线外观：色级 + 线型。色级来自 CSS 变量 --chart-1..3（墨/灰，随主题），
 *  线型在实线 / 长虚 / 点虚之间轮换 —— 不用红绿，也不用渐变填充。 */
export interface SeriesLook {
  color: string;
  dash: readonly number[];
}

const DASH_PATTERNS: ReadonlyArray<readonly number[]> = [[], [7, 4], [2, 4]];
export const MAX_SERIES = DASH_PATTERNS.length * 3;

/** 从当前主题解析 9 组可用外观（chart.ts 与 signal-session.ts 共用）。 */
export function seriesPalette(): SeriesLook[] {
  const cs = getComputedStyle(document.documentElement);
  const tones = [1, 2, 3].map(
    (i) => cs.getPropertyValue('--chart-' + i).trim() || '#161616'
  );
  const looks: SeriesLook[] = [];
  for (const dash of DASH_PATTERNS) {
    for (const color of tones) looks.push({ color, dash });
  }
  return looks;
}

/** 主题相关的颜色与字体（来自 app.css 的 --ef-* 变量；缺省值用于无样式环境）。 */
interface Theme {
  faint: string;
  mid: string;
  grid: string;
  border: string;
  paper: string;
  mono: string;
  ui: string;
}

/** 每像素列的聚合：首/末样本 + 最小/最大样本（min/max 抽稀）。 */
interface Column {
  tF: number;
  vF: number;
  tL: number;
  vL: number;
  tLo: number;
  vLo: number;
  tHi: number;
  vHi: number;
}

/** 一次绘制的几何与映射：共享 X 轴 + 选中序列的纵轴。 */
interface Layout {
  plotL: number;
  plotR: number;
  plotTop: number;
  axisY: number;
  tLeft: number;
  tRight: number;
  active: ChartSeries;
  domain: ValueDomain;
  xOf: (t: number) => number;
  yOf: (v: number) => number;
}

/** 光标吸附命中：series 为命中序列，x/y 为采样点的屏幕坐标。 */
interface SnapHit {
  series: ChartSeries;
  t: number;
  v: number;
  x: number;
  y: number;
}

const TICK_STEPS_MS: readonly number[] = [
  1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 1800000,
];
const AXIS_H = 22; // 底部时间轴高度（CSS 像素）
const GUTTER = 58; // 左侧数值刻度留白
const PAD_R = 10; // 右侧留白
const PAD_T = 4; // 顶部留白（曲线不贴画布上缘）
const SNAP_PX = 24; // 光标吸附与点选半径（CSS 像素）：命中即吸附/选中
const Y_TICK_TARGET = 4; // 纵轴期望刻度档数（按步长取整后实际 3~6 档）
const LINE_W = 1.5; // 非选中曲线线宽
const LINE_W_ACTIVE = 2.25; // 选中曲线线宽（略粗以区分）

export class SignalChart {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly ro: ResizeObserver | null;
  private raf = 0;
  private cssW = 0;
  private cssH = 0;
  private series: readonly ChartSeries[] = [];
  private windowMs = 30000;
  private selectedKey: string | null = null;
  private selectHandler: ((key: string | null) => void) | null = null;
  /** 最近一次光标位置（画布内 CSS 像素）；null = 无光标（离开/取消）。 */
  private cursor: { x: number; y: number } | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('无法创建 2D 绘图上下文');
    this.ctx = ctx;
    this.ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.schedule());
    if (this.ro !== null) this.ro.observe(canvas);
    this.bindPointer();
    this.schedule();
  }

  /** 用最新数据整体重绘（内部合并到 rAF）。 */
  update(series: readonly ChartSeries[], windowMs: number): void {
    this.series = series;
    if (windowMs > 0) this.windowMs = windowMs;
    this.ensureSelection();
    this.schedule();
  }

  setWindowMs(windowMs: number): void {
    if (windowMs <= 0 || windowMs === this.windowMs) return;
    this.windowMs = windowMs;
    this.schedule();
  }

  /** 立即重绘（取消挂起的 rAF，避免同一帧重复绘制）。 */
  render(): void {
    this.cancelFrame();
    this.draw();
  }

  destroy(): void {
    this.cancelFrame();
    if (this.ro !== null) this.ro.disconnect();
  }

  /** 当前选中序列 key（无序列时为 null）。 */
  activeKey(): string | null {
    return this.selectedKey;
  }

  /** 选中指定序列（图例行与曲线点击共用）；key 不存在时忽略。 */
  select(key: string): void {
    if (key === this.selectedKey) return;
    if (!this.series.some((s) => s.key === key)) return;
    this.selectedKey = key;
    this.notifySelect();
    this.schedule();
  }

  /** 注册选中变化回调（图例需要据此刷新 aria-pressed 与视觉态）。 */
  setOnSelectChange(handler: (key: string | null) => void): void {
    this.selectHandler = handler;
  }

  /* ---------- 内部：指针与选中 ---------- */

  private bindPointer(): void {
    this.canvas.addEventListener('pointermove', (e) => {
      this.cursor = this.localPoint(e);
      this.schedule();
    });
    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.cursor = this.localPoint(e);
      /* 先按当前位置重绘（画上参考线），再决定是否切换选中序列 */
      this.render();
      const hit = this.computeSnap();
      if (hit !== null) this.select(hit.series.key);
    });
    const clear = (): void => {
      this.cursor = null;
      this.schedule();
    };
    this.canvas.addEventListener('pointerleave', clear);
    this.canvas.addEventListener('pointercancel', clear);
  }

  private localPoint(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /** 选中序列失效（被移除/清空）时回落到序列表首个；变化时通知外部。 */
  private ensureSelection(): void {
    if (this.selectedKey !== null && this.series.some((s) => s.key === this.selectedKey)) {
      return;
    }
    const next = this.series.length > 0 ? this.series[0].key : null;
    if (next === this.selectedKey) return;
    this.selectedKey = next;
    this.notifySelect();
  }

  private notifySelect(): void {
    const cb = this.selectHandler;
    if (cb !== null) cb(this.selectedKey);
  }

  /* ---------- 内部：帧调度与几何 ---------- */

  private cancelFrame(): void {
    if (this.raf !== 0) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private schedule(): void {
    if (this.raf !== 0) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private theme(): Theme {
    const cs = getComputedStyle(this.canvas);
    const pick = (name: string, fb: string): string => {
      const raw = cs.getPropertyValue(name).trim();
      return raw !== '' ? raw : fb;
    };
    return {
      faint: pick('--ef-ink-2', '#5c5c5c'),
      mid: pick('--ef-ink-2', '#5c5c5c'),
      grid: pick('--ef-rule', '#d9d9d6'),
      border: pick('--ef-ink', '#161616'),
      paper: pick('--ef-paper', '#f4f4f2'),
      mono: pick('--ef-font-mono', 'Menlo, Consolas, monospace'),
      ui: pick('--ef-font-ui', 'system-ui, sans-serif'),
    };
  }

  /** 同步 CSS 尺寸与物理像素（devicePixelRatio 适配）；不可见过小则跳过。 */
  private syncSize(): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);
    if (w < 10 || h < 10) return false;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    this.cssW = w;
    this.cssH = h;
    this.ctx.setTransform(bw / w, 0, 0, bh / h, 0, 0);
    return true;
  }

  /** 时间窗右端对齐全部序列的最新样本（共享 X 轴的锚点）。 */
  private windowEdges(): { tLeft: number; tRight: number } {
    let tRight = 0;
    for (const s of this.series) {
      const n = s.samples.length;
      if (n > 0 && s.samples[n - 1].t > tRight) tRight = s.samples[n - 1].t;
    }
    return { tLeft: tRight - this.windowMs, tRight };
  }

  private tickStepMs(): number {
    const target = this.windowMs / 6;
    for (const s of TICK_STEPS_MS) if (s >= target) return s;
    return this.windowMs;
  }

  /**
   * 推导本次绘制的几何与映射：纵轴值域来自选中序列的窗口内样本
   * （12% 余量 / 恒定对称余量）。选中序列无窗口内样本时返回 null，
   * 调用方据此展示占位说明而不是做无意义的映射。
   */
  private layout(): Layout | null {
    const plotL = GUTTER;
    const plotR = this.cssW - PAD_R;
    const plotTop = PAD_T;
    const axisY = this.cssH - AXIS_H;
    const edges = this.windowEdges();
    const active = this.series.find((s) => s.key === this.selectedKey) ?? null;
    if (active === null) return null;
    const range = timeWindowRange(active.samples, edges.tLeft, edges.tRight);
    const raw = range === null ? null : scanDomain(active.samples, range.first, range.last);
    if (raw === null) return null;
    const domain = padDomain(raw);
    const span = plotR - plotL;
    return {
      plotL,
      plotR,
      plotTop,
      axisY,
      tLeft: edges.tLeft,
      tRight: edges.tRight,
      active,
      domain,
      xOf: (t: number): number => plotL + ((t - edges.tLeft) / this.windowMs) * span,
      yOf: (v: number): number =>
        plotTop + (1 - (v - domain.lo) / (domain.hi - domain.lo)) * (axisY - plotTop),
    };
  }

  /* ---------- 内部：绘制 ---------- */

  private draw(): void {
    if (!this.syncSize()) return;
    const ctx = this.ctx;
    const th = this.theme();
    const w = this.cssW;
    const h = this.cssH;
    ctx.clearRect(0, 0, w, h);
    const list = this.series.filter((s) => s !== null && Array.isArray(s.samples));

    const axisY = h - AXIS_H;
    const plotL = GUTTER;
    const plotR = w - PAD_R;

    this.drawTimeAxis(plotL, plotR, PAD_T, axisY, th);

    if (list.length === 0) {
      this.drawEmptyGrid(plotL, plotR, PAD_T, axisY, th);
      this.drawMessage(w / 2, axisY / 2, '暂无曲线数据', '开启信号开关后，曲线将绘制在这里', th);
      return;
    }
    const g = this.layout();
    if (g === null) {
      /* 选中序列在当前窗口无样本：没有可参照的纵轴刻度，
         其余序列强行映射只会误导，整体给占位说明 */
      this.drawEmptyGrid(plotL, plotR, PAD_T, axisY, th);
      this.drawMessage(
        w / 2,
        axisY / 2,
        '选中信号在此时间窗内暂无数据',
        list.length > 1
          ? '纵轴刻度暂不可用；点击图例中的其他曲线切换'
          : '纵轴刻度暂不可用；等待该信号接收数据后自动绘制',
        th
      );
      return;
    }
    this.drawValueAxis(g, th);
    this.drawAllSeries(g, th);
    this.drawSnapOverlay(g, th);
  }

  /** 纵向时间网格 + 底部时间标注 + 轴基线。 */
  private drawTimeAxis(
    plotL: number,
    plotR: number,
    plotTop: number,
    axisY: number,
    th: Theme
  ): void {
    const ctx = this.ctx;
    const span = plotR - plotL;
    ctx.strokeStyle = th.grid;
    ctx.lineWidth = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '400 10px ' + th.mono;
    ctx.fillStyle = th.mid;
    const step = this.tickStepMs();
    for (let k = Math.floor(this.windowMs / step); k >= 0; k--) {
      const x = Math.round(plotR - (k * step * span) / this.windowMs) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, plotTop);
      ctx.lineTo(x, axisY);
      ctx.stroke();
      ctx.fillText(k === 0 ? '0' : fmtRel(-k * step), x, axisY + 15);
    }
    /* 时间轴基线 */
    ctx.strokeStyle = th.border;
    ctx.beginPath();
    ctx.moveTo(0.5, Math.round(axisY) + 0.5);
    ctx.lineTo(this.cssW - 0.5, Math.round(axisY) + 0.5);
    ctx.stroke();
  }

  /** 纵轴：横向网格 + 刻度槽文案 + 单位标注（刻度槽顶部）。 */
  private drawValueAxis(g: Layout, th: Theme): void {
    const ctx = this.ctx;
    const ticks = niceTicks(g.domain.lo, g.domain.hi, Y_TICK_TARGET);
    if (ticks.length === 0) return;
    const step = ticks.length > 1 ? ticks[1] - ticks[0] : g.domain.hi - g.domain.lo;
    const unit = g.active.unit.trim();
    /* 单位标注占据刻度槽顶部一行；其下方 15px 内不放刻度文案避免叠字 */
    const labelTopMin = g.plotTop + (unit !== '' ? 15 : 3);
    ctx.strokeStyle = th.grid;
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.font = '400 9.5px ' + th.mono;
    ctx.fillStyle = th.mid;
    for (const v of ticks) {
      const y = g.yOf(v);
      if (y < g.plotTop - 0.5 || y > g.axisY + 0.5) continue;
      const yc = Math.round(y) + 0.5;
      ctx.beginPath();
      ctx.moveTo(g.plotL, yc);
      ctx.lineTo(g.plotR, yc);
      ctx.stroke();
      /* 底部 7px 内不放文案：避免压到时间轴基线 */
      if (yc >= labelTopMin && yc <= g.axisY - 7) {
        ctx.fillText(fmtTick(v, step), g.plotL - 6, y);
      }
    }
    if (unit !== '') {
      ctx.font = '600 9.5px ' + th.ui;
      ctx.fillStyle = th.faint;
      ctx.fillText(unit, g.plotL - 6, g.plotTop + 6);
    }
  }

  private drawEmptyGrid(
    plotL: number,
    plotR: number,
    plotTop: number,
    axisY: number,
    th: Theme
  ): void {
    const ctx = this.ctx;
    ctx.strokeStyle = th.grid;
    for (const f of [0.25, 0.5, 0.75]) {
      const y = Math.round(plotTop + f * (axisY - plotTop)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(plotL, y);
      ctx.lineTo(plotR, y);
      ctx.stroke();
    }
  }

  private drawMessage(cx: number, cy: number, main: string, sub: string, th: Theme): void {
    const ctx = this.ctx;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = th.mid;
    ctx.font = '600 12.5px ' + th.ui;
    ctx.fillText(main, cx, cy - 3);
    ctx.fillStyle = th.faint;
    ctx.font = '400 11px ' + th.ui;
    ctx.fillText(sub, cx, cy + 14);
  }

  /** 全部序列画进同一坐标系；裁剪到绘图区（绝不压刻度与时间标注），选中者最后且略粗。 */
  private drawAllSeries(g: Layout, th: Theme): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(g.plotL, g.plotTop - 2, g.plotR - g.plotL, g.axisY - g.plotTop + 4);
    ctx.clip();
    for (const s of this.series) {
      if (s.key === g.active.key) continue;
      this.drawSeries(s, g, LINE_W);
    }
    this.drawSeries(g.active, g, LINE_W_ACTIVE);
    ctx.restore();
  }

  private drawSeries(s: ChartSeries, g: Layout, lineWidth: number): void {
    const ctx = this.ctx;
    const samples = s.samples;
    const range = timeWindowRange(samples, g.tLeft, g.tRight);
    if (range === null) return;

    /* 每像素列 min/max 抽稀 */
    const cols: Column[] = [];
    let lastX = -1;
    for (let j = range.first; j <= range.last; j++) {
      const smp = samples[j];
      if (!Number.isFinite(smp.v)) continue;
      const x = Math.min(g.plotR - 1, Math.max(g.plotL, Math.round(g.xOf(smp.t))));
      const c = cols.length > 0 && x === lastX ? cols[cols.length - 1] : null;
      if (c === null) {
        cols.push({ tF: smp.t, vF: smp.v, tL: smp.t, vL: smp.v, tLo: smp.t, vLo: smp.v, tHi: smp.t, vHi: smp.v });
        lastX = x;
      } else {
        c.tL = smp.t;
        c.vL = smp.v;
        if (smp.v < c.vLo) {
          c.tLo = smp.t;
          c.vLo = smp.v;
        }
        if (smp.v > c.vHi) {
          c.tHi = smp.t;
          c.vHi = smp.v;
        }
      }
    }
    if (cols.length === 0) return;

    /* 面积渐变填充已按视觉规范移除：只保留灰阶线 + 虚线区分 */
    ctx.strokeStyle = s.color;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash(s.dash ?? []);
    ctx.beginPath();
    this.pathColumns(cols, g.xOf, g.yOf);
    ctx.stroke();
    ctx.setLineDash([]);
    if (cols.length === 1) {
      /* 单点：零长线段不可见，画实心圆点 */
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(g.xOf(cols[0].tF), g.yOf(cols[0].vF), lineWidth >= 2 ? 3 : 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** 依时间顺序把抽稀列连成折线路径（每列至多首/末/最小/最大 4 点）。 */
  private pathColumns(
    cols: readonly Column[],
    xOf: (t: number) => number,
    yOf: (v: number) => number
  ): void {
    const ctx = this.ctx;
    const pts: Array<[number, number]> = [];
    let started = false;
    for (const c of cols) {
      pts.length = 0;
      pts.push([c.tF, c.vF], [c.tLo, c.vLo], [c.tHi, c.vHi], [c.tL, c.vL]);
      pts.sort((a, b) => a[0] - b[0]);
      let prevT = Number.NaN;
      for (const p of pts) {
        if (p[0] === prevT) continue;
        prevT = p[0];
        const x = xOf(p[0]);
        const y = yOf(p[1]);
        if (started) ctx.lineTo(x, y);
        else {
          ctx.moveTo(x, y);
          started = true;
        }
      }
    }
  }

  /* ---------- 内部：光标吸附 ---------- */

  /** 完整重算吸附命中（指针按下等事件路径用；绘制路径复用已算好的 layout）。 */
  private computeSnap(): SnapHit | null {
    if (!this.syncSize()) return null;
    return this.hitFrom(this.layout());
  }

  /**
   * 光标吸附：每个序列先按时间二分找最近采样，再取其相邻两点，
   * 在屏幕距离意义下选全局最近者；距离超过 SNAP_PX 视为“不在曲线上”。
   * 所有序列的屏幕 y 都用选中序列的纵轴映射（它们本来就这么画）。
   */
  private hitFrom(g: Layout | null): SnapHit | null {
    if (g === null) return null;
    const cur = this.cursor;
    if (cur === null) return null;
    if (cur.x < g.plotL || cur.x > g.plotR || cur.y < g.plotTop || cur.y > g.axisY) {
      return null;
    }
    const cursorT = g.tLeft + ((cur.x - g.plotL) / (g.plotR - g.plotL)) * this.windowMs;
    let best: SnapHit | null = null;
    let bestDist = SNAP_PX;
    for (const s of this.series) {
      const n = s.samples.length;
      if (n === 0) continue;
      const i = nearestIndex(s.samples, cursorT);
      for (let j = i - 1; j <= i + 1; j++) {
        if (j < 0 || j >= n) continue;
        const smp = s.samples[j];
        if (!Number.isFinite(smp.v) || smp.t < g.tLeft || smp.t > g.tRight) continue;
        const x = g.xOf(smp.t);
        const y = g.yOf(smp.v);
        const dist = Math.hypot(x - cur.x, y - cur.y);
        if (dist < bestDist) {
          bestDist = dist;
          best = { series: s, t: smp.t, v: smp.v, x, y };
        }
      }
    }
    return best;
  }

  /** 参考线 + 采样点标记 + 光标旁提示框；未命中时不画任何光标元素。 */
  private drawSnapOverlay(g: Layout, th: Theme): void {
    const hit = this.hitFrom(g);
    if (hit === null) return;
    const ctx = this.ctx;
    /* 竖向参考线（点虚，与网格/曲线区分） */
    const x = Math.round(hit.x) + 0.5;
    ctx.strokeStyle = th.mid;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, g.plotTop);
    ctx.lineTo(x, g.axisY);
    ctx.stroke();
    ctx.setLineDash([]);
    /* 采样点标记：曲线色实心 + 纸色描边圈，压在曲线上仍然醒目 */
    ctx.beginPath();
    ctx.arc(hit.x, hit.y, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = hit.series.color;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = th.paper;
    ctx.stroke();
    this.drawTip(hit, g, th);
  }

  /** 光标旁的紧凑提示框：名称 + 相对时间 + 数值单位；贴边翻转且始终留在画布内。 */
  private drawTip(hit: SnapHit, g: Layout, th: Theme): void {
    const ctx = this.ctx;
    const w = this.cssW;
    const h = this.cssH;
    const unit = hit.series.unit.trim();
    const valTxt = fmtVal(hit.v) + (unit !== '' ? ' ' + unit : '');
    const timeTxt = fmtRelExact(hit.t - g.tRight);
    const nameFont = '600 11px ' + th.ui;
    const valFont = '400 10.5px ' + th.mono;
    const SWATCH = 12; // 名称行前的曲线色标宽度
    const PAD_X = 7;
    const PAD_Y = 5;
    const LINE_H = 15;
    ctx.font = nameFont;
    const nameW = ctx.measureText(hit.series.label).width;
    ctx.font = valFont;
    const valW = ctx.measureText(timeTxt + ' · ' + valTxt).width;
    const boxW = Math.max(SWATCH + 5 + nameW, valW) + PAD_X * 2;
    const boxH = PAD_Y * 2 + LINE_H * 2 - 1;
    /* 先按“右上优先”放置，越界则左右/上下翻转，最后整体夹回画布 */
    let bx = hit.x + 14;
    if (bx + boxW > w - 4) bx = hit.x - 14 - boxW;
    let by = hit.y - 12 - boxH;
    if (by < 4) by = hit.y + 14;
    bx = Math.min(Math.max(4, bx), Math.max(4, w - 4 - boxW));
    by = Math.min(Math.max(4, by), Math.max(4, h - 4 - boxH));
    /* 纸面 + 1px 墨线描边：直角、无投影、无发光（端风格） */
    ctx.fillStyle = th.paper;
    ctx.fillRect(bx, by, boxW, boxH);
    ctx.strokeStyle = th.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(bx + 0.5, by + 0.5, boxW - 1, boxH - 1);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const nameY = by + PAD_Y + 9;
    ctx.fillStyle = hit.series.color;
    ctx.fillRect(bx + PAD_X, nameY - 4, SWATCH, 2);
    ctx.fillStyle = th.border;
    ctx.font = nameFont;
    ctx.fillText(hit.series.label, bx + PAD_X + SWATCH + 5, nameY);
    ctx.fillStyle = th.mid;
    ctx.font = valFont;
    ctx.fillText(timeTxt + ' · ' + valTxt, bx + PAD_X, nameY + LINE_H);
  }
}
