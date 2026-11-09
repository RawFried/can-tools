//! CAN 工作线程与命令接口。
//!
//! 所有 USB I/O 都在专用 `std::thread` 中串行执行, HTTP 处理器只通过命令
//! 通道交互, 避免阻塞 tokio 运行时, 也避免多线程争用 libusb 句柄。

mod recorder;
mod worker;

use std::path::PathBuf;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::oneshot;

use crate::can::types::{DeviceInfo, SendFrameRequest, StartConfig};
use crate::state::SharedState;
use recorder::RecordingSummary;

/// 命令回复类型。
pub(crate) type Reply<T> = oneshot::Sender<std::result::Result<T, String>>;

/// 工作线程命令。
pub(crate) enum Command {
    /// 枚举设备。
    ListDevices { reply: Reply<Vec<DeviceInfo>> },
    /// 打开设备。
    Open {
        index: usize,
        reply: Reply<DeviceInfo>,
    },
    /// 关闭设备。
    Close { reply: Reply<()> },
    /// 初始化并启动通道。
    Configure {
        config: StartConfig,
        reply: Reply<()>,
    },
    /// 停止通道; `None` 表示全部。
    Stop {
        channels: Option<Vec<u8>>,
        reply: Reply<()>,
    },
    /// 开始录制。
    StartRecording { reply: Reply<String> },
    /// 停止录制。
    StopRecording { reply: Reply<RecordingSummary> },
    /// 清空实时帧与统计。
    ClearFrames { reply: Reply<()> },
    /// 发送一帧。
    Send {
        request: SendFrameRequest,
        reply: Reply<()>,
    },
    /// 退出工作线程。
    Shutdown { reply: Reply<()> },
}

/// CAN 工作线程句柄。
pub struct CanService {
    sender: Sender<Command>,
    join: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl CanService {
    /// 启动工作线程。
    pub fn spawn(shared: Arc<SharedState>, recordings_dir: PathBuf) -> std::io::Result<Self> {
        let (sender, receiver) = channel();
        let worker = worker::Worker::new(shared, recordings_dir);
        let join = std::thread::Builder::new()
            .name("can-worker".to_string())
            .spawn(move || worker.run(receiver))?;
        Ok(Self {
            sender,
            join: Mutex::new(Some(join)),
        })
    }

    /// 枚举设备。
    pub async fn list_devices(&self) -> Result<Vec<DeviceInfo>, String> {
        self.call(Duration::from_secs(5), |reply| Command::ListDevices {
            reply,
        })
        .await
    }

    /// 打开设备。
    pub async fn open(&self, index: usize) -> Result<DeviceInfo, String> {
        self.call(Duration::from_secs(20), |reply| Command::Open {
            index,
            reply,
        })
        .await
    }

    /// 关闭设备。
    pub async fn close(&self) -> Result<(), String> {
        self.call(Duration::from_secs(10), |reply| Command::Close { reply })
            .await
    }

    /// 初始化并启动通道。
    pub async fn configure(&self, config: StartConfig) -> Result<(), String> {
        self.call(Duration::from_secs(10), |reply| Command::Configure {
            config,
            reply,
        })
        .await
    }

    /// 停止通道。
    pub async fn stop(&self, channels: Option<Vec<u8>>) -> Result<(), String> {
        self.call(Duration::from_secs(10), |reply| Command::Stop {
            channels,
            reply,
        })
        .await
    }

    /// 开始录制。
    pub async fn start_recording(&self) -> Result<String, String> {
        self.call(Duration::from_secs(5), |reply| Command::StartRecording {
            reply,
        })
        .await
    }

    /// 停止录制。
    pub async fn stop_recording(&self) -> Result<RecordingSummary, String> {
        self.call(Duration::from_secs(5), |reply| Command::StopRecording {
            reply,
        })
        .await
    }

    /// 清空实时帧与统计。
    pub async fn clear_frames(&self) -> Result<(), String> {
        self.call(Duration::from_secs(5), |reply| Command::ClearFrames {
            reply,
        })
        .await
    }

    /// 发送一帧。
    pub async fn send(&self, request: SendFrameRequest) -> Result<(), String> {
        self.call(Duration::from_secs(5), |reply| Command::Send {
            request,
            reply,
        })
        .await
    }

    /// 停止工作线程并等待退出。
    pub async fn shutdown(&self) {
        let (sender, receiver) = oneshot::channel();
        if self
            .sender
            .send(Command::Shutdown { reply: sender })
            .is_ok()
        {
            let _ = tokio::time::timeout(Duration::from_secs(5), receiver).await;
        }
        let handle = self
            .join
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(handle) = handle {
            let _ = handle.join();
        }
    }

    async fn call<T>(
        &self,
        timeout: Duration,
        build: impl FnOnce(Reply<T>) -> Command,
    ) -> Result<T, String> {
        let (sender, receiver) = oneshot::channel();
        self.sender
            .send(build(sender))
            .map_err(|_| "CAN 工作线程已退出".to_string())?;
        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("CAN 工作线程未返回结果".to_string()),
            Err(_) => Err("CAN 操作超时".to_string()),
        }
    }
}

/// 当前 UNIX 毫秒时间。
pub(crate) fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
