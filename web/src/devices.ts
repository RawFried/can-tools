/**
 * 设备连接卡片：设备列表加载与渲染、单选状态、打开/关闭按钮的可用性联动。
 */
import { fetchDevices } from './api';
import { els } from './dom';
import { errText } from './format';
import { state } from './state';
import { updateControls } from './status';
import { toast } from './toast';

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
  updateControls();
}

export async function loadDevices(): Promise<void> {
  try {
    state.devices = await fetchDevices();
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
