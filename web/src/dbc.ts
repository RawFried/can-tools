/**
 * DBC 面板编排：定义状态、报文/信号选择、上传与移除、收帧解码、曲线与图例批量刷新。
 * 不拥有 DOM 结构，只操作契约中的容器与 id。
 */
import { api } from './api';
import { seriesPalette, MAX_SERIES, SignalChart } from './chart';
import { decodeMessage, parseFrameData, signalKey } from './dbc-model';
import { els } from './dom';
import { errText, fmtSignal, hexOf } from './format';
import { state } from './state';
import { toast } from './toast';
import { isObj, parseDbcDto } from './types';
import type { ChartSample, ChartSeries, SeriesLook } from './chart';
import type { DbcDefinitionDto, DbcMessageDto, DbcSignalDto, FrameDto } from './types';

const SAMPLE_CAP = 20000;
const DEFAULT_WINDOW_MS = 30000;
const MAX_DBC_BYTES = 1024 * 1024;

interface SeriesState {
  message: DbcMessageDto;
  signal: DbcSignalDto;
  look: SeriesLook;
  samples: ChartSample[];
}
interface MsgSeries { message: DbcMessageDto; byKey: Map<string, SeriesState> }

let def: DbcDefinitionDto | null = null;
let activeMsg: { extended: boolean; id: number } | null = null;
let chart: SignalChart | null = null;
let rafId: number | null = null;

const series = new Map<string, SeriesState>();
/** 报文 key → 该报文的序列表；收帧时按帧 id 直接命中，避免每帧全表扫描。 */
let seriesIndex = new Map<string, MsgSeries>();

function msgKey(extended: boolean, id: number): string {
  return (extended ? 'x' : 's') + id.toString(16);
}
function rebuildSeriesIndex(): void {
  seriesIndex = new Map();
  for (const s of series.values()) {
    const key = msgKey(s.message.extended, s.message.id);
    const entry = seriesIndex.get(key) ?? { message: s.message, byKey: new Map() };
    entry.byKey.set(signalKey(s.message, s.signal), s);
    seriesIndex.set(key, entry);
  }
}

function currentWindowMs(): number {
  const n = Number(els.dbcWindowSelect.value);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WINDOW_MS;
}

function activeMessage(): DbcMessageDto | null {
  const active = activeMsg;
  if (!def || !active) return null;
  return def.messages.find((m) => m.id === active.id && m.extended === active.extended) ?? null;
}

function mk<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = cls;
  return el;
}

function text<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, value: string): HTMLElementTagNameMap[K] {
  const el = mk(tag, cls);
  el.textContent = value;
  return el;
}

function scheduleRender(): void {
  if (rafId !== null) return;
  rafId = window.requestAnimationFrame(() => {
    rafId = null;
    renderChart();
  });
}

function renderChart(): void {
  const out: ChartSeries[] = [];
  for (const [key, s] of series) {
    out.push({
      key,
      label: s.signal.name,
      unit: s.signal.unit,
      color: s.look.color,
      dash: s.look.dash,
      samples: s.samples,
    });
  }
  if (chart) chart.update(out, currentWindowMs());
  renderLegend();
}

/** 图例/开关里的线形标记：实线色块或同色虚线（与曲线的 dash 一致）。 */
function lineMarkerCss(look: SeriesLook): string {
  if (look.dash.length === 0) return 'background:' + look.color;
  const on = look.dash[0];
  const off = Math.max(1, look.dash[1] ?? 4);
  return (
    'background:repeating-linear-gradient(90deg,' +
    look.color + ' 0 ' + on + 'px,transparent ' + on + 'px ' + (on + off) + 'px)'
  );
}

function renderLegend(): void {
  if (series.size === 0) {
    els.signalLegend.replaceChildren();
    return;
  }
  const frag = document.createDocumentFragment();
  for (const s of series.values()) {
    const row = mk('div', 'sig-legend');
    const line = mk('span', 'sig-line');
    line.setAttribute('style', lineMarkerCss(s.look));
    const last = s.samples[s.samples.length - 1];
    const shown = last ? fmtSignal(last.v) + (s.signal.unit ? ' ' + s.signal.unit : '') : '—';
    row.append(line, text('span', 'sig-legend-name', s.signal.name), text('span', 'sig-legend-value', shown));
    frag.appendChild(row);
  }
  els.signalLegend.replaceChildren(frag);
}

function renderHeader(): void {
  const count = def ? def.messages.reduce((n, m) => n + m.signals.length, 0) : 0;
  els.dbcName.textContent = def ? def.name : '未加载 DBC';
  els.dbcSummary.textContent = def ? def.messages.length + ' 条报文 │ ' + count + ' 个信号' : '';
  els.btnDbcRemove.disabled = def === null;
  els.dbcEmpty.hidden = def !== null;
  els.dbcBody.hidden = def === null;
}

function renderMessageList(): void {
  if (!def) return void els.dbcMsgList.replaceChildren();
  const sorted = def.messages.slice().sort((a, b) => a.id - b.id || Number(a.extended) - Number(b.extended));
  const frag = document.createDocumentFragment();
  for (const m of sorted) {
    const active = activeMsg !== null && activeMsg.id === m.id && activeMsg.extended === m.extended;
    const btn = mk('button', 'dbc-msg');
    btn.type = 'button';
    btn.dataset['id'] = String(m.id);
    btn.dataset['extended'] = m.extended ? '1' : '0';
    btn.setAttribute('aria-pressed', String(active));
    if (active) btn.classList.add('is-active');
    btn.append(
      text('span', 'dbc-msg-id', hexOf(m.id, m.extended ? 8 : 3)),
      text('span', 'dbc-msg-name', m.name),
      text('span', 'dbc-msg-count', String(m.signals.length))
    );
    frag.appendChild(btn);
  }
  els.dbcMsgList.replaceChildren(frag);
}

function renderSignalBar(): void {
  const msg = activeMessage();
  if (!msg) return void els.dbcSignalBar.replaceChildren();
  const frag = document.createDocumentFragment();
  for (const sig of msg.signals) {
    const s = series.get(signalKey(msg, sig));
    const btn = mk('button', 'sig-chip');
    btn.type = 'button';
    btn.dataset['signal'] = sig.name;
    btn.setAttribute('aria-pressed', String(s !== undefined));
    if (s) btn.classList.add('is-on');
    const dot = mk('span', 'sig-dot');
    if (s) dot.setAttribute('style', 'background:' + s.look.color);
    btn.append(dot, text('span', 'sig-chip-name', sig.name));
    frag.appendChild(btn);
  }
  els.dbcSignalBar.replaceChildren(frag);
}

function updateSignalEmpty(): void {
  const msg = activeMessage();
  let hint: string | null = null;
  if (!def) hint = '加载 DBC 后可选择信号并绘制曲线。';
  else if (def.messages.length === 0) hint = 'DBC 中没有报文，无法绘制曲线。';
  else if (!activeMsg) hint = '选择左侧报文以查看可绘制的信号。';
  else if (!msg || msg.signals.length === 0) hint = '该报文没有可解码信号。';
  else if (series.size === 0) hint = '点击信号开关，将信号加入曲线。';
  els.signalEmpty.textContent = hint ?? '';
  els.signalEmpty.hidden = hint === null;
}

function sameShape(a: DbcDefinitionDto | null, b: DbcDefinitionDto | null): boolean {
  if (a === null || b === null) return a === b;
  const right = b;
  return a.name === right.name && a.messages.length === right.messages.length &&
    a.messages.every((m, i) => m.signals.length === right.messages[i].signals.length);
}

/** 应用新定义；定义形态变化（文件名或报文/信号数量）时清空选择与样本。 */
export function applyDbc(next: DbcDefinitionDto | null): void {
  const changed = !sameShape(def, next);
  def = next;
  if (changed) { series.clear(); activeMsg = null; rebuildSeriesIndex(); }
  renderHeader(); renderMessageList(); renderSignalBar(); updateSignalEmpty();
  /* 仅在定义真正变化时刷新状态行，避免 WebSocket 回执覆盖上传成功的具体提示。 */
  if (changed) {
    setHint(
      next
        ? '已加载 ' + next.name + '：选择报文与信号后开始绘制。'
        : '未加载 DBC：点击「加载 DBC」选择 .dbc 文件，信号曲线将在此显示。',
      false
    );
  }
  if (changed) renderChart();
}

function pushSample(s: SeriesState, t: number, v: number): void {
  if (!Number.isFinite(t) || !Number.isFinite(v)) return;
  const last = s.samples[s.samples.length - 1];
  if (last && t < last.t) return; /* 曲线要求时间升序，乱序帧丢弃 */
  s.samples.push({ t, v });
  /* 成批裁剪，避免接近上限时每帧一次 O(n) splice。 */
  if (s.samples.length > SAMPLE_CAP + 1024) {
    s.samples.splice(0, s.samples.length - SAMPLE_CAP);
  }
}

/** 新选中的信号用 state.buffer 中已有帧回填，避免等下一帧才出现曲线。 */
function backfill(target: SeriesState): void {
  const msg = target.message;
  for (const f of state.buffer) {
    if (f.id !== msg.id || f.extended !== msg.extended) continue;
    for (const decoded of decodeMessage(msg, parseFrameData(f))) {
      if (decoded.signal.name === target.signal.name) {
        pushSample(target, f.time_ms, decoded.value);
        break;
      }
    }
  }
}

function toggleSignal(sig: DbcSignalDto): void {
  const msg = activeMessage();
  if (!msg) return;
  const key = signalKey(msg, sig);
  if (series.has(key)) {
    series.delete(key);
    rebuildSeriesIndex();
  } else if (series.size >= MAX_SERIES) {
    toast('最多同时显示 ' + MAX_SERIES + ' 个信号曲线', 'warn');
    return;
  } else {
    /* 外观按“色级 × 线型”取第一个尚未占用的组合（灰阶 + 虚线区分） */
    const palette = seriesPalette();
    const used = new Set<string>();
    for (const s of series.values()) used.add(s.look.color + '|' + s.look.dash.join(','));
    const look =
      palette.find((c) => !used.has(c.color + '|' + c.dash.join(','))) ?? palette[series.size % palette.length];
    const item: SeriesState = { message: msg, signal: sig, look, samples: [] };
    series.set(key, item);
    rebuildSeriesIndex();
    backfill(item);
  }
  renderSignalBar();
  updateSignalEmpty();
  scheduleRender();
}

/** 只解码已选信号所属报文的帧；rAF 合并后统一刷新 chart/legend。 */
export function feedDbcFrames(frames: FrameDto[]): void {
  if (frames.length === 0 || seriesIndex.size === 0) return;
  let touched = false;
  for (const f of frames) {
    const entry = seriesIndex.get(msgKey(f.extended, f.id));
    if (!entry) continue;
    for (const d of decodeMessage(entry.message, parseFrameData(f))) {
      const s = entry.byKey.get(signalKey(entry.message, d.signal));
      if (s) pushSample(s, f.time_ms, d.value);
    }
    touched = true;
  }
  if (touched) scheduleRender();
}

/** 快照到达时重置样本并用快照帧回填（保留已选信号）。 */
export function seedDbcFrames(frames: FrameDto[]): void {
  for (const s of series.values()) s.samples.length = 0;
  feedDbcFrames(frames);
  scheduleRender();
}

/** 清空全部曲线样本，保留当前信号选择。 */
export function clearDbcSamples(): void {
  for (const s of series.values()) s.samples.length = 0;
  scheduleRender();
}

function setHint(msg: string, isError: boolean): void {
  els.dbcHint.textContent = msg;
  els.dbcHint.classList.toggle('is-error', isError);
}

function reportError(err: unknown): void {
  const msg = errText(err);
  setHint(msg, true);
  toast(msg, 'error');
}

async function loadDbcFile(file: File): Promise<void> {
  const bad = !file.name.toLowerCase().endsWith('.dbc')
    ? '仅支持 .dbc 文件：' + file.name
    : file.size > MAX_DBC_BYTES ? 'DBC 文件不能超过 1 MiB（当前 ' + file.size + ' 字节）' : '';
  if (bad) { setHint(bad, true); return; }
  setHint('正在加载 ' + file.name + '…', false);
  try {
    const content = await file.text();
    const res = await api('/api/dbc', 'POST', { name: file.name, content });
    const parsed = isObj(res) ? parseDbcDto(res['dbc']) : null;
    if (!parsed) {
      setHint('服务器返回的 DBC 定义不完整，已忽略', true);
      return;
    }
    applyDbc(parsed);
    setHint('已加载 ' + parsed.name + '（' + parsed.messages.length + ' 条报文）', false);
    toast('DBC 已加载：' + parsed.name, 'success');
  } catch (err) {
    reportError(err);
  }
}

async function removeDbc(): Promise<void> {
  try {
    await api('/api/dbc', 'DELETE');
    applyDbc(null);
    setHint('已移除 DBC 定义', false);
    toast('已移除 DBC', 'success');
  } catch (err) {
    reportError(err);
  }
}

function onMessageClick(e: MouseEvent): void {
  const target = e.target;
  const btn = target instanceof Element ? target.closest('button.dbc-msg') : null;
  if (!(btn instanceof HTMLButtonElement)) return;
  const id = Number(btn.dataset['id']);
  if (!Number.isFinite(id)) return;
  const extended = btn.dataset['extended'] === '1';
  const same = activeMsg !== null && activeMsg.id === id && activeMsg.extended === extended;
  activeMsg = same ? null : { id, extended };
  renderMessageList();
  renderSignalBar();
  updateSignalEmpty();
}

function onSignalClick(e: MouseEvent): void {
  const target = e.target;
  const btn = target instanceof Element ? target.closest('button.sig-chip') : null;
  if (!(btn instanceof HTMLButtonElement)) return;
  const name = btn.dataset['signal'];
  const msg = activeMessage();
  if (!msg || name === undefined) return;
  const sig = msg.signals.find((s) => s.name === name);
  if (sig) toggleSignal(sig);
}

function onWindowChange(): void {
  if (chart) chart.setWindowMs(currentWindowMs());
  renderChart();
}

/** 绑定 DBC 面板事件并初始化空状态；必须在 connectWs() 之前调用。 */
export function initDbc(): void {
  chart = new SignalChart(els.signalChart);
  els.btnDbcLoad.addEventListener('click', () => els.dbcFileInput.click());
  els.dbcFileInput.addEventListener('change', () => {
    const file = els.dbcFileInput.files?.[0] ?? null;
    els.dbcFileInput.value = '';
    if (file) void loadDbcFile(file);
  });
  els.btnDbcRemove.addEventListener('click', () => void removeDbc());
  els.dbcMsgList.addEventListener('click', onMessageClick);
  els.dbcSignalBar.addEventListener('click', onSignalClick);
  els.dbcWindowSelect.addEventListener('change', onWindowChange);
  els.btnChartClear.addEventListener('click', clearDbcSamples);
  chart.setWindowMs(currentWindowMs());
  applyDbc(null);
}
