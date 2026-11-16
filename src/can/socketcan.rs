//! SocketCAN 链路: sysfs 接口发现、名称校验、自动启用与帧收发封装。
//!
//! 链路与 USB 通道并行工作, 共用一个帧缓冲/录制/统计。所有 socket/netlink 细节都走
//! [`socketcan`] crate, 本模块不直接调用 `libc`, 也不使用 `unsafe`。
//!
//! 注意: `/sys/class/net` 的内容跟随**挂载时**的 netns。新建 netns 里的接口
//! (如 `vcan0`) 通常不在 sysfs 中, 因此"按名字启动链路"只依赖
//! `if_nametoindex`/bind 的成败, sysfs 仅用于展示与状态刷新。

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use socketcan::{
    CanAddr, CanFrame as SocketFrame, CanInterface, CanSocket, EmbeddedFrame, Frame, Socket,
};

use crate::can::types::{CanFrame, ChannelSource, HardwareFilter};
use crate::can::{CanChannel, ChannelConfig};

/// sysfs 网络设备目录 (可通过 [`list_interfaces`] 的参数替换, 便于测试)。
pub const SYSFS_NET: &str = "/sys/class/net";
/// `ARPHRD_CAN` 的 sysfs `type` 值。
pub const ARPHRD_CAN: u64 = 280;
/// Linux 接口名最大长度 (`IFNAMSIZ - 1`)。
pub const MAX_NAME_LEN: usize = 15;
/// 自动启用时允许的最小速率 (bps)。
pub const MIN_BITRATE: u32 = 1_000;
/// 自动启用时允许的最大速率 (bps)。
pub const MAX_BITRATE: u32 = 1_000_000;
/// `IFF_UP` 在 sysfs `flags` 中的位。
const IFF_UP: u64 = 0x1;

/// sysfs 中发现的 SocketCAN 接口。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SocketCanInfo {
    /// 接口名, 如 `can0`。
    pub name: String,
    /// 是否已启用 (`flags & IFF_UP`)。
    pub up: bool,
    /// `can_bittiming/bitrate`; 接口未配置速率时为 `None`。
    pub bitrate: Option<u64>,
}

/// 扫描 sysfs 中的 CAN 接口, 按名字升序返回。
///
/// 目录不存在、条目读失败、`type != 280` 的接口都会被跳过, 不返回错误:
/// 发现失败不应阻塞 USB 侧功能。
pub fn list_interfaces(sysfs_root: &Path) -> Vec<SocketCanInfo> {
    let Ok(entries) = fs::read_dir(sysfs_root) else {
        return Vec::new();
    };
    let mut infos = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if name.is_empty() || name.len() > MAX_NAME_LEN {
            continue;
        }
        let Some(kind) = read_trimmed(&path.join("type")).and_then(|raw| raw.parse::<u64>().ok())
        else {
            continue;
        };
        if kind != ARPHRD_CAN {
            continue;
        }
        let Some(flags) = read_trimmed(&path.join("flags")).and_then(|raw| parse_flags(&raw))
        else {
            continue;
        };
        let bitrate = read_trimmed(&path.join("can_bittiming/bitrate"))
            .and_then(|raw| raw.parse::<u64>().ok());
        infos.push(SocketCanInfo {
            name: name.to_string(),
            up: flags & IFF_UP != 0,
            bitrate,
        });
    }
    infos.sort_by(|left, right| left.name.cmp(&right.name));
    infos
}

/// 校验接口名: 1–15 个 `[A-Za-z0-9_.-]` 字符。
pub fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("SocketCAN 接口名不能为空".to_string());
    }
    if name.len() > MAX_NAME_LEN {
        return Err(format!(
            "SocketCAN 接口名最多 {MAX_NAME_LEN} 个字符, 实际 {} 个",
            name.len()
        ));
    }
    if !name.bytes().all(is_name_byte) {
        return Err(format!(
            "SocketCAN 接口名 {name} 含非法字符; 只允许字母、数字、下划线、点和连字符"
        ));
    }
    Ok(())
}

/// 把 sysfs 的 `up` 标志映射为状态字符串。
pub fn state_label(up: bool) -> &'static str {
    if up {
        "up"
    } else {
        "down"
    }
}

/// 校验自动启用使用的速率范围 (1000–1000000 bps)。
pub fn validate_bitrate(bitrate: u32) -> Result<(), String> {
    if !(MIN_BITRATE..=MAX_BITRATE).contains(&bitrate) {
        return Err(format!(
            "SocketCAN 速率必须在 {MIN_BITRATE}-{MAX_BITRATE} bps 之间, 实际 {bitrate}"
        ));
    }
    Ok(())
}

/// 判断 netlink 错误是否为权限不足 (`EPERM`)。
///
/// neli 把内核错误渲染成 `Error response received from netlink: <errno 文本>`,
/// 因此同时匹配 errno 文案与 `(os error N)` 形式。
pub fn is_permission_error(message: &str) -> bool {
    message.contains("Operation not permitted") || message.contains("(os error 1)")
}

/// 判断 netlink 错误是否为"不支持" (`EOPNOTSUPP`)。
///
/// 虚拟接口 (vcan) 不支持 `can_bittiming`, 设置速率会返回该错误, 属预期。
pub fn is_unsupported_error(message: &str) -> bool {
    message.contains("Operation not supported") || message.contains("(os error 95)")
}

/// 自动启用 SocketCAN 接口, 并把速率设为 `bitrate` (bps)。
///
/// 接口已 UP 时直接返回成功, **不执行任何特权操作** (非 root 也能正常使用);
/// 未 UP 时依次设置速率与 UP 标志, 需要 root 或 `CAP_NET_ADMIN`。
/// vcan 等不支持速率配置的接口会忽略 `EOPNOTSUPP` 并继续启用。
pub fn bring_up(name: &str, bitrate: u32) -> Result<(), String> {
    validate_name(name)?;
    validate_bitrate(bitrate)?;
    let interface = CanInterface::open(name)
        .map_err(|error| format!("SocketCAN 接口 {name} 不存在: {error}"))?;
    let details = interface
        .details()
        .map_err(|error| format!("读取 SocketCAN 接口 {name} 状态失败: {error}"))?;
    if details.is_up {
        return Ok(());
    }
    if let Err(error) = interface.set_bitrate(bitrate, None::<u32>) {
        let message = error.to_string();
        if !is_unsupported_error(&message) {
            return Err(enable_error(name, bitrate, "设置速率", &message));
        }
    }
    interface
        .bring_up()
        .map_err(|error| enable_error(name, bitrate, "启用", &error.to_string()))
}

/// 把 netlink 失败转换为可操作的中文错误; 权限不足时附带手动命令。
fn enable_error(name: &str, bitrate: u32, action: &str, message: &str) -> String {
    if is_permission_error(message) {
        format!(
            "启用 SocketCAN 接口 {name} 需要 root 或 CAP_NET_ADMIN 权限: \
             请以管理员身份运行，或手动执行 ip link set {name} up type can bitrate {bitrate}"
        )
    } else {
        format!("{action} SocketCAN 接口 {name} 失败: {message}")
    }
}

/// 一条已打开的 SocketCAN 链路。
pub struct SocketCanLink {
    socket: CanSocket,
    name: String,
    bitrate: Option<u64>,
    state: &'static str,
}

impl SocketCanLink {
    /// 打开接口并切换到非阻塞模式。
    ///
    /// 调用方应先用 [`bring_up`] 确保接口已启用; 本函数只负责打开 socket,
    /// 并从 sysfs 读取 `state`/`bitrate` 供界面展示 (sysfs 不可见时为
    /// `unknown`/`None`)。
    pub fn open(name: &str) -> Result<Self, String> {
        validate_name(name)?;
        let info = list_interfaces(Path::new(SYSFS_NET))
            .into_iter()
            .find(|info| info.name == name);
        let address = CanAddr::from_iface(name)
            .map_err(|error| format!("SocketCAN 接口 {name} 不存在: {error}"))?;
        let socket = CanSocket::open_addr(&address)
            .map_err(|error| format!("打开 SocketCAN 接口 {name} 失败: {error}"))?;
        socket
            .set_nonblocking(true)
            .map_err(|error| format!("设置 SocketCAN 接口 {name} 非阻塞失败: {error}"))?;
        let state = match info.as_ref() {
            Some(info) => state_label(info.up),
            None => "unknown",
        };
        Ok(Self {
            socket,
            name: name.to_string(),
            bitrate: info.and_then(|info| info.bitrate),
            state,
        })
    }

    /// 接口名。
    pub fn name(&self) -> &str {
        &self.name
    }

    /// sysfs 中读到的速率; 不可见时为 `None`。
    pub fn bitrate(&self) -> Option<u64> {
        self.bitrate
    }

    /// 打开时的接口状态: `up` / `unknown`。
    pub fn state(&self) -> &'static str {
        self.state
    }
}

impl CanChannel for SocketCanLink {
    fn source(&self) -> ChannelSource {
        ChannelSource::SocketCan
    }

    fn name(&self) -> &str {
        &self.name
    }

    fn config(&self) -> ChannelConfig {
        ChannelConfig::SocketCan {
            bitrate: self.bitrate,
            state: self.state.to_string(),
        }
    }

    /// 非阻塞读取最多 `max` 帧; 错误帧被丢弃, 远程帧正常转换。
    ///
    /// 返回的错误由调用方负责关闭链路并写日志, 本方法不改变链路状态。
    fn read(&mut self, max: usize) -> Result<Vec<CanFrame>, String> {
        let mut frames = Vec::new();
        while frames.len() < max {
            match self.socket.read_frame() {
                Ok(frame) => {
                    if let Some(frame) = to_project_frame(&frame) {
                        frames.push(frame);
                    }
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(error) => return Err(error.to_string()),
            }
        }
        Ok(frames)
    }

    /// 向链路写入一帧。
    fn write(&mut self, frame: &CanFrame) -> Result<(), String> {
        let socket_frame = to_socket_frame(frame)?;
        self.socket
            .write_frame(&socket_frame)
            .map_err(|error| error.to_string())
    }

    /// 停止链路: 本实现不发送任何命令, socket 随 [`SocketCanLink`] 被丢弃而关闭。
    fn stop(&mut self) -> Result<(), String> {
        Ok(())
    }

    /// 接口仍存在时返回 `true`; 链路失效也由 [`CanChannel::read`] 的错误上报。
    fn is_alive(&self) -> bool {
        CanAddr::from_iface(&self.name).is_ok()
    }

    /// SocketCAN 没有硬件验收滤波, 只支持上层软件区间。
    fn update_hardware_filter(&mut self, _filter: &HardwareFilter) -> Result<(), String> {
        Err("SocketCAN 链路只支持软件滤波".to_string())
    }
}

fn read_trimmed(path: &Path) -> Option<String> {
    fs::read_to_string(path)
        .ok()
        .map(|text| text.trim().to_string())
}

/// 解析 sysfs `flags`; 内核输出为 `0x...` 十六进制。
fn parse_flags(raw: &str) -> Option<u64> {
    let raw = raw.trim();
    match raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X")) {
        Some(hex) => u64::from_str_radix(hex, 16).ok(),
        None => raw.parse::<u64>().ok(),
    }
}

fn is_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-')
}

/// SocketCAN 帧 → 项目帧; 错误帧返回 `None` (丢弃)。
fn to_project_frame(frame: &SocketFrame) -> Option<CanFrame> {
    if frame.is_error_frame() {
        return None;
    }
    let payload = frame.data();
    let length = payload.len().min(8);
    let mut data = [0u8; 8];
    data[..length].copy_from_slice(&payload[..length]);
    Some(CanFrame {
        id: frame.raw_id(),
        timestamp: 0,
        remote: frame.is_remote_frame(),
        extended: frame.is_extended(),
        dlc: frame.dlc().min(8) as u8,
        data,
    })
}

/// 项目帧 → SocketCAN 帧。
fn to_socket_frame(frame: &CanFrame) -> Result<SocketFrame, String> {
    let id: socketcan::Id = if frame.extended {
        socketcan::ExtendedId::new(frame.id)
            .ok_or_else(|| format!("扩展帧 ID 0x{:X} 超出 SocketCAN 范围", frame.id))?
            .into()
    } else {
        socketcan::StandardId::new(frame.id as u16)
            .ok_or_else(|| format!("标准帧 ID 0x{:X} 超出 SocketCAN 范围", frame.id))?
            .into()
    };
    let socket_frame = if frame.remote {
        SocketFrame::new_remote(id, frame.dlc.min(8) as usize)
    } else {
        SocketFrame::new(id, frame.data_bytes())
    };
    socket_frame.ok_or_else(|| "构造 SocketCAN 帧失败".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::create_dir_all;

    fn write_file(path: &Path, content: &str) {
        create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn fake_interface(
        root: &Path,
        name: &str,
        kind: &str,
        flags: Option<&str>,
        bitrate: Option<&str>,
    ) {
        let directory = root.join(name);
        write_file(&directory.join("type"), kind);
        if let Some(flags) = flags {
            write_file(&directory.join("flags"), flags);
        }
        if let Some(bitrate) = bitrate {
            write_file(&directory.join("can_bittiming/bitrate"), bitrate);
        }
    }

    #[test]
    fn list_interfaces_filters_type_and_sorts_by_name() {
        let directory = tempfile::tempdir().unwrap();
        fake_interface(
            directory.path(),
            "can1",
            "280",
            Some("0x1"),
            Some("500000\n"),
        );
        fake_interface(directory.path(), "can0", "280", Some("0x40080\n"), None);
        fake_interface(directory.path(), "eth0", "1", Some("0x1003"), None);
        fake_interface(directory.path(), "broken", "280", None, None);
        fake_interface(directory.path(), "lo", "772", Some("0x9"), None);

        let infos = list_interfaces(directory.path());
        assert_eq!(infos.len(), 2);
        assert_eq!(infos[0].name, "can0");
        assert!(!infos[0].up);
        assert_eq!(infos[0].bitrate, None);
        assert_eq!(infos[1].name, "can1");
        assert!(infos[1].up);
        assert_eq!(infos[1].bitrate, Some(500_000));
    }

    #[test]
    fn list_interfaces_tolerates_missing_root() {
        assert!(list_interfaces(Path::new("/definitely/not/here")).is_empty());
    }

    #[test]
    fn validate_name_accepts_linux_interface_names() {
        assert!(validate_name("can0").is_ok());
        assert!(validate_name("vcan0").is_ok());
        assert!(validate_name("can.0-x_1").is_ok());
        assert!(validate_name("aaaaaaaaaaaaaaa").is_ok());
    }

    #[test]
    fn validate_name_rejects_bad_names() {
        assert!(validate_name("").is_err());
        assert!(validate_name("aaaaaaaaaaaaaaaa").is_err());
        assert!(validate_name("can 0").is_err());
        assert!(validate_name("can/0").is_err());
        assert!(validate_name("can0\n").is_err());
    }

    #[test]
    fn socket_frame_converts_data_and_remote_frames() {
        let mut data_frame =
            SocketFrame::new(socketcan::StandardId::new(0x123).unwrap(), &[1, 2, 3])
                .expect("data frame");
        let converted = to_project_frame(&data_frame).unwrap();
        assert_eq!(converted.id, 0x123);
        assert_eq!(converted.dlc, 3);
        assert!(!converted.extended && !converted.remote);
        assert_eq!(converted.data_bytes(), &[1, 2, 3]);

        data_frame = SocketFrame::new_remote(socketcan::ExtendedId::new(0x18FF_50E5).unwrap(), 8)
            .expect("remote frame");
        let converted = to_project_frame(&data_frame).unwrap();
        assert_eq!(converted.id, 0x18FF_50E5);
        assert!(converted.extended && converted.remote);
        assert_eq!(converted.dlc, 8);
        assert!(converted.data_bytes().is_empty());
    }

    #[test]
    fn error_frames_are_dropped() {
        // 0x2000_0000 是 Linux 的 CAN_ERR_FLAG, crate 未导出该常量。
        let error =
            SocketFrame::Error(socketcan::CanErrorFrame::new_error(0x2000_0000, &[]).unwrap());
        assert!(to_project_frame(&error).is_none());
    }

    #[test]
    fn project_frame_round_trips_through_socket_frame() {
        let frame = CanFrame {
            id: 0x18FF_50E5,
            extended: true,
            dlc: 2,
            data: [0xAA, 0xBB, 0, 0, 0, 0, 0, 0],
            ..Default::default()
        };
        let socket_frame = to_socket_frame(&frame).unwrap();
        let back = to_project_frame(&socket_frame).unwrap();
        assert_eq!(back, frame);

        let remote = CanFrame {
            id: 0x123,
            remote: true,
            extended: false,
            dlc: 4,
            ..Default::default()
        };
        let socket_frame = to_socket_frame(&remote).unwrap();
        let back = to_project_frame(&socket_frame).unwrap();
        assert_eq!(back, remote);
    }

    #[test]
    fn to_socket_frame_rejects_out_of_range_ids() {
        let frame = CanFrame {
            id: 0x800,
            dlc: 0,
            ..Default::default()
        };
        assert!(to_socket_frame(&frame).is_err());
    }

    #[test]
    fn validate_bitrate_enforces_documented_range() {
        assert!(validate_bitrate(1_000).is_ok());
        assert!(validate_bitrate(500_000).is_ok());
        assert!(validate_bitrate(1_000_000).is_ok());
        assert!(validate_bitrate(0).is_err());
        assert!(validate_bitrate(999).is_err());
        assert!(validate_bitrate(1_000_001).is_err());
    }

    #[test]
    fn classifies_netlink_permission_and_unsupported_errors() {
        let permission =
            "Error response received from netlink: Operation not permitted (os error 1)";
        assert!(is_permission_error(permission));
        assert!(!is_permission_error(
            "Error response received from netlink: Operation not supported (os error 95)"
        ));
        // 不能把 "os error 10" 误判成 "os error 1"。
        assert!(!is_permission_error("read failed (os error 10)"));

        let unsupported =
            "Error response received from netlink: Operation not supported (os error 95)";
        assert!(is_unsupported_error(unsupported));
        assert!(is_unsupported_error("Operation not supported"));
        assert!(!is_unsupported_error(permission));
    }

    #[test]
    fn permission_error_message_mentions_cap_net_admin_and_manual_command() {
        let message = enable_error(
            "can0",
            500_000,
            "设置速率",
            "Error response received from netlink: Operation not permitted (os error 1)",
        );
        assert!(message.contains("CAP_NET_ADMIN"), "{message}");
        assert!(
            message.contains("ip link set can0 up type can bitrate 500000"),
            "{message}"
        );
        assert!(!message.contains("设置速率"), "{message}");
    }

    #[test]
    fn other_netlink_errors_keep_action_and_interface() {
        let message = enable_error("can0", 500_000, "设置速率", "No ack received");
        assert_eq!(
            message,
            "设置速率 SocketCAN 接口 can0 失败: No ack received"
        );
    }

    #[test]
    fn bring_up_validates_before_touching_netlink() {
        let error = bring_up("can0", 999).unwrap_err();
        assert!(error.contains("SocketCAN 速率"), "{error}");
        let error = bring_up("can 0", 500_000).unwrap_err();
        assert!(error.contains("非法字符"), "{error}");
    }
}
