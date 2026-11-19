/**
 * 启动入口：绑定事件、首次渲染、并发加载状态/设备/录制/健康检查、建立 WS 与周期计时。
 */
import { initBackdrop, refreshBackdropTheme } from './backdrop';
import { els } from './dom';
import { initSignals, refreshSignalThemes } from './signals';
import { bindEvents } from './events';
import { setRangeRowsChangedHandler } from './filters';
import { fmtDur } from './format';
import { renderRecordings, loadRecordings } from './recordings';
import { loadDevices } from './devices';
import { updateSendControls, updateSendDlc } from './send';
import { state } from './state';
import { loadHealth, loadStatus, updateControls, updateEmpty, updateStrip } from './status';
import { initTheme, onThemeChange } from './theme';
import { connectWs } from './ws';

function tickTimers(): void {
  const st = state.status;
  if (st && st.recording.active && st.recording.started_at_ms !== null) {
    els.recActiveElapsed.textContent = fmtDur(Date.now() - st.recording.started_at_ms);
  }
}

function init(): void {
  /* 主题先于背景初始化：背景色与曲线色板都从 CSS 变量解析 */
  initTheme();
  onThemeChange(() => {
    refreshSignalThemes();
    refreshBackdropTheme();
  });
  /* 区间行增删后刷新按钮状态；注入以避免 filters ↔ status 直接互相 import */
  setRangeRowsChangedHandler(updateControls);
  bindEvents();
  initBackdrop();
  initSignals();
  renderRecordings();
  updateStrip();
  updateEmpty();
  updateSendDlc();
  updateSendControls();
  void loadStatus();
  void loadDevices();
  void loadRecordings();
  void loadHealth();
  connectWs();
  window.setInterval(tickTimers, 1000);
}

void init();
