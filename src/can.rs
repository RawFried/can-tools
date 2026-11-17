//! CAN 后端: 领域类型、通道抽象、USB/SocketCAN 通道适配与 DBC 支持。
//!
//! 共享驱动类型与 [`CanChannel`] 由 `can-core` 提供; USBCAN 协议与设备 I/O
//! 由 `canalyst-ii` crate 提供, 其 [`usb::UsbCanBus`] 适配层在本模块实现; 本模块
//! 还保留应用层类型、SocketCAN 与 DBC。

pub mod dbc;
pub mod socketcan;
pub mod types;
pub mod usb;

pub use can_core::{CanChannel, ChannelConfig};
pub use canalyst_ii::Error;
pub use usb::UsbCanBus;
