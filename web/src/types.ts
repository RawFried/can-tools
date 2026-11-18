/**
 * 对外数据契约：与 docs/api.md 一致的 DTO 类型、波特率/模式常量，
 * 以及把 unknown JSON 收窄为 DTO 的类型守卫。本模块不触碰 DOM。
 */

/* ---------- API 数据形状（与 docs/api.md 一致） ---------- */

import { parseDbcDto, parseNullableDbc } from './dbc-types';
import type { DbcChannelDto, DbcDefinitionDto } from './dbc-types';

/* DBC 契约已拆到 dbc-types.ts；重新导出以保持既有 import 路径不变 */
export * from './dbc-types';

export const BAUDS = ['5k', '10k', '20k', '50k', '100k', '125k', '250k', '500k', '800k', '1000k'] as const;
export type Baud = typeof BAUDS[number];

export const MODES = ['normal', 'listen_only', 'self_test'] as const;
export type CanMode = typeof MODES[number];

export type FilterMode = 0 | 1 | 2;

export interface DeviceInfoDto {
  index: number;
  fw_version: string;
  serial: string;
  hw_type: string;
  channel_count: number;
}

export interface DeviceStatusDto {
  open: boolean;
  info: DeviceInfoDto | null;
}

export interface AcceptanceFilterDto {
  acc_code: number;
  acc_mask: number;
  mode: FilterMode;
}

/** 通道来源：USB 硬件的 CAN1/CAN2，或 Linux SocketCAN 链路。 */
export type ChannelSource = 'usb' | 'socketcan';

/** 通道帧率与总线负载（后端每秒计算一次）。 */
export interface ChannelMetricsDto {
  /** 该通道自启动以来放行的帧数。 */
  rx_frames: number;
  /** 最近一个统计窗口的帧率（帧/秒）。 */
  rx_rate: number;
  /** 总线负载百分比（0–100 估算值）；速率未知时为 null。 */
  bus_load: number | null;
}

export interface ChannelStatusDto {
  index: number;
  source: ChannelSource;
  name: string;
  running: boolean;
  baud: Baud | null;
  mode: CanMode | null;
  filter: AcceptanceFilterDto | null;
  /** SocketCAN 链路速率（sysfs 可读时有值），USB 为 null。 */
  bitrate: number | null;
  /** SocketCAN 接口状态（up/down/unknown），USB 为 null。 */
  state: string | null;
  /** 该通道当前生效的软件滤波区间（空数组 = 全部接收）。 */
  software_filters: SoftwareFilterDto[];
  /** 该通道的帧率与总线负载；停止时为零值。 */
  metrics: ChannelMetricsDto;
}

/** GET /api/devices 中 socketcan 数组的项。 */
export interface SocketCanLinkDto {
  name: string;
  channel: number;
  bitrate: number | null;
  state: string | null;
  running: boolean;
}

/** GET /api/devices 响应：USB 设备列表 + 发现的 SocketCAN 链路。 */
export interface DevicesResponseDto {
  devices: DeviceInfoDto[];
  socketcan: SocketCanLinkDto[];
}

export interface SoftwareFilterDto {
  extended: boolean;
  start: number;
  end: number;
}

export interface RecordingStatusDto {
  active: boolean;
  file: string | null;
  frames: number | null;
  started_at_ms: number | null;
}

export interface StatsDto {
  rx_frames: number;
  filtered_frames: number;
  rx_rate: number;
  recorded_frames: number;
  tx_frames: number;
}

export interface ServerDto {
  version: string;
  data_dir: string;
  /** 当前录制 CSV 的保存目录（空串表示后端默认目录）。 */
  recordings_dir: string;
}

export interface StatusDto {
  device: DeviceStatusDto;
  channels: ChannelStatusDto[];
  recording: RecordingStatusDto;
  stats: StatsDto;
  server: ServerDto;
}

export interface FrameDto {
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

export interface RecordingFileDto {
  name: string;
  size: number;
  modified_ms: number;
}

/** 单个 USB 通道的启动配置（v5：每通道独立波特率与滤波）。 */
export interface UsbChannelConfigDto {
  index: number;
  baud: Baud;
  filter: AcceptanceFilterDto;
  software_filters: SoftwareFilterDto[];
}

/** 单条 SocketCAN 链路的启动配置（无硬件验收滤波）。 */
export interface SocketCanChannelConfigDto {
  name: string;
  bitrate: number;
  software_filters: SoftwareFilterDto[];
}

/** POST /api/config 请求体（v5：按通道统一配置与滤波）。 */
export interface ConfigBody {
  usb: UsbChannelConfigDto[];
  socketcan: SocketCanChannelConfigDto[];
  mode: CanMode;
}

/** POST /api/filters 中单条通道更新。 */
export interface FilterUpdateChannelDto {
  channel: number;
  /** USB 通道可带硬件验收滤波；SocketCAN 忽略该字段。 */
  filter?: AcceptanceFilterDto;
  software_filters: SoftwareFilterDto[];
}

/** POST /api/filters 请求体（v5：按通道列表更新）。 */
export interface FilterUpdateBody {
  channels: FilterUpdateChannelDto[];
}

/** POST /api/send 请求体 */
export interface SendBody {
  channel: number;
  id: number;
  extended: boolean;
  remote: boolean;
  dlc: number;
  data: string;
}

/** GET/POST /api/dbc/{channel} 的响应：单通道定义。 */
export interface DbcResponseDto {
  channel: number;
  dbc: DbcDefinitionDto | null;
}

/** WebSocket 服务端消息（快照 + 事件） */
export type WsServerMessage =
  | { type: 'snapshot'; status: StatusDto; frames: FrameDto[]; dbcs: DbcChannelDto[] }
  | { type: 'frames'; frames: FrameDto[] }
  | { type: 'status'; status: StatusDto }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'dbc'; channel: number; dbc: DbcDefinitionDto | null }
  | { type: 'cleared' };

/* ---------- JSON 类型守卫 ---------- */

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
export function isStr(v: unknown): v is string {
  return typeof v === 'string';
}
export function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
export function numOr(v: unknown, d: number): number {
  return isNum(v) ? v : d;
}
export function strOr(v: unknown, d: string): string {
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
export function asBaud(v: unknown): Baud | null {
  return isStr(v) && (BAUDS as readonly string[]).includes(v) ? (v as Baud) : null;
}
export function asMode(v: unknown): CanMode | null {
  return isStr(v) && (MODES as readonly string[]).includes(v) ? (v as CanMode) : null;
}

/** 收窄某通道的软件滤波区间列表；非数组或非法项按空数组/跳过处理。 */
function parseSoftwareFilters(v: unknown): SoftwareFilterDto[] {
  if (!Array.isArray(v)) return [];
  const out: SoftwareFilterDto[] = [];
  for (const f of v) {
    if (!isObj(f)) continue;
    out.push({
      extended: f['extended'] === true,
      start: numOr(f['start'], 0),
      end: numOr(f['end'], 0),
    });
  }
  return out;
}

/** 收窄通道统计；旧版后端没有 metrics 字段时按零值处理。 */
function parseChannelMetrics(v: unknown): ChannelMetricsDto {
  if (!isObj(v)) return { rx_frames: 0, rx_rate: 0, bus_load: null };
  return {
    rx_frames: numOr(v['rx_frames'], 0),
    rx_rate: numOr(v['rx_rate'], 0),
    bus_load: isNum(v['bus_load']) ? v['bus_load'] : null,
  };
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

/** 收窄快照的 dbcs 数组；非法项（缺通道号或定义损坏）直接跳过。 */
export function parseDbcChannels(v: unknown): DbcChannelDto[] {
  if (!Array.isArray(v)) return [];
  const out: DbcChannelDto[] = [];
  for (const it of v) {
    if (!isObj(it) || !isNum(it['channel'])) continue;
    const dbc = parseDbcDto(it['dbc']);
    if (dbc !== null) out.push({ channel: it['channel'], dbc });
  }
  return out;
}

/** 收窄 /api/dbc/{channel} 的响应；格式不完整时返回 null（调用方报错）。 */
export function parseDbcResponse(v: unknown): DbcResponseDto | null {
  if (!isObj(v) || !isNum(v['channel'])) return null;
  const dbc = parseNullableDbc(v['dbc']);
  if (dbc === undefined) return null;
  return { channel: v['channel'], dbc };
}

/** 校验并收窄未知 JSON 为 StatusDto；缺少关键结构时返回 null。 */
export function parseStatusDto(v: unknown): StatusDto | null {
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
      const index = numOr(c['index'], channels.length);
      /* 旧版状态没有 source/name 字段：按索引推断来源并给出可读名称 */
      const source: ChannelSource =
        c['source'] === 'usb'
          ? 'usb'
          : c['source'] === 'socketcan'
            ? 'socketcan'
            : index < 2
              ? 'usb'
              : 'socketcan';
      const fallbackName = source === 'usb' ? 'CAN' + (index + 1) : 'CH' + (index + 1);
      const name = strOr(c['name'], '').trim() || fallbackName;
      const filter = isObj(c['filter'])
        ? {
            acc_code: numOr(c['filter']['acc_code'], 0),
            acc_mask: numOr(c['filter']['acc_mask'], 0xffffffff),
            mode: asFilterMode(c['filter']['mode']),
          }
        : null;
      channels.push({
        index,
        source,
        name,
        running: c['running'] === true,
        baud: asBaud(c['baud']),
        mode: asMode(c['mode']),
        filter,
        bitrate: isNum(c['bitrate']) ? c['bitrate'] : null,
        state: isStr(c['state']) ? c['state'] : null,
        software_filters: parseSoftwareFilters(c['software_filters']),
        metrics: parseChannelMetrics(c['metrics']),
      });
    }
  }

  const rec = isObj(v['recording']) ? v['recording'] : {};
  const stats = isObj(v['stats']) ? v['stats'] : {};
  const srv = isObj(v['server']) ? v['server'] : {};

  return {
    device: { open: dev['open'] === true, info },
    channels,
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
    server: {
      version: strOr(srv['version'], ''),
      data_dir: strOr(srv['data_dir'], ''),
      recordings_dir: strOr(srv['recordings_dir'], ''),
    },
  };
}

/** 校验并收窄 GET /api/devices；旧响应缺少 socketcan 时按空列表处理。 */
export function parseDevicesDto(v: unknown): DevicesResponseDto {
  const devices: DeviceInfoDto[] = [];
  const socketcan: SocketCanLinkDto[] = [];
  if (!isObj(v)) return { devices, socketcan };

  if (Array.isArray(v['devices'])) {
    for (const d of v['devices']) {
      if (!isObj(d)) continue;
      devices.push({
        index: numOr(d['index'], 0),
        fw_version: cleanText(d['fw_version']),
        serial: cleanText(d['serial']),
        hw_type: cleanText(d['hw_type']),
        channel_count: numOr(d['channel_count'], 0),
      });
    }
  }

  if (Array.isArray(v['socketcan'])) {
    for (const l of v['socketcan']) {
      if (!isObj(l)) continue;
      const name = cleanText(l['name']);
      if (name.length === 0) continue;
      socketcan.push({
        name,
        channel: numOr(l['channel'], 2 + socketcan.length),
        bitrate: isNum(l['bitrate']) ? l['bitrate'] : null,
        state: isStr(l['state']) ? l['state'] : null,
        running: l['running'] === true,
      });
    }
  }

  return { devices, socketcan };
}

export function parseRecordingsDto(v: unknown): RecordingFileDto[] {
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
export function parseWsMessage(v: unknown): WsServerMessage | null {
  if (!isObj(v)) return null;
  const t = isStr(v['type']) ? v['type'] : '';
  switch (t) {
    case 'snapshot': {
      const st = parseStatusDto(v['status']);
      if (!st) return null;
      return {
        type: 'snapshot',
        status: st,
        frames: parseFrames(v['frames']),
        dbcs: parseDbcChannels(v['dbcs']),
      };
    }
    case 'frames':
      return { type: 'frames', frames: parseFrames(v['frames']) };
    case 'status': {
      const st = parseStatusDto(v['status']);
      return st ? { type: 'status', status: st } : null;
    }
    case 'dbc': {
      if (!isNum(v['channel'])) return null;
      const dbc = parseNullableDbc(v['dbc']);
      /* 缺失/非法 dbc 字段视为坏消息，避免误删已加载定义 */
      return dbc === undefined ? null : { type: 'dbc', channel: v['channel'], dbc };
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
