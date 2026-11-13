/**
 * 滤波器卡片的 DOM 部分：按通道保存/切换 ID 区间、「接收全部」与「实时应用滤波」。
 * 与 status.ts 不互相 import：控件刷新通过 setRangeRowsChangedHandler 注入；
 * status 反过来调用 syncFilters 初始化各通道区间。
 */
import { updateFilters } from './api';
import { els, q, filterTplRow } from './dom';
import { deriveAcceptanceFilter, describeHardwareFilter } from './filters-model';
import { parseHex } from './format';
import { state } from './state';
import { setLastLog, toast } from './toast';
import type {
  ChannelStatusDto,
  ConfigBody,
  FilterUpdateChannelDto,
  SocketCanChannelConfigDto,
  SoftwareFilterDto,
  StatusDto,
  UsbChannelConfigDto,
} from './types';
import { asBaud, asMode } from './types';

/** ID 区间行数上限（后端对 software_filters 同样限制 16 条，超出会被拒绝）。 */
export const MAX_RANGE_ROWS = 16;

/** 由外部（main/events）注入的「区间行数变化后刷新控件」回调。 */
let rangeRowsChangedHandler: (() => void) | null = null;

export function setRangeRowsChangedHandler(fn: () => void): void {
  rangeRowsChangedHandler = fn;
}

function notifyRangeRowsChanged(): void {
  if (rangeRowsChangedHandler !== null) rangeRowsChangedHandler();
}

export function rangeRowCount(): number {
  return els.filterRangeList.querySelectorAll('.filter-row').length;
}

let rangeRowSeq = 0;

export function buildRangeRow(ext: boolean, start?: number, end?: number): HTMLElement {
  const src = filterTplRow;
  const row = (src ? src.cloneNode(true) : document.createElement('div')) as HTMLElement;

  /* 同名 radio 会被视为同一组：为每行生成独立组名，避免行与行之间互斥 */
  const groupName = 'f-ext-' + ++rangeRowSeq;
  for (const radio of row.querySelectorAll<HTMLInputElement>('input[type="radio"]')) {
    radio.name = groupName;
    if (radio.value === (ext ? 'ext' : 'std')) radio.checked = true;
  }

  const startIn = q<HTMLInputElement>(row, '.f-start');
  startIn.value = start !== undefined ? start.toString(16).toUpperCase() : '100';

  const endIn = q<HTMLInputElement>(row, '.f-end');
  endIn.value = end !== undefined ? end.toString(16).toUpperCase() : '7FF';

  q<HTMLButtonElement>(row, '.f-del').addEventListener('click', () => {
    row.remove();
    notifyRangeRowsChanged();
  });
  return row;
}

/** 读取一行的帧类型分段选择。 */
function rangeRowExtended(row: HTMLElement): boolean {
  return q<HTMLInputElement>(row, 'input[type="radio"][value="ext"]').checked;
}

/** 读取当前选中的通道集合（CAN1/CAN2 复选框）。 */
export function selectedChannels(): number[] {
  const channels: number[] = [];
  if (els.ch1Check.checked) channels.push(0);
  if (els.ch2Check.checked) channels.push(1);
  return channels;
}

/** 收集当前 DOM 中的 ID 区间并校验；非法时提示并返回 null。 */
function collectRanges(): SoftwareFilterDto[] | null {
  const rows = Array.from(els.filterRangeList.querySelectorAll<HTMLElement>('.filter-row'));
  if (rows.length > MAX_RANGE_ROWS) {
    toast('ID 区间最多 ' + MAX_RANGE_ROWS + ' 条', 'warn');
    return null;
  }
  const ranges: SoftwareFilterDto[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const ext = rangeRowExtended(row);
    const maxId = ext ? 0x1fffffff : 0x7ff;
    const startIn = q<HTMLInputElement>(row, '.f-start');
    const endIn = q<HTMLInputElement>(row, '.f-end');
    const start = parseHex(startIn.value, maxId);
    const end = parseHex(endIn.value, maxId);
    const scope = ext ? '扩展帧最大 1FFFFFFF' : '标准帧最大 7FF';
    if (start === null) {
      toast('第 ' + (i + 1) + ' 条区间：起始 ID 无效（' + scope + '）', 'warn');
      startIn.focus();
      return null;
    }
    if (end === null) {
      toast('第 ' + (i + 1) + ' 条区间：结束 ID 无效（' + scope + '）', 'warn');
      endIn.focus();
      return null;
    }
    if (start > end) {
      toast('第 ' + (i + 1) + ' 条区间：起始 ID 不能大于结束 ID', 'warn');
      startIn.focus();
      return null;
    }
    ranges.push({ extended: ext, start, end });
  }
  return ranges;
}

/** 通道稳定 key：`usb:0`/`usb:1`/`scan:<name>`。 */
export function channelKey(ch: ChannelStatusDto): string {
  return ch.source === 'usb' ? 'usb:' + ch.index : 'scan:' + ch.name;
}

function channelLabel(ch: ChannelStatusDto): string {
  return (ch.source === 'usb' ? 'USB · ' : 'socket · ') + ch.name;
}

interface ChannelOption {
  key: string;
  label: string;
}

/** 由 status.channels 与已发现链路合并选项，去重并保持稳定顺序。 */
function channelOptions(st: StatusDto | null): ChannelOption[] {
  const options: ChannelOption[] = [];
  const seen = new Set<string>();
  for (const ch of st?.channels ?? []) {
    const key = channelKey(ch);
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ key, label: channelLabel(ch) });
  }
  for (const link of state.socketcan) {
    const key = 'scan:' + link.name;
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ key, label: 'socket · ' + link.name });
  }
  return options;
}

/** 当前滤波目标通道；未在 status 中注册（如仅发现未启动）时返回 null。 */
export function filterChannelStatus(st: StatusDto | null): ChannelStatusDto | null {
  if (st === null || state.filterChannel === null) return null;
  const key = state.filterChannel;
  return st.channels.find((ch) => channelKey(ch) === key) ?? null;
}

let optionsSignature: string | null = null;
let panelRendered = false;

function renderFilterOptions(st: StatusDto | null): void {
  const options = channelOptions(st);
  const signature = options.map((option) => option.key + '|' + option.label).join(',');
  if (signature !== optionsSignature) {
    optionsSignature = signature;
    const frag = document.createDocumentFragment();
    for (const option of options) {
      const el = document.createElement('option');
      el.value = option.key;
      el.textContent = option.label;
      frag.appendChild(el);
    }
    els.filterChannel.replaceChildren(frag);
  }
  els.filterChannel.value = state.filterChannel ?? '';
}

/** 渲染某个通道的区间列表；空列表时由 updateControls 显示占位提示。 */
function renderRanges(key: string | null): void {
  const ranges = key !== null ? state.filters.get(key) ?? [] : [];
  const frag = document.createDocumentFragment();
  for (const f of ranges) {
    frag.appendChild(buildRangeRow(f.extended, f.start, f.end));
  }
  els.filterRangeList.replaceChildren(frag);
  notifyRangeRowsChanged();
}

/** 选中通道失效时的回退：当前选中 → 首个运行通道 → usb:0 → 首个选项。 */
function ensureSelection(st: StatusDto | null): boolean {
  const keys = channelOptions(st).map((option) => option.key);
  if (state.filterChannel !== null && keys.includes(state.filterChannel)) return false;
  const running = st?.channels.find((ch) => ch.running) ?? null;
  state.filterChannel =
    running !== null ? channelKey(running) : keys.includes('usb:0') ? 'usb:0' : keys[0] ?? null;
  return true;
}

/** 状态推送时初始化缺失的通道区间，并保证选项/当前区间已渲染（不覆盖用户编辑）。 */
export function syncFilters(st: StatusDto): void {
  for (const ch of st.channels) {
    const key = channelKey(ch);
    if (!state.filters.has(key)) {
      state.filters.set(key, ch.software_filters.map((f) => ({ ...f })));
    }
  }
  const changed = ensureSelection(st);
  renderFilterOptions(st);
  if (changed || !panelRendered) {
    renderRanges(state.filterChannel);
    panelRendered = true;
  } else {
    notifyRangeRowsChanged();
  }
}

/** 初始化滤波面板（首个状态到达前调用一次）。 */
export function initFilterPanel(): void {
  if (state.status !== null) {
    syncFilters(state.status);
    return;
  }
  ensureSelection(null);
  renderFilterOptions(null);
  renderRanges(state.filterChannel);
}

/** 设备/链路发现变化后刷新通道选项（状态未到达时不改变选区）。 */
export function refreshFilterChannels(): void {
  const st = state.status;
  if (st !== null) {
    const changed = ensureSelection(st);
    renderFilterOptions(st);
    if (changed) {
      renderRanges(state.filterChannel);
      renderHwPrefilter(st);
    }
    return;
  }
  renderFilterOptions(null);
}

/** 切换滤波目标通道：先保存当前通道的区间，再渲染目标通道。 */
export function selectFilterChannel(key: string): void {
  if (key === state.filterChannel) return;
  if (!channelOptions(state.status).some((option) => option.key === key)) {
    els.filterChannel.value = state.filterChannel ?? '';
    return;
  }
  const ranges = collectRanges();
  if (ranges === null) {
    els.filterChannel.value = state.filterChannel ?? '';
    return;
  }
  if (state.filterChannel !== null) state.filters.set(state.filterChannel, ranges);
  state.filterChannel = key;
  panelRendered = true;
  renderFilterOptions(state.status);
  renderRanges(key);
  if (state.status !== null) renderHwPrefilter(state.status);
}

/** 读取链路速率：用户选择优先，其次已发现链路的 bitrate，非法/缺失回退 500000。 */
function scanBitrate(name: string): number {
  const value =
    state.scanRates.get(name) ??
    state.socketcan.find((link) => link.name === name)?.bitrate ??
    null;
  return value !== null && Number.isFinite(value) && value >= 1000 && value <= 1_000_000
    ? value
    : 500_000;
}

/** 从表单收集 POST /api/config 请求体；校验失败时提示并返回 null。 */
export function collectConfig(): ConfigBody | null {
  /* 先把当前通道的 DOM 编辑保存到 state，避免切换前未保存 */
  const current = collectRanges();
  if (current === null) return null;
  if (state.filterChannel !== null) state.filters.set(state.filterChannel, current);

  const usb: UsbChannelConfigDto[] = [];
  for (const index of selectedChannels()) {
    const ranges = state.filters.get('usb:' + index) ?? [];
    const baud = asBaud(index === 0 ? els.ch1Baud.value : els.ch2Baud.value) ?? '500k';
    usb.push({ index, baud, filter: deriveAcceptanceFilter(ranges), software_filters: ranges });
  }

  const socketcan: SocketCanChannelConfigDto[] = [...state.scanSelected].map((name) => ({
    name,
    bitrate: scanBitrate(name),
    software_filters: state.filters.get('scan:' + name) ?? [],
  }));
  if (usb.length === 0 && socketcan.length === 0) {
    toast('请至少选择一个通道', 'warn');
    return null;
  }

  const checked = document.querySelector<HTMLInputElement>('input[name="mode"]:checked');
  const mode = checked ? asMode(checked.value) ?? 'normal' : 'normal';
  return { usb, socketcan, mode };
}

/** 硬件预过滤徽标：当前通道自己的硬件滤波；SocketCAN 无硬件验收。 */
export function renderHwPrefilter(st: StatusDto): void {
  const ch = filterChannelStatus(st);
  if (ch === null) {
    els.hwFilterState.textContent = '—';
    return;
  }
  if (ch.source === 'socketcan') {
    els.hwFilterState.textContent = '仅软件滤波（无硬件验收）';
    return;
  }
  const ranges = state.filters.get(channelKey(ch)) ?? [];
  els.hwFilterState.textContent = describeHardwareFilter(ch.filter, ranges);
}

export function acceptAllRanges(): void {
  if (rangeRowCount() === 0) {
    toast('区间列表已为空：当前通道即接收全部帧', 'info');
    return;
  }
  els.filterRangeList.replaceChildren();
  if (state.filterChannel !== null) state.filters.set(state.filterChannel, []);
  notifyRangeRowsChanged();
  toast('已清空当前通道的全部区间：点击「实时应用滤波」后接收全部帧', 'info');
}

export function addRangeRow(): void {
  const count = rangeRowCount();
  if (count >= MAX_RANGE_ROWS) {
    toast('ID 区间最多 ' + MAX_RANGE_ROWS + ' 条，请先删除不需要的行', 'warn');
    return;
  }
  els.filterRangeList.appendChild(buildRangeRow(false));
  notifyRangeRowsChanged();
  if (count + 1 === MAX_RANGE_ROWS) {
    toast('已达 ' + MAX_RANGE_ROWS + ' 条区间上限', 'info');
  }
}

/**
 * 「实时应用滤波」：只提交当前选中通道的一条更新。
 * USB 带该通道区间推导的硬件验收滤波；SocketCAN 仅软件滤波。
 *
 * applyStatus 由 events 注入，避免 filters ↔ status 直接互相 import。
 */
export async function applyFiltersLive(
  applyStatus: (st: StatusDto) => void
): Promise<void> {
  const ch = filterChannelStatus(state.status);
  if (ch === null) {
    toast('请先在滤波器中选择一个通道', 'warn');
    return;
  }
  if (!ch.running) {
    toast('选中的通道未运行，请先启动该通道', 'warn');
    return;
  }
  const ranges = collectRanges();
  if (ranges === null) return;
  if (state.filterChannel !== null) state.filters.set(state.filterChannel, ranges);

  const update: FilterUpdateChannelDto = { channel: ch.index, software_filters: ranges };
  if (ch.source === 'usb') update.filter = deriveAcceptanceFilter(ranges);

  const status = await updateFilters({ channels: [update] });
  if (status) applyStatus(status);
  toast('滤波已实时更新：' + ch.name + '（通道未停止）', 'success');
  setLastLog('滤波已实时更新：' + ch.name);
}
