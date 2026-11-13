/**
 * DBC 信号曲线渲染器（小多图）：
 * - 每个序列一条横带，Y 轴各自自适应（信号单位可能不同，禁止共用 Y 轴）；
 *   窗口内恒定值（上下刻度格式化后相同）按 |中值| 的 5%（至少 1）给对称余量，
 *   曲线居中、上下刻度可区分；正常序列给 12% 余量防波峰压到标注条；
 * - 共享底部相对时间轴（如 -30s … 0s），窗口右端对齐最新样本；
 * - 每像素列做 min/max 抽稀，超长样本数组不拖慢绘制；
 * - 网格/文字颜色经 getComputedStyle 读取 app.css 自定义属性，
 *   深色/浅色主题自动跟随；序列颜色由调用方从 SERIES_COLORS 分配。
 */

/** 单个采样点：t 为毫秒时间戳（升序），v 为物理值。 */
export interface ChartSample {
  t: number;
  v: number;
}

/** 一条曲线：label/unit 用于横带标注；samples 可能很长，窗口外自动忽略。 */
export interface ChartSeries {
  key: string;
  label: string;
  unit: string;
  color: string;
  samples: readonly ChartSample[];
}

/** 固定 8 色调色板（深空底与冷白底均 ≥3:1，线形可辨），按序分配给开启的信号。 */
export const SERIES_COLORS: readonly string[] = [
  '#12849b', // 青
  '#a8650e', // 橙
  '#0f7d55', // 绿
  '#6c52cc', // 紫
  '#b23c78', // 粉
  '#8f7410', // 黄
  '#2f66bb', // 蓝
  '#bd3a35', // 红
];

/** 主题相关的颜色与字体（来自 app.css 自定义属性；缺省值用于无样式环境）。 */
interface Theme {
  faint: string;
  mid: string;
  grid: string;
  border: string;
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

const TICK_STEPS_MS: readonly number[] = [
  1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 1800000,
];
const AXIS_H = 22; // 底部时间轴高度（CSS 像素）
const GUTTER = 58; // 左侧数值刻度留白
const PAD_R = 10; // 右侧留白
const STRIP = 20; // 每带顶部标注条高度（信号名/最新值），曲线不进入该区域

/** 数值格式化：约 3 位有效数字，万级以上用 k 缩写。 */
function fmtVal(v: number): string {
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
function fmtRel(ms: number): string {
  if (ms === 0) return '0';
  const sec = Math.round(Math.abs(ms) / 1000);
  const txt = sec >= 60 && sec % 60 === 0 ? sec / 60 + 'm' : sec + 's';
  return '-' + txt;
}

/** #rrggbb → rgba(...)；非 6 位十六进制返回 null（调用方跳过面积填充）。 */
function hexToRgba(hex: string, alpha: number): string | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null) return null;
  const n = parseInt(m[1], 16);
  return 'rgba(' + ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ', ' + alpha + ')';
}

export class SignalChart {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly ro: ResizeObserver | null;
  private raf = 0;
  private cssW = 0;
  private cssH = 0;
  private series: readonly ChartSeries[] = [];
  private windowMs = 30000;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('无法创建 2D 绘图上下文');
    this.ctx = ctx;
    this.ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.schedule());
    if (this.ro !== null) this.ro.observe(canvas);
    this.schedule();
  }

  /** 用最新数据整体重绘（内部合并到 rAF）。 */
  update(series: readonly ChartSeries[], windowMs: number): void {
    this.series = series;
    if (windowMs > 0) this.windowMs = windowMs;
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
      faint: pick('--text-faint', '#7e8fa4'),
      mid: pick('--text-mid', '#9db0c5'),
      grid: pick('--border-soft', 'rgba(96, 122, 152, 0.16)'),
      border: pick('--border', '#25303f'),
      mono: pick('--font-mono', 'Menlo, Consolas, monospace'),
      ui: pick('--font-ui', 'system-ui, sans-serif'),
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
    const span = plotR - plotL;

    /* 窗口右端对齐全部序列的最新样本 */
    let tRight = 0;
    for (const s of list) {
      const n = s.samples.length;
      if (n > 0 && s.samples[n - 1].t > tRight) tRight = s.samples[n - 1].t;
    }
    const tLeft = tRight - this.windowMs;

    /* 纵向网格 + 时间刻度 */
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
      ctx.moveTo(x, 0);
      ctx.lineTo(x, axisY);
      ctx.stroke();
      ctx.fillText(k === 0 ? '0' : fmtRel(-k * step), x, axisY + 15);
    }

    /* 时间轴基线 */
    ctx.strokeStyle = th.border;
    ctx.beginPath();
    ctx.moveTo(0.5, Math.round(axisY) + 0.5);
    ctx.lineTo(w - 0.5, Math.round(axisY) + 0.5);
    ctx.stroke();

    if (list.length === 0) {
      this.drawEmptyGrid(plotL, plotR, axisY, th);
      this.drawMessage(w / 2, axisY / 2, '暂无曲线数据', '开启信号开关后，曲线将绘制在这里', th);
      return;
    }
    const bandH = axisY / list.length;
    for (let i = 0; i < list.length; i++) {
      this.drawBand(list[i], i, bandH, tLeft, tRight, plotL, plotR, axisY, th);
    }
  }

  private tickStepMs(): number {
    const target = this.windowMs / 6;
    for (const s of TICK_STEPS_MS) if (s >= target) return s;
    return this.windowMs;
  }

  private drawEmptyGrid(plotL: number, plotR: number, axisY: number, th: Theme): void {
    const ctx = this.ctx;
    ctx.strokeStyle = th.grid;
    for (const f of [0.25, 0.5, 0.75]) {
      const y = Math.round(axisY * f) + 0.5;
      ctx.beginPath();
      ctx.moveTo(plotL, y);
      ctx.lineTo(plotR, y);
      ctx.stroke();
    }
  }

  private drawMessage(cx: number, cy: number, main: string, sub: string, th: Theme): void {
    const ctx = this.ctx;
    ctx.textAlign = 'center';
    ctx.fillStyle = th.mid;
    ctx.font = '600 12.5px ' + th.ui;
    ctx.fillText(main, cx, cy - 3);
    ctx.fillStyle = th.faint;
    ctx.font = '400 11px ' + th.ui;
    ctx.fillText(sub, cx, cy + 14);
  }

  private drawBand(
    s: ChartSeries,
    i: number,
    bandH: number,
    tLeft: number,
    tRight: number,
    plotL: number,
    plotR: number,
    axisY: number,
    th: Theme
  ): void {
    const ctx = this.ctx;
    const top = i * bandH;
    /* 顶部为标注条（名称/最新值），曲线绘制区在其下方，避免波峰压字 */
    const innerTop = top + STRIP;
    const innerBottom = Math.min(top + bandH - 6, axisY);
    if (innerBottom - innerTop < 6) return;
    const span = plotR - plotL;

    /* 带间分隔 + 横向网格（分隔线延伸进左侧刻度槽，明确刻度归属） */
    ctx.strokeStyle = th.grid;
    if (i > 0) {
      const y = Math.round(top) + 0.5;
      ctx.beginPath();
      ctx.moveTo(GUTTER - 26, y);
      ctx.lineTo(plotR, y);
      ctx.stroke();
    }
    for (const f of [0.25, 0.5, 0.75]) {
      const y = Math.round(innerTop + f * (innerBottom - innerTop)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(plotL, y);
      ctx.lineTo(plotR, y);
      ctx.stroke();
    }

    /* 名称 + 单位（标注条左端） */
    const labelY = top + 14;
    ctx.textAlign = 'left';
    ctx.font = '600 11px ' + th.ui;
    ctx.fillStyle = th.mid;
    ctx.fillText(s.label, plotL + 6, labelY);
    if (s.unit !== '' && bandH >= 30) {
      const nameW = ctx.measureText(s.label).width;
      ctx.font = '400 10px ' + th.ui;
      ctx.fillStyle = th.faint;
      ctx.fillText('· ' + s.unit, plotL + 6 + nameW + 4, labelY);
    }

    /* 窗口内样本区间（samples 升序） */
    const samples = s.samples;
    let first = samples.length;
    let last = -1;
    for (let j = 0; j < samples.length; j++) {
      const t = samples[j].t;
      if (t < tLeft) continue;
      if (t > tRight) break;
      if (first === samples.length) first = j;
      last = j;
    }
    ctx.textAlign = 'right';
    ctx.font = '600 11px ' + th.mono;
    if (last < first) {
      ctx.fillStyle = th.faint;
      ctx.fillText('—', plotR - 6, labelY);
      ctx.font = '400 11px ' + th.ui;
      ctx.fillText('暂无数据', (plotL + plotR) / 2, (innerTop + innerBottom) / 2 + 4);
      return;
    }
    const latest = samples[last].v;
    ctx.fillStyle = s.color;
    ctx.fillText(fmtVal(latest), plotR - 6, labelY);

    /* Y 轴自适应：先取窗口内实际最小/最大，再留余量 */
    let dLo = Infinity;
    let dHi = -Infinity;
    for (let j = first; j <= last; j++) {
      const v = samples[j].v;
      if (!Number.isFinite(v)) continue;
      if (v < dLo) dLo = v;
      if (v > dHi) dHi = v;
    }
    if (dLo > dHi) return; // 窗口内全为非法值
    /* 恒定/近恒定判定：上下刻度格式化后相同即视为不可区分（涵盖 range === 0 与
       大数值下的微小抖动），此时实际范围无法作为刻度展示 */
    const flat = fmtVal(dHi) === fmtVal(dLo);
    let lo = dLo;
    let hi = dHi;
    if (flat) {
      /* 恒定值：按 |中值| 的 5%（至少 1）给对称余量，曲线居中、上下刻度可区分 */
      const mid = (dHi + dLo) / 2;
      const d = Math.max(Math.abs(mid) * 0.05, 1);
      lo = mid - d;
      hi = mid + d;
    } else {
      /* 12% 余量：波峰与标注条之间保持可视间隙（窄画布/字体回退时仍不压字） */
      const pad = (hi - lo) * 0.12;
      lo -= pad;
      hi += pad;
    }
    const yOf = (v: number): number => innerTop + (1 - (v - lo) / (hi - lo)) * (innerBottom - innerTop);
    const xOf = (t: number): number => plotL + ((t - tLeft) / this.windowMs) * span;

    /* 左侧范围刻度：正常显示实际数据范围；恒定序列显示含余量的轴范围，
       否则上下两个刻度格式化后相同（如都是 952），失去轴信息 */
    ctx.textAlign = 'right';
    ctx.font = '400 9.5px ' + th.mono;
    ctx.fillStyle = th.mid;
    ctx.fillText(fmtVal(flat ? hi : dHi), plotL - 6, innerTop + 8);
    ctx.fillText(fmtVal(flat ? lo : dLo), plotL - 6, innerBottom - 1);

    /* 每像素列 min/max 抽稀 */
    const cols: Column[] = [];
    let lastX = -1;
    for (let j = first; j <= last; j++) {
      const smp = samples[j];
      if (!Number.isFinite(smp.v)) continue;
      const x = Math.min(plotR - 1, Math.max(plotL, Math.round(xOf(smp.t))));
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

    /* 面积填充：曲线下方按序列色渐隐 */
    const fillTop = hexToRgba(s.color, 0.22);
    if (fillTop !== null && cols.length > 1) {
      const grad = ctx.createLinearGradient(0, innerTop, 0, innerBottom);
      grad.addColorStop(0, fillTop);
      grad.addColorStop(1, hexToRgba(s.color, 0) ?? fillTop);
      ctx.fillStyle = grad;
      ctx.beginPath();
      this.pathColumns(cols, xOf, yOf);
      ctx.lineTo(xOf(cols[cols.length - 1].tL), innerBottom);
      ctx.lineTo(xOf(cols[0].tF), innerBottom);
      ctx.closePath();
      ctx.fill();
    }

    /* 曲线本体 */
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    this.pathColumns(cols, xOf, yOf);
    ctx.stroke();
    if (cols.length === 1) {
      /* 单点：零长线段不可见，画实心圆点 */
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(xOf(cols[0].tF), yOf(cols[0].vF), 2.5, 0, Math.PI * 2);
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
}
