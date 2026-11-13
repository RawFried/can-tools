"use strict";
(() => {
  // src/dom.ts
  function byId(id) {
    const found = document.getElementById(id);
    if (!found) throw new Error("缺少元素 #" + id);
    return found;
  }
  function q(root, selector) {
    const found = root.querySelector(selector);
    if (!found) throw new Error("未找到元素 " + selector);
    return found;
  }
  var els = {
    /* 顶栏 */
    devicePillDot: byId("devicePillDot"),
    devicePillText: byId("devicePillText"),
    recPill: byId("recPill"),
    wsDot: byId("wsDot"),
    wsText: byId("wsText"),
    versionLabel: byId("versionLabel"),
    /* 设备刷新与通道配置 */
    btnRefreshDevices: byId("btnRefreshDevices"),
    channelSelect: byId("channelSelect"),
    channelState: byId("channelState"),
    channelRate: byId("channelRate"),
    btnChannelStart: byId("btnChannelStart"),
    btnChannelStop: byId("btnChannelStop"),
    modeField: byId("modeField"),
    /* 滤波器 */
    filterRangeList: byId("filterRangeList"),
    filterEmpty: byId("filterEmpty"),
    hwFilterState: byId("hwFilterState"),
    btnAddFilter: byId("btnAddFilter"),
    btnAcceptAll: byId("btnAcceptAll"),
    btnApplyFilters: byId("btnApplyFilters"),
    /* 录制 */
    btnRecStart: byId("btnRecStart"),
    btnRecStop: byId("btnRecStop"),
    recActive: byId("recActive"),
    recActiveFile: byId("recActiveFile"),
    recActiveFrames: byId("recActiveFrames"),
    recActiveElapsed: byId("recActiveElapsed"),
    dataDirLabel: byId("dataDirLabel"),
    /* 统计 */
    statRx: byId("statRx"),
    statRate: byId("statRate"),
    statFiltered: byId("statFiltered"),
    statRecorded: byId("statRecorded"),
    /* 发送报文 */
    sendChannel: byId("sendChannel"),
    sendId: byId("sendId"),
    sendData: byId("sendData"),
    sendDlc: byId("sendDlc"),
    sendRemote: byId("sendRemote"),
    btnSend: byId("btnSend"),
    sendCount: byId("sendCount"),
    sendHint: byId("sendHint"),
    /* 实时报文 */
    frameFilter: byId("frameFilter"),
    autoscrollCheck: byId("autoscrollCheck"),
    btnPauseView: byId("btnPauseView"),
    btnPauseLabel: byId("btnPauseLabel"),
    icPause: byId("icPause"),
    icPlay: byId("icPlay"),
    btnClearView: byId("btnClearView"),
    tableWrap: byId("tableWrap"),
    framesBody: byId("framesBody"),
    frameEmpty: byId("frameEmpty"),
    emptyTitle: byId("emptyTitle"),
    emptyHint: byId("emptyHint"),
    pausedBadge: byId("pausedBadge"),
    pausedCount: byId("pausedCount"),
    lastLogMsg: byId("lastLogMsg"),
    visibleCount: byId("visibleCount"),
    bufferUsage: byId("bufferUsage"),
    /* 录制文件 */
    recordingsList: byId("recordingsList"),
    recordingsEmpty: byId("recordingsEmpty"),
    recordingsCount: byId("recordingsCount"),
    btnRefreshRecordings: byId("btnRefreshRecordings"),
    /* DBC 信号曲线 */
    dbcPanel: byId("dbcPanel"),
    dbcName: byId("dbcName"),
    dbcSummary: byId("dbcSummary"),
    btnDbcLoad: byId("btnDbcLoad"),
    dbcFileInput: byId("dbcFileInput"),
    btnDbcRemove: byId("btnDbcRemove"),
    dbcEmpty: byId("dbcEmpty"),
    dbcBody: byId("dbcBody"),
    dbcMsgList: byId("dbcMsgList"),
    dbcSignalBar: byId("dbcSignalBar"),
    signalChart: byId("signalChart"),
    signalLegend: byId("signalLegend"),
    dbcWindowSelect: byId("dbcWindowSelect"),
    btnChartClear: byId("btnChartClear"),
    signalEmpty: byId("signalEmpty"),
    dbcHint: byId("dbcHint"),
    /* 其它 */
    toasts: byId("toasts"),
    rowTpl: byId("rowTpl"),
    recRowTpl: byId("recRowTpl"),
    filterRowTpl: byId("filterRowTpl")
  };
  var rowTplRow = els.rowTpl.content.firstElementChild;
  var recTplRow = els.recRowTpl.content.firstElementChild;
  var filterTplRow = els.filterRowTpl.content.firstElementChild;

  // src/dbc-types.ts
  var DBC_VALUE_KINDS = ["unsigned", "signed", "float", "double"];
  function asValueKind(v) {
    return isStr(v) && DBC_VALUE_KINDS.includes(v) ? v : "unsigned";
  }
  function parseDbcValues(v) {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const it of v) {
      if (!isObj(it)) continue;
      out.push({ raw: numOr(it["raw"], 0), label: strOr(it["label"], "") });
    }
    return out;
  }
  function parseDbcMux(v) {
    if (!isObj(v)) return null;
    return {
      is_multiplexer: v["is_multiplexer"] === true,
      value: isNum(v["value"]) ? v["value"] : null
    };
  }
  function parseDbcSignal(v) {
    if (!isObj(v)) return null;
    return {
      name: strOr(v["name"], ""),
      start_bit: numOr(v["start_bit"], 0),
      length: numOr(v["length"], 0),
      little_endian: v["little_endian"] !== false,
      signed: v["signed"] === true,
      factor: numOr(v["factor"], 1),
      offset: numOr(v["offset"], 0),
      min: numOr(v["min"], 0),
      max: numOr(v["max"], 0),
      unit: strOr(v["unit"], ""),
      receivers: Array.isArray(v["receivers"]) ? v["receivers"].filter(isStr) : [],
      value_kind: asValueKind(v["value_kind"]),
      mux: parseDbcMux(v["mux"]),
      values: parseDbcValues(v["values"])
    };
  }
  function parseDbcMessage(v) {
    if (!isObj(v)) return null;
    const signals = [];
    if (Array.isArray(v["signals"])) {
      for (const s of v["signals"]) {
        const parsed = parseDbcSignal(s);
        if (parsed) signals.push(parsed);
      }
    }
    return {
      id: numOr(v["id"], 0),
      extended: v["extended"] === true,
      name: strOr(v["name"], ""),
      dlc: numOr(v["dlc"], 8),
      sender: strOr(v["sender"], ""),
      signals
    };
  }
  function parseDbcDto(v) {
    if (!isObj(v)) return null;
    const messages = [];
    if (Array.isArray(v["messages"])) {
      for (const m of v["messages"]) {
        const parsed = parseDbcMessage(m);
        if (parsed) messages.push(parsed);
      }
    }
    return {
      name: strOr(v["name"], ""),
      loaded_at_ms: numOr(v["loaded_at_ms"], 0),
      messages
    };
  }
  function parseNullableDbc(v) {
    if (v === null) return null;
    if (v === void 0) return void 0;
    return parseDbcDto(v) ?? void 0;
  }

  // src/types.ts
  var BAUDS = ["5k", "10k", "20k", "50k", "100k", "125k", "250k", "500k", "800k", "1000k"];
  var MODES = ["normal", "listen_only", "self_test"];
  function isObj(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }
  function isStr(v) {
    return typeof v === "string";
  }
  function isNum(v) {
    return typeof v === "number" && Number.isFinite(v);
  }
  function numOr(v, d) {
    return isNum(v) ? v : d;
  }
  function strOr(v, d) {
    return isStr(v) ? v : d;
  }
  function cleanText(v) {
    return isStr(v) ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
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
  function parseSoftwareFilters(v) {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const f of v) {
      if (!isObj(f)) continue;
      out.push({
        extended: f["extended"] === true,
        start: numOr(f["start"], 0),
        end: numOr(f["end"], 0)
      });
    }
    return out;
  }
  function parseFrameDto(o) {
    return {
      seq: numOr(o["seq"], 0),
      time_ms: numOr(o["time_ms"], Date.now()),
      device_ts: numOr(o["device_ts"], 0),
      channel: numOr(o["channel"], 0),
      id: numOr(o["id"], 0),
      extended: o["extended"] === true,
      remote: o["remote"] === true,
      dlc: numOr(o["dlc"], 0),
      data: strOr(o["data"], "")
    };
  }
  function parseFrames(v) {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const it of v) if (isObj(it)) out.push(parseFrameDto(it));
    return out;
  }
  function parseStatusDto(v) {
    if (!isObj(v)) return null;
    const dev = isObj(v["device"]) ? v["device"] : null;
    if (!dev) return null;
    let info = null;
    if (isObj(dev["info"])) {
      const i = dev["info"];
      info = {
        index: numOr(i["index"], 0),
        fw_version: cleanText(i["fw_version"]),
        serial: cleanText(i["serial"]),
        hw_type: cleanText(i["hw_type"]),
        channel_count: numOr(i["channel_count"], 0)
      };
    }
    const channels = [];
    if (Array.isArray(v["channels"])) {
      for (const c of v["channels"]) {
        if (!isObj(c)) continue;
        const index = numOr(c["index"], channels.length);
        const source = c["source"] === "usb" ? "usb" : c["source"] === "socketcan" ? "socketcan" : index < 2 ? "usb" : "socketcan";
        const fallbackName = source === "usb" ? "CAN" + (index + 1) : "CH" + (index + 1);
        const name = strOr(c["name"], "").trim() || fallbackName;
        const filter = isObj(c["filter"]) ? {
          acc_code: numOr(c["filter"]["acc_code"], 0),
          acc_mask: numOr(c["filter"]["acc_mask"], 4294967295),
          mode: asFilterMode(c["filter"]["mode"])
        } : null;
        channels.push({
          index,
          source,
          name,
          running: c["running"] === true,
          baud: asBaud(c["baud"]),
          mode: asMode(c["mode"]),
          filter,
          bitrate: isNum(c["bitrate"]) ? c["bitrate"] : null,
          state: isStr(c["state"]) ? c["state"] : null,
          software_filters: parseSoftwareFilters(c["software_filters"])
        });
      }
    }
    const rec = isObj(v["recording"]) ? v["recording"] : {};
    const stats = isObj(v["stats"]) ? v["stats"] : {};
    const srv = isObj(v["server"]) ? v["server"] : {};
    return {
      device: { open: dev["open"] === true, info },
      channels,
      recording: {
        active: rec["active"] === true,
        file: isStr(rec["file"]) ? rec["file"] : null,
        frames: isNum(rec["frames"]) ? rec["frames"] : null,
        started_at_ms: isNum(rec["started_at_ms"]) ? rec["started_at_ms"] : null
      },
      stats: {
        rx_frames: numOr(stats["rx_frames"], 0),
        filtered_frames: numOr(stats["filtered_frames"], 0),
        rx_rate: numOr(stats["rx_rate"], 0),
        recorded_frames: numOr(stats["recorded_frames"], 0),
        tx_frames: numOr(stats["tx_frames"], 0)
      },
      server: { version: strOr(srv["version"], ""), data_dir: strOr(srv["data_dir"], "") }
    };
  }
  function parseDevicesDto(v) {
    const devices = [];
    const socketcan = [];
    if (!isObj(v)) return { devices, socketcan };
    if (Array.isArray(v["devices"])) {
      for (const d of v["devices"]) {
        if (!isObj(d)) continue;
        devices.push({
          index: numOr(d["index"], 0),
          fw_version: cleanText(d["fw_version"]),
          serial: cleanText(d["serial"]),
          hw_type: cleanText(d["hw_type"]),
          channel_count: numOr(d["channel_count"], 0)
        });
      }
    }
    if (Array.isArray(v["socketcan"])) {
      for (const l of v["socketcan"]) {
        if (!isObj(l)) continue;
        const name = cleanText(l["name"]);
        if (name.length === 0) continue;
        socketcan.push({
          name,
          channel: numOr(l["channel"], 2 + socketcan.length),
          bitrate: isNum(l["bitrate"]) ? l["bitrate"] : null,
          state: isStr(l["state"]) ? l["state"] : null,
          running: l["running"] === true
        });
      }
    }
    return { devices, socketcan };
  }
  function parseRecordingsDto(v) {
    if (!isObj(v) || !Array.isArray(v["recordings"])) return [];
    const out = [];
    for (const r of v["recordings"]) {
      if (!isObj(r)) continue;
      out.push({
        name: strOr(r["name"], ""),
        size: numOr(r["size"], 0),
        modified_ms: numOr(r["modified_ms"], 0)
      });
    }
    return out;
  }
  function parseWsMessage(v) {
    if (!isObj(v)) return null;
    const t = isStr(v["type"]) ? v["type"] : "";
    switch (t) {
      case "snapshot": {
        const st = parseStatusDto(v["status"]);
        if (!st) return null;
        const dbcRaw = v["dbc"];
        const dbc = dbcRaw === void 0 ? null : parseNullableDbc(dbcRaw) ?? null;
        return { type: "snapshot", status: st, frames: parseFrames(v["frames"]), dbc };
      }
      case "frames":
        return { type: "frames", frames: parseFrames(v["frames"]) };
      case "status": {
        const st = parseStatusDto(v["status"]);
        return st ? { type: "status", status: st } : null;
      }
      case "dbc": {
        const dbc = parseNullableDbc(v["dbc"]);
        return dbc === void 0 ? null : { type: "dbc", dbc };
      }
      case "log": {
        const lvl = v["level"];
        if (lvl !== "info" && lvl !== "warn" && lvl !== "error" || !isStr(v["message"])) return null;
        return { type: "log", level: lvl, message: v["message"] };
      }
      case "cleared":
        return { type: "cleared" };
      default:
        return null;
    }
  }

  // src/api.ts
  async function api(path, method = "GET", body) {
    const init2 = { method };
    if (body !== void 0) {
      init2.headers = { "Content-Type": "application/json" };
      init2.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, init2);
    } catch {
      throw new Error("无法连接服务器，请确认后端已启动");
    }
    let data;
    try {
      data = await res.json();
    } catch {
      data = void 0;
    }
    if (!res.ok || isObj(data) && data["ok"] === false) {
      const msg = isObj(data) && isStr(data["error"]) ? data["error"] : "请求失败（HTTP " + res.status + "）";
      throw new Error(msg);
    }
    return data;
  }
  function statusOf(res) {
    return parseStatusDto(isObj(res) ? res["status"] : null);
  }
  async function fetchStatus() {
    return parseStatusDto(await api("/api/status"));
  }
  async function fetchDevices() {
    return parseDevicesDto(await api("/api/devices"));
  }
  async function fetchRecordings() {
    return parseRecordingsDto(await api("/api/recordings"));
  }
  async function fetchHealthVersion() {
    const res = await api("/api/health");
    return isObj(res) && isStr(res["version"]) ? res["version"] : null;
  }
  async function openDevice(index) {
    return statusOf(await api("/api/device/open", "POST", { index }));
  }
  async function applyConfig(body) {
    return statusOf(await api("/api/config", "POST", body));
  }
  async function stopChannels(channels) {
    return statusOf(await api("/api/stop", "POST", { channels }));
  }
  async function updateFilters(body) {
    return statusOf(await api("/api/filters", "POST", body));
  }
  async function sendFrame(body) {
    return statusOf(await api("/api/send", "POST", body));
  }
  async function clearFrames() {
    await api("/api/frames/clear", "POST");
  }
  async function startRecording() {
    const res = await api("/api/recording/start", "POST");
    return { status: statusOf(res), file: isObj(res) && isStr(res["file"]) ? res["file"] : "" };
  }
  async function stopRecording() {
    const res = await api("/api/recording/stop", "POST");
    return {
      status: statusOf(res),
      file: isObj(res) && isStr(res["file"]) ? res["file"] : "",
      frames: isObj(res) && isNum(res["frames"]) ? res["frames"] : null
    };
  }
  async function deleteRecordingFile(name) {
    await api("/api/recordings/" + encodeURIComponent(name), "DELETE");
  }

  // src/chart.ts
  var SERIES_COLORS = [
    "#35b8d6",
    // 青
    "#e89b2c",
    // 琥珀
    "#2fb47c",
    // 绿
    "#e85b53",
    // 珊瑚
    "#9a86ec",
    // 紫
    "#5b9df3",
    // 蓝
    "#d96cb2",
    // 品红
    "#8fae25"
    // 黄绿
  ];
  var TICK_STEPS_MS = [
    1e3,
    2e3,
    5e3,
    1e4,
    15e3,
    3e4,
    6e4,
    12e4,
    3e5,
    6e5,
    18e5
  ];
  var AXIS_H = 22;
  var GUTTER = 58;
  var PAD_R = 10;
  var STRIP = 20;
  function fmtVal(v) {
    if (!Number.isFinite(v)) return "—";
    const a = Math.abs(v);
    if (a >= 1e5) return (v / 1e3).toFixed(0) + "k";
    if (a >= 1e4) return (v / 1e3).toFixed(1) + "k";
    if (a >= 100) return v.toFixed(0);
    if (a >= 10) return v.toFixed(1);
    if (a >= 1) return v.toFixed(2);
    if (a >= 0.01) return v.toFixed(3);
    return a === 0 ? "0" : v.toExponential(1);
  }
  function fmtRel(ms) {
    if (ms === 0) return "0";
    const sec = Math.round(Math.abs(ms) / 1e3);
    const txt = sec >= 60 && sec % 60 === 0 ? sec / 60 + "m" : sec + "s";
    return "-" + txt;
  }
  function hexToRgba(hex, alpha) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (m === null) return null;
    const n = parseInt(m[1], 16);
    return "rgba(" + (n >> 16 & 255) + ", " + (n >> 8 & 255) + ", " + (n & 255) + ", " + alpha + ")";
  }
  var SignalChart = class {
    constructor(canvas) {
      this.raf = 0;
      this.cssW = 0;
      this.cssH = 0;
      this.series = [];
      this.windowMs = 3e4;
      this.canvas = canvas;
      const ctx = canvas.getContext("2d");
      if (ctx === null) throw new Error("无法创建 2D 绘图上下文");
      this.ctx = ctx;
      this.ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.schedule());
      if (this.ro !== null) this.ro.observe(canvas);
      this.schedule();
    }
    /** 用最新数据整体重绘（内部合并到 rAF）。 */
    update(series2, windowMs) {
      this.series = series2;
      if (windowMs > 0) this.windowMs = windowMs;
      this.schedule();
    }
    setWindowMs(windowMs) {
      if (windowMs <= 0 || windowMs === this.windowMs) return;
      this.windowMs = windowMs;
      this.schedule();
    }
    /** 立即重绘（取消挂起的 rAF，避免同一帧重复绘制）。 */
    render() {
      this.cancelFrame();
      this.draw();
    }
    destroy() {
      this.cancelFrame();
      if (this.ro !== null) this.ro.disconnect();
    }
    cancelFrame() {
      if (this.raf !== 0) {
        cancelAnimationFrame(this.raf);
        this.raf = 0;
      }
    }
    schedule() {
      if (this.raf !== 0) return;
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.draw();
      });
    }
    theme() {
      const cs = getComputedStyle(this.canvas);
      const pick = (name, fb) => {
        const raw = cs.getPropertyValue(name).trim();
        return raw !== "" ? raw : fb;
      };
      return {
        faint: pick("--text-faint", "#7e8fa4"),
        mid: pick("--text-mid", "#9db0c5"),
        grid: pick("--border-soft", "rgba(96, 122, 152, 0.16)"),
        border: pick("--border", "#25303f"),
        mono: pick("--font-mono", "Menlo, Consolas, monospace"),
        ui: pick("--font-ui", "system-ui, sans-serif")
      };
    }
    /** 同步 CSS 尺寸与物理像素（devicePixelRatio 适配）；不可见过小则跳过。 */
    syncSize() {
      const rect = this.canvas.getBoundingClientRect();
      const w = Math.floor(rect.width);
      const h = Math.floor(rect.height);
      if (w < 10 || h < 10) return false;
      const dpr = window.devicePixelRatio || 1;
      const bw = Math.round(w * dpr);
      const bh = Math.round(h * dpr);
      if (this.canvas.width !== bw || this.canvas.height !== bh) {
        this.canvas.width = bw;
        this.canvas.height = bh;
      }
      this.cssW = w;
      this.cssH = h;
      this.ctx.setTransform(bw / w, 0, 0, bh / h, 0, 0);
      return true;
    }
    draw() {
      if (!this.syncSize()) return;
      const ctx = this.ctx;
      const th = this.theme();
      const w = this.cssW;
      const h = this.cssH;
      ctx.clearRect(0, 0, w, h);
      const list = this.series.filter((s) => s !== null && Array.isArray(s.samples));
      const axisY = h - AXIS_H;
      const plotL = GUTTER;
      const plotR = w - PAD_R;
      const span = plotR - plotL;
      let tRight = 0;
      for (const s of list) {
        const n = s.samples.length;
        if (n > 0 && s.samples[n - 1].t > tRight) tRight = s.samples[n - 1].t;
      }
      const tLeft = tRight - this.windowMs;
      ctx.strokeStyle = th.grid;
      ctx.lineWidth = 1;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.font = "400 10px " + th.mono;
      ctx.fillStyle = th.mid;
      const step = this.tickStepMs();
      for (let k = Math.floor(this.windowMs / step); k >= 0; k--) {
        const x = Math.round(plotR - k * step * span / this.windowMs) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, axisY);
        ctx.stroke();
        ctx.fillText(k === 0 ? "0" : fmtRel(-k * step), x, axisY + 15);
      }
      ctx.strokeStyle = th.border;
      ctx.beginPath();
      ctx.moveTo(0.5, Math.round(axisY) + 0.5);
      ctx.lineTo(w - 0.5, Math.round(axisY) + 0.5);
      ctx.stroke();
      if (list.length === 0) {
        this.drawEmptyGrid(plotL, plotR, axisY, th);
        this.drawMessage(w / 2, axisY / 2, "暂无曲线数据", "开启信号开关后，曲线将绘制在这里", th);
        return;
      }
      const bandH = axisY / list.length;
      for (let i = 0; i < list.length; i++) {
        this.drawBand(list[i], i, bandH, tLeft, tRight, plotL, plotR, axisY, th);
      }
    }
    tickStepMs() {
      const target = this.windowMs / 6;
      for (const s of TICK_STEPS_MS) if (s >= target) return s;
      return this.windowMs;
    }
    drawEmptyGrid(plotL, plotR, axisY, th) {
      const ctx = this.ctx;
      ctx.strokeStyle = th.grid;
      for (const f of [0.25, 0.5, 0.75]) {
        const y = Math.round(axisY * f) + 0.5;
        ctx.beginPath();
        ctx.moveTo(plotL, y);
        ctx.lineTo(plotR, y);
        ctx.stroke();
      }
    }
    drawMessage(cx, cy, main, sub, th) {
      const ctx = this.ctx;
      ctx.textAlign = "center";
      ctx.fillStyle = th.mid;
      ctx.font = "600 12.5px " + th.ui;
      ctx.fillText(main, cx, cy - 3);
      ctx.fillStyle = th.faint;
      ctx.font = "400 11px " + th.ui;
      ctx.fillText(sub, cx, cy + 14);
    }
    drawBand(s, i, bandH, tLeft, tRight, plotL, plotR, axisY, th) {
      const ctx = this.ctx;
      const top = i * bandH;
      const innerTop = top + STRIP;
      const innerBottom = Math.min(top + bandH - 6, axisY);
      if (innerBottom - innerTop < 6) return;
      const span = plotR - plotL;
      ctx.strokeStyle = th.grid;
      if (i > 0) {
        const y = Math.round(top) + 0.5;
        ctx.beginPath();
        ctx.moveTo(GUTTER - 26, y);
        ctx.lineTo(plotR, y);
        ctx.stroke();
      }
      for (const f of [0.25, 0.5, 0.75]) {
        const y = Math.round(innerTop + f * (innerBottom - innerTop)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(plotL, y);
        ctx.lineTo(plotR, y);
        ctx.stroke();
      }
      const labelY = top + 14;
      ctx.textAlign = "left";
      ctx.font = "600 11px " + th.ui;
      ctx.fillStyle = th.mid;
      ctx.fillText(s.label, plotL + 6, labelY);
      if (s.unit !== "" && bandH >= 30) {
        const nameW = ctx.measureText(s.label).width;
        ctx.font = "400 10px " + th.ui;
        ctx.fillStyle = th.faint;
        ctx.fillText("· " + s.unit, plotL + 6 + nameW + 4, labelY);
      }
      const samples = s.samples;
      let first = samples.length;
      let last = -1;
      for (let j = 0; j < samples.length; j++) {
        const t = samples[j].t;
        if (t < tLeft) continue;
        if (t > tRight) break;
        if (first === samples.length) first = j;
        last = j;
      }
      ctx.textAlign = "right";
      ctx.font = "600 11px " + th.mono;
      if (last < first) {
        ctx.fillStyle = th.faint;
        ctx.fillText("—", plotR - 6, labelY);
        ctx.font = "400 11px " + th.ui;
        ctx.fillText("暂无数据", (plotL + plotR) / 2, (innerTop + innerBottom) / 2 + 4);
        return;
      }
      const latest = samples[last].v;
      ctx.fillStyle = s.color;
      ctx.fillText(fmtVal(latest), plotR - 6, labelY);
      let dLo = Infinity;
      let dHi = -Infinity;
      for (let j = first; j <= last; j++) {
        const v = samples[j].v;
        if (!Number.isFinite(v)) continue;
        if (v < dLo) dLo = v;
        if (v > dHi) dHi = v;
      }
      if (dLo > dHi) return;
      const flat = fmtVal(dHi) === fmtVal(dLo);
      let lo = dLo;
      let hi = dHi;
      if (flat) {
        const mid = (dHi + dLo) / 2;
        const d = Math.max(Math.abs(mid) * 0.05, 1);
        lo = mid - d;
        hi = mid + d;
      } else {
        const pad = (hi - lo) * 0.12;
        lo -= pad;
        hi += pad;
      }
      const yOf = (v) => innerTop + (1 - (v - lo) / (hi - lo)) * (innerBottom - innerTop);
      const xOf = (t) => plotL + (t - tLeft) / this.windowMs * span;
      ctx.textAlign = "right";
      ctx.font = "400 9.5px " + th.mono;
      ctx.fillStyle = th.mid;
      ctx.fillText(fmtVal(flat ? hi : dHi), plotL - 6, innerTop + 8);
      ctx.fillText(fmtVal(flat ? lo : dLo), plotL - 6, innerBottom - 1);
      const cols = [];
      let lastX = -1;
      for (let j = first; j <= last; j++) {
        const smp = samples[j];
        if (!Number.isFinite(smp.v)) continue;
        const x = Math.min(plotR - 1, Math.max(plotL, Math.round(xOf(smp.t))));
        const c = cols.length > 0 && x === lastX ? cols[cols.length - 1] : null;
        if (c === null) {
          cols.push({ tF: smp.t, vF: smp.v, tL: smp.t, vL: smp.v, tLo: smp.t, vLo: smp.v, tHi: smp.t, vHi: smp.v });
          lastX = x;
        } else {
          c.tL = smp.t;
          c.vL = smp.v;
          if (smp.v < c.vLo) {
            c.tLo = smp.t;
            c.vLo = smp.v;
          }
          if (smp.v > c.vHi) {
            c.tHi = smp.t;
            c.vHi = smp.v;
          }
        }
      }
      if (cols.length === 0) return;
      const fillTop = hexToRgba(s.color, 0.22);
      if (fillTop !== null && cols.length > 1) {
        const grad = ctx.createLinearGradient(0, innerTop, 0, innerBottom);
        grad.addColorStop(0, fillTop);
        grad.addColorStop(1, hexToRgba(s.color, 0) ?? fillTop);
        ctx.fillStyle = grad;
        ctx.beginPath();
        this.pathColumns(cols, xOf, yOf);
        ctx.lineTo(xOf(cols[cols.length - 1].tL), innerBottom);
        ctx.lineTo(xOf(cols[0].tF), innerBottom);
        ctx.closePath();
        ctx.fill();
      }
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      this.pathColumns(cols, xOf, yOf);
      ctx.stroke();
      if (cols.length === 1) {
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(xOf(cols[0].tF), yOf(cols[0].vF), 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    /** 依时间顺序把抽稀列连成折线路径（每列至多首/末/最小/最大 4 点）。 */
    pathColumns(cols, xOf, yOf) {
      const ctx = this.ctx;
      const pts = [];
      let started = false;
      for (const c of cols) {
        pts.length = 0;
        pts.push([c.tF, c.vF], [c.tLo, c.vLo], [c.tHi, c.vHi], [c.tL, c.vL]);
        pts.sort((a, b) => a[0] - b[0]);
        let prevT = Number.NaN;
        for (const p of pts) {
          if (p[0] === prevT) continue;
          prevT = p[0];
          const x = xOf(p[0]);
          const y = yOf(p[1]);
          if (started) ctx.lineTo(x, y);
          else {
            ctx.moveTo(x, y);
            started = true;
          }
        }
      }
    }
  };

  // src/dbc-model.ts
  function parseFrameData(frame) {
    if (frame.remote) return new Uint8Array(0);
    const raw = frame.data.trim();
    if (raw.length === 0) return new Uint8Array(0);
    let tokens = raw.split(/\s+/);
    if (tokens.length === 1 && tokens[0].length > 2) {
      const joined = tokens[0];
      const parts = [];
      for (let i = 0; i + 1 < joined.length; i += 2) parts.push(joined.slice(i, i + 2));
      tokens = parts;
    }
    const dlc = Number.isFinite(frame.dlc) ? Math.max(0, Math.trunc(frame.dlc)) : tokens.length;
    const count = Math.min(dlc, tokens.length);
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const b = parseInt(tokens[i], 16);
      out[i] = Number.isFinite(b) && b >= 0 && b <= 255 ? b : 0;
    }
    return out;
  }
  function extractRaw(data, sig) {
    const len = sig.length;
    const start = sig.start_bit;
    if (!Number.isInteger(len) || len < 1 || len > 64) return null;
    if (!Number.isInteger(start) || start < 0) return null;
    const totalBits = data.length * 8;
    if (sig.little_endian) {
      if (start + len > totalBits) return null;
      let raw2 = 0n;
      for (let i = 0; i < len; i++) {
        const abs = start + i;
        const bit = data[abs >> 3] >> (abs & 7) & 1;
        if (bit === 1) raw2 |= 1n << BigInt(i);
      }
      return raw2;
    }
    let raw = 0n;
    let pos = start;
    for (let i = 0; i < len; i++) {
      if (pos < 0 || pos >= totalBits) return null;
      const bit = data[pos >> 3] >> (pos & 7) & 1;
      raw = raw << 1n | BigInt(bit);
      pos = pos % 8 === 0 ? pos + 15 : pos - 1;
    }
    return raw;
  }
  function toSigned(raw, len) {
    const sign = 1n << BigInt(len - 1);
    return raw >= sign ? raw - (sign << 1n) : raw;
  }
  function extractInteger(data, sig) {
    const raw = extractRaw(data, sig);
    if (raw === null) return null;
    return sig.value_kind === "signed" ? toSigned(raw, sig.length) : raw;
  }
  function decodeSignal(data, sig) {
    const raw = extractRaw(data, sig);
    if (raw === null) return null;
    const len = sig.length;
    if (sig.value_kind === "float" || sig.value_kind === "double") {
      const bytes = sig.value_kind === "float" ? 4 : 8;
      if (len !== bytes * 8) return null;
      const view = new DataView(new ArrayBuffer(bytes));
      const factor2 = Number.isFinite(sig.factor) ? sig.factor : 1;
      const offset2 = Number.isFinite(sig.offset) ? sig.offset : 0;
      if (bytes === 4) {
        view.setUint32(0, Number(raw & 0xffffffffn), false);
        return view.getFloat32(0, false) * factor2 + offset2;
      }
      view.setBigUint64(0, raw & 0xffffffffffffffffn, false);
      return view.getFloat64(0, false) * factor2 + offset2;
    }
    const int = sig.value_kind === "signed" ? toSigned(raw, len) : raw;
    const factor = Number.isFinite(sig.factor) ? sig.factor : 1;
    const offset = Number.isFinite(sig.offset) ? sig.offset : 0;
    return Number(int) * factor + offset;
  }
  function decodeMessage(message, data) {
    let hasMux = false;
    let muxValue = null;
    for (const sig of message.signals) {
      if (sig.mux?.is_multiplexer === true) {
        hasMux = true;
        muxValue = extractInteger(data, sig);
        break;
      }
    }
    const out = [];
    for (const sig of message.signals) {
      if (sig.mux !== null && !sig.mux.is_multiplexer) {
        if (!hasMux || muxValue === null || sig.mux.value === null) continue;
        if (BigInt(Math.trunc(sig.mux.value)) !== muxValue) continue;
      }
      const value = decodeSignal(data, sig);
      if (value !== null) out.push({ signal: sig, value });
    }
    return out;
  }
  function signalKey(message, signal) {
    return (message.extended ? "x" : "s") + message.id.toString(16) + ":" + signal.name;
  }

  // src/format.ts
  function errText(err) {
    return err instanceof Error ? err.message : String(err);
  }
  function p2(n) {
    return String(n).padStart(2, "0");
  }
  function fmtInt(n) {
    return Number.isFinite(n) ? Math.trunc(n).toLocaleString("zh-CN") : "—";
  }
  function fmtRate(n) {
    return Number.isFinite(n) ? n.toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 1 }) : "—";
  }
  function fmtBytes(b) {
    if (!Number.isFinite(b) || b < 0) return "—";
    if (b < 1024) return fmtInt(b) + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
    return (b / (1024 * 1024)).toFixed(2) + " MB";
  }
  function fmtClock(ms) {
    const d = new Date(ms);
    return p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds()) + "." + String(d.getMilliseconds()).padStart(3, "0");
  }
  function fmtClockShort(ms) {
    const d = new Date(ms);
    return p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds());
  }
  function fmtDateTime(ms) {
    return Number.isFinite(ms) ? new Date(ms).toLocaleString("zh-CN", { hour12: false }) : "—";
  }
  function fmtDur(ms) {
    const s = Math.max(0, Math.floor(ms / 1e3));
    const h = Math.floor(s / 3600);
    const m = Math.floor(s % 3600 / 60);
    const sec = s % 60;
    return h > 0 ? h + ":" + p2(m) + ":" + p2(sec) : p2(m) + ":" + p2(sec);
  }
  function fmtSignal(v) {
    if (!Number.isFinite(v)) return "—";
    const abs = Math.abs(v);
    if (abs !== 0 && (abs >= 1e6 || abs < 1e-3)) return v.toExponential(2);
    return v.toLocaleString("zh-CN", { maximumFractionDigits: 3 });
  }
  function hexOf(v, width) {
    return "0x" + v.toString(16).toUpperCase().padStart(width, "0");
  }
  function displayChannelName(name) {
    return name.toUpperCase();
  }
  function parseHex(raw, max) {
    const s = raw.trim().toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]+$/.test(s)) return null;
    const v = parseInt(s, 16);
    if (!Number.isSafeInteger(v) || v < 0 || v > max) return null;
    return v;
  }

  // src/state.ts
  var BUFFER_CAP = 5e3;
  var state = {
    status: null,
    devices: [],
    socketcan: [],
    channelKey: null,
    rates: /* @__PURE__ */ new Map(),
    filters: /* @__PURE__ */ new Map(),
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
    filter: ""
  };
  var busy = /* @__PURE__ */ new Set();

  // src/toast.ts
  var lastToast = null;
  var TOAST_ICONS = {
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 7.6v.2"/>',
    success: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.3 2.4 2.4 4.6-5.2"/>',
    warn: '<path d="M12 4.5 21 19.5H3z"/><path d="M12 10v4"/><path d="M12 16.8v.2"/>',
    error: '<circle cx="12" cy="12" r="8.5"/><path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6"/>'
  };
  function buildToastIcon(level) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "15");
    svg.setAttribute("height", "15");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.7");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const parts = TOAST_ICONS[level].match(/<[a-z]+[^>]*>/g) ?? [];
    for (const part of parts) {
      const tag = part.match(/^<([a-z]+)/);
      if (!tag) continue;
      const el = document.createElementNS("http://www.w3.org/2000/svg", tag[1]);
      const attrs = part.match(/[a-z-]+="[^"]*"/g) ?? [];
      for (const attr of attrs) {
        const m = attr.match(/^([a-z-]+)="([^"]*)"$/);
        if (m) el.setAttribute(m[1], m[2]);
      }
      svg.appendChild(el);
    }
    return svg;
  }
  function toast(message, level = "info") {
    const now = Date.now();
    if (lastToast && lastToast.msg === message && now - lastToast.at < 3500) return;
    lastToast = { msg: message, at: now };
    const box = document.createElement("div");
    box.className = "toast " + level;
    const ic = document.createElement("span");
    ic.className = "toast-ic";
    ic.appendChild(buildToastIcon(level));
    const msg = document.createElement("span");
    msg.className = "toast-msg";
    msg.textContent = message;
    const x = document.createElement("button");
    x.type = "button";
    x.className = "toast-x";
    x.setAttribute("aria-label", "关闭提示");
    x.textContent = "×";
    box.append(ic, msg, x);
    els.toasts.appendChild(box);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      box.classList.add("out");
      window.setTimeout(() => box.remove(), 200);
    };
    x.addEventListener("click", close);
    const ttl = level === "error" ? 6500 : level === "warn" ? 5e3 : 3200;
    window.setTimeout(close, ttl);
    while (els.toasts.children.length > 5) {
      const first = els.toasts.firstElementChild;
      if (first) first.remove();
      else break;
    }
  }
  function setLastLog(message) {
    els.lastLogMsg.textContent = fmtClockShort(Date.now()) + " · " + message;
  }

  // src/dbc.ts
  var SAMPLE_CAP = 2e4;
  var MAX_SERIES = 8;
  var DEFAULT_WINDOW_MS = 3e4;
  var MAX_DBC_BYTES = 1024 * 1024;
  var def = null;
  var activeMsg = null;
  var chart = null;
  var rafId = null;
  var series = /* @__PURE__ */ new Map();
  var seriesIndex = /* @__PURE__ */ new Map();
  function msgKey(extended, id) {
    return (extended ? "x" : "s") + id.toString(16);
  }
  function rebuildSeriesIndex() {
    seriesIndex = /* @__PURE__ */ new Map();
    for (const s of series.values()) {
      const key = msgKey(s.message.extended, s.message.id);
      const entry = seriesIndex.get(key) ?? { message: s.message, byKey: /* @__PURE__ */ new Map() };
      entry.byKey.set(signalKey(s.message, s.signal), s);
      seriesIndex.set(key, entry);
    }
  }
  function currentWindowMs() {
    const n = Number(els.dbcWindowSelect.value);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_WINDOW_MS;
  }
  function activeMessage() {
    const active = activeMsg;
    if (!def || !active) return null;
    return def.messages.find((m) => m.id === active.id && m.extended === active.extended) ?? null;
  }
  function mk(tag, cls) {
    const el = document.createElement(tag);
    el.className = cls;
    return el;
  }
  function text(tag, cls, value) {
    const el = mk(tag, cls);
    el.textContent = value;
    return el;
  }
  function scheduleRender() {
    if (rafId !== null) return;
    rafId = window.requestAnimationFrame(() => {
      rafId = null;
      renderChart();
    });
  }
  function renderChart() {
    const out = [];
    for (const [key, s] of series) {
      out.push({ key, label: s.signal.name, unit: s.signal.unit, color: s.color, samples: s.samples });
    }
    if (chart) chart.update(out, currentWindowMs());
    renderLegend();
  }
  function renderLegend() {
    if (series.size === 0) {
      els.signalLegend.replaceChildren();
      return;
    }
    const frag = document.createDocumentFragment();
    for (const s of series.values()) {
      const row = mk("div", "sig-legend");
      const dot = mk("span", "sig-dot");
      dot.style.background = s.color;
      const last = s.samples[s.samples.length - 1];
      const shown = last ? fmtSignal(last.v) + (s.signal.unit ? " " + s.signal.unit : "") : "—";
      row.append(dot, text("span", "sig-legend-name", s.signal.name), text("span", "sig-legend-value", shown));
      frag.appendChild(row);
    }
    els.signalLegend.replaceChildren(frag);
  }
  function renderHeader() {
    const count = def ? def.messages.reduce((n, m) => n + m.signals.length, 0) : 0;
    els.dbcName.textContent = def ? def.name : "未加载 DBC";
    els.dbcSummary.textContent = def ? def.messages.length + " 条报文 · " + count + " 个信号" : "";
    els.btnDbcRemove.disabled = def === null;
    els.dbcEmpty.hidden = def !== null;
    els.dbcBody.hidden = def === null;
  }
  function renderMessageList() {
    if (!def) return void els.dbcMsgList.replaceChildren();
    const sorted = def.messages.slice().sort((a, b) => a.id - b.id || Number(a.extended) - Number(b.extended));
    const frag = document.createDocumentFragment();
    for (const m of sorted) {
      const active = activeMsg !== null && activeMsg.id === m.id && activeMsg.extended === m.extended;
      const btn = mk("button", "dbc-msg");
      btn.type = "button";
      btn.dataset["id"] = String(m.id);
      btn.dataset["extended"] = m.extended ? "1" : "0";
      btn.setAttribute("aria-pressed", String(active));
      if (active) btn.classList.add("is-active");
      btn.append(
        text("span", "dbc-msg-id", hexOf(m.id, m.extended ? 8 : 3)),
        text("span", "dbc-msg-name", m.name),
        text("span", "dbc-msg-count", String(m.signals.length))
      );
      frag.appendChild(btn);
    }
    els.dbcMsgList.replaceChildren(frag);
  }
  function renderSignalBar() {
    const msg = activeMessage();
    if (!msg) return void els.dbcSignalBar.replaceChildren();
    const frag = document.createDocumentFragment();
    for (const sig of msg.signals) {
      const s = series.get(signalKey(msg, sig));
      const btn = mk("button", "sig-chip");
      btn.type = "button";
      btn.dataset["signal"] = sig.name;
      btn.setAttribute("aria-pressed", String(s !== void 0));
      if (s) btn.classList.add("is-on");
      const dot = mk("span", "sig-dot");
      if (s) dot.style.background = s.color;
      btn.append(dot, text("span", "sig-chip-name", sig.name));
      frag.appendChild(btn);
    }
    els.dbcSignalBar.replaceChildren(frag);
  }
  function updateSignalEmpty() {
    const msg = activeMessage();
    let hint = null;
    if (!def) hint = "加载 DBC 后可选择信号并绘制曲线。";
    else if (def.messages.length === 0) hint = "DBC 中没有报文，无法绘制曲线。";
    else if (!activeMsg) hint = "选择左侧报文以查看可绘制的信号。";
    else if (!msg || msg.signals.length === 0) hint = "该报文没有可解码信号。";
    else if (series.size === 0) hint = "点击信号开关，将信号加入曲线。";
    els.signalEmpty.textContent = hint ?? "";
    els.signalEmpty.hidden = hint === null;
  }
  function sameShape(a, b) {
    if (a === null || b === null) return a === b;
    const right = b;
    return a.name === right.name && a.messages.length === right.messages.length && a.messages.every((m, i) => m.signals.length === right.messages[i].signals.length);
  }
  function applyDbc(next) {
    const changed = !sameShape(def, next);
    def = next;
    if (changed) {
      series.clear();
      activeMsg = null;
      rebuildSeriesIndex();
    }
    renderHeader();
    renderMessageList();
    renderSignalBar();
    updateSignalEmpty();
    if (changed) {
      setHint(
        next ? "已加载 " + next.name + "：选择报文与信号后开始绘制。" : "未加载 DBC：点击「加载 DBC」选择 .dbc 文件，信号曲线将在此显示。",
        false
      );
    }
    if (changed) renderChart();
  }
  function pushSample(s, t, v) {
    if (!Number.isFinite(t) || !Number.isFinite(v)) return;
    const last = s.samples[s.samples.length - 1];
    if (last && t < last.t) return;
    s.samples.push({ t, v });
    if (s.samples.length > SAMPLE_CAP + 1024) {
      s.samples.splice(0, s.samples.length - SAMPLE_CAP);
    }
  }
  function backfill(target) {
    const msg = target.message;
    for (const f of state.buffer) {
      if (f.id !== msg.id || f.extended !== msg.extended) continue;
      for (const decoded of decodeMessage(msg, parseFrameData(f))) {
        if (decoded.signal.name === target.signal.name) {
          pushSample(target, f.time_ms, decoded.value);
          break;
        }
      }
    }
  }
  function toggleSignal(sig) {
    const msg = activeMessage();
    if (!msg) return;
    const key = signalKey(msg, sig);
    if (series.has(key)) {
      series.delete(key);
      rebuildSeriesIndex();
    } else if (series.size >= MAX_SERIES) {
      toast("最多同时显示 " + MAX_SERIES + " 个信号曲线", "warn");
      return;
    } else {
      const used = /* @__PURE__ */ new Set();
      for (const s of series.values()) used.add(s.color);
      const color = SERIES_COLORS.find((c) => !used.has(c)) ?? SERIES_COLORS[series.size % SERIES_COLORS.length];
      const item = { message: msg, signal: sig, color, samples: [] };
      series.set(key, item);
      rebuildSeriesIndex();
      backfill(item);
    }
    renderSignalBar();
    updateSignalEmpty();
    scheduleRender();
  }
  function feedDbcFrames(frames) {
    if (frames.length === 0 || seriesIndex.size === 0) return;
    let touched = false;
    for (const f of frames) {
      const entry = seriesIndex.get(msgKey(f.extended, f.id));
      if (!entry) continue;
      for (const d of decodeMessage(entry.message, parseFrameData(f))) {
        const s = entry.byKey.get(signalKey(entry.message, d.signal));
        if (s) pushSample(s, f.time_ms, d.value);
      }
      touched = true;
    }
    if (touched) scheduleRender();
  }
  function seedDbcFrames(frames) {
    for (const s of series.values()) s.samples.length = 0;
    feedDbcFrames(frames);
    scheduleRender();
  }
  function clearDbcSamples() {
    for (const s of series.values()) s.samples.length = 0;
    scheduleRender();
  }
  function setHint(msg, isError) {
    els.dbcHint.textContent = msg;
    els.dbcHint.classList.toggle("is-error", isError);
  }
  function reportError(err) {
    const msg = errText(err);
    setHint(msg, true);
    toast(msg, "error");
  }
  async function loadDbcFile(file) {
    const bad = !file.name.toLowerCase().endsWith(".dbc") ? "仅支持 .dbc 文件：" + file.name : file.size > MAX_DBC_BYTES ? "DBC 文件不能超过 1 MiB（当前 " + file.size + " 字节）" : "";
    if (bad) {
      setHint(bad, true);
      return;
    }
    setHint("正在加载 " + file.name + "…", false);
    try {
      const content = await file.text();
      const res = await api("/api/dbc", "POST", { name: file.name, content });
      const parsed = isObj(res) ? parseDbcDto(res["dbc"]) : null;
      if (!parsed) {
        setHint("服务器返回的 DBC 定义不完整，已忽略", true);
        return;
      }
      applyDbc(parsed);
      setHint("已加载 " + parsed.name + "（" + parsed.messages.length + " 条报文）", false);
      toast("DBC 已加载：" + parsed.name, "success");
    } catch (err) {
      reportError(err);
    }
  }
  async function removeDbc() {
    try {
      await api("/api/dbc", "DELETE");
      applyDbc(null);
      setHint("已移除 DBC 定义", false);
      toast("已移除 DBC", "success");
    } catch (err) {
      reportError(err);
    }
  }
  function onMessageClick(e) {
    const target = e.target;
    const btn = target instanceof Element ? target.closest("button.dbc-msg") : null;
    if (!(btn instanceof HTMLButtonElement)) return;
    const id = Number(btn.dataset["id"]);
    if (!Number.isFinite(id)) return;
    const extended = btn.dataset["extended"] === "1";
    const same = activeMsg !== null && activeMsg.id === id && activeMsg.extended === extended;
    activeMsg = same ? null : { id, extended };
    renderMessageList();
    renderSignalBar();
    updateSignalEmpty();
  }
  function onSignalClick(e) {
    const target = e.target;
    const btn = target instanceof Element ? target.closest("button.sig-chip") : null;
    if (!(btn instanceof HTMLButtonElement)) return;
    const name = btn.dataset["signal"];
    const msg = activeMessage();
    if (!msg || name === void 0) return;
    const sig = msg.signals.find((s) => s.name === name);
    if (sig) toggleSignal(sig);
  }
  function onWindowChange() {
    if (chart) chart.setWindowMs(currentWindowMs());
    renderChart();
  }
  function initDbc() {
    chart = new SignalChart(els.signalChart);
    els.btnDbcLoad.addEventListener("click", () => els.dbcFileInput.click());
    els.dbcFileInput.addEventListener("change", () => {
      const file = els.dbcFileInput.files?.[0] ?? null;
      els.dbcFileInput.value = "";
      if (file) void loadDbcFile(file);
    });
    els.btnDbcRemove.addEventListener("click", () => void removeDbc());
    els.dbcMsgList.addEventListener("click", onMessageClick);
    els.dbcSignalBar.addEventListener("click", onSignalClick);
    els.dbcWindowSelect.addEventListener("change", onWindowChange);
    els.btnChartClear.addEventListener("click", clearDbcSamples);
    chart.setWindowMs(currentWindowMs());
    applyDbc(null);
  }

  // src/filters-model.ts
  function rangeBlock(ranges) {
    if (ranges.length === 0) return null;
    const hasStd = ranges.some((r) => !r.extended);
    const hasExt = ranges.some((r) => r.extended);
    if (hasStd && hasExt) return null;
    let lo = ranges[0].start;
    let hi = ranges[0].end;
    for (const r of ranges) {
      if (r.start < lo) lo = r.start;
      if (r.end > hi) hi = r.end;
    }
    const span = lo ^ hi;
    const blockSize = span === 0 ? 1 : 2 ** (32 - Math.clz32(span));
    const blockStart = lo - lo % blockSize;
    return {
      kind: hasExt ? "扩展" : "标准",
      extended: hasExt,
      blockStart,
      blockEnd: blockStart + blockSize - 1
    };
  }
  function deriveAcceptanceFilter(ranges) {
    const block = rangeBlock(ranges);
    if (block === null) {
      return { acc_code: 0, acc_mask: 4294967295, mode: 0 };
    }
    const shift = block.extended ? 3 : 21;
    const baseMask = block.extended ? 7 : 2097151;
    const blockSize = block.blockEnd - block.blockStart + 1;
    return {
      acc_code: block.blockStart << shift >>> 0,
      acc_mask: (blockSize - 1 << shift | baseMask) >>> 0,
      mode: 1
    };
  }
  function describeHardwareFilter(filter, ranges) {
    if (filter === null) return "未设置";
    const count = ranges.length;
    if (filter.mode === 0 || filter.acc_mask === 4294967295) {
      return count > 0 ? "接收全部（软件精筛 " + count + " 条）" : "接收全部";
    }
    const block = rangeBlock(ranges);
    const derived = deriveAcceptanceFilter(ranges);
    const matches = block !== null && filter.mode === derived.mode && filter.acc_code === derived.acc_code && filter.acc_mask === derived.acc_mask;
    if (!matches) return "自定义";
    const width = block.extended ? 8 : 3;
    const range = block.blockStart === block.blockEnd ? hexOf(block.blockStart, width) : hexOf(block.blockStart, width) + "–" + hexOf(block.blockEnd, width);
    return block.kind + " " + range + "（单滤波器）";
  }

  // src/filters.ts
  var MAX_RANGE_ROWS = 16;
  var rangeRowsChangedHandler = null;
  function setRangeRowsChangedHandler(fn) {
    rangeRowsChangedHandler = fn;
  }
  function notifyRangeRowsChanged() {
    if (rangeRowsChangedHandler !== null) rangeRowsChangedHandler();
  }
  function rangeRowCount() {
    return els.filterRangeList.querySelectorAll(".filter-row").length;
  }
  var rangeRowSeq = 0;
  function buildRangeRow(ext, start, end) {
    const src = filterTplRow;
    const row = src ? src.cloneNode(true) : document.createElement("div");
    const groupName = "f-ext-" + ++rangeRowSeq;
    for (const radio of row.querySelectorAll('input[type="radio"]')) {
      radio.name = groupName;
      if (radio.value === (ext ? "ext" : "std")) radio.checked = true;
    }
    const startIn = q(row, ".f-start");
    startIn.value = start !== void 0 ? start.toString(16).toUpperCase() : "100";
    const endIn = q(row, ".f-end");
    endIn.value = end !== void 0 ? end.toString(16).toUpperCase() : "7FF";
    q(row, ".f-del").addEventListener("click", () => {
      row.remove();
      notifyRangeRowsChanged();
    });
    return row;
  }
  function rangeRowExtended(row) {
    return q(row, 'input[type="radio"][value="ext"]').checked;
  }
  function channelKey(ch) {
    return ch.source === "usb" ? "usb:" + ch.index : "scan:" + ch.name;
  }
  function collectRanges() {
    const rows = Array.from(els.filterRangeList.querySelectorAll(".filter-row"));
    if (rows.length > MAX_RANGE_ROWS) {
      toast("ID 区间最多 " + MAX_RANGE_ROWS + " 条", "warn");
      return null;
    }
    const ranges = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const ext = rangeRowExtended(row);
      const maxId = ext ? 536870911 : 2047;
      const startIn = q(row, ".f-start");
      const endIn = q(row, ".f-end");
      const start = parseHex(startIn.value, maxId);
      const end = parseHex(endIn.value, maxId);
      const scope = ext ? "扩展帧最大 1FFFFFFF" : "标准帧最大 7FF";
      if (start === null) {
        toast("第 " + (i + 1) + " 条区间：起始 ID 无效（" + scope + "）", "warn");
        startIn.focus();
        return null;
      }
      if (end === null) {
        toast("第 " + (i + 1) + " 条区间：结束 ID 无效（" + scope + "）", "warn");
        endIn.focus();
        return null;
      }
      if (start > end) {
        toast("第 " + (i + 1) + " 条区间：起始 ID 不能大于结束 ID", "warn");
        startIn.focus();
        return null;
      }
      ranges.push({ extended: ext, start, end });
    }
    return ranges;
  }
  function saveCurrentRanges() {
    const ranges = collectRanges();
    if (ranges === null) return null;
    if (state.channelKey !== null) state.filters.set(state.channelKey, ranges);
    return ranges;
  }
  var renderedKey = void 0;
  function renderRangesFor(key) {
    const ranges = key !== null ? state.filters.get(key) ?? [] : [];
    const frag = document.createDocumentFragment();
    for (const f of ranges) {
      frag.appendChild(buildRangeRow(f.extended, f.start, f.end));
    }
    els.filterRangeList.replaceChildren(frag);
    renderedKey = key;
    notifyRangeRowsChanged();
  }
  function syncFilters(st) {
    for (const ch of st.channels) {
      const key = channelKey(ch);
      if (!state.filters.has(key)) {
        state.filters.set(key, ch.software_filters.map((f) => ({ ...f })));
      }
    }
    if (renderedKey !== state.channelKey) {
      renderRangesFor(state.channelKey);
    }
  }
  function renderHwPrefilter(st) {
    if (state.channelKey === null) {
      els.hwFilterState.textContent = "—";
      return;
    }
    const key = state.channelKey;
    if (key.startsWith("scan:")) {
      els.hwFilterState.textContent = "仅软件滤波（无硬件验收）";
      return;
    }
    const ch = st.channels.find((item) => channelKey(item) === key) ?? null;
    if (ch === null) {
      els.hwFilterState.textContent = "—";
      return;
    }
    const ranges = state.filters.get(key) ?? [];
    els.hwFilterState.textContent = describeHardwareFilter(ch.filter, ranges);
  }
  function acceptAllRanges() {
    if (rangeRowCount() === 0) {
      toast("区间列表已为空：当前通道即接收全部帧", "info");
      return;
    }
    els.filterRangeList.replaceChildren();
    if (state.channelKey !== null) state.filters.set(state.channelKey, []);
    notifyRangeRowsChanged();
    toast("已清空当前通道的全部区间：点击「实时应用滤波」后接收全部帧", "info");
  }
  function addRangeRow() {
    const count = rangeRowCount();
    if (count >= MAX_RANGE_ROWS) {
      toast("ID 区间最多 " + MAX_RANGE_ROWS + " 条，请先删除不需要的行", "warn");
      return;
    }
    els.filterRangeList.appendChild(buildRangeRow(false));
    notifyRangeRowsChanged();
    if (count + 1 === MAX_RANGE_ROWS) {
      toast("已达 " + MAX_RANGE_ROWS + " 条区间上限", "info");
    }
  }
  async function applyFiltersLive(applyStatus2) {
    const st = state.status;
    const key = state.channelKey;
    if (st === null || key === null) {
      toast("请先选择一个通道", "warn");
      return;
    }
    const target = st.channels.find((ch) => channelKey(ch) === key) ?? null;
    if (target === null) {
      toast("选中的通道未注册，请先启动该通道", "warn");
      return;
    }
    if (!target.running) {
      toast("选中的通道未运行，请先启动该通道", "warn");
      return;
    }
    const ranges = saveCurrentRanges();
    if (ranges === null) return;
    const update = { channel: target.index, software_filters: ranges };
    if (target.source === "usb") update.filter = deriveAcceptanceFilter(ranges);
    const status = await updateFilters({ channels: [update] });
    if (status) applyStatus2(status);
    toast("滤波已实时更新：" + displayChannelName(target.name) + "（通道未停止）", "success");
    setLastLog("滤波已实时更新：" + displayChannelName(target.name));
  }

  // src/channels.ts
  function channelOptions(st) {
    const options = [];
    const seen = /* @__PURE__ */ new Set();
    for (const ch of st?.channels ?? []) {
      const key = channelKey(ch);
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({
        key,
        label: (ch.source === "usb" ? "USB · " : "SOCKET · ") + displayChannelName(ch.name),
        channel: ch,
        link: null
      });
    }
    for (const link of state.socketcan) {
      const key = "scan:" + link.name;
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({ key, label: "SOCKET · " + displayChannelName(link.name), channel: null, link });
    }
    return options;
  }
  function optionForKey(st, key) {
    return channelOptions(st).find((option) => option.key === key) ?? null;
  }
  function selectedChannel(st) {
    if (st === null || state.channelKey === null) return null;
    const key = state.channelKey;
    return st.channels.find((ch) => channelKey(ch) === key) ?? null;
  }
  function ensureChannel(st) {
    const options = channelOptions(st);
    const keys = options.map((option) => option.key);
    if (state.channelKey !== null && keys.includes(state.channelKey)) return false;
    if (st === null) {
      if (state.channelKey === null) return false;
      state.channelKey = null;
      return true;
    }
    const running = st.channels.find((ch) => ch.running) ?? null;
    const next = running !== null ? channelKey(running) : keys.includes("usb:0") ? "usb:0" : options[0]?.key ?? null;
    if (next === state.channelKey) return false;
    state.channelKey = next;
    return true;
  }
  function labelFromBitrate(bitrate) {
    if (bitrate === null || !Number.isFinite(bitrate) || bitrate <= 0) return "500k";
    const label = Math.round(bitrate / 1e3) + "k";
    return BAUDS.includes(label) ? label : "500k";
  }
  function bitrateFromLabel(label) {
    const match = /^(\d+)k$/.exec(label);
    const bps = match ? Number(match[1]) * 1e3 : NaN;
    return Number.isFinite(bps) && bps >= 1e3 && bps <= 1e6 ? bps : 5e5;
  }
  function ensureRate(st, key) {
    const existing = state.rates.get(key);
    if (existing !== void 0) return existing;
    const option = optionForKey(st, key);
    const ch = option?.channel ?? null;
    let label = "500k";
    if (ch !== null) {
      label = ch.source === "usb" ? asBaud(ch.baud) ?? "500k" : labelFromBitrate(ch.bitrate);
    } else if (option?.link) {
      label = labelFromBitrate(option.link.bitrate);
    }
    state.rates.set(key, label);
    return label;
  }
  var optionsSignature = null;
  function renderChannelOptions(st) {
    const options = channelOptions(st);
    const signature = options.map((option) => option.key + "|" + option.label).join(",");
    if (signature !== optionsSignature) {
      optionsSignature = signature;
      const frag = document.createDocumentFragment();
      for (const option of options) {
        const el = document.createElement("option");
        el.value = option.key;
        el.textContent = option.label;
        frag.appendChild(el);
      }
      els.channelSelect.replaceChildren(frag);
    }
    els.channelSelect.value = state.channelKey ?? "";
  }
  function buildRateOptions() {
    if (els.channelRate.options.length > 0) return;
    const frag = document.createDocumentFragment();
    for (const label of BAUDS) {
      const option = document.createElement("option");
      option.value = label;
      option.textContent = label.slice(0, -1) + " kbps";
      frag.appendChild(option);
    }
    els.channelRate.replaceChildren(frag);
  }
  function renderChannelRate(st) {
    buildRateOptions();
    if (state.channelKey === null) {
      els.channelRate.disabled = true;
      return;
    }
    els.channelRate.disabled = false;
    els.channelRate.value = ensureRate(st, state.channelKey);
  }
  function statusRate(st, key, option) {
    const ch = option?.channel ?? null;
    if (ch !== null) {
      if (ch.source === "usb") return asBaud(ch.baud) ?? ensureRate(st, key);
      return ch.bitrate !== null ? labelFromBitrate(ch.bitrate) : ensureRate(st, key);
    }
    if (option?.link && option.link.bitrate !== null) return labelFromBitrate(option.link.bitrate);
    return ensureRate(st, key);
  }
  function renderChannelState(st) {
    const key = state.channelKey;
    if (key === null) {
      els.channelState.textContent = "未选择通道";
      els.channelState.classList.remove("running");
      return;
    }
    const option = optionForKey(st, key);
    const ch = option?.channel ?? null;
    const link = option?.link ?? null;
    const running = ch !== null ? ch.running : link !== null && link.running;
    els.channelState.classList.toggle("running", running);
    if (running) {
      els.channelState.textContent = "运行中 · " + statusRate(st, key, option);
      return;
    }
    const ifaceState = ch !== null && ch.source === "socketcan" ? ch.state : link?.state ?? null;
    const isSocket = ch !== null ? ch.source === "socketcan" : link !== null;
    els.channelState.textContent = isSocket && ifaceState !== "up" ? "未启用" : "已停止";
  }
  function renderModeField(st) {
    const key = state.channelKey;
    const isUsb = key !== null && key.startsWith("usb:");
    els.modeField.hidden = !isUsb;
    if (!isUsb || key === null) return;
    const ch = optionForKey(st, key)?.channel ?? null;
    if (ch === null || !ch.running || ch.mode === null) return;
    const radio = document.querySelector(
      'input[name="mode"][value="' + ch.mode + '"]'
    );
    if (radio) radio.checked = true;
  }
  function selectedMode() {
    const checked = document.querySelector('input[name="mode"]:checked');
    return checked ? asMode(checked.value) ?? "normal" : "normal";
  }
  function syncChannels(st) {
    ensureChannel(st);
    syncFilters(st);
    renderChannelOptions(st);
    if (state.channelKey !== null) ensureRate(st, state.channelKey);
    renderChannelRate(st);
    renderChannelState(st);
    renderModeField(st);
    renderHwPrefilter(st);
  }
  function initChannelPanel() {
    const st = state.status;
    if (st !== null) {
      syncChannels(st);
      return;
    }
    ensureChannel(null);
    renderChannelOptions(null);
    renderChannelRate(null);
    renderChannelState(null);
    renderModeField(null);
    renderRangesFor(null);
  }
  function refreshChannelOptions() {
    const st = state.status;
    if (st !== null) {
      syncChannels(st);
      return;
    }
    renderChannelOptions(null);
  }
  function selectChannel(key) {
    if (key === state.channelKey) return;
    const st = state.status;
    if (optionForKey(st, key) === null) {
      els.channelSelect.value = state.channelKey ?? "";
      return;
    }
    const ranges = saveCurrentRanges();
    if (ranges === null) {
      els.channelSelect.value = state.channelKey ?? "";
      return;
    }
    state.channelKey = key;
    ensureRate(st, key);
    renderChannelOptions(st);
    renderChannelRate(st);
    renderChannelState(st);
    renderModeField(st);
    renderRangesFor(key);
    if (st !== null) renderHwPrefilter(st);
  }
  function setChannelRate(label) {
    if (state.channelKey === null) return;
    state.rates.set(state.channelKey, asBaud(label) ?? "500k");
  }
  async function startChannel(applyStatus2) {
    const st = state.status;
    const key = state.channelKey;
    if (key === null) {
      toast("请先选择一个通道", "warn");
      return;
    }
    const option = optionForKey(st, key);
    if (option === null) {
      toast("选中的通道不可用，请刷新设备与链路", "warn");
      return;
    }
    const ranges = saveCurrentRanges();
    if (ranges === null) return;
    const rate = ensureRate(st, key);
    if (key.startsWith("usb:")) {
      const index = Number(key.slice(4));
      if (index !== 0 && index !== 1) {
        toast("USB 通道编号无效", "warn");
        return;
      }
      if (st?.device.open !== true) {
        const first = state.devices[0];
        if (!first) {
          toast("未检测到 USBCAN 设备", "error");
          return;
        }
        const opened = await openDevice(first.index);
        if (opened) applyStatus2(opened);
      }
      const status2 = await applyConfig({
        usb: [
          {
            index,
            baud: asBaud(rate) ?? "500k",
            filter: deriveAcceptanceFilter(ranges),
            software_filters: ranges
          }
        ],
        socketcan: [],
        mode: selectedMode()
      });
      if (status2) applyStatus2(status2);
      toast("已启动 " + option.label, "success");
      return;
    }
    const name = key.startsWith("scan:") ? key.slice(5) : "";
    if (name.length === 0) {
      toast("链路名称无效", "warn");
      return;
    }
    const status = await applyConfig({
      usb: [],
      socketcan: [{ name, bitrate: bitrateFromLabel(rate), software_filters: ranges }],
      mode: "normal"
    });
    if (status) applyStatus2(status);
    toast("已启动 " + option.label, "success");
  }
  async function stopChannel(applyStatus2) {
    const ch = selectedChannel(state.status);
    if (ch === null || !ch.running) {
      toast("当前通道未运行", "warn");
      return;
    }
    const status = await stopChannels([ch.index]);
    if (status) applyStatus2(status);
    toast("已停止 " + displayChannelName(ch.name), "success");
  }

  // src/send.ts
  var sendChannelSignature = null;
  function sendExtended() {
    const selected = document.querySelector('input[name="send-ext"]:checked');
    return selected !== null && selected.value === "ext";
  }
  function parseSendData(raw) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return [];
    const tokens = trimmed.split(/[\s,:]+/).filter((token) => token.length > 0);
    if (tokens.length > 1) {
      const bytes2 = [];
      for (const token of tokens) {
        const cleaned2 = token.replace(/^0x/i, "");
        if (!/^[0-9a-f]{1,2}$/i.test(cleaned2)) return null;
        bytes2.push(parseInt(cleaned2, 16));
      }
      return bytes2.length <= 8 ? bytes2 : null;
    }
    const cleaned = trimmed.replace(/^0x/i, "");
    if (cleaned.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(cleaned)) return null;
    const bytes = [];
    for (let index = 0; index < cleaned.length; index += 2) {
      bytes.push(parseInt(cleaned.slice(index, index + 2), 16));
    }
    return bytes.length <= 8 ? bytes : null;
  }
  function channelLabel(channel) {
    return displayChannelName(channel.name) + (channel.mode === "listen_only" ? "（只听）" : "");
  }
  function syncSendChannels(st) {
    const running = st.channels.filter((channel) => channel.running);
    const signature = running.map((channel) => channel.index + ":" + channel.name + ":" + (channel.mode ?? "")).join(",");
    if (signature === sendChannelSignature) return;
    sendChannelSignature = signature;
    const previous = els.sendChannel.value;
    if (running.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "无通道";
      option.disabled = true;
      option.selected = true;
      els.sendChannel.replaceChildren(option);
      return;
    }
    const options = running.map((channel) => {
      const option = document.createElement("option");
      option.value = String(channel.index);
      option.textContent = channelLabel(channel);
      option.disabled = channel.mode === "listen_only";
      return option;
    });
    els.sendChannel.replaceChildren(...options);
    const sendable = running.filter((channel) => channel.mode !== "listen_only");
    let selected = sendable[0]?.index ?? running[0].index;
    if (previous !== "" && sendable.some((channel) => channel.index === Number(previous))) {
      selected = Number(previous);
    }
    els.sendChannel.value = String(selected);
  }
  function updateSendDlc() {
    const remote = els.sendRemote.checked;
    els.sendData.disabled = remote;
    els.sendDlc.readOnly = !remote;
    if (remote) {
      if (els.sendDlc.value === "") els.sendDlc.value = "0";
    } else {
      const bytes = parseSendData(els.sendData.value);
      els.sendDlc.value = bytes === null ? "" : String(bytes.length);
    }
  }
  function updateSendControls() {
    const st = state.status;
    const channelValue = els.sendChannel.value;
    const channel = channelValue === "" ? null : Number(channelValue);
    const running = channel === null ? null : st?.channels.find((item) => item.index === channel && item.running) ?? null;
    const extended = sendExtended();
    const id = parseHex(els.sendId.value, extended ? 536870911 : 2047);
    const remote = els.sendRemote.checked;
    const bytes = remote ? [] : parseSendData(els.sendData.value);
    const dlc = remote ? Number(els.sendDlc.value) : bytes?.length ?? 0;
    let reason = "";
    if (running === null) reason = "请先在左侧选择并启动通道";
    else if (running.mode === "listen_only") reason = "只听模式不可发送";
    else if (id === null) reason = "ID 无效或超出范围";
    else if (bytes === null) reason = "数据必须是 1–8 个十六进制字节";
    else if (remote && (!Number.isInteger(dlc) || dlc < 0 || dlc > 8)) reason = "DLC 必须在 0–8";
    els.btnSend.disabled = reason !== "";
    els.sendHint.textContent = reason === "" ? remote ? "远程帧不携带数据；DLC 可设 0–8；回车发送。" : "数据支持 11 22 33 / 112233 / 0x11,0x22；回车发送。" : reason;
    els.sendHint.classList.toggle("error", reason !== "" && running !== null);
  }
  async function sendCurrentFrame(applyStatus2) {
    const channelValue = els.sendChannel.value;
    if (channelValue === "") {
      toast("没有可用的发送通道", "warn");
      return;
    }
    const channel = Number(channelValue);
    const extended = sendExtended();
    const id = parseHex(els.sendId.value, extended ? 536870911 : 2047);
    if (id === null) {
      toast("发送 ID 无效或超出范围", "warn");
      els.sendId.focus();
      return;
    }
    const remote = els.sendRemote.checked;
    const bytes = remote ? [] : parseSendData(els.sendData.value);
    if (bytes === null) {
      toast("发送数据格式无效", "warn");
      els.sendData.focus();
      return;
    }
    const dlc = remote ? Number(els.sendDlc.value) : bytes.length;
    if (remote && (!Number.isInteger(dlc) || dlc < 0 || dlc > 8)) {
      toast("远程帧 DLC 必须在 0–8", "warn");
      els.sendDlc.focus();
      return;
    }
    const body = {
      channel,
      id,
      extended,
      remote,
      dlc,
      data: bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ")
    };
    const status = await sendFrame(body);
    if (status) applyStatus2(status);
    const channelInfo = state.status?.channels.find((item) => item.index === channel) ?? null;
    const channelName = channelInfo ? displayChannelName(channelInfo.name) : "CH" + (channel + 1);
    const label = channelName + " 0x" + id.toString(16).toUpperCase();
    const detail = remote ? "远程帧 DLC " + dlc : bytes.length + " 字节";
    toast("已发送 " + label + " （" + detail + "）", "success");
    setLastLog("已发送 " + label + " （" + detail + "）");
  }

  // src/status.ts
  function applyStatus(st) {
    state.status = st;
    const info = st.device.info;
    if (st.device.open && info) {
      els.devicePillDot.className = "pill-dot ok";
      let pillText;
      if (info.serial) {
        pillText = [info.hw_type, "S/N " + info.serial].filter((s) => s.length > 0).join(" · ");
      } else {
        pillText = ["已连接", info.hw_type].filter((s) => s.length > 0).join(" · ");
      }
      els.devicePillText.textContent = pillText || "设备已连接";
    } else {
      els.devicePillDot.className = "pill-dot";
      els.devicePillText.textContent = "未连接设备";
    }
    syncChannels(st);
    els.recActive.hidden = !st.recording.active;
    els.recPill.hidden = !st.recording.active;
    if (st.recording.active) {
      els.recActiveFile.textContent = st.recording.file ?? "—";
      els.recActiveFrames.textContent = fmtInt(st.recording.frames ?? 0);
      if (st.recording.started_at_ms !== null) {
        els.recActiveElapsed.textContent = fmtDur(Date.now() - st.recording.started_at_ms);
      }
    }
    els.dataDirLabel.textContent = st.server.data_dir || "—";
    els.statRx.textContent = fmtInt(st.stats.rx_frames);
    els.statRate.textContent = fmtRate(st.stats.rx_rate);
    els.statFiltered.textContent = fmtInt(st.stats.filtered_frames);
    els.statRecorded.textContent = fmtInt(st.stats.recorded_frames);
    els.sendCount.textContent = fmtInt(st.stats.tx_frames);
    syncSendChannels(st);
    if (st.server.version) els.versionLabel.textContent = "v" + st.server.version;
    updateControls();
    updateEmpty();
  }
  function updateControls() {
    const st = state.status;
    const anyRunning = st !== null && st.channels.some((c) => c.running);
    const recActive = st !== null && st.recording.active;
    const target = selectedChannel(st);
    const targetRunning = target !== null && target.running;
    const hasChannel = state.channelKey !== null;
    els.btnChannelStart.disabled = !hasChannel;
    els.btnChannelStop.disabled = !targetRunning;
    els.btnApplyFilters.disabled = !targetRunning;
    els.btnAcceptAll.disabled = !hasChannel;
    els.btnRecStart.disabled = !anyRunning || recActive;
    els.btnRecStop.disabled = !recActive;
    els.btnPauseView.disabled = !anyRunning;
    const rangeCount = rangeRowCount();
    els.btnAddFilter.disabled = !hasChannel || rangeCount >= MAX_RANGE_ROWS;
    els.filterEmpty.hidden = rangeCount > 0;
    for (const b of busy) b.disabled = true;
    updateSendControls();
  }
  function updateStrip() {
    els.visibleCount.textContent = "显示 " + fmtInt(els.framesBody.rows.length) + " 行";
    els.bufferUsage.textContent = "缓冲 " + fmtInt(state.buffer.length) + " / " + fmtInt(BUFFER_CAP);
  }
  function updateEmpty() {
    const hasRows = els.framesBody.rows.length > 0;
    els.frameEmpty.hidden = hasRows;
    if (hasRows) return;
    const st = state.status;
    const running = st !== null && st.channels.some((c) => c.running);
    if (state.buffer.length > 0 && state.filter) {
      els.emptyTitle.textContent = "没有匹配的报文";
      els.emptyHint.textContent = "当前过滤条件未匹配任何报文，试着调整或清空过滤输入。";
    } else if (running) {
      els.emptyTitle.textContent = "等待 CAN 报文";
      els.emptyHint.textContent = "通道已启动，尚未收到报文；请确认总线波特率一致、滤波器未全部滤除。";
    } else {
      els.emptyTitle.textContent = "通道未启动";
      els.emptyHint.textContent = "选择通道与速率，然后点击「启动通道」。";
    }
  }
  async function runBusy(btn, fn) {
    if (btn.disabled || busy.has(btn)) return;
    busy.add(btn);
    btn.disabled = true;
    btn.classList.add("busy");
    btn.setAttribute("aria-busy", "true");
    try {
      await fn();
    } catch (err) {
      toast(errText(err), "error");
    } finally {
      busy.delete(btn);
      btn.classList.remove("busy");
      btn.removeAttribute("aria-busy");
      btn.disabled = false;
      updateControls();
    }
  }
  async function loadStatus() {
    try {
      const st = await fetchStatus();
      if (!st) throw new Error("状态响应格式异常");
      applyStatus(st);
    } catch (err) {
      toast(errText(err), "error");
    }
  }
  async function loadHealth() {
    try {
      const version = await fetchHealthVersion();
      if (version !== null && !state.status) {
        els.versionLabel.textContent = "v" + version;
      }
    } catch (err) {
      toast(errText(err), "error");
    }
  }

  // src/devices.ts
  async function loadDevices() {
    try {
      const res = await fetchDevices();
      state.devices = res.devices;
      state.socketcan = res.socketcan;
      state.selectedDevice = state.devices.length > 0 ? state.devices[0].index : null;
      refreshChannelOptions();
      updateControls();
    } catch (err) {
      toast(errText(err), "error");
    }
  }

  // src/recordings.ts
  function buildRecRow(rec) {
    const src = recTplRow;
    const row = src ? src.cloneNode(true) : document.createElement("tr");
    const name = q(row, ".r-name");
    name.textContent = rec.name;
    q(row, ".r-size").textContent = fmtBytes(rec.size);
    q(row, ".r-time").textContent = fmtDateTime(rec.modified_ms);
    const link = q(row, "a.btn");
    link.href = "/api/recordings/" + encodeURIComponent(rec.name);
    link.setAttribute("download", rec.name);
    const del = q(row, "button.btn-danger");
    del.addEventListener("click", () => {
      void deleteRecording(rec.name, del);
    });
    return row;
  }
  function renderRecordings() {
    const frag = document.createDocumentFragment();
    for (const rec of state.recordings) {
      if (rec.name) frag.appendChild(buildRecRow(rec));
    }
    els.recordingsList.replaceChildren(frag);
    els.recordingsEmpty.hidden = state.recordings.length > 0;
    els.recordingsCount.textContent = fmtInt(state.recordings.length);
  }
  async function loadRecordings() {
    try {
      const list = await fetchRecordings();
      list.sort((a, b) => b.modified_ms - a.modified_ms);
      state.recordings = list;
      renderRecordings();
    } catch (err) {
      toast(errText(err), "error");
    }
  }
  async function deleteRecording(name, btn) {
    if (!window.confirm("删除录制文件「" + name + "」？此操作不可恢复。")) return;
    await runBusy(btn, async () => {
      await deleteRecordingFile(name);
      toast("已删除 " + name, "success");
      await loadRecordings();
    });
  }

  // src/frames.ts
  function acceptFrames(frames) {
    if (frames.length === 0) return;
    feedDbcFrames(frames);
    for (const f of frames) state.buffer.push(f);
    if (state.buffer.length > BUFFER_CAP) {
      state.buffer.splice(0, state.buffer.length - BUFFER_CAP);
    }
    if (state.paused) {
      state.pausedHidden += frames.length;
      els.pausedCount.textContent = fmtInt(state.pausedHidden);
      updateStrip();
      return;
    }
    for (const f of frames) state.pending.push(f);
    scheduleFlush();
  }
  var flushReq = false;
  function scheduleFlush() {
    if (flushReq) return;
    flushReq = true;
    window.requestAnimationFrame(() => {
      flushReq = false;
      flushRows();
    });
  }
  function flushRows() {
    const batch = state.pending;
    state.pending = [];
    if (batch.length === 0) {
      updateStrip();
      return;
    }
    const frag = document.createDocumentFragment();
    for (const f of batch) {
      if (matchesFilter(f)) frag.appendChild(buildRow(f));
    }
    if (frag.childNodes.length > 0) els.framesBody.appendChild(frag);
    trimRows();
    updateEmpty();
    updateStrip();
    maybeScroll();
  }
  function buildRow(f) {
    const src = rowTplRow;
    const row = src ? src.cloneNode(true) : document.createElement("tr");
    row.cells[0].textContent = fmtInt(f.seq);
    row.cells[1].textContent = fmtClock(f.time_ms);
    const badge = document.createElement("span");
    const info = state.status?.channels.find((item) => item.index === f.channel) ?? null;
    if (info !== null && info.source === "socketcan") badge.className = "ch-badge ch-scan";
    else if (f.channel === 0 || f.channel === 1) badge.className = "ch-badge ch" + f.channel;
    else badge.className = "ch-badge chx";
    badge.textContent = info !== null ? displayChannelName(info.name) : f.channel === 0 ? "CAN1" : f.channel === 1 ? "CAN2" : "CH" + (f.channel + 1);
    row.cells[2].appendChild(badge);
    row.cells[3].textContent = hexOf(f.id, f.extended ? 8 : 3);
    const baseType = f.extended ? "扩展" : "标准";
    row.cells[4].textContent = f.remote ? baseType + "·远程" : baseType;
    row.cells[5].textContent = String(f.dlc);
    row.cells[6].textContent = f.data.length > 0 ? f.data : "—";
    if (f.remote) row.classList.add("remote");
    return row;
  }
  function matchesFilter(f) {
    const query = state.filter;
    if (!query) return true;
    const baseType = f.extended ? "扩展" : "标准";
    const info = state.status?.channels.find((item) => item.index === f.channel) ?? null;
    const hay = [
      f.id.toString(16),
      String(f.seq),
      String(f.channel),
      String(f.channel + 1),
      "can" + f.channel,
      info ? displayChannelName(info.name) : "",
      f.data,
      baseType,
      f.remote ? "远程" : ""
    ].join(" ").toLowerCase();
    return hay.includes(query);
  }
  function rebuildTable() {
    const frag = document.createDocumentFragment();
    for (const f of state.buffer) {
      if (matchesFilter(f)) frag.appendChild(buildRow(f));
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
  var scrollScheduled = false;
  function maybeScroll() {
    if (!state.autoscroll || state.paused || scrollScheduled) return;
    scrollScheduled = true;
    window.requestAnimationFrame(() => {
      scrollScheduled = false;
      if (state.autoscroll && !state.paused) {
        els.tableWrap.scrollTop = els.tableWrap.scrollHeight;
      }
    });
  }
  function clearLocalFrames() {
    state.buffer.length = 0;
    state.pending.length = 0;
    state.pausedHidden = 0;
    els.pausedCount.textContent = "0";
    clearDbcSamples();
    rebuildTable();
  }
  function setAutoscroll(on) {
    state.autoscroll = on;
    els.autoscrollCheck.checked = on;
    if (on) maybeScroll();
  }
  function setPaused(p) {
    if (state.paused === p) return;
    state.paused = p;
    els.btnPauseView.setAttribute("aria-pressed", String(p));
    els.btnPauseLabel.textContent = p ? "继续显示" : "暂停显示";
    els.icPause.hidden = p;
    els.icPlay.hidden = !p;
    els.autoscrollCheck.disabled = p;
    if (p) {
      els.pausedCount.textContent = fmtInt(state.pausedHidden);
      els.pausedBadge.hidden = false;
    } else {
      state.pausedHidden = 0;
      els.pausedCount.textContent = "0";
      els.pausedBadge.hidden = true;
      rebuildTable();
    }
  }

  // src/ws.ts
  function setWsUi(s) {
    els.wsDot.className = "pill-dot";
    if (s === "online") {
      els.wsDot.classList.add("ok");
      els.wsText.textContent = "服务在线";
    } else if (s === "connecting") {
      els.wsDot.classList.add("warn");
      els.wsText.textContent = "服务重连中";
    } else {
      els.wsDot.classList.add("err");
      els.wsText.textContent = "服务离线";
    }
  }
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
      } catch {
      }
    }
    setWsUi("connecting");
    let ws;
    try {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(proto + "//" + location.host + "/ws");
    } catch {
      scheduleReconnect();
      return;
    }
    state.ws = ws;
    let pingTimer = null;
    ws.onopen = () => {
      if (state.ws !== ws) return;
      state.wsAttempt = 0;
      setWsUi("online");
      if (pingTimer === null) {
        pingTimer = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send("ping");
        }, 25e3);
      }
    };
    ws.onmessage = (ev) => {
      if (state.ws !== ws) return;
      if (typeof ev.data !== "string") return;
      handleWsText(ev.data);
    };
    ws.onclose = () => {
      if (pingTimer !== null) {
        window.clearInterval(pingTimer);
        pingTimer = null;
      }
      if (state.ws !== ws) return;
      state.ws = null;
      setWsUi("offline");
      scheduleReconnect();
    };
    ws.onerror = () => {
    };
  }
  function scheduleReconnect() {
    if (state.wsTimer !== null) return;
    const delay = Math.min(500 * Math.pow(2, state.wsAttempt), 5e3);
    state.wsAttempt++;
    state.wsTimer = window.setTimeout(() => {
      state.wsTimer = null;
      connectWs();
    }, delay);
  }
  function handleWsText(text2) {
    let raw;
    try {
      raw = JSON.parse(text2);
    } catch {
      return;
    }
    const msg = parseWsMessage(raw);
    if (msg === null) return;
    switch (msg.type) {
      case "snapshot":
        applyStatus(msg.status);
        state.buffer = msg.frames.slice(-BUFFER_CAP);
        state.pending.length = 0;
        state.pausedHidden = 0;
        els.pausedCount.textContent = "0";
        applyDbc(msg.dbc);
        seedDbcFrames(msg.frames);
        rebuildTable();
        break;
      case "frames":
        acceptFrames(msg.frames);
        break;
      case "status":
        applyStatus(msg.status);
        break;
      case "dbc":
        applyDbc(msg.dbc);
        break;
      case "log":
        if (msg.level === "error") toast(msg.message, "error");
        else if (msg.level === "warn") toast(msg.message, "warn");
        else setLastLog(msg.message);
        break;
      case "cleared":
        clearLocalFrames();
        setLastLog("实时缓冲已清空");
        break;
    }
  }

  // src/events.ts
  function bindEvents() {
    els.btnRefreshDevices.addEventListener("click", () => {
      void runBusy(els.btnRefreshDevices, loadDevices);
    });
    els.channelSelect.addEventListener("change", () => {
      selectChannel(els.channelSelect.value);
    });
    els.channelRate.addEventListener("change", () => {
      setChannelRate(els.channelRate.value);
    });
    els.btnChannelStart.addEventListener("click", () => {
      void runBusy(els.btnChannelStart, () => startChannel(applyStatus));
    });
    els.btnChannelStop.addEventListener("click", () => {
      void runBusy(els.btnChannelStop, () => stopChannel(applyStatus));
    });
    els.btnAcceptAll.addEventListener("click", () => {
      acceptAllRanges();
    });
    els.btnApplyFilters.addEventListener("click", () => {
      void runBusy(els.btnApplyFilters, () => applyFiltersLive(applyStatus));
    });
    els.btnAddFilter.addEventListener("click", () => {
      addRangeRow();
    });
    els.btnRecStart.addEventListener("click", () => {
      void runBusy(els.btnRecStart, async () => {
        const { status, file } = await startRecording();
        if (status) applyStatus(status);
        toast("开始录制：" + file, "success");
        await loadRecordings();
      });
    });
    els.btnRecStop.addEventListener("click", () => {
      void runBusy(els.btnRecStop, async () => {
        const { status, file, frames } = await stopRecording();
        if (status) applyStatus(status);
        const frameText = frames === null ? "—" : fmtInt(frames);
        toast("已保存 " + file + " （" + frameText + " 帧）", "success");
        await loadRecordings();
      });
    });
    els.btnRefreshRecordings.addEventListener("click", () => {
      void runBusy(els.btnRefreshRecordings, loadRecordings);
    });
    els.btnPauseView.addEventListener("click", () => {
      setPaused(!state.paused);
    });
    els.btnClearView.addEventListener("click", () => {
      void runBusy(els.btnClearView, async () => {
        await clearFrames();
        clearLocalFrames();
        setLastLog("已清空实时缓冲");
      });
    });
    els.frameFilter.addEventListener("input", () => {
      state.filter = els.frameFilter.value.trim().toLowerCase();
      rebuildTable();
    });
    els.autoscrollCheck.addEventListener("change", () => {
      setAutoscroll(els.autoscrollCheck.checked);
    });
    els.sendChannel.addEventListener("change", updateSendControls);
    els.sendId.addEventListener("input", updateSendControls);
    els.sendData.addEventListener("input", () => {
      updateSendDlc();
      updateSendControls();
    });
    els.sendDlc.addEventListener("input", updateSendControls);
    els.sendRemote.addEventListener("change", () => {
      if (els.sendRemote.checked) els.sendDlc.value = "0";
      updateSendDlc();
      updateSendControls();
    });
    for (const radio of document.querySelectorAll('input[name="send-ext"]')) {
      radio.addEventListener("change", updateSendControls);
    }
    for (const input of [els.sendId, els.sendData]) {
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          if (!els.btnSend.disabled) els.btnSend.click();
        }
      });
    }
    els.btnSend.addEventListener("click", () => {
      void runBusy(els.btnSend, () => sendCurrentFrame(applyStatus));
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "/" || e.defaultPrevented) return;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t instanceof HTMLElement && t.isContentEditable) {
        return;
      }
      e.preventDefault();
      els.frameFilter.scrollIntoView({ block: "center" });
      els.frameFilter.focus();
      els.frameFilter.select();
    });
    window.addEventListener("online", () => {
      const ws = state.ws;
      if (!ws || ws.readyState > 1) connectWs();
    });
    initChannelPanel();
  }

  // src/main.ts
  function tickTimers() {
    const st = state.status;
    if (st && st.recording.active && st.recording.started_at_ms !== null) {
      els.recActiveElapsed.textContent = fmtDur(Date.now() - st.recording.started_at_ms);
    }
  }
  function init() {
    setRangeRowsChangedHandler(updateControls);
    bindEvents();
    initDbc();
    renderRecordings();
    updateStrip();
    updateEmpty();
    updateSendDlc();
    updateSendControls();
    void loadStatus();
    void loadDevices();
    void loadRecordings();
    void loadHealth();
    connectWs();
    window.setInterval(tickTimers, 1e3);
  }
  void init();
})();
