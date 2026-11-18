/**
 * 信号曲线按通道管理：通道选择弹窗、每个通道一个可拖拽浮窗、DBC 缓存与增删、
 * 以及把实时帧/快照分发给对应窗口。窗口内部细节见 signal-window.ts。
 */
import { deleteDbc, fetchDbc, uploadDbc } from './api';
import { els } from './dom';
import { errText } from './format';
import { SignalWindow } from './signal-window';
import { state } from './state';
import { toast } from './toast';
import type { DbcChannelDto, DbcDefinitionDto, FrameDto } from './types';

const MAX_DBC_BYTES = 1024 * 1024;

/** 每个通道最近一次已知定义；null = 明确未加载，缺省 = 尚未读取。 */
const defs = new Map<number, DbcDefinitionDto | null>();
const windows = new Map<number, SignalWindow>();

let pickerOpen = false;
let lastFocus: HTMLElement | null = null;
let pickerSignature = '';
let zTop = 0;

function mk<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = cls;
  return el;
}

function text<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  value: string
): HTMLElementTagNameMap[K] {
  const el = mk(tag, cls);
  el.textContent = value;
  return el;
}

function channelLabel(channel: number): string {
  const st = state.status?.channels.find((c) => c.index === channel) ?? null;
  const name = st?.name.trim() ?? '';
  return name.length > 0 ? name : 'CH' + (channel + 1);
}

function dbcNameOf(channel: number): string {
  return defs.get(channel)?.name ?? '无 DBC';
}

/* ---------- 通道选择弹窗 ---------- */

function pickerStateSignature(): string {
  const channels = state.status?.channels ?? [];
  return channels
    .map((c) =>
      [
        c.index,
        c.name,
        c.source,
        c.running ? '1' : '0',
        dbcNameOf(c.index),
        windows.has(c.index) ? '1' : '0',
      ].join('|')
    )
    .join(';');
}

function renderPicker(force = false): void {
  const signature = pickerStateSignature();
  if (!force && signature === pickerSignature) return;
  pickerSignature = signature;

  const channels = state.status?.channels ?? [];
  if (channels.length === 0) {
    els.signalPickerList.replaceChildren();
    els.signalPickerEmpty.hidden = false;
    els.signalPickerEmpty.textContent =
      state.status === null
        ? '尚未读取到通道状态：请确认后端已启动，再点击「信号曲线」重试。'
        : '当前没有可用通道：请先在左侧刷新设备并启动链路。';
    return;
  }

  els.signalPickerEmpty.hidden = true;
  const frag = document.createDocumentFragment();
  for (const c of channels) {
    const open = windows.has(c.index);
    const btn = mk('button', 'signal-picker-row');
    btn.type = 'button';
    btn.dataset['channel'] = String(c.index);
    if (open) btn.classList.add('is-open');
    const source = c.source === 'socketcan' ? 'SocketCAN' : 'USB';
    const meta = [source, c.running ? '运行中' : '已停止'];
    if (open) meta.push('窗口已打开');
    btn.append(
      text('span', 'spr-name', c.name),
      text('span', 'spr-meta', meta.join(' │ ')),
      text('span', 'spr-dbc', dbcNameOf(c.index))
    );
    btn.title =
      '通道 ' + c.name + '（' + source + '，路由 id ' + c.index + '）' +
      (open ? '：窗口已打开，点击聚焦' : '：点击打开信号曲线浮窗');
    frag.appendChild(btn);
  }
  els.signalPickerList.replaceChildren(frag);
}

function closePickerInternal(restoreFocus: boolean): void {
  if (!pickerOpen) return;
  pickerOpen = false;
  els.signalModal.hidden = true;
  document.body.classList.remove('signal-picker-open');
  if (restoreFocus && lastFocus !== null && lastFocus.isConnected) {
    lastFocus.focus({ preventScroll: true });
  }
  if (restoreFocus) lastFocus = null;
}

export function openSignalPicker(): void {
  if (!pickerOpen) {
    lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pickerOpen = true;
    document.body.classList.add('signal-picker-open');
  }
  els.signalModal.hidden = false;
  renderPicker(true);
  const first = els.signalPickerList.querySelector<HTMLButtonElement>('button.signal-picker-row');
  (first ?? els.btnSignalModalClose).focus({ preventScroll: true });
}

export function closeSignalPicker(): void {
  closePickerInternal(true);
}

/* ---------- 窗口生命周期 ---------- */

function raiseWindow(channel: number): void {
  const win = windows.get(channel);
  if (!win) return;
  zTop += 1;
  win.root.style.zIndex = String(zTop);
}

function closeSignalWindow(channel: number): void {
  const win = windows.get(channel);
  if (!win) return;
  windows.delete(channel);
  win.destroy();
  if (pickerOpen) renderPicker(true);
}

export function openSignalWindow(channel: number): void {
  const existing = windows.get(channel);
  if (existing) {
    closePickerInternal(false);
    existing.focus();
    return;
  }

  const win = new SignalWindow(channel, els.signalWindows, {
    loadDbc: (file) => void loadSignalDbc(channel, file),
    removeDbc: () => void removeSignalDbc(channel),
    focus: () => raiseWindow(channel),
    close: () => closeSignalWindow(channel),
    channelStatus: () => state.status?.channels.find((c) => c.index === channel) ?? null,
  });
  windows.set(channel, win);
  raiseWindow(channel);
  win.placeDefault(windows.size - 1);

  if (defs.has(channel)) {
    const cached = defs.get(channel) ?? null;
    win.setDefinition(cached);
    win.setHint(
      cached !== null
        ? '已恢复 ' + cached.name + '：选择报文与信号后开始绘制。'
        : '通道 ' + channelLabel(channel) +
          ' 尚未加载 DBC：点击「加载 DBC」选择 .dbc 文件后，可在此选择报文与信号并绘制曲线。',
      false
    );
  } else {
    win.setDefinition(null);
    void readSignalDbc(channel);
  }

  closePickerInternal(false);
  win.focus();
}

function readSignalDbc(channel: number): void {
  const win = windows.get(channel);
  if (!win) return;
  win.setLoading(true);
  win.setHint('正在读取通道 ' + channelLabel(channel) + ' 的 DBC…', false);
  void (async (): Promise<void> => {
    try {
      const res = await fetchDbc(channel);
      defs.set(channel, res.dbc);
      const current = windows.get(channel);
      if (current) {
        current.setDefinition(res.dbc);
        current.setHint(
          res.dbc !== null
            ? '已恢复 ' + res.dbc.name + '：选择报文与信号后开始绘制。'
            : '通道 ' + channelLabel(channel) +
              ' 尚未加载 DBC：点击「加载 DBC」选择 .dbc 文件后，可在此选择报文与信号并绘制曲线。',
          false
        );
      }
      if (pickerOpen) renderPicker();
    } catch (err) {
      win.setHint('读取 DBC 失败：' + errText(err), true);
    } finally {
      const current = windows.get(channel);
      if (current === win) win.setLoading(false);
    }
  })();
}

/* ---------- DBC 上传/移除 ---------- */

async function loadSignalDbc(channel: number, file: File): Promise<void> {
  const win = windows.get(channel);
  const bad = !file.name.toLowerCase().endsWith('.dbc')
    ? '仅支持 .dbc 文件：' + file.name
    : file.size > MAX_DBC_BYTES
      ? 'DBC 文件不能超过 1 MiB（当前 ' + file.size + ' 字节）'
      : '';
  if (bad.length > 0) {
    win?.setHint(bad, true);
    return;
  }

  win?.setLoading(true);
  win?.setHint('正在加载 ' + file.name + '…', false);
  try {
    const content = await file.text();
    const def = await uploadDbc(channel, file.name, content);
    defs.set(channel, def);
    const current = windows.get(channel);
    if (current) {
      current.setDefinition(def);
      current.setHint('已加载 ' + def.name + '（' + def.messages.length + ' 条报文）', false);
    }
    toast('DBC 已加载：' + def.name + '（' + channelLabel(channel) + '）', 'success');
    if (pickerOpen) renderPicker();
  } catch (err) {
    const msg = errText(err);
    win?.setHint(msg, true);
    toast(msg, 'error');
  } finally {
    const current = windows.get(channel);
    if (current === win) win?.setLoading(false);
  }
}

async function removeSignalDbc(channel: number): Promise<void> {
  const win = windows.get(channel);
  win?.setLoading(true);
  try {
    await deleteDbc(channel);
    defs.set(channel, null);
    const current = windows.get(channel);
    if (current) {
      current.setDefinition(null);
      current.setHint('已移除通道 ' + channelLabel(channel) + ' 的 DBC 定义', false);
    }
    toast('已移除 DBC：' + channelLabel(channel), 'success');
    if (pickerOpen) renderPicker();
  } catch (err) {
    const msg = errText(err);
    win?.setHint(msg, true);
    toast(msg, 'error');
  } finally {
    const current = windows.get(channel);
    if (current !== undefined) current.setLoading(false);
  }
}

/* ---------- 数据分发 ---------- */

/** 快照到达：用服务端 dbcs 重建缓存，并让每个已开窗口重置样本。 */
export function applySignalSnapshot(dbcs: readonly DbcChannelDto[], frames: FrameDto[]): void {
  defs.clear();
  for (const item of dbcs) defs.set(item.channel, item.dbc);
  for (const [channel, win] of windows) {
    win.setDefinition(defs.get(channel) ?? null);
    win.seed(frames);
  }
  if (pickerOpen) renderPicker();
}

/** 单通道 DBC 变更事件（上传/移除后的服务端回执）。 */
export function applySignalEvent(channel: number, dbc: DbcDefinitionDto | null): void {
  defs.set(channel, dbc);
  windows.get(channel)?.setDefinition(dbc);
  if (pickerOpen) renderPicker();
}

/** 实时帧分发给所有窗口；每个窗口自行按 channel 过滤。 */
export function feedSignalFrames(frames: FrameDto[]): void {
  if (frames.length === 0) return;
  for (const win of windows.values()) win.feed(frames);
}

/** 清空所有窗口的曲线样本，保留信号选择。 */
export function clearSignalSamples(): void {
  for (const win of windows.values()) win.clearSamples();
}

/** 状态推送后刷新窗口头部（通道名/运行状态）与弹窗中的通道行。 */
export function refreshSignalWindows(): void {
  for (const win of windows.values()) win.refreshMeta();
  if (pickerOpen) renderPicker();
}

/* ---------- 初始化 ---------- */

/** 绑定顶栏按钮、弹窗关闭路径与窗口重排；必须在 connectWs() 之前调用。 */
export function initSignals(): void {
  els.btnOpenSignals.addEventListener('click', openSignalPicker);
  els.btnSignalModalClose.addEventListener('click', () => closeSignalPicker());
  els.signalPickerList.addEventListener('click', (e) => {
    const target = e.target;
    const btn = target instanceof Element ? target.closest('button.signal-picker-row') : null;
    if (!(btn instanceof HTMLButtonElement)) return;
    const channel = Number(btn.dataset['channel']);
    if (Number.isFinite(channel)) openSignalWindow(channel);
  });
  els.signalModal.addEventListener('click', (e) => {
    const target = e.target;
    if (
      target === els.signalModal ||
      (target instanceof Element && target.closest('[data-signal-close]') !== null)
    ) {
      closeSignalPicker();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !pickerOpen) return;
    e.preventDefault();
    closeSignalPicker();
  });
  window.addEventListener('resize', () => {
    for (const win of windows.values()) win.clampToViewport();
  });
}
