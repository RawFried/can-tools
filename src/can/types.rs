//! 应用层 CAN 类型: API DTO、通道配置、软件滤波与校验。
//!
//! 共享的驱动类型 (帧、波特率、工作模式、硬件滤波、设备/通道描述) 由
//! [`can_core`] 提供并在本模块重导出。JSON 字段名保持 `snake_case`, 与
//! `docs/api.md` 一致。

use serde::{Deserialize, Serialize};

pub use can_core::{BaudRate, CanFrame, CanMode, ChannelSource, DeviceInfo, HardwareFilter};

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

/// 通过 HTTP/WebSocket 暴露给前端的帧。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FrameDto {
    /// 单调递增的接收序号。
    pub seq: u64,
    /// 主机接收时间 (UNIX 毫秒)。
    pub time_ms: u64,
    /// 设备 32 位时间戳。
    pub device_ts: u32,
    /// 通道 id: 0/1 为 USB, `2..=65` 为 SocketCAN 链路。
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

/// 通道编号上限: `0`/`1` 为 USB, `2..=65` 为 SocketCAN 链路 (最多 64 条)。
pub const MAX_CHANNEL: u8 = 65;

/// `/api/devices` 中的 SocketCAN 链路条目。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SocketCanLinkInfo {
    /// 接口名, 如 `can0`。
    pub name: String,
    /// 工作线程分配的通道 id (`2..=65`)。
    pub channel: u8,
    /// sysfs 中读到的速率; 不可见时为 `null`。
    pub bitrate: Option<u64>,
    /// `up` / `down` / `unknown`。
    pub state: String,
    /// 是否有已打开的 socket。
    pub running: bool,
}

/// `GET /api/devices` 的响应: USB 设备列表 + SocketCAN 链路列表。
#[derive(Debug, Clone, Serialize)]
pub struct LinkList {
    /// 匹配的 USB 设备 (设备已打开时只有当前设备)。
    pub devices: Vec<DeviceInfo>,
    /// 已分配通道 id 的 SocketCAN 链路。
    pub socketcan: Vec<SocketCanLinkInfo>,
}

/// `/api/config` 中的一个 USB 通道及其波特率/滤波。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct UsbChannelConfig {
    /// USB 通道索引 (`0` = CAN1, `1` = CAN2)。
    pub index: u8,
    /// 该通道使用的波特率。
    pub baud: BaudRate,
    /// 该通道的硬件验收滤波; 缺省为接收全部。
    #[serde(default)]
    pub filter: HardwareFilter,
    /// 该通道的应用层 ID 区间; 空列表表示接收全部。
    #[serde(default)]
    pub software_filters: Vec<SoftwareFilter>,
}

/// `/api/config` 中的一条 SocketCAN 链路。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SocketCanConfig {
    /// 接口名, 如 `can0`。
    pub name: String,
    /// 自动启用未 UP 接口时使用的速率 (bps); 省略时用默认值。
    #[serde(default)]
    pub bitrate: Option<u32>,
    /// 该链路的应用层 ID 区间; 空列表表示接收全部。
    #[serde(default)]
    pub software_filters: Vec<SoftwareFilter>,
}

impl SocketCanConfig {
    /// 实际生效的速率 (bps)。
    pub fn bitrate_or_default(&self) -> u32 {
        self.bitrate
            .unwrap_or(StartConfig::DEFAULT_SOCKETCAN_BITRATE)
    }
}

/// `/api/config` 请求体 (v5: 每个通道独立配置速率与滤波)。
#[derive(Debug, Clone, Deserialize)]
pub struct StartConfig {
    /// 要配置并启动的 USB 通道 (各带自己的波特率与滤波); 可以为空 (只启动 SocketCAN)。
    #[serde(default)]
    pub usb: Vec<UsbChannelConfig>,
    /// 要启动/重启的 SocketCAN 链路 (各带可选速率与区间)。
    #[serde(default)]
    pub socketcan: Vec<SocketCanConfig>,
    /// 工作模式 (仅作用于 USB 通道)。
    #[serde(default)]
    pub mode: CanMode,
}

impl StartConfig {
    /// 最多允许的软件滤波记录数 (每通道)。
    pub const MAX_SOFTWARE_FILTERS: usize = 16;
    /// 单次请求最多启动的 SocketCAN 链路数。
    pub const MAX_SOCKETCAN_LINKS: usize = 8;
    /// SocketCAN 自动启用速率的默认值 (bps)。
    pub const DEFAULT_SOCKETCAN_BITRATE: u32 = 500_000;

    /// 校验请求参数; 重复的 USB 通道/链路名由调用方去重 (保留首次出现)。
    pub fn validate(&self) -> Result<(), String> {
        if self.usb.is_empty() && self.socketcan.is_empty() {
            return Err("至少选择一个 USB 通道或 SocketCAN 链路".to_string());
        }
        let mut usb_indices: Vec<u8> = Vec::new();
        for entry in &self.usb {
            if entry.index > 1 {
                return Err(format!("非法通道 {}; USB 通道合法值为 0 或 1", entry.index));
            }
            if usb_indices.contains(&entry.index) {
                return Err(format!("USB 通道 {} 重复配置", entry.index));
            }
            usb_indices.push(entry.index);
            entry.filter.validate()?;
            validate_software_filters(&entry.software_filters)?;
        }
        let mut unique_names: Vec<&str> = Vec::new();
        for entry in &self.socketcan {
            crate::can::socketcan::validate_name(&entry.name)?;
            if let Some(bitrate) = entry.bitrate {
                crate::can::socketcan::validate_bitrate(bitrate)?;
            }
            validate_software_filters(&entry.software_filters)?;
            if !unique_names.contains(&entry.name.as_str()) {
                unique_names.push(&entry.name);
            }
        }
        if unique_names.len() > Self::MAX_SOCKETCAN_LINKS {
            return Err(format!(
                "SocketCAN 链路最多 {} 个, 实际 {} 个",
                Self::MAX_SOCKETCAN_LINKS,
                unique_names.len()
            ));
        }
        Ok(())
    }
}

/// 校验一组软件滤波区间: 最多 16 条, 每条区间与 ID 范围合法。
pub fn validate_software_filters(filters: &[SoftwareFilter]) -> Result<(), String> {
    if filters.len() > StartConfig::MAX_SOFTWARE_FILTERS {
        return Err(format!(
            "软件滤波记录最多 {} 条, 实际 {} 条",
            StartConfig::MAX_SOFTWARE_FILTERS,
            filters.len()
        ));
    }
    for filter in filters {
        filter.validate()?;
    }
    Ok(())
}

/// `/api/send` 请求体。
///
/// `data` 支持 `"11 22 33"`、`"112233"`、`"0x11,0x22,0x33"` 等写法。
/// `dlc` 可省略: 数据帧默认等于字节数, 远程帧默认 0。
#[derive(Debug, Clone, Deserialize)]
pub struct SendFrameRequest {
    /// 发送通道: 0/1 为 USB, `2..=65` 为 SocketCAN 链路。
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
        if self.channel > MAX_CHANNEL {
            return Err(format!(
                "非法通道 {}; 合法值为 0/1 (USB) 或 2-{MAX_CHANNEL} (SocketCAN 链路)",
                self.channel
            ));
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

/// `/api/filters` 中单个通道的滤波更新。
#[derive(Debug, Clone, Deserialize)]
pub struct ChannelFilterUpdate {
    /// 通道 id (0/1 为 USB, `2..=65` 为 SocketCAN 链路)。
    pub channel: u8,
    /// 新的硬件验收滤波 (仅 USB 生效; SocketCAN 没有硬件验收滤波, 传入会被忽略)。
    #[serde(default)]
    pub filter: Option<HardwareFilter>,
    /// 新的应用层 ID 区间; 空列表表示接收全部。
    #[serde(default)]
    pub software_filters: Vec<SoftwareFilter>,
}

/// `/api/filters` 请求体: 运行中按通道实时更新滤波。
#[derive(Debug, Clone, Deserialize)]
pub struct FilterUpdateRequest {
    /// 要更新的通道列表; 不能为空, 通道必须运行中且不能重复。
    pub channels: Vec<ChannelFilterUpdate>,
}

impl FilterUpdateRequest {
    /// 校验通道列表与每条滤波参数。
    pub fn validate(&self) -> Result<(), String> {
        if self.channels.is_empty() {
            return Err("至少选择一个通道".to_string());
        }
        let mut seen: Vec<u8> = Vec::new();
        for entry in &self.channels {
            if entry.channel > MAX_CHANNEL {
                return Err(format!(
                    "非法通道 {}; 合法值为 0/1 (USB) 或 2-{MAX_CHANNEL} (SocketCAN 链路)",
                    entry.channel
                ));
            }
            if seen.contains(&entry.channel) {
                return Err(format!("通道 {} 重复", entry.channel));
            }
            seen.push(entry.channel);
            if let Some(filter) = entry.filter {
                filter.validate()?;
            }
            validate_software_filters(&entry.software_filters)?;
        }
        Ok(())
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
        assert_eq!(BaudRate::Kbps250.short_label(), "250k");
        assert_eq!(BaudRate::Kbps1000.short_label(), "1000k");
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

    fn usb_channel(index: u8, baud: BaudRate) -> UsbChannelConfig {
        UsbChannelConfig {
            index,
            baud,
            filter: HardwareFilter::default(),
            software_filters: vec![],
        }
    }

    fn link(name: &str, bitrate: Option<u32>) -> SocketCanConfig {
        SocketCanConfig {
            name: name.to_string(),
            bitrate,
            software_filters: vec![],
        }
    }

    fn range(start: u32, end: u32) -> SoftwareFilter {
        SoftwareFilter {
            extended: false,
            start,
            end,
        }
    }

    fn request(usb: Vec<UsbChannelConfig>, socketcan: Vec<SocketCanConfig>) -> StartConfig {
        StartConfig {
            usb,
            socketcan,
            mode: CanMode::Normal,
        }
    }

    #[test]
    fn start_config_rejects_unknown_channel() {
        let config = request(vec![usb_channel(2, BaudRate::Kbps500)], vec![]);
        let error = config.validate().unwrap_err();
        assert!(error.contains("非法通道 2"), "{error}");
    }

    #[test]
    fn start_config_rejects_duplicate_usb_channel() {
        let config = request(
            vec![
                usb_channel(0, BaudRate::Kbps500),
                usb_channel(0, BaudRate::Kbps250),
            ],
            vec![],
        );
        let error = config.validate().unwrap_err();
        assert_eq!(error, "USB 通道 0 重复配置");
    }

    #[test]
    fn start_config_allows_independent_usb_baud_rates() {
        let config = request(
            vec![
                usb_channel(0, BaudRate::Kbps500),
                usb_channel(1, BaudRate::Kbps250),
            ],
            vec![],
        );
        assert!(config.validate().is_ok());
        assert_eq!(config.usb[0].baud, BaudRate::Kbps500);
        assert_eq!(config.usb[1].baud, BaudRate::Kbps250);
    }

    #[test]
    fn start_config_requires_usb_or_socketcan() {
        let config = request(vec![], vec![]);
        let error = config.validate().unwrap_err();
        assert!(
            error.contains("至少选择一个 USB 通道或 SocketCAN 链路"),
            "{error}"
        );
    }

    #[test]
    fn start_config_accepts_socketcan_without_usb_channels() {
        let config = request(vec![], vec![link("can0", None)]);
        assert!(config.validate().is_ok());
    }

    #[test]
    fn start_config_validates_socketcan_names_and_count() {
        let base = request(vec![], vec![link("can 0", None)]);
        let error = base.validate().unwrap_err();
        assert!(error.contains("非法字符"), "{error}");

        let duplicated = request(
            vec![],
            vec![link("can0", None); StartConfig::MAX_SOCKETCAN_LINKS + 1],
        );
        assert!(duplicated.validate().is_ok());

        let too_many = request(
            vec![],
            (0..StartConfig::MAX_SOCKETCAN_LINKS + 1)
                .map(|index| link(&format!("can{index}"), None))
                .collect(),
        );
        assert!(too_many.validate().is_err());
    }

    #[test]
    fn start_config_validates_socketcan_bitrate() {
        for bad in [0_u32, 999, 1_000_001] {
            let config = request(vec![], vec![link("can0", Some(bad))]);
            let error = config.validate().unwrap_err();
            assert!(error.contains("SocketCAN 速率"), "{error}");
        }
        assert!(request(vec![], vec![link("can0", Some(1_000))])
            .validate()
            .is_ok());
        assert!(request(vec![], vec![link("can0", Some(1_000_000))])
            .validate()
            .is_ok());
        assert_eq!(link("can0", None).bitrate_or_default(), 500_000);
        assert_eq!(link("can0", Some(125_000)).bitrate_or_default(), 125_000);
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
            serde_json::from_str(r#"{"usb":[{"index":0,"baud":"500k"}]}"#).unwrap();
        assert_eq!(config.mode, CanMode::Normal);
        assert!(config.socketcan.is_empty());
        assert_eq!(config.usb.len(), 1);
        assert_eq!(config.usb[0].index, 0);
        assert_eq!(config.usb[0].baud, BaudRate::Kbps500);
        // 每通道滤波可省略: 缺省为接收全部。
        assert_eq!(config.usb[0].filter, HardwareFilter::default());
        assert!(config.usb[0].software_filters.is_empty());
    }

    #[test]
    fn start_config_deserializes_per_channel_rates_and_filters() {
        let config: StartConfig = serde_json::from_str(
            r#"{
                "usb": [
                    {"index": 0, "baud": "500k",
                     "filter": {"acc_code": 0, "acc_mask": 4294967295, "mode": 1},
                     "software_filters": [{"extended": false, "start": 256, "end": 511}]},
                    {"index": 1, "baud": "250k"}
                ],
                "socketcan": [
                    {"name": "can0", "bitrate": 125000,
                     "software_filters": [{"extended": false, "start": 512, "end": 767}]},
                    {"name": "vcan0"}
                ],
                "mode": "listen_only"
            }"#,
        )
        .unwrap();
        assert_eq!(config.usb[0].baud, BaudRate::Kbps500);
        assert_eq!(config.usb[1].baud, BaudRate::Kbps250);
        assert_eq!(config.usb[0].software_filters, vec![range(256, 511)]);
        assert!(config.usb[1].software_filters.is_empty());
        assert_eq!(config.socketcan[0].bitrate, Some(125_000));
        assert_eq!(config.socketcan[0].software_filters, vec![range(512, 767)]);
        assert_eq!(config.socketcan[1].bitrate, None);
        assert!(config.socketcan[1].software_filters.is_empty());
        assert_eq!(config.socketcan[1].bitrate_or_default(), 500_000);
        assert_eq!(config.mode, CanMode::ListenOnly);
        assert!(config.validate().is_ok());
    }

    #[test]
    fn start_config_ignores_legacy_fields() {
        // 旧字段被 serde 忽略: 解析成功, 但没有任何 usb/socketcan 条目, 校验失败。
        let legacy: StartConfig =
            serde_json::from_str(r#"{"channels":[0],"baud":"500k","socketcan_bitrate":500000}"#)
                .unwrap();
        assert!(legacy.usb.is_empty() && legacy.socketcan.is_empty());
        assert!(legacy.validate().is_err());

        // 旧式字符串数组不再是合法的 socketcan 形状。
        assert!(serde_json::from_str::<StartConfig>(r#"{"socketcan":["can0"]}"#).is_err());
    }

    #[test]
    fn start_config_validates_filters_per_channel() {
        let mut usb = usb_channel(0, BaudRate::Kbps500);
        usb.software_filters = vec![range(0, 0x7FF); StartConfig::MAX_SOFTWARE_FILTERS + 1];
        let error = request(vec![usb], vec![]).validate().unwrap_err();
        assert!(error.contains("软件滤波记录最多"), "{error}");

        let mut usb = usb_channel(0, BaudRate::Kbps500);
        usb.software_filters = vec![range(0x200, 0x100)];
        assert!(request(vec![usb], vec![]).validate().is_err());

        let mut usb = usb_channel(0, BaudRate::Kbps500);
        usb.filter = HardwareFilter {
            mode: 3,
            ..HardwareFilter::default()
        };
        assert!(request(vec![usb], vec![]).validate().is_err());

        let mut link_config = link("can0", None);
        link_config.software_filters = vec![range(0, 0x800)];
        assert!(request(vec![], vec![link_config]).validate().is_err());

        let mut link_config = link("can0", None);
        link_config.software_filters = vec![range(0, 0x7FF); StartConfig::MAX_SOFTWARE_FILTERS + 1];
        assert!(request(vec![], vec![link_config]).validate().is_err());

        // 两个通道各自的区间互不影响。
        let mut first = usb_channel(0, BaudRate::Kbps500);
        first.software_filters = vec![range(0x100, 0x1FF)];
        let mut second = usb_channel(1, BaudRate::Kbps250);
        second.software_filters = vec![range(0x200, 0x2FF)];
        let config = request(vec![first, second], vec![]);
        assert!(config.validate().is_ok());
        assert_eq!(config.usb[0].software_filters, vec![range(0x100, 0x1FF)]);
        assert_eq!(config.usb[1].software_filters, vec![range(0x200, 0x2FF)]);
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
        assert!(SendFrameRequest {
            channel: MAX_CHANNEL + 1,
            ..base.clone()
        }
        .to_frame()
        .is_err());
        // SocketCAN 通道 (2..=65) 允许通过帧构造校验, 运行状态由工作线程判断。
        assert!(SendFrameRequest { channel: 2, ..base }.to_frame().is_ok());
    }

    #[test]
    fn filter_update_request_validates_channels_and_filters() {
        let valid = FilterUpdateRequest {
            channels: vec![
                ChannelFilterUpdate {
                    channel: 0,
                    filter: Some(HardwareFilter::default()),
                    software_filters: vec![range(0, 0x7FF)],
                },
                ChannelFilterUpdate {
                    channel: 2,
                    filter: None,
                    software_filters: vec![range(0x100, 0x1FF)],
                },
            ],
        };
        assert!(valid.validate().is_ok());

        // 空列表不再表示"全局更新"。
        let error = FilterUpdateRequest { channels: vec![] }
            .validate()
            .unwrap_err();
        assert_eq!(error, "至少选择一个通道");

        let error = FilterUpdateRequest {
            channels: vec![
                ChannelFilterUpdate {
                    channel: 0,
                    filter: None,
                    software_filters: vec![],
                },
                ChannelFilterUpdate {
                    channel: 0,
                    filter: None,
                    software_filters: vec![],
                },
            ],
        }
        .validate()
        .unwrap_err();
        assert_eq!(error, "通道 0 重复");

        assert!(FilterUpdateRequest {
            channels: vec![ChannelFilterUpdate {
                channel: MAX_CHANNEL + 1,
                filter: None,
                software_filters: vec![],
            }],
        }
        .validate()
        .is_err());

        assert!(FilterUpdateRequest {
            channels: vec![ChannelFilterUpdate {
                channel: 0,
                filter: Some(HardwareFilter {
                    mode: 3,
                    ..HardwareFilter::default()
                }),
                software_filters: vec![],
            }],
        }
        .validate()
        .is_err());

        assert!(FilterUpdateRequest {
            channels: vec![ChannelFilterUpdate {
                channel: 0,
                filter: None,
                software_filters: vec![range(0x200, 0x100)],
            }],
        }
        .validate()
        .is_err());

        assert!(FilterUpdateRequest {
            channels: vec![ChannelFilterUpdate {
                channel: 2,
                filter: None,
                software_filters: vec![range(0, 0x7FF); StartConfig::MAX_SOFTWARE_FILTERS + 1],
            }],
        }
        .validate()
        .is_err());
    }
}
