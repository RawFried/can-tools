//! USB 驱动错误类型。

use thiserror::Error;

/// USBCAN 驱动错误。
#[derive(Debug, Error)]
pub enum Error {
    /// 未找到匹配设备。
    #[error("未找到 USBCAN 设备 (04d8:0053), 请检查 USB 连接")]
    DeviceNotFound,
    /// USB 访问权限不足。
    #[error("USB 访问被拒绝, 请检查 udev 权限 (04d8:0053)")]
    AccessDenied,
    /// 设备已断开。
    #[error("USB 设备已断开")]
    NoDevice,
    /// USB 传输超时。
    #[error("USB 传输超时")]
    Timeout,
    /// 其他 USB 错误。
    #[error("USB 错误: {0}")]
    Usb(rusb::Error),
    /// 设备未打开。
    #[error("设备未打开")]
    NotOpen,
    /// 通道号非法。
    #[error("非法通道 {0}; 合法值为 0 或 1")]
    InvalidChannel(u8),
    /// 参数错误。
    #[error("参数错误: {0}")]
    InvalidArgument(String),
    /// 接口被其他进程占用。
    #[error("USB 接口被占用: {0}")]
    Busy(String),
    /// 文件系统错误。
    #[error("I/O 错误: {0}")]
    Io(#[from] std::io::Error),
}

impl From<rusb::Error> for Error {
    fn from(error: rusb::Error) -> Self {
        match error {
            rusb::Error::Access => Self::AccessDenied,
            rusb::Error::NoDevice => Self::NoDevice,
            rusb::Error::Timeout => Self::Timeout,
            rusb::Error::Busy => Self::Busy("接口已被其他进程 claim".to_string()),
            other => Self::Usb(other),
        }
    }
}

/// 驱动层结果类型。
pub type Result<T> = std::result::Result<T, Error>;
