//! 通道抽象: 工作线程只持有堆上的 [`Box<dyn CanChannel>`], 不感知驱动细节。
//!
//! USB 与 SocketCAN 各自在独立模块实现本 trait; 上层只通过 trait 方法收发、
//! 停止与更新滤波, 不再直接调用 `init_can`/`drain`/`write_frame` 等驱动函数。

use crate::can::types::{BaudRate, CanFrame, CanMode, ChannelSource, HardwareFilter};

/// 通道的配置快照。
///
/// 与 [`CanChannel::config`] 一起用于状态展示: USB 通道给出波特率/模式/硬件
/// 滤波, SocketCAN 链路给出速率与接口状态。仅表示驱动层事实, 不参与 JSON 契约。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChannelConfig {
    /// USBCAN 通道配置。
    Usb {
        /// 当前波特率。
        baud: BaudRate,
        /// 当前工作模式。
        mode: CanMode,
        /// 当前硬件验收滤波。
        filter: HardwareFilter,
    },
    /// SocketCAN 链路配置。
    SocketCan {
        /// 打开时从 sysfs 读到的速率; 不可见时为 `None`。
        bitrate: Option<u64>,
        /// 打开时的接口状态 (`up` / `down` / `unknown`)。
        state: String,
    },
}

/// 一个已打开的 CAN 通道。
///
/// 实现必须可跨线程移动 (`Send`), 但不需要 `Sync`: 工作线程独占所有通道,
/// 每个 trait object 代表一条物理/逻辑通道。所有 I/O 失败以可展示的中文
/// `String` 返回, 由调用方决定是否关闭通道。
pub trait CanChannel: Send {
    /// 通道来源 (USB / SocketCAN), 仅用于生命周期与状态映射。
    fn source(&self) -> ChannelSource;

    /// 通道名: USB 为 `CAN1`/`CAN2`, SocketCAN 为接口名。
    fn name(&self) -> &str;

    /// 当前配置快照。
    fn config(&self) -> ChannelConfig;

    /// 非阻塞读取最多 `max` 帧; 当前无数据时返回空列表。
    fn read(&mut self, max: usize) -> Result<Vec<CanFrame>, String>;

    /// 发送一帧。
    fn write(&mut self, frame: &CanFrame) -> Result<(), String>;

    /// 停止通道; 失败不应阻止调用方释放通道。
    fn stop(&mut self) -> Result<(), String>;

    /// 通道是否仍可用 (设备在线 / 接口仍存在)。
    fn is_alive(&self) -> bool;

    /// 热更新硬件验收滤波。
    ///
    /// USBCAN 通过重新初始化并启动通道生效; SocketCAN 没有硬件验收滤波,
    /// 实现必须返回「只支持软件滤波」的错误。
    fn update_hardware_filter(&mut self, filter: &HardwareFilter) -> Result<(), String>;
}
