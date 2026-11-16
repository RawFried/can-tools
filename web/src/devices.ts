/**
 * 设备与链路发现：刷新 USB 设备列表（USB 启动前自动打开）与 SocketCAN 链路，
 * 并通知通道卡更新可选项。
 */
import { probeDevices } from './channels';
import { errText } from './format';
import { updateControls } from './status';
import { toast } from './toast';

export async function loadDevices(): Promise<void> {
  try {
    /* probeDevices 只更新发现结果；通道速率/区间选择由 state.rates/state.filters 保留 */
    await probeDevices();
    updateControls();
  } catch (err) {
    toast(errText(err), 'error');
  }
}
