/**
 * 设备与链路发现：刷新 USB 设备列表（自动打开用）与 SocketCAN 链路列表，
 * 渲染带来源标记与独立速率下拉的链路行。
 */
import { fetchDevices } from './api';
import { els } from './dom';
import { refreshFilterChannels } from './filters';
import { errText, fmtScanMeta } from './format';
import { state } from './state';
import { updateControls } from './status';
import { toast } from './toast';
import type { SocketCanLinkDto } from './types';

/** 链路速率可选项（bps），与后端 1000–1000000 的校验范围一致。 */
const SCAN_BITRATES = [10000, 20000, 50000, 100000, 125000, 250000, 500000, 800000, 1000000] as const;

/** 速率非法/未知时回退 500000。 */
function clampScanRate(value: number | null): number {
  return value !== null && Number.isFinite(value) && value >= 1000 && value <= 1_000_000
    ? value
    : 500_000;
}

/** 用户选择优先，其次链路已知 bitrate，最后 500000。 */
function effectiveScanRate(link: SocketCanLinkDto): number {
  return clampScanRate(state.scanRates.get(link.name) ?? link.bitrate);
}

/** 链路行的附加文案：优先用实时状态判断运行中，避免必须刷新设备列表。 */
function scanMetaText(link: SocketCanLinkDto): string {
  const live =
    state.status?.channels.find(
      (ch) => ch.source === 'socketcan' && ch.name === link.name
    ) ?? null;
  const running = live !== null ? live.running : link.running;
  return fmtScanMeta(live?.bitrate ?? link.bitrate, running, live?.state ?? link.state);
}

/** 渲染 SocketCAN 发现列表；勾选写入 scanSelected、速率写入 scanRates，刷新时按名字恢复。 */
export function renderScanList(): void {
  const frag = document.createDocumentFragment();
  for (const link of state.socketcan) {
    const item = document.createElement('div');
    item.className = 'scan-item ch-row';
    const checked = state.scanSelected.has(link.name);
    item.classList.toggle('is-on', checked);

    const pick = document.createElement('label');
    pick.className = 'scan-pick';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'scan-check';
    input.value = link.name;
    input.checked = checked;

    const src = document.createElement('span');
    src.className = 'src-tag scan-src';
    src.textContent = 'socket';

    const name = document.createElement('span');
    name.className = 'scan-name';
    name.textContent = link.name;

    pick.append(input, src, name);

    const rate = document.createElement('select');
    rate.className = 'input ch-rate scan-rate';
    rate.setAttribute('aria-label', link.name + ' 速率');
    const selectedRate = effectiveScanRate(link);
    for (const bps of SCAN_BITRATES) {
      const option = document.createElement('option');
      option.value = String(bps);
      option.textContent = bps / 1000 + ' kbps';
      option.selected = bps === selectedRate;
      rate.appendChild(option);
    }

    const meta = document.createElement('span');
    meta.className = 'scan-meta';
    meta.textContent = scanMetaText(link);
    const live =
      state.status?.channels.find(
        (ch) => ch.source === 'socketcan' && ch.name === link.name
      ) ?? null;
    meta.classList.toggle('running', live !== null ? live.running : link.running);

    /* 勾选只影响本地集合；启动/配置仍由「应用配置并启动」统一提交 */
    input.addEventListener('change', () => {
      if (input.checked) state.scanSelected.add(link.name);
      else state.scanSelected.delete(link.name);
      item.classList.toggle('is-on', input.checked);
      updateControls();
    });

    rate.addEventListener('change', () => {
      const bitrate = Number(rate.value);
      if (Number.isFinite(bitrate) && bitrate >= 1000 && bitrate <= 1_000_000) {
        state.scanRates.set(link.name, bitrate);
      } else {
        state.scanRates.delete(link.name);
      }
    });

    item.append(pick, rate, meta);
    frag.appendChild(item);
  }
  els.scanList.replaceChildren(frag);
  els.scanEmpty.hidden = state.socketcan.length > 0;
}

/** 刷新 USB 设备与 SocketCAN 链路；USB 设备仅用于配置前自动打开。 */
export async function loadDevices(): Promise<void> {
  try {
    const res = await fetchDevices();
    state.devices = res.devices;
    /* 只更新发现结果；scanSelected/scanRates 保留，暂时消失的链路配置不丢失 */
    state.socketcan = res.socketcan;
    state.selectedDevice = state.devices.length > 0 ? state.devices[0].index : null;
    renderScanList();
    refreshFilterChannels();
    updateControls();
  } catch (err) {
    toast(errText(err), 'error');
  }
}
