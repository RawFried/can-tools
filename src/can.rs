//! CAN 后端: 领域类型、通道抽象、SocketCAN 链路与 DBC 支持。
//!
//! 共享驱动类型与 [`CanChannel`] 由 `can-core` 提供, USBCAN 驱动由 `usbcan`
//! 提供; 本模块只保留应用层类型、SocketCAN 与 DBC。

pub mod dbc;
pub mod socketcan;
pub mod types;

pub use can_core::{CanChannel, ChannelConfig};
pub use usbcan::{Error, UsbCanBus};
