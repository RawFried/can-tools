/**
 * 运行日志面板：加载 /api/logs、按返回顺序渲染文件表（下载链接）与目录提示。
 * 与 recordings 同构但相互独立；本模块不依赖 status（busy 态由 events 绑定时包一层）。
 */
import { fetchLogs } from './api';
import { els, logTplRow, q } from './dom';
import { errText, fmtBytes, fmtDateTime, fmtInt } from './format';
import { toast } from './toast';
import type { LogFileDto, LogsResponseDto } from './types';

function buildLogRow(file: LogFileDto): HTMLTableRowElement {
  const src = logTplRow;
  const row = (src ? src.cloneNode(true) : document.createElement('tr')) as HTMLTableRowElement;

  q<HTMLElement>(row, '.r-name').textContent = file.name;
  q<HTMLElement>(row, '.r-size').textContent = fmtBytes(file.size);
  q<HTMLElement>(row, '.r-time').textContent = fmtDateTime(file.modified_ms);

  const link = q<HTMLAnchorElement>(row, 'a.btn');
  link.href = '/api/logs/' + encodeURIComponent(file.name);
  link.setAttribute('download', file.name);
  /* 窄屏下按钮文字隐藏、退化为纯图标，用 aria-label 保住可读名称 */
  link.setAttribute('aria-label', '下载 ' + file.name);
  return row;
}

/** 渲染日志列表：保持后端返回顺序（最新在前），不重排；同步徽标、空状态与目录提示。 */
export function renderLogs(res: LogsResponseDto): void {
  const frag = document.createDocumentFragment();
  for (const file of res.files) {
    if (file.name) frag.appendChild(buildLogRow(file));
  }
  els.logsList.replaceChildren(frag);
  els.logsEmpty.hidden = res.files.length > 0;
  els.logsCount.textContent = fmtInt(res.files.length);
  els.logsDir.textContent = res.dir.length > 0 ? res.dir : '—';
}

/** 手动/按钮触发的加载；失败弹出错误提示，不向上抛。 */
export async function loadLogs(): Promise<void> {
  try {
    renderLogs(await fetchLogs());
  } catch (err) {
    toast(errText(err), 'error');
  }
}

/** 页面初始化时的首次加载；静默失败（保持空状态），不影响页面其它功能。 */
export async function initLogs(): Promise<void> {
  try {
    renderLogs(await fetchLogs());
  } catch {
    /* 后端未就绪或网络异常时先展示空状态，用户可通过「刷新」重试 */
  }
}
