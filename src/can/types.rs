//! CAN 领域类型: 帧、波特率、通道配置与滤波记录。
//!
//! 这些类型既用于 USB 驱动层, 也用于 HTTP/WebSocket 序列化。JSON 字段名保持
//! `snake_case`, 与 `docs/api.md` 一致。

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

/// 应用层 ID 区间滤波记录。
///
/// 硬件滤波之后执行: ID 落在 `[start, end]` 且标准/扩展属性一致的帧被保留。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SoftwareFilter {
    /// 是否匹配扩展帧 (29 位 ID)。
    pub extended: bool,
    /// 起始 ID (含)。
    pub start: u32,
    /// 结束 ID (含)。
    pub end: u32,
}

impl SoftwareFilter {
    /// ID 上界: 标准帧 11 位, 扩展帧 29 位。
    pub const fn max_id(extended: bool) -> u32 {
        if extended {
            0x1FFF_FFFF
        } else {
            0x7FF
        }
    }

    /// 判断帧是否命中本记录。
    pub fn matches(&self, frame: &CanFrame) -> bool {
        self.extended == frame.extended && frame.id >= self.start && frame.id <= self.end
    }

    /// 校验区间与 ID 范围。
    pub fn validate(&self) -> Result<(), String> {
        let max = Self::max_id(self.extended);
        if self.start > self.end {
            return Err(format!(
                "软件滤波区间起始 ID 0x{:X} 大于结束 ID 0x{:X}",
                self.start, self.end
            ));
        }
        if self.end > max {
            let kind = if self.extended {
                "扩展帧"
            } else {
                "标准帧"
            };
            return Err(format!(
                "{kind} ID 0x{:X} 超出范围 (最大 0x{max:X})",
                self.end
            ));
        }
        Ok(())
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

/// 通过 HTTP/WebSocket 暴露给前端的帧。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FrameDto {
    /// 单调递增的接收序号。
    pub seq: u64,
    /// 主机接收时间 (UNIX 毫秒)。
    pub time_ms: u64,
    /// 设备 32 位时间戳。
    pub device_ts: u32,
    /// 通道索引 (0 = CAN1, 1 = CAN2)。
    pub channel: u8,
    /// 仲裁 ID。
    pub id: u32,
    /// 是否扩展帧。
    pub extended: bool,
    /// 是否远程帧。
    pub remote: bool,
    /// 数据长度。
    pub dlc: u8,
    /// 大写十六进制字节串, 以单个空格分隔; 无数据时为空串。
    pub data: String,
}

impl FrameDto {
    /// 由驱动帧构造前端帧。
    pub fn new(seq: u64, time_ms: u64, channel: u8, frame: &CanFrame) -> Self {
        Self {
            seq,
            time_ms,
            device_ts: frame.timestamp,
            channel,
            id: frame.id,
            extended: frame.extended,
            remote: frame.remote,
            dlc: frame.dlc,
            data: format_data(frame.data_bytes()),
        }
    }
}

/// 将字节切片格式化为 `11 22 33` 形式。
pub fn format_data(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(" ")
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

/// `/api/config` 请求体。
#[derive(Debug, Clone, Deserialize)]
pub struct StartConfig {
    /// 要配置并启动的通道, 如 `[0, 1]`。
    pub channels: Vec<u8>,
    /// 波特率。
    pub baud: BaudRate,
    /// 工作模式。
    #[serde(default)]
    pub mode: CanMode,
    /// 硬件验收滤波。
    #[serde(default)]
    pub filter: HardwareFilter,
    /// 应用层 ID 滤波。
    #[serde(default)]
    pub software_filters: Vec<SoftwareFilter>,
}

impl StartConfig {
    /// 最多允许的软件滤波记录数。
    pub const MAX_SOFTWARE_FILTERS: usize = 16;

    /// 校验请求参数; 通道去重由调用方处理。
    pub fn validate(&self) -> Result<(), String> {
        if self.channels.is_empty() {
            return Err("至少选择一个通道".to_string());
        }
        for &channel in &self.channels {
            if channel > 1 {
                return Err(format!("非法通道 {channel}; 合法值为 0 或 1"));
            }
        }
        self.filter.validate()?;
        if self.software_filters.len() > Self::MAX_SOFTWARE_FILTERS {
            return Err(format!(
                "软件滤波记录最多 {} 条, 实际 {} 条",
                Self::MAX_SOFTWARE_FILTERS,
                self.software_filters.len()
            ));
        }
        for filter in &self.software_filters {
            filter.validate()?;
        }
        Ok(())
    }
}

/// `/api/send` 请求体。
///
/// `data` 支持 `"11 22 33"`、`"112233"`、`"0x11,0x22,0x33"` 等写法。
/// `dlc` 可省略: 数据帧默认等于字节数, 远程帧默认 0。
#[derive(Debug, Clone, Deserialize)]
pub struct SendFrameRequest {
    /// 发送通道 (0 = CAN1, 1 = CAN2)。
    pub channel: u8,
    /// 仲裁 ID。
    pub id: u32,
    /// 是否扩展帧。
    #[serde(default)]
    pub extended: bool,
    /// 是否远程帧 (无数据负载)。
    #[serde(default)]
    pub remote: bool,
    /// 数据长度; 数据帧必须等于字节数。
    #[serde(default)]
    pub dlc: Option<u8>,
    /// 十六进制数据串。
    #[serde(default)]
    pub data: String,
}

impl SendFrameRequest {
    /// CAN 2.0 单帧最大数据字节数。
    pub const MAX_DATA_LEN: usize = 8;

    /// 校验并转换为驱动帧。
    pub fn to_frame(&self) -> Result<CanFrame, String> {
        if self.channel > 1 {
            return Err(format!("非法通道 {}; 合法值为 0 或 1", self.channel));
        }
        let max_id = if self.extended { 0x1FFF_FFFF } else { 0x7FF };
        if self.id > max_id {
            let kind = if self.extended {
                "扩展帧"
            } else {
                "标准帧"
            };
            return Err(format!(
                "{kind} ID 0x{:X} 超出范围 (最大 0x{max_id:X})",
                self.id
            ));
        }
        let bytes = parse_hex_data(&self.data)?;
        if bytes.len() > Self::MAX_DATA_LEN {
            return Err(format!(
                "数据最多 {} 字节, 实际 {} 字节",
                Self::MAX_DATA_LEN,
                bytes.len()
            ));
        }

        let mut data = [0u8; 8];
        if self.remote {
            if !bytes.is_empty() {
                return Err("远程帧不能携带数据".to_string());
            }
            let dlc = self.dlc.unwrap_or(0);
            if dlc > Self::MAX_DATA_LEN as u8 {
                return Err(format!("DLC 必须在 0-8 之间, 实际 {dlc}"));
            }
            return Ok(CanFrame {
                id: self.id,
                timestamp: 0,
                remote: true,
                extended: self.extended,
                dlc,
                data,
            });
        }

        let dlc = self.dlc.unwrap_or(bytes.len() as u8);
        if dlc as usize != bytes.len() {
            return Err(format!("DLC {dlc} 必须等于数据字节数 {}", bytes.len()));
        }
        data[..bytes.len()].copy_from_slice(&bytes);
        Ok(CanFrame {
            id: self.id,
            timestamp: 0,
            remote: false,
            extended: self.extended,
            dlc,
            data,
        })
    }
}

/// 解析十六进制数据串。
///
/// 支持空格/逗号/冒号分隔的字节 (可带 `0x` 前缀), 也支持连续十六进制串。
pub fn parse_hex_data(raw: &str) -> Result<Vec<u8>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let separated = trimmed
        .split(|character: char| {
            character.is_ascii_whitespace() || character == ',' || character == ':'
        })
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();

    if separated.len() > 1 {
        let mut bytes = Vec::with_capacity(separated.len());
        for token in separated {
            let token = token
                .strip_prefix("0x")
                .or_else(|| token.strip_prefix("0X"))
                .unwrap_or(token);
            if token.is_empty() || token.len() > 2 || !token.chars().all(|c| c.is_ascii_hexdigit())
            {
                return Err(format!("非法十六进制字节: {token}"));
            }
            bytes.push(
                u8::from_str_radix(token, 16).map_err(|_| format!("非法十六进制字节: {token}"))?,
            );
        }
        return Ok(bytes);
    }

    let cleaned = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed);
    if cleaned.len() % 2 != 0 {
        return Err("连续十六进制数据必须为偶数个字符".to_string());
    }
    if !cleaned.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("数据包含非十六进制字符".to_string());
    }
    let bytes = (0..cleaned.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&cleaned[index..index + 2], 16)
                .map_err(|_| "数据包含非法十六进制字符".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn baud_timing_matches_reference_table() {
        assert_eq!(BaudRate::Kbps125.timing(), (0x03, 0x1C));
        assert_eq!(BaudRate::Kbps500.timing(), (0x00, 0x1C));
        assert_eq!(BaudRate::Kbps1000.timing(), (0x00, 0x14));
        assert_eq!(BaudRate::Kbps5.timing(), (0xBF, 0xFF));
    }

    #[test]
    fn baud_serde_uses_short_labels() {
        let json = serde_json::to_string(&BaudRate::Kbps500).unwrap();
        assert_eq!(json, "\"500k\"");
        let parsed: BaudRate = serde_json::from_str("\"1000k\"").unwrap();
        assert_eq!(parsed, BaudRate::Kbps1000);
    }

    #[test]
    fn software_filter_matches_range_and_frame_kind() {
        let filter = SoftwareFilter {
            extended: false,
            start: 0x100,
            end: 0x1FF,
        };
        let mut frame = CanFrame {
            id: 0x123,
            ..Default::default()
        };
        assert!(filter.matches(&frame));
        frame.id = 0x200;
        assert!(!filter.matches(&frame));
        frame.id = 0x123;
        frame.extended = true;
        assert!(!filter.matches(&frame));
    }

    #[test]
    fn software_filter_validation_rejects_bad_ranges() {
        let reversed = SoftwareFilter {
            extended: false,
            start: 0x200,
            end: 0x100,
        };
        assert!(reversed.validate().is_err());
        let out_of_range = SoftwareFilter {
            extended: false,
            start: 0,
            end: 0x800,
        };
        assert!(out_of_range.validate().is_err());
        let extended_ok = SoftwareFilter {
            extended: true,
            start: 0,
            end: 0x1FFF_FFFF,
        };
        assert!(extended_ok.validate().is_ok());
    }

    #[test]
    fn start_config_rejects_unknown_channel() {
        let config = StartConfig {
            channels: vec![2],
            baud: BaudRate::Kbps500,
            mode: CanMode::Normal,
            filter: HardwareFilter::default(),
            software_filters: vec![],
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn frame_dto_formats_data_as_hex_pairs() {
        let frame = CanFrame {
            id: 0x123,
            dlc: 3,
            data: [0x0A, 0xFF, 0x01, 0, 0, 0, 0, 0],
            ..Default::default()
        };
        let dto = FrameDto::new(7, 1_700_000_000_000, 0, &frame);
        assert_eq!(dto.data, "0A FF 01");
        assert_eq!(dto.seq, 7);
    }

    #[test]
    fn start_config_deserializes_defaults() {
        let config: StartConfig =
            serde_json::from_str(r#"{"channels":[0],"baud":"500k"}"#).unwrap();
        assert_eq!(config.mode, CanMode::Normal);
        assert_eq!(config.filter, HardwareFilter::default());
        assert!(config.software_filters.is_empty());
    }

    #[test]
    fn start_config_rejects_too_many_software_filters() {
        let filter = SoftwareFilter {
            extended: false,
            start: 0,
            end: 0x7FF,
        };
        let config = StartConfig {
            channels: vec![0],
            baud: BaudRate::Kbps500,
            mode: CanMode::Normal,
            filter: HardwareFilter::default(),
            software_filters: vec![filter; StartConfig::MAX_SOFTWARE_FILTERS + 1],
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn hardware_filter_for_id_uses_normalized_layout() {
        let standard = HardwareFilter::for_id(0x123, false).unwrap();
        assert_eq!(standard.acc_code, 0x123 << 21);
        assert_eq!(standard.acc_mask, 0x001F_FFFF);
        assert_eq!(standard.mode, 1);
        let frame = CanFrame {
            id: 0x123,
            ..Default::default()
        };
        assert!(standard.accepts(&frame));
        let other = CanFrame {
            id: 0x124,
            ..Default::default()
        };
        assert!(!standard.accepts(&other));

        let extended = HardwareFilter::for_id(0x18FF_50E5, true).unwrap();
        assert_eq!(extended.acc_code, 0x18FF_50E5 << 3);
        assert_eq!(extended.acc_mask, 0x0000_0007);
        let frame = CanFrame {
            id: 0x18FF_50E5,
            extended: true,
            ..Default::default()
        };
        assert!(extended.accepts(&frame));
        let other = CanFrame {
            id: 0x18FF_50E6,
            extended: true,
            ..Default::default()
        };
        assert!(!extended.accepts(&other));
    }

    #[test]
    fn hardware_filter_for_id_rejects_out_of_range_ids() {
        assert!(HardwareFilter::for_id(0x800, false).is_err());
        assert!(HardwareFilter::for_id(0x2000_0000, true).is_err());
    }

    #[test]
    fn parse_hex_data_accepts_common_forms() {
        assert_eq!(parse_hex_data("11 22 33").unwrap(), vec![0x11, 0x22, 0x33]);
        assert_eq!(parse_hex_data("112233").unwrap(), vec![0x11, 0x22, 0x33]);
        assert_eq!(
            parse_hex_data("0x11,0x22:0x33").unwrap(),
            vec![0x11, 0x22, 0x33]
        );
        assert_eq!(parse_hex_data("  ").unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn parse_hex_data_rejects_invalid_input() {
        assert!(parse_hex_data("1 234").is_err());
        assert!(parse_hex_data("ZZ").is_err());
        assert!(parse_hex_data("123").is_err());
    }

    #[test]
    fn send_request_builds_data_and_remote_frames() {
        let request = SendFrameRequest {
            channel: 0,
            id: 0x123,
            extended: false,
            remote: false,
            dlc: None,
            data: "11 22 33".to_string(),
        };
        let frame = request.to_frame().unwrap();
        assert_eq!(frame.id, 0x123);
        assert_eq!(frame.dlc, 3);
        assert_eq!(frame.data_bytes(), &[0x11, 0x22, 0x33]);
        assert!(!frame.remote && !frame.extended);

        let remote = SendFrameRequest {
            channel: 1,
            id: 0x18FF_50E5,
            extended: true,
            remote: true,
            dlc: Some(8),
            data: String::new(),
        };
        let frame = remote.to_frame().unwrap();
        assert!(frame.remote && frame.extended);
        assert_eq!(frame.dlc, 8);
        assert!(frame.data_bytes().is_empty());
    }

    #[test]
    fn send_request_rejects_invalid_combinations() {
        let base = SendFrameRequest {
            channel: 0,
            id: 0x123,
            extended: false,
            remote: false,
            dlc: None,
            data: "11 22".to_string(),
        };
        assert!(SendFrameRequest {
            dlc: Some(1),
            ..base.clone()
        }
        .to_frame()
        .is_err());
        assert!(SendFrameRequest {
            data: "11 22 33 44 55 66 77 88 99".to_string(),
            ..base.clone()
        }
        .to_frame()
        .is_err());
        assert!(SendFrameRequest {
            remote: true,
            ..base.clone()
        }
        .to_frame()
        .is_err());
        assert!(SendFrameRequest {
            id: 0x800,
            ..base.clone()
        }
        .to_frame()
        .is_err());
        assert!(SendFrameRequest { channel: 2, ..base }.to_frame().is_err());
    }
}
