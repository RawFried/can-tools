/**
 * 状态渲染与控件可用性：applyStatus/syncFormOnce/updateControls/updateStrip/updateEmpty、
 * 统计与通道状态；以及以按钮 busy 态执行异步操作的 runBusy。
 */
import { fetchHealthVersion, fetchStatus } from './api';
import { els } from './dom';
import { MAX_RANGE_ROWS, buildRangeRow, rangeRowCount, renderHwPrefilter, selectedChannels } from './filters';
import { errText, fmtBitrateShort, fmtDur, fmtInt, fmtRate, fmtScanMeta, linkStateLabel, MODE_LABELS } from './format';
import { syncSendChannels, updateSendControls } from './send';
import { BUFFER_CAP, busy, state } from './state';
import { toast } from './toast';
import type { StatusDto } from './types';

/** 将服务端 StatusDto 应用到顶栏、通道状态、录制、统计与全部控件可用性。 */
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
    els.deviceInfo.hidden = false;
    els.devHw.textContent = info.hw_type || '—';
    els.devFw.textContent = info.fw_version || '—';
    els.devSerial.textContent = info.serial || '—';
    els.devChannels.textContent = String(info.channel_count);
  } else {
    els.devicePillDot.className = 'pill-dot';
    els.devicePillText.textContent = '未连接设备';
    els.deviceInfo.hidden = true;
  }

  /* 通道状态 */
  for (const ch of st.channels) {
    const chip = ch.index === 0 ? els.chipCh1 : ch.index === 1 ? els.chipCh2 : null;
    const stateEl = ch.index === 0 ? els.chipCh1State : ch.index === 1 ? els.chipCh2State : null;
    const subEl = ch.index === 0 ? els.chipCh1Sub : ch.index === 1 ? els.chipCh2Sub : null;
    if (!chip || !stateEl || !subEl) continue;
    chip.classList.toggle('running', ch.running);
    stateEl.textContent = ch.running ? '运行中' : '已停止';
    subEl.textContent = ch.running && ch.baud ? ch.baud + ' · ' + MODE_LABELS[ch.mode ?? 'normal'] : '—';
  }
  renderScanStates(st);
  refreshScanMeta(st);

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
  els.dataDirLabel.textContent = st.server.data_dir || '—';

  /* 统计 */
  els.statRx.textContent = fmtInt(st.stats.rx_frames);
  els.statRate.textContent = fmtRate(st.stats.rx_rate);
  els.statFiltered.textContent = fmtInt(st.stats.filtered_frames);
  els.statRecorded.textContent = fmtInt(st.stats.recorded_frames);
  els.sendCount.textContent = fmtInt(st.stats.tx_frames);

  syncSendChannels(st);

  /* 版本 */
  if (st.server.version) els.versionLabel.textContent = 'v' + st.server.version;

  renderHwPrefilter(st);
  syncFormOnce(st);
  updateControls();
  updateEmpty();
}

/** 通道状态区的 SocketCAN 徽标：运行中加 .running，副文本显示速率或接口状态。 */
function renderScanStates(st: StatusDto): void {
  const links = st.channels.filter((ch) => ch.source === 'socketcan');
  const frag = document.createDocumentFragment();
  for (const ch of links) {
    const chip = document.createElement('span');
    chip.className = 'scan-chip';
    chip.classList.toggle('running', ch.running);

    const name = document.createElement('span');
    name.className = 'scan-chip-name';
    name.textContent = ch.name;

    const sub = document.createElement('span');
    sub.className = 'scan-chip-sub';
    if (ch.bitrate !== null) sub.textContent = fmtBitrateShort(ch.bitrate);
    else sub.textContent = ch.running ? '运行中' : linkStateLabel(ch.state);

    chip.append(name, sub);
    frag.appendChild(chip);
  }
  els.scanStates.replaceChildren(frag);
  els.scanStates.hidden = links.length === 0;
}

/** 状态推送时原地刷新链路列表的运行态文案；不重建复选框，避免打断用户操作。 */
function refreshScanMeta(st: StatusDto): void {
  for (const item of els.scanList.querySelectorAll<HTMLElement>('.scan-item')) {
    const check = item.querySelector<HTMLInputElement>('.scan-check');
    const meta = item.querySelector<HTMLElement>('.scan-meta');
    if (!check || !meta) continue;
    const name = check.value;
    const live = st.channels.find((ch) => ch.source === 'socketcan' && ch.name === name) ?? null;
    const known = state.socketcan.find((link) => link.name === name) ?? null;
    const running = live !== null ? live.running : known !== null && known.running;
    meta.textContent = fmtScanMeta(
      live?.bitrate ?? known?.bitrate ?? null,
      live?.state ?? known?.state ?? null,
      running
    );
  }
}

/** 依据当前状态计算各按钮的可用性（busy 中的按钮保持禁用）。 */
export function updateControls(): void {
  const st = state.status;
  const open = st !== null && st.device.open;
  const channels = st?.channels ?? [];
  const anyRunning = channels.some((c) => c.running);
  const recActive = st !== null && st.recording.active;
  const anyChannelChecked = els.ch1Check.checked || els.ch2Check.checked;
  const checkedChannels = selectedChannels();
  const allCheckedRunning =
    checkedChannels.length > 0 &&
    checkedChannels.every((index) => channels.some((c) => c.index === index && c.running));
  /* 滤波：勾选的 USB 通道全部运行；未勾选 USB 但仍有运行中的链路（可为 SocketCAN）时只更新软件滤波 */
  const filterAllowed = checkedChannels.length > 0 ? allCheckedRunning : anyRunning;

  els.btnOpenDevice.disabled = open || state.devices.length === 0 || state.selectedDevice === null;
  els.btnCloseDevice.disabled = !open;
  els.btnApplyConfig.disabled = !((open && anyChannelChecked) || state.scanSelected.size > 0);
  els.btnApplyFilters.disabled = !filterAllowed || (checkedChannels.length > 0 && !open);
  els.btnStopChannels.disabled = !anyRunning;
  els.btnRecStart.disabled = !(open || anyRunning) || recActive;
  els.btnRecStop.disabled = !recActive;
  els.btnPauseView.disabled = !anyRunning;

  /* 区间行数达到上限时禁用「添加」，并维护空列表占位提示 */
  const rangeCount = rangeRowCount();
  els.btnAddFilter.disabled = rangeCount >= MAX_RANGE_ROWS;
  els.filterEmpty.hidden = rangeCount > 0;

  /* 异步进行中的按钮保持禁用，避免状态推送期间被重新启用 */
  for (const b of busy) b.disabled = true;

  els.deviceList.classList.toggle('locked', open);
  updateSendControls();
}

/** 首个状态到达时，把运行中的 USB 通道配置回填到表单（仅一次，不覆盖用户后续编辑）。 */
export function syncFormOnce(st: StatusDto): void {
  if (state.formSynced) return;
  state.formSynced = true;

  /* 只回填 USB：SocketCAN 的速率由接口自身决定，勾选状态不受状态推送影响 */
  const usb = st.channels.filter((c) => c.source === 'usb');
  const running = usb.filter((c) => c.running);
  const ref = running.length > 0 ? running[0] : usb.length > 0 ? usb[0] : null;
  if (ref) {
    if (ref.baud) els.baudSelect.value = ref.baud;
    if (ref.mode) {
      const r = document.querySelector<HTMLInputElement>('input[name="mode"][value="' + ref.mode + '"]');
      if (r) r.checked = true;
    }
    if (running.length > 0) {
      els.ch1Check.checked = running.some((c) => c.index === 0);
      els.ch2Check.checked = running.some((c) => c.index === 1);
    } else {
      els.ch1Check.checked = ref.index === 0;
      els.ch2Check.checked = ref.index === 1;
    }
  }

  if (st.software_filters.length > 0) {
    const frag = document.createDocumentFragment();
    for (const f of st.software_filters) {
      frag.appendChild(buildRangeRow(f.extended, f.start, f.end));
    }
    els.filterRangeList.replaceChildren(frag);
  }
  updateControls();
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
  const open = st !== null && st.device.open;
  const running = st !== null && st.channels.some((c) => c.running);

  if (state.buffer.length > 0 && state.filter) {
    els.emptyTitle.textContent = '没有匹配的报文';
    els.emptyHint.textContent = '当前过滤条件未匹配任何报文，试着调整或清空过滤输入。';
  } else if (running) {
    els.emptyTitle.textContent = '等待 CAN 报文';
    els.emptyHint.textContent = '通道已启动，尚未收到报文；请确认总线波特率一致、滤波器未全部滤除。';
  } else if (!open) {
    els.emptyTitle.textContent = '未连接设备';
    els.emptyHint.textContent = '在左侧「设备连接」中选择设备并点击「打开设备」，或勾选 SocketCAN 链路后启动。';
  } else {
    els.emptyTitle.textContent = '通道未启动';
    els.emptyHint.textContent = '选择通道、波特率与滤波器，然后点击「应用配置并启动」。';
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
