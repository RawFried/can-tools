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

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? h + ':' + p2(m) + ':' + p2(sec) : p2(m) + ':' + p2(sec);
}

export function hexOf(v: number, width: number): string {
  return '0x' + v.toString(16).toUpperCase().padStart(width, '0');
}

export function parseHex(raw: string, max: number): number | null {
  const s = raw.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]+$/.test(s)) return null;
  const v = parseInt(s, 16);
  if (!Number.isSafeInteger(v) || v < 0 || v > max) return null;
  return v;
}
