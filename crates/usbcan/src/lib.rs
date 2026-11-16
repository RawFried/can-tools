//! Chuangxin USBCAN/CANalyst-II (04d8:0053) USB 驱动。
//!
//! 提供设备枚举/打开、字节级协议编解码与实现 [`can_core::CanChannel`] 的
//! 总线/通道封装。协议常量与固件行为对齐 C 参考驱动, 修改需硬件实测。

#![warn(missing_docs)]

pub mod device;
pub mod error;
pub mod protocol;
pub mod usb;

pub use device::UsbCan;
pub use error::{Error, Result};
pub use usb::UsbCanBus;
