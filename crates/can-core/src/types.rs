//! 共享 CAN 领域类型: 帧、波特率、模式、硬件滤波与设备/通道描述。
//!
//! 这些类型由 USB 驱动与上层应用共用。JSON 字段名保持 `snake_case`,
//! 与 `docs/api.md` 一致。

use serde::{Deserialize, Serialize};

/// 设备支持的波特率及其 SJA1000 寄存器映射。
///
/// 数值来自 VCI 参考驱动波特率表, 与 C 驱动 `usbcan_driver_gs` 一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BaudRate {
    /// 5 kbit/s。
    #[serde(rename = "5k")]
    Kbps5,
    /// 10 kbit/s。
    #[serde(rename = "10k")]
    Kbps10,
    /// 20 kbit/s。
    #[serde(rename = "20k")]
    Kbps20,
    /// 50 kbit/s。
    #[serde(rename = "50k")]
    Kbps50,
    /// 100 kbit/s。
    #[serde(rename = "100k")]
    Kbps100,
    /// 125 kbit/s。
    #[serde(rename = "125k")]
    Kbps125,
    /// 250 kbit/s。
    #[serde(rename = "250k")]
    Kbps250,
    /// 500 kbit/s。
    #[serde(rename = "500k")]
    Kbps500,
    /// 800 kbit/s。
    #[serde(rename = "800k")]
    Kbps800,
    /// 1000 kbit/s (1 Mbit/s)。
    #[serde(rename = "1000k")]
    Kbps1000,
}

impl BaudRate {
    /// 全部可选波特率, 按速率升序。
    pub const ALL: [Self; 10] = [
        Self::Kbps5,
        Self::Kbps10,
        Self::Kbps20,
        Self::Kbps50,
        Self::Kbps100,
        Self::Kbps125,
        Self::Kbps250,
        Self::Kbps500,
        Self::Kbps800,
        Self::Kbps1000,
    ];

    /// 返回 `(Timing0, Timing1)` 寄存器值。
    pub const fn timing(self) -> (u8, u8) {
        match self {
            Self::Kbps5 => (0xBF, 0xFF),
            Self::Kbps10 => (0x31, 0x1C),
            Self::Kbps20 => (0x18, 0x1C),
            Self::Kbps50 => (0x09, 0x1C),
            Self::Kbps100 => (0x04, 0x1C),
            Self::Kbps125 => (0x03, 0x1C),
            Self::Kbps250 => (0x01, 0x1C),
            Self::Kbps500 => (0x00, 0x1C),
            Self::Kbps800 => (0x00, 0x16),
            Self::Kbps1000 => (0x00, 0x14),
        }
    }

    /// 人类可读名称, 如 `500 kbit/s`。
    pub const fn label(self) -> &'static str {
        match self {
            Self::Kbps5 => "5 kbit/s",
            Self::Kbps10 => "10 kbit/s",
            Self::Kbps20 => "20 kbit/s",
            Self::Kbps50 => "50 kbit/s",
            Self::Kbps100 => "100 kbit/s",
            Self::Kbps125 => "125 kbit/s",
            Self::Kbps250 => "250 kbit/s",
            Self::Kbps500 => "500 kbit/s",
            Self::Kbps800 => "800 kbit/s",
            Self::Kbps1000 => "1000 kbit/s",
        }
    }

    /// 速率 (bit/s), 如 `500k` → `500_000`; 用于总线负载估算。
    pub const fn bps(self) -> u64 {
        match self {
            Self::Kbps5 => 5_000,
            Self::Kbps10 => 10_000,
            Self::Kbps20 => 20_000,
            Self::Kbps50 => 50_000,
            Self::Kbps100 => 100_000,
            Self::Kbps125 => 125_000,
            Self::Kbps250 => 250_000,
            Self::Kbps500 => 500_000,
            Self::Kbps800 => 800_000,
            Self::Kbps1000 => 1_000_000,
        }
    }

    /// 短名称 (与 JSON 取值一致), 如 `500k`。
    pub const fn short_label(self) -> &'static str {
        match self {
            Self::Kbps5 => "5k",
            Self::Kbps10 => "10k",
            Self::Kbps20 => "20k",
            Self::Kbps50 => "50k",
            Self::Kbps100 => "100k",
            Self::Kbps125 => "125k",
            Self::Kbps250 => "250k",
            Self::Kbps500 => "500k",
            Self::Kbps800 => "800k",
            Self::Kbps1000 => "1000k",
        }
    }
}

/// 通道工作模式, 对应固件 `Mode` 字段。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CanMode {
    /// 正常收发。
    #[default]
    Normal,
    /// 只听模式 (不产生 ACK)。
    ListenOnly,
    /// 自发自收 (自测)。
    SelfTest,
}

impl CanMode {
    /// 协议中的数值。
    pub const fn as_u8(self) -> u8 {
        match self {
            Self::Normal => 0,
            Self::ListenOnly => 1,
            Self::SelfTest => 2,
        }
    }
}

/// 硬件验收滤波配置。
///
/// 由 CAN 控制器执行: 帧通过条件为
/// `(id & !acc_mask) == (acc_code & !acc_mask)`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct HardwareFilter {
    /// 验收码。
    pub acc_code: u32,
    /// 验收屏蔽码; 位为 1 表示该位不参与比较。
    pub acc_mask: u32,
    /// 滤波方式: 0 = 接收所有, 1 = 单滤波, 2 = 双滤波。
    pub mode: u8,
}

impl Default for HardwareFilter {
    fn default() -> Self {
        Self {
            acc_code: 0,
            acc_mask: u32::MAX,
            mode: 1,
        }
    }
}

impl HardwareFilter {
    /// 校验滤波方式取值范围。
    pub fn validate(&self) -> Result<(), String> {
        if self.mode > 2 {
            return Err(format!("硬件滤波方式必须是 0/1/2, 实际为 {}", self.mode));
        }
        Ok(())
    }

    /// 按单个 CAN ID 构造验收滤波 (固件归一化布局, 已硬件实测)。
    ///
    /// - 标准帧: `acc_code = id << 21`, `acc_mask = 0x001F_FFFF`;
    /// - 扩展帧: `acc_code = id << 3`, `acc_mask = 0x0000_0007`;
    /// - 滤波方式固定为 1 (单滤波)。
    pub fn for_id(id: u32, extended: bool) -> Result<Self, String> {
        let max = if extended { 0x1FFF_FFFF } else { 0x7FF };
        if id > max {
            let kind = if extended { "扩展帧" } else { "标准帧" };
            return Err(format!("{kind} ID 0x{id:X} 超出范围 (最大 0x{max:X})"));
        }
        let (acc_code, acc_mask) = if extended {
            (id << 3, 0x0000_0007)
        } else {
            (id << 21, 0x001F_FFFF)
        };
        Ok(Self {
            acc_code,
            acc_mask,
            mode: 1,
        })
    }

    /// 判断帧是否通过该验收滤波 (用于测试和文档; 设备端会执行同样的比较)。
    ///
    /// 固件比较的是归一化值, 不是裸 ID。
    pub fn accepts(&self, frame: &CanFrame) -> bool {
        let normalized = if frame.extended {
            frame.id << 3
        } else {
            frame.id << 21
        };
        (normalized & !self.acc_mask) == (self.acc_code & !self.acc_mask)
    }
}

/// 设备上报的 CAN 帧。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CanFrame {
    /// 仲裁 ID, 低有效位对齐。
    pub id: u32,
    /// 设备内部 32 位时间戳计数器。
    pub timestamp: u32,
    /// 远程帧 (RTR)。
    pub remote: bool,
    /// 扩展帧 (29 位 ID)。
    pub extended: bool,
    /// 数据长度 0..=8。
    pub dlc: u8,
    /// 8 字节数据缓冲, 有效长度为 `dlc`。
    pub data: [u8; 8],
}

impl CanFrame {
    /// 有效数据切片; 远程帧没有数据负载, 返回空切片。
    pub fn data_bytes(&self) -> &[u8] {
        if self.remote {
            return &[];
        }
        &self.data[..self.dlc.min(8) as usize]
    }
}

/// 板卡信息 (用于前端展示)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DeviceInfo {
    /// 设备在匹配列表中的索引。
    pub index: usize,
    /// 固件版本, 如 `3.51`。
    pub fw_version: String,
    /// 序列号; 设备不提供时为空串。
    pub serial: String,
    /// 硬件型号。
    pub hw_type: String,
    /// 通道数。
    pub channel_count: u8,
}

/// 通道来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChannelSource {
    /// USBCAN 的 CAN1/CAN2。
    Usb,
    /// Linux SocketCAN 链路。
    SocketCan,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn baud_rate_bps_follows_short_labels() {
        for rate in BaudRate::ALL {
            let label = rate.short_label();
            let expected = label.trim_end_matches('k').parse::<u64>().unwrap() * 1_000;
            assert_eq!(rate.bps(), expected, "{label}");
        }
    }
}
