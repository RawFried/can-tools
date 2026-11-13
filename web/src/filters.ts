/**
 * 滤波器卡片的 DOM 部分：区间行的构建/收集/增删上限、「接收全部」与「实时应用滤波」。
 * 与 status.ts 不互相 import：行数变化后的按钮刷新通过 setRangeRowsChangedHandler 注入。
 */
import { updateFilters } from './api';
import { els, q, filterTplRow } from './dom';
import { deriveAcceptanceFilter, describeHardwareFilter } from './filters-model';
import { parseHex } from './format';
import { setLastLog, toast } from './toast';
import type { ConfigBody, SoftwareFilterDto, StatusDto } from './types';
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

/** 收集 ID 区间行并校验；非法时提示并返回 null。 */
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

/** 从表单收集 POST /api/config 请求体；校验失败时提示并返回 null。 */
export function collectConfig(): ConfigBody | null {
  const channels = selectedChannels();
  if (channels.length === 0) {
    toast('请至少选择一个通道', 'warn');
    return null;
  }

  const baud = asBaud(els.baudSelect.value) ?? '500k';
  const checked = document.querySelector<HTMLInputElement>('input[name="mode"]:checked');
  const mode = checked ? asMode(checked.value) ?? 'normal' : 'normal';
  const software_filters = collectRanges();
  if (software_filters === null) return null;

  /* 硬件滤波由区间列表统一推导，用户不再直接编辑验收码/屏蔽码 */
  return { channels, baud, mode, filter: deriveAcceptanceFilter(software_filters), software_filters };
}

/** 硬件预过滤徽标：跟随每次状态推送，取首个运行中（或首个有滤波的）通道回报。 */
export function renderHwPrefilter(st: StatusDto): void {
  const running = st.channels.find((c) => c.running);
  const ref = running ?? st.channels.find((c) => c.filter !== null) ?? st.channels[0] ?? null;
  els.hwFilterState.textContent = describeHardwareFilter(
    ref ? ref.filter : null,
    st.software_filters
  );
}

export function acceptAllRanges(): void {
  if (rangeRowCount() === 0) {
    toast('区间列表已为空：当前即接收全部帧', 'info');
    return;
  }
  els.filterRangeList.replaceChildren();
  notifyRangeRowsChanged();
  toast('已清空全部区间：点击「实时应用滤波」后接收全部帧', 'info');
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
 * 「实时应用滤波」：硬件与软件滤波同源，均由区间列表推导后一起下发。
 *
 * applyStatus 由 events 注入，避免 filters ↔ status 直接互相 import。
 */
export async function applyFiltersLive(
  applyStatus: (st: StatusDto) => void
): Promise<void> {
  const channels = selectedChannels();
  if (channels.length === 0) {
    toast('请至少选择一个通道', 'warn');
    return;
  }
  const software_filters = collectRanges();
  if (software_filters === null) return;
  /* 硬件滤波与软件滤波同源：由区间列表统一推导后一起下发 */
  const filter = deriveAcceptanceFilter(software_filters);
  const status = await updateFilters(channels, filter, software_filters);
  if (status) applyStatus(status);
  const names = channels.map((channel) => 'CAN' + (channel + 1)).join('、');
  toast('滤波已实时更新：' + names + '（通道未停止）', 'success');
  setLastLog('滤波已实时更新：' + names);
}
