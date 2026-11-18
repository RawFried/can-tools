/**
 * 单通道信号会话（无 DOM）：DBC 定义、报文/信号选择、样本缓存与曲线序列。
 * 浮窗只负责把这里的结果渲染成控件与 canvas；每帧解码限定在自身通道。
 */
import { seriesPalette, MAX_SERIES } from './chart';
import { decodeMessage, parseFrameData, signalKey } from './dbc-model';
import { state } from './state';
import type { ChartSample, ChartSeries, SeriesLook } from './chart';
import type { DbcDefinitionDto, DbcMessageDto, DbcSignalDto, FrameDto } from './types';

const SAMPLE_CAP = 20000;

interface SeriesState {
  message: DbcMessageDto;
  signal: DbcSignalDto;
  look: SeriesLook;
  samples: ChartSample[];
}
interface MsgSeries {
  message: DbcMessageDto;
  byKey: Map<string, SeriesState>;
}

/** 信号开关状态：color 为 null 表示未开启。 */
export interface SignalChoice {
  signal: DbcSignalDto;
  color: string | null;
}

/** 图例行：末值可能为 null（尚未收到帧）；key 用于把行点击映射回曲线选中。 */
export interface SignalLegendItem {
  key: string;
  name: string;
  unit: string;
  color: string;
  dash: readonly number[];
  value: number | null;
}

export type ToggleResult = 'added' | 'removed' | 'limit' | 'none';

function msgKey(extended: boolean, id: number): string {
  return (extended ? 'x' : 's') + id.toString(16);
}

/** 定义形态（文件名或报文/信号数量）是否变化；变化时清空选择与样本。 */
function sameShape(a: DbcDefinitionDto | null, b: DbcDefinitionDto | null): boolean {
  if (a === null || b === null) return a === b;
  const right = b;
  return (
    a.name === right.name &&
    a.messages.length === right.messages.length &&
    a.messages.every((m, i) => m.signals.length === right.messages[i].signals.length)
  );
}

export class SignalSession {
  private readonly channel: number;
  private def: DbcDefinitionDto | null = null;
  private activeMsg: { extended: boolean; id: number } | null = null;
  private readonly series = new Map<string, SeriesState>();
  /** 报文 key → 该报文的序列表；收帧时按帧 id 直接命中。 */
  private seriesIndex = new Map<string, MsgSeries>();

  constructor(channel: number) {
    this.channel = channel;
  }

  definition(): DbcDefinitionDto | null {
    return this.def;
  }

  /** 应用新定义；返回是否发生形态变化（调用方据此清空提示/重绘）。 */
  setDefinition(def: DbcDefinitionDto | null): boolean {
    const changed = !sameShape(this.def, def);
    this.def = def;
    if (changed) {
      this.series.clear();
      this.activeMsg = null;
      this.rebuildSeriesIndex();
    }
    return changed;
  }

  /** 报文按 ID 排序：列表展示与“当前报文”判断共用。 */
  messages(): DbcMessageDto[] {
    if (this.def === null) return [];
    return this.def.messages
      .slice()
      .sort((a, b) => a.id - b.id || Number(a.extended) - Number(b.extended));
  }

  isActive(m: DbcMessageDto): boolean {
    return (
      this.activeMsg !== null &&
      this.activeMsg.id === m.id &&
      this.activeMsg.extended === m.extended
    );
  }

  activeMessage(): DbcMessageDto | null {
    const active = this.activeMsg;
    if (this.def === null || active === null) return null;
    return (
      this.def.messages.find((m) => m.id === active.id && m.extended === active.extended) ?? null
    );
  }

  /** 再次点击同一报文即取消选择。 */
  toggleMessage(id: number, extended: boolean): void {
    const same =
      this.activeMsg !== null && this.activeMsg.id === id && this.activeMsg.extended === extended;
    this.activeMsg = same ? null : { id, extended };
  }

  /** 当前报文下的全部信号及开启状态（点色即图例曲线色）。 */
  signalsOfActive(): SignalChoice[] {
    const msg = this.activeMessage();
    if (msg === null) return [];
    return msg.signals.map((signal) => {
      const s = this.series.get(signalKey(msg, signal));
      return { signal, color: s?.look.color ?? null };
    });
  }

  seriesCount(): number {
    return this.series.size;
  }

  /**
   * 切换信号开关：新增时按“色级 × 线型”分配首个未占用外观，并用缓冲回填；
   * 达到上限时返回 limit，不修改现有选择。
   */
  toggleSignal(sig: DbcSignalDto): ToggleResult {
    const msg = this.activeMessage();
    if (msg === null) return 'none';
    const key = signalKey(msg, sig);
    if (this.series.has(key)) {
      this.series.delete(key);
      this.rebuildSeriesIndex();
      return 'removed';
    }
    if (this.series.size >= MAX_SERIES) return 'limit';

    const palette = seriesPalette();
    const used = new Set<string>();
    for (const s of this.series.values()) {
      used.add(s.look.color + '|' + s.look.dash.join(','));
    }
    const look =
      palette.find((c) => !used.has(c.color + '|' + c.dash.join(','))) ??
      palette[this.series.size % palette.length];
    const item: SeriesState = { message: msg, signal: sig, look, samples: [] };
    this.series.set(key, item);
    this.rebuildSeriesIndex();
    this.backfill(item);
    return 'added';
  }

  /** 收帧解码；只处理自身通道，返回是否有样本被追加。 */
  feed(frames: FrameDto[]): boolean {
    if (frames.length === 0 || this.seriesIndex.size === 0) return false;
    let touched = false;
    for (const f of frames) {
      if (f.channel !== this.channel) continue;
      const entry = this.seriesIndex.get(msgKey(f.extended, f.id));
      if (!entry) continue;
      for (const d of decodeMessage(entry.message, parseFrameData(f))) {
        const s = entry.byKey.get(signalKey(entry.message, d.signal));
        if (s) this.pushSample(s, f.time_ms, d.value);
      }
      touched = true;
    }
    return touched;
  }

  /** 快照到达：保留选择，重置样本并用快照帧回填。 */
  seed(frames: FrameDto[]): boolean {
    const had = this.series.size > 0;
    for (const s of this.series.values()) s.samples.length = 0;
    return this.feed(frames) || had;
  }

  /** 清空样本，保留信号选择；返回是否有曲线需要重绘。 */
  clearSamples(): boolean {
    const had = this.series.size > 0;
    for (const s of this.series.values()) s.samples.length = 0;
    return had;
  }

  /** 传给 SignalChart 的序列（统一坐标系；选中序列决定纵轴刻度）。 */
  chartSeries(): ChartSeries[] {
    const out: ChartSeries[] = [];
    for (const [key, s] of this.series) {
      out.push({
        key,
        label: s.signal.name,
        unit: s.signal.unit,
        color: s.look.color,
        dash: s.look.dash,
        samples: s.samples,
      });
    }
    return out;
  }

  /** 图例数据：名称、末值（真实读数）与曲线外观。 */
  legendItems(): SignalLegendItem[] {
    const out: SignalLegendItem[] = [];
    for (const [key, s] of this.series) {
      const last = s.samples[s.samples.length - 1];
      out.push({
        key,
        name: s.signal.name,
        unit: s.signal.unit,
        color: s.look.color,
        dash: s.look.dash,
        value: last ? last.v : null,
      });
    }
    return out;
  }

  private rebuildSeriesIndex(): void {
    this.seriesIndex = new Map();
    for (const s of this.series.values()) {
      const key = msgKey(s.message.extended, s.message.id);
      const entry = this.seriesIndex.get(key) ?? { message: s.message, byKey: new Map() };
      entry.byKey.set(signalKey(s.message, s.signal), s);
      this.seriesIndex.set(key, entry);
    }
  }

  private pushSample(s: SeriesState, t: number, v: number): void {
    if (!Number.isFinite(t) || !Number.isFinite(v)) return;
    const last = s.samples[s.samples.length - 1];
    if (last && t < last.t) return; /* 曲线要求时间升序，乱序帧丢弃 */
    s.samples.push({ t, v });
    if (s.samples.length > SAMPLE_CAP + 1024) {
      s.samples.splice(0, s.samples.length - SAMPLE_CAP);
    }
  }

  /** 新选中的信号用 state.buffer 中同通道已有帧回填。 */
  private backfill(target: SeriesState): void {
    const msg = target.message;
    for (const f of state.buffer) {
      if (f.channel !== this.channel || f.id !== msg.id || f.extended !== msg.extended) continue;
      for (const decoded of decodeMessage(msg, parseFrameData(f))) {
        if (decoded.signal.name === target.signal.name) {
          this.pushSample(target, f.time_ms, decoded.value);
          break;
        }
      }
    }
  }
}
