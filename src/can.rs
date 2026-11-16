//! USBCAN 驱动层: 协议编解码、设备生命周期与公共类型。

pub mod channel;
pub mod dbc;
pub mod device;
pub mod error;
pub mod protocol;
pub mod socketcan;
pub mod types;
pub mod usb;

pub use channel::{CanChannel, ChannelConfig};
pub use device::UsbCan;
pub use error::{Error, Result};
pub use usb::UsbCanBus;
