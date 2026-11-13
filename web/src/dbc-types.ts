/**
 * DBC 定义的数据契约与收窄守卫（与 /tmp/opencode/dbc-contract.md 第 1 节一致）。
 * 从 types.ts 拆出以控制单文件行数；types.ts 重新导出本模块，外部 import 路径不变。
 */
import { isNum, isObj, isStr, numOr, strOr } from './types';

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
