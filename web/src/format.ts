/**
 * 纯格式化工具：数字/字节/时间/十六进制与错误文案。无 DOM、无状态依赖。
 */
import type { CanMode } from './types';

export const MODE_LABELS: Readonly<Record<CanMode, string>> = {
  normal: '正常',
  listen_only: '只听',
  self_test: '自测',
};

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function p2(n: number): string {
  return String(n).padStart(2, '0');
}

export function fmtInt(n: number): string {
  return Number.isFinite(n) ? Math.trunc(n).toLocaleString('zh-CN') : '—';
}

export function fmtRate(n: number): string {
  return Number.isFinite(n)
    ? n.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 1 })
    : '—';
}

export function fmtBytes(b: number): string {
  if (!Number.isFinite(b) || b < 0) return '—';
  if (b < 1024) return fmtInt(b) + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / (1024 * 1024)).toFixed(2) + ' MB';
}

export function fmtClock(ms: number): string {
  const d = new Date(ms);
  return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

export function fmtClockShort(ms: number): string {
  const d = new Date(ms);
  return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
}

export function fmtDateTime(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—';
}

/**
 * 列表行时间戳：`11.18 14:30`；跨年文件补全年份 `2025.12.30 08:10`。
 * 左栏列表行宽有限，秒与当年年份省略（完整文件名在 title 中）。
 */
export function fmtDateShort(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const md =
    p2(d.getMonth() + 1) +
    '.' + p2(d.getDate()) +
    ' ' + p2(d.getHours()) +
    ':' + p2(d.getMinutes());
  return d.getFullYear() === new Date().getFullYear() ? md : d.getFullYear() + '.' + md;
}

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? h + ':' + p2(m) + ':' + p2(sec) : p2(m) + ':' + p2(sec);
}

/** 物理值显示：最多三位小数，特大/特小用科学计数法，非有限值显示 —。 */
export function fmtSignal(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs !== 0 && (abs >= 1e6 || abs < 1e-3)) return v.toExponential(2);
  return v.toLocaleString('zh-CN', { maximumFractionDigits: 3 });
}

export function hexOf(v: number, width: number): string {
  return '0x' + v.toString(16).toUpperCase().padStart(width, '0');
}

/** SocketCAN 速率完整文案：500000 → "500 kbps"；未知 → "速率未知"。 */
export function fmtBitrateLong(bitrate: number | null): string {
  if (bitrate === null || !Number.isFinite(bitrate) || bitrate <= 0) return '速率未知';
  return Math.round(bitrate / 1000) + ' kbps';
}

/** SocketCAN 接口状态文案（由 flags & IFF_UP 判定，不依赖 operstate）。 */
export function linkStateLabel(state: string | null): string {
  if (state === 'up') return '已启用';
  if (state === 'down') return '未启用';
  if (state === 'unknown' || state === null || state.length === 0) return '状态未知';
  return state;
}

/**
 * SocketCAN 链路行状态文案，状态优先：
 * 运行中 → `运行中 │ 500 kbps`（速率未知则仅「运行中」）；未运行 → 接口启用/未启用/未知。
 */
export function fmtScanMeta(
  bitrate: number | null,
  running: boolean,
  state: string | null
): string {
  if (running) {
    return bitrate !== null && Number.isFinite(bitrate) && bitrate > 0
      ? '运行中 │ ' + fmtBitrateLong(bitrate)
      : '运行中';
  }
  if (state === 'up') return '已启用 │ 未启动';
  if (state === 'down') return '未启用';
  return '状态未知';
}

export function parseHex(raw: string, max: number): number | null {
  const s = raw.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]+$/.test(s)) return null;
  const v = parseInt(s, 16);
  if (!Number.isSafeInteger(v) || v < 0 || v > max) return null;
  return v;
}
