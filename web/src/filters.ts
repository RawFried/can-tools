/**
 * 滤波器卡片的区间编辑：区间按通道 key 存入 state.filters。
 * 通道选择/切换由 channels.ts 负责；与 status.ts 不互相 import，
 * 行数变化后的控件刷新通过 setRangeRowsChangedHandler 注入。
 */
import { updateFilters } from './api';
import { els, q, filterTplRow } from './dom';
import { deriveAcceptanceFilter } from './filters-model';
/* channels.ts 通过 filters 取用滤波推导，保持依赖方向简洁 */
export { deriveAcceptanceFilter };
import { displayChannelName, parseHex } from './format';
import { state } from './state';
import { setLastLog, toast } from './toast';
import type {
  ChannelStatusDto,
  FilterUpdateChannelDto,
  SoftwareFilterDto,
  StatusDto,
} from './types';

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

/** 通道稳定 key：`usb:0`/`usb:1`/`scan:<name>`。 */
export function channelKey(ch: ChannelStatusDto): string {
  return ch.source === 'usb' ? 'usb:' + ch.index : 'scan:' + ch.name;
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

/** 校验当前 DOM 区间并保存到当前通道；失败返回 null（已提示）。 */
export function saveCurrentRanges(): SoftwareFilterDto[] | null {
  const ranges = collectRanges();
  if (ranges === null) return null;
  if (state.channelKey !== null) state.filters.set(state.channelKey, ranges);
  return ranges;
}

let renderedKey: string | null | undefined = undefined;

/** 渲染指定通道的区间列表（channels 切换通道时调用）。 */
export function renderRangesFor(key: string | null): void {
  const ranges = key !== null ? state.filters.get(key) ?? [] : [];
  const frag = document.createDocumentFragment();
  for (const f of ranges) {
    frag.appendChild(buildRangeRow(f.extended, f.start, f.end));
  }
  els.filterRangeList.replaceChildren(frag);
  renderedKey = key;
  notifyRangeRowsChanged();
}

/** 状态推送时补齐缺失的通道区间；当前通道变化时重绘区间。 */
export function syncFilters(st: StatusDto): void {
  for (const ch of st.channels) {
    const key = channelKey(ch);
    if (!state.filters.has(key)) {
      state.filters.set(key, ch.software_filters.map((f) => ({ ...f })));
    }
  }
  if (renderedKey !== state.channelKey) {
    renderRangesFor(state.channelKey);
  }
}

export function acceptAllRanges(): void {
  if (rangeRowCount() === 0) {
    toast('区间列表已为空：当前通道即接收全部帧', 'info');
    return;
  }
  els.filterRangeList.replaceChildren();
  if (state.channelKey !== null) state.filters.set(state.channelKey, []);
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
  const st = state.status;
  const key = state.channelKey;
  if (st === null || key === null) {
    toast('请先选择一个通道', 'warn');
    return;
  }
  const target = st.channels.find((ch) => channelKey(ch) === key) ?? null;
  if (target === null) {
    toast('选中的通道未注册，请先启动该通道', 'warn');
    return;
  }
  if (!target.running) {
    toast('选中的通道未运行，请先启动该通道', 'warn');
    return;
  }
  const ranges = saveCurrentRanges();
  if (ranges === null) return;

  const update: FilterUpdateChannelDto = { channel: target.index, software_filters: ranges };
  if (target.source === 'usb') update.filter = deriveAcceptanceFilter(ranges);

  const status = await updateFilters({ channels: [update] });
  if (status) applyStatus(status);
  toast('滤波已实时更新：' + displayChannelName(target.name) + '（通道未停止）', 'success');
  setLastLog('滤波已实时更新：' + displayChannelName(target.name));
}
