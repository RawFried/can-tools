/**
 * 事件绑定汇总：把各模块的 handler 挂到 DOM/窗口事件上，保持原有绑定顺序与语义。
 */
import {
  clearFrames,
  startRecording,
  stopRecording,
} from './api';
import { initChannelPanel, selectChannel, setChannelRate, startChannel, stopChannel } from './channels';
import { els } from './dom';
import { fmtInt } from './format';
import { loadDevices } from './devices';
import { loadRecordings } from './recordings';
import { acceptAllRanges, addRangeRow, applyFiltersLive } from './filters';
import { clearLocalFrames, rebuildTable, setAutoscroll, setPaused } from './frames';
import { applyStatus, runBusy } from './status';
import { applySendType, sendCurrentFrame, updateSendControls, updateSendDlc } from './send';
import { state } from './state';
import { setLastLog, toast } from './toast';
import { connectWs } from './ws';

export function bindEvents(): void {
  els.btnRefreshDevices.addEventListener('click', () => {
    void runBusy(els.btnRefreshDevices, loadDevices);
  });

  els.channelSelect.addEventListener('change', () => {
    selectChannel(els.channelSelect.value);
  });

  els.channelRate.addEventListener('change', () => {
    setChannelRate(els.channelRate.value);
  });

  els.btnChannelStart.addEventListener('click', () => {
    void runBusy(els.btnChannelStart, () => startChannel(applyStatus));
  });

  els.btnChannelStop.addEventListener('click', () => {
    void runBusy(els.btnChannelStop, () => stopChannel(applyStatus));
  });

  els.btnAcceptAll.addEventListener('click', () => {
    acceptAllRanges();
  });

  els.btnApplyFilters.addEventListener('click', () => {
    void runBusy(els.btnApplyFilters, () => applyFiltersLive(applyStatus));
  });

  els.btnAddFilter.addEventListener('click', () => {
    addRangeRow();
  });

  els.btnRecStart.addEventListener('click', () => {
    void runBusy(els.btnRecStart, async () => {
      const { status, file } = await startRecording();
      if (status) applyStatus(status);
      toast('开始录制：' + file, 'success');
      await loadRecordings();
    });
  });

  els.btnRecStop.addEventListener('click', () => {
    void runBusy(els.btnRecStop, async () => {
      const { status, file, frames } = await stopRecording();
      if (status) applyStatus(status);
      const frameText = frames === null ? '—' : fmtInt(frames);
      toast('已保存 ' + file + ' （' + frameText + ' 帧）', 'success');
      await loadRecordings();
    });
  });

  els.btnRefreshRecordings.addEventListener('click', () => {
    void runBusy(els.btnRefreshRecordings, loadRecordings);
  });

  els.btnPauseView.addEventListener('click', () => {
    setPaused(!state.paused);
  });

  els.btnClearView.addEventListener('click', () => {
    void runBusy(els.btnClearView, async () => {
      await clearFrames();
      clearLocalFrames();
      setLastLog('已清空实时缓冲');
    });
  });

  els.frameFilter.addEventListener('input', () => {
    state.filter = els.frameFilter.value.trim().toLowerCase();
    rebuildTable();
  });

  els.autoscrollCheck.addEventListener('change', () => {
    setAutoscroll(els.autoscrollCheck.checked);
  });

  /* 发送报文 */
  els.sendChannel.addEventListener('change', updateSendControls);
  els.sendId.addEventListener('input', updateSendControls);
  els.sendData.addEventListener('input', () => {
    updateSendDlc();
    updateSendControls();
  });
  els.sendDlc.addEventListener('input', updateSendControls);
  els.sendRemote.addEventListener('change', () => {
    if (els.sendRemote.checked) els.sendDlc.value = '0';
    updateSendDlc();
    updateSendControls();
  });
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="send-ext"]')) {
    radio.addEventListener('change', applySendType);
  }
  for (const input of [els.sendId, els.sendData]) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (!els.btnSend.disabled) els.btnSend.click();
      }
    });
  }
  els.btnSend.addEventListener('click', () => {
    void runBusy(els.btnSend, () => sendCurrentFrame(applyStatus));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.defaultPrevented) return;
    const t = e.target;
    if (
      t instanceof HTMLInputElement ||
      t instanceof HTMLTextAreaElement ||
      t instanceof HTMLSelectElement ||
      (t instanceof HTMLElement && t.isContentEditable)
    ) {
      return;
    }
    e.preventDefault();
    els.frameFilter.scrollIntoView({ block: 'center' });
    els.frameFilter.focus();
    els.frameFilter.select();
  });

  window.addEventListener('online', () => {
    const ws = state.ws;
    if (!ws || ws.readyState > 1) connectWs();
  });

  /* 首个状态到达前先渲染通道卡；状态到达后由 applyStatus → syncChannels 同步 */
  initChannelPanel();
}
