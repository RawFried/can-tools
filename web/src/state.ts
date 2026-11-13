/**
 * 应用状态：单例 state（连接、缓冲、暂停、过滤器、表单同步标记）与 busy 按钮集合。
 */
import type {
  DeviceInfoDto,
  FrameDto,
  RecordingFileDto,
  SocketCanLinkDto,
  SoftwareFilterDto,
  StatusDto,
} from './types';

/** 本地报文缓冲上限，与后端每通道缓冲策略无关（仅约束前端表格） */
export const BUFFER_CAP = 5000;

export interface AppState {
  status: StatusDto | null;
  devices: DeviceInfoDto[];
  /** 最近一次 /api/devices 发现的 SocketCAN 链路（可能已运行或未启用）。 */
  socketcan: SocketCanLinkDto[];
  /** 当前选中的通道 key：`usb:0`/`usb:1`/`scan:<name>`。 */
  channelKey: string | null;
  /** 各通道选择的速率标签（`5k`…`1000k`）。 */
  rates: Map<string, string>;
  /** 按通道保存的 ID 区间；key 同上。 */
  filters: Map<string, SoftwareFilterDto[]>;
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
}

export const state: AppState = {
  status: null,
  devices: [],
  socketcan: [],
  channelKey: null,
  rates: new Map<string, string>(),
  filters: new Map<string, SoftwareFilterDto[]>(),
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
};

/** 异步操作进行中的按钮；状态推送重算可用性时保持禁用 */
export const busy = new Set<HTMLButtonElement>();
