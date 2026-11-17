/**
 * 通道统计面板：把状态快照里的运行中通道渲染成表格行（速率/帧率/总线负载/累计接收）。
 * 只读 DTO，每秒随 applyStatus 重绘；DOM 全部用 createElement/textContent 构建。
 */
import { els } from './dom';
import { displayChannelName, fmtBitrateLong, fmtInt, fmtRate } from './format';
import type { ChannelStatusDto } from './types';

/** USB 波特率文案：`500k` → `500 kbps`；空值退化为破折号。 */
function fmtBaud(baud: string | null): string {
  if (baud === null) return '—';
  const s = baud.trim();
  if (s.endsWith('k')) return s.slice(0, -1) + ' kbps';
  return s.length > 0 ? s : '—';
}

/** 负载百分比限制在 0–100，仅用于进度条宽度（数值文本仍显示真实值）。 */
function clampPercent(v: number): number {
  return Math.min(100, Math.max(0, v));
}

function cell(text: string, className?: string): HTMLTableCellElement {
  const td = document.createElement('td');
  if (className !== undefined) td.className = className;
  td.textContent = text;
  return td;
}

/** 数值 + 弱化单位（帧/秒、帧）。 */
function unitCell(value: string, unit: string): HTMLTableCellElement {
  const td = document.createElement('td');
  td.className = 'num';
  const val = document.createElement('span');
  val.textContent = value;
  const u = document.createElement('span');
  u.className = 'unit-sm';
  u.textContent = unit;
  td.append(val, u);
  return td;
}

/** 通道列：名称（统一大写）+ 来源徽标。 */
function channelCell(c: ChannelStatusDto): HTMLTableCellElement {
  const td = document.createElement('td');
  td.className = 'cs-ch';
  const name = document.createElement('span');
  name.className = 'cs-name';
  name.textContent = displayChannelName(c.name);
  const tag = document.createElement('span');
  tag.className = 'src-tag';
  tag.textContent = c.source === 'usb' ? 'USB' : 'SOCKET';
  td.append(name, tag);
  return td;
}

/**
 * 负载列：数值 + 细进度条。速率未知（bus_load 为 null）时仍占位显示 `—`，
 * 避免用户误以为该通道没有负载数据。
 */
function loadCell(c: ChannelStatusDto): HTMLTableCellElement {
  const td = document.createElement('td');
  td.className = 'cs-load';
  const wrap = document.createElement('div');
  wrap.className = 'load-cell';
  const val = document.createElement('span');
  val.className = 'load-val';
  const load = c.metrics.bus_load;
  wrap.appendChild(val);
  if (load === null) {
    val.textContent = '—';
    wrap.title = '通道速率未知，无法估算负载';
  } else {
    val.textContent = fmtRate(load) + '%';
    const track = document.createElement('div');
    track.className = 'load-track';
    track.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('div');
    fill.className = load > 100 ? 'load-fill over' : 'load-fill';
    fill.style.width = clampPercent(load) + '%';
    track.appendChild(fill);
    wrap.appendChild(track);
  }
  td.appendChild(wrap);
  return td;
}

function buildRow(c: ChannelStatusDto): HTMLTableRowElement {
  const tr = document.createElement('tr');
  const rate = c.source === 'usb' ? fmtBaud(c.baud) : fmtBitrateLong(c.bitrate);
  tr.append(
    channelCell(c),
    cell(rate),
    unitCell(fmtRate(c.metrics.rx_rate), '帧/秒'),
    loadCell(c),
    unitCell(fmtInt(c.metrics.rx_frames), '帧')
  );
  return tr;
}

/** 渲染运行中通道（按 index 升序）；无运行通道时显示空状态。 */
export function renderChannelStats(channels: readonly ChannelStatusDto[]): void {
  const running = channels.filter((c) => c.running).sort((a, b) => a.index - b.index);
  const frag = document.createDocumentFragment();
  for (const c of running) frag.appendChild(buildRow(c));
  els.channelStatsBody.replaceChildren(frag);
  els.channelStatsEmpty.hidden = running.length > 0;
}
