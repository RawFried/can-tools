/**
 * 报文管线：收帧入缓冲、rAF 批量上屏、快速过滤、表格裁剪与滚动钉底、暂停/清空视图。
 */
import { feedDbcFrames, clearDbcSamples } from './dbc';
import { els, rowTplRow } from './dom';
import { fmtClock, fmtInt, hexOf } from './format';
import { BUFFER_CAP, state } from './state';
import { updateEmpty, updateStrip } from './status';
import type { FrameDto } from './types';

/** 收帧入缓冲（上限 BUFFER_CAP）；未暂停时并入待渲染队列，交由 rAF 批量上屏。 */
export function acceptFrames(frames: FrameDto[]): void {
  if (frames.length === 0) return;
  /* 先喂 DBC 曲线：暂停表格显示时曲线仍需继续更新 */
  feedDbcFrames(frames);
  for (const f of frames) state.buffer.push(f);
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
  const frag = document.createDocumentFragment();
  for (const f of batch) {
    if (matchesFilter(f)) frag.appendChild(buildRow(f));
  }
  if (frag.childNodes.length > 0) els.framesBody.appendChild(frag);
  trimRows();
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
  if (info !== null && info.source === 'socketcan') badge.className = 'ch-badge ch-scan';
  else if (f.channel === 0 || f.channel === 1) badge.className = 'ch-badge ch' + f.channel;
  else badge.className = 'ch-badge chx';
  badge.textContent =
    info !== null
      ? info.name
      : f.channel === 0
        ? 'CAN1'
        : f.channel === 1
          ? 'CAN2'
          : 'CH' + (f.channel + 1);
  row.cells[2].appendChild(badge);

  row.cells[3].textContent = hexOf(f.id, f.extended ? 8 : 3);
  const baseType = f.extended ? '扩展' : '标准';
  row.cells[4].textContent = f.remote ? baseType + '·远程' : baseType;
  row.cells[5].textContent = String(f.dlc);
  row.cells[6].textContent = f.data.length > 0 ? f.data : '—';

  if (f.remote) row.classList.add('remote');
  return row;
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
    f.data,
    baseType,
    f.remote ? '远程' : '',
  ]
    .join(' ')
    .toLowerCase();
  return hay.includes(query);
}

/** 由本地缓冲整体重建表格（过滤条件变化、恢复显示、快照到达时调用）。 */
export function rebuildTable(): void {
  const frag = document.createDocumentFragment();
  for (const f of state.buffer) {
    if (matchesFilter(f)) frag.appendChild(buildRow(f));
  }
  els.framesBody.replaceChildren(frag);
  trimRows();
  updateEmpty();
  updateStrip();
  maybeScroll();
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
  els.pausedCount.textContent = '0';
  clearDbcSamples();
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
  els.icPause.hidden = p;
  els.icPlay.hidden = !p;
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
