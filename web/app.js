'use strict';
/* ============================================================
 * CAN Tools · USBCAN-II 上位机 —— 前端逻辑
 *
 * 与后端约定见 docs/api.md：REST + WebSocket，同源，JSON。
 * 本文件为唯一源码（无框架、无依赖），编译为经典脚本 app.js。
 * 所有来自服务器的数据均以 unknown 接收，再经下方类型守卫收窄，
 * DOM 渲染只使用 textContent / DOM API，不拼 HTML。
 * ============================================================ */
/* ---------- API 数据形状（与 docs/api.md 一致） ---------- */
const BAUDS = ['5k', '10k', '20k', '50k', '100k', '125k', '250k', '500k', '800k', '1000k'];
const MODES = ['normal', 'listen_only', 'self_test'];
/* ---------- 通用工具 ---------- */
const BUFFER_CAP = 5000;
const MODE_LABELS = {
    normal: '正常',
    listen_only: '只听',
    self_test: '自测',
};
function byId(id) {
    const found = document.getElementById(id);
    if (!found)
        throw new Error('缺少元素 #' + id);
    return found;
}
function q(root, selector) {
    const found = root.querySelector(selector);
    if (!found)
        throw new Error('未找到元素 ' + selector);
    return found;
}
function errText(err) {
    return err instanceof Error ? err.message : String(err);
}
function p2(n) {
    return String(n).padStart(2, '0');
}
function fmtInt(n) {
    return Number.isFinite(n) ? Math.trunc(n).toLocaleString('zh-CN') : '—';
}
function fmtRate(n) {
    return Number.isFinite(n)
        ? n.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 1 })
        : '—';
}
function fmtBytes(b) {
    if (!Number.isFinite(b) || b < 0)
        return '—';
    if (b < 1024)
        return fmtInt(b) + ' B';
    if (b < 1024 * 1024)
        return (b / 1024).toFixed(1) + ' KB';
    return (b / (1024 * 1024)).toFixed(2) + ' MB';
}
function fmtClock(ms) {
    const d = new Date(ms);
    return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}
function fmtClockShort(ms) {
    const d = new Date(ms);
    return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
}
function fmtDateTime(ms) {
    return Number.isFinite(ms) ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—';
}
function fmtDur(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0 ? h + ':' + p2(m) + ':' + p2(sec) : p2(m) + ':' + p2(sec);
}
function hexOf(v, width) {
    return '0x' + v.toString(16).toUpperCase().padStart(width, '0');
}
function parseHex(raw, max) {
    const s = raw.trim().toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]+$/.test(s))
        return null;
    const v = parseInt(s, 16);
    if (!Number.isSafeInteger(v) || v < 0 || v > max)
        return null;
    return v;
}
/* ---------- JSON 类型守卫 ---------- */
function isObj(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isStr(v) {
    return typeof v === 'string';
}
function isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
}
function numOr(v, d) {
    return isNum(v) ? v : d;
}
function strOr(v, d) {
    return isStr(v) ? v : d;
}
/** 清洗设备返回的文本：去除控制字符（含 NUL 填充）与首尾空白。 */
function cleanText(v) {
    return isStr(v) ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
}
function asFilterMode(v) {
    const n = numOr(v, 1);
    return n === 0 || n === 2 ? n : 1;
}
function asBaud(v) {
    return isStr(v) && BAUDS.includes(v) ? v : null;
}
function asMode(v) {
    return isStr(v) && MODES.includes(v) ? v : null;
}
function parseFrameDto(o) {
    return {
        seq: numOr(o['seq'], 0),
        time_ms: numOr(o['time_ms'], Date.now()),
        device_ts: numOr(o['device_ts'], 0),
        channel: numOr(o['channel'], 0),
        id: numOr(o['id'], 0),
        extended: o['extended'] === true,
        remote: o['remote'] === true,
        dlc: numOr(o['dlc'], 0),
        data: strOr(o['data'], ''),
    };
}
function parseFrames(v) {
    if (!Array.isArray(v))
        return [];
    const out = [];
    for (const it of v)
        if (isObj(it))
            out.push(parseFrameDto(it));
    return out;
}
/** 校验并收窄未知 JSON 为 StatusDto；缺少关键结构时返回 null。 */
function parseStatusDto(v) {
    if (!isObj(v))
        return null;
    const dev = isObj(v['device']) ? v['device'] : null;
    if (!dev)
        return null;
    let info = null;
    if (isObj(dev['info'])) {
        const i = dev['info'];
        info = {
            index: numOr(i['index'], 0),
            fw_version: cleanText(i['fw_version']),
            serial: cleanText(i['serial']),
            hw_type: cleanText(i['hw_type']),
            channel_count: numOr(i['channel_count'], 0),
        };
    }
    const channels = [];
    if (Array.isArray(v['channels'])) {
        for (const c of v['channels']) {
            if (!isObj(c))
                continue;
            const f = isObj(c['filter'])
                ? {
                    acc_code: numOr(c['filter']['acc_code'], 0),
                    acc_mask: numOr(c['filter']['acc_mask'], 0xffffffff),
                    mode: asFilterMode(c['filter']['mode']),
                }
                : null;
            channels.push({
                index: numOr(c['index'], channels.length),
                running: c['running'] === true,
                baud: asBaud(c['baud']),
                mode: asMode(c['mode']),
                filter: f,
            });
        }
    }
    const software_filters = [];
    if (Array.isArray(v['software_filters'])) {
        for (const f of v['software_filters']) {
            if (!isObj(f))
                continue;
            software_filters.push({
                extended: f['extended'] === true,
                start: numOr(f['start'], 0),
                end: numOr(f['end'], 0),
            });
        }
    }
    const rec = isObj(v['recording']) ? v['recording'] : {};
    const stats = isObj(v['stats']) ? v['stats'] : {};
    const srv = isObj(v['server']) ? v['server'] : {};
    return {
        device: { open: dev['open'] === true, info },
        channels,
        software_filters,
        recording: {
            active: rec['active'] === true,
            file: isStr(rec['file']) ? rec['file'] : null,
            frames: isNum(rec['frames']) ? rec['frames'] : null,
            started_at_ms: isNum(rec['started_at_ms']) ? rec['started_at_ms'] : null,
        },
        stats: {
            rx_frames: numOr(stats['rx_frames'], 0),
            filtered_frames: numOr(stats['filtered_frames'], 0),
            rx_rate: numOr(stats['rx_rate'], 0),
            recorded_frames: numOr(stats['recorded_frames'], 0),
        },
        server: { version: strOr(srv['version'], ''), data_dir: strOr(srv['data_dir'], '') },
    };
}
function parseDevicesDto(v) {
    if (!isObj(v) || !Array.isArray(v['devices']))
        return [];
    const out = [];
    for (const d of v['devices']) {
        if (!isObj(d))
            continue;
        out.push({
            index: numOr(d['index'], 0),
            fw_version: cleanText(d['fw_version']),
            serial: cleanText(d['serial']),
            hw_type: cleanText(d['hw_type']),
            channel_count: numOr(d['channel_count'], 0),
        });
    }
    return out;
}
function parseRecordingsDto(v) {
    if (!isObj(v) || !Array.isArray(v['recordings']))
        return [];
    const out = [];
    for (const r of v['recordings']) {
        if (!isObj(r))
            continue;
        out.push({
            name: strOr(r['name'], ''),
            size: numOr(r['size'], 0),
            modified_ms: numOr(r['modified_ms'], 0),
        });
    }
    return out;
}
/** 校验 WS 消息；无法识别（含未知 type）返回 null，由调用方忽略。 */
function parseWsMessage(v) {
    if (!isObj(v))
        return null;
    const t = isStr(v['type']) ? v['type'] : '';
    switch (t) {
        case 'snapshot': {
            const st = parseStatusDto(v['status']);
            if (!st)
                return null;
            return { type: 'snapshot', status: st, frames: parseFrames(v['frames']) };
        }
        case 'frames':
            return { type: 'frames', frames: parseFrames(v['frames']) };
        case 'status': {
            const st = parseStatusDto(v['status']);
            return st ? { type: 'status', status: st } : null;
        }
        case 'log': {
            const lvl = v['level'];
            if ((lvl !== 'info' && lvl !== 'warn' && lvl !== 'error') || !isStr(v['message']))
                return null;
            return { type: 'log', level: lvl, message: v['message'] };
        }
        case 'cleared':
            return { type: 'cleared' };
        default:
            return null; /* 未知事件类型：忽略 */
    }
}
/* ---------- DOM 引用 ---------- */
const els = {
    /* 顶栏 */
    devicePillDot: byId('devicePillDot'),
    devicePillText: byId('devicePillText'),
    recPill: byId('recPill'),
    wsDot: byId('wsDot'),
    wsText: byId('wsText'),
    versionLabel: byId('versionLabel'),
    /* 设备连接 */
    deviceList: byId('deviceList'),
    deviceEmpty: byId('deviceEmpty'),
    btnRefreshDevices: byId('btnRefreshDevices'),
    btnOpenDevice: byId('btnOpenDevice'),
    btnCloseDevice: byId('btnCloseDevice'),
    deviceInfo: byId('deviceInfo'),
    devHw: byId('devHw'),
    devFw: byId('devFw'),
    devSerial: byId('devSerial'),
    devChannels: byId('devChannels'),
    /* 通道配置 */
    ch1Check: byId('ch1Check'),
    ch2Check: byId('ch2Check'),
    baudSelect: byId('baudSelect'),
    btnApplyConfig: byId('btnApplyConfig'),
    btnStopChannels: byId('btnStopChannels'),
    chipCh1: byId('chipCh1'),
    chipCh1State: byId('chipCh1State'),
    chipCh1Sub: byId('chipCh1Sub'),
    chipCh2: byId('chipCh2'),
    chipCh2State: byId('chipCh2State'),
    chipCh2Sub: byId('chipCh2Sub'),
    /* 硬件滤波 */
    accCodeInput: byId('accCodeInput'),
    accMaskInput: byId('accMaskInput'),
    filterModeSelect: byId('filterModeSelect'),
    btnAcceptAll: byId('btnAcceptAll'),
    genIdInput: byId('genIdInput'),
    btnGenFilter: byId('btnGenFilter'),
    /* 软件过滤器 */
    swFilterList: byId('swFilterList'),
    btnAddFilter: byId('btnAddFilter'),
    /* 录制 */
    btnRecStart: byId('btnRecStart'),
    btnRecStop: byId('btnRecStop'),
    recActive: byId('recActive'),
    recActiveFile: byId('recActiveFile'),
    recActiveFrames: byId('recActiveFrames'),
    recActiveElapsed: byId('recActiveElapsed'),
    dataDirLabel: byId('dataDirLabel'),
    /* 统计 */
    statRx: byId('statRx'),
    statRate: byId('statRate'),
    statFiltered: byId('statFiltered'),
    statRecorded: byId('statRecorded'),
    /* 实时报文 */
    frameFilter: byId('frameFilter'),
    autoscrollCheck: byId('autoscrollCheck'),
    btnPauseView: byId('btnPauseView'),
    btnPauseLabel: byId('btnPauseLabel'),
    icPause: byId('icPause'),
    icPlay: byId('icPlay'),
    btnClearView: byId('btnClearView'),
    tableWrap: byId('tableWrap'),
    framesBody: byId('framesBody'),
    frameEmpty: byId('frameEmpty'),
    emptyTitle: byId('emptyTitle'),
    emptyHint: byId('emptyHint'),
    pausedBadge: byId('pausedBadge'),
    pausedCount: byId('pausedCount'),
    lastLogMsg: byId('lastLogMsg'),
    visibleCount: byId('visibleCount'),
    bufferUsage: byId('bufferUsage'),
    /* 录制文件 */
    recordingsList: byId('recordingsList'),
    recordingsEmpty: byId('recordingsEmpty'),
    recordingsCount: byId('recordingsCount'),
    btnRefreshRecordings: byId('btnRefreshRecordings'),
    /* 其它 */
    toasts: byId('toasts'),
    rowTpl: byId('rowTpl'),
    recRowTpl: byId('recRowTpl'),
    swRowTpl: byId('swRowTpl'),
};
const rowTplRow = els.rowTpl.content.firstElementChild;
const recTplRow = els.recRowTpl.content.firstElementChild;
const swTplRow = els.swRowTpl.content.firstElementChild;
const state = {
    status: null,
    devices: [],
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
const busy = new Set();
/* ---------- REST 客户端 ---------- */
/** 发送 REST 请求；失败（网络错误、非 2xx、ok:false）时抛出带服务端 error 文案的错误。 */
async function api(path, method = 'GET', body) {
    const init = { method };
    if (body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
    }
    let res;
    try {
        res = await fetch(path, init);
    }
    catch {
        throw new Error('无法连接服务器，请确认后端已启动');
    }
    let data;
    try {
        data = await res.json();
    }
    catch {
        data = undefined;
    }
    if (!res.ok || (isObj(data) && data['ok'] === false)) {
        const msg = isObj(data) && isStr(data['error']) ? data['error'] : '请求失败（HTTP ' + res.status + '）';
        throw new Error(msg);
    }
    return data;
}
/** 以按钮 busy 态执行异步操作：期间禁用按钮，失败统一弹出错误提示。 */
async function runBusy(btn, fn) {
    if (btn.disabled || busy.has(btn))
        return;
    busy.add(btn);
    btn.disabled = true;
    btn.classList.add('busy');
    btn.setAttribute('aria-busy', 'true');
    try {
        await fn();
    }
    catch (err) {
        toast(errText(err), 'error');
    }
    finally {
        busy.delete(btn);
        btn.classList.remove('busy');
        btn.removeAttribute('aria-busy');
        updateControls();
    }
}
/* ---------- 提示气泡 ---------- */
let lastToast = null;
/** 每种提示级别的前置图标（静态 SVG 路径，经 DOM API 构建） */
const TOAST_ICONS = {
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 7.6v.2"/>',
    success: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.3 2.4 2.4 4.6-5.2"/>',
    warn: '<path d="M12 4.5 21 19.5H3z"/><path d="M12 10v4"/><path d="M12 16.8v.2"/>',
    error: '<circle cx="12" cy="12" r="8.5"/><path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6"/>',
};
function buildToastIcon(level) {
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
        if (!tag)
            continue;
        const el = document.createElementNS('http://www.w3.org/2000/svg', tag[1]);
        const attrs = part.match(/[a-z-]+="[^"]*"/g) ?? [];
        for (const attr of attrs) {
            const m = attr.match(/^([a-z-]+)="([^"]*)"$/);
            if (m)
                el.setAttribute(m[1], m[2]);
        }
        svg.appendChild(el);
    }
    return svg;
}
function toast(message, level = 'info') {
    const now = Date.now();
    if (lastToast && lastToast.msg === message && now - lastToast.at < 3500)
        return;
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
    const close = () => {
        if (closed)
            return;
        closed = true;
        box.classList.add('out');
        window.setTimeout(() => box.remove(), 200);
    };
    x.addEventListener('click', close);
    const ttl = level === 'error' ? 6500 : level === 'warn' ? 5000 : 3200;
    window.setTimeout(close, ttl);
    while (els.toasts.children.length > 5) {
        const first = els.toasts.firstElementChild;
        if (first)
            first.remove();
        else
            break;
    }
}
function setLastLog(message) {
    els.lastLogMsg.textContent = fmtClockShort(Date.now()) + ' · ' + message;
}
/* ---------- WebSocket ---------- */
function setWsUi(s) {
    els.wsDot.className = 'pill-dot';
    if (s === 'online') {
        els.wsDot.classList.add('ok');
        els.wsText.textContent = '服务在线';
    }
    else if (s === 'connecting') {
        els.wsDot.classList.add('warn');
        els.wsText.textContent = '服务重连中';
    }
    else {
        els.wsDot.classList.add('err');
        els.wsText.textContent = '服务离线';
    }
}
/** 建立数据链路；断开后按指数退避（上限 5s）自动重连。 */
function connectWs() {
    if (state.wsTimer !== null) {
        window.clearTimeout(state.wsTimer);
        state.wsTimer = null;
    }
    if (state.ws !== null) {
        const old = state.ws;
        state.ws = null;
        try {
            old.close();
        }
        catch {
            /* 忽略 */
        }
    }
    setWsUi('connecting');
    let ws;
    try {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(proto + '//' + location.host + '/ws');
    }
    catch {
        scheduleReconnect();
        return;
    }
    state.ws = ws;
    /* 心跳定时器与套接字同生命周期，避免重连后旧定时器残留 */
    let pingTimer = null;
    ws.onopen = () => {
        if (state.ws !== ws)
            return;
        state.wsAttempt = 0;
        setWsUi('online');
        if (pingTimer === null) {
            pingTimer = window.setInterval(() => {
                if (ws.readyState === WebSocket.OPEN)
                    ws.send('ping');
            }, 25000);
        }
    };
    ws.onmessage = (ev) => {
        if (state.ws !== ws)
            return;
        if (typeof ev.data !== 'string')
            return;
        handleWsText(ev.data);
    };
    ws.onclose = () => {
        if (pingTimer !== null) {
            window.clearInterval(pingTimer);
            pingTimer = null;
        }
        if (state.ws !== ws)
            return;
        state.ws = null;
        setWsUi('offline');
        scheduleReconnect();
    };
    ws.onerror = () => {
        /* 出错后总会触发 onclose，交由其处理 */
    };
}
function scheduleReconnect() {
    if (state.wsTimer !== null)
        return;
    const delay = Math.min(500 * Math.pow(2, state.wsAttempt), 5000);
    state.wsAttempt++;
    state.wsTimer = window.setTimeout(() => {
        state.wsTimer = null;
        connectWs();
    }, delay);
}
function handleWsText(text) {
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch {
        return;
    }
    const msg = parseWsMessage(raw);
    if (msg === null)
        return;
    switch (msg.type) {
        case 'snapshot':
            applyStatus(msg.status);
            state.buffer = msg.frames.slice(-BUFFER_CAP);
            state.pending.length = 0;
            state.pausedHidden = 0;
            els.pausedCount.textContent = '0';
            rebuildTable();
            break;
        case 'frames':
            acceptFrames(msg.frames);
            break;
        case 'status':
            applyStatus(msg.status);
            break;
        case 'log':
            if (msg.level === 'error')
                toast(msg.message, 'error');
            else if (msg.level === 'warn')
                toast(msg.message, 'warn');
            else
                setLastLog(msg.message);
            break;
        case 'cleared':
            clearLocalFrames();
            setLastLog('实时缓冲已清空');
            break;
    }
}
/* ---------- 报文管线 ---------- */
/** 收帧入缓冲（上限 BUFFER_CAP）；未暂停时并入待渲染队列，交由 rAF 批量上屏。 */
function acceptFrames(frames) {
    if (frames.length === 0)
        return;
    for (const f of frames)
        state.buffer.push(f);
    if (state.buffer.length > BUFFER_CAP) {
        state.buffer.splice(0, state.buffer.length - BUFFER_CAP);
    }
    if (state.paused) {
        state.pausedHidden += frames.length;
        els.pausedCount.textContent = fmtInt(state.pausedHidden);
        updateStrip();
        return;
    }
    for (const f of frames)
        state.pending.push(f);
    scheduleFlush();
}
let flushReq = false;
function scheduleFlush() {
    if (flushReq)
        return;
    flushReq = true;
    window.requestAnimationFrame(() => {
        flushReq = false;
        flushRows();
    });
}
/** 将一批待渲染帧写入表格（仅匹配过滤器的行），并裁剪、滚动。 */
function flushRows() {
    const batch = state.pending;
    state.pending = [];
    if (batch.length === 0) {
        updateStrip();
        return;
    }
    const frag = document.createDocumentFragment();
    for (const f of batch) {
        if (matchesFilter(f))
            frag.appendChild(buildRow(f));
    }
    if (frag.childNodes.length > 0)
        els.framesBody.appendChild(frag);
    trimRows();
    updateEmpty();
    updateStrip();
    maybeScroll();
}
function buildRow(f) {
    const src = rowTplRow;
    const row = (src ? src.cloneNode(true) : document.createElement('tr'));
    row.cells[0].textContent = fmtInt(f.seq);
    row.cells[1].textContent = fmtClock(f.time_ms);
    const badge = document.createElement('span');
    badge.className = 'ch-badge ch' + (f.channel === 0 || f.channel === 1 ? f.channel : 'x');
    badge.textContent = f.channel === 0 ? 'CAN1' : f.channel === 1 ? 'CAN2' : 'CH' + (f.channel + 1);
    row.cells[2].appendChild(badge);
    row.cells[3].textContent = hexOf(f.id, f.extended ? 8 : 3);
    const baseType = f.extended ? '扩展' : '标准';
    row.cells[4].textContent = f.remote ? baseType + '·远程' : baseType;
    row.cells[5].textContent = String(f.dlc);
    row.cells[6].textContent = f.data.length > 0 ? f.data : '—';
    if (f.remote)
        row.classList.add('remote');
    return row;
}
/** 快速过滤：对 ID 十六进制、序列、通道、数据与类型做子串匹配。 */
function matchesFilter(f) {
    const query = state.filter;
    if (!query)
        return true;
    const baseType = f.extended ? '扩展' : '标准';
    const hay = [
        f.id.toString(16),
        String(f.seq),
        String(f.channel),
        String(f.channel + 1),
        'can' + f.channel,
        f.data,
        baseType,
        f.remote ? '远程' : '',
    ]
        .join(' ')
        .toLowerCase();
    return hay.includes(query);
}
/** 由本地缓冲整体重建表格（过滤条件变化、恢复显示、快照到达时调用）。 */
function rebuildTable() {
    const frag = document.createDocumentFragment();
    for (const f of state.buffer) {
        if (matchesFilter(f))
            frag.appendChild(buildRow(f));
    }
    els.framesBody.replaceChildren(frag);
    trimRows();
    updateEmpty();
    updateStrip();
    maybeScroll();
}
function trimRows() {
    while (els.framesBody.rows.length > BUFFER_CAP) {
        els.framesBody.deleteRow(0);
    }
}
function maybeScroll() {
    if (state.autoscroll && !state.paused) {
        els.tableWrap.scrollTop = els.tableWrap.scrollHeight;
    }
}
function clearLocalFrames() {
    state.buffer.length = 0;
    state.pending.length = 0;
    state.pausedHidden = 0;
    els.pausedCount.textContent = '0';
    rebuildTable();
}
function updateStrip() {
    els.visibleCount.textContent = '显示 ' + fmtInt(els.framesBody.rows.length) + ' 行';
    els.bufferUsage.textContent = '缓冲 ' + fmtInt(state.buffer.length) + ' / ' + fmtInt(BUFFER_CAP);
}
function updateEmpty() {
    const hasRows = els.framesBody.rows.length > 0;
    els.frameEmpty.hidden = hasRows;
    if (hasRows)
        return;
    const st = state.status;
    const open = st !== null && st.device.open;
    const running = st !== null && st.channels.some((c) => c.running);
    if (state.buffer.length > 0 && state.filter) {
        els.emptyTitle.textContent = '没有匹配的报文';
        els.emptyHint.textContent = '当前过滤条件未匹配任何报文，试着调整或清空过滤输入。';
    }
    else if (!open) {
        els.emptyTitle.textContent = '未连接设备';
        els.emptyHint.textContent = '在左侧「设备连接」中选择设备并点击「打开设备」。';
    }
    else if (!running) {
        els.emptyTitle.textContent = '通道未启动';
        els.emptyHint.textContent = '选择通道、波特率与滤波器，然后点击「应用配置并启动」。';
    }
    else {
        els.emptyTitle.textContent = '等待 CAN 报文';
        els.emptyHint.textContent = '通道已启动，尚未收到报文；请确认总线波特率一致、滤波器未全部滤除。';
    }
}
/* ---------- 状态渲染 ---------- */
/** 将服务端 StatusDto 应用到顶栏、通道状态、录制、统计与全部控件可用性。 */
function applyStatus(st) {
    state.status = st;
    /* 顶栏设备胶囊：序列号为空（或仅填充字符）时不显示 S/N 段 */
    const info = st.device.info;
    if (st.device.open && info) {
        els.devicePillDot.className = 'pill-dot ok';
        let pillText;
        if (info.serial) {
            pillText = [info.hw_type, 'S/N ' + info.serial].filter((s) => s.length > 0).join(' · ');
        }
        else {
            pillText = ['已连接', info.hw_type].filter((s) => s.length > 0).join(' · ');
        }
        els.devicePillText.textContent = pillText || '设备已连接';
        els.deviceInfo.hidden = false;
        els.devHw.textContent = info.hw_type || '—';
        els.devFw.textContent = info.fw_version || '—';
        els.devSerial.textContent = info.serial || '—';
        els.devChannels.textContent = String(info.channel_count);
    }
    else {
        els.devicePillDot.className = 'pill-dot';
        els.devicePillText.textContent = '未连接设备';
        els.deviceInfo.hidden = true;
    }
    /* 通道状态 */
    for (const ch of st.channels) {
        const chip = ch.index === 0 ? els.chipCh1 : ch.index === 1 ? els.chipCh2 : null;
        const stateEl = ch.index === 0 ? els.chipCh1State : ch.index === 1 ? els.chipCh2State : null;
        const subEl = ch.index === 0 ? els.chipCh1Sub : ch.index === 1 ? els.chipCh2Sub : null;
        if (!chip || !stateEl || !subEl)
            continue;
        chip.classList.toggle('running', ch.running);
        stateEl.textContent = ch.running ? '运行中' : '已停止';
        subEl.textContent = ch.running && ch.baud ? ch.baud + ' · ' + MODE_LABELS[ch.mode ?? 'normal'] : '未运行';
    }
    /* 录制 */
    els.recActive.hidden = !st.recording.active;
    els.recPill.hidden = !st.recording.active;
    if (st.recording.active) {
        els.recActiveFile.textContent = st.recording.file ?? '—';
        els.recActiveFrames.textContent = fmtInt(st.recording.frames ?? 0);
        if (st.recording.started_at_ms !== null) {
            els.recActiveElapsed.textContent = fmtDur(Date.now() - st.recording.started_at_ms);
        }
    }
    els.dataDirLabel.textContent = st.server.data_dir || '—';
    /* 统计 */
    els.statRx.textContent = fmtInt(st.stats.rx_frames);
    els.statRate.textContent = fmtRate(st.stats.rx_rate);
    els.statFiltered.textContent = fmtInt(st.stats.filtered_frames);
    els.statRecorded.textContent = fmtInt(st.stats.recorded_frames);
    /* 版本 */
    if (st.server.version)
        els.versionLabel.textContent = 'v' + st.server.version;
    syncFormOnce(st);
    updateControls();
    updateEmpty();
}
/** 依据当前状态计算各按钮的可用性（busy 中的按钮保持禁用）。 */
function updateControls() {
    const st = state.status;
    const open = st !== null && st.device.open;
    const anyRunning = st !== null && st.channels.some((c) => c.running);
    const recActive = st !== null && st.recording.active;
    const anyChannelChecked = els.ch1Check.checked || els.ch2Check.checked;
    els.btnOpenDevice.disabled = open || state.devices.length === 0 || state.selectedDevice === null;
    els.btnCloseDevice.disabled = !open;
    els.btnApplyConfig.disabled = !open || !anyChannelChecked;
    els.btnStopChannels.disabled = !anyRunning;
    els.btnRecStart.disabled = !open || recActive;
    els.btnRecStop.disabled = !recActive;
    els.btnPauseView.disabled = !anyRunning;
    els.deviceList.classList.toggle('locked', open);
}
/** 首个状态到达时，把运行中的通道配置回填到表单（仅一次，不覆盖用户后续编辑）。 */
function syncFormOnce(st) {
    if (state.formSynced)
        return;
    state.formSynced = true;
    const running = st.channels.filter((c) => c.running);
    const ref = running.length > 0 ? running[0] : st.channels.length > 0 ? st.channels[0] : null;
    if (ref) {
        if (ref.baud)
            els.baudSelect.value = ref.baud;
        if (ref.mode) {
            const r = document.querySelector('input[name="mode"][value="' + ref.mode + '"]');
            if (r)
                r.checked = true;
        }
        if (ref.filter) {
            els.accCodeInput.value = ref.filter.acc_code.toString(16).toUpperCase();
            els.accMaskInput.value = ref.filter.acc_mask.toString(16).toUpperCase();
            els.filterModeSelect.value = String(ref.filter.mode);
        }
        if (running.length > 0) {
            els.ch1Check.checked = running.some((c) => c.index === 0);
            els.ch2Check.checked = running.some((c) => c.index === 1);
        }
        else {
            els.ch1Check.checked = ref.index === 0;
            els.ch2Check.checked = ref.index === 1;
        }
    }
    if (st.software_filters.length > 0) {
        const frag = document.createDocumentFragment();
        for (const f of st.software_filters) {
            frag.appendChild(buildSwRow(f.extended, f.start, f.end));
        }
        els.swFilterList.replaceChildren(frag);
    }
    updateControls();
}
/* ---------- 设备列表 ---------- */
function renderDevices() {
    const frag = document.createDocumentFragment();
    for (const dev of state.devices) {
        const item = document.createElement('label');
        item.className = 'device-item';
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'device';
        input.value = String(dev.index);
        input.id = 'dev-radio-' + dev.index;
        const meta = document.createElement('div');
        meta.className = 'device-meta';
        const name = document.createElement('span');
        name.className = 'device-name';
        name.textContent = 'USBCAN-II #' + dev.index;
        const sub = document.createElement('span');
        sub.className = 'device-sub';
        const subParts = [dev.channel_count + ' 通道', dev.hw_type];
        if (dev.fw_version)
            subParts.push('固件 ' + dev.fw_version);
        if (dev.serial)
            subParts.push('S/N ' + dev.serial);
        sub.textContent = subParts.filter((s) => s.length > 0).join(' · ');
        meta.append(name, sub);
        item.append(input, meta);
        const open = state.status !== null && state.status.device.open;
        input.checked = state.selectedDevice === dev.index;
        input.disabled = open;
        item.classList.toggle('selected', input.checked);
        item.htmlFor = input.id;
        frag.appendChild(item);
    }
    els.deviceList.replaceChildren(frag);
    els.deviceEmpty.hidden = state.devices.length > 0;
    updateControls();
}
async function loadDevices() {
    try {
        const res = await api('/api/devices');
        state.devices = parseDevicesDto(res);
        const st = state.status;
        const openIdx = st !== null && st.device.open && st.device.info ? st.device.info.index : null;
        if (openIdx !== null) {
            state.selectedDevice = openIdx;
        }
        else if (state.selectedDevice === null || !state.devices.some((d) => d.index === state.selectedDevice)) {
            state.selectedDevice = state.devices.length > 0 ? state.devices[0].index : null;
        }
        renderDevices();
    }
    catch (err) {
        toast(errText(err), 'error');
    }
}
async function loadStatus() {
    try {
        const res = await api('/api/status');
        const st = parseStatusDto(res);
        if (!st)
            throw new Error('状态响应格式异常');
        applyStatus(st);
    }
    catch (err) {
        toast(errText(err), 'error');
    }
}
async function loadHealth() {
    try {
        const res = await api('/api/health');
        if (isObj(res) && isStr(res['version']) && !state.status) {
            els.versionLabel.textContent = 'v' + res['version'];
        }
    }
    catch (err) {
        toast(errText(err), 'error');
    }
}
/* ---------- 录制文件 ---------- */
function buildRecRow(rec) {
    const src = recTplRow;
    const row = (src ? src.cloneNode(true) : document.createElement('tr'));
    const name = q(row, '.r-name');
    name.textContent = rec.name;
    q(row, '.r-size').textContent = fmtBytes(rec.size);
    q(row, '.r-time').textContent = fmtDateTime(rec.modified_ms);
    const link = q(row, 'a.btn');
    link.href = '/api/recordings/' + encodeURIComponent(rec.name);
    link.setAttribute('download', rec.name);
    const del = q(row, 'button.btn-danger');
    del.addEventListener('click', () => {
        void deleteRecording(rec.name, del);
    });
    return row;
}
function renderRecordings() {
    const frag = document.createDocumentFragment();
    for (const rec of state.recordings) {
        if (rec.name)
            frag.appendChild(buildRecRow(rec));
    }
    els.recordingsList.replaceChildren(frag);
    els.recordingsEmpty.hidden = state.recordings.length > 0;
    els.recordingsCount.textContent = fmtInt(state.recordings.length);
}
async function loadRecordings() {
    try {
        const res = await api('/api/recordings');
        const list = parseRecordingsDto(res);
        list.sort((a, b) => b.modified_ms - a.modified_ms);
        state.recordings = list;
        renderRecordings();
    }
    catch (err) {
        toast(errText(err), 'error');
    }
}
async function deleteRecording(name, btn) {
    if (!window.confirm('删除录制文件「' + name + '」？此操作不可恢复。'))
        return;
    await runBusy(btn, async () => {
        await api('/api/recordings/' + encodeURIComponent(name), 'DELETE');
        toast('已删除 ' + name, 'success');
        await loadRecordings();
    });
}
/* ---------- 软件过滤器 ---------- */
function buildSwRow(ext, start, end) {
    const src = swTplRow;
    const row = (src ? src.cloneNode(true) : document.createElement('div'));
    const extIn = q(row, '.sw-ext');
    extIn.checked = ext;
    const startIn = q(row, '.sw-start');
    startIn.value = start !== undefined ? start.toString(16).toUpperCase() : '100';
    const endIn = q(row, '.sw-end');
    endIn.value = end !== undefined ? end.toString(16).toUpperCase() : '7FF';
    q(row, '.sw-del').addEventListener('click', () => {
        row.remove();
    });
    return row;
}
/** 从表单收集 POST /api/config 请求体；校验失败时提示并返回 null。 */
function collectConfig() {
    const channels = [];
    if (els.ch1Check.checked)
        channels.push(0);
    if (els.ch2Check.checked)
        channels.push(1);
    if (channels.length === 0) {
        toast('请至少选择一个通道', 'warn');
        return null;
    }
    const baud = asBaud(els.baudSelect.value) ?? '500k';
    const checked = document.querySelector('input[name="mode"]:checked');
    const mode = checked ? asMode(checked.value) ?? 'normal' : 'normal';
    const accCode = parseHex(els.accCodeInput.value, 0xffffffff);
    if (accCode === null) {
        toast('验收码不是有效的十六进制值（0 – FFFFFFFF）', 'warn');
        els.accCodeInput.focus();
        return null;
    }
    const accMask = parseHex(els.accMaskInput.value, 0xffffffff);
    if (accMask === null) {
        toast('屏蔽码不是有效的十六进制值（0 – FFFFFFFF）', 'warn');
        els.accMaskInput.focus();
        return null;
    }
    const filterMode = asFilterMode(Number(els.filterModeSelect.value));
    const software_filters = [];
    const rows = Array.from(els.swFilterList.querySelectorAll('.sw-row'));
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const ext = q(row, '.sw-ext').checked;
        const maxId = ext ? 0x1fffffff : 0x7ff;
        const startIn = q(row, '.sw-start');
        const endIn = q(row, '.sw-end');
        const start = parseHex(startIn.value, maxId);
        const end = parseHex(endIn.value, maxId);
        const scope = ext ? '扩展帧最大 1FFFFFFF' : '标准帧最大 7FF';
        if (start === null) {
            toast('第 ' + (i + 1) + ' 条过滤器：起始 ID 无效（' + scope + '）', 'warn');
            startIn.focus();
            return null;
        }
        if (end === null) {
            toast('第 ' + (i + 1) + ' 条过滤器：结束 ID 无效（' + scope + '）', 'warn');
            endIn.focus();
            return null;
        }
        if (start > end) {
            toast('第 ' + (i + 1) + ' 条过滤器：起始 ID 不能大于结束 ID', 'warn');
            startIn.focus();
            return null;
        }
        software_filters.push({ extended: ext, start, end });
    }
    return {
        channels,
        baud,
        mode,
        filter: { acc_code: accCode, acc_mask: accMask, mode: filterMode },
        software_filters,
    };
}
/* ---------- 视图控制 ---------- */
function setAutoscroll(on) {
    state.autoscroll = on;
    els.autoscrollCheck.checked = on;
    if (on)
        maybeScroll();
}
function setPaused(p) {
    if (state.paused === p)
        return;
    state.paused = p;
    els.btnPauseView.setAttribute('aria-pressed', String(p));
    els.btnPauseLabel.textContent = p ? '继续显示' : '暂停显示';
    els.icPause.hidden = p;
    els.icPlay.hidden = !p;
    /* 暂停时自动滚动无意义，禁用开关以免状态矛盾 */
    els.autoscrollCheck.disabled = p;
    if (p) {
        els.pausedCount.textContent = fmtInt(state.pausedHidden);
        els.pausedBadge.hidden = false;
    }
    else {
        state.pausedHidden = 0;
        els.pausedCount.textContent = '0';
        els.pausedBadge.hidden = true;
        rebuildTable();
    }
}
/* ---------- 事件绑定 ---------- */
function bindEvents() {
    els.btnRefreshDevices.addEventListener('click', () => {
        void runBusy(els.btnRefreshDevices, loadDevices);
    });
    els.deviceList.addEventListener('change', (e) => {
        const t = e.target;
        if (t instanceof HTMLInputElement && t.name === 'device') {
            state.selectedDevice = Number(t.value);
            renderDevices();
        }
    });
    els.btnOpenDevice.addEventListener('click', () => {
        void runBusy(els.btnOpenDevice, async () => {
            if (state.selectedDevice === null)
                return;
            const res = await api('/api/device/open', 'POST', { index: state.selectedDevice });
            const st = parseStatusDto(isObj(res) ? res['status'] : null);
            if (st)
                applyStatus(st);
            toast('设备已打开', 'success');
            await loadDevices();
        });
    });
    els.btnCloseDevice.addEventListener('click', () => {
        void runBusy(els.btnCloseDevice, async () => {
            const res = await api('/api/device/close', 'POST');
            const st = parseStatusDto(isObj(res) ? res['status'] : null);
            if (st)
                applyStatus(st);
            toast('设备已关闭，通道状态已复位', 'success');
            await loadDevices();
        });
    });
    els.ch1Check.addEventListener('change', updateControls);
    els.ch2Check.addEventListener('change', updateControls);
    els.btnApplyConfig.addEventListener('click', () => {
        void runBusy(els.btnApplyConfig, async () => {
            const body = collectConfig();
            if (!body)
                return;
            const res = await api('/api/config', 'POST', body);
            const st = parseStatusDto(isObj(res) ? res['status'] : null);
            if (st)
                applyStatus(st);
            const names = body.channels.map((c) => 'CAN' + (c + 1)).join('、');
            toast('配置已应用，' + names + ' 已启动（' + body.baud + '）', 'success');
        });
    });
    els.btnStopChannels.addEventListener('click', () => {
        void runBusy(els.btnStopChannels, async () => {
            const res = await api('/api/stop', 'POST', {});
            const st = parseStatusDto(isObj(res) ? res['status'] : null);
            if (st)
                applyStatus(st);
            toast('已停止全部通道', 'success');
        });
    });
    els.btnAcceptAll.addEventListener('click', () => {
        els.accCodeInput.value = '0';
        els.accMaskInput.value = 'FFFFFFFF';
        els.filterModeSelect.value = '0';
        toast('已设置为接收全部帧', 'info');
    });
    els.btnGenFilter.addEventListener('click', () => {
        const genExt = document.querySelector('input[name="gen-ext"]:checked');
        const ext = genExt !== null && genExt.value === 'ext';
        const maxId = ext ? 0x1fffffff : 0x7ff;
        const id = parseHex(els.genIdInput.value, maxId);
        if (id === null) {
            toast('帧 ID 无效（' + (ext ? '扩展帧最大 1FFFFFFF' : '标准帧最大 7FF') + '）', 'warn');
            els.genIdInput.focus();
            return;
        }
        /* SJA1000 单滤波器位布局：标准帧 ID 位于高 11 位，扩展帧 ID 位于高 29 位 */
        const code = ext ? (id << 3) >>> 0 : (id << 21) >>> 0;
        const mask = ext ? 0x00000007 : 0x001fffff;
        els.accCodeInput.value = code.toString(16).toUpperCase();
        els.accMaskInput.value = mask.toString(16).toUpperCase();
        els.filterModeSelect.value = '1';
        toast('已生成单滤波器：验收码 ' + hexOf(code, 8) + ' · 屏蔽码 ' + hexOf(mask, 8), 'success');
    });
    els.btnAddFilter.addEventListener('click', () => {
        els.swFilterList.appendChild(buildSwRow(false));
    });
    els.btnRecStart.addEventListener('click', () => {
        void runBusy(els.btnRecStart, async () => {
            const res = await api('/api/recording/start', 'POST');
            const st = parseStatusDto(isObj(res) ? res['status'] : null);
            if (st)
                applyStatus(st);
            const file = isObj(res) && isStr(res['file']) ? res['file'] : '';
            toast('开始录制：' + file, 'success');
            await loadRecordings();
        });
    });
    els.btnRecStop.addEventListener('click', () => {
        void runBusy(els.btnRecStop, async () => {
            const res = await api('/api/recording/stop', 'POST');
            const st = parseStatusDto(isObj(res) ? res['status'] : null);
            if (st)
                applyStatus(st);
            const file = isObj(res) && isStr(res['file']) ? res['file'] : '';
            const frames = isObj(res) && isNum(res['frames']) ? fmtInt(res['frames']) : '—';
            toast('已保存 ' + file + '（' + frames + ' 帧）', 'success');
            await loadRecordings();
        });
    });
    els.btnRefreshRecordings.addEventListener('click', () => {
        void runBusy(els.btnRefreshRecordings, loadRecordings);
    });
    els.btnPauseView.addEventListener('click', () => {
        setPaused(!state.paused);
    });
    els.btnClearView.addEventListener('click', () => {
        void runBusy(els.btnClearView, async () => {
            await api('/api/frames/clear', 'POST');
            clearLocalFrames();
            setLastLog('已清空实时缓冲');
        });
    });
    els.frameFilter.addEventListener('input', () => {
        state.filter = els.frameFilter.value.trim().toLowerCase();
        rebuildTable();
    });
    els.autoscrollCheck.addEventListener('change', () => {
        setAutoscroll(els.autoscrollCheck.checked);
    });
    els.tableWrap.addEventListener('scroll', () => {
        if (!state.autoscroll)
            return;
        const d = els.tableWrap.scrollHeight - els.tableWrap.scrollTop - els.tableWrap.clientHeight;
        if (d > 100)
            setAutoscroll(false);
    }, { passive: true });
    document.addEventListener('keydown', (e) => {
        if (e.key !== '/' || e.defaultPrevented)
            return;
        const t = e.target;
        if (t instanceof HTMLInputElement ||
            t instanceof HTMLTextAreaElement ||
            t instanceof HTMLSelectElement ||
            (t instanceof HTMLElement && t.isContentEditable)) {
            return;
        }
        e.preventDefault();
        els.frameFilter.scrollIntoView({ block: 'center' });
        els.frameFilter.focus();
        els.frameFilter.select();
    });
    window.addEventListener('online', () => {
        const ws = state.ws;
        if (!ws || ws.readyState > 1)
            connectWs();
    });
}
/* ---------- 周期任务与启动 ---------- */
function tickTimers() {
    const st = state.status;
    if (st && st.recording.active && st.recording.started_at_ms !== null) {
        els.recActiveElapsed.textContent = fmtDur(Date.now() - st.recording.started_at_ms);
    }
}
function init() {
    bindEvents();
    renderRecordings();
    updateStrip();
    updateEmpty();
    void loadStatus();
    void loadDevices();
    void loadRecordings();
    void loadHealth();
    connectWs();
    window.setInterval(tickTimers, 1000);
}
init();
