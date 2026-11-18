/**
 * 提示条与底栏日志：toast() 去重/自动关闭/setLastLog()。
 * 提示条为深色条 + 左侧黄色竖条；「出错 / 注意」级别在文字前再加一面黄色小旗，
 * 错误不用红色（红色只保留给删除文件）。
 */
import { els } from './dom';
import { fmtClockShort } from './format';

export type ToastLevel = 'info' | 'success' | 'warn' | 'error';

let lastToast: { msg: string; at: number } | null = null;

/** 需要加旗的级别 → 旗面文字；info/success 只是一条消息。 */
const TOAST_FLAGS: Partial<Readonly<Record<ToastLevel, string>>> = {
  warn: '注意',
  error: '出错',
};

export function toast(message: string, level: ToastLevel = 'info'): void {
  const now = Date.now();
  if (lastToast && lastToast.msg === message && now - lastToast.at < 3500) return;
  lastToast = { msg: message, at: now };

  const box = document.createElement('div');
  box.className = 'toast ' + level;

  const flagText = TOAST_FLAGS[level];
  if (flagText !== undefined) {
    const flag = document.createElement('span');
    flag.className = 'toast-flag';
    flag.textContent = flagText;
    box.appendChild(flag);
  }

  const msg = document.createElement('span');
  msg.className = 'toast-msg';
  msg.textContent = message;

  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'toast-x';
  x.setAttribute('aria-label', '关闭提示');
  x.textContent = '×';

  box.append(msg, x);
  els.toasts.appendChild(box);

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    box.classList.add('out');
    window.setTimeout(() => box.remove(), 200);
  };
  x.addEventListener('click', close);
  const ttl = level === 'error' ? 6500 : level === 'warn' ? 5000 : 3200;
  window.setTimeout(close, ttl);

  while (els.toasts.children.length > 5) {
    const first = els.toasts.firstElementChild;
    if (first) first.remove();
    else break;
  }
}

export function setLastLog(message: string): void {
  els.lastLogMsg.textContent = fmtClockShort(Date.now()) + ' │ ' + message;
}
