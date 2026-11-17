/**
 * 通道卡（v6）：选一个通道 → 显示其速率/运行状态/模式，并单独启动或停止。
 * 依赖单向：channels → {filters, state, dom, api, filters-model, format, toast, types}。
 */
import { applyConfig, fetchDevices, openDevice, stopChannels } from './api';
import { els } from './dom';
import { channelKey, deriveAcceptanceFilter, renderHwPrefilter, renderRangesFor, saveCurrentRanges, syncFilters } from './filters';
import { state } from './state';
import { toast } from './toast';
import { displayChannelName, fmtRate } from './format';
import { asBaud, asMode, BAUDS } from './types';
import type { CanMode, ChannelStatusDto, SocketCanLinkDto, StatusDto } from './types';

interface ChannelOption {
  key: string;
  label: string;
  channel: ChannelStatusDto | null;
  link: SocketCanLinkDto | null;
}

/** 由 status.channels 与已发现链路合并选项：去重、状态通道优先、顺序稳定。 */
function channelOptions(st: StatusDto | null): ChannelOption[] {
  const options: ChannelOption[] = [];
  const seen = new Set<string>();
  /* 未检测到（也未打开）USB 设备时不展示 USB 通道，避免拔出后仍可选。 */
  const usbAvailable = st?.device.open === true || state.devices.length > 0;
  for (const ch of st?.channels ?? []) {
    if (ch.source === 'usb' && !usbAvailable) continue;
    const key = channelKey(ch);
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({
      key,
      label: (ch.source === 'usb' ? 'USB · ' : 'SOCKET · ') + displayChannelName(ch.name),
      channel: ch,
      link: null,
    });
  }
  for (const link of state.socketcan) {
    const key = 'scan:' + link.name;
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ key, label: 'SOCKET · ' + displayChannelName(link.name), channel: null, link });
  }
  return options;
}

function optionForKey(st: StatusDto | null, key: string): ChannelOption | null {
  return channelOptions(st).find((option) => option.key === key) ?? null;
}

/** 当前选中且已在 status 中注册的通道（仅发现未启动的链路返回 null）。 */
export function selectedChannel(st: StatusDto | null): ChannelStatusDto | null {
  if (st === null || state.channelKey === null) return null;
  const key = state.channelKey;
  return st.channels.find((ch) => channelKey(ch) === key) ?? null;
}

/** 选中失效时回退：当前选中 → 首个运行通道 → usb:0 → 首个选项。 */
function ensureChannel(st: StatusDto | null): boolean {
  const options = channelOptions(st);
  const keys = options.map((option) => option.key);
  if (state.channelKey !== null && keys.includes(state.channelKey)) return false;
  /* 状态未到达时只保留已发现链路的用户选择，不自动挑默认通道 */
  if (st === null) {
    if (state.channelKey === null) return false;
    state.channelKey = null;
    return true;
  }
  const running = st.channels.find((ch) => ch.running) ?? null;
  const next =
    running !== null ? channelKey(running) : keys.includes('usb:0') ? 'usb:0' : options[0]?.key ?? null;
  if (next === state.channelKey) return false;
  state.channelKey = next;
  return true;
}

function labelFromBitrate(bitrate: number | null): string {
  if (bitrate === null || !Number.isFinite(bitrate) || bitrate <= 0) return '500k';
  const label = Math.round(bitrate / 1000) + 'k';
  return (BAUDS as readonly string[]).includes(label) ? label : '500k';
}

function bitrateFromLabel(label: string): number {
  const match = /^(\d+)k$/.exec(label);
  const bps = match ? Number(match[1]) * 1000 : NaN;
  return Number.isFinite(bps) && bps >= 1000 && bps <= 1_000_000 ? bps : 500_000;
}

/** 速率标签初始化：已有用户选择优先，其次状态 baud/bitrate，最后 500k。 */
function ensureRate(st: StatusDto | null, key: string): string {
  const existing = state.rates.get(key);
  if (existing !== undefined) return existing;
  const option = optionForKey(st, key);
  const ch = option?.channel ?? null;
  let label = '500k';
  if (ch !== null) {
    label = ch.source === 'usb' ? asBaud(ch.baud) ?? '500k' : labelFromBitrate(ch.bitrate);
  } else if (option?.link) {
    label = labelFromBitrate(option.link.bitrate);
  }
  state.rates.set(key, label);
  return label;
}

let optionsSignature: string | null = null;

function renderChannelOptions(st: StatusDto | null): void {
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
    els.channelSelect.replaceChildren(frag);
  }
  els.channelSelect.value = state.channelKey ?? '';
}

function buildRateOptions(): void {
  if (els.channelRate.options.length > 0) return;
  const frag = document.createDocumentFragment();
  for (const label of BAUDS) {
    const option = document.createElement('option');
    option.value = label;
    option.textContent = label.slice(0, -1) + ' kbps';
    frag.appendChild(option);
  }
  els.channelRate.replaceChildren(frag);
}

function renderChannelRate(st: StatusDto | null): void {
  buildRateOptions();
  if (state.channelKey === null) {
    els.channelRate.disabled = true;
    return;
  }
  els.channelRate.disabled = false;
  els.channelRate.value = ensureRate(st, state.channelKey);
}

/** 运行速率优先取状态回报；状态无速率时回退用户选择。 */
function statusRate(st: StatusDto | null, key: string, option: ChannelOption | null): string {
  const ch = option?.channel ?? null;
  if (ch !== null) {
    if (ch.source === 'usb') return asBaud(ch.baud) ?? ensureRate(st, key);
    return ch.bitrate !== null ? labelFromBitrate(ch.bitrate) : ensureRate(st, key);
  }
  if (option?.link && option.link.bitrate !== null) return labelFromBitrate(option.link.bitrate);
  return ensureRate(st, key);
}

function renderChannelState(st: StatusDto | null): void {
  const key = state.channelKey;
  if (key === null) {
    els.channelState.textContent = '未选择通道';
    els.channelState.classList.remove('running');
    return;
  }
  const option = optionForKey(st, key);
  const ch = option?.channel ?? null;
  const link = option?.link ?? null;
  const running = ch !== null ? ch.running : link !== null && link.running;
  els.channelState.classList.toggle('running', running);

  if (running) {
    const parts = ['运行中 · ' + statusRate(st, key, option)];
    /* 统计由后端每秒推送；只有已注册到 status 的通道才有 metrics。 */
    if (ch !== null) {
      parts.push(fmtRate(ch.metrics.rx_rate) + ' 帧/秒');
      if (ch.metrics.bus_load !== null) parts.push('负载 ' + fmtRate(ch.metrics.bus_load) + '%');
    }
    els.channelState.textContent = parts.join(' · ');
    return;
  }
  const ifaceState = ch !== null && ch.source === 'socketcan' ? ch.state : link?.state ?? null;
  const isSocket = ch !== null ? ch.source === 'socketcan' : link !== null;
  els.channelState.textContent = isSocket && ifaceState !== 'up' ? '未启用' : '已停止';
}

/** USB 显示工作模式；SocketCAN 隐藏。未运行时保留用户当前选择。 */
function renderModeField(st: StatusDto | null): void {
  const key = state.channelKey;
  const isUsb = key !== null && key.startsWith('usb:');
  els.modeField.hidden = !isUsb;
  if (!isUsb || key === null) return;
  const ch = optionForKey(st, key)?.channel ?? null;
  if (ch === null || !ch.running || ch.mode === null) return;
  const radio = document.querySelector<HTMLInputElement>(
    'input[name="mode"][value="' + ch.mode + '"]'
  );
  if (radio) radio.checked = true;
}

function selectedMode(): CanMode {
  const checked = document.querySelector<HTMLInputElement>('input[name="mode"]:checked');
  return checked ? asMode(checked.value) ?? 'normal' : 'normal';
}

/** 状态推送时同步通道选项、速率、状态行、模式与滤波区。 */
export function syncChannels(st: StatusDto): void {
  ensureChannel(st);
  syncFilters(st);
  renderChannelOptions(st);
  if (state.channelKey !== null) ensureRate(st, state.channelKey);
  renderChannelRate(st);
  renderChannelState(st);
  renderModeField(st);
  renderHwPrefilter(st);
}

/** 首个状态到达前初始化通道卡（占位/已发现链路可选）。 */
export function initChannelPanel(): void {
  const st = state.status;
  if (st !== null) {
    syncChannels(st);
    return;
  }
  ensureChannel(null);
  renderChannelOptions(null);
  renderChannelRate(null);
  renderChannelState(null);
  renderModeField(null);
  /* 状态未到达时先清空区间；首次 syncFilters 会按当前通道重绘 */
  renderRangesFor(null);
}

/** 设备/链路发现刷新后更新通道选项与选中态。 */
export function refreshChannelOptions(): void {
  const st = state.status;
  if (st !== null) {
    syncChannels(st);
    return;
  }
  renderChannelOptions(null);
}

/** 用户切换通道：先保存当前 DOM 区间，再渲染目标通道。 */
export function selectChannel(key: string): void {
  if (key === state.channelKey) return;
  const st = state.status;
  if (optionForKey(st, key) === null) {
    els.channelSelect.value = state.channelKey ?? '';
    return;
  }
  const ranges = saveCurrentRanges();
  if (ranges === null) {
    els.channelSelect.value = state.channelKey ?? '';
    return;
  }
  state.channelKey = key;
  ensureRate(st, key);
  renderChannelOptions(st);
  renderChannelRate(st);
  renderChannelState(st);
  renderModeField(st);
  renderRangesFor(key);
  if (st !== null) renderHwPrefilter(st);
}

/** 速率下拉变化：写入 state.rates，下次启动/重启时生效。 */
export function setChannelRate(label: string): void {
  if (state.channelKey === null) return;
  state.rates.set(state.channelKey, asBaud(label) ?? '500k');
}

/**
 * 主动探测一次 USB 设备与 SocketCAN 链路，更新可选通道。
 * 刷新按钮、页面启动与启动通道前都会调用，避免插拔后列表过期。
 */
export async function probeDevices(): Promise<void> {
  const res = await fetchDevices();
  state.devices = res.devices;
  state.socketcan = res.socketcan;
  state.selectedDevice = state.devices.length > 0 ? state.devices[0].index : null;
  refreshChannelOptions();
}

/** 启动/重启当前通道；USB 设备未打开时先用首个已发现设备自动打开。 */
export async function startChannel(applyStatus: (st: StatusDto) => void): Promise<void> {
  const st = state.status;
  const key = state.channelKey;
  if (key === null) {
    toast('请先选择一个通道', 'warn');
    return;
  }
  const option = optionForKey(st, key);
  if (option === null) {
    toast('选中的通道不可用，请刷新设备与链路', 'warn');
    return;
  }
  const ranges = saveCurrentRanges();
  if (ranges === null) return;
  const rate = ensureRate(st, key);

  if (key.startsWith('usb:')) {
    const index = Number(key.slice(4));
    if (index !== 0 && index !== 1) {
      toast('USB 通道编号无效', 'warn');
      return;
    }
    if (st?.device.open !== true) {
      /* 启动前主动探测一次，插入设备后无需先点刷新 */
      await probeDevices().catch(() => undefined);
      const first = state.devices[0];
      if (!first) {
        toast('未检测到 USBCAN 设备', 'error');
        return;
      }
      const opened = await openDevice(first.index);
      if (opened) applyStatus(opened);
    }
    const status = await applyConfig({
      usb: [
        {
          index,
          baud: asBaud(rate) ?? '500k',
          filter: deriveAcceptanceFilter(ranges),
          software_filters: ranges,
        },
      ],
      socketcan: [],
      mode: selectedMode(),
    });
    if (status) applyStatus(status);
    toast('已启动 ' + option.label, 'success');
    return;
  }

  const name = key.startsWith('scan:') ? key.slice(5) : '';
  if (name.length === 0) {
    toast('链路名称无效', 'warn');
    return;
  }
  const status = await applyConfig({
    usb: [],
    socketcan: [{ name, bitrate: bitrateFromLabel(rate), software_filters: ranges }],
    mode: 'normal',
  });
  if (status) applyStatus(status);
  toast('已启动 ' + option.label, 'success');
}

/** 停止当前运行中的通道。 */
export async function stopChannel(applyStatus: (st: StatusDto) => void): Promise<void> {
  const ch = selectedChannel(state.status);
  if (ch === null || !ch.running) {
    toast('当前通道未运行', 'warn');
    return;
  }
  const status = await stopChannels([ch.index]);
  if (status) applyStatus(status);
  toast('已停止 ' + displayChannelName(ch.name), 'success');
}
