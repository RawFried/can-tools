//! USBCAN 设备生命周期与通道操作。
//!
//! 单线程使用: [`UsbCan`] 由 CAN 工作线程独占, 不实现跨线程共享。打开流程
//! 对齐 C 参考驱动: 枚举 → open → 自动 detach 内核驱动 → claim interface 0 →
//! 挑战握手 → 读取字符串触发设备工作模式。
//!
//! 关闭时必须向两个通道的命令端点发送 `0x07`, 等待约 50ms 后释放接口;
//! 跳过该序列会让设备残留异常态。

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusb::{Context, DeviceHandle, UsbContext};

use can_core::{BaudRate, CanFrame, CanMode, DeviceInfo, HardwareFilter};

use crate::error::{Error, Result};
use crate::protocol::{self, Endpoints};

/// 命令/控制传输超时。
const COMMAND_TIMEOUT: Duration = Duration::from_millis(1000);
/// RX 单次读取的默认短超时。
const RX_TIMEOUT: Duration = Duration::from_millis(1);
/// 关闭命令后的稳定窗口。
const CLOSE_SETTLE: Duration = Duration::from_millis(50);
/// 单次 RX 最多读取的传输数 (每传输最多 128 字节)。
const MAX_RX_TRANSFERS: usize = 8;

/// 枚举所有匹配设备 (VID:PID 04d8:0053)。
///
/// 扫描期间会短暂打开设备读取序列号, 但不会 claim 接口或执行任何改变状态的
/// I/O。设备正被本进程打开时不应调用此函数 (由工作线程保证)。
pub fn list_devices() -> Result<Vec<DeviceInfo>> {
    let context = Context::new()?;
    let mut devices = Vec::new();
    for device in context.devices()?.iter() {
        let descriptor = match device.device_descriptor() {
            Ok(descriptor) => descriptor,
            Err(error) => {
                tracing::debug!("跳过无法读取描述符的 USB 设备: {error}");
                continue;
            }
        };
        if descriptor.vendor_id() != protocol::VID || descriptor.product_id() != protocol::PID {
            continue;
        }
        let mut info = DeviceInfo {
            index: devices.len(),
            fw_version: format_firmware(descriptor.device_version()),
            serial: String::new(),
            hw_type: "CAN-Linux".to_string(),
            channel_count: 2,
        };
        match device.open() {
            Ok(handle) => {
                if let Some(index) = descriptor.serial_number_string_index() {
                    if let Ok(serial) = handle.read_string_descriptor_ascii(index) {
                        info.serial = serial;
                    }
                }
            }
            Err(error) => {
                tracing::warn!("设备打开失败 (序列号不可用): {error}");
            }
        }
        devices.push(info);
    }
    Ok(devices)
}

/// 打开第 `index` 个匹配设备。
pub fn open(index: usize) -> Result<UsbCan> {
    if index >= protocol::MAX_DEV {
        return Err(Error::InvalidArgument(format!(
            "设备索引 {index} 超出范围 (0-15)"
        )));
    }
    let context = Context::new()?;
    let mut target = None;
    let mut descriptor = None;
    let mut seen = 0;
    for device in context.devices()?.iter() {
        let desc = match device.device_descriptor() {
            Ok(desc) => desc,
            Err(_) => continue,
        };
        if desc.vendor_id() != protocol::VID || desc.product_id() != protocol::PID {
            continue;
        }
        if seen == index {
            descriptor = Some(desc);
            target = Some(device);
            break;
        }
        seen += 1;
    }
    let device = target.ok_or(Error::DeviceNotFound)?;
    let descriptor = descriptor.ok_or(Error::DeviceNotFound)?;

    let handle = device.open()?;
    handle.set_auto_detach_kernel_driver(true)?;
    handle.claim_interface(0)?;

    if let Err(error) = handshake(&handle) {
        let _ = handle.release_interface(0);
        return Err(error);
    }
    read_work_mode_strings(&handle);

    let mut info = DeviceInfo {
        index,
        fw_version: format_firmware(descriptor.device_version()),
        serial: String::new(),
        hw_type: "CAN-Linux".to_string(),
        channel_count: 2,
    };
    if let Some(string_index) = descriptor.serial_number_string_index() {
        if let Ok(serial) = handle.read_string_descriptor_ascii(string_index) {
            info.serial = serial;
        }
    }

    tracing::info!(
        "已打开 USBCAN 设备 index={} fw={} serial={}",
        info.index,
        info.fw_version,
        info.serial
    );
    Ok(UsbCan {
        _context: context,
        handle: Some(handle),
        info,
        init_packets: [None; 2],
    })
}

/// 打开的设备句柄。
pub struct UsbCan {
    _context: Context,
    handle: Option<DeviceHandle<Context>>,
    info: DeviceInfo,
    init_packets: [Option<[u8; protocol::INIT_CONFIG_PACKET_SIZE]>; 2],
}

impl UsbCan {
    /// 板卡信息。
    pub fn info(&self) -> &DeviceInfo {
        &self.info
    }

    /// 检查设备是否仍在线。
    ///
    /// 用标准 GET_DESCRIPTOR 控制传输探测句柄: 设备拔出后内核句柄失效,
    /// 会返回 `NoDevice`; 其它错误 (STALL/超时等) 不判定为拔出。
    pub fn is_present(&self) -> bool {
        let Some(handle) = self.handle.as_ref() else {
            return false;
        };
        let mut descriptor = [0u8; 18];
        match handle.read_control(
            0x80,
            0x06,
            0x0100,
            0,
            &mut descriptor,
            Duration::from_millis(200),
        ) {
            Ok(_) => true,
            Err(rusb::Error::NoDevice) | Err(rusb::Error::NotFound) => false,
            Err(_) => true,
        }
    }

    /// 初始化通道; 成功时缓存配置包供 StartCAN 复用。
    pub fn init_can(
        &mut self,
        channel: u8,
        baud: BaudRate,
        mode: CanMode,
        filter: &HardwareFilter,
    ) -> Result<()> {
        check_channel(channel)?;
        let packet = protocol::encode_init(baud, mode, filter);
        self.send_command(channel, &packet)?;
        self.init_packets[channel as usize] = Some(packet);
        Ok(())
    }

    /// 启动通道。
    pub fn start_can(&self, channel: u8) -> Result<()> {
        check_channel(channel)?;
        let init = self.init_packets[channel as usize]
            .ok_or_else(|| Error::InvalidArgument("启动前必须先初始化通道".to_string()))?;
        self.send_command(channel, &protocol::to_start_packet(&init))
    }

    /// 复位通道。
    pub fn reset_can(&self, channel: u8) -> Result<()> {
        check_channel(channel)?;
        let packet = [protocol::cmd::RESET_CAN];
        self.send_command(channel, &packet)
    }

    /// 清空通道接收缓冲。
    pub fn clear_buffer(&self, channel: u8) -> Result<()> {
        check_channel(channel)?;
        let packet = [protocol::cmd::CLEAR_BUFFER];
        self.send_command(channel, &packet)
    }

    /// 发送一帧 (64 字节整包, 数据 TX 端点)。
    pub fn send_frame(&self, channel: u8, frame: &CanFrame) -> Result<()> {
        check_channel(channel)?;
        let endpoints = endpoints(channel)?;
        let handle = self.handle.as_ref().ok_or(Error::NotOpen)?;
        handle.write_bulk(
            endpoints.data_out,
            &protocol::encode_tx_frame(frame),
            COMMAND_TIMEOUT,
        )?;
        Ok(())
    }

    /// 立即读取通道上已有的帧, 最多 `max_transfers` 次 bulk 传输。
    ///
    /// 每次传输读取最多 128 字节并遍历两个 64 字节子块。超时表示当前无数据,
    /// 返回空列表; 其他 USB 错误向上传递。
    pub fn drain(&self, channel: u8, max_transfers: usize) -> Result<Vec<CanFrame>> {
        check_channel(channel)?;
        let endpoints = endpoints(channel)?;
        let handle = self.handle.as_ref().ok_or(Error::NotOpen)?;
        let mut frames = Vec::new();
        for _ in 0..max_transfers.min(MAX_RX_TRANSFERS) {
            let mut buffer = [0u8; protocol::RX_TRANSFER_SIZE];
            match handle.read_bulk(endpoints.data_in, &mut buffer, RX_TIMEOUT) {
                Ok(0) => break,
                Ok(received) => frames.extend(protocol::decode_rx_blocks(&buffer[..received])),
                Err(rusb::Error::Timeout) => break,
                Err(error) => return Err(error.into()),
            }
        }
        Ok(frames)
    }

    /// 执行完整关闭序列。
    pub fn close(&mut self) -> Result<()> {
        let Some(handle) = self.handle.take() else {
            return Ok(());
        };
        let packet = [protocol::cmd::CLOSE; protocol::COMMAND_PACKET_SIZE];
        let timeout = Duration::from_millis(200);
        // 双通道命令端点都要收到关闭命令, 否则设备可能残留异常态。
        let _ = handle.write_bulk(0x02, &packet, timeout);
        let _ = handle.write_bulk(0x04, &packet, timeout);
        std::thread::sleep(CLOSE_SETTLE);
        let _ = handle.release_interface(0);
        self.init_packets = [None; 2];
        tracing::info!("已关闭 USBCAN 设备");
        Ok(())
    }

    /// 向通道命令端点发送 64 字节命令包。
    fn send_command(&self, channel: u8, packet: &[u8]) -> Result<()> {
        let endpoints = endpoints(channel)?;
        let handle = self.handle.as_ref().ok_or(Error::NotOpen)?;
        let mut full = [0u8; protocol::COMMAND_PACKET_SIZE];
        let length = packet.len().min(full.len());
        full[..length].copy_from_slice(&packet[..length]);
        handle.write_bulk(endpoints.cmd_out, &full, COMMAND_TIMEOUT)?;
        Ok(())
    }
}

impl Drop for UsbCan {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

/// 挑战-应答握手。固件 V3.51 不校验应答内容, 但需要完成一次控制流。
fn handshake(handle: &DeviceHandle<Context>) -> Result<()> {
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.subsec_nanos())
        .unwrap_or(0x5EED);
    let packet = protocol::encode_handshake(seed);
    handle.write_bulk(0x02, &packet, COMMAND_TIMEOUT)?;
    handle.write_bulk(0x02, &packet, COMMAND_TIMEOUT)?;
    let mut response = [0u8; protocol::COMMAND_PACKET_SIZE];
    handle.read_bulk(0x82, &mut response, COMMAND_TIMEOUT)?;
    Ok(())
}

/// 读取字符串描述符, 触发设备进入工作模式 (对齐 C 驱动行为)。失败可忽略。
fn read_work_mode_strings(handle: &DeviceHandle<Context>) {
    let mut buffer = [0u8; protocol::COMMAND_PACKET_SIZE];
    for (value, index) in [(0x0300u16, 0x0000u16), (0x0302, 0x0409), (0x0304, 0x0409)] {
        let _ = handle.read_control(0x80, 0x06, value, index, &mut buffer, COMMAND_TIMEOUT);
    }
}

/// 将 USB BCD 版本号格式化为 `3.51` 形式。
fn format_firmware(version: rusb::Version) -> String {
    let bcd = (u16::from(version.0) << 8) | (u16::from(version.1) << 4) | u16::from(version.2);
    format!("{}.{:02x}", (bcd >> 8) & 0xFF, bcd & 0xFF)
}

fn check_channel(channel: u8) -> Result<()> {
    if channel > 1 {
        return Err(Error::InvalidChannel(channel));
    }
    Ok(())
}

fn endpoints(channel: u8) -> Result<Endpoints> {
    protocol::endpoints(channel).ok_or(Error::InvalidChannel(channel))
}
