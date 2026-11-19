/**
 * 界面主题插件注册表与选择器：主题 id 写入 <html data-ui-theme="…">，由 CSS 决定外观。
 *
 * 新增一个主题插件只需：在 THEMES 里加一条 { id, label }（可选 colors），
 * 并让 CSS 侧提供 `[data-ui-theme="<id>"]` 的变量覆盖；本模块不含任何配色。
 * 注意 data-ui-theme 的取值同时被 src/html/index.html 的早绘脚本引用（脚本无法 import 模块）。
 */
import { els } from './dom';

export interface ThemePlugin {
  /** data-ui-theme 与 localStorage 中使用的稳定 id。 */
  id: string;
  /** 选择器里显示的中文名。 */
  label: string;
  /** 可选：浏览器界面（地址栏/系统 UI）主题色；缺省时沿用 HTML 里的 theme-color。 */
  colors?: { light: string; dark: string };
}

/** 注册表第一项即默认主题：默认外观不依赖 data-ui-theme 属性也能正确显示。 */
export const THEMES: readonly ThemePlugin[] = [
  { id: 'default', label: '默认', colors: { light: '#e7eaee', dark: '#14181f' } },
  { id: 'endfield', label: '终末地', colors: { light: '#f4f4f2', dark: '#191919' } },
];

export const DEFAULT_THEME_ID = 'default';
/** 主题选择的持久化键；早绘脚本直接读同一个键。 */
export const THEME_STORAGE_KEY = 'can-tools-theme';

type ThemeHandler = (theme: ThemePlugin) => void;

const handlers: ThemeHandler[] = [];
let active: ThemePlugin = THEMES[0];

/** 把任意字符串（存储值/属性值）收窄为注册表中的主题；未知值回落到默认主题。 */
export function themeById(id: string | null | undefined): ThemePlugin {
  if (typeof id === 'string') {
    const found = THEMES.find((theme) => theme.id === id);
    if (found !== undefined) return found;
  }
  return THEMES[0];
}

/** 当前生效的主题（未调用 initTheme 前为默认主题）。 */
export function currentTheme(): ThemePlugin {
  return active;
}

/** 订阅主题切换；返回取消订阅函数。仅在用户切换后触发，初始化不触发。 */
export function onThemeChange(handler: ThemeHandler): () => void {
  handlers.push(handler);
  return () => {
    const index = handlers.indexOf(handler);
    if (index >= 0) handlers.splice(index, 1);
  };
}

/** 应用主题到文档：只改属性与可选的 theme-color，不写存储、不通知订阅者。 */
export function applyTheme(theme: ThemePlugin): void {
  document.documentElement.dataset.uiTheme = theme.id;
  if (theme.colors === undefined) return;
  /* 两个 meta 按 media 区分深浅；浏览器据此着色地址栏/状态栏 */
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const media = meta.getAttribute('media') ?? '';
    meta.content = media.includes('light') ? theme.colors.light : theme.colors.dark;
  }
}

function readStored(): string | null {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null; /* 隐私模式/禁用存储：按默认主题渲染 */
  }
}

function persist(id: string): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch {
    /* 存储失败只影响下次启动的默认选择，本次切换仍然生效 */
  }
}

/** 用注册表填充选择器（每次初始化重建，避免 HTML 里硬编码选项）。 */
function populateSelect(theme: ThemePlugin): void {
  const frag = document.createDocumentFragment();
  for (const item of THEMES) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.label;
    frag.appendChild(option);
  }
  els.themeSelect.replaceChildren(frag);
  els.themeSelect.value = theme.id;
}

/**
 * 初始化主题：先取早绘脚本写入的属性，再回落到 localStorage，最后回落到默认主题；
 * 然后填充选择器并绑定切换。必须在 initBackdrop() 之前调用，背景色才与主题一致。
 */
export function initTheme(): void {
  const fromAttribute = document.documentElement.dataset.uiTheme ?? null;
  const initial = themeById(fromAttribute ?? readStored());
  active = initial;
  applyTheme(initial);
  populateSelect(initial);

  els.themeSelect.addEventListener('change', () => {
    const next = themeById(els.themeSelect.value);
    if (next.id === active.id) return;
    persist(next.id);
    applyTheme(next);
    active = next;
    for (const handler of handlers) handler(next);
  });
}
