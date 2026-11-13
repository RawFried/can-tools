# CAN Tools

基于创芯科技 **USBCAN/CANalyst-II（04d8:0053，固件 CAN-Linux V3.51）** 的 Web 上位机。
Rust 后端直接通过 USB 与设备通信，浏览器前端负责配置与展示。

功能范围（按需求收敛）：

- 配置双通道 **波特率**（5k–1000k）与工作模式（正常 / 只听 / 自测）；
- 用 **ID 区间** 设置滤波（可多条，标准/扩展分列）；硬件验收滤波由区间自动推导、软件层精筛；
- **运行时实时应用滤波**：区间立即生效，硬件预过滤热重初始化，不停止通道；
- **发送单帧**（标准/扩展/远程），并在自测模式下回环验证；
- 实时查看报文，并 **保存为 CSV**；可下载、删除历史文件；
- 单文件 AppImage 分发，内置静态前端，无需 Node 运行时。

![界面](docs/ui.png)

## 快速开始

```bash
cargo run --release
```

默认监听 `127.0.0.1:8787` 并自动打开浏览器。常用参数：

```text
-H, --host <HOST>        监听地址 [default: 127.0.0.1]
-p, --port <PORT>        监听端口 [default: 8787]
    --data-dir <DIR>     数据目录（录制文件在其 recordings 子目录）
    --no-browser         不自动打开浏览器
```

浏览器访问 `http://127.0.0.1:8787/`。数据目录默认遵循 XDG：
`$CAN_TOOLS_DATA_DIR` → `$XDG_DATA_HOME/can-tools` →
`$HOME/.local/share/can-tools` → 系统临时目录下的 `can-tools`。

> 服务默认仅监听回环地址且没有身份认证；若用 `--host 0.0.0.0` 暴露到局域网，
> 请自行确保网络可信。

## 设备权限

Linux 下非 root 用户需要 udev 规则：

```udev
# /etc/udev/rules.d/99-usbcan.rules
ACTION=="add", SUBSYSTEMS=="usb", ATTRS{idVendor}=="04d8", ATTRS{idProduct}=="0053", \
  GROUP="users", MODE="0666", ENV{ID_MM_DEVICE_IGNORE}="1"
```

```bash
sudo udevadm control --reload-rules && sudo udevadm trigger
```

重新插拔设备后生效。若设备被其他进程（如厂商工具）占用，打开会返回“接口被占用”。

## 滤波说明

前端只有一层入口——**ID 区间列表**（最多 16 条，标准/扩展区分，`起始 ≤ ID ≤ 结束`）。
提交时自动拆成两层执行：

- **硬件验收滤波（粗筛）**：由区间列表推导。取覆盖全部区间的最小 2 的幂对齐块，
  写入控制器：标准帧 `acc_code = blockStart << 21`、`acc_mask = (blockSize-1) << 21 | 0x001FFFFF`；
  扩展帧 `acc_code = blockStart << 3`、`acc_mask = (blockSize-1) << 3 | 0x00000007`；滤波方式 1。
  硬件块是区间并集的**超集**，多放行的帧由软件层剔除，因此不需要对齐到区间本身。
  区间列表为空、或同时混用标准/扩展帧时，退化为接收全部（`acc_code=0`、`acc_mask=0xFFFFFFFF`）。
- **软件 ID 区间滤波（精筛）**：主机侧对已接收帧再做一次筛选，命中任一区间即保留，
  帧类型必须一致。列表为空时全部通过。
- 配置变更会重启所选通道；未选中的通道保持运行。
- **实时应用滤波**：通道启动后，编辑区间并点击「实时应用滤波」即可生效，无需停止采集。
  区间（软件层）在主机侧立即切换；推导出的硬件滤波变化时，对所选运行通道执行
  `InitCAN + StartCAN`（不发送 `ResetCAN`、不关闭设备），实测通道保持运行。
  实时滤波只能作用于已启动的通道。卡片内的「硬件预过滤」徽标显示后端实际生效的硬件层。

> 验收滤波的归一化布局已在真实设备自测回环中验证，见
> `tests/hw_filter.rs`、`tests/hw_live_filter.rs` 与 `docs/protocol.md`。

## 发送报文

主界面“发送报文”栏支持单帧发送：

- 选择已启动的通道，填写十六进制 ID，选择标准/扩展；
- 数据支持 `11 22 33`、`112233` 或 `0x11,0x22,0x33`，最多 8 字节；
- 远程帧勾选“远程”，数据输入禁用，DLC 可设为 0–8；
- 发送要求设备已打开且目标通道已启动；只听模式不能发送。成功后更新“已发送”计数并写入运行日志。

在“自测”模式下，设备会把发送帧内部回环到接收端，可同时验证发送、接收与录制链路：

```bash
cargo test --test hw_selftest -- --ignored --nocapture
```

录制文件保存的是**接收帧**；正常总线模式下发送帧不会被本机回显，除非设备/总线回环。

## 报文保存
点击“开始录制”后，每帧写入 `recordings/can-YYYYmmdd-HHMMSS.csv`：

```text
time,unix_ms,channel,id,id_hex,extended,remote,dlc,data
2026-11-09 15:00:00.123,1762681200123,1,291,0x123,0,0,8,11 22 33 44 55 66 77 88
```

`channel` 从 1 开始。录制在停止、关闭设备或进程退出时 flush；写入失败会停止录制
并记录错误，不影响实时查看。

## 架构

```text
浏览器 (TypeScript, 无框架)
   │  REST / WebSocket
   ▼
axum (HTTP + WS 广播)
   │  命令 / oneshot 回复
   ▼
CAN 工作线程 (独占 libusb 句柄)
   │  轮询双通道 bulk IN + 协议编解码
   ▼
USBCAN/CANalyst-II (04d8:0053)
```

- `src/can/`：协议编解码、设备生命周期、公共类型；
- `src/service/`：工作线程、配置/录制命令、CSV 记录器；
- `src/state.rs`：状态快照、实时帧环形缓冲（5000 帧）、事件广播；
- `src/server.rs`：REST、WebSocket、静态资源；
- `web/src/app.ts`：前端唯一 TypeScript 源文件，编译为 `web/app.js` 后嵌入二进制。

协议字节布局见 [`docs/protocol.md`](docs/protocol.md)，HTTP API 见
[`docs/api.md`](docs/api.md)。

## 构建

前置：Rust 1.82+、Linux。`rusb` 启用 `vendored`，构建 libusb 不需要系统开发头文件。

```bash
cargo build --release
cargo test
```

前端（仅在修改 UI 时需要）：

```bash
cd web
npm ci
npm run build     # tsc -> web/app.js
npm run check     # 只做类型检查
```

`web/app.js` 是编译产物并纳入版本控制，Rust 构建不依赖 Node。

## AppImage

```bash
./packaging/build-appimage.sh
# -> dist/can-tools-<version>-x86_64.AppImage
```

脚本会构建 release 二进制、组装 AppDir、下载 `appimagetool`（缓存于 `.tools/`）并
输出单文件 AppImage。可复用已编译二进制：

```bash
SKIP_BUILD=1 ./packaging/build-appimage.sh
```

部分发行版没有 `libfuse2`，可直接解包运行：

```bash
./can-tools-0.1.0-x86_64.AppImage --appimage-extract-and-run
```

## 测试与规范

```bash
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test --all-targets
```

- 硬件冒烟测试（需要真实设备，默认忽略）：
  `cargo test --test hw_smoke -- --ignored --nocapture`
- 自测模式回环（验证 TX 编码与 RX 解码全链路，需要真实设备）：
  `cargo test --test hw_selftest -- --ignored --nocapture`
- 硬件验收滤波布局（验证标准/扩展 ID 的归一化换算，需要真实设备）：
  `cargo test --test hw_filter -- --ignored --nocapture`
- 运行时滤波热更新（不 Reset 通道，需要真实设备）：
  `cargo test --test hw_live_filter -- --ignored --nocapture`
- 遵循 Google 风格的 Rust 约定：`rustfmt`、`clippy`、`snake_case`/`CamelCase`、
  公共项文档注释；提交信息使用英文 Conventional Commits。
- 协议实现的关键不变量（RX 双半块、ID 0、0x340 魔数、0x07 关闭序列）在源码
  注释与 `docs/protocol.md` 中均有说明，修改前请先阅读。

## 范围与限制

- 仅支持 CAN 2.0（标准/扩展/远程帧），不支持 CAN-FD；
- 同一进程一次管理一台设备、双通道；发送为单帧手动发送，暂不支持周期/批量发送；
- 设备关闭后需要数百毫秒重新枚举，程序会在近期关闭过的场景自动重试；
- 浏览器端保留最近 5000 帧，历史报文请使用录制功能。

## 参考与致谢

协议与硬件行为来自同一工作区的参考实现：

- `can_service/usbcan_driver_gs`：C 规范版驱动（协议权威）；
- `can_service/multi-can/crates/usbcan-async`：Rust 异步驱动与协议注释；
- `can_service/usbcan-rs`：早期同步 Rust 驱动。

本项目按上述协议重新实现并针对 Web 上位机场景裁剪，未直接引入这些 crate。

## License

MIT，见 [LICENSE](LICENSE)。
