//! Chuangxin USBCAN/CANalyst-II (04d8:0053) USB 驱动。
//!
//! 只提供设备枚举/打开与字节级协议编解码; 通道抽象 (`CanChannel`) 的实现、
//! 共享句柄与状态展示属于应用层, 本 crate 不感知工作线程。
//! 协议常量与固件行为对齐 C 参考驱动, 修改需硬件实测。

#![warn(missing_docs)]

pub mod device;
pub mod error;
pub mod protocol;

pub use device::UsbCan;
pub use error::{Error, Result};
