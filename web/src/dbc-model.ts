/**
 * DBC 解码纯函数层：帧数据解析、位提取、信号物理值、报文匹配。
 * 零 DOM、零状态，便于独立单元测试；位布局按 /tmp/opencode/dbc-contract.md 第 5 节。
 */
import type { DbcDefinitionDto, DbcMessageDto, DbcSignalDto, FrameDto } from './types';

export interface DecodedSignal {
  signal: DbcSignalDto;
  /** 已乘 factor 并加 offset 的物理值；float/double 为浮点原值。 */
  value: number;
}

export interface DecodedMessage {
  message: DbcMessageDto;
  values: DecodedSignal[];
}

/**
 * 把 frame.data 解析为字节数组：长度取 dlc 与数据长度较小值。
 * 远程帧、空数据返回长度为 0 的数组；非法字节按 0 处理（后端已保证格式）。
 */
export function parseFrameData(frame: FrameDto): Uint8Array {
  if (frame.remote) return new Uint8Array(0);
  const raw = frame.data.trim();
  if (raw.length === 0) return new Uint8Array(0);
  let tokens = raw.split(/\s+/);
  if (tokens.length === 1 && tokens[0].length > 2) {
    /* 兼容无空格连写形式，如 "112233" */
    const joined = tokens[0];
    const parts: string[] = [];
    for (let i = 0; i + 1 < joined.length; i += 2) parts.push(joined.slice(i, i + 2));
    tokens = parts;
  }
  const dlc = Number.isFinite(frame.dlc) ? Math.max(0, Math.trunc(frame.dlc)) : tokens.length;
  const count = Math.min(dlc, tokens.length);
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const b = parseInt(tokens[i], 16);
    out[i] = Number.isFinite(b) && b >= 0 && b <= 0xff ? b : 0;
  }
  return out;
}

/**
 * 按 DBC 位布局提取无符号原始位模式（BigInt，可容纳 64 位）。
 * 长度必须为 1..64；任何所需位越过 data 末尾、start_bit 为负或非整数时返回 null。
 */
export function extractRaw(data: Uint8Array, sig: DbcSignalDto): bigint | null {
  const len = sig.length;
  const start = sig.start_bit;
  if (!Number.isInteger(len) || len < 1 || len > 64) return null;
  if (!Number.isInteger(start) || start < 0) return null;
  const totalBits = data.length * 8;

  if (sig.little_endian) {
    /* Intel：value 第 i 位来自绝对位 start+i（绝对位 b → 字节 b>>3、位 b&7）。 */
    if (start + len > totalBits) return null;
    let raw = 0n;
    for (let i = 0; i < len; i++) {
      const abs = start + i;
      const bit = (data[abs >> 3] >> (abs & 7)) & 1;
      if (bit === 1) raw |= 1n << BigInt(i);
    }
    return raw;
  }

  /* Motorola：从 start_bit（MSB）起逐位右移，跨字节时 pos%8==0 → pos+15。 */
  let raw = 0n;
  let pos = start;
  for (let i = 0; i < len; i++) {
    if (pos < 0 || pos >= totalBits) return null;
    const bit = (data[pos >> 3] >> (pos & 7)) & 1;
    raw = (raw << 1n) | BigInt(bit);
    pos = pos % 8 === 0 ? pos + 15 : pos - 1;
  }
  return raw;
}

/** 按 value_kind 把位模式解释为有符号整数；signed 时按二进制补码回绕。 */
function toSigned(raw: bigint, len: number): bigint {
  const sign = 1n << BigInt(len - 1);
  return raw >= sign ? raw - (sign << 1n) : raw;
}

/** 提取原始整数值（有符号按补码）；位数非法或越界返回 null。 */
export function extractInteger(data: Uint8Array, sig: DbcSignalDto): bigint | null {
  const raw = extractRaw(data, sig);
  if (raw === null) return null;
  return sig.value_kind === 'signed' ? toSigned(raw, sig.length) : raw;
}

/**
 * 解码单个信号的物理值。float/double 要求长度恰为 32/64，按大端位模式用 DataView 解析。
 * 越界、长度非法或类型非法时返回 null；factor/offset 非法时回退 1/0。
 */
export function decodeSignal(data: Uint8Array, sig: DbcSignalDto): number | null {
  const raw = extractRaw(data, sig);
  if (raw === null) return null;
  const len = sig.length;

  if (sig.value_kind === 'float' || sig.value_kind === 'double') {
    const bytes = sig.value_kind === 'float' ? 4 : 8;
    if (len !== bytes * 8) return null;
    const view = new DataView(new ArrayBuffer(bytes));
    /* factor/offset 对浮点信号同样生效（多数 DBC 为 1/0，保持标准换算语义）。 */
    const factor = Number.isFinite(sig.factor) ? sig.factor : 1;
    const offset = Number.isFinite(sig.offset) ? sig.offset : 0;
    if (bytes === 4) {
      view.setUint32(0, Number(raw & 0xffffffffn), false);
      return view.getFloat32(0, false) * factor + offset;
    }
    view.setBigUint64(0, raw & 0xffffffffffffffffn, false);
    return view.getFloat64(0, false) * factor + offset;
  }

  const int = sig.value_kind === 'signed' ? toSigned(raw, len) : raw;
  /* 先转 Number 再算物理值：>53 位时低精度可接受，避免 BigInt 无法乘小数。 */
  const factor = Number.isFinite(sig.factor) ? sig.factor : 1;
  const offset = Number.isFinite(sig.offset) ? sig.offset : 0;
  return Number(int) * factor + offset;
}

/**
 * 解码整条报文：先取多路选择器（M）的原始整数值，再逐信号解码。
 * mN 信号仅在选择器存在且原始值相等时有效；选择器缺失或越界时跳过其子信号。
 */
export function decodeMessage(message: DbcMessageDto, data: Uint8Array): DecodedSignal[] {
  let hasMux = false;
  let muxValue: bigint | null = null;
  for (const sig of message.signals) {
    if (sig.mux?.is_multiplexer === true) {
      hasMux = true;
      muxValue = extractInteger(data, sig);
      break;
    }
  }

  const out: DecodedSignal[] = [];
  for (const sig of message.signals) {
    if (sig.mux !== null && !sig.mux.is_multiplexer) {
      if (!hasMux || muxValue === null || sig.mux.value === null) continue;
      if (BigInt(Math.trunc(sig.mux.value)) !== muxValue) continue;
    }
    const value = decodeSignal(data, sig);
    if (value !== null) out.push({ signal: sig, value });
  }
  return out;
}

/** 匹配一条帧对应的全部 DBC 报文（同 id 且帧类型一致）。 */
export function matchMessages(frame: FrameDto, def: DbcDefinitionDto): DbcMessageDto[] {
  return def.messages.filter((m) => m.id === frame.id && m.extended === frame.extended);
}

/** 解码一帧：返回所有匹配报文的解码结果；无匹配返回空数组。 */
export function decodeFrame(frame: FrameDto, def: DbcDefinitionDto): DecodedMessage[] {
  const messages = matchMessages(frame, def);
  if (messages.length === 0) return [];
  const data = parseFrameData(frame);
  return messages.map((message) => ({ message, values: decodeMessage(message, data) }));
}

/** 序列稳定 key：帧类型 + CAN ID + 信号名（同名信号不会出现在同一报文）。 */
export function signalKey(message: DbcMessageDto, signal: DbcSignalDto): string {
  return (message.extended ? 'x' : 's') + message.id.toString(16) + ':' + signal.name;
}
