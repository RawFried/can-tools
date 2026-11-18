/**
 * REST 客户端 api() 与各端点薄封装：只负责请求与 JSON 收窄，不碰 DOM/提示。
 */
import type {
  ConfigBody,
  DbcDefinitionDto,
  DbcResponseDto,
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
  parseDbcResponse,
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

/** 设置录制 CSV 保存目录；path 为空串时恢复后端默认目录。 */
export async function setRecordingDir(path: string): Promise<StatusDto | null> {
  return statusOf(await api('/api/recording/dir', 'POST', { path }));
}

/* ---------- 按通道 DBC ---------- */

function dbcOf(res: unknown): DbcResponseDto {
  const parsed = parseDbcResponse(res);
  if (!parsed) throw new Error('服务器返回的 DBC 响应格式异常');
  return parsed;
}

/** 读取某通道当前加载的 DBC 定义（未加载时 dbc 为 null）。 */
export async function fetchDbc(channel: number): Promise<DbcResponseDto> {
  return dbcOf(await api('/api/dbc/' + channel));
}

/** 上传某通道的 DBC 文件内容；返回服务器解析后的定义。 */
export async function uploadDbc(
  channel: number,
  name: string,
  content: string
): Promise<DbcDefinitionDto> {
  const res = dbcOf(await api('/api/dbc/' + channel, 'POST', { name, content }));
  if (res.dbc === null) throw new Error('服务器未返回 DBC 定义，请检查文件内容');
  return res.dbc;
}

/** 移除某通道的 DBC 定义（不影响窗口本身）。 */
export async function deleteDbc(channel: number): Promise<void> {
  await api('/api/dbc/' + channel, 'DELETE');
}
