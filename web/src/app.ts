'use strict';

/* ============================================================
 * CAN Tools · USBCAN-II 上位机 —— 前端逻辑
 *
 * 与后端约定见 docs/api.md：REST + WebSocket，同源，JSON。
 * 本文件为唯一源码（无框架、无依赖），编译为经典脚本 app.js。
 * 所有来自服务器的数据均以 unknown 接收，再经下方类型守卫收窄，
 * DOM 渲染只使用 textContent / DOM API，不拼 HTML。
 * ============================================================ */

/* ---------- API 数据形状（与 docs/api.md 一致） ---------- */

const BAUDS = ['5k', '10k', '20k', '50k', '100k', '125k', '250k', '500k', '800k', '1000k'] as const;
type Baud = typeof BAUDS[number];

const MODES = ['normal', 'listen_only', 'self_test'] as const;
type CanMode = typeof MODES[number];

type FilterMode = 0 | 1 | 2;

interface DeviceInfoDto {
  index: number;
  fw_version: string;
  serial: string;
  hw_type: string;
  channel_count: number;
}

interface DeviceStatusDto {
  open: boolean;
  info: DeviceInfoDto | null;
}

interface AcceptanceFilterDto {
  acc_code: number;
  acc_mask: number;
  mode: FilterMode;
}

interface ChannelStatusDto {
  index: number;
  running: boolean;
  baud: Baud | null;
  mode: CanMode | null;
  filter: AcceptanceFilterDto | null;
}

interface SoftwareFilterDto {
  extended: boolean;
  start: number;
  end: number;
}

interface RecordingStatusDto {
  active: boolean;
  file: string | null;
  frames: number | null;
  started_at_ms: number | null;
}

interface StatsDto {
  rx_frames: number;
  filtered_frames: number;
  rx_rate: number;
  recorded_frames: number;
  tx_frames: number;
}

interface ServerDto {
  version: string;
  data_dir: string;
}

interface StatusDto {
  device: DeviceStatusDto;
  channels: ChannelStatusDto[];
  software_filters: SoftwareFilterDto[];
  recording: RecordingStatusDto;
  stats: StatsDto;
  server: ServerDto;
}

interface FrameDto {
  seq: number;
  time_ms: number;
  device_ts: number;
  channel: number;
  id: number;
  extended: boolean;
  remote: boolean;
  dlc: number;
  data: string;
}

interface RecordingFileDto {
  name: string;
  size: number;
  modified_ms: number;
}

/** POST /api/config 请求体 */
interface ConfigBody {
  channels: number[];
  baud: Baud;
  mode: CanMode;
  filter: AcceptanceFilterDto;
  software_filters: SoftwareFilterDto[];
}

/** POST /api/send 请求体 */
interface SendBody {
  channel: number;
  id: number;
  extended: boolean;
  remote: boolean;
  dlc: number;
  data: string;
}

/** WebSocket 服务端消息（快照 + 事件） */
type WsServerMessage =
  | { type: 'snapshot'; status: StatusDto; frames: FrameDto[] }
  | { type: 'frames'; frames: FrameDto[] }
  | { type: 'status'; status: StatusDto }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'cleared' };

/* ---------- 通用工具 ---------- */

const BUFFER_CAP = 5000;
const MODE_LABELS: Readonly<Record<CanMode, string>> = {
  normal: '正常',
  listen_only: '只听',
  self_test: '自测',
};

function byId<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error('缺少元素 #' + id);
  return found as T;
}

function q<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector(selector);
  if (!found) throw new Error('未找到元素 ' + selector);
  return found as T;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function p2(n: number): string {
  return String(n).padStart(2, '0');
}

function fmtInt(n: number): string {
  return Number.isFinite(n) ? Math.trunc(n).toLocaleString('zh-CN') : '—';
}

function fmtRate(n: number): string {
  return Number.isFinite(n)
    ? n.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 1 })
    : '—';
}

function fmtBytes(b: number): string {
  if (!Number.isFinite(b) || b < 0) return '—';
  if (b < 1024) return fmtInt(b) + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / (1024 * 1024)).toFixed(2) + ' MB';
}

function fmtClock(ms: number): string {
  const d = new Date(ms);
  return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function fmtClockShort(ms: number): string {
  const d = new Date(ms);
  return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
}

function fmtDateTime(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—';
}

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? h + ':' + p2(m) + ':' + p2(sec) : p2(m) + ':' + p2(sec);
}

function hexOf(v: number, width: number): string {
  return '0x' + v.toString(16).toUpperCase().padStart(width, '0');
}

function parseHex(raw: string, max: number): number | null {
  const s = raw.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]+$/.test(s)) return null;
  const v = parseInt(s, 16);
  if (!Number.isSafeInteger(v) || v < 0 || v > max) return null;
  return v;
}

/* ---------- JSON 类型守卫 ---------- */

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isStr(v: unknown): v is string {
  return typeof v === 'string';
}
function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function numOr(v: unknown, d: number): number {
  return isNum(v) ? v : d;
}
function strOr(v: unknown, d: string): string {
  return isStr(v) ? v : d;
}
/** 清洗设备返回的文本：去除控制字符（含 NUL 填充）与首尾空白。 */
function cleanText(v: unknown): string {
  return isStr(v) ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
}
function asFilterMode(v: unknown): FilterMode {
  const n = numOr(v, 1);
  return n === 0 || n === 2 ? n : 1;
}
function asBaud(v: unknown): Baud | null {
  return isStr(v) && (BAUDS as readonly string[]).includes(v) ? (v as Baud) : null;
}
function asMode(v: unknown): CanMode | null {
  return isStr(v) && (MODES as readonly string[]).includes(v) ? (v as CanMode) : null;
}

function parseFrameDto(o: Record<string, unknown>): FrameDto {
  return {
    seq: numOr(o['seq'], 0),
    time_ms: numOr(o['time_ms'], Date.now()),
    device_ts: numOr(o['device_ts'], 0),
    channel: numOr(o['channel'], 0),
    id: numOr(o['id'], 0),
    extended: o['extended'] === true,
    remote: o['remote'] === true,
    dlc: numOr(o['dlc'], 0),
    data: strOr(o['data'], ''),
  };
}

function parseFrames(v: unknown): FrameDto[] {
  if (!Array.isArray(v)) return [];
  const out: FrameDto[] = [];
  for (const it of v) if (isObj(it)) out.push(parseFrameDto(it));
  return out;
}

/** 校验并收窄未知 JSON 为 StatusDto；缺少关键结构时返回 null。 */
function parseStatusDto(v: unknown): StatusDto | null {
  if (!isObj(v)) return null;
  const dev = isObj(v['device']) ? v['device'] : null;
  if (!dev) return null;

  let info: DeviceInfoDto | null = null;
  if (isObj(dev['info'])) {
    const i = dev['info'];
    info = {
      index: numOr(i['index'], 0),
      fw_version: cleanText(i['fw_version']),
      serial: cleanText(i['serial']),
      hw_type: cleanText(i['hw_type']),
      channel_count: numOr(i['channel_count'], 0),
    };
  }

  const channels: ChannelStatusDto[] = [];
  if (Array.isArray(v['channels'])) {
    for (const c of v['channels']) {
      if (!isObj(c)) continue;
      const f = isObj(c['filter'])
        ? {
            acc_code: numOr(c['filter']['acc_code'], 0),
            acc_mask: numOr(c['filter']['acc_mask'], 0xffffffff),
            mode: asFilterMode(c['filter']['mode']),
          }
        : null;
      channels.push({
        index: numOr(c['index'], channels.length),
        running: c['running'] === true,
        baud: asBaud(c['baud']),
        mode: asMode(c['mode']),
        filter: f,
      });
    }
  }

  const software_filters: SoftwareFilterDto[] = [];
  if (Array.isArray(v['software_filters'])) {
    for (const f of v['software_filters']) {
      if (!isObj(f)) continue;
      software_filters.push({
        extended: f['extended'] === true,
        start: numOr(f['start'], 0),
        end: numOr(f['end'], 0),
      });
    }
  }

  const rec = isObj(v['recording']) ? v['recording'] : {};
  const stats = isObj(v['stats']) ? v['stats'] : {};
  const srv = isObj(v['server']) ? v['server'] : {};

  return {
    device: { open: dev['open'] === true, info },
    channels,
    software_filters,
    recording: {
      active: rec['active'] === true,
      file: isStr(rec['file']) ? rec['file'] : null,
      frames: isNum(rec['frames']) ? rec['frames'] : null,
      started_at_ms: isNum(rec['started_at_ms']) ? rec['started_at_ms'] : null,
    },
    stats: {
      rx_frames: numOr(stats['rx_frames'], 0),
      filtered_frames: numOr(stats['filtered_frames'], 0),
      rx_rate: numOr(stats['rx_rate'], 0),
      recorded_frames: numOr(stats['recorded_frames'], 0),
      tx_frames: numOr(stats['tx_frames'], 0),
    },
    server: { version: strOr(srv['version'], ''), data_dir: strOr(srv['data_dir'], '') },
  };
}

function parseDevicesDto(v: unknown): DeviceInfoDto[] {
  if (!isObj(v) || !Array.isArray(v['devices'])) return [];
  const out: DeviceInfoDto[] = [];
  for (const d of v['devices']) {
    if (!isObj(d)) continue;
    out.push({
      index: numOr(d['index'], 0),
      fw_version: cleanText(d['fw_version']),
      serial: cleanText(d['serial']),
      hw_type: cleanText(d['hw_type']),
      channel_count: numOr(d['channel_count'], 0),
    });
  }
  return out;
}

function parseRecordingsDto(v: unknown): RecordingFileDto[] {
  if (!isObj(v) || !Array.isArray(v['recordings'])) return [];
  const out: RecordingFileDto[] = [];
  for (const r of v['recordings']) {
    if (!isObj(r)) continue;
    out.push({
      name: strOr(r['name'], ''),
      size: numOr(r['size'], 0),
      modified_ms: numOr(r['modified_ms'], 0),
    });
  }
  return out;
}

/** 校验 WS 消息；无法识别（含未知 type）返回 null，由调用方忽略。 */
function parseWsMessage(v: unknown): WsServerMessage | null {
  if (!isObj(v)) return null;
  const t = isStr(v['type']) ? v['type'] : '';
  switch (t) {
    case 'snapshot': {
      const st = parseStatusDto(v['status']);
      if (!st) return null;
      return { type: 'snapshot', status: st, frames: parseFrames(v['frames']) };
    }
    case 'frames':
      return { type: 'frames', frames: parseFrames(v['frames']) };
    case 'status': {
      const st = parseStatusDto(v['status']);
      return st ? { type: 'status', status: st } : null;
    }
    case 'log': {
      const lvl = v['level'];
      if ((lvl !== 'info' && lvl !== 'warn' && lvl !== 'error') || !isStr(v['message'])) return null;
      return { type: 'log', level: lvl, message: v['message'] };
    }
    case 'cleared':
      return { type: 'cleared' };
    default:
      return null; /* 未知事件类型：忽略 */
  }
}

/* ---------- DOM 引用 ---------- */

const els = {
  /* 顶栏 */
  devicePillDot: byId<HTMLElement>('devicePillDot'),
  devicePillText: byId<HTMLElement>('devicePillText'),
  recPill: byId<HTMLElement>('recPill'),
  wsDot: byId<HTMLElement>('wsDot'),
  wsText: byId<HTMLElement>('wsText'),
  versionLabel: byId<HTMLElement>('versionLabel'),

  /* 设备连接 */
  deviceList: byId<HTMLElement>('deviceList'),
  deviceEmpty: byId<HTMLElement>('deviceEmpty'),
  btnRefreshDevices: byId<HTMLButtonElement>('btnRefreshDevices'),
  btnOpenDevice: byId<HTMLButtonElement>('btnOpenDevice'),
  btnCloseDevice: byId<HTMLButtonElement>('btnCloseDevice'),
  deviceInfo: byId<HTMLElement>('deviceInfo'),
  devHw: byId<HTMLElement>('devHw'),
  devFw: byId<HTMLElement>('devFw'),
  devSerial: byId<HTMLElement>('devSerial'),
  devChannels: byId<HTMLElement>('devChannels'),

  /* 通道配置 */
  ch1Check: byId<HTMLInputElement>('ch1Check'),
  ch2Check: byId<HTMLInputElement>('ch2Check'),
  baudSelect: byId<HTMLSelectElement>('baudSelect'),
  btnApplyConfig: byId<HTMLButtonElement>('btnApplyConfig'),
  btnStopChannels: byId<HTMLButtonElement>('btnStopChannels'),
  chipCh1: byId<HTMLElement>('chipCh1'),
  chipCh1State: byId<HTMLElement>('chipCh1State'),
  chipCh1Sub: byId<HTMLElement>('chipCh1Sub'),
  chipCh2: byId<HTMLElement>('chipCh2'),
  chipCh2State: byId<HTMLElement>('chipCh2State'),
  chipCh2Sub: byId<HTMLElement>('chipCh2Sub'),

  /* 硬件滤波 */
  accCodeInput: byId<HTMLInputElement>('accCodeInput'),
  accMaskInput: byId<HTMLInputElement>('accMaskInput'),
  filterModeSelect: byId<HTMLSelectElement>('filterModeSelect'),
  btnAcceptAll: byId<HTMLButtonElement>('btnAcceptAll'),
  btnApplyFilters: byId<HTMLButtonElement>('btnApplyFilters'),
  filterIdInput: byId<HTMLInputElement>('filterIdInput'),
  filterIdExtended: byId<HTMLInputElement>('filterIdExtended'),
  btnFilterById: byId<HTMLButtonElement>('btnFilterById'),

  /* 软件过滤器 */
  swFilterList: byId<HTMLElement>('swFilterList'),
  btnAddFilter: byId<HTMLButtonElement>('btnAddFilter'),

  /* 录制 */
  btnRecStart: byId<HTMLButtonElement>('btnRecStart'),
  btnRecStop: byId<HTMLButtonElement>('btnRecStop'),
  recActive: byId<HTMLElement>('recActive'),
  recActiveFile: byId<HTMLElement>('recActiveFile'),
  recActiveFrames: byId<HTMLElement>('recActiveFrames'),
  recActiveElapsed: byId<HTMLElement>('recActiveElapsed'),
  dataDirLabel: byId<HTMLElement>('dataDirLabel'),

  /* 统计 */
  statRx: byId<HTMLElement>('statRx'),
  statRate: byId<HTMLElement>('statRate'),
  statFiltered: byId<HTMLElement>('statFiltered'),
  statRecorded: byId<HTMLElement>('statRecorded'),

  /* 发送报文 */
  sendChannel: byId<HTMLSelectElement>('sendChannel'),
  sendId: byId<HTMLInputElement>('sendId'),
  sendData: byId<HTMLInputElement>('sendData'),
  sendDlc: byId<HTMLInputElement>('sendDlc'),
  sendRemote: byId<HTMLInputElement>('sendRemote'),
  btnSend: byId<HTMLButtonElement>('btnSend'),
  sendCount: byId<HTMLElement>('sendCount'),
  sendHint: byId<HTMLElement>('sendHint'),

  /* 实时报文 */
  frameFilter: byId<HTMLInputElement>('frameFilter'),
  autoscrollCheck: byId<HTMLInputElement>('autoscrollCheck'),
  btnPauseView: byId<HTMLButtonElement>('btnPauseView'),
  btnPauseLabel: byId<HTMLElement>('btnPauseLabel'),
  icPause: byId<HTMLElement>('icPause'),
  icPlay: byId<HTMLElement>('icPlay'),
  btnClearView: byId<HTMLButtonElement>('btnClearView'),
  tableWrap: byId<HTMLElement>('tableWrap'),
  framesBody: byId<HTMLTableSectionElement>('framesBody'),
  frameEmpty: byId<HTMLElement>('frameEmpty'),
  emptyTitle: byId<HTMLElement>('emptyTitle'),
  emptyHint: byId<HTMLElement>('emptyHint'),
  pausedBadge: byId<HTMLElement>('pausedBadge'),
  pausedCount: byId<HTMLElement>('pausedCount'),
  lastLogMsg: byId<HTMLElement>('lastLogMsg'),
  visibleCount: byId<HTMLElement>('visibleCount'),
  bufferUsage: byId<HTMLElement>('bufferUsage'),

  /* 录制文件 */
  recordingsList: byId<HTMLTableSectionElement>('recordingsList'),
  recordingsEmpty: byId<HTMLElement>('recordingsEmpty'),
  recordingsCount: byId<HTMLElement>('recordingsCount'),
  btnRefreshRecordings: byId<HTMLButtonElement>('btnRefreshRecordings'),

  /* 其它 */
  toasts: byId<HTMLElement>('toasts'),
  rowTpl: byId<HTMLTemplateElement>('rowTpl'),
  recRowTpl: byId<HTMLTemplateElement>('recRowTpl'),
  swRowTpl: byId<HTMLTemplateElement>('swRowTpl'),
};

const rowTplRow = els.rowTpl.content.firstElementChild as HTMLTableRowElement | null;
const recTplRow = els.recRowTpl.content.firstElementChild as HTMLTableRowElement | null;
const swTplRow = els.swRowTpl.content.firstElementChild as HTMLElement | null;

/* ---------- 应用状态 ---------- */

type WsUiState = 'online' | 'connecting' | 'offline';
type ToastLevel = 'info' | 'success' | 'warn' | 'error';

interface AppState {
  status: StatusDto | null;
  devices: DeviceInfoDto[];
  selectedDevice: number | null;
  recordings: RecordingFileDto[];
  ws: WebSocket | null;
  wsAttempt: number;
  wsTimer: number | null;
  buffer: FrameDto[];
  pending: FrameDto[];
  paused: boolean;
  pausedHidden: number;
  autoscroll: boolean;
  filter: string;
  formSynced: boolean;
}

const state: AppState = {
  status: null,
  devices: [],
  selectedDevice: null,
  recordings: [],
  ws: null,
  wsAttempt: 0,
  wsTimer: null,
  buffer: [],
  pending: [],
  paused: false,
  pausedHidden: 0,
  autoscroll: true,
  filter: '',
  formSynced: false,
};

const busy = new Set<HTMLButtonElement>();

/* ---------- REST 客户端 ---------- */

/** 发送 REST 请求；失败（网络错误、非 2xx、ok:false）时抛出带服务端 error 文案的错误。 */
async function api(path: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', body?: unknown): Promise<unknown> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error('无法连接服务器，请确认后端已启动');
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = undefined;
  }
  if (!res.ok || (isObj(data) && data['ok'] === false)) {
    const msg = isObj(data) && isStr(data['error']) ? data['error'] : '请求失败（HTTP ' + res.status + '）';
    throw new Error(msg);
  }
  return data;
}

/** 以按钮 busy 态执行异步操作：期间禁用按钮，失败统一弹出错误提示。 */
async function runBusy(btn: HTMLButtonElement, fn: () => Promise<void>): Promise<void> {
  if (btn.disabled || busy.has(btn)) return;
  busy.add(btn);
  btn.disabled = true;
  btn.classList.add('busy');
  btn.setAttribute('aria-busy', 'true');
  try {
    await fn();
  } catch (err) {
    toast(errText(err), 'error');
  } finally {
    busy.delete(btn);
    btn.classList.remove('busy');
    btn.removeAttribute('aria-busy');
    updateControls();
  }
}

/* ---------- 提示气泡 ---------- */

let lastToast: { msg: string; at: number } | null = null;

/** 每种提示级别的前置图标（静态 SVG 路径，经 DOM API 构建） */
const TOAST_ICONS: Readonly<Record<ToastLevel, string>> = {
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 7.6v.2"/>',
  success: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.3 2.4 2.4 4.6-5.2"/>',
  warn: '<path d="M12 4.5 21 19.5H3z"/><path d="M12 10v4"/><path d="M12 16.8v.2"/>',
  error: '<circle cx="12" cy="12" r="8.5"/><path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6"/>',
};

function buildToastIcon(level: ToastLevel): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const parts = TOAST_ICONS[level].match(/<[a-z]+[^>]*>/g) ?? [];
  for (const part of parts) {
    const tag = part.match(/^<([a-z]+)/);
    if (!tag) continue;
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag[1]);
    const attrs = part.match(/[a-z-]+="[^"]*"/g) ?? [];
    for (const attr of attrs) {
      const m = attr.match(/^([a-z-]+)="([^"]*)"$/);
      if (m) el.setAttribute(m[1], m[2]);
    }
    svg.appendChild(el);
  }
  return svg;
}

function toast(message: string, level: ToastLevel = 'info'): void {
  const now = Date.now();
  if (lastToast && lastToast.msg === message && now - lastToast.at < 3500) return;
  lastToast = { msg: message, at: now };

  const box = document.createElement('div');
  box.className = 'toast ' + level;

  const ic = document.createElement('span');
  ic.className = 'toast-ic';
  ic.appendChild(buildToastIcon(level));

  const msg = document.createElement('span');
  msg.className = 'toast-msg';
  msg.textContent = message;

  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'toast-x';
  x.setAttribute('aria-label', '关闭提示');
  x.textContent = '×';

  box.append(ic, msg, x);
  els.toasts.appendChild(box);

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    box.classList.add('out');
    window.setTimeout(() => box.remove(), 200);
  };
  x.addEventListener('click', close);
  const ttl = level === 'error' ? 6500 : level === 'warn' ? 5000 : 3200;
  window.setTimeout(close, ttl);

  while (els.toasts.children.length > 5) {
    const first = els.toasts.firstElementChild;
    if (first) first.remove();
    else break;
  }
}

function setLastLog(message: string): void {
  els.lastLogMsg.textContent = fmtClockShort(Date.now()) + ' · ' + message;
}

/* ---------- WebSocket ---------- */

function setWsUi(s: WsUiState): void {
  els.wsDot.className = 'pill-dot';
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
function connectWs(): void {
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
      rebuildTable();
      break;
    case 'frames':
      acceptFrames(msg.frames);
      break;
    case 'status':
      applyStatus(msg.status);
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

/* ---------- 报文管线 ---------- */

/** 收帧入缓冲（上限 BUFFER_CAP）；未暂停时并入待渲染队列，交由 rAF 批量上屏。 */
function acceptFrames(frames: FrameDto[]): void {
  if (frames.length === 0) return;
  for (const f of frames) state.buffer.push(f);
  if (state.buffer.length > BUFFER_CAP) {
    state.buffer.splice(0, state.buffer.length - BUFFER_CAP);
  }
  if (state.paused) {
    state.pausedHidden += frames.length;
    els.pausedCount.textContent = fmtInt(state.pausedHidden);
    updateStrip();
    return;
  }
  for (const f of frames) state.pending.push(f);
  scheduleFlush();
}

let flushReq = false;

function scheduleFlush(): void {
  if (flushReq) return;
  flushReq = true;
  window.requestAnimationFrame(() => {
    flushReq = false;
    flushRows();
  });
}

/** 将一批待渲染帧写入表格（仅匹配过滤器的行），并裁剪、滚动。 */
function flushRows(): void {
  const batch = state.pending;
  state.pending = [];
  if (batch.length === 0) {
    updateStrip();
    return;
  }
  const frag = document.createDocumentFragment();
  for (const f of batch) {
    if (matchesFilter(f)) frag.appendChild(buildRow(f));
  }
  if (frag.childNodes.length > 0) els.framesBody.appendChild(frag);
  trimRows();
  updateEmpty();
  updateStrip();
  maybeScroll();
}

function buildRow(f: FrameDto): HTMLTableRowElement {
  const src = rowTplRow;
  const row = (src ? src.cloneNode(true) : document.createElement('tr')) as HTMLTableRowElement;
  row.cells[0].textContent = fmtInt(f.seq);
  row.cells[1].textContent = fmtClock(f.time_ms);

  const badge = document.createElement('span');
  badge.className = 'ch-badge ch' + (f.channel === 0 || f.channel === 1 ? f.channel : 'x');
  badge.textContent = f.channel === 0 ? 'CAN1' : f.channel === 1 ? 'CAN2' : 'CH' + (f.channel + 1);
  row.cells[2].appendChild(badge);

  row.cells[3].textContent = hexOf(f.id, f.extended ? 8 : 3);
  const baseType = f.extended ? '扩展' : '标准';
  row.cells[4].textContent = f.remote ? baseType + '·远程' : baseType;
  row.cells[5].textContent = String(f.dlc);
  row.cells[6].textContent = f.data.length > 0 ? f.data : '—';

  if (f.remote) row.classList.add('remote');
  return row;
}

/** 快速过滤：对 ID 十六进制、序列、通道、数据与类型做子串匹配。 */
function matchesFilter(f: FrameDto): boolean {
  const query = state.filter;
  if (!query) return true;
  const baseType = f.extended ? '扩展' : '标准';
  const hay = [
    f.id.toString(16),
    String(f.seq),
    String(f.channel),
    String(f.channel + 1),
    'can' + f.channel,
    f.data,
    baseType,
    f.remote ? '远程' : '',
  ]
    .join(' ')
    .toLowerCase();
  return hay.includes(query);
}

/** 由本地缓冲整体重建表格（过滤条件变化、恢复显示、快照到达时调用）。 */
function rebuildTable(): void {
  const frag = document.createDocumentFragment();
  for (const f of state.buffer) {
    if (matchesFilter(f)) frag.appendChild(buildRow(f));
  }
  els.framesBody.replaceChildren(frag);
  trimRows();
  updateEmpty();
  updateStrip();
  maybeScroll();
}

function trimRows(): void {
  while (els.framesBody.rows.length > BUFFER_CAP) {
    els.framesBody.deleteRow(0);
  }
}

let scrollScheduled = false;

function maybeScroll(): void {
  if (!state.autoscroll || state.paused || scrollScheduled) return;
  scrollScheduled = true;
  window.requestAnimationFrame(() => {
    scrollScheduled = false;
    if (state.autoscroll && !state.paused) {
      els.tableWrap.scrollTop = els.tableWrap.scrollHeight;
    }
  });
}

function clearLocalFrames(): void {
  state.buffer.length = 0;
  state.pending.length = 0;
  state.pausedHidden = 0;
  els.pausedCount.textContent = '0';
  rebuildTable();
}

function updateStrip(): void {
  els.visibleCount.textContent = '显示 ' + fmtInt(els.framesBody.rows.length) + ' 行';
  els.bufferUsage.textContent = '缓冲 ' + fmtInt(state.buffer.length) + ' / ' + fmtInt(BUFFER_CAP);
}

function updateEmpty(): void {
  const hasRows = els.framesBody.rows.length > 0;
  els.frameEmpty.hidden = hasRows;
  if (hasRows) return;

  const st = state.status;
  const open = st !== null && st.device.open;
  const running = st !== null && st.channels.some((c) => c.running);

  if (state.buffer.length > 0 && state.filter) {
    els.emptyTitle.textContent = '没有匹配的报文';
    els.emptyHint.textContent = '当前过滤条件未匹配任何报文，试着调整或清空过滤输入。';
  } else if (!open) {
    els.emptyTitle.textContent = '未连接设备';
    els.emptyHint.textContent = '在左侧「设备连接」中选择设备并点击「打开设备」。';
  } else if (!running) {
    els.emptyTitle.textContent = '通道未启动';
    els.emptyHint.textContent = '选择通道、波特率与滤波器，然后点击「应用配置并启动」。';
  } else {
    els.emptyTitle.textContent = '等待 CAN 报文';
    els.emptyHint.textContent = '通道已启动，尚未收到报文；请确认总线波特率一致、滤波器未全部滤除。';
  }
}

/* ---------- 状态渲染 ---------- */

/** 将服务端 StatusDto 应用到顶栏、通道状态、录制、统计与全部控件可用性。 */
function applyStatus(st: StatusDto): void {
  state.status = st;

  /* 顶栏设备胶囊：序列号为空（或仅填充字符）时不显示 S/N 段 */
  const info = st.device.info;
  if (st.device.open && info) {
    els.devicePillDot.className = 'pill-dot ok';
    let pillText: string;
    if (info.serial) {
      pillText = [info.hw_type, 'S/N ' + info.serial].filter((s) => s.length > 0).join(' · ');
    } else {
      pillText = ['已连接', info.hw_type].filter((s) => s.length > 0).join(' · ');
    }
    els.devicePillText.textContent = pillText || '设备已连接';
    els.deviceInfo.hidden = false;
    els.devHw.textContent = info.hw_type || '—';
    els.devFw.textContent = info.fw_version || '—';
    els.devSerial.textContent = info.serial || '—';
    els.devChannels.textContent = String(info.channel_count);
  } else {
    els.devicePillDot.className = 'pill-dot';
    els.devicePillText.textContent = '未连接设备';
    els.deviceInfo.hidden = true;
  }

  /* 通道状态 */
  for (const ch of st.channels) {
    const chip = ch.index === 0 ? els.chipCh1 : ch.index === 1 ? els.chipCh2 : null;
    const stateEl = ch.index === 0 ? els.chipCh1State : ch.index === 1 ? els.chipCh2State : null;
    const subEl = ch.index === 0 ? els.chipCh1Sub : ch.index === 1 ? els.chipCh2Sub : null;
    if (!chip || !stateEl || !subEl) continue;
    chip.classList.toggle('running', ch.running);
    stateEl.textContent = ch.running ? '运行中' : '已停止';
    subEl.textContent = ch.running && ch.baud ? ch.baud + ' · ' + MODE_LABELS[ch.mode ?? 'normal'] : '—';
  }

  /* 录制 */
  els.recActive.hidden = !st.recording.active;
  els.recPill.hidden = !st.recording.active;
  if (st.recording.active) {
    els.recActiveFile.textContent = st.recording.file ?? '—';
    els.recActiveFrames.textContent = fmtInt(st.recording.frames ?? 0);
    if (st.recording.started_at_ms !== null) {
      els.recActiveElapsed.textContent = fmtDur(Date.now() - st.recording.started_at_ms);
    }
  }
  els.dataDirLabel.textContent = st.server.data_dir || '—';

  /* 统计 */
  els.statRx.textContent = fmtInt(st.stats.rx_frames);
  els.statRate.textContent = fmtRate(st.stats.rx_rate);
  els.statFiltered.textContent = fmtInt(st.stats.filtered_frames);
  els.statRecorded.textContent = fmtInt(st.stats.recorded_frames);
  els.sendCount.textContent = fmtInt(st.stats.tx_frames);

  syncSendChannels(st);

  /* 版本 */
  if (st.server.version) els.versionLabel.textContent = 'v' + st.server.version;

  syncFormOnce(st);
  updateControls();
  updateEmpty();
}

/** 依据当前状态计算各按钮的可用性（busy 中的按钮保持禁用）。 */
function updateControls(): void {
  const st = state.status;
  const open = st !== null && st.device.open;
  const anyRunning = st !== null && st.channels.some((c) => c.running);
  const recActive = st !== null && st.recording.active;
  const anyChannelChecked = els.ch1Check.checked || els.ch2Check.checked;
  const checkedChannels = selectedChannels();
  const allCheckedRunning =
    checkedChannels.length > 0 &&
    checkedChannels.every((index) => st?.channels[index]?.running === true);

  els.btnOpenDevice.disabled = open || state.devices.length === 0 || state.selectedDevice === null;
  els.btnCloseDevice.disabled = !open;
  els.btnApplyConfig.disabled = !open || !anyChannelChecked;
  els.btnApplyFilters.disabled = !open || !allCheckedRunning;
  els.btnStopChannels.disabled = !anyRunning;
  els.btnRecStart.disabled = !open || recActive;
  els.btnRecStop.disabled = !recActive;
  els.btnPauseView.disabled = !anyRunning;

  /* 异步进行中的按钮保持禁用，避免状态推送期间被重新启用 */
  for (const b of busy) b.disabled = true;

  els.deviceList.classList.toggle('locked', open);
  updateSendControls();
}

/** 首个状态到达时，把运行中的通道配置回填到表单（仅一次，不覆盖用户后续编辑）。 */
function syncFormOnce(st: StatusDto): void {
  if (state.formSynced) return;
  state.formSynced = true;

  const running = st.channels.filter((c) => c.running);
  const ref = running.length > 0 ? running[0] : st.channels.length > 0 ? st.channels[0] : null;
  if (ref) {
    if (ref.baud) els.baudSelect.value = ref.baud;
    if (ref.mode) {
      const r = document.querySelector<HTMLInputElement>('input[name="mode"][value="' + ref.mode + '"]');
      if (r) r.checked = true;
    }
    if (ref.filter) {
      els.accCodeInput.value = ref.filter.acc_code.toString(16).toUpperCase();
      els.accMaskInput.value = ref.filter.acc_mask.toString(16).toUpperCase();
      els.filterModeSelect.value = String(ref.filter.mode);
    }
    if (running.length > 0) {
      els.ch1Check.checked = running.some((c) => c.index === 0);
      els.ch2Check.checked = running.some((c) => c.index === 1);
    } else {
      els.ch1Check.checked = ref.index === 0;
      els.ch2Check.checked = ref.index === 1;
    }
  }

  if (st.software_filters.length > 0) {
    const frag = document.createDocumentFragment();
    for (const f of st.software_filters) {
      frag.appendChild(buildSwRow(f.extended, f.start, f.end));
    }
    els.swFilterList.replaceChildren(frag);
  }
  updateControls();
}

/* ---------- 设备列表 ---------- */

function renderDevices(): void {
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

async function loadDevices(): Promise<void> {
  try {
    const res = await api('/api/devices');
    state.devices = parseDevicesDto(res);
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

async function loadStatus(): Promise<void> {
  try {
    const res = await api('/api/status');
    const st = parseStatusDto(res);
    if (!st) throw new Error('状态响应格式异常');
    applyStatus(st);
  } catch (err) {
    toast(errText(err), 'error');
  }
}

async function loadHealth(): Promise<void> {
  try {
    const res = await api('/api/health');
    if (isObj(res) && isStr(res['version']) && !state.status) {
      els.versionLabel.textContent = 'v' + res['version'];
    }
  } catch (err) {
    toast(errText(err), 'error');
  }
}

/* ---------- 录制文件 ---------- */

function buildRecRow(rec: RecordingFileDto): HTMLTableRowElement {
  const src = recTplRow;
  const row = (src ? src.cloneNode(true) : document.createElement('tr')) as HTMLTableRowElement;

  const name = q<HTMLElement>(row, '.r-name');
  name.textContent = rec.name;
  q<HTMLElement>(row, '.r-size').textContent = fmtBytes(rec.size);
  q<HTMLElement>(row, '.r-time').textContent = fmtDateTime(rec.modified_ms);

  const link = q<HTMLAnchorElement>(row, 'a.btn');
  link.href = '/api/recordings/' + encodeURIComponent(rec.name);
  link.setAttribute('download', rec.name);

  const del = q<HTMLButtonElement>(row, 'button.btn-danger');
  del.addEventListener('click', () => {
    void deleteRecording(rec.name, del);
  });
  return row;
}

function renderRecordings(): void {
  const frag = document.createDocumentFragment();
  for (const rec of state.recordings) {
    if (rec.name) frag.appendChild(buildRecRow(rec));
  }
  els.recordingsList.replaceChildren(frag);
  els.recordingsEmpty.hidden = state.recordings.length > 0;
  els.recordingsCount.textContent = fmtInt(state.recordings.length);
}

async function loadRecordings(): Promise<void> {
  try {
    const res = await api('/api/recordings');
    const list = parseRecordingsDto(res);
    list.sort((a, b) => b.modified_ms - a.modified_ms);
    state.recordings = list;
    renderRecordings();
  } catch (err) {
    toast(errText(err), 'error');
  }
}

async function deleteRecording(name: string, btn: HTMLButtonElement): Promise<void> {
  if (!window.confirm('删除录制文件「' + name + '」？此操作不可恢复。')) return;
  await runBusy(btn, async () => {
    await api('/api/recordings/' + encodeURIComponent(name), 'DELETE');
    toast('已删除 ' + name, 'success');
    await loadRecordings();
  });
}

/* ---------- 软件过滤器 ---------- */

function buildSwRow(ext: boolean, start?: number, end?: number): HTMLElement {
  const src = swTplRow;
  const row = (src ? src.cloneNode(true) : document.createElement('div')) as HTMLElement;

  const extIn = q<HTMLInputElement>(row, '.sw-ext');
  extIn.checked = ext;

  const startIn = q<HTMLInputElement>(row, '.sw-start');
  startIn.value = start !== undefined ? start.toString(16).toUpperCase() : '100';

  const endIn = q<HTMLInputElement>(row, '.sw-end');
  endIn.value = end !== undefined ? end.toString(16).toUpperCase() : '7FF';

  q<HTMLButtonElement>(row, '.sw-del').addEventListener('click', () => {
    row.remove();
  });
  return row;
}

/** 从表单收集 POST /api/config 请求体；校验失败时提示并返回 null。 */
function selectedChannels(): number[] {
  const channels: number[] = [];
  if (els.ch1Check.checked) channels.push(0);
  if (els.ch2Check.checked) channels.push(1);
  return channels;
}

/** 读取硬件验收滤波字段; 非法时提示并返回 null。 */
function collectHardwareFilter(): AcceptanceFilterDto | null {
  const accCode = parseHex(els.accCodeInput.value, 0xffffffff);
  if (accCode === null) {
    toast('验收码不是有效的十六进制值 （0 – FFFFFFFF）', 'warn');
    els.accCodeInput.focus();
    return null;
  }
  const accMask = parseHex(els.accMaskInput.value, 0xffffffff);
  if (accMask === null) {
    toast('屏蔽码不是有效的十六进制值 （0 – FFFFFFFF）', 'warn');
    els.accMaskInput.focus();
    return null;
  }
  return {
    acc_code: accCode,
    acc_mask: accMask,
    mode: asFilterMode(Number(els.filterModeSelect.value)),
  };
}

/** 读取软件 ID 过滤行; 非法时提示并返回 null。 */
function collectSoftwareFilters(): SoftwareFilterDto[] | null {
  const software_filters: SoftwareFilterDto[] = [];
  const rows = Array.from(els.swFilterList.querySelectorAll<HTMLElement>('.sw-row'));
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const ext = q<HTMLInputElement>(row, '.sw-ext').checked;
    const maxId = ext ? 0x1fffffff : 0x7ff;
    const startIn = q<HTMLInputElement>(row, '.sw-start');
    const endIn = q<HTMLInputElement>(row, '.sw-end');
    const start = parseHex(startIn.value, maxId);
    const end = parseHex(endIn.value, maxId);
    const scope = ext ? '扩展帧最大 1FFFFFFF' : '标准帧最大 7FF';
    if (start === null) {
      toast('第 ' + (i + 1) + ' 条过滤器：起始 ID 无效 （' + scope + '）', 'warn');
      startIn.focus();
      return null;
    }
    if (end === null) {
      toast('第 ' + (i + 1) + ' 条过滤器：结束 ID 无效 （' + scope + '）', 'warn');
      endIn.focus();
      return null;
    }
    if (start > end) {
      toast('第 ' + (i + 1) + ' 条过滤器：起始 ID 不能大于结束 ID', 'warn');
      startIn.focus();
      return null;
    }
    software_filters.push({ extended: ext, start, end });
  }
  return software_filters;
}

function collectConfig(): ConfigBody | null {
  const channels = selectedChannels();
  if (channels.length === 0) {
    toast('请至少选择一个通道', 'warn');
    return null;
  }

  const baud = asBaud(els.baudSelect.value) ?? '500k';
  const checked = document.querySelector<HTMLInputElement>('input[name="mode"]:checked');
  const mode = checked ? asMode(checked.value) ?? 'normal' : 'normal';
  const filter = collectHardwareFilter();
  if (filter === null) return null;
  const software_filters = collectSoftwareFilters();
  if (software_filters === null) return null;

  return { channels, baud, mode, filter, software_filters };
}

/* ---------- 视图控制 ---------- */

function setAutoscroll(on: boolean): void {
  state.autoscroll = on;
  els.autoscrollCheck.checked = on;
  if (on) maybeScroll();
}

function setPaused(p: boolean): void {
  if (state.paused === p) return;
  state.paused = p;
  els.btnPauseView.setAttribute('aria-pressed', String(p));
  els.btnPauseLabel.textContent = p ? '继续显示' : '暂停显示';
  els.icPause.hidden = p;
  els.icPlay.hidden = !p;
  /* 暂停时自动滚动无意义，禁用开关以免状态矛盾 */
  els.autoscrollCheck.disabled = p;
  if (p) {
    els.pausedCount.textContent = fmtInt(state.pausedHidden);
    els.pausedBadge.hidden = false;
  } else {
    state.pausedHidden = 0;
    els.pausedCount.textContent = '0';
    els.pausedBadge.hidden = true;
    rebuildTable();
  }
}

/* ---------- 事件绑定 ---------- */

/* ---------- 发送报文 ---------- */

let sendChannelSignature: string | null = null;

function sendExtended(): boolean {
  const selected = document.querySelector<HTMLInputElement>('input[name="send-ext"]:checked');
  return selected !== null && selected.value === 'ext';
}

/** 解析发送数据；支持空格/逗号/冒号分隔或连续十六进制。 */
function parseSendData(raw: string): number[] | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  const tokens = trimmed.split(/[\s,:]+/).filter((token) => token.length > 0);
  if (tokens.length > 1) {
    const bytes: number[] = [];
    for (const token of tokens) {
      const cleaned = token.replace(/^0x/i, '');
      if (!/^[0-9a-f]{1,2}$/i.test(cleaned)) return null;
      bytes.push(parseInt(cleaned, 16));
    }
    return bytes.length <= 8 ? bytes : null;
  }
  const cleaned = trimmed.replace(/^0x/i, '');
  if (cleaned.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(cleaned)) return null;
  const bytes: number[] = [];
  for (let index = 0; index < cleaned.length; index += 2) {
    bytes.push(parseInt(cleaned.slice(index, index + 2), 16));
  }
  return bytes.length <= 8 ? bytes : null;
}

/** 依据运行中的通道重建发送通道下拉框；保留用户选择。 */
function syncSendChannels(st: StatusDto): void {
  const running = st.channels.filter((channel) => channel.running);
  const signature = running
    .map((channel) => channel.index + ':' + (channel.mode ?? ''))
    .join(',');
  if (signature === sendChannelSignature) return;
  sendChannelSignature = signature;
  const previous = els.sendChannel.value;

  if (running.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '无通道';
    option.disabled = true;
    option.selected = true;
    els.sendChannel.replaceChildren(option);
    return;
  }

  const options = running.map((channel) => {
    const option = document.createElement('option');
    option.value = String(channel.index);
    option.textContent =
      'CAN' + (channel.index + 1) + (channel.mode === 'listen_only' ? '（只听）' : '');
    option.disabled = channel.mode === 'listen_only';
    return option;
  });
  els.sendChannel.replaceChildren(...options);

  const sendable = running.filter((channel) => channel.mode !== 'listen_only');
  let selected = sendable[0]?.index ?? running[0].index;
  if (previous !== '' && sendable.some((channel) => channel.index === Number(previous))) {
    selected = Number(previous);
  }
  els.sendChannel.value = String(selected);
}

/** 远程帧禁用数据输入；数据帧的 DLC 自动等于字节数。 */
function updateSendDlc(): void {
  const remote = els.sendRemote.checked;
  els.sendData.disabled = remote;
  els.sendDlc.readOnly = !remote;
  if (remote) {
    if (els.sendDlc.value === '') els.sendDlc.value = '0';
  } else {
    const bytes = parseSendData(els.sendData.value);
    els.sendDlc.value = bytes === null ? '' : String(bytes.length);
  }
}

function updateSendControls(): void {
  const st = state.status;
  const open = st !== null && st.device.open;
  const channelValue = els.sendChannel.value;
  const channel = channelValue === '' ? null : Number(channelValue);
  const running =
    channel === null
      ? null
      : (st?.channels.find((item) => item.index === channel && item.running) ?? null);
  const extended = sendExtended();
  const id = parseHex(els.sendId.value, extended ? 0x1fffffff : 0x7ff);
  const remote = els.sendRemote.checked;
  const bytes = remote ? [] : parseSendData(els.sendData.value);
  const dlc = remote ? Number(els.sendDlc.value) : (bytes?.length ?? 0);

  let reason = '';
  if (!open) reason = '先打开设备';
  else if (running === null) reason = '先启动一个通道';
  else if (running.mode === 'listen_only') reason = '只听模式不可发送';
  else if (id === null) reason = 'ID 无效或超出范围';
  else if (bytes === null) reason = '数据必须是 1–8 个十六进制字节';
  else if (remote && (!Number.isInteger(dlc) || dlc < 0 || dlc > 8)) reason = 'DLC 必须在 0–8';

  els.btnSend.disabled = reason !== '';
  els.sendHint.textContent =
    reason === ''
      ? remote
        ? '远程帧不携带数据；DLC 可设 0–8；回车发送。'
        : '数据支持 11 22 33 / 112233 / 0x11,0x22；回车发送。'
      : reason;
  els.sendHint.classList.toggle('error', reason !== '' && open && running !== null);
}

async function sendCurrentFrame(): Promise<void> {
  const channelValue = els.sendChannel.value;
  if (channelValue === '') {
    toast('没有可用的发送通道', 'warn');
    return;
  }
  const channel = Number(channelValue);
  const extended = sendExtended();
  const id = parseHex(els.sendId.value, extended ? 0x1fffffff : 0x7ff);
  if (id === null) {
    toast('发送 ID 无效或超出范围', 'warn');
    els.sendId.focus();
    return;
  }
  const remote = els.sendRemote.checked;
  const bytes = remote ? [] : parseSendData(els.sendData.value);
  if (bytes === null) {
    toast('发送数据格式无效', 'warn');
    els.sendData.focus();
    return;
  }
  const dlc = remote ? Number(els.sendDlc.value) : bytes.length;
  if (remote && (!Number.isInteger(dlc) || dlc < 0 || dlc > 8)) {
    toast('远程帧 DLC 必须在 0–8', 'warn');
    els.sendDlc.focus();
    return;
  }
  const body: SendBody = {
    channel,
    id,
    extended,
    remote,
    dlc,
    data: bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(' '),
  };
  const response = await api('/api/send', 'POST', body);
  const status = parseStatusDto(isObj(response) ? response['status'] : null);
  if (status) applyStatus(status);
  const label = 'CAN' + (channel + 1) + ' 0x' + id.toString(16).toUpperCase();
  const detail = remote ? '远程帧 DLC ' + dlc : bytes.length + ' 字节';
  toast('已发送 ' + label + ' （' + detail + '）', 'success');
  setLastLog('已发送 ' + label + ' （' + detail + '）');
}

function bindEvents(): void {
  els.btnRefreshDevices.addEventListener('click', () => {
    void runBusy(els.btnRefreshDevices, loadDevices);
  });

  els.deviceList.addEventListener('change', (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement && t.name === 'device') {
      state.selectedDevice = Number(t.value);
      renderDevices();
    }
  });

  els.btnOpenDevice.addEventListener('click', () => {
    void runBusy(els.btnOpenDevice, async () => {
      if (state.selectedDevice === null) return;
      const res = await api('/api/device/open', 'POST', { index: state.selectedDevice });
      const st = parseStatusDto(isObj(res) ? res['status'] : null);
      if (st) applyStatus(st);
      toast('设备已打开', 'success');
      await loadDevices();
    });
  });

  els.btnCloseDevice.addEventListener('click', () => {
    void runBusy(els.btnCloseDevice, async () => {
      const res = await api('/api/device/close', 'POST');
      const st = parseStatusDto(isObj(res) ? res['status'] : null);
      if (st) applyStatus(st);
      toast('设备已关闭，通道状态已复位', 'success');
      await loadDevices();
    });
  });

  els.ch1Check.addEventListener('change', updateControls);
  els.ch2Check.addEventListener('change', updateControls);

  els.btnApplyConfig.addEventListener('click', () => {
    void runBusy(els.btnApplyConfig, async () => {
      const body = collectConfig();
      if (!body) return;
      const res = await api('/api/config', 'POST', body);
      const st = parseStatusDto(isObj(res) ? res['status'] : null);
      if (st) applyStatus(st);
      const names = body.channels.map((c) => 'CAN' + (c + 1)).join('、');
      toast('配置已应用，' + names + ' 已启动 （' + body.baud + '）', 'success');
    });
  });

  els.btnStopChannels.addEventListener('click', () => {
    void runBusy(els.btnStopChannels, async () => {
      const res = await api('/api/stop', 'POST', {});
      const st = parseStatusDto(isObj(res) ? res['status'] : null);
      if (st) applyStatus(st);
      toast('已停止全部通道', 'success');
    });
  });

  els.btnAcceptAll.addEventListener('click', () => {
    els.accCodeInput.value = '0';
    els.accMaskInput.value = 'FFFFFFFF';
    els.filterModeSelect.value = '0';
    toast('已设置为接收全部帧', 'info');
  });

  els.btnApplyFilters.addEventListener('click', () => {
    void runBusy(els.btnApplyFilters, async () => {
      const channels = selectedChannels();
      if (channels.length === 0) {
        toast('请至少选择一个通道', 'warn');
        return;
      }
      const filter = collectHardwareFilter();
      if (filter === null) return;
      const software_filters = collectSoftwareFilters();
      if (software_filters === null) return;
      const res = await api('/api/filters', 'POST', { channels, filter, software_filters });
      const st = parseStatusDto(isObj(res) ? res['status'] : null);
      if (st) applyStatus(st);
      const names = channels.map((channel) => 'CAN' + (channel + 1)).join('、');
      toast('滤波已实时更新：' + names + '（通道未停止）', 'success');
      setLastLog('滤波已实时更新：' + names);
    });
  });

  els.btnFilterById.addEventListener('click', () => {
    const ext = els.filterIdExtended.checked;
    const maxId = ext ? 0x1fffffff : 0x7ff;
    const id = parseHex(els.filterIdInput.value, maxId);
    if (id === null) {
      toast('帧 ID 无效 （' + (ext ? '扩展帧最大 1FFFFFFF' : '标准帧最大 7FF') + '）', 'warn');
      els.filterIdInput.focus();
      return;
    }
    /* SJA1000 单滤波器位布局：标准帧 ID 位于高 11 位，扩展帧 ID 位于高 29 位 */
    const code = ext ? (id << 3) >>> 0 : (id << 21) >>> 0;
    const mask = ext ? 0x00000007 : 0x001fffff;
    els.accCodeInput.value = code.toString(16).toUpperCase();
    els.accMaskInput.value = mask.toString(16).toUpperCase();
    els.filterModeSelect.value = '1';
    toast(
      '已生成单滤波器：验收码 ' + hexOf(code, 8) + ' · 屏蔽码 ' + hexOf(mask, 8) + ' （应用配置后生效）',
      'success'
    );
  });

  els.btnAddFilter.addEventListener('click', () => {
    els.swFilterList.appendChild(buildSwRow(false));
  });

  els.btnRecStart.addEventListener('click', () => {
    void runBusy(els.btnRecStart, async () => {
      const res = await api('/api/recording/start', 'POST');
      const st = parseStatusDto(isObj(res) ? res['status'] : null);
      if (st) applyStatus(st);
      const file = isObj(res) && isStr(res['file']) ? res['file'] : '';
      toast('开始录制：' + file, 'success');
      await loadRecordings();
    });
  });

  els.btnRecStop.addEventListener('click', () => {
    void runBusy(els.btnRecStop, async () => {
      const res = await api('/api/recording/stop', 'POST');
      const st = parseStatusDto(isObj(res) ? res['status'] : null);
      if (st) applyStatus(st);
      const file = isObj(res) && isStr(res['file']) ? res['file'] : '';
      const frames = isObj(res) && isNum(res['frames']) ? fmtInt(res['frames']) : '—';
      toast('已保存 ' + file + ' （' + frames + ' 帧）', 'success');
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
      await api('/api/frames/clear', 'POST');
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
    radio.addEventListener('change', updateSendControls);
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
    void runBusy(els.btnSend, sendCurrentFrame);
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
}

/* ---------- 周期任务与启动 ---------- */

function tickTimers(): void {
  const st = state.status;
  if (st && st.recording.active && st.recording.started_at_ms !== null) {
    els.recActiveElapsed.textContent = fmtDur(Date.now() - st.recording.started_at_ms);
  }
}

function init(): void {
  bindEvents();
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

init();
