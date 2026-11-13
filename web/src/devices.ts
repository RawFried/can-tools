/**
 * 设备与链路发现：刷新 USB 设备列表（USB 启动前自动打开）与 SocketCAN 链路，
 * 并通知通道卡更新可选项。
 */
import { fetchDevices } from './api';
import { refreshChannelOptions } from './channels';
import { errText } from './format';
import { state } from './state';
import { updateControls } from './status';
import { toast } from './toast';

export async function loadDevices(): Promise<void> {
  try {
    const res = await fetchDevices();
    state.devices = res.devices;
    /* 只更新发现结果；通道速率/区间选择由 state.rates/state.filters 保留 */
    state.socketcan = res.socketcan;
    state.selectedDevice = state.devices.length > 0 ? state.devices[0].index : null;
    refreshChannelOptions();
    updateControls();
  } catch (err) {
    toast(errText(err), 'error');
  }
}
