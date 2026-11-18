/**
 * 信号曲线浮窗的几何行为：默认落位、视口约束与标题栏拖拽。
 * 与业务/DOM 结构无关，只操作窗口根与标题栏元素。
 */

const NARROW_WIDTH = 760;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}

/** 打开时把窗口放到视口内的默认位置；cascade 用于多窗错位。 */
export function placeSignalWindow(root: HTMLElement, cascade: number): void {
  if (window.innerWidth <= NARROW_WIDTH) {
    root.style.left = '1rem';
    root.style.top = '1rem';
    return;
  }
  const rect = root.getBoundingClientRect();
  const left = Math.round((window.innerWidth - rect.width) / 2) + Math.min(cascade, 4) * 24;
  const top = Math.round(window.innerHeight * 0.12) + Math.min(cascade, 4) * 18;
  root.style.left = clamp(left, 12, window.innerWidth - rect.width - 12) + 'px';
  root.style.top = clamp(top, 12, window.innerHeight - rect.height - 12) + 'px';
}

/** 窗口尺寸变化后把它拉回视口；小屏铺满由 CSS + 固定 1rem 实现。 */
export function clampSignalWindow(root: HTMLElement): void {
  if (window.innerWidth <= NARROW_WIDTH) {
    root.style.left = '1rem';
    root.style.top = '1rem';
    return;
  }
  const rect = root.getBoundingClientRect();
  root.style.left = clamp(rect.left, 0, window.innerWidth - rect.width) + 'px';
  root.style.top = clamp(rect.top, 0, window.innerHeight - rect.height) + 'px';
}

/** 标题栏拖拽：pointer capture + 视口约束；小屏不启用（窗口铺满）。 */
export function makeSignalWindowDraggable(root: HTMLElement, handle: HTMLElement): void {
  let dragging = false;
  let offX = 0;
  let offY = 0;

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || window.innerWidth <= NARROW_WIDTH) return;
    const target = e.target;
    if (target instanceof Element && target.closest('button, input, select, a') !== null) return;
    const rect = root.getBoundingClientRect();
    offX = e.clientX - rect.left;
    offY = e.clientY - rect.top;
    dragging = true;
    root.classList.add('is-dragging');
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = root.getBoundingClientRect();
    const left = clamp(e.clientX - offX, 0, window.innerWidth - rect.width);
    const top = clamp(e.clientY - offY, 0, window.innerHeight - rect.height);
    root.style.left = left + 'px';
    root.style.top = top + 'px';
  });

  const end = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    root.classList.remove('is-dragging');
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}
