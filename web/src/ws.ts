/**
 * WebSocket 数据链路：连接/指数退避重连、心跳、WS 消息分发（status/frames/log/cleared）。
 */
import { loadDevices } from './devices';
import { els } from './dom';
import { applySignalEvent, applySignalSnapshot } from './signals';
import { acceptFrames, clearLocalFrames, rebuildTable } from './frames';
import { BUFFER_CAP, state } from './state';
import { applyStatus } from './status';
import { setLastLog, toast } from './toast';
import { parseWsMessage } from './types';

type WsUiState = 'online' | 'connecting' | 'offline';

function setWsUi(s: WsUiState): void {
  els.wsDot.className = 'cm-dot';
  if (s === 'online') {
    els.wsDot.classList.add('ok');
    els.wsText.textContent = '服务在线';
  } else if (s === 'connecting') {
    els.wsDot.classList.add('warn');
    els.wsText.textContent = '服务重连中';
  } else {
    els.wsDot.classList.add('err');
    els.wsText.textContent = '服务离线';
  }
}

/** 建立数据链路；断开后按指数退避（上限 5s）自动重连。 */
export function connectWs(): void {
  if (state.wsTimer !== null) {
    window.clearTimeout(state.wsTimer);
    state.wsTimer = null;
  }
  if (state.ws !== null) {
    const old = state.ws;
    state.ws = null;
    try {
      old.close();
    } catch {
      /* 忽略 */
    }
  }

  setWsUi('connecting');
  let ws: WebSocket;
  try {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws');
  } catch {
    scheduleReconnect();
    return;
  }
  state.ws = ws;

  /* 心跳定时器与套接字同生命周期，避免重连后旧定时器残留 */
  let pingTimer: number | null = null;

  ws.onopen = (): void => {
    if (state.ws !== ws) return;
    state.wsAttempt = 0;
    setWsUi('online');
    /* 启动/重连后主动探测一次设备与链路 */
    void loadDevices();
    if (pingTimer === null) {
      pingTimer = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('ping');
      }, 25000);
    }
  };

  ws.onmessage = (ev: MessageEvent): void => {
    if (state.ws !== ws) return;
    if (typeof ev.data !== 'string') return;
    handleWsText(ev.data);
  };

  ws.onclose = (): void => {
    if (pingTimer !== null) {
      window.clearInterval(pingTimer);
      pingTimer = null;
    }
    if (state.ws !== ws) return;
    state.ws = null;
    setWsUi('offline');
    scheduleReconnect();
  };

  ws.onerror = (): void => {
    /* 出错后总会触发 onclose，交由其处理 */
  };
}

function scheduleReconnect(): void {
  if (state.wsTimer !== null) return;
  const delay = Math.min(500 * Math.pow(2, state.wsAttempt), 5000);
  state.wsAttempt++;
  state.wsTimer = window.setTimeout(() => {
    state.wsTimer = null;
    connectWs();
  }, delay);
}

function handleWsText(text: string): void {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return;
  }
  const msg = parseWsMessage(raw);
  if (msg === null) return;
  switch (msg.type) {
    case 'snapshot':
      applyStatus(msg.status);
      state.buffer = msg.frames.slice(-BUFFER_CAP);
      state.pending.length = 0;
      state.pausedHidden = 0;
      els.pausedCount.textContent = '0';
      applySignalSnapshot(msg.dbcs, msg.frames);
      rebuildTable(true);
      break;
    case 'frames':
      acceptFrames(msg.frames);
      break;
    case 'status':
      applyStatus(msg.status);
      break;
    case 'dbc':
      applySignalEvent(msg.channel, msg.dbc);
      break;
    case 'log':
      if (msg.level === 'error') toast(msg.message, 'error');
      else if (msg.level === 'warn') toast(msg.message, 'warn');
      else setLastLog(msg.message);
      break;
    case 'cleared':
      clearLocalFrames();
      setLastLog('实时缓冲已清空');
      break;
  }
}
