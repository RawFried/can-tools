//! USBCAN 应用层适配: 把驱动 crate 的单设备句柄包装成总线与通道。
//!
//! `canalyst-ii` crate 只负责协议编解码与设备 I/O, 不依赖通道抽象; [`CanChannel`]
//! 的实现、通道命名与共享句柄策略属于应用层, 因此放在这里。
//!
//! 一个 [`UsbCanBus`] 对应一台设备, 内部用 `Arc<Mutex<UsbCan>>` 让两个
//! [`UsbChannel`] 串行复用同一个 USB 句柄; 所有收发仍由工作线程串行触发,
//! 上层只通过 [`CanChannel`] 操作通道。

use std::sync::{Arc, Mutex, MutexGuard};

use can_core::{
    BaudRate, CanChannel, CanFrame, CanMode, ChannelConfig, ChannelSource, DeviceInfo,
    HardwareFilter,
};
use canalyst_ii::device::{self, UsbCan};
use canalyst_ii::Error;

/// 已打开的 USBCAN 设备及其通道工厂。
pub struct UsbCanBus {
    index: usize,
    device: Arc<Mutex<UsbCan>>,
    info: DeviceInfo,
}

impl UsbCanBus {
    /// 打开第 `index` 个匹配设备。
    ///
    /// 失败时返回底层驱动错误, 调用方可据 [`Error::DeviceNotFound`] 决定是否重试。
    pub fn open(index: usize) -> Result<Self, Error> {
        let device = device::open(index)?;
        let info = device.info().clone();
        Ok(Self {
            index,
            device: Arc::new(Mutex::new(device)),
            info,
        })
    }

    /// 设备在匹配列表中的索引。
    pub fn index(&self) -> usize {
        self.index
    }

    /// 打开时的板卡信息。
    pub fn info(&self) -> &DeviceInfo {
        &self.info
    }

    /// 检查设备是否仍在线 (USB 拔出后返回 `false`)。
    pub fn is_present(&self) -> bool {
        lock(&self.device).is_present()
    }

    /// 枚举匹配设备, 不打开或改变设备状态。
    pub fn list_devices() -> Result<Vec<DeviceInfo>, Error> {
        device::list_devices()
    }

    /// 初始化并启动 `channel`, 返回可独立操作该通道的 trait object。
    ///
    /// 启动后尽力清空接收缓冲 (失败忽略, 与既有行为一致)。`name` 用于状态与
    /// 录制展示, 通常为 `CAN1`/`CAN2`。
    pub fn open_channel(
        &self,
        channel: u8,
        baud: BaudRate,
        mode: CanMode,
        filter: HardwareFilter,
        name: String,
    ) -> Result<Box<dyn CanChannel>, String> {
        {
            let mut device = lock(&self.device);
            device
                .init_can(channel, baud, mode, &filter)
                .map_err(|error| error.to_string())?;
            device
                .start_can(channel)
                .map_err(|error| error.to_string())?;
            let _ = device.clear_buffer(channel);
        }
        Ok(Box::new(UsbChannel {
            device: Arc::clone(&self.device),
            channel,
            name,
            baud,
            mode,
            filter,
        }))
    }

    /// 执行完整关闭序列; 调用前应先停止并释放所有通道。
    pub fn close(&mut self) -> Result<(), Error> {
        lock(&self.device).close()
    }
}

struct UsbChannel {
    device: Arc<Mutex<UsbCan>>,
    channel: u8,
    name: String,
    baud: BaudRate,
    mode: CanMode,
    filter: HardwareFilter,
}

impl CanChannel for UsbChannel {
    fn source(&self) -> ChannelSource {
        ChannelSource::Usb
    }

    fn name(&self) -> &str {
        &self.name
    }

    fn config(&self) -> ChannelConfig {
        ChannelConfig::Usb {
            baud: self.baud,
            mode: self.mode,
            filter: self.filter,
        }
    }

    fn read(&mut self, max: usize) -> Result<Vec<CanFrame>, String> {
        lock(&self.device)
            .drain(self.channel, max)
            .map_err(|error| error.to_string())
    }

    fn write(&mut self, frame: &CanFrame) -> Result<(), String> {
        lock(&self.device)
            .send_frame(self.channel, frame)
            .map_err(|error| error.to_string())
    }

    fn stop(&mut self) -> Result<(), String> {
        lock(&self.device)
            .reset_can(self.channel)
            .map_err(|error| error.to_string())
    }

    fn is_alive(&self) -> bool {
        lock(&self.device).is_present()
    }

    fn update_hardware_filter(&mut self, filter: &HardwareFilter) -> Result<(), String> {
        let mut device = lock(&self.device);
        device
            .init_can(self.channel, self.baud, self.mode, filter)
            .map_err(|error| error.to_string())?;
        device
            .start_can(self.channel)
            .map_err(|error| error.to_string())?;
        self.filter = *filter;
        Ok(())
    }
}

/// 串行化访问共享句柄; 互斥锁中毒时复用内部值, 避免把 panic 扩散给工作线程。
fn lock(device: &Arc<Mutex<UsbCan>>) -> MutexGuard<'_, UsbCan> {
    device
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
