/**
 * DOM 引用集中表：byId/q 查询工具、全部元素引用与 <template> 行原型。
 * 其它模块只从本模块取元素，便于静态核对引用是否齐全。
 */

export function byId<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error('缺少元素 #' + id);
  return found as T;
}

export function q<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector(selector);
  if (!found) throw new Error('未找到元素 ' + selector);
  return found as T;
}

export const els = {
  /* 顶栏 */
  devicePillDot: byId<HTMLElement>('devicePillDot'),
  devicePillText: byId<HTMLElement>('devicePillText'),
  recPill: byId<HTMLElement>('recPill'),
  wsDot: byId<HTMLElement>('wsDot'),
  wsText: byId<HTMLElement>('wsText'),
  versionLabel: byId<HTMLElement>('versionLabel'),

  /* 设备连接 */
  deviceList: byId<HTMLElement>('deviceList'),
  deviceEmpty: byId<HTMLElement>('deviceEmpty'),
  btnRefreshDevices: byId<HTMLButtonElement>('btnRefreshDevices'),
  btnOpenDevice: byId<HTMLButtonElement>('btnOpenDevice'),
  btnCloseDevice: byId<HTMLButtonElement>('btnCloseDevice'),
  deviceInfo: byId<HTMLElement>('deviceInfo'),
  devHw: byId<HTMLElement>('devHw'),
  devFw: byId<HTMLElement>('devFw'),
  devSerial: byId<HTMLElement>('devSerial'),
  devChannels: byId<HTMLElement>('devChannels'),

  /* 通道配置 */
  ch1Check: byId<HTMLInputElement>('ch1Check'),
  ch2Check: byId<HTMLInputElement>('ch2Check'),
  baudSelect: byId<HTMLSelectElement>('baudSelect'),
  btnApplyConfig: byId<HTMLButtonElement>('btnApplyConfig'),
  btnStopChannels: byId<HTMLButtonElement>('btnStopChannels'),
  chipCh1: byId<HTMLElement>('chipCh1'),
  chipCh1State: byId<HTMLElement>('chipCh1State'),
  chipCh1Sub: byId<HTMLElement>('chipCh1Sub'),
  chipCh2: byId<HTMLElement>('chipCh2'),
  chipCh2State: byId<HTMLElement>('chipCh2State'),
  chipCh2Sub: byId<HTMLElement>('chipCh2Sub'),

  /* 滤波器 */
  filterRangeList: byId<HTMLElement>('filterRangeList'),
  filterEmpty: byId<HTMLElement>('filterEmpty'),
  hwFilterState: byId<HTMLElement>('hwFilterState'),
  btnAddFilter: byId<HTMLButtonElement>('btnAddFilter'),
  btnAcceptAll: byId<HTMLButtonElement>('btnAcceptAll'),
  btnApplyFilters: byId<HTMLButtonElement>('btnApplyFilters'),

  /* 录制 */
  btnRecStart: byId<HTMLButtonElement>('btnRecStart'),
  btnRecStop: byId<HTMLButtonElement>('btnRecStop'),
  recActive: byId<HTMLElement>('recActive'),
  recActiveFile: byId<HTMLElement>('recActiveFile'),
  recActiveFrames: byId<HTMLElement>('recActiveFrames'),
  recActiveElapsed: byId<HTMLElement>('recActiveElapsed'),
  dataDirLabel: byId<HTMLElement>('dataDirLabel'),

  /* 统计 */
  statRx: byId<HTMLElement>('statRx'),
  statRate: byId<HTMLElement>('statRate'),
  statFiltered: byId<HTMLElement>('statFiltered'),
  statRecorded: byId<HTMLElement>('statRecorded'),

  /* 发送报文 */
  sendChannel: byId<HTMLSelectElement>('sendChannel'),
  sendId: byId<HTMLInputElement>('sendId'),
  sendData: byId<HTMLInputElement>('sendData'),
  sendDlc: byId<HTMLInputElement>('sendDlc'),
  sendRemote: byId<HTMLInputElement>('sendRemote'),
  btnSend: byId<HTMLButtonElement>('btnSend'),
  sendCount: byId<HTMLElement>('sendCount'),
  sendHint: byId<HTMLElement>('sendHint'),

  /* 实时报文 */
  frameFilter: byId<HTMLInputElement>('frameFilter'),
  autoscrollCheck: byId<HTMLInputElement>('autoscrollCheck'),
  btnPauseView: byId<HTMLButtonElement>('btnPauseView'),
  btnPauseLabel: byId<HTMLElement>('btnPauseLabel'),
  icPause: byId<HTMLElement>('icPause'),
  icPlay: byId<HTMLElement>('icPlay'),
  btnClearView: byId<HTMLButtonElement>('btnClearView'),
  tableWrap: byId<HTMLElement>('tableWrap'),
  framesBody: byId<HTMLTableSectionElement>('framesBody'),
  frameEmpty: byId<HTMLElement>('frameEmpty'),
  emptyTitle: byId<HTMLElement>('emptyTitle'),
  emptyHint: byId<HTMLElement>('emptyHint'),
  pausedBadge: byId<HTMLElement>('pausedBadge'),
  pausedCount: byId<HTMLElement>('pausedCount'),
  lastLogMsg: byId<HTMLElement>('lastLogMsg'),
  visibleCount: byId<HTMLElement>('visibleCount'),
  bufferUsage: byId<HTMLElement>('bufferUsage'),

  /* 录制文件 */
  recordingsList: byId<HTMLTableSectionElement>('recordingsList'),
  recordingsEmpty: byId<HTMLElement>('recordingsEmpty'),
  recordingsCount: byId<HTMLElement>('recordingsCount'),
  btnRefreshRecordings: byId<HTMLButtonElement>('btnRefreshRecordings'),

  /* DBC 信号曲线 */
  dbcPanel: byId<HTMLElement>('dbcPanel'),
  dbcName: byId<HTMLElement>('dbcName'),
  dbcSummary: byId<HTMLElement>('dbcSummary'),
  btnDbcLoad: byId<HTMLButtonElement>('btnDbcLoad'),
  dbcFileInput: byId<HTMLInputElement>('dbcFileInput'),
  btnDbcRemove: byId<HTMLButtonElement>('btnDbcRemove'),
  dbcEmpty: byId<HTMLElement>('dbcEmpty'),
  dbcBody: byId<HTMLElement>('dbcBody'),
  dbcMsgList: byId<HTMLElement>('dbcMsgList'),
  dbcSignalBar: byId<HTMLElement>('dbcSignalBar'),
  signalChart: byId<HTMLCanvasElement>('signalChart'),
  signalLegend: byId<HTMLElement>('signalLegend'),
  dbcWindowSelect: byId<HTMLSelectElement>('dbcWindowSelect'),
  btnChartClear: byId<HTMLButtonElement>('btnChartClear'),
  signalEmpty: byId<HTMLElement>('signalEmpty'),
  dbcHint: byId<HTMLElement>('dbcHint'),

  /* 其它 */
  toasts: byId<HTMLElement>('toasts'),
  rowTpl: byId<HTMLTemplateElement>('rowTpl'),
  recRowTpl: byId<HTMLTemplateElement>('recRowTpl'),
  filterRowTpl: byId<HTMLTemplateElement>('filterRowTpl'),
};

export const rowTplRow = els.rowTpl.content.firstElementChild as HTMLTableRowElement | null;
export const recTplRow = els.recRowTpl.content.firstElementChild as HTMLTableRowElement | null;
export const filterTplRow = els.filterRowTpl.content.firstElementChild as HTMLElement | null;
