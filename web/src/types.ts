/**
 * 对外数据契约：与 docs/api.md 一致的 DTO 类型、波特率/模式常量，
 * 以及把 unknown JSON 收窄为 DTO 的类型守卫。本模块不触碰 DOM。
 */

/* ---------- API 数据形状（与 docs/api.md 一致） ---------- */

import { parseNullableDbc } from './dbc-types';
import type { DbcDefinitionDto } from './dbc-types';

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
}

export interface StatusDto {
  device: DeviceStatusDto;
  channels: ChannelStatusDto[];
  software_filters: SoftwareFilterDto[];
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

/** POST /api/config 请求体 */
export interface ConfigBody {
  channels: number[];
  baud: Baud;
  mode: CanMode;
  filter: AcceptanceFilterDto;
  software_filters: SoftwareFilterDto[];
  /** 要启动/重启的 SocketCAN 接口名；channels 与 socketcan 不可同时为空。 */
  socketcan: string[];
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

/** WebSocket 服务端消息（快照 + 事件） */
export type WsServerMessage =
  | { type: 'snapshot'; status: StatusDto; frames: FrameDto[]; dbc: DbcDefinitionDto | null }
  | { type: 'frames'; frames: FrameDto[] }
  | { type: 'status'; status: StatusDto }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'dbc'; dbc: DbcDefinitionDto | null }
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
      /* 快照里的 dbc 字段缺失视为「无定义」，非法也按 null 处理以免阻断快照 */
      const dbcRaw = v['dbc'];
      const dbc = dbcRaw === undefined ? null : parseNullableDbc(dbcRaw) ?? null;
      return { type: 'snapshot', status: st, frames: parseFrames(v['frames']), dbc };
    }
    case 'frames':
      return { type: 'frames', frames: parseFrames(v['frames']) };
    case 'status': {
      const st = parseStatusDto(v['status']);
      return st ? { type: 'status', status: st } : null;
    }
    case 'dbc': {
      const dbc = parseNullableDbc(v['dbc']);
      /* 缺失/非法 dbc 字段视为坏消息，避免误删已加载定义 */
      return dbc === undefined ? null : { type: 'dbc', dbc };
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
