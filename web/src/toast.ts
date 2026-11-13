/**
 * 提示气泡与底栏日志：toast() 去重/自动关闭/setLastLog()。
 */
import { els } from './dom';
import { fmtClockShort } from './format';

export type ToastLevel = 'info' | 'success' | 'warn' | 'error';

let lastToast: { msg: string; at: number } | null = null;

/** 每种提示级别的前置图标（静态 SVG 路径，经 DOM API 构建） */
const TOAST_ICONS: Readonly<Record<ToastLevel, string>> = {
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 7.6v.2"/>',
  success: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.3 2.4 2.4 4.6-5.2"/>',
  warn: '<path d="M12 4.5 21 19.5H3z"/><path d="M12 10v4"/><path d="M12 16.8v.2"/>',
  error: '<circle cx="12" cy="12" r="8.5"/><path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6"/>',
};

function buildToastIcon(level: ToastLevel): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const parts = TOAST_ICONS[level].match(/<[a-z]+[^>]*>/g) ?? [];
  for (const part of parts) {
    const tag = part.match(/^<([a-z]+)/);
    if (!tag) continue;
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag[1]);
    const attrs = part.match(/[a-z-]+="[^"]*"/g) ?? [];
    for (const attr of attrs) {
      const m = attr.match(/^([a-z-]+)="([^"]*)"$/);
      if (m) el.setAttribute(m[1], m[2]);
    }
    svg.appendChild(el);
  }
  return svg;
}

export function toast(message: string, level: ToastLevel = 'info'): void {
  const now = Date.now();
  if (lastToast && lastToast.msg === message && now - lastToast.at < 3500) return;
  lastToast = { msg: message, at: now };

  const box = document.createElement('div');
  box.className = 'toast ' + level;

  const ic = document.createElement('span');
  ic.className = 'toast-ic';
  ic.appendChild(buildToastIcon(level));

  const msg = document.createElement('span');
  msg.className = 'toast-msg';
  msg.textContent = message;

  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'toast-x';
  x.setAttribute('aria-label', '关闭提示');
  x.textContent = '×';

  box.append(ic, msg, x);
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
  els.lastLogMsg.textContent = fmtClockShort(Date.now()) + ' · ' + message;
}
