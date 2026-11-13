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
  /** 已勾选的 SocketCAN 接口名；刷新设备时刻意保留，避免暂时消失的链路丢失选择。 */
  scanSelected: Set<string>;
  /** 用户为各 SocketCAN 链路选择的速率（bps）；未设置时回退链路 bitrate/500000。 */
  scanRates: Map<string, number>;
  /** 按通道保存的 ID 区间；key 为 `usb:0`/`usb:1`/`scan:<name>`。 */
  filters: Map<string, SoftwareFilterDto[]>;
  /** 滤波卡当前选中的通道 key；null 表示尚未初始化。 */
  filterChannel: string | null;
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
  socketcan: [],
  scanSelected: new Set<string>(),
  scanRates: new Map<string, number>(),
  filters: new Map<string, SoftwareFilterDto[]>(),
  filterChannel: null,
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
