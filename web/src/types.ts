/**
 * 对外数据契约：与 docs/api.md 一致的 DTO 类型、波特率/模式常量，
 * 以及把 unknown JSON 收窄为 DTO 的类型守卫。本模块不触碰 DOM。
 */

/* ---------- API 数据形状（与 docs/api.md 一致） ---------- */

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

export interface ChannelStatusDto {
  index: number;
  running: boolean;
  baud: Baud | null;
  mode: CanMode | null;
  filter: AcceptanceFilterDto | null;
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

/* ---------- DBC 定义（与 /tmp/opencode/dbc-contract.md 第 1 节一致） ---------- */

export type DbcValueKind = 'unsigned' | 'signed' | 'float' | 'double';

/** VAL_ 取值表项；raw 为 i64，可负。 */
export interface DbcValueDto {
  raw: number;
  label: string;
}

/** 多路复用信息：M 信号 is_multiplexer=true、value=null；mN 信号 value=N。 */
export interface DbcMuxDto {
  is_multiplexer: boolean;
  value: number | null;
}

export interface DbcSignalDto {
  name: string;
  start_bit: number;
  length: number;
  little_endian: boolean;
  signed: boolean;
  factor: number;
  offset: number;
  min: number;
  max: number;
  unit: string;
  receivers: string[];
  value_kind: DbcValueKind;
  mux: DbcMuxDto | null;
  values: DbcValueDto[];
}

export interface DbcMessageDto {
  id: number;
  extended: boolean;
  name: string;
  dlc: number;
  sender: string;
  signals: DbcSignalDto[];
}

export interface DbcDefinitionDto {
  name: string;
  loaded_at_ms: number;
  messages: DbcMessageDto[];
}

/** POST /api/config 请求体 */
export interface ConfigBody {
  channels: number[];
  baud: Baud;
  mode: CanMode;
  filter: AcceptanceFilterDto;
  software_filters: SoftwareFilterDto[];
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

export function parseDevicesDto(v: unknown): DeviceInfoDto[] {
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

const DBC_VALUE_KINDS: readonly DbcValueKind[] = ['unsigned', 'signed', 'float', 'double'];

function asValueKind(v: unknown): DbcValueKind {
  return isStr(v) && (DBC_VALUE_KINDS as readonly string[]).includes(v)
    ? (v as DbcValueKind)
    : 'unsigned';
}

function parseDbcValues(v: unknown): DbcValueDto[] {
  if (!Array.isArray(v)) return [];
  const out: DbcValueDto[] = [];
  for (const it of v) {
    if (!isObj(it)) continue;
    out.push({ raw: numOr(it['raw'], 0), label: strOr(it['label'], '') });
  }
  return out;
}

function parseDbcMux(v: unknown): DbcMuxDto | null {
  if (!isObj(v)) return null;
  return {
    is_multiplexer: v['is_multiplexer'] === true,
    value: isNum(v['value']) ? v['value'] : null,
  };
}

function parseDbcSignal(v: unknown): DbcSignalDto | null {
  if (!isObj(v)) return null;
  return {
    name: strOr(v['name'], ''),
    start_bit: numOr(v['start_bit'], 0),
    length: numOr(v['length'], 0),
    little_endian: v['little_endian'] !== false,
    signed: v['signed'] === true,
    factor: numOr(v['factor'], 1),
    offset: numOr(v['offset'], 0),
    min: numOr(v['min'], 0),
    max: numOr(v['max'], 0),
    unit: strOr(v['unit'], ''),
    receivers: Array.isArray(v['receivers']) ? v['receivers'].filter(isStr) : [],
    value_kind: asValueKind(v['value_kind']),
    mux: parseDbcMux(v['mux']),
    values: parseDbcValues(v['values']),
  };
}

function parseDbcMessage(v: unknown): DbcMessageDto | null {
  if (!isObj(v)) return null;
  const signals: DbcSignalDto[] = [];
  if (Array.isArray(v['signals'])) {
    for (const s of v['signals']) {
      const parsed = parseDbcSignal(s);
      if (parsed) signals.push(parsed);
    }
  }
  return {
    id: numOr(v['id'], 0),
    extended: v['extended'] === true,
    name: strOr(v['name'], ''),
    dlc: numOr(v['dlc'], 8),
    sender: strOr(v['sender'], ''),
    signals,
  };
}

/**
 * 校验并收窄未知 JSON 为 DbcDefinitionDto；非对象返回 null。
 * 字段缺失时给默认值（messages/signals 非数组或为空按空数组），保证 key 齐全。
 */
export function parseDbcDto(v: unknown): DbcDefinitionDto | null {
  if (!isObj(v)) return null;
  const messages: DbcMessageDto[] = [];
  if (Array.isArray(v['messages'])) {
    for (const m of v['messages']) {
      const parsed = parseDbcMessage(m);
      if (parsed) messages.push(parsed);
    }
  }
  return {
    name: strOr(v['name'], ''),
    loaded_at_ms: numOr(v['loaded_at_ms'], 0),
    messages,
  };
}

/**
 * 收窄 `dbc` 字段：null → null（无定义）；undefined 或非法 → undefined（不可用）。
 * 调用方据此区分「明确没有定义」与「字段损坏」。
 */
export function parseNullableDbc(v: unknown): DbcDefinitionDto | null | undefined {
  if (v === null) return null;
  if (v === undefined) return undefined;
  return parseDbcDto(v) ?? undefined;
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
