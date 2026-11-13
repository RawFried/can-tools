/**
 * 发送报文面板：扩展帧选择、ID/数据校验、DLC 推导、发送通道下拉框与发送按钮状态。
 */
import { sendFrame } from './api';
import { els } from './dom';
import { parseHex } from './format';
import { state } from './state';
import { setLastLog, toast } from './toast';
import type { SendBody, StatusDto } from './types';

/** 运行中通道集合的签名，用于避免每次状态推送都重建下拉框。 */
let sendChannelSignature: string | null = null;

function sendExtended(): boolean {
  const selected = document.querySelector<HTMLInputElement>('input[name="send-ext"]:checked');
  return selected !== null && selected.value === 'ext';
}

/** 解析发送数据；支持空格/逗号/冒号分隔或连续十六进制。 */
export function parseSendData(raw: string): number[] | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  const tokens = trimmed.split(/[\s,:]+/).filter((token) => token.length > 0);
  if (tokens.length > 1) {
    const bytes: number[] = [];
    for (const token of tokens) {
      const cleaned = token.replace(/^0x/i, '');
      if (!/^[0-9a-f]{1,2}$/i.test(cleaned)) return null;
      bytes.push(parseInt(cleaned, 16));
    }
    return bytes.length <= 8 ? bytes : null;
  }
  const cleaned = trimmed.replace(/^0x/i, '');
  if (cleaned.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(cleaned)) return null;
  const bytes: number[] = [];
  for (let index = 0; index < cleaned.length; index += 2) {
    bytes.push(parseInt(cleaned.slice(index, index + 2), 16));
  }
  return bytes.length <= 8 ? bytes : null;
}

/** 依据运行中的通道重建发送通道下拉框；保留用户选择。 */
export function syncSendChannels(st: StatusDto): void {
  const running = st.channels.filter((channel) => channel.running);
  const signature = running
    .map((channel) => channel.index + ':' + (channel.mode ?? ''))
    .join(',');
  if (signature === sendChannelSignature) return;
  sendChannelSignature = signature;
  const previous = els.sendChannel.value;

  if (running.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '无通道';
    option.disabled = true;
    option.selected = true;
    els.sendChannel.replaceChildren(option);
    return;
  }

  const options = running.map((channel) => {
    const option = document.createElement('option');
    option.value = String(channel.index);
    option.textContent =
      'CAN' + (channel.index + 1) + (channel.mode === 'listen_only' ? '（只听）' : '');
    option.disabled = channel.mode === 'listen_only';
    return option;
  });
  els.sendChannel.replaceChildren(...options);

  const sendable = running.filter((channel) => channel.mode !== 'listen_only');
  let selected = sendable[0]?.index ?? running[0].index;
  if (previous !== '' && sendable.some((channel) => channel.index === Number(previous))) {
    selected = Number(previous);
  }
  els.sendChannel.value = String(selected);
}

/** 远程帧禁用数据输入；数据帧的 DLC 自动等于字节数。 */
export function updateSendDlc(): void {
  const remote = els.sendRemote.checked;
  els.sendData.disabled = remote;
  els.sendDlc.readOnly = !remote;
  if (remote) {
    if (els.sendDlc.value === '') els.sendDlc.value = '0';
  } else {
    const bytes = parseSendData(els.sendData.value);
    els.sendDlc.value = bytes === null ? '' : String(bytes.length);
  }
}

export function updateSendControls(): void {
  const st = state.status;
  const open = st !== null && st.device.open;
  const channelValue = els.sendChannel.value;
  const channel = channelValue === '' ? null : Number(channelValue);
  const running =
    channel === null
      ? null
      : (st?.channels.find((item) => item.index === channel && item.running) ?? null);
  const extended = sendExtended();
  const id = parseHex(els.sendId.value, extended ? 0x1fffffff : 0x7ff);
  const remote = els.sendRemote.checked;
  const bytes = remote ? [] : parseSendData(els.sendData.value);
  const dlc = remote ? Number(els.sendDlc.value) : (bytes?.length ?? 0);

  let reason = '';
  if (!open) reason = '先打开设备';
  else if (running === null) reason = '先启动一个通道';
  else if (running.mode === 'listen_only') reason = '只听模式不可发送';
  else if (id === null) reason = 'ID 无效或超出范围';
  else if (bytes === null) reason = '数据必须是 1–8 个十六进制字节';
  else if (remote && (!Number.isInteger(dlc) || dlc < 0 || dlc > 8)) reason = 'DLC 必须在 0–8';

  els.btnSend.disabled = reason !== '';
  els.sendHint.textContent =
    reason === ''
      ? remote
        ? '远程帧不携带数据；DLC 可设 0–8；回车发送。'
        : '数据支持 11 22 33 / 112233 / 0x11,0x22；回车发送。'
      : reason;
  els.sendHint.classList.toggle('error', reason !== '' && open && running !== null);
}

/**
 * 发送当前表单报文。
 *
 * applyStatus 由 events 注入：避免 send ↔ status 直接互相 import，同时保持
 * 「先应用状态，再提示」的原有顺序。
 */
export async function sendCurrentFrame(applyStatus: (st: StatusDto) => void): Promise<void> {
  const channelValue = els.sendChannel.value;
  if (channelValue === '') {
    toast('没有可用的发送通道', 'warn');
    return;
  }
  const channel = Number(channelValue);
  const extended = sendExtended();
  const id = parseHex(els.sendId.value, extended ? 0x1fffffff : 0x7ff);
  if (id === null) {
    toast('发送 ID 无效或超出范围', 'warn');
    els.sendId.focus();
    return;
  }
  const remote = els.sendRemote.checked;
  const bytes = remote ? [] : parseSendData(els.sendData.value);
  if (bytes === null) {
    toast('发送数据格式无效', 'warn');
    els.sendData.focus();
    return;
  }
  const dlc = remote ? Number(els.sendDlc.value) : bytes.length;
  if (remote && (!Number.isInteger(dlc) || dlc < 0 || dlc > 8)) {
    toast('远程帧 DLC 必须在 0–8', 'warn');
    els.sendDlc.focus();
    return;
  }
  const body: SendBody = {
    channel,
    id,
    extended,
    remote,
    dlc,
    data: bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(' '),
  };
  const status = await sendFrame(body);
  if (status) applyStatus(status);
  const label = 'CAN' + (channel + 1) + ' 0x' + id.toString(16).toUpperCase();
  const detail = remote ? '远程帧 DLC ' + dlc : bytes.length + ' 字节';
  toast('已发送 ' + label + ' （' + detail + '）', 'success');
  setLastLog('已发送 ' + label + ' （' + detail + '）');
}
