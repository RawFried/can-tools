/**
 * 报文管线：收帧入缓冲、rAF 批量上屏、快速过滤、表格裁剪与滚动钉底、暂停/清空视图。
 */
import { feedSignalFrames, clearSignalSamples } from './signals';
import { els, rowTplRow } from './dom';
import { fmtClock, fmtInt, hexOf } from './format';
import { BUFFER_CAP, state } from './state';
import { updateEmpty, updateStrip } from './status';
import type { FrameDto } from './types';

/** 实时报文显示方式：流水线逐行滚动，或按 ID 汇总最新值并高亮变化字节。 */
export type FrameMode = 'stream' | 'changes';

interface LatestEntry {
  frame: FrameDto;
  row: HTMLTableRowElement | null;
  /** 上一次实际渲染到表格的字节；用于比较变化。 */
  dataBytes: string[];
}

let frameMode: FrameMode = 'stream';
const latest = new Map<string, LatestEntry>();

function latestKey(f: FrameDto): string {
  return f.channel + ':' + (f.extended ? 'x' : 's') + f.id;
}

/** 记录最新帧；无论当前模式都维护，切换模式时可立即显示已有 ID。 */
function rememberLatest(f: FrameDto): void {
  const key = latestKey(f);
  const entry = latest.get(key);
  if (entry !== undefined) entry.frame = f;
  else latest.set(key, { frame: f, row: null, dataBytes: [] });
}

/** 收帧入缓冲（上限 BUFFER_CAP）；未暂停时并入待渲染队列，交由 rAF 批量上屏。 */
export function acceptFrames(frames: FrameDto[]): void {
  if (frames.length === 0) return;
  /* 先喂信号曲线：暂停表格显示时曲线仍需继续更新 */
  feedSignalFrames(frames);
  for (const f of frames) {
    state.buffer.push(f);
    rememberLatest(f);
  }
  if (state.buffer.length > BUFFER_CAP) {
    state.buffer.splice(0, state.buffer.length - BUFFER_CAP);
  }
  if (state.paused) {
    state.pausedHidden += frames.length;
    els.pausedCount.textContent = fmtInt(state.pausedHidden);
    updateStrip();
    return;
  }
  for (const f of frames) state.pending.push(f);
  scheduleFlush();
}

let flushReq = false;

function scheduleFlush(): void {
  if (flushReq) return;
  flushReq = true;
  window.requestAnimationFrame(() => {
    flushReq = false;
    flushRows();
  });
}

/** 将一批待渲染帧写入表格（仅匹配过滤器的行），并裁剪、滚动。 */
function flushRows(): void {
  const batch = state.pending;
  state.pending = [];
  if (batch.length === 0) {
    updateStrip();
    return;
  }
  if (frameMode === 'changes') {
    flushLatest(batch);
  } else {
    const frag = document.createDocumentFragment();
    for (const f of batch) {
      if (matchesFilter(f)) frag.appendChild(buildRow(f));
    }
    if (frag.childNodes.length > 0) els.framesBody.appendChild(frag);
    trimRows();
  }
  updateEmpty();
  updateStrip();
  maybeScroll();
}

function buildRow(f: FrameDto): HTMLTableRowElement {
  const src = rowTplRow;
  const row = (src ? src.cloneNode(true) : document.createElement('tr')) as HTMLTableRowElement;
  row.cells[0].textContent = fmtInt(f.seq);
  row.cells[1].textContent = fmtClock(f.time_ms);

  const badge = document.createElement('span');
  const info = state.status?.channels.find((item) => item.index === f.channel) ?? null;
  const isSocket = info !== null && info.source === 'socketcan';
  /* 通道来源统一为墨底编号标签（不靠多种色相区分），来源未知时退化为虚线框 */
  badge.className = info !== null ? 'ch-badge' : 'ch-badge ch-x';
  /* 名称前带来源，避免 SocketCAN 的 can0 与 USB 的 CAN0/CAN1 混淆。 */
  const text = document.createElement('span');
  text.className = 'ch-name';
  text.textContent =
    info !== null
      ? (isSocket ? 'SOCKET │ ' : 'USB │ ') +
        info.name
      : 'CH' + (f.channel + 1);
  badge.title =
    info !== null
      ? (isSocket ? 'SocketCAN 链路 ' : 'USB 通道 ') +
        info.name +
        '（路由 id ' +
        f.channel +
        '）'
      : '路由 id ' + f.channel;
  badge.appendChild(text);
  row.cells[2].appendChild(badge);

  row.cells[3].textContent = hexOf(f.id, f.extended ? 8 : 3);
  const baseType = f.extended ? '扩展' : '标准';
  row.cells[4].textContent = f.remote ? baseType + ' / 远程' : baseType;
  row.cells[5].textContent = String(f.dlc);
  row.cells[6].textContent = f.data.length > 0 ? f.data : '—';

  if (f.remote) row.classList.add('remote');
  return row;
}

/** 渲染数据字节；与上一轮显示的字节比较，变化的字节加高亮。 */
function renderData(cell: HTMLTableCellElement, data: string, previous: readonly string[]): string[] {
  const bytes = data.length > 0 ? data.split(' ') : [];
  if (bytes.length === 0) {
    cell.textContent = '—';
    return bytes;
  }
  const frag = document.createDocumentFragment();
  for (let i = 0; i < bytes.length; i += 1) {
    const span = document.createElement('span');
    span.className = 'frame-byte';
    if (previous.length > 0 && previous[i] !== bytes[i]) span.classList.add('is-changed');
    span.textContent = bytes[i];
    frag.appendChild(span);
    if (i < bytes.length - 1) frag.appendChild(document.createTextNode(' '));
  }
  cell.replaceChildren(frag);
  return bytes;
}

function buildLatestRow(entry: LatestEntry): HTMLTableRowElement {
  const row = buildRow(entry.frame);
  const cell = row.cells[6] as HTMLTableCellElement;
  entry.dataBytes = renderData(cell, entry.frame.data, []);
  return row;
}

function updateLatestRow(entry: LatestEntry): void {
  const row = entry.row;
  if (row === null) return;
  const f = entry.frame;
  row.cells[0].textContent = fmtInt(f.seq);
  row.cells[1].textContent = fmtClock(f.time_ms);
  row.cells[4].textContent = f.remote ? (f.extended ? '扩展 / 远程' : '标准 / 远程') : f.extended ? '扩展' : '标准';
  row.cells[5].textContent = String(f.dlc);
  row.classList.toggle('remote', f.remote);
  entry.dataBytes = renderData(row.cells[6] as HTMLTableCellElement, f.data, entry.dataBytes);
}

/** 变化汇总：只处理本批触及的 ID；行顺序按 ID 首次出现顺序。 */
function flushLatest(batch: readonly FrameDto[]): void {
  const touched = new Set<string>();
  for (const f of batch) touched.add(latestKey(f));
  for (const key of touched) {
    const entry = latest.get(key);
    if (entry === undefined) continue;
    const visible = matchesFilter(entry.frame);
    if (!visible) {
      entry.row?.remove();
      entry.row = null;
      continue;
    }
    if (entry.row === null) {
      entry.row = buildLatestRow(entry);
      els.framesBody.appendChild(entry.row);
    } else {
      updateLatestRow(entry);
    }
  }
}

function seedLatestFromBuffer(): void {
  latest.clear();
  for (const f of state.buffer) rememberLatest(f);
}

function rebuildLatest(): void {
  const frag = document.createDocumentFragment();
  for (const entry of latest.values()) {
    entry.row = null;
    if (matchesFilter(entry.frame)) {
      entry.row = buildLatestRow(entry);
      frag.appendChild(entry.row);
    }
  }
  els.framesBody.replaceChildren(frag);
}

/** 快速过滤：对 ID 十六进制、序列、通道、数据与类型做子串匹配。 */
function matchesFilter(f: FrameDto): boolean {
  const query = state.filter;
  if (!query) return true;
  const baseType = f.extended ? '扩展' : '标准';
  const info = state.status?.channels.find((item) => item.index === f.channel) ?? null;
  const hay = [
    f.id.toString(16),
    String(f.seq),
    String(f.channel),
    String(f.channel + 1),
    'can' + f.channel,
    info ? info.name : '',
    info ? info.name : '',
    info ? (info.source === 'socketcan' ? 'socketcan' : 'usb') : '',
    f.data,
    baseType,
    f.remote ? '远程' : '',
  ]
    .join(' ')
    .toLowerCase();
  return hay.includes(query);
}

/** 由本地缓冲整体重建表格（过滤条件变化、恢复显示、快照到达时调用）。 */
export function rebuildTable(resetLatest = false): void {
  if (resetLatest) seedLatestFromBuffer();
  if (frameMode === 'changes') {
    rebuildLatest();
  } else {
    const frag = document.createDocumentFragment();
    for (const f of state.buffer) {
      if (matchesFilter(f)) frag.appendChild(buildRow(f));
    }
    els.framesBody.replaceChildren(frag);
    trimRows();
  }
  updateEmpty();
  updateStrip();
  maybeScroll();
}

/** 切换实时报文显示方式并重建表格。 */
export function setFrameMode(next: FrameMode): void {
  if (frameMode === next) return;
  frameMode = next;
  rebuildTable();
}

function trimRows(): void {
  while (els.framesBody.rows.length > BUFFER_CAP) {
    els.framesBody.deleteRow(0);
  }
}

let scrollScheduled = false;

function maybeScroll(): void {
  if (!state.autoscroll || state.paused || scrollScheduled) return;
  scrollScheduled = true;
  window.requestAnimationFrame(() => {
    scrollScheduled = false;
    if (state.autoscroll && !state.paused) {
      els.tableWrap.scrollTop = els.tableWrap.scrollHeight;
    }
  });
}

export function clearLocalFrames(): void {
  state.buffer.length = 0;
  state.pending.length = 0;
  state.pausedHidden = 0;
  latest.clear();
  els.pausedCount.textContent = '0';
  clearSignalSamples();
  rebuildTable();
}

export function setAutoscroll(on: boolean): void {
  state.autoscroll = on;
  els.autoscrollCheck.checked = on;
  if (on) maybeScroll();
}

export function setPaused(p: boolean): void {
  if (state.paused === p) return;
  state.paused = p;
  els.btnPauseView.setAttribute('aria-pressed', String(p));
  els.btnPauseLabel.textContent = p ? '继续显示' : '暂停显示';
  /* 暂停时自动滚动无意义，禁用开关以免状态矛盾 */
  els.autoscrollCheck.disabled = p;
  if (p) {
    els.pausedCount.textContent = fmtInt(state.pausedHidden);
    els.pausedBadge.hidden = false;
  } else {
    state.pausedHidden = 0;
    els.pausedCount.textContent = '0';
    els.pausedBadge.hidden = true;
    rebuildTable();
  }
}
