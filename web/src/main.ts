/**
 * 启动入口：绑定事件、首次渲染、并发加载状态/设备/录制/健康检查、建立 WS 与周期计时。
 */
import { els } from './dom';
import { initDbc } from './dbc';
import { bindEvents } from './events';
import { setRangeRowsChangedHandler } from './filters';
import { fmtDur } from './format';
import { initLogs } from './logs';
import { renderRecordings, loadRecordings } from './recordings';
import { loadDevices } from './devices';
import { updateSendControls, updateSendDlc } from './send';
import { state } from './state';
import { loadHealth, loadStatus, updateControls, updateEmpty, updateStrip } from './status';
import { connectWs } from './ws';

function tickTimers(): void {
  const st = state.status;
  if (st && st.recording.active && st.recording.started_at_ms !== null) {
    els.recActiveElapsed.textContent = fmtDur(Date.now() - st.recording.started_at_ms);
  }
}

function init(): void {
  /* 区间行增删后刷新按钮状态；注入以避免 filters ↔ status 直接互相 import */
  setRangeRowsChangedHandler(updateControls);
  bindEvents();
  initDbc();
  renderRecordings();
  updateStrip();
  updateEmpty();
  updateSendDlc();
  updateSendControls();
  void loadStatus();
  void loadDevices();
  void loadRecordings();
  void loadHealth();
  void initLogs();
  connectWs();
  window.setInterval(tickTimers, 1000);
}

void init();
