/**
 * dbc-model 纯函数测试：零依赖断言（失败即 throw），由 esbuild 打包后 node 运行。
 * 覆盖契约第 5 节的位布局、有符号、float/double、factor/offset、mux 与越界路径。
 */
import {
  decodeFrame,
  decodeMessage,
  decodeSignal,
  extractInteger,
  extractRaw,
  matchMessages,
  parseFrameData,
  signalKey,
} from '../src/dbc-model';
import type { DbcMessageDto, DbcSignalDto, FrameDto } from '../src/types';

let passed = 0;

function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log('  ✓ ' + name);
}

function eq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(label + '：期望 ' + String(expected) + '，实际 ' + String(actual));
  }
}

function near(actual: number | null, expected: number, label: string): void {
  if (actual === null || Math.abs(actual - expected) > 1e-9) {
    throw new Error(label + '：期望 ' + expected + '，实际 ' + String(actual));
  }
}

function frame(data: string, dlc = 8): FrameDto {
  return {
    seq: 0,
    time_ms: 1000,
    device_ts: 0,
    channel: 0,
    id: 0x123,
    extended: false,
    remote: false,
    dlc,
    data,
  };
}

function sig(over: Partial<DbcSignalDto> = {}): DbcSignalDto {
  return {
    name: 'S',
    start_bit: 0,
    length: 8,
    little_endian: true,
    signed: false,
    factor: 1,
    offset: 0,
    min: 0,
    max: 0,
    unit: '',
    receivers: [],
    value_kind: 'unsigned',
    mux: null,
    values: [],
    ...over,
  };
}

function message(signals: DbcSignalDto[], over: Partial<DbcMessageDto> = {}): DbcMessageDto {
  return { id: 0x123, extended: false, name: 'Msg', dlc: 8, sender: 'ECU', signals, ...over };
}

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

/* ---------- parseFrameData ---------- */

test('parseFrameData 空数据返回空数组', () => {
  eq(parseFrameData(frame('')).length, 0, '空 data');
  eq(parseFrameData(frame('', 0)).length, 0, 'dlc=0');
});

test('parseFrameData 取 dlc 与数据长度较小值', () => {
  const data = parseFrameData(frame('11 22 33', 2));
  eq(data.length, 2, '长度');
  eq(data[0], 0x11, 'byte0');
  eq(data[1], 0x22, 'byte1');
});

test('parseFrameData 远程帧无数据', () => {
  eq(parseFrameData({ ...frame('11 22'), remote: true }).length, 0, '远程帧');
});

/* ---------- Intel ---------- */

test('Intel 8 位', () => {
  const s = sig({ start_bit: 0, length: 8 });
  const data = bytes(0x7f);
  eq(extractRaw(data, s), 0x7fn, 'raw');
  near(decodeSignal(data, s), 127, '物理值');
});

test('Intel 16 位（从字节 1 起）', () => {
  const s = sig({ start_bit: 8, length: 16 });
  const data = bytes(0x00, 0x12, 0x34);
  eq(extractRaw(data, s), 0x3412n, 'raw');
  near(decodeSignal(data, s), 0x3412, '物理值');
});

test('Intel 跨字节 12 位（start 4）', () => {
  const s = sig({ start_bit: 4, length: 12 });
  const data = bytes(0xab, 0xcd);
  eq(extractRaw(data, s), 0xcdan, 'raw');
  near(decodeSignal(data, s), 3290, '物理值');
});

test('Intel 64 位无符号不受 Number 精度限制', () => {
  const s = sig({ start_bit: 0, length: 64 });
  const data = bytes(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
  eq(extractRaw(data, s), 0xffffffffffffffffn, 'raw');
});

/* ---------- Motorola ---------- */

test('Motorola 16 位（start 7，MSB 优先）', () => {
  const s = sig({ start_bit: 7, length: 16, little_endian: false });
  const data = bytes(0x12, 0x34);
  eq(extractRaw(data, s), 0x1234n, 'raw');
  near(decodeSignal(data, s), 0x1234, '物理值');
});

test('Motorola 12 位非字节对齐（start 3）', () => {
  const s = sig({ start_bit: 3, length: 12, little_endian: false });
  const data = bytes(0xa5, 0x3c);
  eq(extractRaw(data, s), 0x53cn, 'raw');
  near(decodeSignal(data, s), 1340, '物理值');
});

/* ---------- 有符号 ---------- */

test('有符号 8 位负值（0xFF → -1）', () => {
  const s = sig({ length: 8, signed: true, value_kind: 'signed' });
  near(decodeSignal(bytes(0xff), s), -1, '值');
});

test('有符号 12 位负值（0xFFF → -1）', () => {
  const s = sig({ length: 12, signed: true, value_kind: 'signed' });
  near(decodeSignal(bytes(0xff, 0x0f), s), -1, '值');
});

test('有符号正数不触发补码回绕', () => {
  const s = sig({ length: 8, signed: true, value_kind: 'signed' });
  near(decodeSignal(bytes(0x7f), s), 127, '值');
});

/* ---------- factor / offset ---------- */

test('factor 与 offset 参与物理值计算', () => {
  const s = sig({ length: 8, factor: 0.5, offset: -10 });
  near(decodeSignal(bytes(100), s), 40, '值');
});

/* ---------- float / double ---------- */

test('float（SIG_VALTYPE_ 1）按大端位模式解析', () => {
  const s = sig({ length: 32, value_kind: 'float' });
  const data = bytes(0x00, 0x00, 0x80, 0x3f); /* 0x3F800000 → 1.0 */
  near(decodeSignal(data, s), 1, '值');
});

test('double（SIG_VALTYPE_ 2）按大端位模式解析', () => {
  const s = sig({ length: 64, value_kind: 'double' });
  const data = bytes(0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f);
  near(decodeSignal(data, s), 1, '值');
});

test('float 长度非 32 返回 null', () => {
  eq(decodeSignal(bytes(0x00, 0x00), sig({ length: 16, value_kind: 'float' })), null, '值');
});

test('float 同样应用 factor 与 offset', () => {
  const s = sig({ length: 32, value_kind: 'float', factor: 2, offset: 1 });
  near(decodeSignal(bytes(0x00, 0x00, 0x80, 0x3f), s), 3, '值');
});

/* ---------- mux ---------- */

const muxM = sig({ name: 'M', start_bit: 0, length: 8, mux: { is_multiplexer: true, value: null } });
const muxA = sig({
  name: 'A',
  start_bit: 8,
  length: 8,
  mux: { is_multiplexer: false, value: 1 },
});
const muxB = sig({
  name: 'B',
  start_bit: 8,
  length: 8,
  mux: { is_multiplexer: false, value: 3 },
});
const muxMsg = message([muxM, muxA, muxB]);

test('mux：选择器为 3 时只命中 m3', () => {
  const values = decodeMessage(muxMsg, bytes(3, 0x42));
  const names = values.map((v) => v.signal.name);
  eq(names.join(','), 'M,B', '命中信号');
  near(values.find((v) => v.signal.name === 'B')?.value ?? null, 66, 'B 的值');
});

test('mux：选择器为 1 时只命中 m1', () => {
  const values = decodeMessage(muxMsg, bytes(1, 0x0a));
  eq(values.map((v) => v.signal.name).join(','), 'M,A', '命中信号');
});

test('mux：选择器缺失时跳过子信号', () => {
  eq(decodeMessage(muxMsg, bytes()).length, 0, '全部跳过');
});

test('extractInteger 解析多路选择器原始值', () => {
  eq(extractInteger(bytes(3), muxM), 3n, 'M 原始值');
});

/* ---------- 越界 ---------- */

test('所需位超出数据长度返回 null', () => {
  const s = sig({ start_bit: 0, length: 16 });
  eq(extractRaw(bytes(0x7f), s), null, 'extractRaw');
  eq(decodeSignal(bytes(0x7f), s), null, 'decodeSignal');
});

test('Motorola 越界返回 null', () => {
  const s = sig({ start_bit: 7, length: 16, little_endian: false });
  eq(extractRaw(bytes(0x12), s), null, 'extractRaw');
});

test('长度 0 或 65 视为非法', () => {
  eq(extractRaw(bytes(0xff), sig({ length: 0 })), null, '长度 0');
  eq(extractRaw(bytes(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff), sig({ length: 65 })), null, '长度 65');
});

/* ---------- 报文匹配与整帧解码 ---------- */

test('matchMessages 同时匹配 id 与帧类型', () => {
  const def = {
    name: 'demo.dbc',
    loaded_at_ms: 0,
    messages: [message([sig()]), message([sig()], { id: 0x124 }), message([sig()], { extended: true })],
  };
  eq(matchMessages(frame('00'), def).length, 1, '标准帧');
  eq(matchMessages({ ...frame('00'), extended: true }, def).length, 1, '扩展帧同 id');
});

test('decodeFrame 返回匹配报文的解码值', () => {
  const s = sig({ start_bit: 0, length: 8 });
  const def = { name: 'demo.dbc', loaded_at_ms: 0, messages: [message([s])] };
  const out = decodeFrame(frame('2A', 1), def);
  eq(out.length, 1, '报文数');
  near(out[0].values[0]?.value ?? null, 42, '值');
});

test('signalKey 区分帧类型与信号名', () => {
  const a = message([sig({ name: 'X' })]);
  const b = message([sig({ name: 'X' })], { extended: true });
  eq(signalKey(a, a.signals[0]) !== signalKey(b, b.signals[0]), true, 'key 不同');
  eq(signalKey(a, a.signals[0]), 's123:X', 'key 形状');
});

console.log('dbc-model 测试通过：' + passed + ' 项');
