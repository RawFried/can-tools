//! 进程内共享状态: 最新状态快照、实时帧环形缓冲与事件广播。

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use tokio::sync::broadcast;

use crate::can::dbc::DbcDefinition;
use crate::can::types::{
    BaudRate, CanMode, ChannelSource, DeviceInfo, FrameDto, HardwareFilter, SoftwareFilter,
};

/// 前端实时帧缓冲上限。
pub const MAX_LIVE_FRAMES: usize = 5000;
/// WebSocket 事件广播容量。慢客户端会收到 `Lagged`, 由前端重连快照恢复。
pub const EVENT_CAPACITY: usize = 1024;

/// 设备连接状态。
#[derive(Debug, Clone, Serialize)]
pub struct DeviceStatus {
    /// 是否已打开。
    pub open: bool,
    /// 打开时的设备信息。
    pub info: Option<DeviceInfo>,
}

/// 单通道状态。
///
/// USB 与 SocketCAN 共用同一形状; USB 项的 `bitrate`/`state` 为 `null`,
/// SocketCAN 项的 `baud`/`mode`/`filter` 为 `null`。
#[derive(Debug, Clone, Serialize)]
pub struct ChannelStatus {
    /// 通道索引: 0/1 为 USB, `2..=65` 为 SocketCAN 链路。
    pub index: u8,
    /// 通道来源。
    pub source: ChannelSource,
    /// 通道名: USB 为 `CAN1`/`CAN2`, SocketCAN 为接口名。
    pub name: String,
    /// 是否已启动。
    pub running: bool,
    /// 当前波特率 (仅 USB)。
    pub baud: Option<BaudRate>,
    /// 当前工作模式 (仅 USB)。
    pub mode: Option<CanMode>,
    /// 当前硬件滤波 (仅 USB)。
    pub filter: Option<HardwareFilter>,
    /// sysfs 中读到的接口速率 (仅 SocketCAN)。
    pub bitrate: Option<u64>,
    /// 接口状态 `up`/`down`/`unknown` (仅 SocketCAN)。
    pub state: Option<String>,
    /// 该通道当前生效的应用层 ID 区间; 空数组表示接收全部。
    pub software_filters: Vec<SoftwareFilter>,
}

impl ChannelStatus {
    fn stopped(index: u8) -> Self {
        Self {
            index,
            source: ChannelSource::Usb,
            name: format!("CAN{}", index + 1),
            running: false,
            baud: None,
            mode: None,
            filter: None,
            bitrate: None,
            state: None,
            software_filters: Vec::new(),
        }
    }
}

/// 录制状态。
#[derive(Debug, Clone, Default, Serialize)]
pub struct RecordingStatus {
    /// 是否正在录制。
    pub active: bool,
    /// 当前录制文件名。
    pub file: Option<String>,
    /// 已写入帧数。
    pub frames: u64,
    /// 开始录制的 UNIX 毫秒时间。
    pub started_at_ms: Option<u64>,
}

/// 统计信息。
#[derive(Debug, Clone, Default, Serialize)]
pub struct Stats {
    /// 打开/清空以来接收的帧数 (不含被软件滤波丢弃的帧)。
    pub rx_frames: u64,
    /// 被按通道软件滤波丢弃的帧数 (所有通道合计)。
    pub filtered_frames: u64,
    /// 最近一秒的接收速率 (帧/秒)。
    pub rx_rate: f64,
    /// 当前录制文件中的帧数。
    pub recorded_frames: u64,
    /// 打开/清空以来成功发送的帧数。
    pub tx_frames: u64,
}

/// 服务端信息。
#[derive(Debug, Clone, Serialize)]
pub struct ServerInfo {
    /// 程序版本。
    pub version: String,
    /// 数据目录 (录制文件位于其 `recordings` 子目录)。
    pub data_dir: String,
}

/// `/api/status` 与 WebSocket 状态事件的完整快照。
#[derive(Debug, Clone, Serialize)]
pub struct Status {
    /// 设备状态。
    pub device: DeviceStatus,
    /// 全部通道状态: 2 个 USB 项 + 已注册的 SocketCAN 链路。
    ///
    /// 软件滤波是**按通道**的, 见每个 [`ChannelStatus::software_filters`]。
    pub channels: Vec<ChannelStatus>,
    /// 录制状态。
    pub recording: RecordingStatus,
    /// 统计信息。
    pub stats: Stats,
    /// 服务端信息。
    pub server: ServerInfo,
}

impl Status {
    /// 构造初始 (设备关闭) 状态。
    pub fn closed(server: ServerInfo) -> Self {
        Self {
            device: DeviceStatus {
                open: false,
                info: None,
            },
            channels: vec![ChannelStatus::stopped(0), ChannelStatus::stopped(1)],
            recording: RecordingStatus::default(),
            stats: Stats::default(),
            server,
        }
    }

    /// 取指定通道状态。
    pub fn channel(&self, index: u8) -> &ChannelStatus {
        &self.channels[index as usize]
    }
}

/// WebSocket 事件。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    /// 一批新接收的帧。
    Frames {
        /// 帧列表。
        frames: Vec<FrameDto>,
    },
    /// 状态变化。
    Status {
        /// 最新状态。
        status: Box<Status>,
    },
    /// 日志消息。
    Log {
        /// `info` / `warn` / `error`。
        level: String,
        /// 消息正文。
        message: String,
    },
    /// 实时缓冲已清空。
    Cleared,
    /// DBC 定义已加载或移除。
    Dbc {
        /// 新定义; 移除后为 `null`。
        dbc: Option<DbcDefinition>,
    },
}

/// 共享状态容器。
pub struct SharedState {
    status: Mutex<Status>,
    frames: Mutex<VecDeque<FrameDto>>,
    dbc: Mutex<Option<Arc<DbcDefinition>>>,
    events: broadcast::Sender<Event>,
    max_frames: usize,
}

impl SharedState {
    /// 创建共享状态并返回 `Arc` (工作线程与 HTTP 处理器共用)。
    pub fn new(server: ServerInfo) -> Arc<Self> {
        Self::with_limits(server, MAX_LIVE_FRAMES, EVENT_CAPACITY)
    }

    fn with_limits(server: ServerInfo, max_frames: usize, event_capacity: usize) -> Arc<Self> {
        let (events, _) = broadcast::channel(event_capacity);
        Arc::new(Self {
            status: Mutex::new(Status::closed(server)),
            frames: Mutex::new(VecDeque::with_capacity(max_frames)),
            dbc: Mutex::new(None),
            events,
            max_frames,
        })
    }

    /// 订阅事件流。
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    /// 读取最新状态快照。
    pub fn status(&self) -> Status {
        self.lock_status().clone()
    }

    /// 读取实时帧缓冲快照。
    pub fn frames(&self) -> Vec<FrameDto> {
        self.lock_frames().iter().cloned().collect()
    }

    /// 替换状态并广播。
    pub fn set_status(&self, status: Status) {
        *self.lock_status() = status.clone();
        self.broadcast(Event::Status {
            status: Box::new(status),
        });
    }

    /// 原地修改状态并广播。
    pub fn update_status(&self, update: impl FnOnce(&mut Status)) {
        let status = {
            let mut guard = self.lock_status();
            update(&mut guard);
            guard.clone()
        };
        self.broadcast(Event::Status {
            status: Box::new(status),
        });
    }

    /// 推送一批帧到环形缓冲并广播。
    pub fn push_frames(&self, frames: Vec<FrameDto>) {
        if frames.is_empty() {
            return;
        }
        {
            let mut buffer = self.lock_frames();
            for frame in &frames {
                if buffer.len() == self.max_frames {
                    buffer.pop_front();
                }
                buffer.push_back(frame.clone());
            }
        }
        self.broadcast(Event::Frames { frames });
    }

    /// 清空实时帧缓冲并广播。
    pub fn clear_frames(&self) {
        self.lock_frames().clear();
        self.broadcast(Event::Cleared);
    }

    /// 读取当前 DBC 定义; 未加载时为 `None`。
    pub fn dbc(&self) -> Option<Arc<DbcDefinition>> {
        self.lock_dbc().clone()
    }

    /// 替换 DBC 定义并广播 `dbc` 事件。
    ///
    /// 广播内容序列化为完整的定义 (而非 `Arc`), 因为 `serde` 未启用 `rc` feature。
    pub fn set_dbc(&self, dbc: Option<Arc<DbcDefinition>>) {
        let event_dbc = dbc.as_deref().cloned();
        *self.lock_dbc() = dbc;
        self.broadcast(Event::Dbc { dbc: event_dbc });
    }

    /// 广播一条日志。
    pub fn log(&self, level: &str, message: impl Into<String>) {
        let message = message.into();
        match level {
            "warn" => tracing::warn!("{message}"),
            "error" => tracing::error!("{message}"),
            _ => tracing::info!("{message}"),
        }
        self.broadcast(Event::Log {
            level: level.to_string(),
            message,
        });
    }

    /// 广播一条任意事件 (无订阅者时静默丢弃)。
    pub fn broadcast(&self, event: Event) {
        let _ = self.events.send(event);
    }

    fn lock_status(&self) -> MutexGuard<'_, Status> {
        self.status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock_frames(&self) -> MutexGuard<'_, VecDeque<FrameDto>> {
        self.frames
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock_dbc(&self) -> MutexGuard<'_, Option<Arc<DbcDefinition>>> {
        self.dbc
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server_info() -> ServerInfo {
        ServerInfo {
            version: "0.1.0".to_string(),
            data_dir: "/tmp/can-tools".to_string(),
        }
    }

    fn frame(seq: u64) -> FrameDto {
        FrameDto {
            seq,
            time_ms: seq,
            device_ts: 0,
            channel: 0,
            id: 0x123,
            extended: false,
            remote: false,
            dlc: 0,
            data: String::new(),
        }
    }

    #[test]
    fn initial_status_is_closed_with_two_channels() {
        let shared = SharedState::new(server_info());
        let status = shared.status();
        assert!(!status.device.open);
        assert_eq!(status.channels.len(), 2);
        assert!(!status.channels[1].running);
        assert!(status
            .channels
            .iter()
            .all(|channel| channel.software_filters.is_empty()));
        assert!(status.recording.file.is_none());
    }

    #[test]
    fn frame_buffer_is_bounded_and_clears() {
        let shared = SharedState::with_limits(server_info(), 3, 16);
        shared.push_frames(vec![frame(1), frame(2), frame(3), frame(4)]);
        let frames = shared.frames();
        assert_eq!(
            frames.iter().map(|f| f.seq).collect::<Vec<_>>(),
            vec![2, 3, 4]
        );
        shared.clear_frames();
        assert!(shared.frames().is_empty());
    }

    #[test]
    fn status_update_notifies_subscribers() {
        let shared = SharedState::new(server_info());
        let mut receiver = shared.subscribe();
        shared.update_status(|status| status.stats.rx_frames = 42);
        match receiver.try_recv().unwrap() {
            Event::Status { status } => assert_eq!(status.stats.rx_frames, 42),
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn event_json_uses_documented_tags() {
        let cleared = serde_json::to_value(Event::Cleared).unwrap();
        assert_eq!(cleared, serde_json::json!({"type": "cleared"}));
        let frames = serde_json::to_value(Event::Frames {
            frames: vec![frame(1)],
        })
        .unwrap();
        assert_eq!(frames["type"], "frames");
        assert_eq!(frames["frames"][0]["seq"], 1);
    }

    fn dbc_definition() -> DbcDefinition {
        DbcDefinition {
            name: "demo.dbc".to_string(),
            loaded_at_ms: 1,
            messages: Vec::new(),
        }
    }

    #[test]
    fn dbc_event_uses_documented_tag_and_null() {
        let definition = dbc_definition();
        let with_value = serde_json::to_value(Event::Dbc {
            dbc: Some(definition.clone()),
        })
        .unwrap();
        assert_eq!(with_value["type"], "dbc");
        assert_eq!(with_value["dbc"]["name"], "demo.dbc");
        assert_eq!(with_value["dbc"]["messages"], serde_json::json!([]));

        let cleared = serde_json::to_value(Event::Dbc { dbc: None }).unwrap();
        assert_eq!(cleared, serde_json::json!({"type": "dbc", "dbc": null}));
    }

    #[test]
    fn dbc_set_and_get_round_trip() {
        let shared = SharedState::new(server_info());
        assert!(shared.dbc().is_none());

        let definition = dbc_definition();
        shared.set_dbc(Some(Arc::new(definition.clone())));
        assert_eq!(shared.dbc().as_deref(), Some(&definition));

        shared.set_dbc(None);
        assert!(shared.dbc().is_none());
    }

    #[test]
    fn dbc_set_broadcasts_event() {
        let shared = SharedState::new(server_info());
        let mut receiver = shared.subscribe();
        shared.set_dbc(Some(Arc::new(dbc_definition())));
        match receiver.try_recv().unwrap() {
            Event::Dbc { dbc } => {
                assert_eq!(dbc.map(|dbc| dbc.name), Some("demo.dbc".to_string()));
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }
}
