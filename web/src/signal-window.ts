/**
 * 单通道信号曲线浮窗：可拖拽窗口、DBC 报文/信号选择、收帧解码、曲线与图例刷新。
 * 每个窗口独立持有定义、选择与样本；只处理 channel 与自身一致的帧。
 */
import { SignalChart, MAX_SERIES } from './chart';
import { fmtSignal, hexOf } from './format';
import { clampSignalWindow, makeSignalWindowDraggable, placeSignalWindow } from './signal-drag';
import { SignalSession } from './signal-session';
import type { SignalLegendItem } from './signal-session';
import type {
  ChannelStatusDto,
  DbcDefinitionDto,
  DbcSignalDto,
  FrameDto,
} from './types';

const DEFAULT_WINDOW_MS = 30000;

/** 浮窗向外暴露的协作动作；定义与元数据由 manager 提供。 */
export interface SignalWindowHooks {
  loadDbc: (file: File) => void;
  removeDbc: () => void;
  focus: () => void;
  close: () => void;
  channelStatus: () => ChannelStatusDto | null;
}

function mk<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = cls;
  return el;
}

function text<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  value: string
): HTMLElementTagNameMap[K] {
  const el = mk(tag, cls);
  el.textContent = value;
  return el;
}

export class SignalWindow {
  readonly channel: number;
  readonly root: HTMLElement;
  private readonly hooks: SignalWindowHooks;
  private readonly head: HTMLElement;
  private readonly nameEl: HTMLElement;
  private readonly metaEl: HTMLElement;
  private readonly dbcNameEl: HTMLElement;
  private readonly closeBtn: HTMLButtonElement;
  private readonly loadBtn: HTMLButtonElement;
  private readonly fileInput: HTMLInputElement;
  private readonly removeBtn: HTMLButtonElement;
  private readonly windowSelect: HTMLSelectElement;
  private readonly body: HTMLElement;
  private readonly noDbc: HTMLElement;
  private readonly noDbcText: HTMLElement;
  private readonly msgList: HTMLElement;
  private readonly signalBar: HTMLElement;
  private readonly signalEmpty: HTMLElement;
  private readonly legend: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly chartCanvas: HTMLCanvasElement;
  private readonly chart: SignalChart;
  private readonly session: SignalSession;

  private loading = false;
  private rafId: number | null = null;
  /** 当前图例按钮对应的 key 序列；用于判断能否原位更新而不是重建按钮。 */
  private legendKeys: string[] = [];

  constructor(channel: number, host: HTMLElement, hooks: SignalWindowHooks) {
    this.channel = channel;
    this.hooks = hooks;
    this.session = new SignalSession(channel);
    this.root = mk('article', 'signal-window');
    this.root.tabIndex = -1;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', '信号曲线窗口');

    this.head = mk('header', 'signal-window-head');
    this.nameEl = text('span', 'sw-name', 'CH' + (channel + 1));
    this.metaEl = text('span', 'sw-meta', '通道状态未知');
    this.dbcNameEl = text('span', 'sw-dbc-name', '未加载 DBC');

    const idBlock = mk('div', 'sw-id');
    idBlock.append(this.nameEl, this.metaEl);
    const dbcBlock = mk('div', 'sw-dbc');
    dbcBlock.appendChild(this.dbcNameEl);
    this.closeBtn = mk('button', 'ef-btn small icon-only sw-close');
    this.closeBtn.type = 'button';
    this.closeBtn.setAttribute('aria-label', '关闭此通道的信号曲线窗口');
    this.closeBtn.appendChild(text('span', '', '×'));
    this.head.append(
      idBlock,
      dbcBlock,
      text('span', 'sw-drag', '拖动标题栏移动'),
      this.closeBtn
    );

    const tools = mk('div', 'sw-tools');
    this.loadBtn = mk('button', 'ef-btn small sw-load');
    this.loadBtn.type = 'button';
    this.loadBtn.appendChild(text('span', '', '加载 DBC'));
    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.className = 'sr-only sw-file';
    this.fileInput.accept = '.dbc,text/plain';
    this.fileInput.tabIndex = -1;
    this.fileInput.setAttribute('aria-hidden', 'true');
    this.removeBtn = mk('button', 'ef-btn small danger sw-remove');
    this.removeBtn.type = 'button';
    this.removeBtn.appendChild(text('span', '', '移除 DBC'));
    this.removeBtn.disabled = true;

    const selectId = 'swWindowSelect' + channel;
    const selectLabel = text('label', 'sw-window-label', '时间窗');
    selectLabel.htmlFor = selectId;
    this.windowSelect = mk('select', 'input sw-window-select');
    this.windowSelect.id = selectId;
    for (const [value, label] of [
      ['10000', '10 秒'],
      ['30000', '30 秒'],
      ['60000', '1 分钟'],
      ['300000', '5 分钟'],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      if (value === String(DEFAULT_WINDOW_MS)) opt.selected = true;
      this.windowSelect.appendChild(opt);
    }
    tools.append(
      this.loadBtn,
      this.fileInput,
      this.removeBtn,
      text('span', 'head-spacer', ''),
      selectLabel,
      this.windowSelect
    );

    this.msgList = mk('div', 'dbc-msg-list sw-msg-list');
    this.msgList.setAttribute('role', 'group');
    this.msgList.setAttribute('aria-label', 'DBC 报文列表');
    const msgPane = mk('div', 'sw-msg-pane');
    const paneHead = mk('div', 'dbc-pane-head');
    paneHead.append(text('span', '', '报文'), text('span', 'dbc-pane-tip', '点击切换'));
    msgPane.append(paneHead, this.msgList);

    this.signalBar = mk('div', 'dbc-signal-bar sw-signal-bar');
    this.signalBar.setAttribute('role', 'group');
    this.signalBar.setAttribute('aria-label', '信号开关');
    this.signalEmpty = mk('div', 'dbc-signal-empty sw-signal-empty');
    this.signalEmpty.hidden = true;
    const chartBox = mk('div', 'dbc-chart-box sw-chart-box');
    const canvas = document.createElement('canvas');
    canvas.className = 'sw-canvas';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute(
      'aria-label',
      '信号曲线图：各曲线归一化后共用同一时间轴；纵轴虚线默认跟随选中曲线，吸附时显示该曲线刻度值，并列出同一 X 上各曲线的数值'
    );
    chartBox.appendChild(canvas);
    this.chartCanvas = canvas;
    this.legend = mk('div', 'dbc-legend sw-legend');
    const chartPane = mk('div', 'sw-chart-pane');
    chartPane.append(this.signalBar, this.signalEmpty, chartBox, this.legend);

    this.body = mk('div', 'sw-body');
    this.body.append(msgPane, chartPane);

    this.noDbc = mk('div', 'sw-no-dbc');
    this.noDbcText = text('p', '', '');
    const emptyLoad = mk('button', 'ef-btn small sw-empty-load');
    emptyLoad.type = 'button';
    emptyLoad.appendChild(text('span', '', '加载 DBC 文件'));
    this.noDbc.append(this.noDbcText, emptyLoad);

    this.hint = mk('p', 'sw-hint');
    this.hint.setAttribute('aria-live', 'polite');

    this.root.append(this.head, tools, this.body, this.noDbc, this.hint);
    host.appendChild(this.root);

    this.chart = new SignalChart(canvas);
    this.chart.setWindowMs(this.windowMs());
    this.chart.setOnSelectChange(() => this.onChartSelect());
    this.bindEvents(emptyLoad);
    this.renderHeader();
    this.setDefinition(null);
  }

  /** 用新定义刷新窗口；形态变化时清空选择与样本（保留窗口位置）。 */
  setDefinition(def: DbcDefinitionDto | null): void {
    const changed = this.session.setDefinition(def);
    this.renderHeader();
    this.renderMessageList();
    this.renderSignalBar();
    this.updateSignalEmpty();
    this.body.hidden = def === null;
    this.noDbc.hidden = def !== null;
    this.btnRemoveState();
    if (changed) {
      this.setHint(
        def !== null
          ? '已加载 ' + def.name + '：选择报文与信号后开始绘制。'
          : '通道 ' + this.channelLabel() +
            ' 尚未加载 DBC：点击「加载 DBC」选择 .dbc 文件后，可在此选择报文与信号并绘制曲线。',
        false
      );
      this.renderChart();
    }
  }

  /** 仅刷新通道名/运行状态/DBC 名（状态推送后调用）。 */
  refreshMeta(): void {
    this.renderHeader();
  }

  /** 主题切换后重绘：色板来自 CSS 变量，需重新解析后刷新开关点色、图例与曲线。 */
  refreshTheme(): void {
    this.renderSignalBar();
    this.renderChart();
  }

  setLoading(loading: boolean): void {
    this.loading = loading;
    this.loadBtn.disabled = loading;
    if (loading) this.loadBtn.setAttribute('aria-busy', 'true');
    else this.loadBtn.removeAttribute('aria-busy');
    this.btnRemoveState();
  }

  setHint(message: string, isError: boolean): void {
    this.hint.textContent = message;
    this.hint.classList.toggle('is-error', isError);
  }

  /** 只解码本窗口通道的帧；rAF 合并后统一刷新 chart/legend。 */
  feed(frames: FrameDto[]): void {
    if (this.session.feed(frames)) this.scheduleRender();
  }

  /** 快照到达：保留选择，重置样本并用快照帧回填。 */
  seed(frames: FrameDto[]): void {
    if (this.session.seed(frames)) this.scheduleRender();
  }

  /** 清空曲线样本，保留当前信号选择。 */
  clearSamples(): void {
    if (this.session.clearSamples()) this.scheduleRender();
  }

  /** 打开时把窗口放到视口内的默认位置；cascade 用于多窗错位。 */
  placeDefault(cascade: number): void {
    placeSignalWindow(this.root, cascade);
  }

  /** 窗口尺寸变化后把它拉回视口；小屏铺满由 CSS + 固定 1rem 实现。 */
  clampToViewport(): void {
    clampSignalWindow(this.root);
  }

  focus(): void {
    this.hooks.focus();
    this.root.focus({ preventScroll: true });
  }

  destroy(): void {
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.chart.destroy();
    this.root.remove();
  }

  /* ---------- 内部：DOM 绑定 ---------- */

  private bindEvents(emptyLoad: HTMLButtonElement): void {
    this.root.addEventListener('pointerdown', () => this.hooks.focus(), { capture: true });
    this.closeBtn.addEventListener('click', () => this.hooks.close());
    this.loadBtn.addEventListener('click', () => this.fileInput.click());
    emptyLoad.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0] ?? null;
      this.fileInput.value = '';
      if (file) this.hooks.loadDbc(file);
    });
    this.removeBtn.addEventListener('click', () => this.hooks.removeDbc());
    this.msgList.addEventListener('click', (e) => this.onMessageClick(e));
    this.signalBar.addEventListener('click', (e) => this.onSignalClick(e));
    this.legend.addEventListener('click', (e) => this.onLegendClick(e));
    this.windowSelect.addEventListener('change', () => this.onWindowChange());
    makeSignalWindowDraggable(this.root, this.head);
  }

  /* ---------- 内部：头/列表/开关 ---------- */

  private channelLabel(): string {
    const st = this.hooks.channelStatus();
    const name = st?.name.trim() ?? '';
    return name.length > 0 ? name : 'CH' + (this.channel + 1);
  }

  private renderHeader(): void {
    const st = this.hooks.channelStatus();
    this.nameEl.textContent = this.channelLabel();
    const source = st === null ? '通道状态未知' : st.source === 'socketcan' ? 'SocketCAN' : 'USB';
    const running = st === null ? '' : st.running ? ' │ 运行中' : ' │ 已停止';
    this.metaEl.textContent = source + running;
    this.metaEl.classList.toggle('is-running', st?.running === true);
    const def = this.session.definition();
    this.dbcNameEl.textContent = def !== null ? def.name : '未加载 DBC';
    this.dbcNameEl.title = def !== null ? def.name : '未加载 DBC';
    this.noDbcText.textContent =
      '通道 ' + this.channelLabel() +
      ' 尚未加载 DBC：点击「加载 DBC」选择 .dbc 文件后，可在此选择报文与信号并绘制曲线。';
  }

  private btnRemoveState(): void {
    this.removeBtn.disabled = this.loading || this.session.definition() === null;
  }

  private currentWindowMs(): number {
    const n = Number(this.windowSelect.value);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_WINDOW_MS;
  }

  private windowMs(): number {
    return this.currentWindowMs();
  }

  private renderMessageList(): void {
    const frag = document.createDocumentFragment();
    for (const m of this.session.messages()) {
      const active = this.session.isActive(m);
      const btn = mk('button', 'dbc-msg');
      btn.type = 'button';
      btn.dataset['id'] = String(m.id);
      btn.dataset['extended'] = m.extended ? '1' : '0';
      btn.setAttribute('aria-pressed', String(active));
      if (active) btn.classList.add('is-active');
      btn.append(
        text('span', 'dbc-msg-id', hexOf(m.id, m.extended ? 8 : 3)),
        text('span', 'dbc-msg-name', m.name),
        text('span', 'dbc-msg-count', String(m.signals.length))
      );
      frag.appendChild(btn);
    }
    this.msgList.replaceChildren(frag);
  }

  private renderSignalBar(): void {
    const frag = document.createDocumentFragment();
    for (const item of this.session.signalsOfActive()) {
      const on = item.color !== null;
      const btn = mk('button', 'sig-chip');
      btn.type = 'button';
      btn.dataset['signal'] = item.signal.name;
      btn.setAttribute('aria-pressed', String(on));
      if (on) btn.classList.add('is-on');
      const dot = mk('span', 'sig-dot');
      if (item.color !== null) dot.setAttribute('style', 'background:' + item.color);
      btn.append(dot, text('span', 'sig-chip-name', item.signal.name));
      frag.appendChild(btn);
    }
    this.signalBar.replaceChildren(frag);
  }

  private updateSignalEmpty(): void {
    const def = this.session.definition();
    const msg = this.session.activeMessage();
    let hint: string | null = null;
    if (def === null) hint = '加载 DBC 后可选择信号并绘制曲线。';
    else if (def.messages.length === 0) hint = 'DBC 中没有报文，无法绘制曲线。';
    else if (msg === null) hint = '选择左侧报文以查看可绘制的信号。';
    else if (msg.signals.length === 0) hint = '该报文没有可解码信号。';
    else if (this.session.seriesCount() === 0) hint = '点击信号开关，将信号加入曲线。';
    this.signalEmpty.textContent = hint ?? '';
    this.signalEmpty.hidden = hint === null;
  }

  /* ---------- 内部：采样/绘图 ---------- */

  /** 曲线选中变化：图例按钮态与画布可读描述同步（样本与选择逻辑不在此处改动）。 */
  private onChartSelect(): void {
    this.renderLegend();
    this.updateChartAria();
  }

  /** 画布的可读描述跟随选中曲线（读屏用户可知当前突出显示的是哪条）。 */
  private updateChartAria(): void {
    const key = this.chart.activeKey();
    const name =
      key === null ? null : this.session.legendItems().find((i) => i.key === key)?.name ?? null;
    this.chartCanvas.setAttribute(
      'aria-label',
      name === null
        ? '信号曲线图：各曲线归一化后共用同一时间轴；纵轴虚线默认跟随选中曲线，吸附时显示该曲线刻度值，并列出同一 X 上各曲线的数值'
        : '信号曲线图：当前突出显示 ' + name + '；纵轴虚线保留最近刻度，吸附时显示刻度值并列出同一 X 上各曲线的数值'
    );
  }

  private scheduleRender(): void {
    if (this.rafId !== null) return;
    this.rafId = window.requestAnimationFrame(() => {
      this.rafId = null;
      this.renderChart();
    });
  }

  private renderChart(): void {
    this.chart.update(this.session.chartSeries(), this.currentWindowMs());
    this.renderLegend();
  }

  /** 图例/开关里的线形标记：实线色块或同色虚线（与曲线的 dash 一致）。 */
  private lineMarkerCss(item: SignalLegendItem): string {
    if (item.dash.length === 0) return 'background:' + item.color;
    const on = item.dash[0];
    const off = Math.max(1, item.dash[1] ?? 4);
    return (
      'background:repeating-linear-gradient(90deg,' +
      item.color + ' 0 ' + on + 'px,transparent ' + on + 'px ' + (on + off) + 'px)'
    );
  }

  /** 图例按钮是可点控件：点击选中曲线并加粗突出显示（aria-pressed + 视觉态）。
   *  原位更新：只要 key 序列不变就复用已有按钮（只改态与文本），
   *  避免每帧 replaceChildren 打断键盘焦点/悬停；集合或顺序变化才整体重建。 */
  private renderLegend(): void {
    const items = this.session.legendItems();
    if (items.length === 0) {
      if (this.legendKeys.length !== 0) {
        this.legendKeys = [];
        this.legend.replaceChildren();
      }
      return;
    }
    const keys = items.map((i) => i.key);
    const sameOrder =
      keys.length === this.legendKeys.length &&
      keys.every((k, i) => k === this.legendKeys[i]);
    if (!sameOrder) {
      const frag = document.createDocumentFragment();
      for (const item of items) {
        const row = mk('button', 'sig-legend');
        row.type = 'button';
        row.dataset['key'] = item.key;
        row.title = '选中此曲线以加粗突出显示';
        row.append(
          mk('span', 'sig-line'),
          text('span', 'sig-legend-name', item.name),
          text('span', 'sig-legend-value', '')
        );
        frag.appendChild(row);
      }
      this.legend.replaceChildren(frag);
      this.legendKeys = keys;
    }
    const activeKey = this.chart.activeKey();
    const rows = this.legend.children;
    for (let i = 0; i < items.length; i++) {
      const row = rows[i];
      if (!(row instanceof HTMLButtonElement)) continue;
      const item = items[i];
      const active = item.key === activeKey;
      row.classList.toggle('is-active', active);
      row.setAttribute('aria-pressed', String(active));
      /* 行内子元素固定为 [线形标记, 名称, 数值]；名称随 key 不变，只更新标记与数值 */
      const line = row.children[0];
      line.setAttribute('style', this.lineMarkerCss(item));
      const value = row.children[2];
      value.textContent =
        item.value !== null
          ? fmtSignal(item.value) + (item.unit ? ' ' + item.unit : '')
          : '—';
    }
  }

  private onLegendClick(e: MouseEvent): void {
    const target = e.target;
    const btn = target instanceof Element ? target.closest('button.sig-legend') : null;
    if (!(btn instanceof HTMLButtonElement)) return;
    const key = btn.dataset['key'];
    if (key !== undefined) this.chart.select(key);
  }

  private toggleSignal(sig: DbcSignalDto): void {
    const result = this.session.toggleSignal(sig);
    if (result === 'limit') {
      this.setHint('最多同时显示 ' + MAX_SERIES + ' 个信号曲线', true);
      return;
    }
    this.renderSignalBar();
    this.updateSignalEmpty();
    this.scheduleRender();
  }

  private onMessageClick(e: MouseEvent): void {
    const target = e.target;
    const btn = target instanceof Element ? target.closest('button.dbc-msg') : null;
    if (!(btn instanceof HTMLButtonElement)) return;
    const id = Number(btn.dataset['id']);
    if (!Number.isFinite(id)) return;
    const extended = btn.dataset['extended'] === '1';
    this.session.toggleMessage(id, extended);
    this.renderMessageList();
    this.renderSignalBar();
    this.updateSignalEmpty();
  }

  private onSignalClick(e: MouseEvent): void {
    const target = e.target;
    const btn = target instanceof Element ? target.closest('button.sig-chip') : null;
    if (!(btn instanceof HTMLButtonElement)) return;
    const name = btn.dataset['signal'];
    const msg = this.session.activeMessage();
    if (!msg || name === undefined) return;
    const sig = msg.signals.find((s) => s.name === name);
    if (sig) this.toggleSignal(sig);
  }

  private onWindowChange(): void {
    this.chart.setWindowMs(this.currentWindowMs());
    this.renderChart();
  }
}
