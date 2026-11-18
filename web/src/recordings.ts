/**
 * 录制文件列表：加载/排序、列表项渲染、下载链接与删除（二次确认 + busy 态）。
 */
import { deleteRecordingFile, fetchRecordings } from './api';
import { els, q, recTplRow } from './dom';
import { errText, fmtBytes, fmtDateShort, fmtInt } from './format';
import { state } from './state';
import { runBusy } from './status';
import { toast } from './toast';
import type { RecordingFileDto } from './types';

/** 侧栏窄列表行：第一行文件名（省略 + title 全名），第二行「大小 │ 修改时间」，右侧下载/删除。 */
function buildRecRow(rec: RecordingFileDto): HTMLLIElement {
  const src = recTplRow;
  const row = (src ? src.cloneNode(true) : document.createElement('li')) as HTMLLIElement;

  const name = q<HTMLElement>(row, '.r-name');
  name.textContent = rec.name;
  name.title = rec.name;
  q<HTMLElement>(row, '.r-size').textContent = fmtBytes(rec.size);
  q<HTMLElement>(row, '.r-time').textContent = fmtDateShort(rec.modified_ms);

  const link = q<HTMLAnchorElement>(row, 'a.ef-btn');
  link.href = '/api/recordings/' + encodeURIComponent(rec.name);
  link.setAttribute('download', rec.name);
  link.setAttribute('aria-label', '下载 ' + rec.name);

  const del = q<HTMLButtonElement>(row, 'button.danger');
  del.setAttribute('aria-label', '删除 ' + rec.name);
  del.addEventListener('click', () => {
    void deleteRecording(rec.name, del);
  });
  return row;
}

export function renderRecordings(): void {
  const frag = document.createDocumentFragment();
  for (const rec of state.recordings) {
    if (rec.name) frag.appendChild(buildRecRow(rec));
  }
  els.recordingsList.replaceChildren(frag);
  els.recordingsEmpty.hidden = state.recordings.length > 0;
  els.recordingsCount.textContent = '共 ' + fmtInt(state.recordings.length) + ' 个';
  /* 仅当内容超出 5 行时把滚动区纳入键盘 Tab 顺序, 避免空列表也能被 Tab 命中。 */
  els.recordingsWrap.tabIndex = state.recordings.length > 5 ? 0 : -1;
}

export async function loadRecordings(): Promise<void> {
  try {
    const list = await fetchRecordings();
    list.sort((a, b) => b.modified_ms - a.modified_ms);
    state.recordings = list;
    renderRecordings();
  } catch (err) {
    toast(errText(err), 'error');
  }
}

async function deleteRecording(name: string, btn: HTMLButtonElement): Promise<void> {
  if (!window.confirm('删除录制文件「' + name + '」？此操作不可恢复。')) return;
  await runBusy(btn, async () => {
    await deleteRecordingFile(name);
    toast('已删除 ' + name, 'success');
    await loadRecordings();
  });
}
