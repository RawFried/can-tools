/**
 * 应用状态：单例 state（连接、缓冲、暂停、过滤器、表单同步标记）与 busy 按钮集合。
 */
import type { DeviceInfoDto, FrameDto, RecordingFileDto, StatusDto } from './types';

/** 本地报文缓冲上限，与后端每通道缓冲策略无关（仅约束前端表格） */
export const BUFFER_CAP = 5000;

export interface AppState {
  status: StatusDto | null;
  devices: DeviceInfoDto[];
  selectedDevice: number | null;
  recordings: RecordingFileDto[];
  ws: WebSocket | null;
  wsAttempt: number;
  wsTimer: number | null;
  buffer: FrameDto[];
  pending: FrameDto[];
  paused: boolean;
  pausedHidden: number;
  autoscroll: boolean;
  filter: string;
  formSynced: boolean;
}

export const state: AppState = {
  status: null,
  devices: [],
  selectedDevice: null,
  recordings: [],
  ws: null,
  wsAttempt: 0,
  wsTimer: null,
  buffer: [],
  pending: [],
  paused: false,
  pausedHidden: 0,
  autoscroll: true,
  filter: '',
  formSynced: false,
};

/** 异步操作进行中的按钮；状态推送重算可用性时保持禁用 */
export const busy = new Set<HTMLButtonElement>();
