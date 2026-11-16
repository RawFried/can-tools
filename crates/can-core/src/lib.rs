//! 共享 CAN 驱动类型与通道抽象。
//!
//! 本 crate 不依赖具体 USB/SocketCAN 后端, 只定义驱动与应用共同使用的领域
//! 类型和 [`CanChannel`] trait。

#![warn(missing_docs)]

pub mod channel;
pub mod types;

pub use channel::{CanChannel, ChannelConfig};
pub use types::{BaudRate, CanFrame, CanMode, ChannelSource, DeviceInfo, HardwareFilter};
