/**
 * REST 客户端 api() 与各端点薄封装：只负责请求与 JSON 收窄，不碰 DOM/提示。
 */
import type {
  ConfigBody,
  DevicesResponseDto,
  FilterUpdateBody,
  RecordingFileDto,
  SendBody,
  StatusDto,
} from './types';
import {
  isNum,
  isObj,
  isStr,
  parseDevicesDto,
  parseRecordingsDto,
  parseStatusDto,
} from './types';

/** 发送 REST 请求；失败（网络错误、非 2xx、ok:false）时抛出带服务端 error 文案的错误。 */
export async function api(
  path: string,
  method: 'GET' | 'POST' | 'DELETE' = 'GET',
  body?: unknown
): Promise<unknown> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error('无法连接服务器，请确认后端已启动');
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = undefined;
  }
  if (!res.ok || (isObj(data) && data['ok'] === false)) {
    const msg = isObj(data) && isStr(data['error']) ? data['error'] : '请求失败（HTTP ' + res.status + '）';
    throw new Error(msg);
  }
  return data;
}

/** 从 /api/* 响应里取出 status 字段并收窄。 */
function statusOf(res: unknown): StatusDto | null {
  return parseStatusDto(isObj(res) ? res['status'] : null);
}

export async function fetchStatus(): Promise<StatusDto | null> {
  return parseStatusDto(await api('/api/status'));
}

/** 设备与链路发现：USB 设备列表 + SocketCAN 链路列表。 */
export async function fetchDevices(): Promise<DevicesResponseDto> {
  return parseDevicesDto(await api('/api/devices'));
}

export async function fetchRecordings(): Promise<RecordingFileDto[]> {
  return parseRecordingsDto(await api('/api/recordings'));
}

/** /api/health 的版本号；缺失时返回 null（调用方决定是否回退）。 */
export async function fetchHealthVersion(): Promise<string | null> {
  const res = await api('/api/health');
  return isObj(res) && isStr(res['version']) ? res['version'] : null;
}

export async function openDevice(index: number): Promise<StatusDto | null> {
  return statusOf(await api('/api/device/open', 'POST', { index }));
}

export async function closeDevice(): Promise<StatusDto | null> {
  return statusOf(await api('/api/device/close', 'POST'));
}

export async function applyConfig(body: ConfigBody): Promise<StatusDto | null> {
  return statusOf(await api('/api/config', 'POST', body));
}

/** 停止指定通道/链路（id 列表）。 */
export async function stopChannels(channels: number[]): Promise<StatusDto | null> {
  return statusOf(await api('/api/stop', 'POST', { channels }));
}

/** 按通道实时更新硬件/软件滤波（通道保持运行）。 */
export async function updateFilters(body: FilterUpdateBody): Promise<StatusDto | null> {
  return statusOf(await api('/api/filters', 'POST', body));
}

export async function sendFrame(body: SendBody): Promise<StatusDto | null> {
  return statusOf(await api('/api/send', 'POST', body));
}

export async function clearFrames(): Promise<void> {
  await api('/api/frames/clear', 'POST');
}

export interface RecordingStartResult {
  status: StatusDto | null;
  file: string;
}

export interface RecordingStopResult extends RecordingStartResult {
  frames: number | null;
}

export async function startRecording(): Promise<RecordingStartResult> {
  const res = await api('/api/recording/start', 'POST');
  return { status: statusOf(res), file: isObj(res) && isStr(res['file']) ? res['file'] : '' };
}

export async function stopRecording(): Promise<RecordingStopResult> {
  const res = await api('/api/recording/stop', 'POST');
  return {
    status: statusOf(res),
    file: isObj(res) && isStr(res['file']) ? res['file'] : '',
    frames: isObj(res) && isNum(res['frames']) ? res['frames'] : null,
  };
}

export async function deleteRecordingFile(name: string): Promise<void> {
  await api('/api/recordings/' + encodeURIComponent(name), 'DELETE');
}
