/**
 * 设备连接卡片：设备列表加载与渲染、单选状态、打开/关闭按钮的可用性联动。
 */
import { fetchDevices } from './api';
import { els } from './dom';
import { errText, fmtScanMeta } from './format';
import { state } from './state';
import { updateControls } from './status';
import { toast } from './toast';
import type { SocketCanLinkDto } from './types';

/** 链路行的附加文案：优先用实时状态判断运行中，避免必须刷新设备列表。 */
function scanMetaText(link: SocketCanLinkDto): string {
  const live =
    state.status?.channels.find(
      (ch) => ch.source === 'socketcan' && ch.name === link.name
    ) ?? null;
  const running = live !== null ? live.running : link.running;
  return fmtScanMeta(
    live?.bitrate ?? link.bitrate,
    live?.state ?? link.state,
    running
  );
}

/** 渲染 SocketCAN 发现列表；勾选写入 scanSelected，刷新时按名字恢复。 */
export function renderScanList(): void {
  const frag = document.createDocumentFragment();
  for (const link of state.socketcan) {
    const item = document.createElement('label');
    item.className = 'scan-item';
    const checked = state.scanSelected.has(link.name);
    item.classList.toggle('is-on', checked);

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'scan-check';
    input.value = link.name;
    input.checked = checked;

    const name = document.createElement('span');
    name.className = 'scan-name';
    name.textContent = link.name;

    const meta = document.createElement('span');
    meta.className = 'scan-meta';
    meta.textContent = scanMetaText(link);

    /* 勾选态只影响本地集合；启动/配置仍由「应用配置并启动」统一提交 */
    input.addEventListener('change', () => {
      if (input.checked) state.scanSelected.add(link.name);
      else state.scanSelected.delete(link.name);
      item.classList.toggle('is-on', input.checked);
      updateControls();
    });

    item.append(input, name, meta);
    frag.appendChild(item);
  }
  els.scanList.replaceChildren(frag);
  els.scanEmpty.hidden = state.socketcan.length > 0;
}

export function renderDevices(): void {
  const frag = document.createDocumentFragment();
  for (const dev of state.devices) {
    const item = document.createElement('label');
    item.className = 'device-item';

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'device';
    input.value = String(dev.index);
    input.id = 'dev-radio-' + dev.index;

    const meta = document.createElement('div');
    meta.className = 'device-meta';

    const name = document.createElement('span');
    name.className = 'device-name';
    name.textContent = 'USBCAN-II #' + dev.index;

    const sub = document.createElement('span');
    sub.className = 'device-sub';
    const subParts = [dev.channel_count + ' 通道', dev.hw_type];
    if (dev.fw_version) subParts.push('固件 ' + dev.fw_version);
    if (dev.serial) subParts.push('S/N ' + dev.serial);
    sub.textContent = subParts.filter((s) => s.length > 0).join(' · ');

    meta.append(name, sub);
    item.append(input, meta);

    const open = state.status !== null && state.status.device.open;
    input.checked = state.selectedDevice === dev.index;
    input.disabled = open;
    item.classList.toggle('selected', input.checked);
    item.htmlFor = input.id;
    frag.appendChild(item);
  }
  els.deviceList.replaceChildren(frag);
  els.deviceEmpty.hidden = state.devices.length > 0;
  renderScanList();
  updateControls();
}

export async function loadDevices(): Promise<void> {
  try {
    const res = await fetchDevices();
    state.devices = res.devices;
    /* 只更新发现结果；scanSelected 保留，已勾选但暂时消失的链路名不丢失 */
    state.socketcan = res.socketcan;
    const st = state.status;
    const openIdx = st !== null && st.device.open && st.device.info ? st.device.info.index : null;
    if (openIdx !== null) {
      state.selectedDevice = openIdx;
    } else if (state.selectedDevice === null || !state.devices.some((d) => d.index === state.selectedDevice)) {
      state.selectedDevice = state.devices.length > 0 ? state.devices[0].index : null;
    }
    renderDevices();
  } catch (err) {
    toast(errText(err), 'error');
  }
}
