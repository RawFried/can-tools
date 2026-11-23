# AGENTS.md

本文件是 `can-tools` 的工程约束。所有人类贡献者与 AI agent 在改动本仓库前必读。

## 1. 总原则（遵循 Google 工程实践）

参考 Google Engineering Practices 与 Google Style Guides，取其可执行部分：

- **小步、单一目的。** 一个提交只做一件事；顺手重构请单独提交。评审者应能在几分钟内读完 diff。
- **改动必须自带验证。** 行为变化要附测试或可复现的验证步骤；"能编译"不等于"已验证"。
- **契约先于实现。** 修改 HTTP/WebSocket 形状、CSV 列、协议字节布局时，先改文档再改代码，二者同一提交。
- **可读性优先于聪明。** 命名表达意图；注释解释「为什么」，不解释「是什么」。不保留注释掉的代码与调试输出。
- **错误必须显式处理。** 禁止吞掉 `Err`/异常；面向用户的错误信息需可操作（说明发生了什么、能做什么）。
- **格式与静态检查自动化。** 不手工对齐格式；格式问题一律交给 `cargo fmt` / `tsc`。
- **不提交生成物之外的垃圾。** 构建产物、日志、运行数据、临时脚本不得入库（见 `.gitignore`）。

## 2. 仓库结构与职责

```
crates/can-core/        共享驱动类型 + CanChannel trait（无 rusb / 无 app 依赖）
  src/types.rs          BaudRate/CanMode/HardwareFilter/CanFrame/DeviceInfo/ChannelSource
  src/channel.rs        CanChannel trait 与 ChannelConfig 快照
crates/canalyst-ii/     USBCAN/CANalyst-II USB 驱动（只做协议与设备 I/O，依赖 can-core + rusb）
  src/protocol.rs       USBCAN 字节级协议编解码（改动需硬件实测）
  src/device.rs         USB 设备打开/初始化/收发的底层句柄
  src/error.rs          驱动错误类型
src/                  Rust 后端（bin + lib）
  can/usb.rs          USBCAN 总线/通道适配（UsbCanBus/UsbChannel，实现 CanChannel）
  can/socketcan.rs    SocketCAN 接口发现/启用与链路（实现 CanChannel）
  can/types.rs        应用层 API DTO、软件滤波与校验（重导出 can-core 共享类型）
  service/            worker 线程（只持有 Box<dyn CanChannel>）、录制、状态发布
  logging.rs          运行日志：控制台 + <data_dir>/logs 文件双写与按大小轮转
  server.rs           axum 路由与 HTTP/WS 处理
  paths.rs            数据目录解析（CAN_TOOLS_DATA_DIR → XDG）
web/                  前端（无框架 TypeScript + CSS + HTML 片段，源码按职责拆模块于 src/）
  src/main.ts         启动入口；types/format/dom/state/api/toast/ws/frames/status/
                      devices/recordings/channel-stats/backdrop/signals/
                      signal-window/signal-session/signal-drag/filters(-model)/
                      send/events/theme 各司其职
  src/theme.ts        主题插件注册表、选择器、持久化；id 与 index.html 早绘脚本同步
  src/styles/         CSS 源码：vendor/ui-shell（共享部件外壳）/fonts/base/
                      backdrop/layout/controls/rail/stats/data/send/dbc/
                      overlays/responsive 各司其职，index.css 按序 @import；
                      themes/ 为主题插件（default、endfield），只放身份令牌与覆盖
  src/html/           HTML 片段源码：index.html 为骨架，topbar/rail/main/stats/send/
                      data/recordings/overlays 按区块拆分，骨架用 include 标记引用
  scripts/build-html.mjs  递归展开 include 标记，拼装出单文件 web/index.html
  fonts/              自托管 Saira 可变字体与 SIL OFL 许可证（运行时 /fonts/Saira.ttf）
  index.html          由 src/html/** 拼装生成，**不入库**；运行时仍是单文件
  app.js              由 esbuild 生成的单 IIFE 脚本，**不入库**；构建前需 npm run build
  app.css             由 src/styles/** 经 esbuild 打包生成，**不入库**（页面路径仍为 /app.css）
                      index.html/app.js/app.css 都在 cargo 编译时被后端 include_str! 嵌入，
                      build.rs 缺失时给出「先 npm run build」提示
docs/api.md           HTTP/WebSocket 契约（权威）
docs/protocol.md      USBCAN 协议摘要
tests/                集成测试（hw_* 需要真实硬件）
packaging/            AppImage 打包
```

## 3. Rust 约束

- 版本：`edition 2021`，`rust-version 1.82`。
- **禁止 `unsafe`**（`Cargo.toml` 已 `forbid`），不要用 `#[allow]` 绕过。
- 格式：`rustfmt.toml` 固定 `max_width = 100`；提交前跑 `cargo fmt --all`。
- Lint：`[lints.clippy] all = "warn"`，CI 以 `-D warnings` 执行；不要新增 `#[allow(clippy::…)]` 除非在紧邻注释里说明原因。
- 命名与文档：类型 `CamelCase`，函数/变量 `snake_case`，常量 `SCREAMING_SNAKE_CASE`。公开项写 `///` 文档注释（中文，说明约束与失败条件）。
- 错误：库内用 `Result<_, String>` / `thiserror`；不要 `panic!` 处理可恢复错误。面向用户的错误文案为中文且包含实际值。
- 协议常量（`acc_code`/`acc_mask` 位布局、帧头、端点）不得凭猜测修改；改动必须附硬件复现记录。
- 分层约束：`crates/canalyst-ii`（Rust 路径 `canalyst_ii`）只做协议与设备 I/O，**不得实现 `CanChannel`** 或依赖工作线程/共享状态；USB 通道适配放 `src/can/usb.rs`，与 `can/socketcan.rs` 同层。
- 单元测试放在源文件末尾 `#[cfg(test)] mod tests`，测试名描述行为（`software_filter_matches_range_and_frame_kind`）。

## 4. TypeScript / 前端约束

- **运行时无框架、无依赖**；`web/devDependencies` 只允许类型检查（`typescript`）与打包（`esbuild`）这类构建期工具。打包器把 `web/src/**` 打成单个 IIFE 经典脚本 `web/app.js`，由后端 `include_str!` 嵌入分发。
- **按职责分模块，禁止单文件膨胀**。目录职责与依赖方向（单向，禁止反向/循环）：

  ```
  types → format → dom → {state, toast} → api → ws → frames → channel-stats → status
        → {devices, recordings, filters} → send → events → main
  ```

  - `filters-model.ts` 必须是纯函数（零 DOM、零 state），便于独立测试；
  - `filters.ts` 与 `status.ts` 之间不得互相 import：跨模块回调用注入（`setRangeRowsChangedHandler`）或放在 `events.ts` 汇总；
  - 单模块建议 ≤ 350 行，超过 500 行视为拆分不彻底。
- **HTML 同样按区块分文件**（`web/src/html/**`，`index.html` 为骨架）：片段只能通过独占一行的 `<!-- include: NAME.html -->` 引用，由 `web/scripts/build-html.mjs` 在构建期递归展开成单文件 `web/index.html`；片段名不得含路径分隔符。改结构只改 `web/src/html/**`，不要直接编辑生成的 `web/index.html`，片段内容为原始 HTML（保留缩进与换行），拼装结果必须与拆分前逐字节一致。
- `strict: true`；禁止 `any`、`@ts-ignore`、非空断言滥用。外部数据一律先按 `unknown` 接收，经类型守卫收窄。
- DOM 只通过 DOM API 与 `textContent` 构建；**禁止 `innerHTML` 拼接**。所有元素引用集中在 `dom.ts`，行模板放在对应 HTML 片段（`web/src/html/**`）的 `<template>` 中。
- 风格：2 空格缩进、单引号、语句带分号、`camelCase` 变量/函数、`PascalCase` 类型。界面文案与注释用中文，标识符用英文。
- `web/index.html`、`web/app.js` 与 `web/app.css` 都是构建产物且**不入库**：只改 `web/src/**`，然后在 `web/` 下 `npm run build`（先 `build:html` 拼装 HTML，再 `build:js` / `build:css`）生成；`build.rs` 会在产物缺失时提示。CI 在 cargo 之前构建前端。构建必须确定性（同源同工具两次构建 md5 相同）。`index.html` 中不得残留 `include:` 标记，`app.js` 中不得出现 `import`/`export`/`require`，`app.css` 中不得残留 `@import`（已内联）。
- **外观走主题插件**：`web/src/styles/themes/**` 提供完整身份令牌（`--ui-*`、`--chart-1..3` 的浅色/深色/系统兜底），`<html data-ui-theme="…">` 选择当前主题；`theme.ts` 的注册表负责选项、切换与持久化，`index.html` 的早绘脚本镜像同一 id 列表（脚本无法 import）。
  - `default`（仪表工作台）为初始主题：v0.3 深蓝/浅灰配色、28px 网格地面、实色卡片/按钮、CAN1 青色强调、系统字体；无磨砂玻璃/半透明表面/极光地面；等高线/尘埃/三色条隐藏；
  - `endfield` 主题沿用 endfield-ui 规范：纸/墨/单一信号黄、切角只给可点击、宽体 Saira、静态等高线与尘埃；红色仍只给删除；
  - 共享部件必须只消费令牌，不写死主题色；主题可覆盖 01–05 面板（`section.ui-panel[data-panel]`）与 `.ui-btn`/`.ui-seg` 等按钮类的皮肤，但不得改布局尺寸与状态语义。所有 endfield 身份纹样（眉标前缀、空态标记、面板页签、hatch 纹理、弹窗/浮窗铬件等）都必须令牌化或由主题覆盖，默认主题不得残留 endfield 纹样。新增主题要建完整令牌集、在 `themes/index.css` 追加 `@import`，并同步 `theme.ts` 与早绘脚本的 id 列表。
- **CSS 同样按职责分文件**（`web/src/styles/**`，`index.css` 为入口）。依赖方向单向：`vendor/ui-shell → fonts → base → backdrop → layout → controls → rail → stats → data → send → dbc → overlays → responsive → themes`；`vendor/ui-shell.css` 只保留共享部件规则与等高线数据 URI（身份令牌已迁出），除升级或结构迁移外不要改；`index.css` 的 `@import` 顺序即级联顺序，`themes` 必须最后（令牌覆盖所有共享样式），调整顺序前先确认选择器优先级与覆盖关系。禁止在 `index.css` 里写规则，也不要直接编辑 `web/app.css`。
- 纯函数（如滤波推导、解析）放在可测试的位置并配注释说明边界条件；不要在没有依据的情况下改动已实测的位运算。

## 5. 提交与评审

- 提交信息遵循 Conventional Commits：`<type>(<scope>): <description>`，type ∈ `feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert`；描述用祈使句、不超 72 字符；破坏性变更用 `!` 或 `BREAKING CHANGE:` 脚注。
- 一个提交 = 一个逻辑改动；不把格式化 diff 混进功能提交。
- 评审关注：正确性、边界条件、错误路径、是否补了文档与测试、是否引入未使用代码。
- 禁止跳过钩子（`--no-verify`）、禁止 `push --force` 到 `main`。

## 6. 提交前必跑（顺序固定）

```bash
cd web && npm run build             # 生成 index.html/app.js/app.css（不入库）；cargo 编译前必须存在
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets  # hw_* 需要真实硬件；无硬件时至少跑非 hw 用例
```

需要真机时：`tests/hw_*.rs` 与 `docs/protocol.md` 中的实测结论是基准，失败先怀疑接线/波特率，再怀疑代码。

## 7. 禁止事项

- 提交 `.env`、密钥、设备序列号等敏感信息。
- 提交 `target/`、`dist/`、`.tools/`、`node_modules/`、运行日志与采集数据。
- 在文档中写入未经验证的"已修复/已通过"结论。
- 修改 `docs/api.md` 未同步更新前端类型守卫或后端 DTO。
