//! USBCAN 驱动层: 协议编解码、设备生命周期与公共类型。

pub mod device;
pub mod error;
pub mod protocol;
pub mod types;

pub use device::UsbCan;
pub use error::{Error, Result};
