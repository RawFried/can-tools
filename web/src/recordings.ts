/**
 * 录制文件列表：加载/排序、行渲染、下载链接与删除（二次确认 + busy 态）。
 */
import { deleteRecordingFile, fetchRecordings } from './api';
import { els, q, recTplRow } from './dom';
import { errText, fmtBytes, fmtDateTime, fmtInt } from './format';
import { state } from './state';
import { runBusy } from './status';
import { toast } from './toast';
import type { RecordingFileDto } from './types';

function buildRecRow(rec: RecordingFileDto): HTMLTableRowElement {
  const src = recTplRow;
  const row = (src ? src.cloneNode(true) : document.createElement('tr')) as HTMLTableRowElement;

  const name = q<HTMLElement>(row, '.r-name');
  name.textContent = rec.name;
  q<HTMLElement>(row, '.r-size').textContent = fmtBytes(rec.size);
  q<HTMLElement>(row, '.r-time').textContent = fmtDateTime(rec.modified_ms);

  const link = q<HTMLAnchorElement>(row, 'a.btn');
  link.href = '/api/recordings/' + encodeURIComponent(rec.name);
  link.setAttribute('download', rec.name);

  const del = q<HTMLButtonElement>(row, 'button.btn-danger');
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
  els.recordingsCount.textContent = fmtInt(state.recordings.length);
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
