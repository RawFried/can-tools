/**
 * 状态渲染与控件可用性：applyStatus/updateControls/updateStrip/updateEmpty、
 * 统计与通道卡；以及以按钮 busy 态执行异步操作的 runBusy。
 */
import { fetchHealthVersion, fetchStatus } from './api';
import { renderChannelStats } from './channel-stats';
import { selectedChannel, syncChannels } from './channels';
import { els } from './dom';
import { MAX_RANGE_ROWS, rangeRowCount } from './filters';
import { errText, fmtDur, fmtInt } from './format';
import { syncSendChannels, updateSendControls } from './send';
import { BUFFER_CAP, busy, state } from './state';
import { toast } from './toast';
import type { StatusDto } from './types';

/** 将服务端 StatusDto 应用到顶栏、通道状态、录制、通道统计与全部控件可用性。 */
export function applyStatus(st: StatusDto): void {
  state.status = st;

  /* 顶栏设备胶囊：序列号为空（或仅填充字符）时不显示 S/N 段 */
  const info = st.device.info;
  if (st.device.open && info) {
    els.devicePillDot.className = 'pill-dot ok';
    let pillText: string;
    if (info.serial) {
      pillText = [info.hw_type, 'S/N ' + info.serial].filter((s) => s.length > 0).join(' · ');
    } else {
      pillText = ['已连接', info.hw_type].filter((s) => s.length > 0).join(' · ');
    }
    els.devicePillText.textContent = pillText || '设备已连接';
  } else {
    els.devicePillDot.className = 'pill-dot';
    els.devicePillText.textContent = '未连接设备';
  }

  /* 通道卡：选项、速率、状态行、模式与滤波区（channels 内部联动 filters） */
  syncChannels(st);

  /* 录制 */
  els.recActive.hidden = !st.recording.active;
  els.recPill.hidden = !st.recording.active;
  if (st.recording.active) {
    els.recActiveFile.textContent = st.recording.file ?? '—';
    els.recActiveFrames.textContent = fmtInt(st.recording.frames ?? 0);
    if (st.recording.started_at_ms !== null) {
      els.recActiveElapsed.textContent = fmtDur(Date.now() - st.recording.started_at_ms);
    }
  }
  /* 录制目录：输入框聚焦时不回填，避免打断正在编辑的内容 */
  if (document.activeElement !== els.dataDirInput) {
    els.dataDirInput.value = st.server.recordings_dir;
  }

  /* 通道统计（运行中通道的帧率与总线负载）与发送计数 */
  renderChannelStats(st.channels);
  els.sendCount.textContent = fmtInt(st.stats.tx_frames);

  syncSendChannels(st);

  /* 版本 */
  if (st.server.version) els.versionLabel.textContent = 'v' + st.server.version;

  updateControls();
  updateEmpty();
}

/** 依据当前状态计算各按钮的可用性（busy 中的按钮保持禁用）。 */
export function updateControls(): void {
  const st = state.status;
  const anyRunning = st !== null && st.channels.some((c) => c.running);
  const recActive = st !== null && st.recording.active;
  const target = selectedChannel(st);
  const targetRunning = target !== null && target.running;
  const hasChannel = state.channelKey !== null;

  els.btnChannelStart.disabled = !hasChannel;
  els.btnChannelStop.disabled = !targetRunning;
  els.btnApplyFilters.disabled = !targetRunning;
  els.btnAcceptAll.disabled = !hasChannel;
  els.btnRecStart.disabled = !anyRunning || recActive;
  els.btnRecStop.disabled = !recActive;
  els.btnPauseView.disabled = !anyRunning;

  /* 区间行数达到上限时禁用「添加」，并维护空列表占位提示 */
  const rangeCount = rangeRowCount();
  els.btnAddFilter.disabled = !hasChannel || rangeCount >= MAX_RANGE_ROWS;
  els.filterEmpty.hidden = rangeCount > 0;

  /* 异步进行中的按钮保持禁用，避免状态推送期间被重新启用 */
  for (const b of busy) b.disabled = true;

  updateSendControls();
}

export function updateStrip(): void {
  els.visibleCount.textContent = '显示 ' + fmtInt(els.framesBody.rows.length) + ' 行';
  els.bufferUsage.textContent = '缓冲 ' + fmtInt(state.buffer.length) + ' / ' + fmtInt(BUFFER_CAP);
}

export function updateEmpty(): void {
  const hasRows = els.framesBody.rows.length > 0;
  els.frameEmpty.hidden = hasRows;
  if (hasRows) return;

  const st = state.status;
  const running = st !== null && st.channels.some((c) => c.running);

  if (state.buffer.length > 0 && state.filter) {
    els.emptyTitle.textContent = '没有匹配的报文';
    els.emptyHint.textContent = '当前过滤条件未匹配任何报文，试着调整或清空过滤输入。';
  } else if (running) {
    els.emptyTitle.textContent = '等待 CAN 报文';
    els.emptyHint.textContent = '通道已启动，尚未收到报文；请确认总线波特率一致、滤波器未全部滤除。';
  } else {
    els.emptyTitle.textContent = '通道未启动';
    els.emptyHint.textContent = '选择通道与速率，然后点击「启动通道」。';
  }
}

/* ---------- 异步操作 ---------- */

/** 以按钮 busy 态执行异步操作：期间禁用按钮，失败统一弹出错误提示。 */
export async function runBusy(btn: HTMLButtonElement, fn: () => Promise<void>): Promise<void> {
  if (btn.disabled || busy.has(btn)) return;
  busy.add(btn);
  btn.disabled = true;
  btn.classList.add('busy');
  btn.setAttribute('aria-busy', 'true');
  try {
    await fn();
  } catch (err) {
    toast(errText(err), 'error');
  } finally {
    busy.delete(btn);
    btn.classList.remove('busy');
    btn.removeAttribute('aria-busy');
    /* 一次性按钮（如刷新设备）必须显式恢复可用，否则 updateControls 无法将其解锁 */
    btn.disabled = false;
    updateControls();
  }
}

/* ---------- 初始加载 ---------- */

export async function loadStatus(): Promise<void> {
  try {
    const st = await fetchStatus();
    if (!st) throw new Error('状态响应格式异常');
    applyStatus(st);
  } catch (err) {
    toast(errText(err), 'error');
  }
}

export async function loadHealth(): Promise<void> {
  try {
    const version = await fetchHealthVersion();
    if (version !== null && !state.status) {
      els.versionLabel.textContent = 'v' + version;
    }
  } catch (err) {
    toast(errText(err), 'error');
  }
}
